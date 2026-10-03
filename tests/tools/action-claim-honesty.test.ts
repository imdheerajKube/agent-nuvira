/**
 * Honest-answer guard — a reply that CLAIMS a delivery must be flagged when no
 * delivery tool actually ran.
 *
 * Live incident (2026-09-20): a model answered
 *   "I have sent the poem to +918800425333 via WhatsApp."
 * followed by the gateway_send call as TEXT, and nothing was sent. The loop's
 * salvage recovers a text call (so the tool really runs), but a model that
 * emits NO call at all would leave a false confirmation standing. This pins
 * the detector + the loop annotation, and the trace outcome that surfaces it.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  runToolLoop,
  detectUnverifiedDeliveryClaim,
  detectUnfulfilledIntentPromise,
  type ToolLoopDeps,
  type StepResponse,
} from '../../src/tools/tool-loop.js';
import { getTool, type ToolContext } from '../../src/tools/registry.js';
import { buildTraceOutcome } from '../../src/learning/reasoning-trace.js';

async function realExecute(name: string, args: Record<string, unknown>, c: ToolContext): Promise<string> {
  const tool = getTool(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(args, c);
}

const ctx: ToolContext = { configManager: {} };

function mockDeps(script: StepResponse[], executeTool = realExecute): ToolLoopDeps {
  const callModel = vi.fn();
  let i = 0;
  callModel.mockImplementation(async () => script[Math.min(i++, script.length - 1)]);
  return { callModel, executeTool, onEvent: vi.fn() };
}

describe('detectUnverifiedDeliveryClaim', () => {
  it('flags a past-tense send claim when no delivery tool ran', () => {
    expect(detectUnverifiedDeliveryClaim('I have sent the poem to +918800425333 via WhatsApp.', [])).toBe(true);
    expect(detectUnverifiedDeliveryClaim('I sent it to Alex on WhatsApp.', [])).toBe(true);
    expect(detectUnverifiedDeliveryClaim('The message has been delivered to ops.', [])).toBe(true);
    expect(detectUnverifiedDeliveryClaim('Successfully forwarded the file.', [])).toBe(true);
  });

  it('does NOT flag when gateway_send actually ran', () => {
    expect(detectUnverifiedDeliveryClaim('I have sent the poem to Alex.', ['gateway_send'])).toBe(false);
  });

  it('does NOT flag future / interrogative / negated statements', () => {
    expect(detectUnverifiedDeliveryClaim('I will send it to Alex shortly.', [])).toBe(false);
    expect(detectUnverifiedDeliveryClaim('Should I send it to Alex?', [])).toBe(false);
    expect(detectUnverifiedDeliveryClaim("I haven't sent it to Alex yet.", [])).toBe(false);
    expect(detectUnverifiedDeliveryClaim('I could not send it to Alex.', [])).toBe(false);
    expect(detectUnverifiedDeliveryClaim('Here is how to send a message to Alex.', [])).toBe(false);
  });

  it('does not flag ordinary content', () => {
    expect(detectUnverifiedDeliveryClaim('Here is the poem you asked for.', [])).toBe(false);
    expect(detectUnverifiedDeliveryClaim('', [])).toBe(false);
  });
});

describe('tool loop annotates an unverified claim', () => {
  it('flags a claimed-but-unperformed delivery', async () => {
    const deps = mockDeps([{ content: 'I have sent the poem to Alex via WhatsApp.', toolCalls: [] }]);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'send it' }], context: ctx, deps });
    expect(result.unverifiedActionClaim).toBe(true);
    // The answer is NOT silently rewritten by the loop (the gateway decides).
    expect(result.content).toContain('I have sent the poem');
  });

  it('does not flag when gateway_send really ran', async () => {
    const executeTool = vi.fn(async (name: string) => {
      if (name === 'gateway_send') return 'gateway_send: ✅ sent to Alex — message delivered.';
      const tool = getTool(name);
      return tool ? tool.run({}, ctx) : 'ok';
    });
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'gateway_send', arguments: { target: 'whatsapp:Alex', text: 'poem' } }] },
        { content: 'I have sent the poem to Alex via WhatsApp.', toolCalls: [] },
      ],
      executeTool as unknown as ToolLoopDeps['executeTool'],
    );
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'send it' }], context: ctx, deps });
    expect(result.toolCalls).toContain('gateway_send');
    expect(result.successfulToolCalls).toContain('gateway_send');
    expect(result.deliveryConfirmed).toBe(true);
    expect(result.unverifiedActionClaim).toBeFalsy();
  });

  it('flags a claimed delivery when the gateway_send ATTEMPT failed (never received)', async () => {
    // Live incident (2026-09-21): the agent replied "I have sent the guide…"
    // after gateway_send returned ⚠️ (transport refused) — the message never
    // arrived, yet the trace read "✅ action performed — message sent" because
    // delivery was inferred from the attempted tool NAME.
    const executeTool = vi.fn(async (name: string) => {
      if (name === 'gateway_send') {
        return (
          'gateway_send: ⚠️ send to whatsapp:+918800663237 (+918800663237) failed — the adapter is not ' +
          'configured or the transport is unreachable. The message was queued in the delivery ledger for retry.'
        );
      }
      return 'ok';
    });
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'gateway_send', arguments: { target: 'whatsapp:+918800663237', text: 'guide' } }] },
        { content: 'I have sent the guide to +918800663237 via WhatsApp.', toolCalls: [] },
      ],
      executeTool as unknown as ToolLoopDeps['executeTool'],
    );
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'send it' }], context: ctx, deps });
    // Attempted, but NOT a delivery — so the claim is flagged as unverified.
    expect(result.toolCalls).toContain('gateway_send');
    expect(result.successfulToolCalls).not.toContain('gateway_send');
    expect(result.deliveryConfirmed).toBe(false);
    expect(result.unverifiedActionClaim).toBe(true);
    // And the trace outcome derives NO delivery from the honest tool list.
    const outcome = buildTraceOutcome({ tools: result.successfulToolCalls });
    expect(outcome.delivered).toBeUndefined();
    expect(outcome.kind).toBe('answered');
  });

  it('keeps refused/unknown calls out of successfulToolCalls', async () => {
    const deps = mockDeps([
      { content: '', toolCalls: [{ id: 'c1', name: 'not_a_tool', arguments: {} }] },
      { content: 'Done.', toolCalls: [] },
    ]);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'x' }], context: ctx, deps });
    expect(result.toolCalls).toEqual(['not_a_tool']);
    expect(result.successfulToolCalls).toEqual([]);
  });
});

describe('buildTraceOutcome', () => {
  it('answered when no tool ran', () => {
    expect(buildTraceOutcome({ tools: [] })).toEqual({ kind: 'answered', tools: [] });
  });
  it('acted with a delivery tool', () => {
    const o = buildTraceOutcome({ tools: ['read_files', 'gateway_send'] });
    expect(o.kind).toBe('acted');
    expect(o.delivered).toBe(true);
  });
  it('acted without a delivery tool', () => {
    const o = buildTraceOutcome({ tools: ['read_files'] });
    expect(o.kind).toBe('acted');
    expect(o.delivered).toBeUndefined();
  });
  // A3 — a turn that CLAIMED an action it did not perform, or promised work it
  // did not deliver, is `incomplete`, not `answered`: it did not conclude, and
  // it must not be recorded as a success. The flags still ride along.
  it('carries the unverified-claim flag (and is incomplete)', () => {
    const o = buildTraceOutcome({ tools: [], unverifiedActionClaim: true });
    expect(o.kind).toBe('incomplete');
    expect(o.unverifiedClaim).toBe(true);
  });
  it('carries the unfulfilled-promise flag (and is incomplete)', () => {
    const o = buildTraceOutcome({ tools: [], unfulfilledPromise: true });
    expect(o.kind).toBe('incomplete');
    expect(o.unfulfilledPromise).toBe(true);
  });
  it('failed / cancelled win over tool list', () => {
    expect(buildTraceOutcome({ generationFailed: true, tools: ['x'] }).kind).toBe('failed');
    expect(buildTraceOutcome({ cancelled: true, tools: ['x'] }).kind).toBe('cancelled');
  });
  // G1 + G2 — the edit analogues ride the same outcome contract.
  it('carries the unverified-edit flag', () => {
    const o = buildTraceOutcome({ tools: ['edit_file'], unverifiedEdit: true });
    expect(o.kind).toBe('acted');
    expect(o.unverifiedEdit).toBe(true);
  });
  it('carries the unverified-edit-claim flag', () => {
    const o = buildTraceOutcome({ tools: ['edit_file'], unverifiedEdit: true, unverifiedEditClaim: true });
    expect(o.unverifiedEditClaim).toBe(true);
  });
  it('omits the edit flags on a verified turn', () => {
    const o = buildTraceOutcome({ tools: ['edit_file', 'run_terminal'] });
    expect(o.unverifiedEdit).toBeUndefined();
    expect(o.unverifiedEditClaim).toBeUndefined();
  });
});

describe('detectUnfulfilledIntentPromise (dangling promise)', () => {
  it('flags an imminent first-person promise to act', () => {
    expect(detectUnfulfilledIntentPromise('I will begin by scaffolding the project structure.')).toBe(true);
    expect(detectUnfulfilledIntentPromise('Let me now create the files.')).toBe(true);
    expect(detectUnfulfilledIntentPromise("I'll start by reading the config.")).toBe(true);
    expect(detectUnfulfilledIntentPromise('I will now implement the module.')).toBe(true);
    expect(detectUnfulfilledIntentPromise('I will go ahead and update the schema.')).toBe(true);
    // The promise may be followed by a closing courtesy line.
    expect(
      detectUnfulfilledIntentPromise(
        'I will begin by scaffolding the project structure.\n\nLet me know if you want a different stack.',
      ),
    ).toBe(true);
  });

  it('does NOT flag a descriptive future (no imminent self-action)', () => {
    // The deliverable itself describes what the assistant will produce.
    expect(detectUnfulfilledIntentPromise('I will create a four-week routine for your daughter.')).toBe(false);
    expect(detectUnfulfilledIntentPromise('I will send it once you confirm the number.')).toBe(false);
    expect(detectUnfulfilledIntentPromise('Should I create the file?')).toBe(false);
  });

  it('does NOT flag an answer that delivered something', () => {
    // A list is a produced deliverable (a plan enumerates phases).
    expect(
      detectUnfulfilledIntentPromise('Here is the plan:\n1. Set up the repo\n2. Build the app\n3. Ship it'),
    ).toBe(false);
    // Pure chat verbs are not tool-shaped actions.
    expect(detectUnfulfilledIntentPromise('Let me explain how division works for a class-4 child.')).toBe(false);
    expect(detectUnfulfilledIntentPromise('Here is the poem you asked for.')).toBe(false);
    expect(detectUnfulfilledIntentPromise('')).toBe(false);
  });
});

describe('tool loop nudges a dangling promise and flags the residue', () => {
  it('asks the model to carry out the announced action instead of ending on it', async () => {
    const callModel = vi.fn();
    let i = 0;
    const script: StepResponse[] = [
      { content: 'I will begin by scaffolding the project structure.', toolCalls: [] },
      { content: 'Here is the answer.', toolCalls: [] },
    ];
    callModel.mockImplementation(async () => script[Math.min(i++, script.length - 1)]);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'build me a calculator app' }],
      context: ctx,
      deps: { callModel, executeTool: realExecute, onEvent: vi.fn() },
    });
    // The nudge spent one extra model step; the promise was not the answer.
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('Here is the answer.');
    // Nothing was performed, but the model was made to try — the residue is only
    // flagged when the FINAL answer still closes on a promise.
    expect(result.unfulfilledPromise).toBeFalsy();
  });

  it('flags the turn when the model promises again after the nudge', async () => {
    const deps = mockDeps([{ content: 'Let me now create the files.', toolCalls: [] }]);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'create the files' }],
      context: ctx,
      deps,
    });
    expect(result.successfulToolCalls).toEqual([]);
    expect(result.unfulfilledPromise).toBe(true);
  });

  it('does NOT flag a turn that actually performed work', async () => {
    const executeTool = vi.fn(async (name: string) => `ran ${name}`);
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] },
        { content: 'I will now implement the change.', toolCalls: [] },
      ],
      executeTool as unknown as ToolLoopDeps['executeTool'],
    );
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'read then implement' }],
      context: ctx,
      deps,
    });
    expect(result.successfulToolCalls).toContain('read_file');
    expect(result.unfulfilledPromise).toBeFalsy();
  });
});
