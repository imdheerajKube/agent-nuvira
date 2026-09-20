/**
 * Regression: a model that writes the suggest_followups call as TEXT (no
 * native tool call) must still produce followups and must never leak the raw
 * JSON into the answer.
 *
 * Live incident (2026-09-20): the auto-routed model printed
 *   {"tool":"suggest_followups","arguments":{"followups":[...]}}
 * verbatim as the answer and no menu/chips appeared — the JSON transport
 * parsed this shape, the native path did not.
 */

import { describe, it, expect, vi } from 'vitest';

import { runToolLoop, type ToolLoopDeps, type StepResponse } from '../../src/tools/tool-loop.js';
import { getTool, type ToolContext, type FollowupSuggestion } from '../../src/tools/registry.js';

async function realExecute(name: string, args: Record<string, unknown>, c: ToolContext): Promise<string> {
  const tool = getTool(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(args, c);
}

const ctx: ToolContext = { configManager: {} };

function mockDeps(script: StepResponse[]): ToolLoopDeps {
  const callModel = vi.fn();
  let i = 0;
  callModel.mockImplementation(async () => script[Math.min(i++, script.length - 1)]);
  return { callModel, executeTool: realExecute, onEvent: vi.fn() };
}

const RAW = (prompts: string[]) =>
  `Here is the answer.\n\n${JSON.stringify({ tool: 'suggest_followups', arguments: { followups: prompts.map((p) => ({ prompt: p })) } })}`;

describe('tool loop — recovers tool calls written as text', () => {
  it('parses a bare followups JSON block from a no-tools step', async () => {
    const deps = mockDeps([{ content: RAW(['Go deeper on A', 'Do B next']), toolCalls: [] }]);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'hi' }], context: ctx, deps });
    expect(result.followups).toEqual([
      { prompt: 'Go deeper on A' },
      { prompt: 'Do B next' },
    ] as FollowupSuggestion[]);
    // The raw JSON never reaches the delivered content.
    expect(result.content).toBe('Here is the answer.');
    expect(result.content).not.toContain('"tool"');
  });

  it('parses a fenced JSON block too', async () => {
    const fenced = `Here is the answer.\n\n\`\`\`json\n${JSON.stringify({ tool: 'suggest_followups', arguments: { followups: [{ prompt: 'Fenced next' }] } })}\n\`\`\``;
    const deps = mockDeps([{ content: fenced, toolCalls: [] }]);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'hi' }], context: ctx, deps });
    expect(result.followups.map((f) => f.prompt)).toEqual(['Fenced next']);
    expect(result.content).not.toContain('```');
    expect(result.content).not.toContain('"tool"');
  });

  it('strips a malformed block without inventing a call', async () => {
    const deps = mockDeps([{ content: 'The answer.\n\n{"tool":"suggest_followups","arguments":{', toolCalls: [] }]);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'hi' }], context: ctx, deps });
    expect(result.followups).toEqual([]);
    expect(result.content).not.toContain('"tool"');
  });

  it('leaves ordinary content (no tool JSON) untouched', async () => {
    const deps = mockDeps([{ content: 'Just a normal answer about "tools" in general.', toolCalls: [] }]);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'hi' }], context: ctx, deps });
    expect(result.followups).toEqual([]);
    expect(result.content).toBe('Just a normal answer about "tools" in general.');
  });

  it('still honours a proper NATIVE suggest_followups call', async () => {
    const deps = mockDeps([
      {
        content: 'Native answer.',
        toolCalls: [{ id: 'c1', name: 'suggest_followups', arguments: { followups: [{ prompt: 'Native next' }] } }],
      },
    ]);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'hi' }], context: ctx, deps });
    expect(result.followups.map((f) => f.prompt)).toEqual(['Native next']);
    expect(result.content).toBe('Native answer.');
  });
});
