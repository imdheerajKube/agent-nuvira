/**
 * Build/run EFFECT verification — launch the thing that was built, and refuse
 * to call the build a success if the artifact crashes on launch.
 *
 * WHY THIS EXISTS (the live Aukat_check failure):
 * `nuvira` rebuilt a macOS app, the build command exited 0, and the run reported
 * "The app is now successfully built and functional." It was not: the bundle
 * crashed immediately with `ModuleNotFoundError: No module named 'PyQt6'` /
 * `ImportError: cannot import name 'AXIsProcessTrusted' from 'AppKit'`. The
 * agent's own "verification" was `ps aux | grep`, which cannot tell a running
 * process from a crash-loop.
 *
 * `artifact-verification.ts` already makes FILE deliverables honest (missing,
 * empty, empty-archive). This generalizes the same invariant to a PROCESS
 * deliverable: a build is done when the artifact it produced is OBSERVED to
 * launch — not when a command's exit code said so.
 *
 * Deliberately conservative and LLM-free:
 *   - Only BUILD commands that plausibly produce a runnable artifact engage it.
 *   - Only a launch that EXITS NON-ZERO with stderr (or dies by signal) is a
 *     failure. A process still alive at the timeout is a success (a GUI app),
 *     and a clean exit 0 is a success (a CLI that did its job).
 *   - No candidate artifact ⇒ `no-artifact`, which is REPORTED, never failures:
 *     a library build legitimately produces nothing to launch.
 *   - `NUVIRA_EFFECT_VERIFY=off` disables it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, join, resolve } from 'node:path';

/** A launchable artifact a build may have produced. */
export interface LaunchCandidate {
  /** Absolute path to the artifact (an `.app` bundle or an executable). */
  path: string;
  kind: 'app-bundle' | 'executable';
}

/** The outcome of one launch attempt. */
export interface LaunchResult {
  ok: boolean;
  /** Exit code when the process ended on its own; null when it timed out (killed). */
  exitCode: number | null;
  /** True when the process was still alive at the timeout and had to be killed. */
  timedOut: boolean;
  /** Captured stderr (bounded). */
  stderr: string;
  /** One line naming why it failed (empty when ok). */
  reason: string;
}

export type EffectVerdict =
  | { status: 'not-applicable' }
  | { status: 'no-artifact'; buildCommand: string }
  | { status: 'verified'; artifact: LaunchCandidate; aliveMs: number }
  | { status: 'failed'; artifact: LaunchCandidate; reason: string; stderr: string };

/** Is the effect check disabled by the deployment? */
export function effectVerifyDisabled(): boolean {
  const raw = (process.env.NUVIRA_EFFECT_VERIFY ?? process.env.BUFF_EFFECT_VERIFY ?? '')
    .trim()
    .toLowerCase();
  return raw === 'off' || raw === '0' || raw === 'false' || raw === 'no';
}

/** Default launch window: long enough for a crash-on-import, short enough to not stall. */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 8000;

/**
 * Build commands whose whole purpose is to produce a runnable artifact.
 * Kept to the well-known producers so this never surprises an ordinary command.
 */
const BUILD_COMMAND_RE =
  /(?:^|[\s;&|])(?:npx\s+)?(?:pyinstaller|pyinstaller-?\d*|cargo\s+build|tauri\s+build|go\s+build|xcodebuild|maturin\s+build|swift\s+build|cmake\s+--build|dotnet\s+build|mvn\s+(?:package|install|verify)|gradle\s+(?:build|assemble)|(?:\.\/)?gradlew\s+(?:build|assemble)|python3?\s+-m\s+(?:PyInstaller|build)|npm\s+run\s+build|pnpm\s+run\s+build|yarn\s+build|bun\s+run\s+build|make)\b/;

/** Does this command build a runnable artifact worth launching? */
export function isBuildCommand(command: string): boolean {
  return BUILD_COMMAND_RE.test(String(command ?? '').toLowerCase());
}

/** Directories a build typically writes its artifact into, nearest-first. */
const ARTIFACT_DIRS = ['dist', 'build', 'target/release', 'target/debug', 'out', 'bin'];

/**
 * The names a build command declares — from `--name=X` and from a PyInstaller
 * `.spec`'s `name='…'` entries. Used to locate the artifact the command produced.
 */
export function extractBuildNames(command: string, cwd: string): string[] {
  const names = new Set<string>();
  for (const m of command.matchAll(/--name[= ]([\w.\-]+)/g)) names.add(m[1]);

  const specMatch = command.match(/([\w.\-/]+\.spec)\b/);
  const specPath = specMatch ? resolve(cwd, specMatch[1]) : findSpecFile(cwd);
  if (specPath && existsSync(specPath)) {
    try {
      const text = readFileSync(specPath, 'utf-8');
      for (const m of text.matchAll(/name\s*=\s*['"]([^'"]+)['"]/g)) {
        names.add(m[1].replace(/\.app$/i, ''));
      }
    } catch {
      /* best-effort — an unreadable spec is not a verdict */
    }
  }
  return [...names];
}

/** The first `*.spec` directly in `cwd`, if any. */
function findSpecFile(cwd: string): string | null {
  try {
    const entry = readdirSync(cwd).find((f) => f.endsWith('.spec'));
    return entry ? join(cwd, entry) : null;
  } catch {
    return null;
  }
}

/** Is this a POSIX-executable file (or a Windows `.exe`)? */
function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return /\.(exe|com|bat|cmd)$/i.test(path);
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** An `.app` bundle is a directory with a runnable inner executable. */
function isAppBundle(path: string): boolean {
  if (process.platform !== 'darwin' || !path.endsWith('.app')) return false;
  try {
    return statSync(path).isDirectory() && existsSync(join(path, 'Contents', 'MacOS'));
  } catch {
    return false;
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The artifacts a build command plausibly produced, newest first.
 *
 * Candidates come from the declared build names first (so a `.spec`'s `.app` is
 * found even in a busy `dist/`), then from a bounded scan of the usual output
 * directories. Only entries written at/after `sinceMs` are considered, so a
 * stale artifact from an earlier run is never mistaken for this build's output.
 */
export function findLaunchCandidates(
  command: string,
  cwd: string,
  sinceMs: number,
): LaunchCandidate[] {
  const roots: string[] = ARTIFACT_DIRS.map((d) => join(cwd, d)).filter((d) => existsSync(d));
  const candidates: LaunchCandidate[] = [];
  const seen = new Set<string>();

  const consider = (path: string): void => {
    if (seen.has(path) || !existsSync(path)) return;
    if (mtimeOf(path) < sinceMs) return;
    if (isAppBundle(path)) {
      seen.add(path);
      candidates.push({ path, kind: 'app-bundle' });
    } else if (isExecutableFile(path)) {
      seen.add(path);
      candidates.push({ path, kind: 'executable' });
    }
  };

  // 1. Declared names under the usual dirs (and an onedir `<name>/<name>` layout).
  for (const name of extractBuildNames(command, cwd)) {
    for (const root of roots) {
      consider(join(root, `${name}.app`));
      consider(join(root, name, name));
      consider(join(root, name, `${name}.exe`));
      consider(join(root, name));
    }
  }

  // 2. Bounded scan of the output dirs (top level + one level deep), newest first.
  for (const root of roots) {
    try {
      for (const entry of readdirSync(root)) {
        const full = join(root, entry);
        consider(full);
        if (isAppBundle(full)) continue;
        try {
          if (statSync(full).isDirectory()) {
            for (const inner of readdirSync(full)) consider(join(full, inner));
          }
        } catch {
          /* not a dir */
        }
      }
    } catch {
      /* unreadable dir */
    }
  }

  candidates.sort((a, b) => mtimeOf(b.path) - mtimeOf(a.path));
  return candidates.slice(0, 5);
}

/** The actual binary to run for a candidate (inner executable of an `.app`). */
export function resolveLaunchBinary(candidate: LaunchCandidate): string | null {
  if (candidate.kind === 'executable') return candidate.path;
  const macos = join(candidate.path, 'Contents', 'MacOS');
  try {
    const files = readdirSync(macos).filter((f) => {
      try {
        return statSync(join(macos, f)).isFile();
      } catch {
        return false;
      }
    });
    const plist = join(candidate.path, 'Contents', 'Info.plist');
    if (existsSync(plist)) {
      const txt = readFileSync(plist, 'utf-8');
      const m = txt.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
      if (m && files.includes(m[1])) return join(macos, m[1]);
    }
    return files.length > 0 ? join(macos, files[0]) : null;
  } catch {
    return null;
  }
}

/** Options for one launch attempt. */
export interface LaunchOptions {
  timeoutMs: number;
  env?: Record<string, string | undefined>;
}

/**
 * Launch an artifact and observe it for a bounded window.
 *
 * The rule that makes this honest AND safe: a process still alive at the timeout
 * is a success (it did not crash), and only a non-zero exit (or death by signal)
 * is a failure — with the captured stderr as the reason.
 */
export function smokeLaunchArtifact(
  candidate: LaunchCandidate,
  options: LaunchOptions,
): Promise<LaunchResult> {
  return new Promise((resolve) => {
    const bin = resolveLaunchBinary(candidate);
    if (!bin) {
      resolve({
        ok: false,
        exitCode: null,
        timedOut: false,
        stderr: '',
        reason: 'the artifact exists but has no runnable executable inside it',
      });
      return;
    }
    let err = '';
    let settled = false;
    const finish = (r: LaunchResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child;
    try {
      child = spawn(bin, [], {
        env: options.env ?? process.env,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      finish({
        ok: false,
        exitCode: null,
        timedOut: false,
        stderr: '',
        reason: `could not launch: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
      finish({ ok: true, exitCode: null, timedOut: true, stderr: err.trim().slice(-2000), reason: '' });
    }, options.timeoutMs);
    child.stderr?.on('data', (b: Buffer) => {
      err += b.toString('utf-8');
      if (err.length > 4000) err = err.slice(-4000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({
        ok: false,
        exitCode: null,
        timedOut: false,
        stderr: e.message,
        reason: `could not launch: ${e.message}`,
      });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const stderr = err.trim();
      if (signal) {
        finish({
          ok: false,
          exitCode: code,
          timedOut: false,
          stderr: stderr.slice(-2000),
          reason: `the artifact crashed on launch (signal ${signal})`,
        });
        return;
      }
      const ok = code === 0;
      finish({
        ok,
        exitCode: code,
        timedOut: false,
        stderr: stderr.slice(-2000),
        reason: ok ? '' : `the artifact exited with code ${code}`,
      });
    });
  });
}

/** Injectable launcher (tests never spawn a real artifact). */
export type ArtifactLauncher = (
  candidate: LaunchCandidate,
  options: LaunchOptions,
) => Promise<LaunchResult>;

/** Options for {@link verifyBuildEffect}. */
export interface EffectVerifyOptions {
  /** Only consider artifacts written at/after this epoch ms (the build's start). */
  sinceMs?: number;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  launch?: ArtifactLauncher;
}

/**
 * Verify that a build command's output actually launches.
 *
 * Ordered by honesty: a successful launch verifies; a crash fails with its
 * stderr; no launchable artifact is reported (not failed), because a library
 * build legitimately has nothing to launch.
 */
export async function verifyBuildEffect(
  command: string,
  cwd: string,
  options: EffectVerifyOptions = {},
): Promise<EffectVerdict> {
  if (effectVerifyDisabled() || !isBuildCommand(command)) return { status: 'not-applicable' };
  const sinceMs = options.sinceMs ?? 0;
  const candidates = findLaunchCandidates(command, cwd, sinceMs);
  if (candidates.length === 0) return { status: 'no-artifact', buildCommand: command };

  const timeoutMs = options.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  const launch: ArtifactLauncher = options.launch ?? smokeLaunchArtifact;
  for (const candidate of candidates) {
    const result = await launch(candidate, { timeoutMs, ...(options.env ? { env: options.env } : {}) });
    if (result.ok) {
      return { status: 'verified', artifact: candidate, aliveMs: result.timedOut ? timeoutMs : 0 };
    }
    return { status: 'failed', artifact: candidate, reason: result.reason, stderr: result.stderr };
  }
  return { status: 'no-artifact', buildCommand: command };
}

/** A one-line, model-readable description of an effect verdict ('' when nothing to say). */
export function formatEffectVerdict(verdict: EffectVerdict): string {
  switch (verdict.status) {
    case 'verified':
      return `🩺 effect verified — launched ${basename(verdict.artifact.path)} and it did not crash`;
    case 'failed':
      return (
        `the build succeeded but the artifact CRASHES on launch: ${verdict.reason}.` +
        (verdict.stderr ? `\nLaunch stderr:\n${verdict.stderr}` : '')
      );
    case 'no-artifact':
      return '';
    default:
      return '';
  }
}
