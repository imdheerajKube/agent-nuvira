/**
 * Child-agent runtime (`src/tools/child-agent-runtime.ts`).
 *
 * The work a forked subagent process actually does: resolve a REAL inference
 * provider from the user's own configuration, run a bounded think → act →
 * observe loop, execute any tool the model asks for through the REAL registry,
 * and return the model's own output.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * `child-agent-worker.ts` was a simulation wearing the shape of an agent loop:
 * its `LLMClient.call()` switched on keywords in the goal and returned canned
 * strings ("I've analyzed the task: …"), and its `ToolExecutor.execute()`
 * returned `Executed <tool>` without running anything. A subagent built on it
 * reported work that never happened — the finding-#4 defect in the same
 * workstream, which is why the tool was marked NOT CONNECTED in the registry.
 *
 * ── The rule this module follows ────────────────────────────────────────────
 * Nothing is synthesised. If no provider can be constructed, or the backend is
 * not reachable, or the provider cannot do tool-calling while tools were
 * requested, this THROWS a typed refusal instead of returning a plausible
 * answer. `SubagentRefusalError.code` carries the reason so the parent records
 * it as the failure it is.
 *
 * The provider factory and the tool runner are injectable so the loop is
 * testable without a network; production passes neither and gets the real ones.
 */

import { ConfigManager } from '../config/manager.js';
import { ProviderFactory } from '../inference/factory.js';
import type { InferenceProvider, ToolMessage, ToolSchema } from '../inference/interface.js';
import { SubagentRefusalError } from './subagent-refusal.js';
import { getTool, toolJsonSchemas, type ToolContext } from './registry.js';

export interface SubagentRuntimeConfig {
  /** The task the subagent must complete. */
  goal: string;
  /** Provider id, or 'auto' to let the config resolve the best available one. */
  provider?: string;
  /** Model id; 'auto'/absent lets the provider's configured model stand. */
  model?: string;
  /** Allow-list of tool names. Empty = a plain completion with no tools. */
  tools?: string[];
  /** Never offered to the model, and refused if it calls one anyway. */
  blockedTools?: string[];
  /** Hard ceiling on model calls (default 25). */
  maxLlmCalls?: number;
  /** Hard ceiling on loop iterations (default 12). */
  maxIterations?: number;
  /** Working directory for tool execution. */
  cwd?: string;
}

export interface SubagentRuntimeHooks {
  /** Receives `progress` records (forwarded to the parent over IPC). */
  send?: (msg: Record<string, unknown>) => void;
  /** Override provider construction (tests inject a scripted provider). */
  createProvider?: (
    requested: string | undefined,
    model: string | undefined,
  ) => Promise<{ provider: InferenceProvider; type: string }>;
  /** Override tool execution (tests assert the real registry is used). */
  runTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export interface SubagentRuntimeResult {
  /** The model's final text. Never a template this module composed. */
  result: string;
  llmCalls: number;
  toolCalls: number;
  /** Provider that actually served the calls. */
  provider: string;
  /** True when the run hit an iteration/call ceiling before the model stopped. */
  truncated: boolean;
}

const DEFAULT_MAX_LLM_CALLS = 25;
const DEFAULT_MAX_ITERATIONS = 12;

/** Tools a subagent must never call, whatever the caller asks for. */
const ALWAYS_BLOCKED = new Set(['ask_user', 'respond']);

function buildSystemPrompt(config: SubagentRuntimeConfig, tools: string[]): string {
  return [
    `You are a subagent. Your task: ${config.goal}`,
    '',
    tools.length
      ? `You have these tools: ${tools.join(', ')}. Use them to gather what you need, then answer.`
      : 'You have no tools. Answer from what you already know and say so if you cannot.',
    '',
    'Work in steps. When the task is done, reply with the final answer as plain text —',
    'no preamble, no instructions to the user.',
  ].join('\n');
}

/**
 * Resolve the tool allow-list: the request, minus anything always blocked, minus
 * anything the caller listed as blocked, keeping only names the registry knows.
 * A name that does not exist is dropped loudly (returned) rather than silently.
 */
export function resolveToolAllowList(config: SubagentRuntimeConfig): { allowed: string[]; unknown: string[] } {
  const blocked = new Set([...(config.blockedTools ?? []), ...ALWAYS_BLOCKED]);
  const unknown: string[] = [];
  const allowed: string[] = [];
  for (const name of config.tools ?? []) {
    if (blocked.has(name)) continue;
    if (!getTool(name)) {
      unknown.push(name);
      continue;
    }
    allowed.push(name);
  }
  return { allowed, unknown };
}

/**
 * Run the subagent to completion.
 *
 * @throws SubagentRefusalError when nothing real can be run — no constructible
 *   provider, an unreachable backend, or tools requested on a provider that
 *   cannot call them.
 */
export async function runSubagent(
  config: SubagentRuntimeConfig,
  hooks: SubagentRuntimeHooks = {},
): Promise<SubagentRuntimeResult> {
  const send = hooks.send ?? (() => {});
  const maxLlmCalls = config.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS;
  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const { allowed, unknown } = resolveToolAllowList(config);
  if (unknown.length > 0) {
    throw new SubagentRefusalError(
      'unsupported_format',
      `Unknown tool(s) requested for this subagent: ${unknown.join(', ')}. ` +
        `Available: ${toolJsonSchemas().length} registered tools.`,
    );
  }

  const { provider, type } = await createProvider(hooks, config);

  // A backend that cannot be reached is a refusal, not an empty result.
  const available = await provider.isAvailable().catch(() => false);
  if (!available) {
    throw new SubagentRefusalError(
      'not_configured',
      `Provider '${type}' is not reachable. Configure it (or start its backend, e.g. \`ollama serve\`) and re-run.`,
    );
  }

  send({ type: 'progress', phase: 'starting', provider: type, tools: allowed });

  // ── Native tool-calling loop ──────────────────────────────────────────────
  if (allowed.length > 0) {
    if (typeof provider.generateTools !== 'function') {
      // Running the task without its tools would answer a question the model was
      // never equipped to answer, which is the fabrication this workstream is
      // about. Refuse and name a provider that can.
      throw new SubagentRefusalError(
        'unavailable',
        `Provider '${type}' does not support tool-calling, so a subagent was asked for tools it cannot use. ` +
          `Use a tool-calling provider (openai, anthropic, gemini, nim, openrouter) or request no tools.`,
      );
    }
    return runToolLoop(config, allowed, provider, type, { send, runTool: hooks.runTool, maxLlmCalls, maxIterations });
  }

  // ── Plain completion (no tools) ───────────────────────────────────────────
  const prompt = [
    buildSystemPrompt(config, []),
    '',
    `Task: ${config.goal}`,
  ].join('\n');
  const text = await provider.generate(prompt, modelOption(config));
  return {
    result: text.trim(),
    llmCalls: 1,
    toolCalls: 0,
    provider: type,
    truncated: false,
  };
}

/** Only pass a model when one was actually requested — 'auto' is not a model id. */
function modelOption(config: SubagentRuntimeConfig): { model?: string } {
  return config.model && config.model !== 'auto' ? { model: config.model } : {};
}

async function createProvider(
  hooks: SubagentRuntimeHooks,
  config: SubagentRuntimeConfig,
): Promise<{ provider: InferenceProvider; type: string }> {
  if (hooks.createProvider) return hooks.createProvider(config.provider, config.model);

  const configManager = new ConfigManager();
  const requested = config.provider && config.provider !== 'auto' ? config.provider : 'auto';
  const { type, config: providerConfig } = configManager.getProviderConfig(requested);

  if (!ProviderFactory.isConstructible(type)) {
    throw new SubagentRefusalError(
      'not_configured',
      `Provider '${type}' has no adapter, so no subagent call can be made with it. Configure a supported provider.`,
    );
  }
  // A model named for the subagent wins over the provider's default; the adapter
  // still receives a real id because 'auto' is filtered out above.
  const merged = config.model && config.model !== 'auto' ? { ...providerConfig, model: config.model } : providerConfig;
  return { provider: ProviderFactory.createProvider(type, merged), type };
}

interface LoopHooks {
  send: (msg: Record<string, unknown>) => void;
  runTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
  maxLlmCalls: number;
  maxIterations: number;
}

async function runToolLoop(
  config: SubagentRuntimeConfig,
  allowed: string[],
  provider: InferenceProvider,
  type: string,
  loop: LoopHooks,
): Promise<SubagentRuntimeResult> {
  const schemas: ToolSchema[] = toolJsonSchemas(allowed).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const messages: ToolMessage[] = [
    { role: 'system', content: buildSystemPrompt(config, allowed) },
    { role: 'user', content: config.goal },
  ];

  let llmCalls = 0;
  let toolCalls = 0;

  for (let iteration = 0; iteration < loop.maxIterations; iteration += 1) {
    if (llmCalls >= loop.maxLlmCalls) {
      return {
        result: 'Subagent stopped: reached its model-call ceiling before finishing.',
        llmCalls,
        toolCalls,
        provider: type,
        truncated: true,
      };
    }

    loop.send({ type: 'progress', phase: 'thinking', iteration: iteration + 1, llmCalls, toolCalls });
    const response = await provider.generateTools!(messages, schemas, modelOption(config));
    llmCalls += 1;

    if (response.toolCalls.length === 0) {
      return { result: response.content.trim(), llmCalls, toolCalls, provider: type, truncated: false };
    }

    // Replay the assistant turn exactly as the provider asked for it — the
    // tool-call ids and any providerMeta (Gemini's thoughtSignature) must go back
    // verbatim or the next turn is rejected.
    messages.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
        ...(call.providerMeta ? { providerMeta: call.providerMeta } : {}),
      })),
    });

    for (const call of response.toolCalls) {
      if (!allowed.includes(call.name)) {
        messages.push({
          role: 'tool',
          content: `Refused: '${call.name}' is not available to this subagent.`,
          toolCallId: call.id,
        });
        continue;
      }
      loop.send({ type: 'progress', phase: 'tool_call', tool: call.name });
      const output = await executeTool(config, call.name, call.arguments, loop.runTool);
      toolCalls += 1;
      messages.push({ role: 'tool', content: output, toolCallId: call.id });
    }
  }

  return {
    result: 'Subagent stopped: reached its iteration ceiling before finishing.',
    llmCalls,
    toolCalls,
    provider: type,
    truncated: true,
  };
}

/**
 * Execute one tool through the REAL registry. Errors come back as text for the
 * model to read (a tool that failed is information, not a crash), which is also
 * what the main tool loop does.
 */
async function executeTool(
  config: SubagentRuntimeConfig,
  name: string,
  args: Record<string, unknown>,
  override?: (name: string, args: Record<string, unknown>) => Promise<string>,
): Promise<string> {
  if (override) return override(name, args);
  const tool = getTool(name);
  if (!tool) return `Error: unknown tool '${name}'.`;
  const ctx: ToolContext = {
    configManager: new ConfigManager(),
    cwd: config.cwd ?? process.cwd(),
  };
  try {
    const out = await tool.run(args as never, ctx);
    return typeof out === 'string' ? out : JSON.stringify(out);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
