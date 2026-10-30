/**
 * H1 — Shared OpenAI-format tool-calling helper tests.
 *
 * buildWireMessages maps the ToolMessage shape to the OpenAI wire format
 * (assistant tool_calls / tool tool_call_id); parseToolCallResponse converts
 * the wire response into parsed ToolCallResponse with arguments as objects.
 */

import { describe, it, expect } from 'vitest';
import { buildWireMessages, parseToolCallResponse } from '../../src/inference/tools.js';
import { REASONING_NOT_RETAINED, REASONING_NOT_RETAINED_TURN } from '../../src/inference/thinking-replay.js';

describe('buildWireMessages', () => {
  it('passes system/user messages through', () => {
    const wire = buildWireMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    expect(wire).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('maps assistant tool_calls to the OpenAI wire shape', () => {
    const wire = buildWireMessages([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'build', arguments: '{"goal":"x"}' }],
      },
    ]);
    expect(wire[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'build', arguments: '{"goal":"x"}' } }],
    });
  });

  it('maps tool messages to tool_call_id', () => {
    const wire = buildWireMessages([{ role: 'tool', content: 'result', toolCallId: 'c1' }]);
    expect(wire[0]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'result' });
  });

  it('replays reasoning_content on the assistant turn that carried tool_calls (DeepSeek thinking mode)', () => {
    const wire = buildWireMessages([
      {
        role: 'assistant',
        content: '',
        reasoningContent: 'I should list the files first.',
        toolCalls: [{ id: 'c1', name: 'ls', arguments: '{}' }],
      },
    ]);
    expect(wire[0]).toMatchObject({ role: 'assistant', reasoning_content: 'I should list the files first.' });
  });

  it('omits reasoning_content entirely when the turn had none (byte-identical for everyone else)', () => {
    const wire = buildWireMessages([{ role: 'assistant', content: 'ok' }]);
    expect(wire[0]).toEqual({ role: 'assistant', content: 'ok' });
    expect(Object.keys(wire[0] as object)).not.toContain('reasoning_content');
  });

  /**
   * THE REPLAY INVARIANT (see src/inference/thinking-replay.ts). A thinking-mode
   * conversation that carries reasoning on SOME turns but not on a tool-call turn
   * is the shape DeepSeek rejects with 400 "The `reasoning_content` in the
   * thinking mode must be passed back to the API", observed four times in one
   * real run. The gap is filled rather than the reasoning stripped, so the
   * model's own reasoning is never discarded to satisfy the endpoint.
   */
  it('fills a tool-call turn that has no reasoning, when the conversation carries reasoning elsewhere', () => {
    const wire = buildWireMessages([
      {
        role: 'assistant',
        content: '',
        reasoningContent: 'I should read a.js first.',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.js"}' }],
      },
      { role: 'tool', content: 'a.js contents', toolCallId: 'c1' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read_file', arguments: '{"path":"b.js"}' }] },
    ]);
    expect(wire[0]).toMatchObject({ reasoning_content: 'I should read a.js first.' });
    expect(wire[2]).toMatchObject({ reasoning_content: REASONING_NOT_RETAINED });
    // The tool result is untouched — only assistant tool-call turns are filled.
    expect(wire[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'a.js contents' });
  });

  it('leaves a NON-thinking conversation byte-identical (no reasoning anywhere)', () => {
    const wire = buildWireMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'ls', arguments: '{}' }] },
      { role: 'tool', content: 'ok', toolCallId: 'c1' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(wire[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
    });
    expect(Object.keys(wire[0] as object)).not.toContain('reasoning_content');
    expect(wire[2]).toEqual({ role: 'assistant', content: 'done' });
  });

  it('fills a CONTENT-ONLY turn too, once the conversation is in thinking mode', () => {
    // MEASURED 2026-10-29 against the live endpoint: the rule covers every
    // assistant turn, not only the tool-call ones — a plain prose turn without
    // reasoning is rejected exactly like a tool-call turn without it (400, same
    // sentence). Filling only tool-call turns is what left one live repair
    // incomplete: the loop kept failing on the turn that carried the answer.
    const wire = buildWireMessages([
      { role: 'assistant', content: 'thinking out loud', reasoningContent: 'real reasoning' },
      { role: 'assistant', content: 'a plain answer turn' },
    ]);
    expect(wire[1]).toEqual({
      role: 'assistant',
      content: 'a plain answer turn',
      reasoning_content: REASONING_NOT_RETAINED_TURN,
    });
    // The model's OWN reasoning is never overwritten.
    expect(wire[0]).toMatchObject({ reasoning_content: 'real reasoning' });
  });
});

describe('parseToolCallResponse', () => {
  it('returns content + parsed tool calls (arguments as objects)', () => {
    const resp = parseToolCallResponse({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'ask_user', arguments: '{"question":"Q","choices":[{"label":"A"}]}' } },
            ],
          },
        },
      ],
    });
    expect(resp.content).toBe('');
    expect(resp.toolCalls.length).toBe(1);
    expect(resp.toolCalls[0].name).toBe('ask_user');
    expect((resp.toolCalls[0].arguments as { question: string }).question).toBe('Q');
  });

  it('tolerates malformed argument JSON (falls back to {})', () => {
    const resp = parseToolCallResponse({
      choices: [{ message: { content: 'hi', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: 'not json' } }] } }],
    });
    expect(resp.content).toBe('hi');
    expect(resp.toolCalls[0].arguments).toEqual({});
  });

  it('carries the provider-reported usage up, so a cost is measured and not estimated', () => {
    // The wire had these numbers all along and nothing above the adapter could see
    // them: every trace row and every cost axis was `chars/4`. A comparison against
    // an agent that reports its own tokens cannot be built on an estimate.
    const resp = parseToolCallResponse({
      choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] } }],
      usage: { prompt_tokens: 1234, completion_tokens: 56, prompt_tokens_details: { cached_tokens: 1000 } },
    } as never);
    expect(resp.usage).toEqual({ promptTokens: 1234, completionTokens: 56, cachedPromptTokens: 1000 });

    // No `usage` on the wire ⇒ absent, never zero: "unknown" and "free" are not
    // the same claim.
    const silent = parseToolCallResponse({ choices: [{ message: { content: 'done' } }] });
    expect(silent.usage).toBeUndefined();
  });

  it('returns an empty toolCalls array when the model ends the turn', () => {
    const resp = parseToolCallResponse({ choices: [{ message: { content: 'done' } }] });
    expect(resp.content).toBe('done');
    expect(resp.toolCalls).toEqual([]);
  });

  it('captures reasoning_content when the endpoint returned one (and omits it otherwise)', () => {
    const withReasoning = parseToolCallResponse({
      choices: [{ message: { content: '', reasoning_content: 'plan step', tool_calls: [] } }],
    });
    expect(withReasoning.reasoningContent).toBe('plan step');
    const without = parseToolCallResponse({ choices: [{ message: { content: 'hi' } }] });
    expect(without.reasoningContent).toBeUndefined();
  });
});
