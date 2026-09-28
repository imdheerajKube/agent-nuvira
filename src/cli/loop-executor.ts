/**
 * Loop executor (`src/cli/loop-executor.ts`) — AGENTIC_CAPABILITY_ASSESSMENT
 * Addendum v4 Phase 1.1: "Make `runToolLoop` the executor behind coding-intent
 * dispatch (…extend to `nuvira execute` default path behind
 * `--engine loop|pipeline`, default `pipeline` until Phase 0 numbers land)."
 *
 * `nuvira execute` currently goes straight to the Orchestrator. This module
 * is the LOOP arm: one agentic turn over the same `runToolLoop` the chat
 * engine uses, with the ambient project-context injection + tiered tool
 * exposure the chat path already has. The orchestrator stays the DEFAULT
 * until the Phase 0 eval numbers land; this arm ships complete so
 * `--engine loop` is a real path, not a stub.
 *
 * Engine selection (Phase 2) happens in the CALLER (`execute` dispatch):
 * `resolveEngine()` decides loop vs pipeline from the routed provider tier;
 * this module is deliberately single-responsibility (it IS the loop arm).
 *
 * Telemetry parity with the eval framework: the executor returns wall-clock
 * time, per-tool call counts, errored-tool names (captured from the
 * `tool:called` events, not guessed from content), the bounded flag, and the
 * generation-failed flag so Phase 0 can compare arms on identical metrics.
 *
 * Phase 1.3 guardrail note (v4 risk table): file ops stay deny-first /
 * confirm-gated (registry tools keep their own gates) and the orchestrator
 * remains available for CI/publish — enterprise semantics are not weakened.
 */

import { ConfigManager } from '../config/manager.js';
import { resolveProvider } from './router.js';
import { resolveRoute, servedRouteFrom, type ServedRoute } from '../inference/route-resolver.js';
import { noteServedRoute } from '../tools/loop-route-feed.js';
import { getAutoRouter, isAutoModel, isAutoProvider, governanceVerdict } from '../learning/auto-router.js';
import { buildDeepFailoverPool, createFailoverExclusionFilter } from '../learning/resilient-call.js';
import { getModelRegistry } from '../learning/model-registry.js';
import { recordActionFailure, type FailureSessionState } from '../learning/failure-bookkeeping.js';
import {
  recordRegistrySuccess,
  getProviderFallback,
  classifyFallbackError,
  isRetryableError,
} from '../learning/provider-fallback.js';
import { resolveThreadBudgetChars } from '../learning/context-budget.js';
import { buildLoopProjectContext } from '../tools/loop-project-context.js';
import { deliverablesNamedIn, recordStepHandoff } from '../agents/step-handoff.js';
import { getLoopExposureMode } from '../tools/toolsets.js';
import { resolveModelHarnessProfile } from '../learning/model-harness.js';
import { hasCredentials } from '../learning/model-selection.js';
import { resolveEngine } from '../learning/engine-router.js';
import { logger } from '../utils/logger.js';
import {
  beginTrace,
  endTrace,
  recordStep,
  recordTraceEvent,
  buildTraceOutcome,
} from '../learning/reasoning-trace.js';
import type { LoopTraceEvent } from '../tools/tool-loop.js';
import { estimateTokens } from '../learning/cost-tracker.js';
import { createHash } from 'node:crypto';
import {
  toUserFacingGenerationError,
  detectAnswerQualityFailure,
  answerQualityError,
  type AnswerQualityKind,
} from '../inference/tool-call-utils.js';
import type { InferenceProvider, ToolMessage } from '../inference/interface.js';
import type { ToolJsonSchema } from '../tools/registry.js';

/**
 * Serialize the loop's thread the way the chat transport does, so the SAME
 * layer splitter (and therefore the same per-layer digests) applies to both
 * (G18). Without the role markers a loop prompt lands in the "unknown shape"
 * branch and the stable layer is the whole thread — which grows every step, so
 * the one question the layers exist to answer (did the system layer stay byte-
 * stable?) could never be answered for an `execute` run.
 */
function serializeLoopThread(messages: readonly ToolMessage[]): string {
  const marker: Record<string, string> = {
    system: '[System]',
    user: '[User]',
    assistant: '[Assistant]',
    tool: '[Tool result]',
  };
  return messages
    .map((m) => `${marker[m.role] ?? `[${m.role}]`}\n${m.content ?? ''}`)
    .join('\n');
}

/** sha256 hex prefix — the same digest shape the store uses. */
function digestOf(text: string): string {
  try {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
  } catch {
    return String(text.length);
  }
}

/** One bounded line, for the verbose console echo of a tool result. */
function previewLine(text: string, max = 200): string {
  const first = (text || '').split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const flat = first.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}\u2026` : flat;
}

/** The loop executor's result — every metric the Phase 0 eval needs. */
export interface LoopExecutorResult {
  /** Final assistant content (the loop's end-turn answer). */
  content: string;
  /** True when generation failed entirely (no content, no tools ran). */
  generationFailed: boolean;
  /** True when the loop hit its step bound before an end turn. */
  bounded: boolean;
  /** Tool names executed, in order (repair-count proxy). */
  toolCalls: string[];
  /** Tool names that returned an error result (captured from tool:called). */
  erroredTools: string[];
  /**
   * Per-call tool outcomes, in call order — WHICH call succeeded or failed, not
   * a name list beside a separate error set.
   *
   * Captured from the loop's own `tool`/`refusal` trace events (the ones that
   * carry `ok`), so pairing is unambiguous even when a tool runs more than once
   * — a call that failed and later succeeded used to be indistinguishable from
   * one that failed once. This is the `execute` arm's answer to the chat
   * surfaces' `onToolCall` lifecycle (`tool-call-lifecycle@cli-execute`).
   */
  toolOutcomes: Array<{ tool: string; ok: boolean }>;
  /** Wall-clock duration (ms). */
  durationMs: number;
  /** The provider id used (telemetry echo). */
  provider: string;
  /** The model id used (telemetry echo). */
  model: string;
  /** The engine decision explanation (Phase 2 audit trail). */
  engineExplanation: string;
  /**
   * G18 — the trace id this run was recorded under (`nuvira trace show <id>`),
   * echoed so a live run says where its own evidence lives.
   */
  traceId?: string;
  /** G18 — refusals recorded this turn (declined calls), for the CLI summary. */
  refusals?: number;
  /**
   * Stage 2 — the turn's own behaviour, as counts (see learning/run-trace.ts).
   * Carried because "did the agent do the task WITHOUT stopping to ask" is a
   * property of the run that no hidden test can observe: a task can pass every
   * test and still have interrupted the user four times.
   */
  runTrace?: import('../learning/run-trace.js').RunTraceSnapshot;
  /** G18 — gate decisions recorded this turn (nudges spent, bounds reached). */
  gateDecisions?: number;
  /**
   * R2 — the tool transport that served the run (`native` / `json` / `none`),
   * reported by the loop's own model-call seam. Absent when no model call was
   * made at all (a routing failure), which is the honest answer there.
   */
  transport?: 'native' | 'json' | 'none';
}

/** Options for runLoopExecutor — mirrors the pipeline arm's surface. */
export interface LoopExecutorOptions {
  /** Explicit provider id (auto-routed when omitted or 'auto'). */
  provider?: string;
  /** Explicit model (router-resolved when omitted or 'auto'). */
  model?: string;
  /** Stream content tokens live (CLI prints; eval ignores). */
  onToken?: (token: string) => void;
  /** External cancellation (execute's Ctrl+C). */
  signal?: AbortSignal;
  /** Skip the ambient [Project context] injection (tests). */
  skipProjectContext?: boolean;
  /**
   * Phase 3.2 — skip the loop-side skill match hint (tests / hint-free
   * comparisons). Default false: the hint is part of the loop arm's standard
   * context, mirroring the pipeline arm's skillGuidance injection.
   */
  skipSkillHint?: boolean;
  /** Override the step bound (default 16 — the loop's own default). */
  maxSteps?: number;
  /** Quiet mode: no progress logging (eval arms). */
  quiet?: boolean;
  /**
   * G18 — echo each tool RESULT (first line, bounded) under the call line.
   * Previously even `-v` printed only the call (`⚙ edit_file({path: …})`) and
   * never what came back, so a live run could not distinguish "the gate applied
   * the edit autonomously" from "the model passed confirm:true" — the exact
   * ambiguity the confirmation-gate audit had to resolve by reading code.
   */
  verbose?: boolean;
}

/** The system prompt for the execute-loop arm (verification-first). */
function buildExecuteLoopSystemPrompt(toolContractJson: string): string {
  return [
    'You are Nuvira, executing a coding task end-to-end. You have the project\'s tool surface: read files, edit/write files, search code, run terminal commands (typecheck/tests/build), plan with plan_todo, and delegate subtasks.',
    'Work autonomously: understand the code first (read_file/code_search), make the change (edit_file/write_file), then VERIFY by running typecheck/tests with run_terminal. Fix what fails and re-verify.',
    'When the task is complete, summarize what changed and why. End with suggest_followups listing sensible next steps.',
    '',
    'Some tools live in domain toolsets outside your visible list — if a tool you need is "unknown", call tool_search with {"action":"load","toolset":"<name>"} and its tools become callable immediately.',
    '',
    toolContractJson,
  ].join('\n');
}

/**
 * Run one coding goal through the single agentic loop (the v4 universal
 * engine). Resolves the route the same way chat does (explicit override or
 * AutoModelRouter candidate walk), injects the ambient project context, and
 * runs `runToolLoop` with tiered exposure per config. Never throws — a
 * failure returns a result with generationFailed=true (eval arms count it as
 * a loss; the CLI prints the message).
 */
export async function runLoopExecutor(
  goal: string,
  configManager: ConfigManager,
  opts: LoopExecutorOptions = {},
): Promise<LoopExecutorResult> {
  const startedAt = Date.now();

  // ── G18 — THE LOOP LEAVES A TRACE ────────────────────────────────────────
  // Recorded from the FIRST line of the run (before routing) on purpose: a run
  // that dies in routing is exactly the one a reader needs to see, and a trace
  // that only exists for successful runs cannot explain a failure. `source:
  // 'loop'` distinguishes these from pipeline ('orchestrator') and 'chat'
  // traces in `nuvira trace list` — the old gap was that an `execute` run
  // wrote NOTHING here, so the engine that runs by default was the one
  // engine with no evidence trail.
  const traceId = beginTrace({ goal, source: 'loop' });
  /** Refusals/gates recorded this turn — reported in the CLI summary. */
  const recorded = { refusals: 0, gateDecisions: 0 };
  /** Per-call tool outcomes, in call order (see LoopExecutorResult.toolOutcomes). */
  const toolOutcomes: Array<{ tool: string; ok: boolean }> = [];
  /**
   * G18 — one sink for the loop's non-LLM facts: persisted to the trace store,
   * and (only under `-v`) echoed to the console so a live run is readable
   * without opening the JSON. Timestamps/ordering are the store's job.
   */
  const onTraceEvent = (event: LoopTraceEvent): void => {
    recordTraceEvent(traceId, event);
    if (event.kind === 'refusal') recorded.refusals += 1;
    if (event.kind === 'gate') recorded.gateDecisions += 1;
    // One event per executed call, so this is the call-ordered per-call outcome
    // (a refusal event is a call that ran and did not succeed). `ok` is set on
    // both; fall back to the kind only if a future emitter omits it.
    if ((event.kind === 'tool' || event.kind === 'refusal') && event.tool) {
      toolOutcomes.push({ tool: event.tool, ok: event.ok ?? event.kind === 'tool' });
    }
    if (!opts.quiet && opts.verbose && (event.kind === 'tool' || event.kind === 'refusal')) {
      logger.info(`   ${event.ok ? '↳' : '⛔'} ${event.tool}: ${previewLine(event.result ?? event.summary)}`);
    }
  };

  // ── Route: explicit provider/model wins; otherwise the AutoModelRouter ──
  let providerType = 'auto';
  let model = 'default';
  let provider: InferenceProvider | null = null;
  /**
   * The route ACTUALLY serving this turn, kept current through every failover
   * and handed to the loop (which re-reads it before each model call) so the
   * model can answer about itself from a measured fact instead of a guess.
   */
  let servedRoute: ServedRoute | null = null;

  // ── Mid-turn failover candidate pool ────────────────────────────────────
  // The SAME deep chain the orchestrator/chat walk. Before this the loop only
  // used the chain to pick its STARTING provider: a 429 on the second step
  // killed the whole turn (observed live on gemini free tier) and the failure
  // was never recorded, so the next run repeated the same pick. callModel now
  // walks this pool and writes every failure through the shared bookkeeping.
  const candidatePairs: Array<{ provider: string; model: string }> = [];
  const seenCandidate = new Set<string>();
  const pushCandidate = (prov: string, mdl?: string): void => {
    if (!prov) return;
    const m = mdl && mdl !== 'default' ? mdl : 'default';
    const key = `${prov}|${m}`;
    if (seenCandidate.has(key)) return;
    seenCandidate.add(key);
    candidatePairs.push({ provider: prov, model: m });
  };
  /**
   * True when the caller explicitly pinned a provider (`--provider X`). A pin
   * narrows WHICH failures justify leaving the requested provider (see the
   * retryable gate in `callModel`); it never disables failover entirely.
   */
  const pinnedRun = Boolean(opts.provider && !isAutoProvider(opts.provider));
  /**
   * The pinned run's config-declared fallback chain, derived LAZILY on the
   * first failure — never at route time. Deriving it eagerly made every pinned
   * run pay for a provider ranking even when nothing failed (measured as a real
   * latency regression on the execute-dispatch path), and chat's non-auto path
   * derives the same chain the same lazy way, inside its failure branch.
   */
  let pinnedFallbacks: Array<{ provider: string; model: string }> | null = null;
  const resolvePinnedFallbacks = (): Array<{ provider: string; model: string }> => {
    if (pinnedFallbacks) return pinnedFallbacks;
    const out: Array<{ provider: string; model: string }> = [];
    try {
      const chain = getProviderFallback(configManager, configManager.getAll().fallback)
        .getFallbackChain(providerType);
      // Only providers the user can actually CALL. An explicit `fallback.
      // providers` entry with no key (e.g. a placeholder NIM) is not filtered
      // out by the chain itself, so it used to cost a full connection timeout
      // before the next fallback was tried — measured live at ~25s against an
      // unauthenticated endpoint. This is the same credential gate the router's
      // own candidate set applies (`hasCredentials`).
      const fbTypes = chain
        .filter((t) => t !== providerType && hasCredentials(configManager, t))
        // ADMIN POLICY: a pinned run must not fall back to a provider the
        // governance policy rules out (allow/deny lists, and the PII privacy
        // gate for a task that matches a configured PII pattern). This path
        // bypasses `autoRouter.resolve`, where the policy is otherwise
        // enforced, so it has to apply the same verdict itself. No policy
        // configured → every verdict is permissive and nothing changes.
        .filter((t) => {
          const verdict = governanceVerdict(configManager, t, { taskText: goal });
          if (!verdict.allowed) {
            logger.warn(`   ⚠️ 🔒 ${t} skipped — ${verdict.reason}`);
          }
          return verdict.allowed;
        });
      // SAME exclusion predicate the auto path applies (session/model
      // cooldowns + cross-pipeline memory + registry per-ENTRY usability): a
      // registry-parked or quarantined fallback is ordered LAST — never
      // dropped. The PINNED provider itself is never filtered: the user asked
      // for it explicitly, and a spot-check may be about to re-admit it.
      let ordered = fbTypes;
      try {
        const isExcluded = createFailoverExclusionFilter();
        ordered = [
          ...fbTypes.filter((t) => !isExcluded(t)),
          ...fbTypes.filter((t) => isExcluded(t)),
        ];
      } catch {
        // Exclusion is an optimization — never cost us the chain itself.
      }
      for (const t of ordered) out.push({ provider: t, model: 'default' });
    } catch {
      // Best-effort — an unconfigured fallback chain must never break a pinned
      // run (the pinned candidate alone is still a valid pool).
    }
    pinnedFallbacks = out;
    return out;
  };
  /** Per-turn failure session — same composition every other action uses. */
  const failureSession: FailureSessionState = {
    sessionFailedProviders: new Map(),
    sessionTransientFailedProviders: new Set(),
    sessionFailedModels: new Map(),
  };

  try {
    if (opts.provider && !isAutoProvider(opts.provider)) {
      const resolved = resolveProvider(configManager, opts.provider);
      providerType = resolved.type;
      provider = resolved.provider;
      // Validate the pin against the provider that will serve it, ALWAYS — an
      // explicit `--model` used to be used as-is (`opts.model ? opts.model :
      // resolve…`), so `-p groq -m <a gemini model>` reached the API unvalidated
      // and 404'd with the repair machinery sitting right there (issue #10).
      const pinned = await resolveRoute({
        providerType,
        provider,
        model: opts.model,
        source: 'cli',
        task: 'interactive loop (pinned provider)',
      });
      model = pinned.model;
      servedRoute = servedRouteFrom(pinned);
      pushCandidate(providerType, model);
      // ── A PINNED RUN FAILS OVER TOO ──────────────────────────────────────
      // A pinned provider used to contribute a SINGLE candidate, so any
      // mid-turn failure killed the whole turn even though a fallback chain
      // was configured — the pin collapsed the deep pool into a one-shot. The
      // SAME config-declared chain chat's non-auto path walks (`fallback.
      // providers` when set, otherwise the credentialed/verified providers
      // ranked dynamically) is appended by `extendWithPinnedFallbacks()` when a
      // failure actually needs it, so `--provider X` still lands a best-effort
      // answer instead of dying on X's first bad step.
    } else {
      const routed = await getAutoRouter().resolve('execute', goal, { verbose: !opts.quiet }, configManager);
      // Walk {provider, model} PAIRS to the first AVAILABLE one (the router
      // excludes unconfigured providers; isAvailable() is the gate). The pairs
      // come from the router's DEEP failover chain, so several models per
      // provider are reachable — a single model per provider meant a provider's
      // 2nd-best model was never tried (free tiers meter per-model, so siblings
      // are frequently still usable).
      const pairs: Array<{ provider: string; model: string }> = [];
      const seen = new Set<string>();
      const push = (prov: string, mdl?: string): void => {
        if (!prov) return;
        const model = mdl && mdl !== 'default' ? mdl : 'default';
        const key = `${prov}|${model}`;
        if (seen.has(key)) return;
        // NOTE: deliberately NO registry-usability skip here — `resolveWorkingModel`
        // below owns model health and repairs a dead/parked model to a live one
        // on the SAME provider. Filtering the candidate out first would skip the
        // whole provider and bypass that repair. The chain already ranks healthy
        // models first, so a parked pick is only ever the last resort.
        seen.add(key);
        pairs.push({ provider: prov, model });
      };
      // SAME deep pool the orchestrator and chat walk (primary → model-first
      // tiered pool → router chain incl. reserve → ranked → config fallback),
      // so execute no longer reaches fewer models than the other paths.
      const pool = buildDeepFailoverPool(routed, {
        taskDescription: goal,
        configManager,
      });
      for (const c of pool) push(c.provider, c.model);

      // SAME exclusion predicate the orchestrator's resilient walk uses: skip
      // models the registry marks unusable/parked (per ENTRY — a parked model's
      // siblings stay reachable) and models that failed in an earlier run
      // (cross-pipeline memory; entries self-expire, so a healed model is picked
      // again). Tried in TWO passes so "reject only when nothing is left" holds:
      // excluded candidates are attempted last, never dropped, so an
      // all-excluded pool still makes the best attempt instead of failing with
      // "no available provider".
      const isExcluded = createFailoverExclusionFilter();
      const ordered = [
        ...pairs.filter((p) => !isExcluded(p.provider, p.model)),
        ...pairs.filter((p) => isExcluded(p.provider, p.model)),
      ];
      // Hand the whole ordered chain to the mid-turn walk.
      for (const pair of ordered) pushCandidate(pair.provider, pair.model);

      for (const pair of ordered) {
        try {
          const resolved = resolveProvider(configManager, pair.provider);
          if (await resolved.provider.isAvailable()) {
            const desired = pair.model !== 'default'
              ? pair.model
              : getAutoRouter().resolveModel(pair.provider, 'execute', configManager);
            providerType = resolved.type;
            provider = resolved.provider;
            const route = await resolveRoute({
              providerType: resolved.type,
              provider: resolved.provider,
              model: desired,
              source: 'cli',
              task: 'interactive loop (failover chain)',
            });
            model = route.model;
            servedRoute = servedRouteFrom(route);
            break;
          }
        } catch {
          // Next candidate.
        }
      }
    }
  } catch (err) {
    // G18 — a routing failure is a FAILED trace, not a missing one.
    endTrace(traceId, false, { kind: 'failed', tools: [] });
    return failureResult(
      // User-facing reason is sanitized (no provider wire text); the raw error
      // rides along as the technical explanation below.
      toUserFacingGenerationError(err),
      startedAt,
      opts.provider ?? 'auto',
      opts.model ?? 'default',
      `routing failed before an engine decision was possible: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!provider) {
    endTrace(traceId, false, { kind: 'failed', tools: [] });
    return failureResult(
      'No available provider for the loop engine (check API keys / local runner).',
      startedAt,
      opts.provider ?? 'auto',
      opts.model ?? 'default',
      'no available provider after the candidate walk',
    );
  }

  // ── Engine decision (Phase 2): audit-trail echo for the caller/telemetry ──
  // The CALLER decides loop-vs-pipeline with the same function; this echo
  // keeps the executor's telemetry self-describing (dashboard badge parity).
  let engineExplanation = '';
  try {
    engineExplanation = resolveEngine({ provider: providerType, model }).explanation;
  } catch {
    engineExplanation = 'engine decision unavailable';
  }
  if (!opts.quiet) logger.debug(`Engine: ${engineExplanation}`);

  // ── Ambient project context (Phase 1.4 — same block the chat engine uses) ──
  let projectContext: string | undefined;
  if (!opts.skipProjectContext) {
    try {
      const built = await buildLoopProjectContext(process.cwd());
      if (built) projectContext = built;
    } catch {
      projectContext = undefined; // best-effort — never breaks the turn
    }
  }

  // ── Loop-side skill match hint (Phase 3.2 — chat/execute parity) ─────────
  // The orchestrator consults SkillStore.findMatch + the hub catalog before
  // planning; the execute loop never heard about that layer. One
  // deterministic, best-effort match is appended to the system prompt
  // (methodology + exact skill-tool load syntax, bounded to ONE block). A
  // failure returns '' and the prompt is byte-identical to pre-3.2.
  let skillHint = '';
  if (!opts.skipSkillHint) {
    try {
      const { buildLoopSkillHint, markLoopSkillUsed } = await import('../tools/loop-skill-hint.js');
      const injected: { value: import('../tools/loop-skill-hint.js').LoopSkillHintMatch | null } = { value: null };
      skillHint = await buildLoopSkillHint(goal, configManager, injected);
      if (injected.value) {
        void markLoopSkillUsed(injected.value);
        if (!opts.quiet) logger.info(`   🧠 Matched skill '${injected.value.name}' — methodology injected into the loop context`);
      }
    } catch {
      skillHint = ''; // best-effort — never breaks the turn
    }
  }

  const { runToolLoop } = await import('../tools/tool-loop.js');
  const { getTool, TOOL_CONTRACT_JSON } = await import('../tools/registry.js');

  const thread: ToolMessage[] = [
    { role: 'system', content: buildExecuteLoopSystemPrompt(TOOL_CONTRACT_JSON) + skillHint },
    ...(projectContext ? [{ role: 'user' as const, content: `[Project context]\n${projectContext}` }] : []),
    { role: 'user', content: goal },
  ];

  const loadedExtraTools = new Set<string>();
  const erroredTools: string[] = [];

  // Adapter cache — one `resolveProvider` per provider per turn.
  const resolvedProviders = new Map<string, InferenceProvider>();
  const resolveAdapter = async (prov: string): Promise<InferenceProvider> => {
    const cached = resolvedProviders.get(prov);
    if (cached) return cached;
    const resolved = resolveProvider(configManager, prov);
    resolvedProviders.set(prov, resolved.provider);
    return resolved.provider;
  };
  /** Candidates that already failed in THIS turn (attempted, but tried last). */
  const failedPairs = new Set<string>();
  const pairKey = (p: string, m: string): string => `${p}|${m}`;

  /** One generation attempt on a concrete provider × model (native → JSON). */
  const tryOnce = async (
    prov: InferenceProvider,
    mdl: string,
    messages: ToolMessage[],
    schemas: ToolJsonSchema[],
    abort: AbortSignal | undefined,
  ) => {
    if (typeof prov.generateTools === 'function' && schemas.length > 0) {
      // R2 — tag the transport on the way out, the same vocabulary chat and the
      // subagent child report, so an `execute` run can be attributed too.
      if (typeof prov.generateToolsStream === 'function' && opts.onToken) {
        const streamed = await prov.generateToolsStream(messages, schemas, { model: mdl, signal: abort }, opts.onToken);
        return { ...streamed, transport: 'native' as const };
      }
      const native = await prov.generateTools(messages, schemas, { model: mdl, signal: abort });
      return { ...native, transport: 'native' as const };
    }
    // JSON fallback transport — the shared helper the chat engine uses.
    const { buildJsonFallbackPrompt } = await import('../inference/tool-call-utils.js');
    const { extractFallbackToolCalls } = await import('../tools/tool-loop.js');
    const prompt = buildJsonFallbackPrompt(messages, schemas);
    let raw: string;
    if (typeof prov.generateStream === 'function') {
      const chunks: string[] = [];
      await prov.generateStream(prompt, { model: mdl, signal: abort }, (t) => {
        chunks.push(t);
        opts.onToken?.(t);
      });
      raw = chunks.join('');
    } else {
      raw = await prov.generate(prompt, { model: mdl, signal: abort });
    }
    const { text, calls } = extractFallbackToolCalls(raw);
    // R2 — the shared JSON fallback, named as such.
    return { content: text, toolCalls: calls, transport: 'json' as const };
  };

  const callModel = async (
    messages: ToolMessage[],
    schemas: ToolJsonSchema[],
    _stepOnToken?: (token: string) => void,
    stepSignal?: AbortSignal,
  ) => {
    void _stepOnToken;
    const abort = stepSignal ?? opts.signal;
    // Walk order: the CURRENT pick first, then the rest of the deep chain.
    // Candidates that already failed this turn are attempted LAST (never
    // dropped), so an all-failed pool still makes the best attempt instead of
    // dying on "no candidate".
    const primary = { provider: providerType, model };
    const all: Array<{ provider: string; model: string }> = [];
    const seenAll = new Set<string>();
    for (const c of [primary, ...candidatePairs]) {
      const k = pairKey(c.provider, c.model);
      if (seenAll.has(k)) continue;
      seenAll.add(k);
      all.push(c);
    }
    const walk = [
      ...all.filter((c) => !failedPairs.has(pairKey(c.provider, c.model))),
      ...all.filter((c) => failedPairs.has(pairKey(c.provider, c.model))),
    ];
    /**
     * Lazily extend the walk with the pinned run's config fallback chain, the
     * first time a candidate actually fails or is unavailable. Appending to
     * `walk` mid-iteration is safe (the array iterator re-reads the length), so
     * the very failure that triggered the extension already fails over within
     * this step instead of deferring to the next one.
     */
    const extendWithPinnedFallbacks = (): void => {
      if (!pinnedRun) return;
      for (const fb of resolvePinnedFallbacks()) {
        const k = pairKey(fb.provider, fb.model);
        if (seenAll.has(k)) continue;
        seenAll.add(k);
        all.push(fb);
        walk.push(fb);
      }
    };

    let lastErr: unknown;
    for (const cand of walk) {
      if (abort?.aborted) break;
      const key = pairKey(cand.provider, cand.model);
      try {
        const prov = await resolveAdapter(cand.provider);
        if (typeof prov.isAvailable === 'function' && !(await prov.isAvailable())) {
          failedPairs.add(key);
          // A pinned provider that cannot be constructed/reached is not a
          // verdict on it — walk its configured fallbacks.
          extendWithPinnedFallbacks();
          continue;
        }
        const desired = cand.model !== 'default'
          ? cand.model
          : getAutoRouter().resolveModel(cand.provider, 'execute', configManager);
        const route = await resolveRoute({
          providerType: cand.provider,
          provider: prov,
          model: desired,
          source: 'failover',
          task: 'interactive loop (mid-turn failover)',
        });
        const mdl = route.model;
        // Flip the loop's active provider/model to the candidate that answers,
        // so telemetry and the NEXT step's primary pick follow the winner.
        providerType = cand.provider;
        provider = prov;
        model = mdl;
        // The model is TOLD about this, honestly (see loop-route-feed.ts): a
        // failover that the model does not learn about is how a turn ends up
        // answering "which model are you?" about a model that stopped serving
        // it several steps earlier.
        servedRoute = noteServedRoute(servedRoute, servedRouteFrom(route));
        const resp = await tryOnce(prov, mdl, messages, schemas, abort);
        // ── ANSWER-QUALITY GATE ──────────────────────────────────────────
        // A reply that is the model's own REASONING, or its narration of the
        // tool contract, is not a deliverable — and it never THROWS, so this
        // walk (which only reacts to provider errors) used to accept it and
        // the loop returned it as the turn's answer. Observed live from
        // `nuvira execute` on 2026-09-21, in a run whose tool calls succeeded:
        //   "The user wants a project plan for a … I should use the
        //    `plan_todo` tool to create a structured plan."
        // was the printed answer, and the same class reached WhatsApp senders.
        // One shared detector with the chat loop (see
        // `detectAnswerQualityFailure`), so the engine that drives `execute`
        // and every pipeline run can no longer be the surface that ships it.
        //
        // Checked BEFORE the success attribution: a rejected reply must not
        // mark the model verified for real usage. Throwing lands in the catch
        // below, which treats a quality failure as a candidate-level miss
        // (never a provider outage) and walks on.
        //
        // Two-tier on purpose: a step that carries TOOL CALLS may legitimately
        // open with an action narration ("Let me check the project files." then
        // `list_dir`), and rejecting it would throw that call away — measured
        // on the JSON-fallback transport, whose real lead-in `I will check.`
        // tripped the deliberation opener and lost the step's `list_dir` call.
        // A tool-carrying step is therefore judged on the HIGH-PRECISION
        // signals only (narrating the conversation, reciting the prompt), while
        // the step that IS the answer is judged on all of them.
        const quality = detectAnswerQualityFailure(resp.content, schemas.map((s) => s.name), {
          highPrecisionOnly: resp.toolCalls.length > 0,
        });
        if (quality) throw answerQualityError(resp.content, quality);
        // Success attribution — the same per-action write-through chat/execute
        // use, so the provider × model is marked verified for real usage.
        recordRegistrySuccess(cand.provider, mdl, 'execute');
        return resp;
      } catch (err) {
        // An abort is a clean stop, not a generation failure — never fail over
        // (or book a failure) for the caller's own cancellation.
        if (abort?.aborted) throw err;
        lastErr = err;
        failedPairs.add(key);
        /**
         * A QUALITY failure is not a provider OUTAGE: the model answered, just
         * not usefully. It is excluded from the failure bookkeeping below on
         * purpose — `classifyFallbackError` reads a reasoning/confusion error as
         * `unknown`, which would park the provider, decay its health score and
         * teach the bandit that a healthy endpoint is weak, all for a prompt it
         * answered in the wrong voice. The candidate is simply done for this
         * turn, and the pinned gate is skipped so a genuine development ask can
         * still reach the next candidate instead of dying on step 1.
         */
        const qualityKind = (err as Error & { qualityKind?: AnswerQualityKind }).qualityKind;
        if (!qualityKind) {
          // FULL shared bookkeeping: session exclusion → (rate-limit) ledger
          // park → registry write-through → quota timeline → circuit breaker.
          // This is what makes a mid-loop 429 LEARNED: the model rests and the
          // next run (and this turn's later steps) routes around it.
          try {
            recordActionFailure(failureSession, cand.provider, err, configManager, {
              model: cand.model !== 'default' ? cand.model : model,
              action: 'execute',
            });
          } catch {
            // Best-effort — bookkeeping must never mask the generation error.
          }
          // ── PINNED-RUN GATE ──────────────────────────────────────────────
          // Leaving a provider the user EXPLICITLY asked for is only justified
          // by a failure another provider can plausibly answer — the same
          // retryable gate chat's non-auto path uses. An auth error (the key is
          // dead) or a deterministic request-shape rejection fails identically
          // everywhere; surfacing it beats silently running the user's job
          // somewhere they did not ask for. The failure is still recorded above,
          // so the pin does not blind the router to a dead key.
          if (pinnedRun && !isRetryableError(classifyFallbackError(err))) {
            throw err;
          }
        }
        extendWithPinnedFallbacks();
        // ── DURABLE HAND-OFF ────────────────────────────────────────────────
        // The failure is written down BEFORE the walk moves on, so the next
        // candidate, the next turn and the next run all inherit it. The design
        // already said "a broken task is handed to another model" — what was
        // missing is the RECORD that survives the hand-off, which is why the
        // live NVDA-addon ask re-planned the identical step 18 times and would
        // have re-planned a 19th (see step-handoff.ts).
        //
        // What the record carries is deliberately not "model X failed": it is
        // the route, the failure KIND, the reason, and the artifacts the ask
        // named — reconciled against the filesystem on every later read, so the
        // incoming model is told what is genuinely still outstanding.
        try {
          recordStepHandoff({
            projectPath: process.cwd(),
            goal,
            stepDescription: goal,
            declared: deliverablesNamedIn(goal),
            route: `${cand.provider}:${cand.model !== 'default' ? cand.model : model}`,
            kind: qualityKind ? 'quality' : 'failed',
            reason: err instanceof Error ? err.message : String(err),
          });
        } catch {
          // Best-effort — a hand-off write must never mask the generation error.
        }
        if (!opts.quiet) {
          logger.warn(
            qualityKind
              ? `   \u26A0\uFE0F ${cand.provider} answered with ${
                  qualityKind === 'reasoning' ? 'its own reasoning' : 'tool-contract confusion'
                } instead of the task — trying the next loop candidate...`
              : `   \u26A0\uFE0F ${cand.provider} failed — trying the next loop candidate...`,
          );
        }
      }
    }
    throw lastErr ?? new Error('no loop candidate could complete the step');
  };

  try {
    // R1 — the harness is fitted to the MODEL that will run, not just to
    // config: `getLoopExposureMode` alone hands a 0.5B local model the same
    // surface as gpt-oss:120b.
    const harness = resolveModelHarnessProfile({
      model,
      configExposure: getLoopExposureMode(configManager),
    });
    const result = await runToolLoop({
      messages: thread,
      // Read fresh on every step: a mid-turn failover must be visible to the
      // model, not just to the log (see the route feed).
      servedRoute: () => servedRoute,
      maxSteps: opts.maxSteps ?? 16,
      // Model-window-aware thread budget: a 1M-token model keeps its whole
      // window instead of being trimmed to the fixed ~50K-token default.
      // Undefined (unknown window) leaves the tool-loop default untouched.
      threadBudgetChars: resolveThreadBudgetChars({ provider: providerType, model }),
      toolExposure: harness.exposure,
      maxParallelReads: harness.maxParallelReads,
      onToken: opts.onToken,
      signal: opts.signal,
      context: {
        configManager,
        loadedExtraTools,
        cwd: process.cwd(),
        // G18 — the autonomy gates report their DECISIONS on this bus
        // (`autonomy:write-applied`, emitted by write_file/edit_file/
        // run_terminal/run_cli/git). Forwarding them here is what makes "the
        // gate proceeded on the request's own authorization, and here is its
        // reason" reviewable after the fact instead of inferred from a missing
        // round trip.
        emit: (event, data) => {
          if (event !== 'autonomy:write-applied') return;
          const d = data as { tool?: string; reason?: string } | undefined;
          onTraceEvent({
            kind: 'gate',
            gate: 'autonomy',
            ...(d?.tool ? { tool: d.tool } : {}),
            summary: d?.reason
              ? `proceeded without asking — ${d.reason}`
              : 'proceeded without asking — the request itself was the authorization',
          });
        },
      },
      deps: {
        // G18 — the LLM steps of the loop are recorded like every other
        // engine's, so the Trace tab can show WHY the loop answered as it did
        // (prompt digests, per-layer stability, model, tokens, latency).
        callModel: async (messages, schemas, onToken, signal) => {
          const started = Date.now();
          const promptText = serializeLoopThread(messages);
          try {
            const resp = await callModel(messages, schemas, onToken, signal);
            // G10 — an EMPTY step is not a success: a step with neither content
            // nor a tool call produced nothing, and must not read as one.
            const produced = resp.content.trim().length > 0 || resp.toolCalls.length > 0;
            recordStep(traceId, {
              agentType: 'loop',
              description: `${schemas.length} tool schema(s) exposed`,
              promptFull: promptText,
              provider: providerType,
              model,
              promptDigest: digestOf(promptText),
              // The TAIL is the ask + the most recent tool results — the part a
              // reader needs; the head is the system prompt (kept once, whole,
              // as the trace's stable layer).
              promptPreview: promptText.length > 800 ? `…${promptText.slice(-800)}` : promptText,
              responsePreview: resp.content.slice(0, 1000),
              responseLength: resp.content.length,
              inputTokens: estimateTokens(promptText),
              outputTokens: estimateTokens(resp.content),
              latencyMs: Date.now() - started,
              success: produced,
              ...(produced ? {} : { error: 'empty step — no answer text and no tool call' }),
            });
            return resp;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            recordStep(traceId, {
              agentType: 'loop',
              description: `${schemas.length} tool schema(s) exposed`,
              promptFull: promptText,
              provider: providerType,
              model,
              promptDigest: digestOf(promptText),
              promptPreview: promptText.length > 800 ? `…${promptText.slice(-800)}` : promptText,
              responsePreview: '',
              responseLength: 0,
              inputTokens: estimateTokens(promptText),
              outputTokens: 0,
              latencyMs: Date.now() - started,
              success: false,
              error: message,
            });
            throw err;
          }
        },
        executeTool: async (name, args, ctx) => {
          const tool = getTool(name);
          if (!tool) throw new Error(`Unknown tool: ${name}`);
          const out = await tool.run(args, ctx);
          // Errored-tool telemetry (Phase 0 repair-count proxy). Two failure
          // conventions exist: the loop's `Error:` prefix (runtime throw) and
          // the coding tools' `<name>: cannot|no such file …` verbs (missing
          // file, unreadable path). A bare `<name>: ` prefix is NOT a failure
          // signal — successful list_dir/read_file output legitimately starts
          // with it — and soft refusals ("is a directory", "looks binary") are
          // advisory, not failures. Telemetry only — never alters the text.
          if (
            out.startsWith('Error:') ||
            new RegExp(`^${name}: (cannot |no such file |denied)`).test(out)
          ) {
            erroredTools.push(name);
          }
          return out;
        },
        onEvent: opts.quiet ? undefined : (line) => logger.info(line),
      },
      // G18 — the loop's tool calls, gate decisions and refusals all reach the
      // trace store through this one sink (an OPTION, not a dep: the loop
      // describes, the surface records).
      onTraceEvent,
    });

    // G18 — WHAT ACTUALLY HAPPENED, in the same shape the chat and gateway
    // paths record: a declined call, an unverified edit, an unsatisfied
    // deliverable and a dropped promise are all facts about the turn, and the
    // outcome is what the Trace tab reads instead of "the model answered".
    endTrace(
      traceId,
      !result.generationFailed,
      buildTraceOutcome({
        generationFailed: result.generationFailed,
        cancelled: result.cancelled,
        tools: result.successfulToolCalls ?? result.toolCalls,
        unverifiedActionClaim: result.unverifiedActionClaim,
        unfulfilledPromise: result.unfulfilledPromise,
        unverifiedEdit: result.unverifiedEdit,
        unverifiedEditClaim: result.unverifiedEditClaim,
        undeliveredArtifact: result.undeliveredArtifact,
      }),
    );

    return {
      content: result.content,
      generationFailed: result.generationFailed ?? false,
      bounded: result.bounded,
      toolCalls: result.toolCalls,
      erroredTools,
      toolOutcomes,
      durationMs: Date.now() - startedAt,
      provider: providerType,
      model,
      engineExplanation,
      traceId,
      refusals: recorded.refusals,
      gateDecisions: recorded.gateDecisions,
      ...(result.transport ? { transport: result.transport } : {}),
      ...(result.runTrace ? { runTrace: result.runTrace } : {}),
    };
  } catch (err) {
    endTrace(traceId, false, { kind: 'failed', tools: [] });
    return failureResult(
      toUserFacingGenerationError(err),
      startedAt,
      providerType,
      model,
      `loop execution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Build a failed result (shape-complete for the eval arm comparison). */
function failureResult(message: string, startedAt: number, provider: string, model: string, engineExplanation: string): LoopExecutorResult {
  return {
    content: message,
    generationFailed: true,
    bounded: false,
    toolCalls: [],
    erroredTools: [],
    toolOutcomes: [],
    durationMs: Date.now() - startedAt,
    provider,
    model,
    engineExplanation,
  };
}
