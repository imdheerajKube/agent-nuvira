/**
 * Interactive missing-system-tool prompt for the runner (enterprise parity).
 *
 * When a command needs a system tool that is not installed (e.g. `zip` for
 * packaging an NVDA addon, `git`, `make`, `cmake`), the runner must NOT fail
 * silently and must NOT install OS-level software without consent. Instead it:
 *
 *   1. Detects the missing tool from the failing command.
 *   2. Recommends the OS-appropriate install command (Homebrew on macOS,
 *      apt/dnf/apk on Linux, winget/choco on Windows).
 *   3. Asks the user for approval (interactive TTY) — "install now", "show me
 *      manual steps", or "skip".
 *   4. On approval the runner executes the install, verifies the tool, and
 *      RE-RUNS the original command so the task completes.
 *
 * Non-interactive (piped/CI) stdin never blocks: the recommended command is
 * printed and the task fails with actionable instructions — the manual task is
 * left to the user, exactly like a human agent would hand off a step it cannot
 * complete alone (e.g. generating a token).
 *
 * This module is small and dependency-light so it can be unit tested in
 * isolation (inquirer mocked), mirroring failover-prompt.ts / weak-model-prompt.ts.
 */

import inquirer from 'inquirer';
import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** What the user chose when a required system tool is missing. */
export type ToolInstallChoice = 'install' | 'manual' | 'skip';

/** Per-platform install commands for a known tool. */
export interface ToolInstallOptions {
  darwin?: string;
  linux?: string;
  win32?: string;
}

// ─── Per-OS install recipes for common build/system tools ──────────────────

/**
 * Known system tools and their OS-appropriate install commands. Keys are the
 * bare command names the runner sees on the command line. The command chosen
 * is filtered by which package manager actually exists on the machine
 * (brew / apt-get / dnf / yum / apk / winget / choco) — see toolInstallCommand().
 */
const TOOL_INSTALL_OPTIONS: Record<string, ToolInstallOptions> = {
  zip: {
    darwin: 'brew install zip',
    linux: 'install -y zip',
    win32: 'winget install 7zip.7zip --silent --accept-package-agreements --accept-source-agreements',
  },
  unzip: {
    darwin: 'brew install unzip',
    linux: 'install -y unzip',
    win32: 'winget install 7zip.7zip --silent --accept-package-agreements --accept-source-agreements',
  },
  git: {
    darwin: 'brew install git',
    linux: 'install -y git',
    win32: 'winget install Git.Git --silent --accept-package-agreements --accept-source-agreements',
  },
  make: {
    darwin: 'xcode-select --install',
    linux: 'install -y make',
    win32: 'winget install GnuWin32.Make --silent --accept-package-agreements --accept-source-agreements',
  },
  cmake: {
    darwin: 'brew install cmake',
    linux: 'install -y cmake',
    win32: 'winget install Kitware.CMake --silent --accept-package-agreements --accept-source-agreements',
  },
  curl: {
    darwin: 'brew install curl',
    linux: 'install -y curl',
    win32: 'winget install cURL.cURL --silent --accept-package-agreements --accept-source-agreements',
  },
  wget: {
    darwin: 'brew install wget',
    linux: 'install -y wget',
    win32: 'winget install GNU.Wget2 --silent --accept-package-agreements --accept-source-agreements',
  },
  jq: {
    darwin: 'brew install jq',
    linux: 'install -y jq',
    win32: 'winget install jqlang.jq --silent --accept-package-agreements --accept-source-agreements',
  },
  rsync: {
    darwin: 'brew install rsync',
    linux: 'install -y rsync',
    win32: 'winget install Cygwin.Cygwin --silent --accept-package-agreements --accept-source-agreements',
  },
  ffmpeg: {
    darwin: 'brew install ffmpeg',
    linux: 'install -y ffmpeg',
    win32: 'winget install Gyan.FFmpeg --silent --accept-package-agreements --accept-source-agreements',
  },
  pandoc: {
    darwin: 'brew install pandoc',
    linux: 'install -y pandoc',
    win32: 'winget install JohnMacFarlane.Pandoc --silent --accept-package-agreements --accept-source-agreements',
  },
  gcc: {
    darwin: 'xcode-select --install',
    linux: 'install -y build-essential',
    win32: 'winget install LLVM.LLVM --silent --accept-package-agreements --accept-source-agreements',
  },
  'g++': {
    darwin: 'xcode-select --install',
    linux: 'install -y build-essential',
    win32: 'winget install LLVM.LLVM --silent --accept-package-agreements --accept-source-agreements',
  },
  clang: {
    darwin: 'xcode-select --install',
    linux: 'install -y clang',
    win32: 'winget install LLVM.LLVM --silent --accept-package-agreements --accept-source-agreements',
  },
  // ── Container / infra tooling (enterprise build pipelines) ─────────────
  docker: {
    darwin: 'brew install --cask docker',
    linux: 'install -y docker.io',
    win32: 'winget install Docker.DockerDesktop --silent --accept-package-agreements --accept-source-agreements',
  },
  kubectl: {
    darwin: 'brew install kubectl',
    linux: 'install -y kubectl',
    win32: 'winget install Kubernetes.kubectl --silent --accept-package-agreements --accept-source-agreements',
  },
  terraform: {
    darwin: 'brew install terraform',
    linux: 'install -y terraform',
    win32: 'winget install HashiCorp.Terraform --silent --accept-package-agreements --accept-source-agreements',
  },
  packer: {
    darwin: 'brew install packer',
    linux: 'install -y packer',
    win32: 'winget install HashiCorp.Packer --silent --accept-package-agreements --accept-source-agreements',
  },
  vault: {
    darwin: 'brew install vault',
    linux: 'install -y vault',
    win32: 'winget install HashiCorp.Vault --silent --accept-package-agreements --accept-source-agreements',
  },
  helm: {
    darwin: 'brew install helm',
    linux: 'install -y helm',
    win32: 'winget install Helm.Helm --silent --accept-package-agreements --accept-source-agreements',
  },
  minikube: {
    darwin: 'brew install minikube',
    linux: 'install -y minikube',
    win32: 'winget install Kubernetes.minikube --silent --accept-package-agreements --accept-source-agreements',
  },
  // ── Cloud CLIs ───────────────────────────────────────────────────────────
  aws: {
    darwin: 'brew install awscli',
    linux: 'install -y awscli',
    win32: 'winget install Amazon.AWSCLI --silent --accept-package-agreements --accept-source-agreements',
  },
  az: {
    darwin: 'brew install azure-cli',
    linux: 'install -y azure-cli',
    win32: 'winget install Microsoft.AzureCLI --silent --accept-package-agreements --accept-source-agreements',
  },
  gcloud: {
    darwin: 'brew install --cask google-cloud-sdk',
    linux: 'install -y google-cloud-cli',
    win32: 'winget install Google.CloudSDK --silent --accept-package-agreements --accept-source-agreements',
  },
  gh: {
    darwin: 'brew install gh',
    linux: 'install -y gh',
    win32: 'winget install GitHub.cli --silent --accept-package-agreements --accept-source-agreements',
  },
  glab: {
    darwin: 'brew install glab',
    linux: 'install -y glab',
    win32: 'winget install GLab.glab --silent --accept-package-agreements --accept-source-agreements',
  },
  // ── Language toolchains & package managers (beyond npm/pip) ────────────
  cargo: {
    darwin: 'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y',
    linux: 'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y',
    win32: 'winget install Rustlang.Rustup --silent --accept-package-agreements --accept-source-agreements',
  },
  // rustc/rustup travel with cargo (the Tauri/Rust case): a `rustc: command
  // not found` is the same missing toolchain and must trigger the takeover too.
  rustc: {
    darwin: 'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y',
    linux: 'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y',
    win32: 'winget install Rustlang.Rustup --silent --accept-package-agreements --accept-source-agreements',
  },
  rustup: {
    darwin: 'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y',
    linux: 'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y',
    win32: 'winget install Rustlang.Rustup --silent --accept-package-agreements --accept-source-agreements',
  },
  go: {
    darwin: 'brew install go',
    linux: 'install -y golang-go',
    win32: 'winget install GoLang.Go --silent --accept-package-agreements --accept-source-agreements',
  },
  java: {
    darwin: 'brew install openjdk',
    linux: 'install -y openjdk-17-jdk',
    win32: 'winget install EclipseAdoptium.Temurin.17.JDK --silent --accept-package-agreements --accept-source-agreements',
  },
  mvn: {
    darwin: 'brew install maven',
    linux: 'install -y maven',
    win32: 'winget install Apache.Maven --silent --accept-package-agreements --accept-source-agreements',
  },
  gradle: {
    darwin: 'brew install gradle',
    linux: 'install -y gradle',
    win32: 'winget install Gradle.Gradle --silent --accept-package-agreements --accept-source-agreements',
  },
  dotnet: {
    darwin: 'brew install --cask dotnet-sdk',
    linux: 'install -y dotnet-sdk-8.0',
    win32: 'winget install Microsoft.DotNet.SDK.8 --silent --accept-package-agreements --accept-source-agreements',
  },
  ruby: {
    darwin: 'brew install ruby',
    linux: 'install -y ruby-full',
    win32: 'winget install RubyInstallerTeam.Ruby.3.2 --silent --accept-package-agreements --accept-source-agreements',
  },
  bundle: {
    darwin: 'gem install bundler',
    linux: 'install -y bundler || gem install bundler',
    win32: 'gem install bundler',
  },
  php: {
    darwin: 'brew install php',
    linux: 'install -y php-cli',
    win32: 'winget install PHP.PHP.8.3 --silent --accept-package-agreements --accept-source-agreements',
  },
  composer: {
    darwin: 'brew install composer',
    linux: 'install -y composer',
    win32: 'winget install Composer.Composer --silent --accept-package-agreements --accept-source-agreements',
  },
  dart: {
    darwin: 'brew install dart',
    linux: 'install -y dart',
    win32: 'winget install Dart.Dart --silent --accept-package-agreements --accept-source-agreements',
  },
  flutter: {
    darwin: 'brew install --cask flutter',
    linux: 'install -y flutter',
    win32: 'winget install Flutter.Flutter --silent --accept-package-agreements --accept-source-agreements',
  },
  // ── Databases / services clients ─────────────────────────────────────────
  psql: {
    darwin: 'brew install postgresql@16',
    linux: 'install -y postgresql-client',
    win32: 'winget install PostgreSQL.PostgreSQL.16 --silent --accept-package-agreements --accept-source-agreements',
  },
  redis: {
    darwin: 'brew install redis',
    linux: 'install -y redis-tools',
    win32: 'winget install Redis.Redis --silent --accept-package-agreements --accept-source-agreements',
  },
  sqlite3: {
    darwin: 'brew install sqlite3',
    linux: 'install -y sqlite3',
    win32: 'winget install SQLite.SQLite --silent --accept-package-agreements --accept-source-agreements',
  },
  mongosh: {
    darwin: 'brew install mongosh',
    linux: 'install -y mongodb-mongosh',
    win32: 'winget install MongoDB.MongoSH --silent --accept-package-agreements --accept-source-agreements',
  },
  // ── General utilities ────────────────────────────────────────────────────
  '7z': {
    darwin: 'brew install sevenzip',
    linux: 'install -y p7zip-full',
    win32: 'winget install 7zip.7zip --silent --accept-package-agreements --accept-source-agreements',
  },
  rar: {
    darwin: 'brew install rar',
    linux: 'install -y rar',
    win32: 'winget install RARLab.WinRAR --silent --accept-package-agreements --accept-source-agreements',
  },
  htop: {
    darwin: 'brew install htop',
    linux: 'install -y htop',
    win32: 'winget install htop.htop --silent --accept-package-agreements --accept-source-agreements',
  },
  tmux: {
    darwin: 'brew install tmux',
    linux: 'install -y tmux',
    win32: 'winget install tmux.tmux --silent --accept-package-agreements --accept-source-agreements',
  },
  watch: {
    darwin: 'brew install watch',
    linux: 'install -y procps',
    // watch is not first-class on Windows — no recipe
  },
  tar: {
    darwin: 'brew install libarchive',
    linux: 'install -y tar',
    // bsdtar ships with Windows 10+ — no recipe
  },
};

/** Linux package-manager prefixes, tried in order of preference. */
const LINUX_PKG_MANAGERS: Array<{ detect: string; prefix: string }> = [
  { detect: 'apt-get', prefix: 'sudo apt-get update && sudo apt-get' },
  { detect: 'dnf', prefix: 'sudo dnf' },
  { detect: 'yum', prefix: 'sudo yum' },
  { detect: 'apk', prefix: 'sudo apk add' },
];

/** Whether we have an install recipe for this tool on any OS. */
export function isKnownSystemTool(tool: string): boolean {
  return tool in TOOL_INSTALL_OPTIONS;
}

// ─── Missing-prerequisite detection (chat/loop takeover) ────────────────────

/**
 * Signals that a shell command failed because its binary is not on PATH.
 * Deliberately specific: a bare "not found" in prose must not trigger the
 * takeover (it would fire on any error text that happens to contain it).
 */
const MISSING_BINARY_RE =
  /(?:command not found|not found in (?:the )?\$?PATH|no such file or directory|\bENOENT\b|exit (?:code )?127|\.sh: [a-z0-9_.+-]+: command not found|is not recognized as an internal or external command|is not recognized as the name of a cmdlet|not recognized as the name of a cmdlet|exit (?:code )?9009)/i;

/**
 * Candidate tool names in a shell command line: the first token of every
 * pipeline / `&&` / `;` segment, with `sudo`/`env`-style prefixes stripped.
 * Pure; never throws.
 */
export function commandToolNames(command: string): string[] {
  return String(command ?? '')
    .split(/(?:\|\||&&|[;|\n])/)
    .map((seg) => seg.trim())
    // `&` is PowerShell's call operator (`& cargo build`); strip it like sudo.
    .map((seg) => seg.replace(/^(?:sudo|command|env|nohup|time|&)\s+/i, '').trim())
    .map((seg) => seg.split(/\s+/)[0] ?? '')
    .map((tok) => tok.replace(/^[('"`]+/, '').replace(/[)'"`]+$/, ''))
    // Windows executables are typed with their extension (`cargo.exe`) — the
    // recipe table keys on the bare name, so drop it.
    .map((tok) => tok.replace(/\.(?:exe|cmd|bat)$/i, ''))
    .filter((tok) => /^[a-z0-9_][a-z0-9_.+-]*$/i.test(tok));
}

/**
 * ALL known, installable system tools implicated by a failing command, in the
 * order the shell would hit them, de-duplicated. The missing-binary signal in
 * `output` is REQUIRED: a nonzero exit from a PRESENT tool (a failing test, a
 * build error) is not this case.
 *
 * A single command line can need several prerequisites at once
 * (`cd app && cargo build && cmake .`), which is the v3.3.3 behavior the user
 * remembers: "agent kicks in and says I can install all of those software".
 */
export function installableToolsFromFailure(command: string, output: string): string[] {
  if (!MISSING_BINARY_RE.test(String(output ?? ''))) return [];
  const found: string[] = [];
  for (const name of commandToolNames(command)) {
    if (isKnownSystemTool(name) && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * The FIRST known, installable system tool implicated by a failing command —
 * or null. Kept for callers that only need the head of the list.
 */
export function installableToolFromFailure(command: string, output: string): string | null {
  return installableToolsFromFailure(command, output)[0] ?? null;
}

/**
 * Is `name` an executable on PATH? Cheap (no spawn) — used to pick the install
 * recipe for the machine we are actually on.
 */
export function commandOnPath(name: string): boolean {
  const dirs = (process.env.PATH ?? '').split(delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return dirs.some((dir) => dir && exts.some((ext) => existsSync(join(dir, name + ext))));
}

/** The concrete install command for a known tool on THIS machine, or null. */
export function resolveInstallCommand(tool: string): string | null {
  return toolInstallCommand(tool, process.platform, commandOnPath);
}

/**
 * The deterministic TAKEOVER instruction appended to a failed `run_terminal`
 * result when a known, installable prerequisite is missing.
 *
 * WHY THIS EXISTS (live, 2026-10-03, trace trace-1791127992452-qzgodi).
 * Asked to build a Tauri app, the model ran `cargo --version` → exit 127 and
 * then DECLARED "I cannot install system-level software like Rust on your host
 * machine — I am physically unable to build the Tauri application", handing the
 * user a manual `curl … | sh` step. It was not sandboxed at all: it had a real
 * shell and had just been told "i allow you to access my tools and skills and
 * execute the commands on my terminal". A missing PREREQUISITE is a step to
 * complete, not a wall — so this instruction names the exact install command
 * and forbids the enclosed-system refusal.
 */
export function toolTakeoverInstruction(
  tool: string | string[],
  installCommand?: string | Array<string | null>,
): string {
  const tools = Array.isArray(tool) ? tool : [tool];
  const commands = (Array.isArray(installCommand) ? installCommand : [installCommand])
    .map((c) => (c ?? '').trim())
    .filter((c) => c.length > 0);
  const list = tools.join(', ');
  const lines = [
    `🤖 I'm Nuvira, your agent — and yes, I can install ${tools.length > 1 ? 'these' : 'this'} myself.`,
    `🛠️ TOOL TAKEOVER — ${list} ${tools.length > 1 ? 'are' : 'is'} missing and INSTALLABLE on this machine.`,
    'You are running on the user\u2019s REAL machine with a REAL shell. You are NOT sandboxed, NOT "enclosed",',
    'and NOT blocked from installing software. A missing prerequisite is something to FIX, not to hand off.',
    'Install it now with run_terminal (pass confirm:true if the tool asks — the user already authorized this',
    'work), then re-run the original command that failed:',
  ];
  for (const c of commands) lines.push(`    ${c}`);
  lines.push(
    'Do NOT tell the user to install it themselves and do NOT claim you are unable or not permitted — they',
    'already asked you to do this work. TRY the install yourself first. If it genuinely needs interactive',
    'input you cannot supply (a sudo/admin password, a GUI installer, an OS license prompt), STOP and hand',
    'off ONE clear note in exactly this shape, then wait:',
    `    🛠️ I tried to install <tool> because <one-line reason it is needed>, but it needs you to do this one step:`,
    `        <exact command>`,
    `    Nothing else in the work is blocked — tell me once it is done and I will continue.`,
    'Never silently skip the prerequisite and never pretend the task completed without it.',
  );
  return lines.join('\n');
}

/**
 * True when an install command cannot run unattended — it will block on human
 * input we must not fabricate (a `sudo`/administrator password, the macOS
 * `xcode-select --install` GUI, an explicit `--interactive` installer). Used to
 * decide between "install it yourself" and the honest handoff note.
 */
export function installNeedsHumanInput(installCommand: string): boolean {
  const c = String(installCommand ?? '');
  return (
    /(?:^|[\s;&|])sudo\b/.test(c) ||
    /xcode-select\s+--install/.test(c) ||
    /--interactive\b/.test(c)
  );
}

/**
 * The single, deterministic handoff note for a prerequisite the agent TRIED to
 * install but that needs a human step it cannot supply. Names what was tried,
 * WHY the tool is needed, and the exact command — so the user can finish one
 * step and the agent resumes, instead of the agent looping or pretending.
 */
export function humanInterventionNote(
  tool: string,
  installCommand: string,
  reason?: string,
): string {
  return [
    `🛠️ I tried to install '${tool}'${reason ? ` because ${reason}` : ''}, but it needs you to do this one step:`,
    `    ${installCommand}`,
    `Nothing else in the work is blocked — tell me once it's done and I'll continue from where I left off.`,
  ].join('\n');
}

/**
 * Pick the concrete install command for a tool on this machine.
 *
 * @param tool      Bare command name (e.g. 'zip').
 * @param platform  process.platform value ('darwin' | 'linux' | 'win32').
 * @param hasPkgMgr Predicate answering "is this package manager on PATH?"
 *                  (the runner injects its commandExists check).
 * @returns The full shell command to install the tool, or null when no recipe
 *          applies to this platform/package-manager combination.
 */
export function toolInstallCommand(
  tool: string,
  platform: NodeJS.Platform,
  hasPkgMgr: (name: string) => boolean,
): string | null {
  const opts = TOOL_INSTALL_OPTIONS[tool];
  if (!opts) return null;

  if (platform === 'darwin') {
    // Homebrew is the standard macOS package manager. If brew is missing the
    // recipe still tells the user to install brew first (curl script) — the
    // runner will surface that as a manual step.
    return opts.darwin || null;
  }

  if (platform === 'linux') {
    if (!opts.linux) return null;
    for (const pm of LINUX_PKG_MANAGERS) {
      if (hasPkgMgr(pm.detect)) {
        // opts.linux is "install -y <pkg>" — prefix the detected manager.
        return `${pm.prefix} ${opts.linux}`.replace(/\s+/g, ' ');
      }
    }
    // Fall back to apt-get (most common) — the runner's install will surface
    // a clear error if sudo/apt is unavailable, and the user gets manual steps.
    return `sudo apt-get update && sudo apt-get ${opts.linux}`.replace(/\s+/g, ' ');
  }

  if (platform === 'win32') {
    if (!opts.win32) return null;
    // Prefer winget, fall back to choco when winget is absent.
    if (hasPkgMgr('winget')) return opts.win32;
    if (hasPkgMgr('choco')) {
      const pkg = tool === 'zip' || tool === 'unzip' ? '7zip' : tool;
      return `choco install ${pkg} -y`;
    }
    return opts.win32;
  }

  return null;
}

// ─── Interactive approval prompt ────────────────────────────────────────────

/**
 * Ask the user how to handle a missing system tool. TTY-only — callers must
 * gate on process.stdin.isTTY (non-interactive callers fall through to the
 * fail-with-instructions path instead of blocking).
 *
 * @param tool   Bare command name that is missing (e.g. 'zip').
 * @param cmd    The concrete OS-appropriate install command to recommend.
 * @returns 'install' to run the install and continue, 'manual' to show steps
 *          and fail, or 'skip' to continue without installing.
 */
export async function promptToolInstall(
  tool: string,
  cmd: string,
): Promise<ToolInstallChoice> {
  console.log('');
  logger.warn(`   🛠️  Tool '${tool}' is not installed — this task needs it.`);
  console.log('');

  const choices: Array<{ name: string; value: ToolInstallChoice }> = [
    {
      name: `▶  Install it now (${cmd})`,
      value: 'install',
    },
    {
      name: '📋  Show me the manual install steps — I will do it myself',
      value: 'manual',
    },
    {
      name: '⏭  Skip — continue without this tool',
      value: 'skip',
    },
  ];

  const answer = await inquirer.prompt<{ action: ToolInstallChoice }>([
    {
      type: 'list',
      name: 'action',
      message: `Install '${tool}' now?`,
      prefix: '🛠️',
      choices,
    },
  ]);

  console.log('');
  return answer.action;
}

/** Render the manual-install instructions for a tool (used when the user asks, or in non-interactive mode). */
export function manualInstallSteps(tool: string, cmd: string): string {
  const lines = [
    `The tool '${tool}' is required but not installed on this machine.`,
    `Install it manually, e.g.:`,
    `    ${cmd}`,
    `(macOS also accepts: brew install ${tool}; Windows: winget install ${tool})`,
    `Then re-run the task.`,
  ];
  return lines.join('\n');
}
