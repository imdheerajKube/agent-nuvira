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

  it('classifies read-only PARSE checks as verify (they were the ask loop)', () => {
    // A live turn asked the user FOUR times in one turn to run `node -c
    // script.js`. It classified as confirm, so the refusal said "call ask_user,
    // then retry" — and a check that cannot mutate anything produced a prompt
    // every time. A parse check executes nothing and must never be gated.
    for (const cmd of ['node -c script.js', 'node --check script.js', 'node -c src/app.js']) {
      expect(classifyCommand(cmd), cmd).toBe('verify');
    }
    // …while arbitrary code execution stays confirm-class (the boundary is
    // "parses a file" vs "runs a program", not "mentions node").
    expect(classifyCommand('node script.js')).toBe('confirm');
    expect(classifyCommand('node -e "console.log(1)"')).toBe('confirm');
  });

  it('classifies read-only VERSION/HELP probes and metadata reads as verify (never gate them)', () => {
    // A live trace (2026-10-04) burned five steps on `cargo --version`: it was
    // `confirm`-class, the gate refused it as "external", then the autonomy gate
    // swallowed the model's ask_user — a deadlock that ended in a bad failover.
    // A probe that cannot change state must never generate a prompt.
    for (const cmd of [
      'cargo --version',
      'rustc --version',
      'node --version',
      'python --version',
      'go version',
      'docker --version',
      'npm view @tauri-apps/cli versions --json',
      'npm ls --depth=0',
      'cargo metadata --format-version 1',
      'command -v cargo',
      'some-tool --help',
      'some-tool -h',
    ]) {
      expect(classifyCommand(cmd), cmd).toBe('verify');
    }
    // A probe flag LAUNDERING a state change stays confirm (worst-segment rule).
    expect(classifyCommand('cargo --version && rm -rf target')).toBe('confirm');
    expect(classifyCommand('cargo --version && npm publish')).toBe('confirm');
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

  it('classifies a READ-ONLY chain through a shell loop as verify (never gate a check)', () => {
    // Live, 2026-10-08 (`trace-1791390325578-4968th`): the model inspected its own
    // output with a chain that only ever READ a file, but the `for`/`do`/`done`
    // segments were off the allowlist, so the whole chain scored confirm and the
    // gate refused it as "state-changing". The model then burned a step on it
    // ("the command guard misfired on a read-only check"). A check that cannot
    // mutate state must never generate a prompt.
    const live =
      'grep -n \'^#\' NOTES.md && echo "---" && wc -w NOTES.md && echo "--- sections ---" && ' +
      'for i in Introduction Design Operations; do printf "%s: " "$i"; done; echo; awk \'/^# Introduction/{print}\' NOTES.md';
    expect(classifyCommand(live)).toBe('verify');

    // The same rule, exercised on its own.
    expect(classifyCommand('for f in a b c; do echo "$f"; done')).toBe('verify');
    expect(classifyCommand('if test -f x; then echo yes; else echo no; fi')).toBe('verify');
  });

  it('a loop BODY is judged by what it RUNS — grammar never launders a state change', () => {
    expect(classifyCommand('for f in a b; do touch $f; done')).toBe('confirm');
    expect(classifyCommand('for f in *; do rm -rf $f; done')).toBe('confirm');
    expect(classifyCommand('if true; then npm install lodash; fi')).toBe('confirm');
    // Deny still wins on the WHOLE string, whatever the grammar around it.
    expect(classifyCommand('for x in 1; do sudo rm -rf /; done')).toBe('deny');
  });

  it('a text processor is read-only only in its READ form', () => {
    expect(classifyCommand("awk '/^#/{print}' NOTES.md")).toBe('verify');
    // The write forms keep the confirm gate (safe direction).
    expect(classifyCommand("awk '{print > \"out.txt\"}' NOTES.md")).toBe('confirm');
    expect(classifyCommand("awk 'BEGIN{system(\"rm x\")}'")).toBe('confirm');
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

describe('run_terminal — no-op refusals are FAILURES (Error: prefix)', () => {
  // Enterprise G1: the loop's honest accounting treats a non-`Error:` result as
  // a success, and the verification gate counts a successful run_terminal as
  // proof. A no-op (`empty command`) MUST therefore be an error, otherwise a
  // turn reads as “verified” while nothing ran — observed live.
  it('an empty command is an Error, not a silent success', async () => {
    const { ctx } = makeWorkspace();
    const out = await runTerminalTool({ command: '   ' }, ctx);
    expect(out.startsWith('Error:')).toBe(true);
    expect(out).toContain('empty command');
  });

  it('a denied command is an Error', async () => {
    const { ctx } = makeWorkspace();
    const out = await runTerminalTool({ command: 'git push origin main' }, ctx);
    expect(out.startsWith('Error:')).toBe(true);
  });

  it('a state-changing command without confirmation is an Error', async () => {
    const { ctx } = makeWorkspace();
    const out = await runTerminalTool({ command: 'npm install left-pad' }, ctx);
    expect(out.startsWith('Error:')).toBe(true);
    expect(out).toContain('explicit confirmation');
  });

  it('a FAILING command (non-zero exit) is an Error, so it cannot count as verification', async () => {
    const { ctx } = makeWorkspace();
    const out = await runTerminalTool({ command: 'node -e "process.exit(1)"', confirm: true }, ctx);
    expect(out.startsWith('Error:')).toBe(true);
    expect(out).toContain('❌ failed (exit 1)');
  });

  it('a SUCCESSFUL command is not an Error (it can count as verification)', async () => {
    const { ctx } = makeWorkspace();
    const out = await runTerminalTool({ command: 'node -e "process.exit(0)"', confirm: true }, ctx);
    expect(out.startsWith('Error:')).toBe(false);
    expect(out).toContain('✅ succeeded');
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
