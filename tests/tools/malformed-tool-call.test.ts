/**
 * A tool call whose ARGUMENTS never arrived is not a call the model made.
 *
 * MEASURED (dashboard session `4e2b0e51-8b37-4289-ac92-38b9bcffd38f`, debug log
 * `…-1791349543186.log`, 2026-10-07, goal "yes deliver complete document"):
 *
 *   - 81 tool calls in one 16-minute turn, `bounded: true`, no document;
 *   - **73 of them arrived with EMPTY arguments** (`write_file` 59,
 *     `run_terminal` 14, `code_execution` 2) — the document did not fit in one
 *     model output, so the arguments were cut off;
 *   - every one of those was parsed with the defensive `JSON.parse(raw || '{}')`
 *     fallback and EXECUTED, so the model's feedback was `write_file: path is
 *     required` — which names the wrong problem and offers no way out;
 *   - the model diagnosed it itself ("my calls were emitted with no arguments")
 *     and then retried the identical call 59 times, because nothing told it how
 *     to deliver a payload larger than one output.
 *
 * Pinned here: the call is REFUSED rather than executed, the refusal names the
 * real cause (including the provider's own `finish_reason: "length"`), it offers
 * the working alternative, and after three of them the loop spends one bounded
 * nudge on the delivery strategy.
 */

import { describe, it, expect, vi } from 'vitest';

import { runToolLoop, type ToolLoopDeps, type StepResponse } from '../../src/tools/tool-loop.js';
import type { ToolContext } from '../../src/tools/registry.js';

/** A call that arrived with no usable arguments — what the wire layer now reports. */
function malformed(name: string): StepResponse['toolCalls'][number] {
  return { id: 'c1', name, arguments: {}, argumentsError: 'empty' };
}

function scripted(calls: StepResponse[], requests: unknown[][]): ToolLoopDeps {
  let i = 0;
  return {
    callModel: vi.fn(async (messages: unknown) => {
      requests.push(JSON.parse(JSON.stringify(messages)) as unknown[]);
      return calls[Math.min(i++, calls.length - 1)];
    }),
    executeTool: vi.fn(async () => 'ran'),
    onEvent: vi.fn(),
  };
}

const ctx: ToolContext = { configManager: {} };

describe('a tool call with no arguments is refused, not executed as {}', () => {
  it('never reaches the tool, and the refusal names the cause and the way out', async () => {
    const requests: unknown[][] = [];
    const deps = scripted(
      [
        { content: '', toolCalls: [malformed('write_file')] },
        { content: 'I will deliver it in sections.', toolCalls: [] },
      ],
      requests,
    );

    await runToolLoop({ messages: [{ role: 'user', content: 'deliver the document' }], context: ctx, deps });

    expect(deps.executeTool).not.toHaveBeenCalled();
    const thread = JSON.stringify(requests.at(-1));
    expect(thread).toContain('NOT run');
    expect(thread).toContain('NO arguments at all');
    // The alternative, not just the failure.
    expect(thread).toContain('mode:\\"append\\"');
    expect(thread).toContain('PIECES');
    // It counts as a failed call, not a successful one.
    expect(thread).toContain('Error: write_file');
  });

  it("quotes the provider's own verdict when the output budget cut the payload", async () => {
    const requests: unknown[][] = [];
    const deps = scripted(
      [
        { content: '', toolCalls: [malformed('write_file')], finishReason: 'length' },
        { content: 'Splitting it up.', toolCalls: [] },
      ],
      requests,
    );

    await runToolLoop({ messages: [{ role: 'user', content: 'deliver the document' }], context: ctx, deps });

    const thread = JSON.stringify(requests.at(-1));
    expect(thread).toContain('output-token limit');
    expect(thread).toContain('finish_reason');
  });

  it('distinguishes truncated arguments from arguments that never arrived', async () => {
    const requests: unknown[][] = [];
    const deps = scripted(
      [
        {
          content: '',
          toolCalls: [{ id: 'c1', name: 'write_file', arguments: {}, argumentsError: 'unparseable' }],
        },
        { content: 'Splitting it up.', toolCalls: [] },
      ],
      requests,
    );

    await runToolLoop({ messages: [{ role: 'user', content: 'deliver the document' }], context: ctx, deps });

    expect(JSON.stringify(requests.at(-1))).toContain('incomplete and could not be parsed');
  });

  it('after three, spends ONE bounded nudge on the delivery strategy (not a fourth identical error)', async () => {
    const requests: unknown[][] = [];
    const deps = scripted(
      [
        { content: '', toolCalls: [malformed('write_file')] },
        { content: '', toolCalls: [malformed('write_file')] },
        { content: '', toolCalls: [malformed('write_file')] },
        { content: 'Understood — delivering in sections.', toolCalls: [] },
      ],
      requests,
    );

    await runToolLoop({ messages: [{ role: 'user', content: 'deliver the document' }], context: ctx, deps });

    const nudges = (deps.onEvent as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .filter((t) => t.includes('no usable arguments'));
    expect(nudges).toHaveLength(1);
    const last = JSON.stringify(requests.at(-1));
    expect(last).toContain('arrived WITHOUT usable arguments');
    expect(last).toContain('Build the artifact in');
    expect(deps.executeTool).not.toHaveBeenCalled();
  });

  it('leaves a healthy call untouched', async () => {
    const deps = scripted(
      [{ content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] }, { content: 'done', toolCalls: [] }],
      [],
    );
    await runToolLoop({ messages: [{ role: 'user', content: 'read it' }], context: ctx, deps });
    expect(deps.executeTool).toHaveBeenCalledTimes(1);
  });

  // ─── item 6 — the empty-arguments refusal is SCHEMA-AWARE ────────────────────

  it('does NOT refuse a legitimate no-argument call (item 6, the Gemini wire)', async () => {
    // `list_dir` declares no required argument, so `{}` is a real call. The Gemini
    // wire omits an empty `args` object, which now reports `argumentsError: 'empty'`
    // — a blanket refusal would reject a genuine no-argument call.
    const requests: unknown[][] = [];
    const deps = scripted(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'list_dir', arguments: {}, argumentsError: 'empty' }] },
        { content: 'Checked.', toolCalls: [] },
      ],
      requests,
    );
    // `requirePlan: false` isolates THIS gate — the plan gate also refuses the
    // first workspace call, which would make the test pass for the wrong reason.
    await runToolLoop({
      messages: [{ role: 'user', content: 'list the directory' }],
      context: ctx,
      deps,
      requirePlan: false,
    });
    expect(deps.executeTool).toHaveBeenCalled();
    const thread = JSON.stringify(requests.at(-1));
    expect(thread).not.toContain('NOT run');
  });

  it('still refuses an empty call to a tool that REQUIRES arguments', async () => {
    const requests: unknown[][] = [];
    const deps = scripted(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'write_file', arguments: {}, argumentsError: 'empty' }] },
        { content: 'Splitting it up.', toolCalls: [] },
      ],
      requests,
    );
    await runToolLoop({ messages: [{ role: 'user', content: 'deliver the document' }], context: ctx, deps });
    expect(deps.executeTool).not.toHaveBeenCalled();
    expect(JSON.stringify(requests.at(-1))).toContain('NO arguments at all');
  });

  it('refuses an UNPARSEABLE call even when the tool needs no arguments', async () => {
    // A truncated payload is never a legitimate no-argument call.
    const requests: unknown[][] = [];
    const deps = scripted(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'list_dir', arguments: {}, argumentsError: 'unparseable' }] },
        { content: 'ok', toolCalls: [] },
      ],
      requests,
    );
    await runToolLoop({ messages: [{ role: 'user', content: 'list the directory' }], context: ctx, deps });
    expect(JSON.stringify(requests.at(-1))).toContain('could not be parsed');
  });
});
