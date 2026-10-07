/**
 * Native tool-calling wire mapping tests (`tests/inference/native-tools.test.ts`)
 * — AGENTIC_CAPABILITY_ASSESSMENT Addendum v4 Phase 1.2 (the BLOCKING item).
 *
 * Covers BOTH adapters' wire mappings with pure translation tests (no
 * network): Gemini contents/functionDeclarations + response parsing + SSE
 * chunk parsing, Anthropic messages/tool defs + response parsing + the
 * streaming accumulator, plus the shared schema-tolerance contract
 * (malformed arguments degrade to {} instead of throwing — the model retries
 * in-loop).
 */

import { describe, it, expect } from 'vitest';
import {
  parseToolArguments,
  toGeminiContents,
  toGeminiFunctionDeclarations,
  toGeminiSchema,
  parseGeminiToolResponse,
  parseGeminiToolSSEChunk,
  toAnthropicMessages,
  toAnthropicToolDefs,
  parseAnthropicToolResponse,
  AnthropicToolStreamAccumulator,
} from '../../src/inference/native-tools.js';
import type { ToolMessage, ToolSchema } from '../../src/inference/interface.js';

describe('parseToolArguments (shared)', () => {
  it('parses a valid JSON object string', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
  });

  it('degrades malformed JSON to {} (never throws)', () => {
    expect(parseToolArguments('{not json')).toEqual({});
    expect(parseToolArguments(undefined)).toEqual({});
    expect(parseToolArguments('')).toEqual({});
  });

  it('degrades non-object JSON (array/scalar) to {}', () => {
    expect(parseToolArguments('[1,2]')).toEqual({});
    expect(parseToolArguments('42')).toEqual({});
    expect(parseToolArguments('"str"')).toEqual({});
  });
});

describe('Gemini mapping', () => {
  it('maps system → systemInstruction, user → user content', () => {
    const messages: ToolMessage[] = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
    ];
    const { systemInstruction, contents } = toGeminiContents(messages);
    expect(systemInstruction).toEqual({ parts: [{ text: 'be terse' }] });
    expect(contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }]);
  });

  it('maps assistant toolCalls → model functionCall parts with parsed args', () => {
    const messages: ToolMessage[] = [
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: 'ok',
        toolCalls: [{ id: 'c1', name: 'run_terminal', arguments: '{"command":"ls"}' }],
      },
    ];
    const { contents } = toGeminiContents(messages);
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [{ text: 'ok' }, { functionCall: { name: 'run_terminal', args: { command: 'ls' } } }],
    });
  });

  it('maps tool results → functionResponse keyed by the tool NAME recovered from the call', () => {
    const messages: ToolMessage[] = [
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'run_terminal', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: 'file list here' },
    ];
    const { contents } = toGeminiContents(messages);
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'run_terminal', response: { result: 'file list here' } } }],
    });
  });

  it('drops an unpaired tool result (no Gemini key available) instead of crashing', () => {
    const messages: ToolMessage[] = [
      { role: 'tool', toolCallId: 'ghost', content: 'orphan' },
    ];
    const { contents } = toGeminiContents(messages);
    expect(contents).toEqual([]);
  });

  it('builds functionDeclarations with sanitized schemas', () => {
    const tools: ToolSchema[] = [
      {
        name: 'edit_file',
        description: 'Edit a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'file path' },
            confirm: { type: ['boolean', 'null'], default: false },
          },
          required: ['path'],
          additionalProperties: false,
          $schema: 'http://json-schema.org/draft-07/schema#',
        },
      },
    ];
    const decls = toGeminiFunctionDeclarations(tools);
    expect(decls).toHaveLength(1);
    const params = decls[0].functionDeclarations[0].parameters as Record<string, any>;
    expect(params.type).toBe('object');
    expect(params.properties.path.type).toBe('string');
    // Union type flattened + nullable; default/$schema/additionalProperties stripped.
    expect(params.properties.confirm).toEqual({ type: 'boolean', nullable: true });
    expect(params.additionalProperties).toBeUndefined();
    expect(params.$schema).toBeUndefined();
  });

  it('toGeminiSchema strips unsupported keywords and keeps the accepted subset', () => {
    const out = toGeminiSchema({
      type: 'object',
      properties: {
        q: { type: 'string', minLength: 1, maxLength: 10, description: 'query' },
        n: { type: 'number', exclusiveMinimum: 0 },
      },
      required: ['q'],
      additionalProperties: false,
    }) as Record<string, any>;
    expect(out.properties.q.minLength).toBe(1);
    expect(out.properties.q.maxLength).toBe(10);
    expect(out.properties.n.exclusiveMinimum).toBeUndefined();
    expect(out.additionalProperties).toBeUndefined();
  });

  it('parseGeminiToolResponse extracts text + function calls with synthetic ids', () => {
    const response = {
      candidates: [{
        content: {
          parts: [
            { text: 'Let me check.' },
            { functionCall: { name: 'read_file', args: { path: 'a.ts' } } },
            { functionCall: { name: 'code_search', args: { pattern: 'x' } } },
          ],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
    };
    const result = parseGeminiToolResponse(response);
    expect(result.content).toBe('Let me check.');
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } },
      { id: 'call_2', name: 'code_search', arguments: { pattern: 'x' } },
    ]);
  });

  it('flags a functionCall with NO args as an empty payload (item 6)', () => {
    // Gemini carries structured `args`, so an ABSENT one is the empty-payload
    // signature — the loop then decides whether the tool requires arguments.
    const absent = parseGeminiToolResponse({
      candidates: [{ content: { parts: [{ functionCall: { name: 'write_file' } }] } }],
    });
    expect(absent.toolCalls[0]).toMatchObject({ name: 'write_file', arguments: {}, argumentsError: 'empty' });
    // An EXPLICIT empty object is not flagged — only an absent one is.
    const explicit = parseGeminiToolResponse({
      candidates: [{ content: { parts: [{ functionCall: { name: 'list_dir', args: {} } }] } }],
    });
    expect(explicit.toolCalls[0].argumentsError).toBeUndefined();
  });

  it('parseGeminiToolResponse tolerates an empty body', () => {
    expect(parseGeminiToolResponse({})).toEqual({ content: '', toolCalls: [] });
  });

  it('parseGeminiToolSSEChunk extracts text deltas and function calls from one SSE line', () => {
    const textChunk = parseGeminiToolSSEChunk(
      'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'he' }] } }] }),
    );
    expect(textChunk?.text).toBe('he');
    expect(textChunk?.functionCalls).toEqual([]);

    const callChunk = parseGeminiToolSSEChunk(
      'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'glob', args: { pattern: '*' } } }] } }] }),
    );
    expect(callChunk?.text).toBeNull();
    expect(callChunk?.functionCalls).toEqual([{ name: 'glob', args: { pattern: '*' } }]);

    expect(parseGeminiToolSSEChunk('data: [DONE]')).toBeNull();
    expect(parseGeminiToolSSEChunk('event: ping')).toBeNull();
    expect(parseGeminiToolSSEChunk('data: {broken')).toBeNull();
  });
});

describe('Anthropic mapping', () => {
  it('maps system → top-level system string (concatenated)', () => {
    const { system } = toAnthropicMessages([
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' },
    ]);
    expect(system).toBe('a\nb');
  });

  it('maps assistant toolCalls → tool_use blocks with parsed input', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'on it',
        toolCalls: [{ id: 'tc_1', name: 'edit_file', arguments: '{"path":"x.ts"}' }],
      },
    ]);
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'on it' },
        { type: 'tool_use', id: 'tc_1', name: 'edit_file', input: { path: 'x.ts' } },
      ],
    });
  });

  it('merges consecutive tool results into ONE user message of tool_result blocks', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc_1', name: 'read_file', arguments: '{}' },
          { id: 'tc_2', name: 'list_dir', arguments: '{}' },
        ],
      },
      { role: 'tool', toolCallId: 'tc_1', content: 'file body' },
      { role: 'tool', toolCallId: 'tc_2', content: 'dir listing' },
    ]);
    // [user, assistant(tool_use ×2), user(tool_result ×2)] — the merge is the
    // protocol requirement (tool_result must immediately follow tool_use).
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tc_1', content: 'file body' },
        { type: 'tool_result', tool_use_id: 'tc_2', content: 'dir listing' },
      ],
    });
  });

  it('flushes pending tool results before a new user message (no interleaving)', () => {
    const { messages } = toAnthropicMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 'tc_1', name: 'run_terminal', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'tc_1', content: 'out' },
      { role: 'user', content: 'next question' },
    ]);
    expect(messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tc_1', content: 'out' }],
    });
    expect(messages[2]).toEqual({ role: 'user', content: 'next question' });
  });

  it('builds tool defs with input_schema', () => {
    const tools: ToolSchema[] = [
      { name: 'web_search', description: 'Search the web', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
    ];
    expect(toAnthropicToolDefs(tools)).toEqual([
      {
        name: 'web_search',
        description: 'Search the web',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ]);
  });

  it('parseAnthropicToolResponse extracts text + tool_use blocks', () => {
    const result = parseAnthropicToolResponse({
      content: [
        { type: 'text', text: 'Working.' },
        { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'a', content: 'b' } },
      ],
      usage: { input_tokens: 50, output_tokens: 10 },
    });
    expect(result.content).toBe('Working.');
    expect(result.toolCalls).toEqual([
      { id: 'toolu_1', name: 'write_file', arguments: { path: 'a', content: 'b' } },
    ]);
  });

  it('parseAnthropicToolResponse synthesizes an id when the block lacks one', () => {
    const result = parseAnthropicToolResponse({
      content: [{ type: 'tool_use', name: 'glob', input: {} }],
    });
    expect(result.toolCalls[0].id).toBe('call_1');
  });
});

describe('AnthropicToolStreamAccumulator', () => {
  /** Feed a full realistic event stream and assert the final response. */
  function feedStream(acc: AnthropicToolStreamAccumulator): string | null {
    const events = [
      { type: 'message_start' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'read_file' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pa' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'th":"a.ts"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ];
    let streamed: string | null = null;
    for (const e of events) {
      const text = acc.consume(e);
      if (text) streamed = (streamed ?? '') + text;
    }
    return streamed;
  }

  it('streams text deltas and finalizes tool_use from input_json_delta fragments', () => {
    const acc = new AnthropicToolStreamAccumulator();
    const streamed = feedStream(acc);
    expect(streamed).toBe('Hello');
    expect(acc.isStopped).toBe(true);
    expect(acc.finalize()).toEqual({
      content: 'Hello',
      toolCalls: [{ id: 'toolu_9', name: 'read_file', arguments: { path: 'a.ts' } }],
    });
  });

  it('captures message_delta usage for cost metering', () => {
    const acc = new AnthropicToolStreamAccumulator();
    feedStream(acc);
    expect(acc.streamUsage).toEqual({ promptTokens: undefined, completionTokens: 12 });
  });

  it('finalize on an empty stream yields an empty response (never throws)', () => {
    const acc = new AnthropicToolStreamAccumulator();
    expect(acc.finalize()).toEqual({ content: '', toolCalls: [] });
  });

  it('tolerates malformed fragments — arguments degrade to {}', () => {
    const acc = new AnthropicToolStreamAccumulator();
    acc.consume({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'glob' } });
    acc.consume({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{oops' } });
    const result = acc.finalize();
    expect(result.toolCalls[0].arguments).toEqual({});
  });
});

// ─── Gemini thoughtSignature round trip (live-caught bug) ───────────────────
//
// Caught by running a real Gemini agent task, not by reading code: step 1's
// plan_todo succeeded, step 2 failed with
//   `400: Function call is missing a thought_signature in functionCall parts.
//    This is required for tools to work correctly.`
// Gemini returns an opaque `thoughtSignature` with each functionCall part and
// REQUIRES it back on the model turn when the conversation continues. The
// adapter dropped it in two places (response parsing, and contents
// serialization, which rebuilt the part from name+args), so NO Gemini run could
// ever get past its second step — indistinguishable from "the model can't do
// multi-step work".

describe('Gemini thoughtSignature round trip', () => {
  const signature = 'CBcKAQEYASIBMA==';

  it('captures the signature when parsing a non-stream response', () => {
    const parsed = parseGeminiToolResponse({
      candidates: [
        {
          content: {
            parts: [
              { text: '', functionCall: { name: 'plan_todo', args: { goal: 'x' } }, thoughtSignature: signature },
            ],
          },
        },
      ],
    });
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].providerMeta).toEqual({ thoughtSignature: signature });
  });

  it('captures the signature when parsing an SSE chunk', () => {
    const chunk = parseGeminiToolSSEChunk(
      `data: ${JSON.stringify({
        candidates: [
          { content: { parts: [{ functionCall: { name: 'read_file', args: {} }, thoughtSignature: signature }] } },
        ],
      })}`,
    );
    expect(chunk?.functionCalls[0].thoughtSignature).toBe(signature);
  });

  it('sends the signature back on the model turn (the actual fix)', () => {
    const { contents } = toGeminiContents([
      { role: 'user', content: 'fix the tests' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'plan_todo',
            arguments: JSON.stringify({ goal: 'x' }),
            providerMeta: { thoughtSignature: signature },
          },
        ],
      },
      { role: 'tool', content: 'ok', toolCallId: 'call_1' },
    ]);

    const modelTurn = contents.find((c) => c.role === 'model');
    const part = modelTurn?.parts.find((p) => 'functionCall' in p) as { thoughtSignature?: string } | undefined;
    expect(part?.thoughtSignature).toBe(signature);
  });

  it('omits the field entirely for providers/turns that have no signature', () => {
    const { contents } = toGeminiContents([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{}' }],
      },
    ]);
    const part = contents.find((c) => c.role === 'model')?.parts[0] as Record<string, unknown>;
    expect(part).not.toHaveProperty('thoughtSignature');
  });
});
