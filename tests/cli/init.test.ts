/**
 * InitCommand — Integration tests for project scaffolding.
 *
 * Covers:
 * 1. Listing templates (--list flag)
 * 2. Project creation from all 5 built-in templates
 * 3. Variable substitution ({{name}}, {{NAME}})
 * 4. .buffconfig.json generation with provider selection
 * 5. Error handling (existing dir, invalid template)
 * 6. Interactive mode (mocked inquirer prompts)
 * 7. Project structure consistency checks
 *
 * IMPORTANT: Commander's parseAsync on a subcommand processes args directly
 * without skipping a command name. So we omit 'init' from the arg list.
 * Each parseAsync call should use a FRESH command object to avoid leaked state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import inquirer from 'inquirer';
import { Command } from 'commander';

import { InitCommand } from '../../src/cli/init.js';

// ─── Mock helpers ───────────────────────────────────────────────────────────

function useTempDir(): string {
  const testDir = mkdtempSync(join(tmpdir(), 'buff-init-test-'));
  vi.spyOn(process, 'cwd').mockReturnValue(testDir);
  return testDir;
}

function cleanupTempDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function muteConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

/**
 * Create a fresh InitCommand and parse args against it.
 * Important: we pass args WITHOUT the 'init' command name since
 * Commander's parseAsync on a subcommand doesn't skip past it.
 * We also create a NEW command each call to avoid leaked state.
 */
async function runInit(args: string[]): Promise<void> {
  const cmd = new InitCommand();
  const command = cmd.create();
  await command.parseAsync(['node', 'buff', ...args]);
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../src/cli/model-picker.js', () => ({
  showModelPicker: vi.fn(),
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('InitCommand', () => {
  let testDir: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    testDir = useTempDir();
    muteConsole();
    // Default: decline the provider config prompt (most common case)
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ wantsProvider: false });
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  // ── List templates ─────────────────────────────────────────────────────

  describe('list templates (--list)', () => {
    it('should list all 5 built-in templates', async () => {
      await runInit(['--list']);
      for (const id of ['node-cli', 'ts-library', 'node-api', 'python-cli', 'minimal']) {
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining(id));
      }
    });

    it('should include file count for each template', async () => {
      await runInit(['--list']);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('5 files'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('2 files'));
    });

    it('should include usage instructions', async () => {
      await runInit(['--list']);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('buff init <project-name> --template'));
    });

    it('should not create any project directory', async () => {
      await runInit(['--list']);
      const items = readdirSync(testDir).filter(f => !f.startsWith('.'));
      expect(items).toHaveLength(0);
    });
  });

  // ── Create project from each template ──────────────────────────────────

  describe('create project — minimal template', () => {
    it('should create project directory', async () => {
      await runInit(['test-project', '--template', 'minimal']);
      expect(statSync(join(testDir, 'test-project')).isDirectory()).toBe(true);
    });

    it('should create README.md with project name', async () => {
      await runInit(['test-project', '--template', 'minimal']);
      const readme = readFileSync(join(testDir, 'test-project', 'README.md'), 'utf-8');
      expect(readme).toContain('# test-project');
    });

    it('should create .gitignore', async () => {
      await runInit(['test-project', '--template', 'minimal']);
      expect(readFileSync(join(testDir, 'test-project', '.gitignore'), 'utf-8')).toContain('node_modules');
    });

    it('should create exactly 2 files', async () => {
      await runInit(['test-project', '--template', 'minimal']);
      expect(readdirSync(join(testDir, 'test-project'))).toEqual(expect.arrayContaining(['README.md', '.gitignore']));
    });

    it('should not generate .buffconfig.json when provider declined', async () => {
      await runInit(['test-project', '--template', 'minimal']);
      expect(existsSync(join(testDir, 'test-project', '.buffconfig.json'))).toBe(false);
    });
  });

  describe('create project — node-cli template', () => {
    it('should create package.json with correct name', async () => {
      await runInit(['my-cli', '--template', 'node-cli']);
      const pkg = JSON.parse(readFileSync(join(testDir, 'my-cli', 'package.json'), 'utf-8'));
      expect(pkg.name).toBe('my-cli');
      expect(pkg.type).toBe('module');
    });

    it('should create tsconfig.json', async () => {
      await runInit(['my-cli', '--template', 'node-cli']);
      const tsconfig = JSON.parse(readFileSync(join(testDir, 'my-cli', 'tsconfig.json'), 'utf-8'));
      expect(tsconfig.compilerOptions.target).toBe('ES2022');
      expect(tsconfig.compilerOptions.strict).toBe(true);
    });

    it('should substitute {{name}} in src/index.ts', async () => {
      await runInit(['my-cli', '--template', 'node-cli']);
      const src = readFileSync(join(testDir, 'my-cli', 'src', 'index.ts'), 'utf-8');
      expect(src).toContain('Hello from my-cli');
      expect(src).not.toContain('{{name}}');
    });

    it('should create all expected files', async () => {
      await runInit(['my-cli', '--template', 'node-cli']);
      for (const f of ['package.json', 'tsconfig.json', 'src/index.ts', '.gitignore', 'README.md']) {
        expect(existsSync(join(testDir, 'my-cli', f))).toBe(true);
      }
    });
  });

  describe('create project — ts-library template', () => {
    it('should create package.json with vitest', async () => {
      await runInit(['my-lib', '--template', 'ts-library']);
      const pkg = JSON.parse(readFileSync(join(testDir, 'my-lib', 'package.json'), 'utf-8'));
      expect(pkg.scripts.test).toBe('vitest run');
      expect(pkg.devDependencies).toHaveProperty('vitest');
    });

    it('should create src/index.ts with greet function', async () => {
      await runInit(['my-lib', '--template', 'ts-library']);
      expect(readFileSync(join(testDir, 'my-lib', 'src', 'index.ts'), 'utf-8')).toContain('greet');
    });

    it('should create tests directory with test file', async () => {
      await runInit(['my-lib', '--template', 'ts-library']);
      const testFile = readFileSync(join(testDir, 'my-lib', 'tests', 'index.test.ts'), 'utf-8');
      expect(testFile).toContain("toBe('Hello, World!')");
    });
  });

  describe('create project — node-api template', () => {
    it('should create package.json with express', async () => {
      await runInit(['api-server', '--template', 'node-api']);
      const pkg = JSON.parse(readFileSync(join(testDir, 'api-server', 'package.json'), 'utf-8'));
      expect(pkg.dependencies).toHaveProperty('express');
    });

    it('should create Express server with health endpoint', async () => {
      await runInit(['api-server', '--template', 'node-api']);
      const src = readFileSync(join(testDir, 'api-server', 'src', 'index.ts'), 'utf-8');
      expect(src).toContain("from 'express'");
      expect(src).toContain('/health');
    });

    it('should create dev script with tsx watch', async () => {
      await runInit(['api-server', '--template', 'node-api']);
      const pkg = JSON.parse(readFileSync(join(testDir, 'api-server', 'package.json'), 'utf-8'));
      expect(pkg.scripts.dev).toContain('tsx watch');
    });
  });

  describe('create project — python-cli template', () => {
    it('should create pyproject.toml with project name', async () => {
      await runInit(['py-app', '--template', 'python-cli']);
      const toml = readFileSync(join(testDir, 'py-app', 'pyproject.toml'), 'utf-8');
      expect(toml).toContain('name = "py-app"');
    });

    it('should create src directory with Python files', async () => {
      await runInit(['py-app', '--template', 'python-cli']);
      expect(existsSync(join(testDir, 'py-app', 'src', '__init__.py'))).toBe(true);
      expect(existsSync(join(testDir, 'py-app', 'src', 'cli.py'))).toBe(true);
      expect(existsSync(join(testDir, 'py-app', 'tests', 'test_cli.py'))).toBe(true);
    });

    it('should create cli.py with main function', async () => {
      await runInit(['py-app', '--template', 'python-cli']);
      expect(readFileSync(join(testDir, 'py-app', 'src', 'cli.py'), 'utf-8')).toContain('def main()');
    });
  });

  // ── Variable substitution ───────────────────────────────────────────────

  describe('variable substitution', () => {
    it('should replace {{name}} in all template files', async () => {
      await runInit(['my-app', '--template', 'node-cli']);
      for (const f of ['package.json', 'README.md', 'src/index.ts']) {
        const content = readFileSync(join(testDir, 'my-app', f), 'utf-8');
        expect(content).not.toContain('{{name}}');
      }
    });

    it('should substitute via function generators', async () => {
      await runInit(['my-lib', '--template', 'ts-library']);
      const pkg = JSON.parse(readFileSync(join(testDir, 'my-lib', 'package.json'), 'utf-8'));
      expect(pkg.name).toBe('my-lib');
    });

    it('should handle project names with hyphens and numbers', async () => {
      await runInit(['my-awesome-app-2', '--template', 'minimal']);
      expect(readFileSync(join(testDir, 'my-awesome-app-2', 'README.md'), 'utf-8')).toContain('# my-awesome-app-2');
    });
  });

  // ── .buffconfig.json generation ─────────────────────────────────────────

  describe('.buffconfig.json generation', () => {
    it('should generate config with --provider and --model', async () => {
      await runInit(['cfg-app', '--template', 'minimal', '--provider', 'groq', '--model', 'llama-3.3-70b-versatile']);
      const config = JSON.parse(readFileSync(join(testDir, 'cfg-app', '.buffconfig.json'), 'utf-8'));
      expect(config.defaultProvider).toBe('groq');
      expect(config.providers.groq.model).toBe('llama-3.3-70b-versatile');
    });

    it('should include default temperature and maxTokens', async () => {
      await runInit(['cfg-app', '--template', 'minimal', '--provider', 'gemini', '--model', 'gemini-2.0-flash-exp']);
      const config = JSON.parse(readFileSync(join(testDir, 'cfg-app', '.buffconfig.json'), 'utf-8'));
      expect(config.providers.gemini.temperature).toBe(0.7);
      expect(config.providers.gemini.maxTokens).toBe(4096);
    });

    it('should use "default" as model when --model is omitted', async () => {
      await runInit(['cfg-app', '--template', 'minimal', '--provider', 'openrouter']);
      const config = JSON.parse(readFileSync(join(testDir, 'cfg-app', '.buffconfig.json'), 'utf-8'));
      expect(config.providers.openrouter.model).toBe('default');
    });

    it('should generate valid JSON matching BuffConfig structure', async () => {
      await runInit(['cfg-app', '--template', 'minimal', '--provider', 'nim', '--model', 'meta/llama-3.1-8b-instruct']);
      const config = JSON.parse(readFileSync(join(testDir, 'cfg-app', '.buffconfig.json'), 'utf-8'));
      expect(config).toHaveProperty('defaultProvider');
      expect(config.providers.nim).toHaveProperty('model');
      expect(config.providers.nim).toHaveProperty('temperature');
      expect(config.providers.nim).toHaveProperty('maxTokens');
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────

  describe('error handling', () => {
    it('should fail when project directory already exists', async () => {
      mkdirSync(join(testDir, 'existing-project'), { recursive: true });
      await runInit(['existing-project', '--template', 'minimal']);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    });

    it('should fail and list templates when invalid template ID given', async () => {
      await runInit(['bad-template', '--template', 'non-existent-template']);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unknown template'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('node-cli'));
    });

    it('should not create project directory on template error', async () => {
      await runInit(['bad-template', '--template', 'non-existent-template']);
      expect(existsSync(join(testDir, 'bad-template'))).toBe(false);
    });
  });

  // ── Interactive mode ───────────────────────────────────────────────────

  describe('interactive mode', () => {
    it('should prompt for project name when not provided', async () => {
      // Override default inquirer mock with specific chain
      vi.spyOn(inquirer, 'prompt')
        .mockReset()
        .mockResolvedValueOnce({ name: 'interactive-project' })
        .mockResolvedValueOnce({ template: 'minimal' })
        .mockResolvedValueOnce({ wantsProvider: false });

      await runInit([]);
      expect(existsSync(join(testDir, 'interactive-project'))).toBe(true);
    });

    it('should prompt for template when not specified', async () => {
      vi.spyOn(inquirer, 'prompt')
        .mockReset()
        .mockResolvedValueOnce({ name: 'template-pick' })
        .mockResolvedValueOnce({ template: 'node-cli' })
        .mockResolvedValueOnce({ wantsProvider: false });

      await runInit([]);
      const pkg = JSON.parse(readFileSync(join(testDir, 'template-pick', 'package.json'), 'utf-8'));
      expect(pkg.name).toBe('template-pick');
    });

    it('should prompt for provider when --provider not set', async () => {
      const { showModelPicker } = await import('../../src/cli/model-picker.js');
      vi.mocked(showModelPicker).mockResolvedValueOnce({
        provider: 'groq', model: 'llama-3.3-70b-versatile',
      });
      vi.spyOn(inquirer, 'prompt')
        .mockReset()
        .mockResolvedValueOnce({ wantsProvider: true });

      await runInit(['with-provider', '--template', 'minimal']);
      const config = JSON.parse(readFileSync(join(testDir, 'with-provider', '.buffconfig.json'), 'utf-8'));
      expect(config.defaultProvider).toBe('groq');
    });

    it('should skip provider config when user declines', async () => {
      vi.spyOn(inquirer, 'prompt')
        .mockReset()
        .mockResolvedValueOnce({ wantsProvider: false });

      await runInit(['skip-provider', '--template', 'minimal']);
      expect(existsSync(join(testDir, 'skip-provider', '.buffconfig.json'))).toBe(false);
    });

    it('should handle full interactive flow for minimal template', async () => {
      vi.spyOn(inquirer, 'prompt')
        .mockReset()
        .mockResolvedValueOnce({ name: 'full-interactive' })
        .mockResolvedValueOnce({ template: 'minimal' })
        .mockResolvedValueOnce({ wantsProvider: false });

      await runInit([]);
      const files = readdirSync(join(testDir, 'full-interactive'));
      expect(files).toContain('README.md');
      expect(files).toContain('.gitignore');
    });
  });

  // ── Project structure ──────────────────────────────────────────────────

  describe('project structure', () => {
    it('should create project inside cwd', async () => {
      await runInit(['subdir-check', '--template', 'minimal']);
      expect(existsSync(join(testDir, 'subdir-check'))).toBe(true);
    });

    it('should create src directory for templates that need it', async () => {
      await runInit(['has-src', '--template', 'node-cli']);
      expect(statSync(join(testDir, 'has-src', 'src')).isDirectory()).toBe(true);
    });

    it('should create unique projects per invocation', async () => {
      await runInit(['project-a', '--template', 'minimal']);
      await runInit(['project-b', '--template', 'minimal']);
      expect(readFileSync(join(testDir, 'project-a', 'README.md'), 'utf-8')).toContain('# project-a');
      expect(readFileSync(join(testDir, 'project-b', 'README.md'), 'utf-8')).toContain('# project-b');
    });
  });
});
