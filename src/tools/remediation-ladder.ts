/**
 * Remediation ladder — a recognised toolchain failure gets a KNOWN fix instead
 * of another exploration loop.
 *
 * WHY (A4). On the supervised `cal` Android run (2026-10-05) the agent
 * diagnosed the real cause of a Gradle failure correctly — Capacitor 8 compiles
 * at `JavaVersion.VERSION_21`, the environment had JDK 17 — and then stopped:
 * it retried the same command with small variations and closed the turn telling
 * the user to install JDK 21 themselves. A supervisor fixed the same tree in
 * ~30 s with a project-local edit (`android/local.properties` + a JDK-21
 * `JAVA_HOME`). The failure was not environmental in the sense of "impossible";
 * it was a fix the agent could see and did not take.
 *
 * The ladder closes that gap with a SMALL, DECLARED map: error signature →
 * what it means → the bounded fix, split into the part that belongs to THIS
 * project (a file write, a chmod, an env var scoped to the command) and the
 * part that is the user's decision (installing a system JDK). By DEFAULT it is
 * advisory: the note is appended to the failed tool result, so the model takes
 * the fix with the same tools it already has. A very small subset may carry a
 * machine-readable safe action (see AUTO-APPLY below), but nothing is ever
 * changed without an explicit opt-in — a remediation the agent cannot see is
 * indistinguishable from a bug, and the agent must stay able to reason about
 * what changed.
 *
 * Rules are intentionally a handful of high-signal signatures, not a general
 * log classifier: a wrong "known fix" is worse than none.
 *
 * AUTO-APPLY (opt-in). A subset of the fixes is a single, idempotent,
 * project-local file operation that cannot strand the user — `chmod +x` on the
 * wrapper, writing `android/local.properties`. For those a rule may also
 * declare a machine-readable {@link AutoFixAction}. When the run opts in
 * (`NUVIRA_REMEDIATE=auto`) the fix is applied to the workspace and the note
 * reports exactly what changed; by default the note is advisory only. Anything
 * that needs a discovery or a per-run env var stays advisory — the agent can
 * still see it and take it.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Remediation {
  /** Stable id (telemetry / tests). */
  id: string;
  /** What this signature means, in one line. */
  summary: string;
  /** Bounded steps, in order. Concrete commands/paths, not advice. */
  fix: string[];
  /**
   * `project-local` steps are the agent's job; `system` steps change the
   * machine and may need the user. Both are shown; only the distinction is.
   */
  scope: 'project-local' | 'system';
  /**
   * Safe, idempotent, project-local operations a machine may take on the agent's
   * behalf when auto-apply is enabled. Absent means advisory-only (the default).
   */
  autoFix?: AutoFixAction[];
}

/** A no-surprise filesystem operation confined to the project workspace. */
export type AutoFixAction =
  | { kind: 'chmod-exec'; path: string }
  | { kind: 'write-file'; path: string; content: string };

/** A rule is a signature match plus the remediation it produces. */
interface Rule {
  id: string;
  test: (command: string, output: string) => boolean;
  build: (context: RuleContext) => Remediation;
}

interface RuleContext {
  command: string;
  output: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

/** Filesystem seam so rules stay testable without touching the real tree. */
const defaultFs = { existsSync, statSync };

/**
 * Find the Gradle wrapper script relative to the project root, if it exists.
 * The `cal` tree keeps it under `android/`; a bare Android project keeps it at
 * the root, so both are checked (most specific first).
 */
function findGradlew(cwd: string | undefined): string | null {
  if (!cwd) return null;
  for (const rel of ['android/gradlew', 'gradlew']) {
    const abs = join(cwd, rel);
    try {
      if (defaultFs.existsSync(abs) && defaultFs.statSync(abs).isFile()) return abs;
    } catch {
      /* unreadable — treat as absent */
    }
  }
  return null;
}

/**
 * Where the Android SDK lives, if this machine merely has it configured. Used
 * to write `android/local.properties`, which is the whole of the SDK-location
 * failure. Returns null when no path can be found, so nothing is written.
 */
function findAndroidSdk(cwd: string | undefined, env: NodeJS.ProcessEnv): string | null {
  const explicit = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  if (explicit && existsSync(explicit)) return explicit;
  const home = env.HOME || '';
  const candidates = [
    join(home, 'android-toolchain/android-sdk'),
    join(home, 'Library/Android/sdk'),
    join(home, 'Android/Sdk'),
    ...(cwd ? [join(cwd, 'android-sdk'), join(cwd, '.android-sdk')] : []),
  ];
  for (const c of candidates) {
    try {
      // A real SDK has a `platform-tools` (or `platforms`) directory.
      if (c && existsSync(join(c, 'platform-tools'))) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const ANDROID_JDK_LINE = /requires\s+java\s+(1[1-9]|[2-9]\d)|java\s*21|VERSION_21|Unsupported class file major version/i;

/**
 * The rules, most specific first. Each `test` is deliberately narrow so the
 * ladder fires only on a signature it can actually help with.
 */
const RULES: Rule[] = [
  {
    id: 'jdk-version',
    test: (cmd, out) =>
      ANDROID_JDK_LINE.test(out) ||
      /(android|gradle|sdk)/i.test(cmd) && /(java|jdk).*(version|home|17|21)|could not determine java version/i.test(out),
    build: () => ({
      id: 'jdk-version',
      summary:
        'This build needs a newer JDK than the one on PATH (for example Capacitor/AGP 8 requires JDK 21, not 17).',
      fix: [
        'Find a JDK that satisfies the required version (e.g. `~/android-toolchain/jdk21/Contents/Home`, `/usr/libexec/java_home -v 21`, or `ls /usr/lib/jvm`).',
        'Point THIS build at it without changing the user’s default: re-run the command with `JAVA_HOME=<jdk> PATH="$JAVA_HOME/bin:$PATH" <command>` (project-local, do this now).',
        'If the JDK is not installed at all, install it (e.g. `brew install --cask temurin@21`) — this changes the machine, so say so rather than blocking on it.',
        'For Gradle you can also pin it in the project: add `org.gradle.java.home=<jdk>` to `android/gradle.properties` (project-local, survives the turn).',
        'Do NOT retry the same command with the same JAVA_HOME — the version cannot change by retrying.',
      ],
      scope: 'project-local',
    }),
  },
  {
    id: 'android-sdk-location',
    test: (_cmd, out) =>
      /SDK location not found|ANDROID_HOME|ANDROID_SDK_ROOT|sdk\.dir|accepted the SDK license|licenses? .* not accepted/i.test(out),
    build: ({ cwd, env }) => {
      const sdk = findAndroidSdk(cwd, env);
      const localProps = cwd ? join(cwd, 'android/local.properties') : '';
      return {
        id: 'android-sdk-location',
        summary: 'Gradle cannot find (or is not allowed to use) the Android SDK.',
        ...(sdk && localProps
          ? { autoFix: [{ kind: 'write-file' as const, path: localProps, content: `sdk.dir=${sdk}\n` }] }
          : {}),
        fix: [
          'Create `android/local.properties` (project-local) containing `sdk.dir=<path-to-Android-SDK>` — this is the whole of the SDK-location failure.',
          'Install the required components if missing: `sdkmanager "platforms;android-34" "build-tools;34.0.0" "platform-tools"`.',
          'Accept pending licences: `yes | sdkmanager --licenses`.',
          'Re-run `./gradlew assembleDebug` (or the original build) in the SAME directory.',
        ],
        scope: 'project-local',
      };
    },
  },
  {
    id: 'gradlew-not-executable',
    test: (cmd, out) => /gradlew/i.test(cmd) && /Permission denied|not executable/i.test(out),
    build: ({ cwd }) => {
      const gradlew = findGradlew(cwd);
      return {
        id: 'gradlew-not-executable',
        summary: 'The Gradle wrapper script is not executable in this checkout.',
        ...(gradlew ? { autoFix: [{ kind: 'chmod-exec' as const, path: gradlew }] } : {}),
        fix: [
          'Run `chmod +x android/gradlew` (project-local), then re-run the build.',
          'Alternatively invoke it through the shell: `sh android/gradlew assembleDebug`.',
        ],
        scope: 'project-local',
      };
    },
  },
  {
    id: 'toolchain-missing',
    test: (_cmd, out) =>
      /\b(java|javac|gradle|adb|sdkmanager|kotlinc)\b.*(command not found|not recognized as)/i.test(out),
    build: () => ({
      id: 'toolchain-missing',
      summary: 'A build tool is not installed (or not on PATH).',
      fix: [
        'Check whether the tool exists somewhere first (`which java`, `ls ~/android-toolchain`).',
        'Install the missing component, or add its path to PATH for THIS command (`PATH="$HOME/android-toolchain/android-sdk/platform-tools:$PATH" <command>`) — project-local for the run.',
        'Installing a toolchain system-wide is the user’s decision; state it plainly if it is genuinely required.',
      ],
      scope: 'project-local',
    }),
  },
  {
    id: 'python-env',
    test: (_cmd, out) =>
      /externally-managed-environment|No module named|Could not find a version that satisfies|python[0-9.]*: (command )?not found/i.test(out),
    build: () => ({
      id: 'python-env',
      summary: 'Python dependencies are missing or the environment is externally managed.',
      fix: [
        'Create a project venv: `python3 -m venv .venv` (project-local).',
        'Install into it: `.venv/bin/pip install -r requirements.txt` (or the named package).',
        'Re-run the original command with the venv active: `.venv/bin/python <command>`.',
        'Do NOT `pip install --break-system-packages` — the venv is the fix.',
      ],
      scope: 'project-local',
    }),
  },
  {
    id: 'node-engines',
    test: (_cmd, out) => /EBADENGINE|Unsupported engine|requires Node(\.js)? (version )?|node: (command )?not found/i.test(out),
    build: () => ({
      id: 'node-engines',
      summary: 'The installed Node/npm does not satisfy this project’s engine requirement.',
      fix: [
        'Read the required version from `package.json` (`engines`).',
        'Select a matching runtime for THIS command (e.g. `nvm use 20`, `fnm use`, or point PATH at the right install) — project-local for the run.',
        'If no matching runtime exists, installing one is the user’s decision — say so instead of retrying.',
      ],
      scope: 'project-local',
    }),
  },
  {
    id: 'docker-daemon',
    test: (_cmd, out) => /Cannot connect to the Docker daemon|Is the docker daemon running/i.test(out),
    build: () => ({
      id: 'docker-daemon',
      summary: 'Docker is installed but its daemon is not running.',
      fix: [
        'Start it: `open -a Docker` (macOS), `sudo systemctl start docker` (Linux), or start Docker Desktop.',
        'Wait for `docker info` to succeed, then re-run the original command.',
        'If it cannot be started, choose a non-container path for the build rather than retrying.',
      ],
      scope: 'system',
    }),
  },
];

/**
 * Diagnose a FAILED command. Returns null when the output matches no known
 * signature — the ladder must never invent a fix for an unknown failure.
 */
export function diagnoseFailure(
  command: string,
  output: string,
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): Remediation | null {
  const cmd = String(command ?? '');
  const out = String(output ?? '');
  if (!out) return null;
  for (const rule of RULES) {
    try {
      if (rule.test(cmd, out)) return rule.build({ command: cmd, output: out, cwd, env });
    } catch {
      // A rule must never break the tool result it is annotating.
      continue;
    }
  }
  return null;
}

/** Is auto-apply requested for this run? Off unless explicitly opted in. */
export function remediationAutoApplyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NUVIRA_REMEDIATE || '').toLowerCase() === 'auto';
}

export interface AutoApplyResult {
  /** Human strings for the operations that changed the workspace. */
  applied: string[];
  /** Operations that were already satisfied or could not be taken safely. */
  skipped: string[];
}

/**
 * Apply the remediations's safe auto-fixes. Every operation is idempotent and
 * confined to the workspace; anything that fails is reported as skipped, never
 * thrown — a remediation must not break the tool result it annotates.
 */
export function applyRemediationAutoFixes(r: Remediation): AutoApplyResult {
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const action of r.autoFix ?? []) {
    try {
      if (action.kind === 'chmod-exec') {
        // Windows has no POSIX execute bit — `chmod` there can only toggle the
        // read-only attribute. Running it would report a fix that did not happen
        // (and could never become idempotent), so say plainly that it does not
        // apply instead of claiming success.
        if (process.platform === 'win32') {
          skipped.push(`chmod +x ${action.path} (not applicable on Windows — no POSIX execute bit)`);
          continue;
        }
        if (!existsSync(action.path)) {
          skipped.push(`chmod +x ${action.path} (file not found)`);
          continue;
        }
        const mode = statSync(action.path).mode;
        if (mode & 0o111) {
          skipped.push(`chmod +x ${action.path} (already executable)`);
          continue;
        }
        chmodSync(action.path, 0o755);
        applied.push(`chmod +x ${action.path}`);
      } else {
        // write-file: never clobber a file that already says what we would say.
        if (existsSync(action.path)) {
          const current = readFileSync(action.path, 'utf-8');
          const wanted = action.content.trim();
          if (current.includes(wanted)) {
            skipped.push(`${action.path} (already set)`);
            continue;
          }
          // Append rather than overwrite — other keys in the file are the user's.
          const sep = current.endsWith('\n') || current === '' ? '' : '\n';
          writeFileSync(action.path, `${current}${sep}${action.content}`);
          applied.push(`${action.path} (+ ${wanted})`);
          continue;
        }
        mkdirSync(dirname(action.path), { recursive: true });
        writeFileSync(action.path, action.content);
        applied.push(`${action.path} (created)`);
      }
    } catch (e) {
      skipped.push(`${action.kind} ${'path' in action ? action.path : ''} (${(e as Error).message})`);
    }
  }
  return { applied, skipped };
}

/** Render the auto-apply outcome as a note appended after the advisory fix. */
export function formatAutoApply(result: AutoApplyResult): string {
  if (result.applied.length === 0 && result.skipped.length === 0) return '';
  const lines = ['⚙️  Auto-applied safe project-local fix(es):'];
  for (const a of result.applied) lines.push(`   ✓ ${a}`);
  for (const s of result.skipped) lines.push(`   – ${s}`);
  lines.push('   (NUVIRA_REMEDIATE=auto; re-run the original command now.)');
  return lines.join('\n');
}

/**
 * Render a remediation as the note appended to the failed tool result. Plain
 * text (not markdown headers) so it reads the same in a terminal, a transcript,
 * and a model prompt.
 */
export function formatRemediation(r: Remediation): string {
  const head = `🔧 Known failure (${r.id}): ${r.summary}`;
  const body = r.fix.map((step, i) => `   ${i + 1}. ${step}`).join('\n');
  const tail =
    r.scope === 'project-local'
      ? '   → Take the project-local step above and re-run; do not repeat the same command unchanged.'
      : '   → This one is a machine-level change; state it plainly if it is required.';
  return `${head}\n${body}\n${tail}`;
}
