import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isKnownSystemTool,
  toolInstallCommand,
  manualInstallSteps,
  promptToolInstall,
  commandToolNames,
  installableToolFromFailure,
  installableToolsFromFailure,
  installNeedsHumanInput,
  humanInterventionNote,
  toolTakeoverInstruction,
  type ToolInstallChoice,
} from '../../src/cli/tool-install-prompt.js';

// Mock inquirer — the prompt module imports it directly.
vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
}));

import inquirer from 'inquirer';

describe('tool-install-prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isKnownSystemTool', () => {
    it('recognizes common build tools', () => {
      expect(isKnownSystemTool('zip')).toBe(true);
      expect(isKnownSystemTool('git')).toBe(true);
      expect(isKnownSystemTool('make')).toBe(true);
      expect(isKnownSystemTool('cmake')).toBe(true);
    });

    it('recognizes enterprise infra + cloud + language tools', () => {
      for (const t of ['docker', 'kubectl', 'terraform', 'helm', 'minikube', 'aws', 'az', 'gcloud', 'gh', 'go', 'cargo', 'java', 'mvn', 'gradle', 'dotnet', 'flutter', 'psql', 'mongosh', 'sqlite3', '7z']) {
        expect(isKnownSystemTool(t)).toBe(true);
      }
    });

    it('rejects unknown commands', () => {
      expect(isKnownSystemTool('python')).toBe(false); // handled by interpreter normalize
      expect(isKnownSystemTool('wrangler')).toBe(false);
      expect(isKnownSystemTool('random-tool-xyz')).toBe(false);
    });
  });

  describe('toolInstallCommand', () => {
    const has = (names: string[]) => (name: string) => names.includes(name);
    const noPkg = () => false;

    it('returns the Homebrew command on macOS', () => {
      const cmd = toolInstallCommand('zip', 'darwin', noPkg);
      expect(cmd).toBe('brew install zip');
    });

    it('uses the detected Linux package manager (apt-get)', () => {
      const cmd = toolInstallCommand('git', 'linux', has(['apt-get']));
      expect(cmd).toContain('apt-get');
      expect(cmd).toContain('install -y git');
    });

    it('uses dnf when apt-get is absent on Linux', () => {
      const cmd = toolInstallCommand('cmake', 'linux', has(['dnf']));
      expect(cmd).toContain('dnf');
      expect(cmd).toContain('cmake');
    });

    it('falls back to apt-get on Linux when no package manager is detected', () => {
      const cmd = toolInstallCommand('zip', 'linux', noPkg);
      expect(cmd).toContain('apt-get');
    });

    it('prefers winget on Windows and falls back to choco', () => {
      const winget = toolInstallCommand('zip', 'win32', has(['winget']));
      expect(winget).toContain('winget');
      const choco = toolInstallCommand('zip', 'win32', has(['choco']));
      expect(choco).toContain('choco');
    });

    it('returns docker/kubectl/terraform recipes per OS', () => {
      expect(toolInstallCommand('docker', 'darwin', noPkg)).toContain('docker');
      const linuxDocker = toolInstallCommand('docker', 'linux', has(['apt-get']));
      expect(linuxDocker).toContain('docker.io');
      expect(toolInstallCommand('kubectl', 'win32', has(['winget']))).toContain('winget');
      expect(toolInstallCommand('terraform', 'darwin', noPkg)).toContain('terraform');
    });

    it('returns null for tools with no recipe on that platform (e.g. tar/watch on Windows)', () => {
      expect(toolInstallCommand('tar', 'win32', noPkg)).toBeNull();
      expect(toolInstallCommand('watch', 'win32', noPkg)).toBeNull();
    });

    it('returns null for unknown tools or unsupported platforms', () => {
      expect(toolInstallCommand('nope-tool', 'darwin', noPkg)).toBeNull();
      expect(toolInstallCommand('zip', 'freebsd' as any, noPkg)).toBeNull();
    });
  });

  describe('commandToolNames', () => {
    it('extracts the tool from each pipeline/&& segment, stripping sudo', () => {
      expect(commandToolNames('cargo --version')).toEqual(['cargo']);
      expect(commandToolNames('cd src-tauri && cargo build')).toEqual(['cd', 'cargo']);
      expect(commandToolNames('sudo apt-get install -y jq')).toContain('apt-get');
    });

    it('normalizes Windows shapes: PowerShell call operator + .exe extension', () => {
      expect(commandToolNames('& cargo.exe +stable-x86_64-pc-windows-msvc build')).toEqual(['cargo']);
      expect(commandToolNames('npx.cmd tauri build')).toEqual(['npx']);
      expect(commandToolNames('winget install Rustlang.Rustup')).toContain('winget');
    });
  });

  describe('installableToolFromFailure — the missing-prerequisite takeover trigger', () => {
    it('detects a known missing tool from the failure output', () => {
      expect(installableToolFromFailure('cargo --version', '/bin/sh: cargo: command not found')).toBe('cargo');
      expect(installableToolFromFailure('cd src-tauri && cargo build', 'sh: cargo: command not found')).toBe('cargo');
      expect(installableToolFromFailure('zip -r out.zip .', 'exit code 127')).toBe('zip');
    });

    it('detects the Windows missing-command messages (cmd.exe + PowerShell) and exit 9009', () => {
      // cmd.exe
      expect(
        installableToolFromFailure(
          'cargo --version',
          "'cargo' is not recognized as an internal or external command,\noperable program or batch file.",
        ),
      ).toBe('cargo');
      // PowerShell
      expect(
        installableToolFromFailure(
          'cargo build',
          "cargo : The term 'cargo' is not recognized as the name of a cmdlet, function, script file, or operable program.",
        ),
      ).toBe('cargo');
      // A bare Windows error code (9009) with no message text.
      expect(installableToolFromFailure('cmake --version', 'exit code 9009')).toBe('cmake');
      // PowerShell call operator + .exe are normalized before the lookup.
      expect(
        installableToolFromFailure('& cargo.exe build', "cargo.exe : The term 'cargo.exe' is not recognized as the name of a cmdlet"),
      ).toBe('cargo');
    });

    it('does NOT fire without a missing-binary signal (a plain nonzero exit is not this case)', () => {
      expect(installableToolFromFailure('cargo build', 'error[E0432]: unresolved import `foo`')).toBeNull();
      expect(installableToolFromFailure('npm test', 'Tests failed: 3 failing')).toBeNull();
      expect(installableToolFromFailure('npx tauri build', "error: the package 'cal' does not contain this feature: custom-protocol")).toBeNull();
    });

    it('does NOT fire for an unknown/unrecipe tool', () => {
      expect(installableToolFromFailure('wrangler deploy', 'wrangler: command not found')).toBeNull();
    });
  });

  describe('installableToolsFromFailure', () => {
    it('returns EVERY installable tool a single failing line needs, de-duplicated', () => {
      expect(
        installableToolsFromFailure('cd app && cargo build && cmake .', 'sh: cargo: command not found'),
      ).toEqual(['cargo', 'cmake']);
      expect(
        installableToolsFromFailure('cargo build && cargo test', 'sh: cargo: command not found'),
      ).toEqual(['cargo']);
    });

    it('returns an empty list without a missing-binary signal', () => {
      expect(installableToolsFromFailure('cargo build', 'error[E0432]: unresolved import')).toEqual([]);
    });
  });

  describe('installNeedsHumanInput', () => {
    it('flags sudo / xcode-select / interactive installs', () => {
      expect(installNeedsHumanInput('sudo apt-get install -y make')).toBe(true);
      expect(installNeedsHumanInput('xcode-select --install')).toBe(true);
      expect(installNeedsHumanInput('brew install --interactive foo')).toBe(true);
    });

    it('does not flag unattended installs', () => {
      expect(installNeedsHumanInput('brew install zip')).toBe(false);
      expect(installNeedsHumanInput('winget install Rustlang.Rustup --silent')).toBe(false);
    });
  });

  describe('humanInterventionNote', () => {
    it('states what was tried, why, and the exact command to run', () => {
      const note = humanInterventionNote('make', 'xcode-select --install', 'the build needs a native toolchain');
      expect(note).toContain("I tried to install 'make'");
      expect(note).toContain('because the build needs a native toolchain');
      expect(note).toContain('xcode-select --install');
      // The agent stays available to resume — it is a handoff, not a dead end.
      expect(note).toMatch(/tell me once it's done/);
    });

    it('omits the reason clause when none is given', () => {
      const note = humanInterventionNote('make', 'sudo apt-get install -y make');
      expect(note).toContain("I tried to install 'make'");
      expect(note).not.toContain('because');
    });
  });

  describe('toolTakeoverInstruction', () => {
    it('identifies as the agent and says it can install the tool itself', () => {
      const text = toolTakeoverInstruction('cargo', 'curl --proto https://sh.rustup.rs | sh -s -- -y');
      expect(text).toContain("I'm Nuvira, your agent");
      expect(text).toContain('cargo');
      expect(text).toContain('rustup');
      expect(text).toContain('run_terminal');
      expect(text).toMatch(/NOT sandboxed/);
      expect(text).toMatch(/Do NOT tell the user to install it themselves/);
    });

    it('lists EVERY missing tool and its command (the v3.3.3 "install all of those" behavior)', () => {
      const text = toolTakeoverInstruction(
        ['cargo', 'cmake'],
        ['curl --proto https://sh.rustup.rs | sh -s -- -y', 'brew install cmake'],
      );
      expect(text).toContain('cargo, cmake');
      expect(text).toContain('rustup');
      expect(text).toContain('brew install cmake');
      expect(text).toContain('these');
    });

    it('teaches the honest human-intervention handoff for interactive installs', () => {
      const text = toolTakeoverInstruction('make', 'xcode-select --install');
      expect(text).toMatch(/TRY the install yourself first/);
      // The exact note shape: what was tried, the reason, the command, resume.
      expect(text).toMatch(/I tried to install <tool> because/);
      expect(text).toMatch(/tell me once it is done and I will continue/);
    });

    it('still reads well when no install command is available', () => {
      const text = toolTakeoverInstruction('go', '');
      expect(text).toContain('go');
      expect(text).toContain('run_terminal');
    });
  });

  describe('manualInstallSteps', () => {
    it('renders the tool, command, and re-run guidance', () => {
      const steps = manualInstallSteps('zip', 'brew install zip');
      expect(steps).toContain('zip');
      expect(steps).toContain('brew install zip');
      expect(steps).toContain('re-run');
    });
  });

  describe('promptToolInstall', () => {
    it('offers install / manual / skip and returns the selection', async () => {
      (inquirer.prompt as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ action: 'install' });
      const choice = await promptToolInstall('zip', 'brew install zip');
      expect(choice).toBe('install');

      const promptArg = (inquirer.prompt as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0][0];
      expect(promptArg.type).toBe('list');
      const values = promptArg.choices.map((c: { value: string }) => c.value);
      expect(values).toEqual(expect.arrayContaining(['install', 'manual', 'skip']));
    });

    it('can return manual or skip', async () => {
      for (const action of ['manual', 'skip'] as ToolInstallChoice[]) {
        (inquirer.prompt as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ action });
        const choice = await promptToolInstall('git', 'brew install git');
        expect(choice).toBe(action);
      }
    });
  });
});
