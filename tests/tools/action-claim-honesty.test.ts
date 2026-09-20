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
    expect(result.unverifiedActionClaim).toBeFalsy();
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
  it('carries the unverified-claim flag', () => {
    const o = buildTraceOutcome({ tools: [], unverifiedActionClaim: true });
    expect(o.kind).toBe('answered');
    expect(o.unverifiedClaim).toBe(true);
  });
  it('failed / cancelled win over tool list', () => {
    expect(buildTraceOutcome({ generationFailed: true, tools: ['x'] }).kind).toBe('failed');
    expect(buildTraceOutcome({ cancelled: true, tools: ['x'] }).kind).toBe('cancelled');
  });
});
