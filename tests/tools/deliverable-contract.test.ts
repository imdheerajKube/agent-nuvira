/**
 * The deliverable the request NAMED is enforced at the loop, not just in the prompt.
 *
 * Measured 2026-10-29 (BUG-SEEDED): the ask said "Write `docs/BUGS_FOUND.md`: for each
 * defect, `path:line` …". The turn fixed all four seeded bugs, wrote a test file — and
 * handed in no report, ending on "next steps: write up the audit report". Cline, on the
 * same ask, wrote 164 lines of it. Nothing in the loop refused: the fixed-vocabulary
 * artifacts gate knows todo.md/README/e2e, not an arbitrary path.
 *
 * These tests pin the two halves of the fix at the loop level:
 *   1. a work-shaped ask that names a path gets the deliverable-FIRST observation, so
 *      the file is started early instead of competing with the last step;
 *   2. `finish({verified:true})` is REFUSED while that path is not on disk, and
 *      accepted once it is.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runToolLoop } from '../../src/tools/tool-loop.js';
import { getTool } from '../../src/tools/registry.js';
import type { ToolMessage } from '../../src/inference/interface.js';
import { FINISH_ACCEPTED_MARKER, FINISH_REFUSED_MARKER } from '../../src/learning/completion-contract.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deliverable-contract-'));
  mkdirSync(join(root, 'ai_voice_studio'), { recursive: true });
  writeFileSync(join(root, 'ai_voice_studio', 'util.py'), 'def f():\n    return 1\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ASK = [
  '# BUG-SEEDED — audit untested code, find the defects, fix them',
  '',
  '1. Audit the code under `ai_voice_studio/` for behaviour that is wrong on its own terms.',
  '2. Write `docs/BUGS_FOUND.md`: for each defect, `path:line`, the wrong behaviour.',
  '3. Apply a minimal fix for each defect you are confident about.',
].join('\n');

interface Step {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

async function run(script: Step[]): Promise<{ finishResults: string[]; threads: ToolMessage[][] }> {
  const finishResults: string[] = [];
  const threads: ToolMessage[][] = [];
  let call = 0;
  await runToolLoop({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: ASK },
    ],
    context: { cwd: root } as never,
    deps: {
      callModel: async (thread: ToolMessage[]) => {
        threads.push(thread.map((m) => ({ ...m })));
        const step = script[Math.min(call, script.length - 1)];
        call += 1;
        return step as never;
      },
      // The REAL `finish` (it reads the loop's own ledger); every other call is a stub
      // whose only job is to record that it happened.
      executeTool: async (name: string, args: Record<string, unknown>, ctx: never) => {
        if (name === 'finish') {
          const out = await getTool('finish')!.run(args, ctx);
          finishResults.push(out);
          return out;
        }
        // A write actually lands on disk: the gate reads the FILESYSTEM, so a stub
        // that only says "ok" would make the acceptance half untestable.
        if (name === 'write_file' && typeof args.path === 'string') {
          const target = join(root, args.path);
          mkdirSync(join(target, '..'), { recursive: true });
          writeFileSync(target, String(args.content ?? ''));
        }
        return 'ok';
      },
      onEvent: () => {},
    } as never,
    maxSteps: 12,
    maxContinuations: 1,
    requireVerification: false,
    requireSelfReview: false,
    requirePlan: false,
    requireAction: false,
    servedRoute: () => ({ providerType: 'deepseek', model: 'deepseek-flash' }),
  });
  return { finishResults, threads };
}

const call = (name: string, args: Record<string, unknown>): Step => ({
  content: '',
  toolCalls: [{ id: `c-${name}-${Math.random().toString(36).slice(2, 7)}`, name, arguments: args }],
});

describe('the deliverable the ask NAMED', () => {
  it('opens with the deliverable-first observation, naming the file and the order of work', async () => {
    const { threads } = await run([{ content: 'Done.', toolCalls: [] }]);
    const first = threads[0].map((m) => String(m.content ?? '')).join('\n');
    expect(first).toContain('[harness] The request names a file');
    expect(first).toContain('docs/BUGS_FOUND.md');
    expect(first).toMatch(/FIRST evidence pass/);
  });

  it('is not opened for a QUESTION that happens to name a path', async () => {
    const results = new Map<string, string>();
    const threads: ToolMessage[][] = [];
    await runToolLoop({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Why is docs/BUGS_FOUND.md missing from this repo?' },
      ],
      context: { cwd: root } as never,
      deps: {
        callModel: async (thread: ToolMessage[]) => {
          threads.push(thread.map((m) => ({ ...m })));
          return { content: 'It was never written.', toolCalls: [] } as never;
        },
        executeTool: async () => {
          results.set('called', 'yes');
          return 'ok';
        },
        onEvent: () => {},
      } as never,
      maxSteps: 4,
      maxContinuations: 0,
      requireVerification: false,
      requireSelfReview: false,
      requirePlan: false,
      requireAction: false,
      servedRoute: () => ({ providerType: 'deepseek', model: 'deepseek-flash' }),
    });
    const text = threads.flat().map((m) => String(m.content ?? '')).join('\n');
    expect(text).not.toContain('[harness] The request names a file');
  });

  it('does not read the SURFACE banner as the ask, so a messaging turn owes no phantom file', async () => {
    // Measured 2026-10-29 against the parity harness: the gateway's user turn is
    // `[Origin: WhatsApp chat parity — … (WhatsApp/Telegram/etc) …]` followed by the
    // ask. The deliverable extractor read `/Telegram/etc` out of that banner as an
    // absolute destination, so a turn that only said "list the working directory"
    // was told it owed a file, then nudged a second time at the end — one extra
    // model call on EVERY gateway turn, and the cross-surface parity suite saw it
    // as a divergence (`cli-chat` 2 model calls, `gateway-chat` 3).
    const banner = [
      '[Origin: WhatsApp chat parity — this message was sent from a messaging app (WhatsApp/Telegram/etc). ' +
        'Your text response is automatically delivered back to the sender — do NOT call gateway_send for this ' +
        'conversation unless you need to send to a DIFFERENT target.]',
      '',
      'list the working directory, then answer',
    ].join('\n');
    const threads: ToolMessage[][] = [];
    let calls = 0;
    await runToolLoop({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: banner },
      ],
      context: { cwd: root } as never,
      deps: {
        callModel: async (thread: ToolMessage[]) => {
          threads.push(thread.map((m) => ({ ...m })));
          calls += 1;
          return { content: 'Listed.', toolCalls: [] } as never;
        },
        executeTool: async () => 'ok',
        onEvent: () => {},
      } as never,
      maxSteps: 8,
      maxContinuations: 1,
      requireVerification: false,
      requireSelfReview: false,
      requirePlan: false,
      requireAction: false,
      servedRoute: () => ({ providerType: 'deepseek', model: 'deepseek-flash' }),
    });
    // The banner is still the USER's text, so it is still on the wire (it says
    // where the message came from). What must not happen is the HARNESS quoting it
    // back as a requirement — that is the claim this case is about.
    const directives = threads
      .flat()
      .map((m) => String(m.content ?? ''))
      .filter((content) => content.startsWith('[harness]'));
    expect(directives.join('\n')).not.toContain('/Telegram/etc');
    expect(directives.join('\n')).not.toContain('The request names a file');
    // ONE call: no nudge, so no second trip to the model for a file nobody asked for.
    expect(calls).toBe(1);
  });

  it('refuses a verified claim while the named file is missing, then accepts it once written', async () => {
    const { finishResults } = await run([
      call('run_terminal', { command: 'python3 -m pytest tests/ -q', confirm: true }),
      call('write_file', { path: 'ai_voice_studio/util.py', content: 'def f():\n    return 1\n' }),
      call('finish', { summary: 'Fixed the defects', verified: true }),
      call('write_file', { path: 'docs/BUGS_FOUND.md', content: '# Bugs\n\n## 1\n\nai_voice_studio/util.py:1\n' }),
      call('finish', { summary: 'Fixed the defects and wrote the report', verified: true }),
    ]);
    expect(finishResults.length).toBeGreaterThanOrEqual(2);
    // The FIRST finish ran before the report existed, so its refusal names the path.
    const first = finishResults[0];
    expect(first).toContain(FINISH_REFUSED_MARKER);
    expect(first).toContain('docs/BUGS_FOUND.md');
    expect(first).toContain('does not exist');
    // And the loop did reach an accepted ending later in the same turn — the gate
    // sends the model back to work, it does not deadlock the turn.
    expect(finishResults.some((out) => out.includes(FINISH_ACCEPTED_MARKER))).toBe(true);
  });
});
