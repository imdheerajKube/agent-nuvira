/**
 * WASTE GUARD + BATCHING NUDGE (2026-10-17).
 *
 * WHY THESE EXIST. The Cline head-to-head measured Nuvira at 51 model calls /
 * 49 tool calls / 1.43 M input tokens for a task whose intrinsic shape is ~7
 * calls and which Cline finished in 8 calls / 47 K input tokens — for the SAME
 * 100/100 score. The largest avoidable block was repetition: `npm test` run four
 * times with a different output filter each time, and the same directories
 * listed twice. Each repeat re-sends the whole thread.
 *
 * Two mechanisms are pinned here:
 *   1. `memoizableReadSignature` — which calls are pure repeats (and which must
 *      NEVER be suppressed: mutations, page fetches, unknown commands).
 *   2. The loop: an identical read on an UNCHANGED workspace is refused rather
 *      than re-executed, and is allowed again the moment the workspace changes.
 * Plus the one bounded batching nudge, and the contract lines that ask for
 * batching in the first place.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runToolLoop,
  memoizableReadSignature,
  stripOutputFilters,
  repeatReadRefusal,
  batchingNudge,
  type ToolLoopDeps,
  type StepResponse,
} from '../../src/tools/tool-loop.js';
import { TOOL_CONTRACT, type ToolContext } from '../../src/tools/registry.js';

const ctx: ToolContext = { configManager: {} };

function mockDeps(
  script: StepResponse[],
  execute?: (name: string, args: Record<string, unknown>) => Promise<string>,
  onEvent?: (line: string) => void,
): ToolLoopDeps {
  const callModel = vi.fn();
  let i = 0;
  callModel.mockImplementation(async () => script[Math.min(i++, script.length - 1)]);
  return {
    callModel,
    executeTool: execute || vi.fn(async (name: string) => `executed ${name}`),
    onEvent: onEvent ? vi.fn(onEvent) : vi.fn(),
  };
}

/**
 * Every message the model was handed on its Nth call, as {role, content}.
 *
 * NOTE: the loop hands the SAME live `thread` array to every call, so all
 * recorded calls alias the FINAL thread. These assertions are therefore about
 * the thread's contents and ORDER (a directive's position relative to tool
 * results is how "when did it fire" is pinned) — never about "this message was
 * absent from an early call". For firing COUNT, assert on `onEvent` lines.
 */
function messagesAt(deps: ToolLoopDeps, n: number): Array<{ role: string; content: string }> {
  return deps.callModel.mock.calls[n][0] as Array<{ role: string; content: string }>;
}

/** Every console line the loop emitted this turn (order preserved). */
function events(deps: ToolLoopDeps): string[] {
  return (deps.onEvent as unknown as { mock: { calls: [string][] } }).mock.calls.map(([line]) => line);
}

describe('waste guard — signature: what is a pure repeat', () => {
  it('treats the same read with reordered arguments as one signature', () => {
    const a = memoizableReadSignature('read_file', { paths: ['src/a.js'], offset: 10, limit: 50 });
    const b = memoizableReadSignature('read_file', { limit: 50, offset: 10, paths: ['src/a.js'] });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('ignores an explicitly-undefined optional field (omitted vs undefined is one read)', () => {
    expect(memoizableReadSignature('list_dir', { path: 'src', depth: undefined })).toBe(
      memoizableReadSignature('list_dir', { path: 'src' }),
    );
  });

  it('collapses a command that differs ONLY by its output filter', () => {
    const tail = memoizableReadSignature('run_terminal', { command: 'npm test | tail -40' });
    const grep = memoizableReadSignature('run_terminal', { command: 'npm test 2>&1 | grep -E "^# pass"' });
    const plain = memoizableReadSignature('run_terminal', { command: 'npm test' });
    expect(tail).not.toBeNull();
    expect(tail).toBe(grep);
    expect(tail).toBe(plain);
  });

  it('covers the same repeat made through code_execution (measured: npm test twice, two tools)', () => {
    const viaTerminal = memoizableReadSignature('run_terminal', { command: 'npm test | tail -25' });
    const viaCode = memoizableReadSignature('code_execution', { code: 'cd /tmp/proj && npm test 2>&1' });
    expect(viaTerminal).not.toBeNull();
    expect(viaCode).not.toBeNull();
    expect(viaCode).toBe(memoizableReadSignature('code_execution', { code: 'cd /tmp/proj && npm test 2>&1 | head -20' }));
    // A script that is not an inspect command is never suppressed.
    expect(memoizableReadSignature('code_execution', { code: 'python3 -c "import os; os.remove(\'x\')"' })).toBeNull();
  });

  it('keeps inspecting commands memoizable', () => {
    for (const command of [
      'ls -la',
      'cd /tmp/proj && cat package.json',
      'git status --short',
      'git diff HEAD',
      'node --version',
      'grep -rn "slugify" src',
    ]) {
      expect(memoizableReadSignature('run_terminal', { command }), command).not.toBeNull();
    }
  });

  it('NEVER suppresses a call that can change something', () => {
    for (const command of [
      'npm install',
      'npm run build',
      'npm run deploy',
      'npx tauri build',
      'echo hello > out.txt',
      'rm -rf dist',
      'git commit -m "x"',
      'git add -A',
      'curl https://example.com | tail -3',
      'mkdir -p src/x',
    ]) {
      expect(memoizableReadSignature('run_terminal', { command }), command).toBeNull();
    }
    // Mutating tools, page fetches and unknown tools are never memoized.
    expect(memoizableReadSignature('edit_file', { path: 'a.js' })).toBeNull();
    expect(memoizableReadSignature('write_file', { path: 'a.js' })).toBeNull();
    expect(memoizableReadSignature('read_page', { url: 'https://example.com' })).toBeNull();
    expect(memoizableReadSignature('surprise_tool', { x: 1 })).toBeNull();
  });

  it('stripOutputFilters removes only trailing view filters', () => {
    expect(stripOutputFilters('npm test 2>&1 | tail -40')).toBe('npm test');
    expect(stripOutputFilters('npm test | grep foo | head -3')).toBe('npm test');
    expect(stripOutputFilters('cat log | wc -l')).toBe('cat log');
    // A pipe into something that can WRITE is not a filter — kept as-is.
    expect(stripOutputFilters('cat a.txt | tee b.txt')).toBe('cat a.txt | tee b.txt');
    // Trailing `2>&1` on its own is noise, not a view.
    expect(stripOutputFilters('npm test 2>&1')).toBe('npm test');
  });

  it('the refusal names the cause and does not re-send the result', () => {
    const text = repeatReadRefusal('read_file');
    expect(text.startsWith('Error:')).toBe(true);
    expect(text).toContain('already called this turn');
    expect(text).toContain('unchanged');
  });
});

describe('waste guard — the loop refuses a repeat read, and frees it after a change', () => {
  it('executes an identical read ONCE and refuses the repeat with the reason', async () => {
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { paths: ['src/slugify.js'] } }] },
      { content: '', toolCalls: [{ id: 'c2', name: 'read_file', arguments: { paths: ['src/slugify.js'] } }] },
      { content: 'Read it once.', toolCalls: [] },
    ];
    const execute = vi.fn(async () => 'slugify.js contents');
    const deps = mockDeps(script, execute);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'show me src/slugify.js' }],
      context: ctx,
      deps,
      requirePlan: false,
    });

    // The tool ran EXACTLY once — the second call never reached it.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.steps).toBe(3);
    // …and the model was told WHY, in the tool result of its second call.
    const third = messagesAt(deps, 2);
    const refusal = third.find((m) => m.role === 'tool' && m.content.includes('already called this turn'));
    expect(refusal).toBeDefined();
  });

  it('refuses only the SAME read: a different file still runs', async () => {
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { paths: ['a.js'] } }] },
      { content: '', toolCalls: [{ id: 'c2', name: 'read_file', arguments: { paths: ['b.js'] } }] },
      { content: 'Both read.', toolCalls: [] },
    ];
    const execute = vi.fn(async (name: string, args: Record<string, unknown>) => `contents of ${(args as { paths: string[] }).paths[0]}`);
    const deps = mockDeps(script, execute);
    await runToolLoop({ messages: [{ role: 'user', content: 'read a.js and b.js' }], context: ctx, deps, requirePlan: false });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('a workspace CHANGE frees the read again (a repaired project may re-run its check)', async () => {
    const read = { id: 'c1', name: 'read_file', arguments: { paths: ['src/a.js'] } };
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ ...read, id: 'r1' }] },
      { content: '', toolCalls: [{ id: 'w1', name: 'edit_file', arguments: { path: 'src/a.js', old_string: 'a', new_string: 'b' } }] },
      { content: '', toolCalls: [{ ...read, id: 'r2' }] },
      { content: 'Done.', toolCalls: [] },
    ];
    const execute = vi.fn(async (name: string) => (name === 'edit_file' ? '✅ edited src/a.js' : 'file contents'));
    const deps = mockDeps(script, execute);
    await runToolLoop({
      messages: [{ role: 'user', content: 'fix the bug in src/a.js and edit it' }],
      context: ctx,
      deps,
      requirePlan: false,
      requireVerification: false,
    });
    // read (1) + edit (1) + read again (1) — the second read is allowed because
    // the file changed in between.
    expect(execute.mock.calls.filter(([name]) => name === 'read_file')).toHaveLength(2);
    const last = messagesAt(deps, 3);
    expect(last.some((m) => m.role === 'tool' && m.content === 'file contents')).toBe(true);
  });
});

describe('batching nudge — one bounded ask for multiple calls per step', () => {
  it('fires once, after the second consecutive one-call step, naming the alternative', async () => {
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { paths: ['README.md'] } }] },
      { content: '', toolCalls: [{ id: 'c2', name: 'read_file', arguments: { paths: ['package.json'] } }] },
      { content: '', toolCalls: [{ id: 'c3', name: 'list_dir', arguments: { path: 'src' } }] },
      { content: 'Done.', toolCalls: [] },
    ];
    const deps = mockDeps(script);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'summarise this project' }],
      context: ctx,
      deps,
      requirePlan: false,
      requireVerification: false,
    });
    expect(result.steps).toBe(4);

    const thread = messagesAt(deps, 3);
    // ONE directive for the turn, as a marked harness system message.
    const nudges = thread.filter((m) => m.content.includes('BATCHING'));
    expect(nudges).toHaveLength(1);
    expect(nudges[0].role).toBe('system');
    expect(nudges[0].content.startsWith('[harness]')).toBe(true);
    expect(nudges[0].content).toContain('still run the real check');
    // AFTER the second one-call step, not after the first: it sits behind the
    // tool result of the 2nd call (package.json) and ahead of the 3rd (list_dir).
    const secondTool = thread.findIndex((m) => m.role === 'tool' && m.content.includes('executed read_file'));
    const batchingAt = thread.indexOf(nudges[0]);
    expect(batchingAt).toBeGreaterThan(secondTool);
    expect(thread.slice(batchingAt).some((m) => m.role === 'tool' && m.content.includes('executed list_dir'))).toBe(true);
    // …and it was announced exactly once on the console.
    expect(events(deps).filter((l) => l.includes('🧺'))).toHaveLength(1);
  });

  it('counts one-call gather steps that are NOT consecutive (the live transcript shape)', async () => {
    // Measured 2026-10-17: the single-call gathers were interleaved with
    // bookkeeping calls (`plan_todo`, `finding`), so a consecutive-only counter
    // never reached 2 and the advisory never fired.
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { paths: ['README.md'] } }] },
      { content: '', toolCalls: [{ id: 'c2', name: 'plan_todo', arguments: { action: 'create', goal: 'ship it' } }] },
      { content: '', toolCalls: [{ id: 'c3', name: 'run_terminal', arguments: { command: 'npm test | tail -5' } }] },
      { content: 'Done.', toolCalls: [] },
    ];
    const deps = mockDeps(script);
    await runToolLoop({
      messages: [{ role: 'user', content: 'release it' }],
      context: ctx,
      deps,
      requirePlan: false,
      requireVerification: false,
    });
    expect(events(deps).filter((l) => l.includes('🧺'))).toHaveLength(1);
  });

  it('does NOT fire when a step already batches, or when the model is not gathering', async () => {
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [
          { id: 'c1', name: 'read_file', arguments: { paths: ['README.md'] } },
          { id: 'c2', name: 'read_file', arguments: { paths: ['package.json'] } },
        ],
      },
      { content: 'Done.', toolCalls: [] },
    ];
    const deps = mockDeps(script);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'summarise this project' }],
      context: ctx,
      deps,
      requirePlan: false,
      requireVerification: false,
    });
    expect(result.steps).toBe(2);
    expect(messagesAt(deps, 1).some((m) => m.content.includes('BATCHING'))).toBe(false);
    expect(events(deps).filter((l) => l.includes('🧺'))).toHaveLength(0);
  });

  it('batchingNudge states the cost and the exact alternative', () => {
    const text = batchingNudge(6, 'read_file');
    expect(text).toContain('6 model round-trips');
    expect(text).toContain('ONE call per step');
    expect(text).toContain('run_terminal');
  });
});

describe('the tool contract asks for batching (the cheap half of the fix)', () => {
  it('carries the batching and no-repeat rules into every surface', () => {
    expect(TOOL_CONTRACT).toContain('WORK IN BATCHES');
    expect(TOOL_CONTRACT).toContain('NEVER repeat a call you already made');
    // The batching rule must not read as "skip verification".
    expect(TOOL_CONTRACT).toContain('Re-running is only for verifying work you just changed');
    // …and the "check once, not once per file" rule keeps its debugging exception.
    expect(TOOL_CONTRACT).toContain('RUN THE CHECK ONCE, not once per file');
    expect(TOOL_CONTRACT).toContain('when you are DEBUGGING a failure');
  });
});
