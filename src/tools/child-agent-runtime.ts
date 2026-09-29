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
import type { InferenceProvider, ToolCallResponse, ToolMessage, ToolSchema } from '../inference/interface.js';
import { resolveAdapterDefault } from '../learning/model-selection.js';
import { SubagentRefusalError } from './subagent-refusal.js';
import { getTool, toolJsonSchemas, TOOL_CONTRACT_JSON, type ToolContext } from './registry.js';
// WS1 — the finding tool's bus event; forwarded to the parent as its own frame.
import { FINDING_EVENT } from './finding-tool.js';

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
  /**
   * The model sent on the wire, when one could be resolved. Reported because a
   * run is otherwise only attributable to a provider — "groq failed" does not
   * say WHICH model the account rejected (see {@link effectiveModel}).
   */
  model?: string;
  /**
   * How tool calls were carried. `native` = the provider's own tool protocol;
   * `json` = the shared JSON-fallback transport (the same prompt builder and
   * parser the chat and execute loops use). `none` = no tools were requested.
   */
  transport: 'native' | 'json' | 'none';
  /** True when the run hit an iteration/call ceiling before the model stopped. */
  truncated: boolean;
}

/**
 * Which transport carries tool calls for this provider.
 *
 * Most hosted providers speak the OpenAI `tools` protocol. A local Ollama model
 * (the `local` adapter) does not, and that used to make the subagent REFUSE when
 * tools were asked for — honest, but it meant a local-only setup could not use
 * tools at all. The fallback closes that: the tool names, argument shapes and a
 * `{"tool":…,"arguments":…}` contract ride in the prompt, and the reply is parsed
 * with the same `extractFallbackToolCalls` the chat loop uses for exactly this.
 */
function transportFor(provider: InferenceProvider): 'native' | 'json' {
  return typeof provider.generateTools === 'function' ? 'native' : 'json';
}

const DEFAULT_MAX_LLM_CALLS = 25;
const DEFAULT_MAX_ITERATIONS = 12;

/** Tools a subagent must never call, whatever the caller asks for. */
const ALWAYS_BLOCKED = new Set(['ask_user', 'respond']);

function buildSystemPrompt(
  config: SubagentRuntimeConfig,
  tools: string[],
  transport: 'native' | 'json' | 'none' = 'none',
): string {
  const lines = [
    `You are a subagent. Your task: ${config.goal}`,
    '',
    tools.length
      ? `You have these tools: ${tools.join(', ')}. Use them to gather what you need, then answer.`
      : 'You have no tools. Answer from what you already know and say so if you cannot.',
  ];
  if (transport === 'json') {
    // No tool protocol on this provider, so the contract is stated in the prompt
    // — the same text the chat and execute loops use, never a private re-wording.
    lines.push('', TOOL_CONTRACT_JSON);
  }
  lines.push(
    '',
    'Work in steps. When the task is done, reply with the final answer as plain text —',
    'no preamble, no instructions to the user.',
  );
  return lines.join('\n');
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

  const { provider, type, model } = await createProvider(hooks, config);

  // Which provider/model/transport is about to serve this run, announced BEFORE
  // anything can fail. The parent records these on the run, so a subagent that
  // dies on its very first model call is still attributable — "groq rejected
  // gemma-4-26b-a4b-it over the native tool protocol" — instead of leaving a
  // bare error string and no way to tell which backend produced it.
  const hasTools = allowed.length > 0;
  const transport: 'native' | 'json' = transportFor(provider);
  send({
    type: 'progress',
    phase: 'starting',
    provider: type,
    ...(model ? { model } : {}),
    tools: allowed,
    transport: hasTools ? transport : 'none',
  });

  // A backend that cannot be reached is a refusal, not an empty result.
  const available = await provider.isAvailable().catch(() => false);
  if (!available) {
    throw new SubagentRefusalError(
      'not_configured',
      `Provider '${type}' is not reachable. Configure it (or start its backend, e.g. \`ollama serve\`) and re-run.`,
    );
  }

  // ── Tool loop (native protocol, or the shared JSON fallback) ──────────────
  if (hasTools) {
    return runToolLoop(config, allowed, provider, type, transport, {
      send,
      runTool: hooks.runTool,
      maxLlmCalls,
      maxIterations,
      model,
    });
  }

  // ── Plain completion (no tools) ───────────────────────────────────────────
  const prompt = [
    buildSystemPrompt(config, []),
    '',
    `Task: ${config.goal}`,
  ].join('\n');
  const text = await provider.generate(prompt, modelOption(model));
  return {
    result: text.trim(),
    llmCalls: 1,
    toolCalls: 0,
    provider: type,
    ...(model ? { model } : {}),
    transport: 'none',
    truncated: false,
  };
}

/**
 * One model call, on whichever transport this provider speaks.
 *
 * The fallback path reuses `buildJsonFallbackPrompt` and
 * `extractFallbackToolCalls` — the same pair the chat loop and the execute loop
 * use — so a subagent speaks the dialect the rest of the system already parses.
 * They are imported lazily because `tool-loop.ts` pulls in the registry and the
 * event bus, which a plain completion should not pay for.
 */
async function callModel(
  provider: InferenceProvider,
  transport: 'native' | 'json',
  messages: ToolMessage[],
  schemas: ToolSchema[],
  model: string | undefined,
): Promise<ToolCallResponse> {
  if (transport === 'native') {
    return provider.generateTools!(messages, schemas, modelOption(model));
  }
  const { buildJsonFallbackPrompt } = await import('../inference/tool-call-utils.js');
  const { extractFallbackToolCalls } = await import('./tool-loop.js');
  const raw = await provider.generate(buildJsonFallbackPrompt(messages as never, schemas as never), modelOption(model));
  const { text, calls } = extractFallbackToolCalls(raw);
  return {
    content: text,
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
  };
}

/** Only pass a model when one was actually resolved — 'auto' is not a model id. */
function modelOption(model: string | undefined): { model: string } | undefined {
  return model ? { model } : undefined;
}

/**
 * The model id the adapter will put on the wire for this subagent.
 *
 * Resolved with `resolveAdapterDefault` — the SAME function every adapter calls
 * for itself when the caller passes no model — so the name recorded on a run
 * cannot disagree with the name actually sent. It is then passed EXPLICITLY to
 * every model call, which makes that guarantee structural rather than a promise:
 * `options.model` wins over the adapter's own fallback, so a run that reports
 * `model: X` really was sent X.
 *
 * Returns undefined when nothing can be resolved; the adapter then raises its own
 * clear "no model resolved — run `nuvira models refresh`" error, which is the
 * failure a run should carry rather than an invented name.
 */
function effectiveModel(providerType: string, configuredModel?: string): string | undefined {
  return resolveAdapterDefault(providerType, configuredModel === 'auto' ? undefined : configuredModel);
}

async function createProvider(
  hooks: SubagentRuntimeHooks,
  config: SubagentRuntimeConfig,
): Promise<{ provider: InferenceProvider; type: string; model?: string }> {
  if (hooks.createProvider) {
    const { provider, type } = await hooks.createProvider(config.provider, config.model);
    // An injected factory names its own model; there is no adapter registry to
    // consult, so a caller-named model is reported as-is and nothing is invented.
    const named = config.model && config.model !== 'auto' ? config.model : undefined;
    return { provider, type, ...(named ? { model: named } : {}) };
  }

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
  const model = effectiveModel(type, merged.model);
  return { provider: ProviderFactory.createProvider(type, merged), type, ...(model ? { model } : {}) };
}

interface LoopHooks {
  send: (msg: Record<string, unknown>) => void;
  runTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
  maxLlmCalls: number;
  maxIterations: number;
  /** The model every call in this loop is pinned to (see {@link effectiveModel}). */
  model?: string;
}

async function runToolLoop(
  config: SubagentRuntimeConfig,
  allowed: string[],
  provider: InferenceProvider,
  type: string,
  transport: 'native' | 'json',
  loop: LoopHooks,
): Promise<SubagentRuntimeResult> {
  const schemas: ToolSchema[] = toolJsonSchemas(allowed).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const messages: ToolMessage[] = [
    { role: 'system', content: buildSystemPrompt(config, allowed, transport) },
    { role: 'user', content: config.goal },
  ];

  const model = loop.model;
  const base = { provider: type, ...(model ? { model } : {}), transport } as const;

  let llmCalls = 0;
  let toolCalls = 0;

  for (let iteration = 0; iteration < loop.maxIterations; iteration += 1) {
    if (llmCalls >= loop.maxLlmCalls) {
      return {
        result: 'Subagent stopped: reached its model-call ceiling before finishing.',
        llmCalls,
        toolCalls,
        ...base,
        truncated: true,
      };
    }

    loop.send({ type: 'progress', phase: 'thinking', iteration: iteration + 1, llmCalls, toolCalls });
    const response = await callModel(provider, transport, messages, schemas, model);
    llmCalls += 1;

    if (response.toolCalls.length === 0) {
      return { result: response.content.trim(), llmCalls, toolCalls, ...base, truncated: false };
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
      // Two frames, mirroring the main loop's `tool:started` → `tool:called`
      // pair: the CALL, then its OUTCOME. The parent used to hear the name and
      // nothing else, so a run's tool calls were unattributable — a call that
      // FAILED looked exactly like one that worked (recorded on #22 as
      // tool-call-lifecycle@subagent).
      loop.send({ type: 'progress', phase: 'tool_call', tool: call.name });
      const output = await executeTool(config, call.name, call.arguments, loop.runTool, (event, data) => {
        // WS1 — a finding the child recorded, shipped on its own frame (the
        // same way its tool lifecycle crosses IPC). The parent records it, so a
        // subagent run reports the verdicts it produced like every other
        // surface instead of leaving them inside the child's process.
        if (event === FINDING_EVENT) {
          loop.send({ type: 'progress', phase: 'finding', finding: data, llmCalls, toolCalls });
        }
      });
      toolCalls += 1;
      loop.send({
        type: 'progress',
        phase: 'tool_result',
        tool: call.name,
        // The same convention the main loop and the tool registry use: a tool
        // signals failure by returning text that starts with `Error:`.
        ok: !output.startsWith('Error:'),
        llmCalls,
        toolCalls,
      });
      messages.push({ role: 'tool', content: output, toolCallId: call.id });
    }
  }

  return {
    result: 'Subagent stopped: reached its iteration ceiling before finishing.',
    llmCalls,
    toolCalls,
    ...base,
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
  emit?: (event: string, data: unknown) => void,
): Promise<string> {
  if (override) return override(name, args);
  const tool = getTool(name);
  if (!tool) return `Error: unknown tool '${name}'.`;
  const ctx: ToolContext = {
    configManager: new ConfigManager(),
    cwd: config.cwd ?? process.cwd(),
    // A tool that reports through the bus (the finding tool emits
    // `finding:recorded`) needs a sink on this side of the fork; the caller
    // forwards it as a frame. Absent for a direct/test invocation, exactly like
    // the other optional context fields.
    ...(emit ? { emit } : {}),
  };
  try {
    const out = await tool.run(args as never, ctx);
    return typeof out === 'string' ? out : JSON.stringify(out);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
