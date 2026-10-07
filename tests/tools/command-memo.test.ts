/**
 * C3 — one probe per fact per run.
 *
 * The measured defect (run A, `/tmp/nuvira-logs/runA.log`, proxy log lines 3–6):
 * a single turn asked the same three facts TWICE — one combined probe
 * (`python3 --version; node --version; npm --version`) and then the same three
 * individually — four shell invocations for three facts. The same run issued
 * `python3 -m venv backend/.venv` twice (lines 222 and 232) and left BOTH
 * `/tmp/test/.venv` and `/tmp/test/backend/.venv` on disk. Every repeat costs a
 * round trip, a tool slot in the context window, and a step of the model's
 * attention on a question it has already had answered.
 *
 * The model cannot hold that memory across a long thread; the HARNESS can,
 * because it ran the command and holds the output. Pinned here:
 *
 *  1. what is memoizable (pure probes, idempotent setup) and what is NOT
 *     (installs, actions, anything composed/globby — skipping a re-install
 *     after a manifest edit is worse than repeating it);
 *  2. a combined probe answers the individual facts it established, and
 *     individual facts NEVER answer a combined question they only partly cover;
 *  3. a FAILED command is not remembered, so a repaired workspace can retry;
 *  4. the tool really does not spawn the second time (proved by making a
 *     re-spawn observably fail);
 *  5. per-run isolation: the memo's lifetime is the run's.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  splitCommandChain,
  commandMemoKind,
  createRunCommandMemo,
  memoKeyFor,
  lookupMemo,
  storeMemo,
  memoNotice,
} from '../../src/tools/command-memo.js';
import { runTerminalTool } from '../../src/tools/run-terminal.js';
import { runToolLoop, type ToolLoopDeps, type StepResponse } from '../../src/tools/tool-loop.js';
import { getTool, type ToolContext } from '../../src/tools/registry.js';

const createdDirs: string[] = [];
function makeWorkspace(): { dir: string; ctx: ToolContext } {
  const dir = mkdtempSync(join(tmpdir(), 'buff-run-memo-'));
  createdDirs.push(dir);
  return { dir, ctx: { configManager: {}, cwd: dir, commandMemo: createRunCommandMemo() } };
}

afterEach(() => {
  for (const d of createdDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('splitCommandChain — decompose only what is safe to decompose', () => {
  it('splits a composed probe into its facts', () => {
    expect(splitCommandChain('python3 --version; node --version; npm --version')).toEqual([
      'python3 --version',
      'node --version',
      'npm --version',
    ]);
    expect(splitCommandChain('mkdir -p a && touch b')).toEqual(['mkdir -p a', 'touch b']);
    expect(splitCommandChain('a \n b')).toEqual(['a', 'b']);
    // Inner whitespace is collapsed, so the same fact written two ways is one key.
    expect(splitCommandChain('node   --version')).toEqual(['node --version']);
  });

  it('refuses anything whose parts are not independent', () => {
    for (const command of [
      'node --version | tee log.txt',
      // `||` is a `|` — the right-hand side runs only when the left FAILED, so
      // its parts are not independent facts.
      'node --version || echo missing',
      'echo x > out.txt',
      'echo $(pwd)',
      'ls *.ts',
      'echo `pwd`',
      'echo {a,b}',
      'echo $HOME',
      'echo ~',
      '(cd x && pwd)',
      'echo hi > /dev/null; pwd',
    ]) {
      expect(splitCommandChain(command), command).toBeNull();
    }
    expect(splitCommandChain('   ')).toBeNull();
  });
});

describe('commandMemoKind — narrow on purpose', () => {
  it('classifies pure probes', () => {
    for (const command of [
      'node --version',
      'python3 --version',
      'npm -v',
      'uv -V',
      'which uv',
      'command -v python3',
      'type node',
      'pwd',
      'uname -a',
      'nproc',
    ]) {
      expect(commandMemoKind(command), command).toBe('probe');
    }
  });

  it('classifies idempotent setup', () => {
    expect(commandMemoKind('python3 -m venv .venv')).toBe('idempotent');
    expect(commandMemoKind('python -m venv backend/.venv')).toBe('idempotent');
    expect(commandMemoKind('mkdir -p src/components')).toBe('idempotent');
    expect(commandMemoKind('touch marker.txt')).toBe('idempotent');
  });

  it('refuses to memoize installs, plain mutations and unknown commands', () => {
    for (const command of [
      'npm install',
      'npm install lodash',
      'pip install requests',
      'uv pip install -r requirements.txt',
      // A bare `mkdir` FAILS on the second call — memoizing it would turn an
      // error the model may be relying on into a silent success.
      'mkdir src',
      'touch a b',
      // Actions whose second call is not the same question.
      'git add .',
      'cp a b',
      'mv a b',
      'rm -f x',
      'echo hello',
      'python3 -m venv',
      'sudo node --version',
    ]) {
      expect(commandMemoKind(command), command).toBeNull();
    }
  });

  it('keys only what it classifies, and normalizes the key', () => {
    expect(memoKeyFor('node --version')).toBe('whole:node --version');
    expect(memoKeyFor('  node   --version  ')).toBe('whole:node --version');
    expect(memoKeyFor('python3 --version; node --version')).toBe(
      'whole:python3 --version; node --version',
    );
    expect(memoKeyFor('npm install')).toBeNull();
    expect(memoKeyFor('node --version | cat')).toBeNull();
    expect(memoKeyFor('')).toBeNull();
  });
});

describe('lookupMemo — the combined probe answers the individual facts', () => {
  function withCombined(): ReturnType<typeof createRunCommandMemo> {
    const memo = createRunCommandMemo();
    storeMemo(memo, 'python3 --version; node --version; npm --version', 'v3.11\nv20\nv10');
    return memo;
  }

  it('a fact established by the earlier combined probe is a hit', () => {
    const hit = lookupMemo(withCombined(), 'node --version');
    expect(hit).not.toBeNull();
    expect(hit!.entry.command).toBe('python3 --version; node --version; npm --version');
    expect(hit!.parts).toEqual(['node --version']);
  });

  it('an exact repeat of the whole command is a hit', () => {
    const hit = lookupMemo(withCombined(), 'node --version; npm --version');
    // Only `node` and `npm` are asked here — both are covered by the earlier
    // command, so it is a hit even though the chain differs.
    expect(hit).not.toBeNull();
    expect(hit!.parts).toEqual(['node --version', 'npm --version']);
  });

  it('facts gathered ONE BY ONE never answer a question they only partly cover', () => {
    const memo = createRunCommandMemo();
    storeMemo(memo, 'node --version', 'v20');
    storeMemo(memo, 'npm --version', 'v10');
    // Both facts are known — but from two DIFFERENT commands, whose outputs must
    // not be glued into one reply as if a single run had produced them.
    expect(lookupMemo(memo, 'node --version; npm --version')).toBeNull();
    // Each fact on its own is still answered.
    expect(lookupMemo(memo, 'node --version')).not.toBeNull();
  });

  it('a partly-covered command re-runs (and its own output is then stored)', () => {
    const memo = withCombined();
    expect(lookupMemo(memo, 'python3 --version; go version')).toBeNull();
  });

  it('no memo means the old behaviour, exactly', () => {
    expect(lookupMemo(undefined, 'node --version')).toBeNull();
  });

  it('keeps runs isolated from each other', () => {
    const a = withCombined();
    const b = createRunCommandMemo();
    expect(lookupMemo(a, 'node --version')).not.toBeNull();
    expect(lookupMemo(b, 'node --version')).toBeNull();
  });

  it('keeps DIRECTORIES isolated: a fact learned in one tree is not a fact about another', () => {
    const memo = createRunCommandMemo();
    storeMemo(memo, 'pwd', '/tmp/one', '/tmp/one');
    expect(lookupMemo(memo, 'pwd', '/tmp/one')).not.toBeNull();
    expect(lookupMemo(memo, 'pwd', '/tmp/two')).toBeNull();
    // The measured shape works per directory too.
    storeMemo(memo, 'node --version; pwd', 'v20\n/tmp/two', '/tmp/two');
    expect(lookupMemo(memo, 'node --version', '/tmp/two')).not.toBeNull();
    expect(lookupMemo(memo, 'node --version', '/tmp/one')).toBeNull();
  });

  it('the notice names what answered it, reproduces the output, and is not an error', () => {
    const hit = lookupMemo(withCombined(), 'node --version')!;
    const notice = memoNotice('node --version', hit);
    expect(notice).toContain('↺ run_terminal: not re-run');
    expect(notice).toContain('node --version');
    expect(notice).toContain('python3 --version; node --version; npm --version');
    expect(notice).toContain('v20');
    // The loop classifies a failure by this prefix — a memo hit is not a failure.
    expect(notice.startsWith('Error:')).toBe(false);
  });
});

describe('run_terminal — the second ask does not spawn', () => {
  it('answers a repeated probe from the memo instead of running it again', async () => {
    const { ctx } = makeWorkspace();
    const first = await runTerminalTool({ command: 'node --version; pwd' }, ctx);
    expect(first).toContain('✅ succeeded');
    expect(first).not.toContain('↺');

    const second = await runTerminalTool({ command: 'node --version' }, ctx);
    // The answer is the NOTICE, not a second run's banner: the reply leads with
    // the memo line and reproduces the earlier command's output.
    expect(second.startsWith('↺ run_terminal: not re-run')).toBe(true);
    expect(second).toContain('node --version; pwd');
    expect(second.startsWith('Error:')).toBe(false);
  });

  it('reports the memo hit on the observability bus', async () => {
    const { ctx } = makeWorkspace();
    const emit = vi.fn();
    ctx.emit = emit;
    await runTerminalTool({ command: 'node --version' }, ctx);
    await runTerminalTool({ command: 'node --version' }, ctx);
    expect(emit).toHaveBeenCalledWith(
      'terminal:memoized',
      expect.objectContaining({ command: 'node --version' }),
      'tool-loop',
    );
  });

  it('PROVES no second spawn: a re-run would now fail, and it does not even try', async () => {
    const { dir, ctx } = makeWorkspace();
    const target = join(dir, 'target');
    const first = await runTerminalTool({ command: 'mkdir -p target', confirm: true }, ctx);
    expect(first).toContain('✅ succeeded');
    expect(existsSync(target)).toBe(true);

    // Make an actual re-run fail observably: replace the directory with a FILE,
    // so `mkdir -p target` would exit non-zero.
    rmSync(target, { recursive: true, force: true });
    writeFileSync(target, 'not a directory', 'utf-8');

    const second = await runTerminalTool({ command: 'mkdir -p target', confirm: true }, ctx);
    expect(second.startsWith('↺ run_terminal: not re-run')).toBe(true);
    expect(second.startsWith('Error:')).toBe(false);
    // The file was left alone — nothing ran.
    expect(statSync(target).isFile()).toBe(true);
  });

  it('a different target is a different fact, and still runs', async () => {
    const { dir, ctx } = makeWorkspace();
    await runTerminalTool({ command: 'mkdir -p one', confirm: true }, ctx);
    const other = await runTerminalTool({ command: 'mkdir -p two', confirm: true }, ctx);
    expect(other).toContain('✅ succeeded');
    expect(other).not.toContain('↺');
    expect(existsSync(join(dir, 'two'))).toBe(true);
  });

  it('does not answer a probe from a directory the run has moved away from', async () => {
    const first = makeWorkspace();
    const second = makeWorkspace();
    const a = await runTerminalTool({ command: 'node --version' }, first.ctx);
    expect(a).toContain('✅ succeeded');

    // The run clones a repo and `ctx.cwd` now points at the new tree — the old
    // answer must not be reused for a question asked here.
    first.ctx.cwd = second.dir;
    const b = await runTerminalTool({ command: 'node --version' }, first.ctx);
    expect(b).toContain('✅ succeeded');
    expect(b).not.toContain('↺');
  });

  it('never remembers a FAILED command, so a repaired workspace can retry', async () => {
    const { dir, ctx } = makeWorkspace();
    const target = join(dir, 'target');
    writeFileSync(target, 'not a directory', 'utf-8');

    const failed = await runTerminalTool({ command: 'mkdir -p target', confirm: true }, ctx);
    expect(failed.startsWith('Error:')).toBe(true);

    // Repair the cause — the second ask must really run.
    rmSync(target, { force: true });
    const retried = await runTerminalTool({ command: 'mkdir -p target', confirm: true }, ctx);
    expect(retried).toContain('✅ succeeded');
    expect(existsSync(target)).toBe(true);
  });

  it('does nothing when the run has no memo (direct calls, bare contexts)', async () => {
    const { dir } = makeWorkspace();
    const bare: ToolContext = { configManager: {}, cwd: dir };
    const a = await runTerminalTool({ command: 'node --version' }, bare);
    const b = await runTerminalTool({ command: 'node --version' }, bare);
    expect(a).toContain('✅ succeeded');
    expect(b).toContain('✅ succeeded');
    expect(b).not.toContain('↺');
  });
});

describe('the tool loop hands every step ONE memo for the run', () => {
  it('shares the same memo across steps, and it is a real memo', async () => {
    const { dir } = makeWorkspace();
    const seen: ToolContext[] = [];
    const calls: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'run_terminal', arguments: { command: 'node --version' } }] },
      { content: '', toolCalls: [{ id: 'c2', name: 'run_terminal', arguments: { command: 'npm --version' } }] },
      { content: 'Checked the toolchain.', toolCalls: [] },
    ];
    let i = 0;
    const deps: ToolLoopDeps = {
      callModel: vi.fn(async () => calls[Math.min(i++, calls.length - 1)]),
      executeTool: vi.fn(async (name: string, args: Record<string, unknown>, c: ToolContext) => {
        seen.push(c);
        return runTerminalTool(args as { command: string }, c);
      }),
      onEvent: vi.fn(),
    };

    await runToolLoop({
      messages: [{ role: 'user', content: 'check the toolchain and tell me the versions' }],
      context: { configManager: {}, cwd: dir },
      deps,
    });

    expect(seen.length).toBeGreaterThanOrEqual(2);
    const memo = seen[0].commandMemo;
    expect(memo, 'the loop must give the run a memo').toBeDefined();
    expect(seen[1].commandMemo, 'every step must get the SAME memo').toBe(memo);
    for (const c of seen) expect(c.commandMemo).toBe(memo);
  });

  it('a caller-injected memo is honoured (so a longer-lived scope can share one)', async () => {
    const { dir } = makeWorkspace();
    const injected = createRunCommandMemo();
    const seen: ToolContext[] = [];
    const deps: ToolLoopDeps = {
      callModel: vi.fn(async () => ({
        content: '',
        toolCalls: [{ id: 'c1', name: 'run_terminal', arguments: { command: 'node --version' } }],
      })),
      executeTool: vi.fn(async (_name: string, _args: Record<string, unknown>, c: ToolContext) => {
        seen.push(c);
        return 'ok';
      }),
      onEvent: vi.fn(),
    };

    // The loop bounds itself; a script that never stops asking still terminates.
    await runToolLoop({
      messages: [{ role: 'user', content: 'check node' }],
      context: { configManager: {}, cwd: dir, commandMemo: injected },
      deps,
      maxSteps: 1,
    });

    expect(seen[0]?.commandMemo).toBe(injected);
  });
});

describe('the registered tool keeps working through the registry', () => {
  it('memoizes when the run supplies a memo, through the registered entry point', async () => {
    const { ctx } = makeWorkspace();
    const tool = getTool('run_terminal');
    expect(tool).toBeDefined();
    await tool!.run({ command: 'node --version' }, ctx);
    const second = await tool!.run({ command: 'node --version' }, ctx);
    expect(second).toContain('↺ run_terminal: not re-run');
  });
});
