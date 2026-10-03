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
import { fenceUntrustedToolOutput } from './untrusted-content.js';
import { getTool, toolJsonSchemas, TOOL_CONTRACT_JSON, type ToolContext } from './registry.js';
// WS1 — the finding tool's bus event; forwarded to the parent as its own frame.
import { FINDING_EVENT } from './finding-tool.js';
import { sessionDebugLog, type SessionDebugLog } from '../observability/debug-log.js';
// WS3 (#25) — the child's own span tree, exported over OTLP when the operator
// asked for it. This is a SECOND process with its own provider, so its trace
// only joins the parent's when the parent handed it a `traceparent`.
import {
  flushSpans,
  parentContextFromEnv,
  shutdownSpans,
  startTurnSpan,
  TOOL_SPAN_PREFIX,
  withSpanActive,
  type SpanHandle,
} from '../observability/otel.js';
// WS4 (#26) — the SAME operator hooks, in the child's own process. The child
// reads its own config and inherits the parent's environment, so a hook declared
// either way applies here too; without this, a veto that holds on every
// in-process surface would leak through a forked subagent.
import {
  runBeforeToolHooks,
  runToolOutcomeHooks,
  toolHookRefusalText,
} from './tool-hooks.js';
// WS6 (#28) — the declared fault seam, read in the child's own process (the
// declaration arrives through the environment the parent handed it).
import { faultAt } from '../runtime/fault-injection.js';
// WS5 (#27) — the child's OWN partial resume. The model calls happen in THIS
// process, so a resume that only the parent could do would replay nothing: the
// child records its steps into its own store and replays the ones whose input is
// unchanged, exactly as the in-process loop does (`tools/tool-loop.ts`).
import {
  closeResume,
  openResume,
  resolveResumeRequest,
  stepDigest,
  type OpenResume,
  type ResumeOutcome,
  type StepReplay,
} from '../learning/step-checkpoint.js';
// Phase 4b/4c — the child's PERSISTENT SESSION STORE. Opened on the same gate as
// its resume ledger: a delegated run asked to resume snapshots its live thread at
// each iteration boundary, so a subagent process that dies mid-task leaves a
// conversation the orchestrator's next run can pick up (the parent already
// checkpoints task-level state; this adds the per-task conversation layer).
import {
  findResumableSessionFor,
  openSession,
  rehydrateThread,
  resolveSessionStore,
  type SessionStore,
} from '../learning/session-store.js';
// G1 — the verification gate, in the CHILD's own engine. `write_file`/`edit_file`
// are mutations (`edit-verification.ts`), so an in-process turn that writes one
// gets one bounded nudge before it can answer and reports the residual honestly.
// The forked child had no gate at all, so the SAME write inside a delegated run
// was never followed by "nothing observed the result, run a check" — measured by
// the parity harness as `modelCalls 3 vs 2` across surfaces
// (see docs/TOOL_TRUTHFULNESS_TRACKER.md). The gate is imported, not reimplemented,
// so the nudge text, the tool classification and the honesty flags cannot drift
// between the loop that runs in this process and the loop that runs in the parent's.
import {
  assessEditActivity,
  detectUnverifiedEditClaim,
  isMutationTool,
  isVerificationTool,
  verificationNudgeFor,
  type ToolCallEvidence,
} from './edit-verification.js';
// A3 — the provenance ledger's shape. Type-only, so it is erased at runtime and
// this process pulls in nothing new to record what its tools actually did.
import type { ExecutedAction } from '../findings/verdicts.js';

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
  /**
   * WS5 (#27) — replay this child's recorded steps whose input is unchanged
   * instead of paying for them again. `undefined` defers to the inherited
   * `NUVIRA_RESUME`, so a resumed parent run resumes its children too.
   */
  resume?: string | boolean;
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
  /**
   * WS5 (#27) — what this run's resume replayed, and what it saved. Present only
   * when a resume was asked for; reported to the parent on its own frame, because
   * the child is a separate process and that frame is its only channel.
   */
  resume?: ResumeOutcome;
  /**
   * G1 — this run MUTATED the workspace and nothing observed the result (the
   * bounded nudge was spent and the model still answered without verifying, or
   * the run hit its ceiling first). Set whether or not the nudge fired, exactly
   * as `ToolLoopResult.unverifiedEdit` is: honesty is not a function of
   * configuration, so a caller can never read an unverified edit as a checked one.
   */
  unverifiedEdit?: boolean;
  /**
   * G1/G2 — the answer ASSERTS a completed code change that no verification
   * backed (`detectUnverifiedEditClaim`). The child's own flag, carried across the
   * fork, so a delegated run whose summary claims "I fixed it" is recorded as
   * unverified rather than read as an observed result.
   */
  unverifiedEditClaim?: boolean;
  /**
   * A3 Part 2 — a BUILD command ran and FAILED this run, no later build
   * succeeded, and the answer still asserted the artifact came out good. The
   * child's own flag, carried across the fork like `unverifiedEditClaim`, so a
   * delegated build-debug run cannot report a success its own ledger contradicts.
   */
  unverifiedBuildClaim?: boolean;
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
 * P1 — the ambient project context (+ hand-off) a subagent inherits from its
 * working directory. Mirrors the loop engine exactly (`buildLoopProjectContext`)
 * and is best-effort: any failure returns '' so a context read can never break a
 * delegated run, and a clean/empty project adds no prompt weight beyond the
 * bounded snapshot. Lazy-imported so a plain (no-tools) completion does not pay
 * for the tree/git walk until it is actually useful.
 */
async function subagentContextBlock(cwd: string | undefined): Promise<string> {
  try {
    const { buildLoopProjectContext } = await import('./loop-project-context.js');
    return await buildLoopProjectContext(cwd ?? process.cwd());
  } catch {
    return '';
  }
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

  // WS2 (#24) — the optional session debug log for this child process.
  // Opened HERE, after the provider is constructed, so its header can name the
  // backend from the first line; `null` unless `NUVIRA_DEBUG_LOG` is set (the
  // parent's process env is inherited across the fork).
  const debugLog = sessionDebugLog({
    surface: 'subagent',
    goal: config.goal,
    backend: {
      engine: 'loop',
      provider: type,
      ...(model ? { model } : {}),
      transport: hasTools ? transport : 'none',
    },
  });
  debugLog?.event('turn.start', { tools: allowed.length, transport: hasTools ? transport : 'none' });

  // WS3 (#25) — the child's turn span. Started from the `traceparent` the parent
  // injected into this process's environment, so the child hangs off the tool
  // call that spawned it and the whole turn is ONE trace. With no `traceparent`
  // (a child started by hand, or the parent not tracing) this starts a trace of
  // its own — which is the honest outcome, not a fabricated parent id.
  const otelSpan = await startTurnSpan({
    surface: 'subagent',
    goal: config.goal,
    parent: parentContextFromEnv(),
  });
  /**
   * Finish the span tree and let the process go.
   *
   * The forked child is a ONE-SHOT process: unlike the dashboard or the
   * gateway, nothing else will use this provider after the answer is reported,
   * so shutting it down here is what stops a lingering exporter socket or batch
   * timer from keeping the child alive after it has said what it did.
   */
  let spansFinished = false;
  const finishSpans = async (outcome: { ok: boolean; message?: string }): Promise<void> => {
    if (!otelSpan || spansFinished) return;
    spansFinished = true;
    otelSpan.end(outcome);
    await flushSpans();
    await shutdownSpans();
  };

  /**
   * Write the child's debug log and announce where it landed.
   *
   * The path travels as a `progress` frame (the same channel `starting` and
   * `finding` use) because the child has no console of its own worth reading —
   * an unattended fork's stdout is easy to lose, and a log nobody can find is
   * not an attachable artifact. The parent ignores phases it does not know.
   */
  let debugLogFinished = false;
  const finishDebugLog = (detail: Record<string, unknown> = {}): void => {
    if (!debugLog || debugLogFinished) return;
    debugLogFinished = true;
    debugLog.event('turn.end', detail);
    const path = debugLog.write();
    if (path) send({ type: 'progress', phase: 'debug_log', path });
  };

  // WS5 (#27) — the child's own resume ledger, and the frame that reports what it
  // did with it. Opened before the loop (a record is read once, not per step) and
  // closed on every path that produces a result, so a child that ran is a child
  // whose steps the NEXT resume can replay — and a child that could not write the
  // record says so instead of reporting a resume that silently did nothing.
  const resumeRequest = resolveResumeRequest({ resume: config.resume });
  const resumeCwd = config.cwd ?? process.cwd();
  const resume: OpenResume | null = resumeRequest
    ? openResume({ goal: config.goal, cwd: resumeCwd, resume: resumeRequest })
    : null;
  const finishResume = (out: SubagentRuntimeResult): SubagentRuntimeResult => {
    if (!resume) return out;
    const outcome = closeResume(resume, { goal: config.goal, cwd: resumeCwd });
    send({ type: 'progress', phase: 'resume', resume: outcome });
    return { ...out, resume: outcome };
  };
  // Phase 4b/4c — the child's session store. DEFAULT ON (like the parent), so a
  // subagent that dies mid-task leaves a conversation its re-run can pick up;
  // `NUVIRA_SESSION_STORE=0` (or the config key) turns it off.
  const sessionStoreOn = resolveSessionStore();
  const session: SessionStore | null = sessionStoreOn
    ? openSession({ goal: config.goal, cwd: resumeCwd })
    : null;

  // A backend that cannot be reached is a refusal, not an empty result.
  const available = await provider.isAvailable().catch(() => false);
  if (!available) {
    // WS2 — a REFUSAL is exactly the run a bug report is about, so the log is
    // still written (with the backend already in its header) before throwing.
    finishDebugLog({ refused: 'provider_not_reachable', provider: type });
    // WS3 — and the span is shipped red. A child whose provider was unreachable
    // is the shape an operator most needs to see in a trace, not an absence.
    const refused = `Provider '${type}' is not reachable.`;
    await finishSpans({ ok: false, message: refused });
    throw new SubagentRefusalError(
      'not_configured',
      `Provider '${type}' is not reachable. Configure it (or start its backend, e.g. \`ollama serve\`) and re-run.`,
    );
  }

  // ── Tool loop (native protocol, or the shared JSON fallback) ──────────────
  //
  // WS6 (#28) — EVERYTHING below runs under one guard, because a call that throws
  // mid-run used to leave NOTHING behind: the unreachable-provider refusal above
  // writes its debug log and ships a red span before it throws, while a provider
  // that failed INSIDE a call skipped both. Measured by the provider-fault parity
  // row: the child reported `written: false` and `exported: false`, so a crashed
  // subagent produced no attachable log and no trace at all — the two artifacts
  // WS2 and WS3 exist to guarantee, missing on exactly the run an operator most
  // needs them for.
  /**
   * Leave the same evidence a refusal leaves, then rethrow.
   *
   * WS6 (#28) — a provider that failed INSIDE a call used to leave NOTHING
   * behind: the unreachable-provider refusal above writes its debug log and ships
   * a red span before it throws, while a call that threw skipped both. Measured by
   * the provider-fault parity row: the child reported `written: false` and
   * `exported: false`, so a crashed subagent produced no attachable log and no
   * trace at all — the two artifacts WS2 and WS3 exist to guarantee, missing on
   * exactly the run an operator most needs them for. The error is rethrown
   * unchanged, so the parent still receives the honest failure frame.
   */
  const failWithEvidence = async (err: unknown): Promise<never> => {
    const message = err instanceof Error ? err.message : String(err);
    finishDebugLog({ failed: message, provider: type });
    await finishSpans({ ok: false, message });
    throw err;
  };

  if (hasTools) {
    const out = await runToolLoop(config, allowed, provider, type, transport, {
      send,
      runTool: hooks.runTool,
      maxLlmCalls,
      maxIterations,
      model,
      debug: debugLog,
      otel: otelSpan,
      resume: resume?.ledger ?? null,
      session,
      sessionResume: sessionStoreOn,
    }).catch(failWithEvidence);
    finishDebugLog({
      llmCalls: out.llmCalls,
      toolCalls: out.toolCalls,
      truncated: out.truncated,
      transport: out.transport,
    });
    otelSpan?.attr('nuvira.llmCalls', out.llmCalls);
    otelSpan?.attr('nuvira.toolCalls', out.toolCalls);
    await finishSpans({
      // A run that hit its ceiling before the model stopped is not a failure —
      // it is a bounded run, and the loop reports that fact rather than an error.
      ok: true,
      ...(out.truncated ? { message: 'the subagent reached its ceiling' } : {}),
    });
    return finishResume(out);
  }

  // ── Plain completion (no tools) ───────────────────────────────────────────
  const ctxBlock = await subagentContextBlock(config.cwd);
  const prompt = [
    buildSystemPrompt(config, []),
    ...(ctxBlock ? ['', `[Project context]\n${ctxBlock}`] : []),
    '',
    `Task: ${config.goal}`,
  ].join('\n');
  const text = await provider.generate(prompt, modelOption(model)).catch(failWithEvidence);
  finishDebugLog({ llmCalls: 1, toolCalls: 0, transport: 'none' });
  await finishSpans({ ok: true });
  return finishResume({
    result: text.trim(),
    llmCalls: 1,
    toolCalls: 0,
    provider: type,
    ...(model ? { model } : {}),
    transport: 'none',
    truncated: false,
  });
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
  /** WS2 — the child's session debug log, when logging is on (else null). */
  debug?: SessionDebugLog | null;
  /**
   * WS3 — the child's turn span, when span export is on (else null).
   *
   * Made ACTIVE around each tool's execution exactly as the in-process loop
   * does, so a tool that in turn needs a trace parent (a nested fork) does not
   * have to know how the context got there.
   */
  otel?: SpanHandle | null;
  /**
   * WS5 (#27) — the resume ledger, when this child was asked to resume.
   *
   * The child's messages are its own (a system prompt + the goal + tool results),
   * so its steps are keyed and hashed by the same rule the shared loop uses: the
   * KEY is the step's position and the DIGEST is the whole input, which is why a
   * resume that changes the goal replays nothing.
   */
  resume?: StepReplay | null;
  /**
   * Phase 4b/4c — the child's session store, when it was asked to resume. The
   * thread is snapshotted per iteration so a child process that dies mid-task
   * leaves a resumable conversation (see `learning/session-store.ts`).
   */
  session?: SessionStore | null;
  /** Phase 4c — whether an explicit resume was requested (rehydration gate). */
  sessionResume?: boolean;
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

  // P1 — the same ambient project context the chat/execute loops inject, so a
  // delegated run is not context-blind. `buildLoopProjectContext` also carries
  // the durable hand-off block, so a subagent continues unfinished work in its
  // working directory instead of rediscovering it. Best-effort: '' adds nothing.
  const ctxBlock = await subagentContextBlock(config.cwd);
  const head: ToolMessage[] = [
    { role: 'system', content: buildSystemPrompt(config, allowed, transport) },
    ...(ctxBlock ? [{ role: 'user' as const, content: `[Project context]\n${ctxBlock}` }] : []),
  ];
  let messages: ToolMessage[] = [...head, { role: 'user', content: config.goal }];

  // Phase 4c — rehydrate a conversation a DEAD child left OPEN (only on an
  // explicit resume, and only for the same task). The fresh head replaces the
  // stored one; the child's prior work stays in the thread, so it is not re-run.
  if (loop.sessionResume) {
    try {
      const prior = findResumableSessionFor(config.goal, config.cwd ?? process.cwd());
      if (prior) messages = rehydrateThread(head, prior);
    } catch {
      // Best-effort — a rehydration failure is a cold start, not a broken run.
    }
  }

  const model = loop.model;
  const base = { provider: type, ...(model ? { model } : {}), transport } as const;

  let llmCalls = 0;
  let toolCalls = 0;
  // G1 — the accumulators the verification gate reads, the same three the
  // in-process loop keeps (`successfulToolCalls` / `mutatedPaths` /
  // `verificationEvidence`). Only calls that actually RAN SUCCEEDED are recorded:
  // a refusal is neither a mutation nor a verification.
  const successfulToolCalls: string[] = [];
  const mutatedPaths: string[] = [];
  const verificationEvidence: ToolCallEvidence[] = [];
  // A3 — the actions this run really performed, shared with the tools so a
  // `finding`'s evidence can be checked for provenance, and read at the end for
  // the build-honesty flag (see `finish`).
  const executedActions: ExecutedAction[] = [];
  // Bounded exactly once, like the in-process gate (`verificationNudges < 1`).
  let verificationNudges = 0;
  // The iteration ceiling is the loop's `loop.maxIterations` plus one for each
  // nudge spent: the ceiling bounds the WORK, and a nudge the loop itself asked
  // for must not eat the budget the goal was owed (in-process does the same by
  // raising its step limit).
  let iterationLimit = loop.maxIterations;
  // One config read per loop rather than per call: the hooks are declared in the
  // child's own configuration (this process's, not the parent's), and the
  // declarations are resolved through the same manager the tools use.
  const hookConfigManager = new ConfigManager();
  // The in-process loop's refusal classifier is the authority for "this call did
  // NOT run": `write_file` refusing a path outside the workspace returns
  // "… escapes the workspace … — denied" with NO `Error:` prefix, so a bare prefix
  // check would count a refused write as a mutation and nudge the child to verify
  // a file that was never written. Imported lazily for the same reason
  // `extractFallbackToolCalls` is: `tool-loop.ts` pulls in the registry and the
  // event bus.
  const { classifyToolRefusal, detectFailedBuildSuccessClaim } = await import('./tool-loop.js');
  // A3 Part 2 — the build-honesty detector is the in-process loop's own (imported,
  // never reimplemented), so a delegated run that watched a build FAIL and then
  // reported success is flagged across the fork exactly as an in-process turn is.

  /**
   * Finish the loop, annotating the result with the honesty flags.
   *
   * Computed from the SAME accumulators the gate reads, so the nudge and the flag
   * can never disagree — and computed on EVERY exit (including a ceiling), since a
   * run cut short with a mutation unobserved is exactly the one that needs the
   * flag. Nothing here depends on whether the nudge fired.
   */
  const finish = (result: string, truncated: boolean): SubagentRuntimeResult => {
    const activity = assessEditActivity(successfulToolCalls, verificationEvidence, mutatedPaths);
    const out: SubagentRuntimeResult = { result, llmCalls, toolCalls, ...base, truncated };
    if (activity.needsVerification) out.unverifiedEdit = true;
    if (detectUnverifiedEditClaim(result, activity.mutations, activity.verifications)) {
      out.unverifiedEditClaim = true;
    }
    // A3 Part 2 — a build that failed while the answer claims success.
    if (detectFailedBuildSuccessClaim(result, executedActions)) {
      out.unverifiedBuildClaim = true;
    }
    // Phase 4b/4c — the child reached an end, so its session transcript is
    // HISTORY: close it so it is not rehydrated as if work remained. Best-effort.
    try {
      loop.session?.finish();
    } catch {
      // Best-effort.
    }
    return out;
  };

  for (let iteration = 0; iteration < iterationLimit; iteration += 1) {
    if (llmCalls >= loop.maxLlmCalls) {
      return finish('Subagent stopped: reached its model-call ceiling before finishing.', true);
    }

    // WS5 (#27) — a resumed child replays this step when its input is unchanged.
    // The digest is over the WHOLE input (the thread AND the schema), so a step
    // whose tool result or tool list differs MISSES and is paid for again — the
    // property that makes a replay an answer to the same question rather than to
    // the same step number.
    const stepKey = `model:${iteration + 1}`;
    const stepHash = loop.resume ? stepDigest(messages, schemas) : '';
    const replayed = loop.resume?.replay(stepKey, stepHash) ?? null;
    let response: ToolCallResponse;
    if (replayed) {
      response = replayed;
      // A REPLAYED step is not a model call, so `llmCalls` is not incremented —
      // the count the parent records and the debug log carry is the number of
      // calls this run actually made (see `ResumeOutcome.modelCalls`).
      loop.send({ type: 'progress', phase: 'resume_step', step: stepKey });
      loop.send({ type: 'progress', phase: 'thinking', iteration: iteration + 1, llmCalls, toolCalls });
    } else {
      // WS6 (#28) — the ATTEMPT is counted BEFORE it is made, and that ordering is
      // the fix for a measured dishonesty: a model call that THREW used to leave
      // `llmCalls` unchanged, so a child whose provider failed every call reported
      // ZERO model calls — as if it never reached a model at all. The in-process
      // surfaces' counts come from the wire and already include failed attempts, so
      // this is also what makes the child's count comparable across the fork; and
      // the frame that announces the call now carries the incremented count, which
      // is the only channel the parent has (the child dies before a result frame).
      llmCalls += 1;
      loop.send({ type: 'progress', phase: 'thinking', iteration: iteration + 1, llmCalls, toolCalls });
      response = await callModel(provider, transport, messages, schemas, model);
      loop.resume?.record(stepKey, stepHash, response);
    }

    if (response.toolCalls.length === 0) {
      // ── G1 — VERIFICATION GATE ────────────────────────────────────────────
      // The model is about to answer, but this run MUTATED the workspace and
      // nothing observed the result: spend ONE bounded nudge asking for the check
      // (the same nudge the in-process loop sends, naming THIS workspace's
      // strongest real command). A nudge, not a hard block — a task with no
      // runnable check must still finish, and the residual `unverifiedEdit` flag
      // carries the honesty for that case.
      if (
        verificationNudges < 1 &&
        assessEditActivity(successfulToolCalls, verificationEvidence, mutatedPaths).needsVerification
      ) {
        verificationNudges += 1;
        iterationLimit += 1;
        const mutations = successfulToolCalls.filter(isMutationTool);
        // A frame, because the child's stdout is easy to lose and the parent is
        // its only channel; the GATE is reported for the same reason the
        // in-process loop records a `gate` trace event — a run that asked for a
        // check and one that never needed to are otherwise indistinguishable.
        loop.send({
          type: 'progress',
          phase: 'gate',
          gate: 'verification',
          summary:
            'the subagent mutated the workspace and nothing observed the result — one bounded nudge to verify',
          mutations,
          llmCalls,
          toolCalls,
        });
        loop.debug?.event('gate.verification', { mutations });
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: verificationNudgeFor(config.cwd ?? process.cwd(), mutatedPaths),
        });
        continue;
      }
      return finish(response.content.trim(), false);
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
        loop.debug?.event('tool.refused', { tool: call.name });
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
      loop.debug?.event('tool.start', { tool: call.name });
      const toolStartedAt = Date.now();
      // WS4 (#26) — the `before` hooks. A veto stops the call here, so a hook
      // that holds on the CLI holds for a forked subagent too — the child is a
      // separate PROCESS, and a policy that stopped at the process boundary would
      // be worse than no policy, because it would look enforced.
      const beforeHooks = await runBeforeToolHooks({
        tool: call.name,
        args: call.arguments,
        callId: call.id,
        surface: 'subagent',
        ...(config.cwd ? { cwd: config.cwd } : {}),
        configManager: hookConfigManager,
      });
      for (const problem of beforeHooks.problems) {
        // A failed hook is reported to the parent on its own frame rather than
        // swallowed: the seam fails open, so a broken policy would otherwise be
        // indistinguishable from one that approved every call.
        loop.send({ type: 'progress', phase: 'hook_problem', problem });
      }
      if (beforeHooks.denied) {
        const refusal = toolHookRefusalText(beforeHooks);
        loop.debug?.event('tool.refused', { tool: call.name, by: 'tool-hook' });
        // The same pair of frames a call that ran and failed sends, so the parent
        // records the attempt and its outcome exactly as it does everywhere else.
        loop.send({
          type: 'progress',
          phase: 'tool_result',
          tool: call.name,
          ok: false,
          llmCalls,
          toolCalls,
        });
        messages.push({ role: 'tool', content: refusal, toolCallId: call.id });
        continue;
      }
      // WS3 (#25) — the call as a child span of the child's turn, created where
      // the call actually RUNS (the allow-list check above is a refusal, not a
      // call). Same name shape as every other surface's tool span, so the tree
      // an operator reads is the same tree wherever the tool ran.
      const toolSpan = loop.otel?.child(`${TOOL_SPAN_PREFIX}${call.name}`, { 'nuvira.tool': call.name }) ?? null;
      try {
        const output = await withSpanActive(toolSpan, () =>
          executeTool(config, call.name, call.arguments, loop.runTool, (event, data) => {
            // WS1 — a finding the child recorded, shipped on its own frame (the
            // same way its tool lifecycle crosses IPC). The parent records it, so a
            // subagent run reports the verdicts it produced like every other
            // surface instead of leaving them inside the child's process.
            if (event === FINDING_EVENT) {
              loop.send({ type: 'progress', phase: 'finding', finding: data, llmCalls, toolCalls });
              // WS2 — and into the child's own debug log, so a bug report from a
              // forked run carries the verdicts it recorded.
              const finding = data as { verdict?: string; claim?: string };
              loop.debug?.event('finding', `${finding?.verdict ?? '?'} ${finding?.claim ?? ''}`);
            }
          }, executedActions),
        );
        toolCalls += 1;
        // The same convention the main loop and the tool registry use: a tool
        // signals failure by returning text that starts with `Error:`.
        const ok = !output.startsWith('Error:');
        // HONEST ACCOUNTING for the gate. A DECLINED call is not a success
        // whatever prefix it used, so it may not count as a mutation (or a
        // verification) — the same rule the in-process loop applies, and the
        // reason `classifyToolRefusal` is consulted here rather than the prefix
        // alone. `ok` stays the parent-facing outcome (unchanged wire shape).
        const ranOk = ok && classifyToolRefusal(output) === null;
        // A3 — the provenance ledger (see `finish`). A REFUSED call never
        // performed its command, so it is not evidence that a citation is real;
        // an executed-but-failed call IS.
        if (classifyToolRefusal(output) === null) {
          const command = (call.arguments as { command?: unknown } | undefined)?.command;
          const path = (call.arguments as { path?: unknown; file_path?: unknown; file?: unknown } | undefined);
          const p = path?.path ?? path?.file_path ?? path?.file;
          const cmd = typeof command === 'string' && command.trim() ? command.trim() : undefined;
          const target = typeof p === 'string' && p.trim() ? p.trim() : undefined;
          if (cmd !== undefined || target !== undefined) {
            executedActions.push({ tool: call.name, ok, ...(cmd ? { command: cmd } : {}), ...(target ? { path: target } : {}) });
          }
        }
        if (ranOk) {
          successfulToolCalls.push(call.name);
          if (isMutationTool(call.name)) {
            const a = call.arguments as { path?: unknown; file_path?: unknown; file?: unknown } | undefined;
            const p = a?.path ?? a?.file_path ?? a?.file;
            if (typeof p === 'string' && p) mutatedPaths.push(p);
          } else if (isVerificationTool(call.name)) {
            verificationEvidence.push({ tool: call.name, args: call.arguments, result: output });
          }
        }
        loop.debug?.event('tool.end', { tool: call.name, ok });
        loop.send({
          type: 'progress',
          phase: 'tool_result',
          tool: call.name,
          ok,
          llmCalls,
          toolCalls,
        });
        toolSpan?.attr('nuvira.ok', ok);
        toolSpan?.end({ ok });
        // WS4 (#26) — `after` for a call that succeeded, `failed` for one that
        // did not. Exactly one of the two, because a hook that counts failures
        // must not be told about a success.
        const outcomeHooks = await runToolOutcomeHooks({
          tool: call.name,
          args: call.arguments,
          callId: call.id,
          surface: 'subagent',
          ...(config.cwd ? { cwd: config.cwd } : {}),
          configManager: hookConfigManager,
          ok,
          result: output,
          durationMs: Date.now() - toolStartedAt,
        });
        for (const problem of outcomeHooks.problems) {
          loop.send({ type: 'progress', phase: 'hook_problem', problem });
        }
        // P3 — fence UNTRUSTED external content as DATA, exactly as the
        // in-process loop does (imported helper, never re-worded). The raw
        // `output` still feeds the provenance ledger and the outcome hooks
        // above; only what re-enters the MODEL's context is fenced.
        messages.push({ role: 'tool', content: fenceUntrustedToolOutput(call.name, output), toolCallId: call.id });
      } catch (err) {
        // The injected `runTool` override can throw where the registry's own
        // executor would have returned an `Error:` result — both are a failure
        // the `failed` phase is owed.
        const message = err instanceof Error ? err.message : String(err);
        const outcomeHooks = await runToolOutcomeHooks({
          tool: call.name,
          args: call.arguments,
          callId: call.id,
          surface: 'subagent',
          ...(config.cwd ? { cwd: config.cwd } : {}),
          configManager: hookConfigManager,
          ok: false,
          error: message,
          durationMs: Date.now() - toolStartedAt,
        });
        for (const problem of outcomeHooks.problems) {
          loop.send({ type: 'progress', phase: 'hook_problem', problem });
        }
        throw err;
      } finally {
        // A safety net, not a second report: an injected `runTool` can throw,
        // and a span left open would hang off the turn span for ever.
        toolSpan?.end({ ok: false, message: 'tool outcome was never reported' });
      }
    }

    // Phase 4c — STEP BOUNDARY. This iteration's tool results are now IN the
    // thread, so a child process that dies on the NEXT iteration leaves a record
    // of everything through this one. Best-effort: a snapshot write can never
    // break the child (a no-op when the child was not asked to resume).
    if (loop.session) {
      try {
        loop.session.save(messages, {
          steps: iteration + 1,
          successfulTools: successfulToolCalls,
          mutatedPaths,
        });
      } catch {
        // Best-effort.
      }
    }
  }

  return finish('Subagent stopped: reached its iteration ceiling before finishing.', true);
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
  executedActions?: ExecutedAction[],
): Promise<string> {
  // WS6 (#28) — a DECLARED fault, injected before every path (including an
  // injected `runTool`), so a fault declared for a turn reaches a FORKED CHILD the
  // same way it reaches the in-process loop. The child inherits the declaration
  // through its environment, which is why one declaration covers all five
  // surfaces and the parity row can assert it across the process boundary.
  const injected = faultAt('tool', name);
  if (injected) return `Error: ${injected.message}`;
  if (override) return override(name, args);
  const tool = getTool(name);
  if (!tool) return `Error: unknown tool '${name}'.`;
  const ctx: ToolContext = {
    configManager: new ConfigManager(),
    cwd: config.cwd ?? process.cwd(),
    // A3 — the provenance ledger (see `finish`).
    executedActions,
    // A tool that reports through the bus (the finding tool emits
    // `finding:recorded`) needs a sink on this side of the fork; the caller
    // forwards it as a frame. Absent for a direct/test invocation, exactly like
    // the other optional context fields.
    ...(emit ? { emit } : {}),
    // A3 — the provenance ledger (see `finish`). Absent for a direct/test call.
    ...(executedActions ? { executedActions } : {}),
  };
  try {
    const out = await tool.run(args as never, ctx);
    return typeof out === 'string' ? out : JSON.stringify(out);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
