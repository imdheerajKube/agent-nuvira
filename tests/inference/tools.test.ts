/**
 * H1 — Shared OpenAI-format tool-calling helper tests.
 *
 * buildWireMessages maps the ToolMessage shape to the OpenAI wire format
 * (assistant tool_calls / tool tool_call_id); parseToolCallResponse converts
 * the wire response into parsed ToolCallResponse with arguments as objects.
 */

import { describe, it, expect } from 'vitest';
import { buildWireMessages, parseToolCallResponse } from '../../src/inference/tools.js';

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
