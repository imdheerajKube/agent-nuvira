import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isKnownSystemTool,
  toolInstallCommand,
  manualInstallSteps,
  promptToolInstall,
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
