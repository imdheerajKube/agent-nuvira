/**
 * A model descriptor returned by listModels()
 */
export interface ModelDescriptor {
  id: string;
  name: string;
  provider: string;
  owner?: string;
  description?: string;
  /**
   * Category tags indicating what this model is good for.
   * Examples: 'chat', 'code', 'fast', 'reasoning', 'vision'
   * Populated by the model-catalog utility when listing models.
   */
  tags?: string[];
  /**
   * The provider's OWN advertised nominal input context window (tokens) for
   * this model, when the list endpoint exposes it (Ollama `/api/tags`
   * `general.context_length`, OpenRouter `/models` `context_length`).
   * Recorded into the Model Availability Registry on probe so the router's
   * context preflight uses the LIVE descriptor, not a static table.
   */
  contextWindowTokens?: number;
}

import { InferenceOptions } from '../config/types.js';

// ─── Tool-calling types (H1) ────────────────────────────────────────────────

/** One message in a tool-calling conversation (OpenAI wire shape). */
export interface ToolMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant only — the tool calls this assistant message made. */
  toolCalls?: ToolCallRequest[];
  /** Tool only — the id of the tool call being answered. */
  toolCallId?: string;
}

/** A tool call in the assistant message (wire form: arguments is a JSON string). */
export interface ToolCallRequest {
  id: string;
  name: string;
  /** JSON string of the arguments (OpenAI wire convention). */
  arguments: string;
}

/** A parsed tool call (arguments is an object). */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** The JSON-schema form of a tool handed to native tool-calling providers. */
export interface ToolSchema {
  name: string;
  description: string;
  /** OpenAPI-style JSON schema for the tool's parameters. */
  parameters: Record<string, unknown>;
}

/** The response of a native tool-calling call. */
export interface ToolCallResponse {
  /** Assistant text content (usually empty when tool calls are present). */
  content: string;
  /** Parsed tool calls (empty = end turn). */
  toolCalls: ToolCall[];
}

/**
 * Unified inference provider interface.
 * All adapters (local, nim, gemini, openrouter) implement this.
 */
export interface InferenceProvider {
  /** Display name for the provider */
  readonly name: string;

  /**
   * Generate a completion for the given prompt.
   * Returns the generated text content.
   */
  generate(prompt: string, options?: InferenceOptions): Promise<string>;

  /**
   * H1 — native tool-calling (optional). Implemented by providers that speak
   * the OpenAI `tools`/`tool_calls` protocol. When absent, callers fall back
   * to the JSON-fallback transport (tools contract in the system prompt).
   * Returns text content + parsed tool calls (empty toolCalls = end turn).
   */
  generateTools?(
    messages: ToolMessage[],
    tools: ToolSchema[],
    options?: InferenceOptions
  ): Promise<ToolCallResponse>;

  /**
   * Generate a streaming completion for the given prompt.
   * Tokens are delivered to onToken as they arrive.
   * Returns the full generated text content.
   */
  generateStream?(
    prompt: string,
    options: InferenceOptions | undefined,
    onToken: (token: string) => void
  ): Promise<string>;

  /**
   * Check if the provider is properly configured and available
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get a description of the current provider configuration
   */
  getInfo(): string;

  /**
   * List available models from this provider
   */
  listModels(): Promise<ModelDescriptor[]>;
}
