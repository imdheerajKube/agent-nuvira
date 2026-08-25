/**
 * P0.4 — `run_terminal` tests.
 *
 * The brief (master-plan P0.4): the agent must verify code by ACTUAL
 * invocation — run a single test file, a typecheck, see the real output —
 * not by scripts or guesses. Covers the deny-first classification (deny
 * regexes scan the whole string so `$(...)` substitutions are caught),
 * the verify/confirm gating, masking of sender ids, cwd scoping, and exit
 * codes. Hermetic: only trivially-safe commands run in a tmpdir workspace.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyCommand, runTerminalTool } from '../../src/tools/run-terminal.js';
import { getTool, listTools } from '../../src/tools/registry.js';
import { toolsetForTool, filterToolsByToolsets, TOOLSETS } from '../../src/tools/toolsets.js';
import type { ToolContext } from '../../src/tools/registry.js';

const createdDirs: string[] = [];
function makeWorkspace(): { dir: string; ctx: ToolContext } {
  const dir = mkdtempSync(join(tmpdir(), 'buff-run-terminal-'));
  createdDirs.push(dir);
  return { dir, ctx: { configManager: {}, cwd: dir } };
}

afterEach(() => {
  for (const d of createdDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('classifyCommand — deny-first three-class model', () => {
  it('denies destructive/system commands outright (even with confirm)', () => {
    for (const cmd of [
      'sudo rm -rf /',
      'git push origin main',
      'git push --force',
      'git reset --hard HEAD',
      'git clean -fd',
      'git checkout -- .',
      'rm -rf /',
      'rm -rf ~',
      'rm -rf *',
      'rm -rf /etc',
      'rm -rf $HOME',
      'mkfs.ext4 /dev/sda',
      'dd if=/dev/zero of=/dev/sda',
      'shutdown now',
      'kill -9 1234',
      ':(){ :|:& };:',
    ]) {
      expect(classifyCommand(cmd), cmd).toBe('deny');
    }
  });

  it('catches denied commands inside $(...) substitutions and pipes', () => {
    // Deny regexes scan the WHOLE string — a verify-class wrapper must not
    // smuggle a denied command through.
    expect(classifyCommand('echo $(rm -rf /)')).toBe('deny');
    expect(classifyCommand('echo hi | sudo rm -rf /')).toBe('deny');
    expect(classifyCommand('cat x && git push origin main')).toBe('deny');
  });

  it('classifies verify-class commands (tests/typecheck/build/git-readonly)', () => {
    for (const cmd of [
      'npx vitest run tests/foo.test.ts',
      'vitest run',
      'npm test',
      'npm test -- tests/foo.test.ts',
      'npm run typecheck',
      'npm run lint',
      'npm run build',
      'npx tsc --noEmit',
      'tsc',
      'git status',
      'git diff --stat',
      'git log --oneline -5',
      'ls -la',
      'cat package.json',
      'pwd',
      'echo hello',
    ]) {
      expect(classifyCommand(cmd), cmd).toBe('verify');
    }
  });

  it('classifies state-changing commands as confirm', () => {
    for (const cmd of [
      'touch marker.txt',
      'npm install lodash',
      'git commit -m "x"',
      'git checkout main', // branch switch mutates the working tree
      'node -e "console.log(1)"', // arbitrary code
      'python -c "print(1)"',
      'curl https://example.com',
      'rm -rf node_modules', // scoped cleanup: needs confirm, not denied
    ]) {
      expect(classifyCommand(cmd), cmd).toBe('confirm');
    }
  });
});

describe('runTerminalTool — the verify loop', () => {
  it('runs a verify-class command WITHOUT confirmation and returns its output', async () => {
    const { ctx } = makeWorkspace();
    const out = await runTerminalTool({ command: 'echo hello-from-terminal' }, ctx);
    expect(out).toContain('✅ succeeded');
    expect(out).toContain('hello-from-terminal');
  });

  it('respects the workspace cwd', async () => {
    const { dir, ctx } = makeWorkspace();
    const out = await runTerminalTool({ command: 'pwd' }, ctx);
    // The child starts in the REALPATH of cwd (macOS /var → /private/var),
    // and the masker mangles digit runs in the tmpdir hash — so assert the
    // unmangled workspace dir NAME (proves cwd was honored) + success.
    expect(out).toContain('✅ succeeded');
    expect(out).toContain('buff-run-terminal-');
  });

  it('refuses a state-changing command without confirm, telling the model to ask_user', async () => {
    const { dir, ctx } = makeWorkspace();
    const out = await runTerminalTool({ command: 'touch marker.txt' }, ctx);
    expect(out).toContain('needs explicit confirmation');
    expect(out).toContain('ask_user');
    expect(out).toContain('confirm:true');
    // Nothing was executed.
    expect(existsSync(join(dir, 'marker.txt'))).toBe(false);
  });

  it('runs a state-changing command with confirm', async () => {
    const { dir, ctx } = makeWorkspace();
    const out = await runTerminalTool({ command: 'touch marker.txt', confirm: true }, ctx);
    expect(out).toContain('✅ succeeded');
    expect(existsSync(join(dir, 'marker.txt'))).toBe(true);
  });

  it('denies destructive commands even with confirm:true', async () => {
    const { ctx } = makeWorkspace();
    const out = await runTerminalTool({ command: 'git push origin main', confirm: true }, ctx);
    expect(out).toContain('DENIED');
  });

  it('routes buff/agent-nuvira commands to run_cli (one execution path)', async () => {
    const { ctx } = makeWorkspace();
    const out = await runTerminalTool({ command: 'nuvira doctor' }, ctx);
    expect(out).toContain('run_cli');
    expect(out).toContain('command manifest');
  });

  it('masks sender ids in the output (phones never echo back in full)', async () => {
    const { ctx } = makeWorkspace();
    const out = await runTerminalTool({ command: 'echo +919876543210 sent to 918178504516' }, ctx);
    expect(out).toContain('+91***');
    expect(out).not.toContain('919876543210');
    expect(out).not.toContain('918178504516');
  });

  it('reports a non-zero exit code as failure', async () => {
    const { ctx } = makeWorkspace();
    const out = await runTerminalTool({ command: 'node -e "process.exit(3)"', confirm: true }, ctx);
    expect(out).toContain('❌ failed (exit 3)');
  });
});

describe('toolset gating — run_terminal joins the coding toolset', () => {
  it('registers run_terminal in the registry', () => {
    const tool = getTool('run_terminal');
    expect(tool).toBeDefined();
    expect(tool!.category).toBe('workflow');
    expect(tool!.endsAgentStep).toBe(false);
  });

  it('owns run_terminal in the coding toolset (eight tools — terminal joined)', () => {
    expect(toolsetForTool('run_terminal')?.name).toBe('coding');
    expect(TOOLSETS.find((t) => t.name === 'coding')?.tools).toEqual([
      'read_file', 'list_dir', 'glob', 'edit_file', 'write_file', 'run_terminal', 'plan_todo', 'terminal',
    ]);
  });

  it('the coding toolset is disabled → run_terminal is gated out', () => {
    const names = filterToolsByToolsets(listTools(), ['coding']).map((t) => t.name);
    expect(names).not.toContain('run_terminal');
    expect(names).toContain('code_search'); // untouched sibling toolset
  });
});
