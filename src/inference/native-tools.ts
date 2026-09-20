/**
 * Native tool-calling wire mapping (`src/inference/native-tools.ts`) —
 * AGENTIC_CAPABILITY_ASSESSMENT Addendum v4 Phase 1.2 (the BLOCKING item).
 *
 * The loop engine (`runToolLoop`) speaks the OpenAI `ToolMessage`/`ToolSchema`
 * shape. Groq/OpenRouter/OpenAI-compat/NIM ride the shared
 * `chatCompletionsWithTools` helper (tools.ts). Gemini and Anthropic do NOT
 * speak that protocol — the assessment found them at "0 generateTools matches,
 * JSON-fallback only" and marked adapter parity as BLOCKING for loop-default,
 * because prompt-parsed JSON tool calls are flakiest on exactly the models
 * users route to.
 *
 * This module carries the two non-OpenAI wire mappings, so each adapter's
 * `generateTools`/`generateToolsStream` is a thin fetch around tested
 * translation code:
 *
 *   Gemini (v1beta generateContent):
 *     system      → systemInstruction.parts[].text
 *     user        → role "user", parts[{text}]
 *     assistant   → role "model", parts[{text}?, {functionCall:{name,args}}…]
 *     tool result → role "user", parts[{functionResponse:{name,response}}]
 *     tools       → tools[{functionDeclarations:[…]}]  (OpenAPI subset schema)
 *
 *   Anthropic (v1/messages):
 *     system        → top-level `system` string (concatenated)
 *     user          → messages[{role:"user", content}]
 *     assistant+tc  → content blocks: [{type:"text"}?, {type:"tool_use", id, name, input}…]
 *     tool result   → user message with {type:"tool_result", tool_use_id, content}
 *                     (consecutive tool messages merge into ONE user message —
 *                     Anthropic requires tool_result blocks to live in the
 *                     message immediately following the tool_use)
 *     tools         → tools[{name, description, input_schema}]
 *
 * Correctness rules shared by both mappings:
 * - Assistant tool_calls carry `arguments` as a JSON STRING (OpenAI wire
 *   convention); both mappings parse it defensively — a malformed argument
 *   string degrades to `{}` instead of throwing (the model retries in-loop).
 * - Tool results keep their identity: Gemini keys functionResponse by tool
 *   NAME (recovered from the assistant toolCalls entry with the matching id),
 *   Anthropic by tool_use_id directly.
 * - Synthetic tool-call ids (`call_1`…) are generated for Gemini, which has
 *   no id concept — they only need internal consistency within one thread.
 */

import type { ToolCallResponse, ToolMessage, ToolSchema } from './interface.js';

// ─── Shared: defensive JSON argument parsing ────────────────────────────────

/** Parse an OpenAI-wire arguments JSON string → object ({} on any failure). */
export function parseToolArguments(argumentsJson: string | undefined): Record<string, unknown> {
  if (!argumentsJson) return {};
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// ─── Gemini ─────────────────────────────────────────────────────────────────

/** Gemini function declaration (OpenAPI-schema subset, camelCase keys). */
interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  /**
   * Returned by Gemini alongside a functionCall part and REQUIRED on the way
   * back when the loop continues the conversation. Opaque to us — we only
   * carry it.
   */
  thoughtSignature?: string;
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/**
 * Strip JSON-Schema keywords Gemini's function-declaration validation rejects
 * ($schema, additionalProperties, default, examples, exclusiveMinimum/Maximum,
 * oneOf/anyOf/allOf/not — Gemini 1.x 400s on these) and flatten union types
 * (`type: ["string","null"]` → `type: "string", nullable: true`). The OpenAPI
 * subset Gemini accepts: type, description, enum, format, items, properties,
 * required, nullable, minItems/maxItems, minLength/maxLength, minimum/maximum,
 * pattern, title, readOnly, ignore.
 */
export function toGeminiSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const KEEP = new Set([
    'type', 'description', 'enum', 'format', 'items', 'properties', 'required',
    'nullable', 'minItems', 'maxItems', 'minLength', 'maxLength',
    'minimum', 'maximum', 'pattern', 'title',
  ]);
  const walk = (node: unknown): Record<string, unknown> | undefined => {
    if (!node || typeof node !== 'object') return undefined;
    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (!KEEP.has(k)) continue;
      if (k === 'type' && Array.isArray(v)) {
        // Union type → base type + nullable flag (Gemini's nullability form).
        const nonNull = v.filter((t) => t !== 'null') as string[];
        out.type = nonNull[0] ?? 'string';
        if (v.includes('null')) out.nullable = true;
        continue;
      }
      if (k === 'items') {
        out.items = walk(v) ?? {};
        continue;
      }
      if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
        const props: Record<string, unknown> = {};
        for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
          const s = walk(pv);
          if (s) props[pk] = s;
        }
        out.properties = props;
        continue;
      }
      out[k] = v;
    }
    // Gemini requires a concrete type on every property object.
    if (!out.type && (out.properties || out.items)) out.type = 'object';
    return out;
  };
  const result = walk(schema);
  if (result && !result.type) result.type = 'object';
  return result;
}

/** ToolSchema[] → Gemini `tools` request entry. */
export function toGeminiFunctionDeclarations(tools: ToolSchema[]): Array<{ functionDeclarations: GeminiFunctionDeclaration[] }> {
  const declarations: GeminiFunctionDeclaration[] = tools.map((t) => {
    const decl: GeminiFunctionDeclaration = { name: t.name, description: t.description };
    const params = toGeminiSchema(t.parameters);
    if (params && (params.properties || params.type === 'object')) decl.parameters = params;
    return decl;
  });
  return [{ functionDeclarations: declarations }];
}

/** Recover the tool NAME for a tool result from the assistant toolCalls entry with that id. */
function toolNameForCallId(messages: ToolMessage[], toolCallId: string | undefined): string | undefined {
  if (!toolCallId) return undefined;
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    const match = m.toolCalls.find((tc) => tc.id === toolCallId);
    if (match) return match.name;
  }
  return undefined;
}

/**
 * ToolMessage[] → Gemini `contents` + `systemInstruction`.
 * Consecutive tool-result messages become one "user" content with one
 * functionResponse part each (the loop pushes them individually, but a
 * parallel-capable caller may batch them).
 */
export function toGeminiContents(messages: ToolMessage[]): {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: GeminiContent[];
} {
  let systemInstruction: { parts: Array<{ text: string }> } | undefined;
  const contents: GeminiContent[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      if (!m.content) continue;
      if (!systemInstruction) systemInstruction = { parts: [] };
      systemInstruction.parts.push({ text: m.content });
      continue;
    }
    if (m.role === 'user') {
      if (m.content) contents.push({ role: 'user', parts: [{ text: m.content }] });
      continue;
    }
    if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) {
        // Echo the provider's opaque thought signature back with the call it
        // belongs to. Without this Gemini rejects the continuation turn with
        // `400 ... missing a thought_signature in functionCall parts`, so a
        // Gemini run died on step 2 no matter how capable the model was.
        const signature = tc.providerMeta?.thoughtSignature;
        parts.push({
          functionCall: { name: tc.name, args: parseToolArguments(tc.arguments) },
          ...(typeof signature === 'string' ? { thoughtSignature: signature } : {}),
        });
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }
    // role === 'tool' → functionResponse under role "user" (v1beta convention).
    const name = toolNameForCallId(messages, m.toolCallId);
    if (!name) continue; // unpaired tool result — nothing Gemini can key it by
    contents.push({
      role: 'user',
      parts: [{ functionResponse: { name, response: { result: m.content } } }],
    });
  }

  return { systemInstruction, contents };
}

/** Non-stream Gemini generateContent response shape (tool-call aware). */
export interface GeminiToolResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: { name: string; args?: Record<string, unknown> };
        thoughtSignature?: string;
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Parse a Gemini response body → the loop's ToolCallResponse. */
export function parseGeminiToolResponse(data: GeminiToolResponse): ToolCallResponse {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  let content = '';
  const toolCalls: ToolCallResponse['toolCalls'] = [];
  for (const p of parts) {
    if (typeof p.text === 'string' && p.text) content += p.text;
    if (p.functionCall?.name) {
      toolCalls.push({
        id: `call_${toolCalls.length + 1}`,
        name: p.functionCall.name,
        arguments: p.functionCall.args ?? {},
        // Carried, never interpreted — see GeminiPart.thoughtSignature.
        ...(p.thoughtSignature ? { providerMeta: { thoughtSignature: p.thoughtSignature } } : {}),
      });
    }
  }
  return { content, toolCalls };
}

/**
 * Extract the text deltas from ONE Gemini SSE chunk (streamGenerateContent
 * alt=sse): text parts stream to the caller immediately, functionCall parts
 * accumulate. Returns null for non-data/[DONE]/unparseable lines.
 */
export function parseGeminiToolSSEChunk(line: string): {
  text: string | null;
  functionCalls: Array<{ name: string; args?: Record<string, unknown>; thoughtSignature?: string }>;
  usage?: { promptTokens?: number; completionTokens?: number };
} | null {
  if (!line.startsWith('data: ')) return null;
  const data = line.slice(6).trim();
  if (!data || data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data) as GeminiToolResponse;
    const parts = parsed.candidates?.[0]?.content?.parts ?? [];
    let text: string | null = null;
    const functionCalls: Array<{ name: string; args?: Record<string, unknown>; thoughtSignature?: string }> = [];
    for (const p of parts) {
      if (typeof p.text === 'string' && p.text) text = (text ?? '') + p.text;
      if (p.functionCall?.name) {
        functionCalls.push({ name: p.functionCall.name, args: p.functionCall.args, thoughtSignature: p.thoughtSignature });
      }
    }
    const usage = parsed.usageMetadata
      ? { promptTokens: parsed.usageMetadata.promptTokenCount, completionTokens: parsed.usageMetadata.candidatesTokenCount }
      : undefined;
    return { text, functionCalls, usage };
  } catch {
    return null;
  }
}

// ─── Anthropic ──────────────────────────────────────────────────────────────

/** Anthropic content blocks used by tool calling. */
export type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface AnthropicRequestMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

/**
 * ToolMessage[] → Anthropic `system` + `messages`.
 * Consecutive tool results merge into ONE user message (tool_result blocks
 * must immediately follow the tool_use they answer). Empty text is skipped;
 * an assistant message with only toolCalls sends tool_use blocks with no
 * text block (Anthropic accepts content arrays with tool_use only).
 */
export function toAnthropicMessages(messages: ToolMessage[]): {
  system: string | undefined;
  messages: AnthropicRequestMessage[];
} {
  let system: string | undefined;
  const out: AnthropicRequestMessage[] = [];
  // Pending tool_result blocks waiting to be flushed as one user message.
  let pendingToolResults: AnthropicBlock[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      out.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of messages) {
    if (m.role === 'system') {
      if (!m.content) continue;
      system = system ? `${system}\n${m.content}` : m.content;
      continue;
    }
    if (m.role === 'user') {
      flushToolResults();
      if (m.content) out.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      flushToolResults();
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parseToolArguments(tc.arguments) });
      }
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });
      continue;
    }
    // role === 'tool' → tool_result block in the NEXT user message.
    if (m.toolCallId) {
      pendingToolResults.push({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
    }
  }
  flushToolResults();

  return { system, messages: out };
}

/** ToolSchema[] → Anthropic `tools` request entry. */
export function toAnthropicToolDefs(tools: ToolSchema[]): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: (t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} }),
  }));
}

/** Non-stream Anthropic Messages response shape (tool-call aware). */
export interface AnthropicToolResponse {
  content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Parse an Anthropic Messages response body → the loop's ToolCallResponse. */
export function parseAnthropicToolResponse(data: AnthropicToolResponse): ToolCallResponse {
  let content = '';
  const toolCalls: ToolCallResponse['toolCalls'] = [];
  for (const block of data.content ?? []) {
    if (block.type === 'text' && block.text) content += block.text;
    if (block.type === 'tool_use' && block.name) {
      toolCalls.push({
        id: block.id || `call_${toolCalls.length + 1}`,
        name: block.name,
        arguments: block.input ?? {},
      });
    }
  }
  return { content, toolCalls };
}

// ─── Anthropic streaming accumulator ────────────────────────────────────────

/**
 * Streaming state machine for Anthropic's event stream with tools.
 * Feed every `data: {…}` SSE line; text deltas arrive via the returned
 * `text` (deliver to onToken), tool_use blocks accumulate from
 * content_block_start (id/name) + input_json_delta fragments and are
 * finalized at message_stop via `finalize()`.
 */
export class AnthropicToolStreamAccumulator {
  private blocks: Array<{
    index: number;
    type: 'text' | 'tool_use';
    text?: string;
    id?: string;
    name?: string;
    inputJson?: string;
  }> = [];
  private usage?: { promptTokens?: number; completionTokens?: number };
  private stopped = false;

  /** Consume one parsed SSE event object. Returns text deltas to stream (or null). */
  consume(event: {
    type?: string;
    index?: number;
    content_block?: { type?: string; text?: string; id?: string; name?: string };
    delta?: { type?: string; text?: string; partial_json?: string };
    usage?: { input_tokens?: number; output_tokens?: number };
  }): string | null {
    switch (event.type) {
      case 'content_block_start': {
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          this.blocks.push({ index: event.index ?? this.blocks.length, type: 'tool_use', id: block.id, name: block.name, inputJson: '' });
        } else if (block?.type === 'text') {
          this.blocks.push({ index: event.index ?? this.blocks.length, type: 'text', text: block.text ?? '' });
        }
        return null;
      }
      case 'content_block_delta': {
        const target = this.blocks.find((b) => b.index === (event.index ?? 0));
        if (!target) return null;
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          target.text = (target.text ?? '') + event.delta.text;
          return event.delta.text;
        }
        if (event.delta?.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
          target.inputJson = (target.inputJson ?? '') + event.delta.partial_json;
        }
        return null;
      }
      case 'message_delta': {
        if (event.usage) this.usage = { promptTokens: event.usage.input_tokens, completionTokens: event.usage.output_tokens };
        return null;
      }
      case 'message_stop': {
        this.stopped = true;
        return null;
      }
      default:
        return null;
    }
  }

  /** Whether message_stop arrived (the stream is complete). */
  get isStopped(): boolean {
    return this.stopped;
  }

  /** Wire-usage captured from message_delta (undefined when the stream carried none). */
  get streamUsage(): { promptTokens?: number; completionTokens?: number } | undefined {
    return this.usage;
  }

  /** Finalize → the loop's ToolCallResponse (text joined, tool_use inputs parsed). */
  finalize(): ToolCallResponse {
    let content = '';
    const toolCalls: ToolCallResponse['toolCalls'] = [];
    for (const b of this.blocks) {
      if (b.type === 'text' && b.text) content += b.text;
      if (b.type === 'tool_use' && b.name) {
        toolCalls.push({
          id: b.id || `call_${toolCalls.length + 1}`,
          name: b.name,
          arguments: parseToolArguments(b.inputJson || '{}'),
        });
      }
    }
    return { content, toolCalls };
  }
}
