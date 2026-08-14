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
