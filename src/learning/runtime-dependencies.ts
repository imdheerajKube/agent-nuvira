/**
 * Runtime dependencies — the software Nuvira USES but does not ship.
 *
 * WHY THIS EXISTS. `nuvira doctor` reported node, npm and git, and said nothing
 * about the binaries that decide whether half the tool surface works: without
 * `ffmpeg` the motion renderer cannot encode a frame sequence, without a
 * chromium bundle the browser tools and the motion renderer cannot capture one,
 * and without `edge-tts` narration is silently skipped. A missing one of those
 * is NOT a broken install — every caller degrades and says so — but the user had
 * no single list of "what should I install for the full thing", and each tool
 * explained its own prerequisite again in its own words.
 *
 * So this module is the ONE list. Each entry declares what it is, whether it is
 * RECOMMENDED (the agent is meaningfully better with it) or OPTIONAL (one extra
 * capability), how presence is decided, what it enables in plain English, and
 * the install command for THIS OS together with the caveat that actually
 * matters. Everything else is derived from the declaration: the doctor section,
 * the `--fix` installer, the prompt line the model reads, and the docs table.
 * Nothing hands out a command that is not in here, so the list cannot say one
 * thing and the installer do another.
 *
 * PRESENCE IS A FACT, INTENT IS NOT. A probe only ever answers "is it here".
 * Whether the user WANTS it is asked separately, before anything runs — see
 * `installPlan()` (what we WOULD run) versus `nuvira doctor --fix` (what runs
 * after the user says yes). Nothing here executes anything.
 *
 * NOT A BINARY IS STILL A DEPENDENCY. A playwright browser bundle is a folder in
 * a cache directory, not an executable on PATH, so `anyOf` alone cannot see it —
 * the `probe: 'playwright-browser'` hook exists for exactly that case and is the
 * only non-PATH check allowed in the table.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { binaryOnPath } from '../utils/binary-probe.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** How much the agent loses without it. */
export type DependencyNeed = 'recommended' | 'optional';

/**
 * Where to get it, per platform. `linuxPackage` names distro packages and is
 * assembled with the package manager the machine ACTUALLY has; `linux` is a
 * complete command for the tools that no distro package provides (a pip
 * install, an install script).
 */
export interface DependencyInstall {
  darwin?: string;
  win32?: string;
  /** Distro package(s), installed with the detected Linux package manager. */
  linuxPackage?: string;
  /** A complete Linux command, used when `linuxPackage` is absent. */
  linux?: string;
}

export interface RuntimeDependency {
  /** Stable id — used by the doctor line, the docs table and tests. */
  id: string;
  /** Human label, printed as-is. */
  label: string;
  need: DependencyNeed;
  /** Present when ANY of these resolves on PATH. */
  anyOf: string[];
  /** The one presence check that is not a PATH lookup (see the header note). */
  probe?: 'playwright-browser';
  /** What installing it buys, one sentence, no jargon. */
  enables: string;
  /** The tools that actually need it — cited by the doctor line and the docs. */
  neededBy: string[];
  install: DependencyInstall;
  /** The caveat that bites in practice, shown right next to the command. */
  note?: string;
}

/**
 * Linux package managers, in preference order, each knowing how to install a
 * package. Shared with `cli/tool-install-prompt.ts` — the module that installs a
 * tool the AGENT needs mid-task — so a user who reads a command in one place and
 * runs it from the other cannot get two different answers.
 *
 * The builder is per-manager rather than a shared "<prefix> install -y <pkg>"
 * template because their command SHAPES differ: apt needs an `update` first,
 * apk takes `add --no-cache` and no `install -y` at all. A shared template
 * produced `sudo apk add install -y ffmpeg`, which is not a command apk accepts
 * (a bug inherited from the table this replaced).
 */
export const LINUX_PACKAGE_MANAGERS: ReadonlyArray<{
  detect: string;
  install: (packages: string) => string;
}> = [
  { detect: 'apt-get', install: (p) => `sudo apt-get update && sudo apt-get install -y ${p}` },
  { detect: 'dnf', install: (p) => `sudo dnf install -y ${p}` },
  { detect: 'yum', install: (p) => `sudo yum install -y ${p}` },
  { detect: 'apk', install: (p) => `sudo apk add --no-cache ${p}` },
];

/** The fallback when no known package manager is on PATH (apt-get is most common). */
const APT_FALLBACK: (packages: string) => string = (p) =>
  `sudo apt-get update && sudo apt-get install -y ${p}`;

// ─── The list ───────────────────────────────────────────────────────────────

/**
 * Every non-bundled runtime dependency, most valuable first.
 *
 * `recommended` means a visible part of the product stops working without it
 * (video, browser automation, local models). `optional` means one capability
 * goes quiet and everything else is unaffected. Ordering is the order the
 * doctor prints, so the things that matter most are read first.
 */
export const RUNTIME_DEPENDENCIES: readonly RuntimeDependency[] = [
  {
    id: 'ffmpeg',
    label: 'FFmpeg',
    need: 'recommended',
    anyOf: ['ffmpeg'],
    enables:
      'Encode the motion renderer’s frames into a video, and preview, trim, merge or transcode any other video or audio file.',
    neededBy: ['motion_render', 'video editing skills', 'voice_mode (records via ffmpeg when sox is absent)'],
    install: {
      // `ffmpeg-full`, NOT `ffmpeg`: the lean formula is built without libass, so
      // a burn-captions render silently degrades to a sidecar .srt (measured on
      // this project, 2026-10-15: brew ffmpeg 9.0.2 had no `subtitles` filter).
      darwin: 'brew install ffmpeg-full',
      linuxPackage: 'ffmpeg',
      win32: 'winget install Gyan.FFmpeg --silent --accept-package-agreements --accept-source-agreements',
    },
    note:
      'macOS: install `ffmpeg-full`, not `ffmpeg` — the plain formula is a lean bottle without libass, so burned-in captions fall back to a separate .srt. `ffmpeg-full` is keg-only: put it first on PATH with export PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH".',
  },
  {
    id: 'chromium',
    label: 'Chromium (Playwright)',
    need: 'recommended',
    anyOf: ['chromium', 'chromium-browser', 'google-chrome', 'chrome'],
    probe: 'playwright-browser',
    enables:
      'Open real pages with the browser tools, and capture the frames the motion renderer turns into a video.',
    neededBy: ['browser_* (navigate, click, extract)', 'motion_render', 'web research fallback'],
    install: {
      // One command on every OS: playwright's own installer puts the bundle in
      // its cache directory, which is where the probe looks.
      darwin: 'npx playwright install chromium',
      linux: 'npx playwright install chromium',
      win32: 'npx playwright install chromium',
    },
    note:
      'Playwright itself is an optional dependency of agent-nuvira: if `npx playwright` is not found, run `npm install -g playwright` first. A render then needs no API key at all.',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    need: 'recommended',
    anyOf: ['ollama'],
    enables:
      'Run models on your own machine — no API key, no cost, and it keeps working offline (nuvira model → local).',
    neededBy: ['local provider', 'router failover', 'offline runs'],
    install: {
      darwin: 'brew install ollama',
      linux: 'curl -fsSL https://ollama.com/install.sh | sh',
      win32: 'winget install Ollama.Ollama --silent --accept-package-agreements --accept-source-agreements',
    },
    note:
      'Start the server (`ollama serve`, or `brew services start ollama`) and pull a model once — e.g. `ollama pull llama3.2`. A model download is several GB; nothing is pulled for you.',
  },
  {
    id: 'edge-tts',
    label: 'edge-tts',
    need: 'optional',
    anyOf: ['edge-tts', 'piper'],
    enables:
      'Local narration for `speak` and for a motion render’s voice-over — free, no API key, no cloud account.',
    neededBy: ['speak', 'motion_render (narration)', 'tts_streaming'],
    install: {
      darwin: 'pip3 install --user edge-tts',
      linux: 'pip3 install --user edge-tts',
      win32: 'pip install edge-tts',
    },
    note:
      'Needs Python 3 with pip. If `edge-tts` is still not on PATH afterwards, add the user bin directory (`python3 -m site --user-base` + /bin) to PATH.',
  },
  {
    id: 'piper',
    label: 'Piper',
    need: 'optional',
    anyOf: ['piper'],
    enables:
      'A fully offline voice for `speak` when edge-tts is not installed or the machine has no network.',
    neededBy: ['speak', 'motion_render (narration)'],
    install: {
      darwin: 'pip3 install --user piper-tts',
      linux: 'pip3 install --user piper-tts',
      win32: 'pip install piper-tts',
    },
    note:
      'A voice model is a separate download: point NUVIRA_PIPER_MODEL at a .onnx voice file. Piper is the fallback only when edge-tts is absent.',
  },
  {
    id: 'whisper',
    label: 'Whisper (speech-to-text)',
    need: 'optional',
    anyOf: ['whisper', 'whisper-cli'],
    enables:
      'Transcribe an audio file or a voice note locally with `transcribe`, so a spoken request can be read as text.',
    neededBy: ['transcribe'],
    install: {
      darwin: 'pip3 install --user openai-whisper',
      linux: 'pip3 install --user openai-whisper',
      win32: 'pip install openai-whisper',
    },
    note:
      'Heavy: pulls torch, and the first run downloads a model. whisper.cpp builds a much smaller `whisper-cli` binary, which the same probe accepts. ffmpeg must be installed either way.',
  },
  {
    id: 'poppler',
    label: 'Poppler (PDF rasteriser)',
    need: 'optional',
    anyOf: ['pdftoppm', 'pdftocairo'],
    enables:
      'Read a scanned, image-only PDF: its pages are rasterised and then transcribed by the vision model, which is the only route for a PDF with no text layer.',
    neededBy: ['knowledge ingest (scanned PDFs)', 'read_extract (OCR fallback)'],
    install: {
      darwin: 'brew install poppler',
      linuxPackage: 'poppler-utils',
      // No trustworthy one-line installer on Windows — Poppler ships there as a
      // zip of binaries. Saying nothing is better than naming a package that may
      // not exist; the manual route is in docs/DEPENDENCIES.md.
    },
    note:
      'Windows: download a Poppler build and add its bin/ to PATH. Linux: the package is `poppler-utils`.',
  },
];

// ─── Presence probes ────────────────────────────────────────────────────────

/** The two facts a probe can establish. Injectable so tests spawn nothing. */
export interface DependencyProbe {
  /** Is this executable on PATH? */
  binary: (name: string) => boolean;
  /** Is a playwright browser bundle present on disk? */
  playwrightBrowser: () => boolean;
}

/**
 * Where playwright keeps its browser bundles. `PLAYWRIGHT_BROWSERS_PATH`
 * overrides the default; the value `0` means "inside node_modules", which is a
 * place this check deliberately does not crawl (see `playwrightBrowserPresent`).
 */
export function playwrightBrowserDirs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const override = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (override && override !== '0') return [override];
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === 'darwin') return [join(home, 'Library', 'Caches', 'ms-playwright')];
  if (platform === 'win32') return [join(home, 'AppData', 'Local', 'ms-playwright')];
  return [join(home, '.cache', 'ms-playwright')];
}

/**
 * True when a chromium bundle is already downloaded. Never throws, and a
 * directory it cannot read is "not present" rather than an error — the cost of
 * being wrong is one redundant `npx playwright install`.
 *
 * `PLAYWRIGHT_BROWSERS_PATH=0` keeps the browsers inside node_modules; this
 * check cannot see them and reports "missing", so the doctor line may say so on
 * a machine where the browser tools work fine. That is stated, not hidden.
 */
export function playwrightBrowserPresent(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.PLAYWRIGHT_BROWSERS_PATH?.trim() === '0') return false;
  for (const dir of playwrightBrowserDirs(env, platform)) {
    try {
      if (!existsSync(dir)) continue;
      if (readdirSync(dir).some((entry) => entry.toLowerCase().startsWith('chromium'))) return true;
    } catch {
      // Unreadable cache directory → keep looking; never fail the check.
    }
  }
  return false;
}

/** The real probe. `binaryOnPath` is the same resolver the shell uses. */
export function defaultDependencyProbe(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DependencyProbe {
  return {
    binary: (name) => binaryOnPath(name),
    playwrightBrowser: () => playwrightBrowserPresent(env, platform),
  };
}

// ─── Status ─────────────────────────────────────────────────────────────────

export interface DependencyStatus {
  dependency: RuntimeDependency;
  present: boolean;
  /** The command for THIS machine, or null when no recipe applies here. */
  installCommand: string | null;
  /** True when running `installCommand` needs a human (sudo password, a GUI). */
  needsHumanInput: boolean;
}

/** Present when any declared binary OR its non-PATH probe answers yes. */
export function dependencyPresent(dep: RuntimeDependency, probe: DependencyProbe): boolean {
  try {
    if (dep.anyOf.some((bin) => probe.binary(bin))) return true;
    if (dep.probe === 'playwright-browser') return probe.playwrightBrowser();
  } catch {
    // A probe failure is "unknown", and unknown is not "present".
  }
  return false;
}

/** Probe the whole list against this machine. Order is the table's order. */
export function probeRuntimeDependencies(
  probe: DependencyProbe = defaultDependencyProbe(),
  platform: NodeJS.Platform = process.platform,
  hasPkgMgr: (name: string) => boolean = binaryOnPath,
  list: readonly RuntimeDependency[] = RUNTIME_DEPENDENCIES,
): DependencyStatus[] {
  return list.map((dependency) => {
    const installCommand = installCommandFor(dependency, platform, hasPkgMgr);
    return {
      dependency,
      present: dependencyPresent(dependency, probe),
      installCommand,
      needsHumanInput: installCommand ? installNeedsHumanInput(installCommand) : false,
    };
  });
}

/** The missing entries, in table order. */
export function missingDependencies(statuses: DependencyStatus[]): DependencyStatus[] {
  return statuses.filter((s) => !s.present);
}

/**
 * One line stating where the machine stands, or '' when nothing is missing.
 * Bounded on purpose: a prompt line, not a report.
 */
export function dependencySummary(statuses: DependencyStatus[]): string {
  const installed = statuses.length - missingDependencies(statuses).length;
  return `${installed} of ${statuses.length} optional tools installed`;
}

/**
 * A bounded block for the model: what this machine does NOT have, and what to
 * do about it. Empty string when everything is installed, so the common case
 * costs no prompt tokens.
 *
 * The last line is the honesty rule that makes this worth the tokens: a feature
 * whose tool is missing was SKIPPED, and the model must not report it as done.
 */
export function buildRuntimeDependenciesBlock(
  statuses: DependencyStatus[] = probeRuntimeDependencies(),
  limit = 5,
): string {
  const missing = missingDependencies(statuses);
  if (missing.length === 0) return '';
  const named = missing.slice(0, limit).map((s) => `${s.dependency.id} (${s.dependency.enables.split(',')[0]})`);
  const rest = missing.length - named.length;
  return [
    '',
    '## Optional tools NOT installed on this machine',
    `${named.join(' · ')}${rest > 0 ? ` · +${rest} more` : ''}`,
    'A feature that needs one of these is SKIPPED, not silently done: say which prerequisite is missing and its install command instead of reporting the feature as working. You may install it yourself with run_terminal (the user has already authorised the work), or tell them to run `nuvira doctor --fix`, which installs the recommended ones after asking.',
  ].join('\n');
}

// ─── Install commands ───────────────────────────────────────────────────────

/**
 * The install command for a Linux distro package, using the FIRST package
 * manager actually present. The fallback is apt-get (most common) so a machine
 * with an unusual manager still gets a command rather than an empty answer.
 */
export function linuxInstallCommand(
  packages: string,
  hasPkgMgr: (name: string) => boolean,
): string {
  for (const pm of LINUX_PACKAGE_MANAGERS) {
    if (hasPkgMgr(pm.detect)) return pm.install(packages).replace(/\s+/g, ' ');
  }
  return APT_FALLBACK(packages).replace(/\s+/g, ' ');
}

/** The concrete install command for one dependency on THIS machine, or null. */
export function installCommandFor(
  dep: RuntimeDependency,
  platform: NodeJS.Platform = process.platform,
  hasPkgMgr: (name: string) => boolean = binaryOnPath,
): string | null {
  const { darwin, linux, linuxPackage, win32 } = dep.install;
  if (platform === 'darwin') return darwin ?? null;
  if (platform === 'win32') return win32 ?? null;
  if (platform === 'linux') {
    if (linuxPackage) return linuxInstallCommand(linuxPackage, hasPkgMgr);
    return linux ?? null;
  }
  return null;
}

/**
 * True when an install command cannot run unattended — it will block on input we
 * must not fabricate (a `sudo`/administrator password, the macOS
 * `xcode-select --install` GUI, an explicit `--interactive` installer).
 *
 * Used to choose between "install it yourself" and the honest handoff note that
 * names the one step the user must take.
 */
export function installNeedsHumanInput(installCommand: string): boolean {
  const c = String(installCommand ?? '');
  return (
    /(?:^|[\s;&|])sudo\b/.test(c) ||
    /xcode-select\s+--install/.test(c) ||
    /--interactive\b/.test(c)
  );
}

export interface InstallStep {
  dependency: RuntimeDependency;
  command: string;
  /** False when the agent can run it unattended (no sudo/password/GUI). */
  needsHumanInput: boolean;
}

/**
 * What `nuvira doctor --fix` would run, in table order: every MISSING dependency
 * that has a recipe for this machine. A missing dependency with no recipe here
 * is returned by `missingDependencies()` but absent from the plan, so the caller
 * can still print the manual route — never a silent skip.
 */
export function installPlan(
  statuses: DependencyStatus[],
  options: { includeOptional?: boolean } = {},
): InstallStep[] {
  const includeOptional = options.includeOptional ?? true;
  return missingDependencies(statuses)
    .filter((s) => s.installCommand !== null)
    .filter((s) => includeOptional || s.dependency.need === 'recommended')
    .map((s) => ({
      dependency: s.dependency,
      command: s.installCommand as string,
      needsHumanInput: s.needsHumanInput,
    }));
}

/**
 * The list a user can act on, one line per missing dependency: what it is, what
 * it buys, and the exact command. This is the "share the list" half of the
 * feature — the same text the docs table is generated from, printed by the
 * doctor so nobody has to find the docs.
 */
export function dependencyInstallLines(statuses: DependencyStatus[]): string[] {
  return missingDependencies(statuses).map((s) => {
    const cmd = s.installCommand ? s.installCommand : 'no one-line installer on this OS — see docs/DEPENDENCIES.md';
    return `${s.dependency.label} (${s.dependency.need}) — ${s.dependency.enables} Install: ${cmd}`;
  });
}
