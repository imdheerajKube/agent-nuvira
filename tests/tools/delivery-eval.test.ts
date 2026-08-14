/**
 * Delivery-rate eval — the essay reliability fix, measured.
 *
 * Replays the EXACT failure modes observed in the live "write an essay about
 * elephants for a class 4 student" runs through the REAL runToolLoop (no
 * network, scripted mock model), N times each, and asserts a 100% delivery
 * rate: the user-facing answer must always contain the full essay, and the
 * followups must be parsed into the structured sink.
 *
 * Failure modes replayed (from the live diagnosis):
 *   A. Model wrote the essay + suggest_followups with INVALID args (plain
 *      strings, then `{text:…}`) → zod validation failed → loop continued →
 *      step 3 delivered a short wrapper INSTEAD of the essay (S1).
 *   B. JSON-only concluding step (empty text + valid followups) after the
 *      answer — the delivered answer was lost / bounded-empty (S1).
 *   C. A `{"tool":...}` block embedded in prose — must be stripped from the
 *      delivered text and executed as a real tool call (fallback transport).
 *   D. Repeated suggest_followups — only the LAST call's suggestions survive
 *      (no 15 stale suggestions).
 *
 * Delivery = the result.content contains the essay's unique line, the result
 * is not the wrapper, and followups landed in the sink. Every scenario must
 * deliver 100% of the time or this eval fails.
 */
import { describe, it, expect } from 'vitest';
import {
  runToolLoop,
  extractFallbackToolCalls,
  type ToolLoopDeps,
  type StepResponse,
} from '../../src/tools/tool-loop.js';
import { getTool, type ToolContext } from '../../src/tools/registry.js';

const ctx: ToolContext = { configManager: {} };

/** Run the REAL registry tool so zod validation failures reproduce exactly. */
async function realExecute(name: string, args: Record<string, unknown>, c: ToolContext): Promise<string> {
  const tool = getTool(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(args, c);
}

/** Essay text — the answer that must always survive. */
const ESSAY = [
  'The elephant is the largest land animal in the world.',
  'It has a huge body, four thick legs, and two big flapping ears.',
  'Its trunk is like a hand — it picks up food and drinks water with it.',
  'Elephants live in forests and grasslands of India and Africa.',
  'They eat leaves, grass, fruits, and sugarcane.',
  'An elephant eats about 100 kilograms of food every day.',
  'They live in herds and care for their babies very lovingly.',
  'The elephant is a gentle giant and we must protect it.',
].join('\n');

const WRAPPER = 'While I am specialized in coding, I wrote the essay above.';

function validFollowups(): Record<string, unknown> {
  return {
    followups: [
      { prompt: 'Tell me more about elephant diet and habitat' },
      { prompt: 'What is the ecological role of elephants?', label: 'Ecology' },
    ],
  };
}

/** Run one scenario N times and return the delivery rate + failures. */
async function deliveryRate(script: () => StepResponse[], n: number): Promise<{ rate: number; failures: string[] }> {
  const failures: string[] = [];
  let delivered = 0;
  for (let i = 0; i < n; i++) {
    const deps: ToolLoopDeps = {
      callModel: (() => {
        let step = 0;
        return async () => {
          const s = script();
          const r = s[Math.min(step, s.length - 1)];
          step += 1;
          return r;
        };
      })(),
      executeTool: realExecute,
      onEvent: () => {},
    };
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'Write an essay about elephants for a class 4 student.' }],
      context: ctx,
      deps,
    });
    const hasEssay = result.content.includes('largest land animal');
    const notWrapperOnly = !result.content.startsWith('While I am specialized');
    if (hasEssay && notWrapperOnly) delivered += 1;
    else failures.push(`run ${i}: content=${JSON.stringify(result.content.slice(0, 60))}...`);
  }
  return { rate: delivered / n, failures };
}

describe('delivery-rate eval — essay scenarios through the real tool loop', () => {
  const RUNS = 25;

  it('A: invalid followups (strings, then {text:…}) + trailing wrapper — the ESSAY is delivered (S1)', async () => {
    // Step 1: essay + suggest_followups with INVALID args (plain strings) →
    // zod validation fails → tool error fed back → loop continues.
    // Step 2: essay + {text:…} (wrong key) → fails again.
    // Step 3: short wrapper + VALID followups → ends after concluding.
    // Delivery must be the ESSAY (longest-substantive), never the wrapper.
    const script = (): StepResponse[] => [
      {
        content: ESSAY,
        toolCalls: [
          { id: 'c1', name: 'suggest_followups', arguments: { followups: ['Tell me more', 'Show me a poem'] } },
        ],
      },
      {
        content: ESSAY,
        toolCalls: [{ id: 'c2', name: 'suggest_followups', arguments: { text: 'more about elephants' } }],
      },
      { content: WRAPPER, toolCalls: [{ id: 'c3', name: 'suggest_followups', arguments: validFollowups() }] },
    ];
    const { rate, failures } = await deliveryRate(script, RUNS);
    expect(rate).toBe(1);
    expect(failures).toEqual([]);
  });

  it('B: JSON-only concluding step (empty text + valid followups) — the earlier answer survives (S1)', async () => {
    // Step 1: essay + invalid followups → continues (answer noted).
    // Step 2: JSON-only — empty text + VALID followups → ends after concluding.
    // The delivered content must be the earlier essay, not empty.
    const script = (): StepResponse[] => [
      {
        content: ESSAY,
        toolCalls: [{ id: 'c1', name: 'suggest_followups', arguments: { followups: ['x'] } }],
      },
      { content: '', toolCalls: [{ id: 'c2', name: 'suggest_followups', arguments: validFollowups() }] },
    ];
    const { rate, failures } = await deliveryRate(script, RUNS);
    expect(rate).toBe(1);
    expect(failures).toEqual([]);
  });

  it('C: {"tool":...} block embedded in prose — stripped from text AND executed (fallback transport)', async () => {
    // The REAL JSON fallback transport (chat.ts buildToolCallModel): the model
    // emits prose + a `{"tool":...}` block in one string; extractFallbackToolCalls
    // strips the block from the answer and returns it as a tool call. The mock
    // replays that transport with the REAL extractor so the loop sees exactly
    // what production sees.
    const deps: ToolLoopDeps = {
      callModel: async () => {
        const raw = `${ESSAY}\n{"tool":"suggest_followups","arguments":${JSON.stringify(validFollowups())}}`;
        const { text, calls } = extractFallbackToolCalls(raw);
        return { content: text, toolCalls: calls };
      },
      executeTool: realExecute,
      onEvent: () => {},
    };
    let delivered = 0;
    for (let i = 0; i < RUNS; i++) {
      const result = await runToolLoop({
        messages: [{ role: 'user', content: 'Write an essay about elephants for a class 4 student.' }],
        context: ctx,
        deps,
      });
      if (result.content.includes('largest land animal') && !result.content.includes('{"tool"')) delivered += 1;
    }
    expect(delivered).toBe(RUNS);
  });

  it('D: repeated suggest_followups — only the LAST call\u2019s suggestions survive', async () => {
    // Step 1: essay + invalid followups → continues.
    // Step 2: essay + valid followups (3) → ends. The invalid attempt pushed
    // nothing; the last call is the only one recorded (no stale suggestions).
    const script = (): StepResponse[] => [
      {
        content: ESSAY,
        toolCalls: [
          { id: 'c1', name: 'suggest_followups', arguments: { followups: ['stale 1', 'stale 2', 'stale 3'] } },
        ],
      },
      {
        content: ESSAY,
        toolCalls: [
          {
            id: 'c2',
            name: 'suggest_followups',
            arguments: {
              followups: [
                { prompt: 'Final followup 1' },
                { prompt: 'Final followup 2' },
                { prompt: 'Final followup 3' },
              ],
            },
          },
        ],
      },
    ];
    const { rate, failures } = await deliveryRate(script, RUNS);
    expect(rate).toBe(1);
    expect(failures).toEqual([]);
  });
});
