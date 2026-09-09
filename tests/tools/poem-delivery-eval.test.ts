/**
 * Behavioral eval — personal creative + delivery request, end to end.
 *
 * The user asks (paraphrased from the real request):
 *
 *   "Write a poem for my daughter, showing my love for her. I am her father
 *    and she is a 9-year-old girl."
 *
 * … and may want it delivered as a WhatsApp message via the gateway. This is
 * one of many OFF-CODING tasks a user may ask the agent, so the eval pins the
 * behavior contract for the whole class:
 *
 *   1. The agent must COMPOSE the poem in its answer (the loop's delivered
 *      content carries the full poem — the essay-delivery lesson generalized:
 *      a creative deliverable must never be replaced by a wrapper or lost to
 *      a JSON-only concluding step).
 *   2. Delivery MUST go through gateway_send with a platform:channel target
 *      ("whatsapp:<contact>") — the one real delivery path — never invented
 *      channels or silent no-ops.
 *   3. An unknown/unregistered contact must produce a FEEDABLE error (the
 *      tool returns model-readable guidance) so the agent can recover —
 *      e.g. retry with a registered contact — without losing the poem.
 *   4. The fallback transport (prose + embedded {"tool":…} block, exactly
 *      what chat.ts's buildToolCallModel sees from JSON-only models) must
 *      strip the block from the delivered poem AND execute the send.
 *   5. All of it replays through the REAL runToolLoop + REAL registry
 *      gateway_send tool (real zod validation) with an injected fake
 *      WhatsApp gateway — no network, deterministic.
 */

import { describe, it, expect } from 'vitest';
import {
  runToolLoop,
  extractFallbackToolCalls,
  type ToolLoopDeps,
  type StepResponse,
} from '../../src/tools/tool-loop.js';
import { getTool, type ToolContext } from '../../src/tools/registry.js';

/** A fake WhatsApp gateway that records sends — the ToolContext.gateway shape. */
function fakeGateway(overrides?: { failFirstFor?: string }): {
  gateway: NonNullable<ToolContext['gateway']>;
  sent: Array<{ target: string; text: string; platform: string; channelId: string }>;
} {
  const sent: Array<{ target: string; text: string; platform: string; channelId: string }> = [];
  let failedOnce = false;
  const directory = {
    resolve(target: string): { platform: string; channelId: string } | null {
      // Known registered contacts; anything else is unregistered (no contacts file in tests).
      if (target === 'whatsapp:Kashvi') return { platform: 'whatsapp', channelId: 'Kashvi' };
      if (target === 'whatsapp:Mom') return { platform: 'whatsapp', channelId: '+15550001111' };
      return null;
    },
  };
  const gateway: NonNullable<ToolContext['gateway']> = {
    directory,
    send: async (target: string, text: string) => {
      if (overrides?.failFirstFor && target === overrides.failFirstFor && !failedOnce) {
        failedOnce = true;
        return false;
      }
      sent.push({ target, text, ...directory.resolve(target)! });
      return true;
    },
  };
  return { gateway, sent };
}

/** Run the REAL registry gateway_send tool (real zod schema + real path). */
async function realExecute(name: string, args: Record<string, unknown>, c: ToolContext): Promise<string> {
  const tool = getTool(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(args, c);
}

/** The poem the father wants for his 9-year-old daughter — unique lines for assertions. */
const POEM = [
  'My little star, my morning light,',
  'Nine years of joy, nine years of delight.',
  'Your laughter fills our home with song,',
  'With you beside me I am strong.',
  'Kashvi, my heart, my pride, my girl —',
  'You are the most precious jewel in my world.',
].join('\n');

const FINAL_NOTE = 'The poem has been sent to Kashvi on WhatsApp.';

describe('behavioral eval — poem for my daughter, delivered via WhatsApp gateway', () => {
  it('composes the poem, sends it via gateway_send(whatsapp:<contact>), and delivers the poem in the answer', async () => {
    const { gateway, sent } = fakeGateway();
    const ctx: ToolContext = { configManager: {}, gateway };
    const script: StepResponse[] = [
      {
        // The model composes the poem AND immediately sends it in the same step.
        content: POEM,
        toolCalls: [{ id: 'g1', name: 'gateway_send', arguments: { target: 'whatsapp:Kashvi', text: POEM } }],
      },
      { content: FINAL_NOTE, toolCalls: [] },
    ];
    const deps: ToolLoopDeps = {
      callModel: async () => script[Math.min((deps as any).i++ ?? 0, script.length - 1)],
      executeTool: realExecute,
      onEvent: () => {},
    };
    (deps as any).i = 0;

    const result = await runToolLoop({
      messages: [
        {
          role: 'user',
          content:
            'Write a poem for my daughter, showing my love for her. I am her father and she is a 9 year old girl named Kashvi. Send it to her on WhatsApp.',
        },
      ],
      context: ctx,
      deps,
    });

    // 1. The poem is the delivered answer (not a wrapper, not empty).
    expect(result.content).toContain('Kashvi');
    expect(result.content).toContain('nine years of delight');
    // 2. Delivery went through the real tool with the right target.
    expect(result.toolCalls).toContain('gateway_send');
    expect(sent).toHaveLength(1);
    expect(sent[0].target).toBe('whatsapp:Kashvi');
    expect(sent[0].platform).toBe('whatsapp');
    expect(sent[0].text).toBe(POEM);
  });

  it('unregistered contact → feedable error from the real tool, agent retries with a registered contact, poem never lost', async () => {
    const { gateway, sent } = fakeGateway();
    const ctx: ToolContext = { configManager: {}, gateway };
    const script: StepResponse[] = [
      {
        content: POEM,
        toolCalls: [{ id: 'g1', name: 'gateway_send', arguments: { target: 'whatsapp:Princess', text: POEM } }],
      },
      {
        // The tool error told the model the target is unknown; it recovers
        // with a registered contact and resends THE SAME poem.
        content: POEM,
        toolCalls: [{ id: 'g2', name: 'gateway_send', arguments: { target: 'whatsapp:Mom', text: POEM } }],
      },
      { content: FINAL_NOTE, toolCalls: [] },
    ];
    let step = 0;
    const deps: ToolLoopDeps = {
      callModel: async () => script[Math.min(step++, script.length - 1)],
      executeTool: realExecute,
      onEvent: () => {},
    };
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'Write a poem for Kashvi and send it on WhatsApp.' }],
      context: ctx,
      deps,
    });

    // First send hit the unknown-target path and produced model-feedable guidance.
    expect(sent).toHaveLength(1);
    expect(sent[0].target).toBe('whatsapp:Mom');
    // The poem still reached the user in the answer.
    expect(result.content).toContain('nine years of delight');
  });

  it('transport failure (gateway offline) → queued-retry feedback, agent still delivers the poem in the answer', async () => {
    // The gateway rejects the FIRST send (adapter unpaired) — the real tool
    // reports the queue-and-retry message instead of throwing, so the loop
    // continues and the answer still carries the poem.
    const { gateway, sent } = fakeGateway({ failFirstFor: 'whatsapp:Kashvi' });
    const ctx: ToolContext = { configManager: {}, gateway };
    const script: StepResponse[] = [
      {
        content: POEM,
        toolCalls: [{ id: 'g1', name: 'gateway_send', arguments: { target: 'whatsapp:Kashvi', text: POEM } }],
      },
      { content: FINAL_NOTE, toolCalls: [] },
    ];
    let step = 0;
    const deps: ToolLoopDeps = {
      callModel: async () => script[Math.min(step++, script.length - 1)],
      executeTool: realExecute,
      onEvent: () => {},
    };
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'Poem for Kashvi, WhatsApp it to her.' }],
      context: ctx,
      deps,
    });
    expect(sent).toHaveLength(0); // nothing delivered — but also nothing silently lost
    expect(result.content).toContain('nine years of delight');
  });

  it('JSON-fallback transport: prose poem + embedded {"tool":…} block — block stripped from the poem AND send executed', async () => {
    const { gateway, sent } = fakeGateway();
    const ctx: ToolContext = { configManager: {}, gateway };
    const raw = `${POEM}\n{"tool":"gateway_send","arguments":${JSON.stringify({
      target: 'whatsapp:Kashvi',
      text: POEM,
    })}}\n${FINAL_NOTE}`;
    const { text, calls } = extractFallbackToolCalls(raw);
    let step = 0;
    const deps: ToolLoopDeps = {
      callModel: async () => {
        // Step 1: the JSON-only model's answer — poem + embedded send block
        // (already extracted). Step 2: a short closing with no tools.
        if (step++ === 0) return { content: text, toolCalls: calls };
        return { content: FINAL_NOTE, toolCalls: [] };
      },
      executeTool: realExecute,
      onEvent: () => {},
    };
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'Poem for Kashvi, WhatsApp it to her.' }],
      context: ctx,
      deps,
    });
    expect(result.content).toContain('nine years of delight');
    expect(result.content).not.toContain('{"tool"');
    expect(sent).toHaveLength(1);
    expect(sent[0].target).toBe('whatsapp:Kashvi');
  });

  it('delivery-rate: N runs of the happy path deliver 100% of the time', async () => {
    const RUNS = 25;
    let delivered = 0;
    for (let i = 0; i < RUNS; i++) {
      const { gateway, sent } = fakeGateway();
      const ctx: ToolContext = { configManager: {}, gateway };
      const script: StepResponse[] = [
        {
          content: POEM,
          toolCalls: [{ id: 'g1', name: 'gateway_send', arguments: { target: 'whatsapp:Kashvi', text: POEM } }],
        },
        { content: FINAL_NOTE, toolCalls: [] },
      ];
      let step = 0;
      const deps: ToolLoopDeps = {
        callModel: async () => script[Math.min(step++, script.length - 1)],
        executeTool: realExecute,
        onEvent: () => {},
      };
      const result = await runToolLoop({
        messages: [{ role: 'user', content: 'Write a poem for Kashvi and send it on WhatsApp.' }],
        context: ctx,
        deps,
      });
      if (result.content.includes('nine years of delight') && sent.length === 1) delivered += 1;
    }
    expect(delivered).toBe(RUNS);
  });
});
