import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { envBuff } from '../config/paths';

import { Command } from 'commander';
import inquirer from 'inquirer';
import { BaseCommand, getCliName } from './commands.js';
import { resolveProvider } from './router.js';
import { resolveRoute, strictModelMode, strictPinRefusal } from '../inference/route-resolver.js';
import { showModelPicker } from './model-picker.js';
import { ContextParser } from '../context/parser.js';
import { getCache } from '../context/cache.js';
import { assembleContext, retrievalOptionsFromConfig, recordRetrievalStats } from '../learning/retrieval.js';
import { getChatHistory } from '../context/history.js';
import { maybeAutoRecall, recallContextBlock } from '../context/session-recall.js';
import { getMemoryManager } from '../memory/manager.js';
import { logger } from '../utils/logger.js';
import { printOrchestrationResult } from './execute.js';
// WS5 (#27) — isolation (a git worktree around the turn) and resume (replaying
// recorded steps instead of re-paying for them). See the module headers for why
// the worktree is created HERE, around the whole turn, and why a replay is
// keyed on the step's whole input rather than its position alone.
import {
  beginIsolation,
  endIsolation,
  resolveIsolationRequest,
  worktreeNotice,
  type IsolationOutcome,
} from '../tools/worktree.js';
import {
  closeResume,
  openResume,
  resolveResumeRequest,
  type OpenResume,
  type ResumeOutcome,
} from '../learning/step-checkpoint.js';
import { applyActiveModel } from './model.js';
import { ConfigManager } from '../config/manager.js';
import { capabilityReasoningEffort, isMaxCapability } from '../config/capability-mode.js';
import { InferenceProvider } from '../inference/interface.js';
import type { ProviderType } from '../config/types.js';
import { getProviderFallback, classifyFallbackError, isRetryableError, isTransientForRetry, recordRegistrySuccess } from '../learning/provider-fallback.js';
import {
  recordActionFailure,
  RATE_LIMIT_EXCLUSION_MS,
} from '../learning/failure-bookkeeping.js';
import type { ComplexityLevel } from '../learning/hybrid-router.js';
import { getRouterBandit } from '../learning/router-bandit.js';
import { UnusableModelResponseError } from '../learning/response-usability.js';
import { resolveThreadBudgetChars } from '../learning/context-budget.js';
import { getAutoRouter, isAgentAutoRoute, isAutoModel, isAutoProvider, governanceVerdict, adminBudgetVerdict } from '../learning/auto-router.js';
import { continuationSoftwareText } from '../learning/continuation-intent.js';
import { TaskModelContinuity, taskSignature } from '../learning/task-model-continuity.js';
import {
  describeFailureKind,
  renderExhaustionReport,
  type ExhaustionAttempt,
} from '../learning/exhaustion-report.js';
import { estimateTokens } from '../learning/cost-tracker.js';
import { getModelRegistry } from '../learning/model-registry.js';
import { costSince } from '../learning/cost-tracker.js';
import { refreshModelRegistry } from '../inference/model-probe.js';
import { startWarmupDaemon } from '../learning/model-warmup.js';
import { recordRoutingDecision, type RoutingScoreBasis } from '../learning/routing-history.js';
import { shouldConfirmFailover, promptFailoverChoice } from './failover-prompt.js';
import { runSingleShotAuto } from './failover-runner.js';
import { buildAutoResolveOptions } from '../learning/resolve-options.js';
import { buildDeepFailoverPool, createFailoverExclusionFilter, modelBreadthReport } from '../learning/resilient-call.js';
import { parseRequestSync } from '../nlu/parser.js';
import { createPersistentPlanStore } from '../tools/plan-store.js';
import { withLogCorrelation } from '../enterprise/log.js';
import { recordMetricTime, getMetrics } from '../enterprise/metrics.js';
import type { ParsedRequest } from '../nlu/parser.js';
import { resolveDispatch } from '../nlu/actions.js';
import { hasCodingAction, resolveAskKind } from '../nlu/conversation-gate.js';
import { runToolLoop, extractFallbackToolCalls } from '../tools/tool-loop.js';
// WS3 (#25) — the turn as a span, when an operator has asked for OTLP export.
import { flushSpans, otelNoticeOnce, startTurnSpan } from '../observability/otel.js';
import {
  detectAnswerQualityFailure,
  answerQualityError,
  toUserFacingGenerationError,
  isToolCallingUnsupported,
  stripToolCallArtifacts,
} from '../inference/tool-call-utils.js';
import { beginTrace, endTrace, recordStep, recordTraceEvent, recordTraceFindings, recordTurnReport, buildTraceOutcome, traceOutcomeSucceeded } from '../learning/reasoning-trace.js';
import { recordWorkingState, getWorkingState, formatWorkingState, isProjectLedgerDir } from '../learning/working-state.js';
import { getLoopExposureMode } from '../tools/toolsets.js';
import { resolveModelHarnessProfile, shouldSkipNativeTools, isAgenticCapableModel } from '../learning/model-harness.js';
import { assertAgenticRoute, setWeakModelConsent, resolveWeakModelPolicy, weakRouteNotice } from '../learning/agentic-route-gate.js';
import { resolvePromptBudget, measurePromptBudget, formatPromptBudgetBreakdown } from '../learning/prompt-budget.js';
import { buildTurnReport, formatTurnReport, type TurnReport } from '../learning/turn-report.js';
import { turnOutcomeObservation } from '../learning/outcome-observation.js';
import { resolveAdapterDefault, hasCredentials } from '../learning/model-selection.js';
import { buildLoopProjectContext } from '../tools/loop-project-context.js';
import { sweepTransientFailures, collectionRevivalStore } from '../learning/provider-revival.js';
import { analyzeComplexity } from '../learning/hybrid-router.js';
import { routingCacheSignature, withRoutingCache } from '../learning/routing-cache.js';

/**
 * P0.6 — a tool-call lifecycle event forwarded to the GUI. `started` carries
 * the call id + args (rendered as a running card); `called` carries the
 * outcome (ok/error + duration + result preview). The dashboard chat console
 * forwards these over SSE as `tool` events.
 */
export interface ToolCallInfo {
  id?: string;
  tool: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  result?: string;
  error?: string;
  durationMs?: number;
}
import type { ToolLoopDeps, StepResponse, ToolLoopResult } from '../tools/tool-loop.js';
import { getTool, TOOL_CONTRACT_JSON, type ToolContext } from '../tools/registry.js';
// WS1 — the finding tool's bus event, and the wire shape every surface reports.
import { FINDING_EVENT } from '../tools/finding-tool.js';
import type { WireFinding } from '../findings/verdicts.js';
import { debugLogNotice, sessionDebugLog } from '../observability/debug-log.js';
import {
  buildFollowupContinuationPrompt,
  isSuggestedFollowup,
  withContinuationFollowups,
  type FollowupSuggestion,
} from '../tools/followup-utils.js';
// S2/S3 — the shared tool-call reliability helpers (salvage failed_generation,
// compact fallback schemas). One copy for every tool-calling surface, not
// chat-private (execute/plan/… inherit the fix).
import { buildJsonFallbackPrompt, salvageFailedGeneration } from '../inference/tool-call-utils.js';
import { runPipelineTool } from '../tools/pipeline-tool.js';
import { ArtifactStore } from '../tools/artifact-store.js';
import type { ToolMessage } from '../inference/interface.js';
import { getEventBus } from '../observability/event-bus.js';
import { maybeRunBackgroundDuties } from './duties.js';
import { deriveProjectId } from '../config/workspace.js';
import { compressLossless } from '../learning/compression.js';

// ─── Error Recovery Types ───────────────────────────────────────────────────

type ErrorRecoveryAction = 'retry' | 'switch' | 'cancel' | 'exit';

/** The resolved-route shape returned by ChatCommand.routeMessageAuto(). */
type AutoRoutedMessage = {
  type: string;
  provider: InferenceProvider;
  model: string;
  ranked: string[];
  complexity: string;
  score: number;
  /** A1/A2 — capability verdict on the FINAL (post-repair) pair, when known. */
  agenticCapable?: boolean;
  /** A1 — how the model-first override affected the final pick. */
  overrideReason?: string;
  /** The task profile the post-route capability gate needs. */
  taskProfile?: { intent?: string; requiresVerification?: boolean };
};

interface ErrorRecoveryResult {
  action: ErrorRecoveryAction;
  newType?: string;
  newProvider?: InferenceProvider;
  newModel?: string;
  /** When true, re-enable auto routing for subsequent messages */
  auto?: boolean;
}

/**
 * Detect error type and prompt the user for a recovery action.
 * This is a standalone function (not a method) for clarity.
 */
async function handleInferenceError(
  err: unknown,
  providerName: string,
  configManager: ConfigManager,
): Promise<ErrorRecoveryResult> {
  const errorMessage = err instanceof Error ? err.message : String(err);
  const errorStr = errorMessage.toLowerCase();

  // ── Detect error type ────────────────────────────────────────────────
  const isRateLimit =
    errorStr.includes('429') ||
    errorStr.includes('rate limit') ||
    errorStr.includes('too many requests') ||
    errorStr.includes('quota exceeded') ||
    errorStr.includes('rate_limit') ||
    // Keep in sync with classifyFallbackError(): mid-session quota/limit
    // exhaustion (Gemini-style) must also offer "wait and retry".
    errorStr.includes('token limit') ||
    errorStr.includes('resource has been exhausted') ||
    errorStr.includes('insufficient_quota');

  const isAuthError =
    errorStr.includes('401') ||
    errorStr.includes('403') ||
    errorStr.includes('unauthorized') ||
    errorStr.includes('forbidden') ||
    errorStr.includes('api key');

  const isServerError =
    errorStr.includes('500') ||
    errorStr.includes('502') ||
    errorStr.includes('503') ||
    errorStr.includes('server error') ||
    errorStr.includes('internal server');

  const isNetworkError =
    errorStr.includes('fetch failed') ||
    errorStr.includes('econnrefused') ||
    errorStr.includes('enotfound') ||
    errorStr.includes('econnreset') ||
    errorStr.includes('network') && !errorStr.includes('network policy');

  const errorType = isRateLimit
    ? '🚦 Rate limit'
    : isAuthError
      ? '🔑 Authentication'
      : isServerError
        ? '🔴 Server'
        : isNetworkError
          ? '🌐 Network'
          : '⚠️  API';

  // ── Show error summary ───────────────────────────────────────────────
  console.log('');
  logger.error(`${errorType} error from ${providerName}:`);
  const firstLine = errorMessage.split('\n')[0];
  logger.info(`  ${firstLine.slice(0, 200)}`);
  console.log('');

  // ── Build recovery choices ───────────────────────────────────────────
  const choices: Array<{ name: string; value: string }> = [];

  if (isRateLimit) {
    choices.push({ name: '⏳  Wait a moment and retry', value: 'retry' });
  }

  choices.push({ name: '🔄  Switch to a different provider/model', value: 'switch' });

  if (!isAuthError) {
    choices.push({ name: '🔁  Retry with same provider', value: 'retry' });
  }

  choices.push({ name: '❌  Cancel this message', value: 'cancel' });
  choices.push({ name: '🚪  Exit chat', value: 'exit' });

  const answer = await inquirer.prompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'How would you like to proceed?',
      prefix: '⚡',
      choices,
    },
  ]);

  console.log('');

  if (answer.action === 'switch') {
    const picked = await showModelPicker(configManager);
    if (picked) {
      // ── Auto selected — re-enable auto routing instead of switching ──
      if (picked.provider === 'auto' || isAutoModel(picked.model)) {
        return { action: 'switch', auto: true };
      }
      const resolved = resolveProvider(configManager, picked.provider);
      return {
        action: 'switch',
        newType: resolved.type,
        newProvider: resolved.provider,
        newModel: picked.model,
      };
    }
    // Picker cancelled — fall through to cancel
    return { action: 'cancel' };
  }

  if (answer.action === 'retry' && isRateLimit) {
    logger.info('⏳  Waiting 3 seconds before retry...');
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  return { action: answer.action as ErrorRecoveryAction };
}

/** E3a — the menu-free dispatch decision (rule-based, C1/C3 only). */
export interface PipelineDispatchDecision {
  /** Whether the request runs the coding pipeline. */
  dispatch: boolean;
  /** Whether a single confirm is required first (ambiguous create only). */
  needConfirm: boolean;
}

/** Options for the rule assessment (P0.5 adds the raw ask text). */
export interface DispatchAssessmentOptions {
  dev?: boolean;
  /** The raw user ask — lets the P0.5 conversation gate see the wording. */
  text?: string;
}

/**
 * E3a/E3c — the rule assessment (no-model fallback source).
 *
 * The legacy `promptDeveloperMode` menu ("1. Chat mode / 2. Developer mode")
 * is DELETED (Session 7c re-scope, landed in E3a). E3c demotes the rules
 * further (model-decides): EVERY request runs as a tool-call turn and the
 * MODEL decides what to do. This function computes what the RULES would say,
 * used for ONE thing only: the no-model fallback — when the tool loop fails to
 * generate a single response AND the rules assessed a high-confidence pipeline
 * intent, the pipeline runs directly. Rules act ONLY when the model is
 * unavailable, never as a bypass.
 *
 * It is deliberately NOT injected into the model's system prompt: commit
 * 4d30b7e removed prompt-level intent steering ("give the LLM tools and let it
 * decide") and a test guards against its return. So on THIS surface the model
 * decides, and `resolveAskKind` does not determine the outcome — that is only
 * true of the GATEWAY, which routes on it BEFORE the model is called. Same
 * rule, two different consequences: do not read a routing table here as a
 * prediction of what `nuvira chat` will do.
 * `dev` (the --dev flag / /dev toggle) forces the assessment to dispatch.
 */
export function resolvePipelineDispatch(
  parsed: ParsedRequest,
  opts?: DispatchAssessmentOptions,
): PipelineDispatchDecision {
  // P0.5 — conversation-vs-pipeline gate (runs BEFORE the dev bypass and the
  // action-map gate, so a question is never dispatched even with --dev, and
  // a coding goal phrased as a question still dispatches):
  // 1. QUESTION → never the pipeline (the observed failure: a question in
  //    execute/dev mode spawned the pipeline and created a python program to
  //    "answer" it).
  // 2. CODING ACTION in command position → always the pipeline, even when the
  //    NLU alone would misread it as chat ("how do I add JWT auth?" → explain
  //    → chat, but the user wants the auth added).
  if (opts?.text) {
    // ONE shared rule for every surface (see resolveAskKind): a genuine
    // question never dispatches; a coding verb in command position always
    // does. Keeping the gateway on this same function is what stops the two
    // from disagreeing about the same ask.
    if (resolveAskKind(opts.text, parsed) === 'chat') {
      return { dispatch: false, needConfirm: false };
    }
    if (hasCodingAction(opts.text)) {
      return { dispatch: true, needConfirm: false };
    }
  }
  if (opts?.dev) return { dispatch: true, needConfirm: false };
  if (parsed.action.run !== 'pipeline') return { dispatch: false, needConfirm: false };
  const d = resolveDispatch(parsed);
  return d.autoDispatch
    ? { dispatch: true, needConfirm: false }
    : { dispatch: true, needConfirm: true };
}



/**
 * Execute the multi-agent pipeline for a user's goal (H1/E3b refactor).
 *
 * Thin wrapper over the shared `runPipelineTool` (src/tools/pipeline-tool.ts)
 * — the SAME pipeline core the tool registry's build/resume/repair tools use,
 * so `nuvira chat` pre-dispatch and in-loop pipeline tool calls can never
 * diverge (STANDING RULE). Prints the orchestration result; the tool path
 * returns the summary text instead.
 */
export async function runDeveloperMode(
  goal: string,
  configManager: any,
  options?: { provider?: string; model?: string },
): Promise<void> {
  const r = await runPipelineTool(goal, configManager, {
    provider: options?.provider,
    model: options?.model,
    board: true,
  });
  if (r.result) {
    console.log('');
    printOrchestrationResult(r.result);
  } else if (r.error) {
    logger.error(r.error);
  }
}

/**
 * E3b — the tool-loop system prompt: base identity + the tool
 * contract (clarify via ask_user, end every response with suggest_followups).
 *
 * E3c — the rule assessment is a HINT, never a bypass: when the rules parsed
 * a confident intent, the model sees it as context ("rule assessment: … you
 * decide") so it can act faster — but the MODEL is the sole decision-maker
 * (rules act only as the no-model fallback in the
 * caller, never to skip the loop).
 */
/**
 * Backoff schedule for a SAME-provider retry on a transient failure. Two extra
 * attempts, deliberately short: a capacity spike at a shared endpoint clears in
 * seconds, and the user is waiting in the foreground. Long/looping retries belong
 * to the background runners, not the interactive turn.
 */
export const TRANSIENT_RETRY_DELAYS_MS = [1_000, 3_000] as const;

/**
 * Run one provider attempt, retrying transient failures against the SAME
 * provider before giving up.
 *
 * Why this exists next to the failover walk rather than inside it: the walk
 * needs a DIFFERENT provider to exist, and it books the failure against the one
 * that just failed. Verified live — a single configured provider plus a Gemini
 * 503 meant no retry at all, the circuit breaker parked the provider for 120s,
 * and the agent degraded to editing with zero gathered context. A transient
 * spike must cost a few seconds, not the whole task.
 *
 * Never retries: non-transient classes (auth, rate-limit, model/harness faults),
 * a cancelled turn, or once the schedule is exhausted.
 */
export async function generateWithTransientRetry<T>(
  attempt: () => Promise<T>,
  signal?: AbortSignal,
  onRetry?: (attemptNumber: number, err: unknown) => void,
): Promise<T> {
  for (let i = 0; ; i += 1) {
    try {
      return await attempt();
    } catch (err) {
      const canRetry = i < TRANSIENT_RETRY_DELAYS_MS.length && isTransientForRetry(err);
      if (!canRetry || signal?.aborted) throw err;
      onRetry?.(i + 1, err);
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAYS_MS[i]));
    }
  }
}

/**
 * Exported for the release gate (`tests/release/agent-contracts.test.ts`): the
 * assembled system prompt's SIZE and its required contract clauses are a
 * release invariant, not an implementation detail. See the gate for why.
 */
export function buildToolSystemPrompt(parsed?: ParsedRequest): string {
  return [
    "You are Nuvira, Agent-Nuvira's AI agent. You code, create, write, analyze, and automate — anything the user needs. You identify as Nuvira (never 'Buff').",
    'Be precise and honest. When a request is ambiguous or incomplete, clarify with ask_user instead of guessing.',
    '',
    '## What you can do',
    '- 💻 **Code**: write, debug, refactor, review, and ship code in any language',
    '- 📝 **Write**: poems, essays, emails, reports, documentation, scripts',
    '- 🎨 **Create images**: generate images, logos, diagrams, artwork',
    '- 🎬 **Create videos**: generate video content',
    '- 📊 **Analyze**: projects, data, files, architecture, performance',
    '- 🔧 **Automate**: CI/CD, deployments, infrastructure, workflows',
    '- 💬 **Chat**: answer questions, explain concepts, brainstorm ideas',
    '- 📁 **Manage files**: read, list, search, organize project files',
    '',
    '## How to respond',
    '- If the answer is already in the context (e.g., project context lists 5 files), just answer directly — no tools needed.',
    '- If you need data to answer (file names, contents, directory listing), use the appropriate tool (list_dir, read_file, glob) and then answer.',
    '- For code changes, use read_file to understand the code first, then make the change.',
    '- For tasks that match a known skill (deployments, assessments, structured workflows), call skill with no name to LIST available skills, then load the matching one — do not guess the procedure when a skill has it.',
    '- For tasks NOT covered by any tool: COMPOSE PRIMITIVES. Write a script with write_file and run it with run_terminal (or code_execution), fetch pages with read_page, generate images with tool_search load "media" + generate_image. You are the general solution — the tool list is not.',
    '- Some tools live OUTSIDE your visible list in domain toolsets (media, browser, channels, docker, …). If a tool you need is "unknown", call tool_search with {"action":"load","toolset":"<name>"} — its tools become callable immediately.',
    '- Always end with suggest_followups.',
    '',
    // WHY THIS BLOCK EXISTS. A weak model, primed by an earlier "attach a
    // project folder" refusal, carried that refusal into a plain writing
    // request: asked to write an essay it answered with instructions for moving
    // a project folder and "I don't have the capability to create files in a
    // workspace". Both are wrong and both are exactly what these lines forbid.
    '## Workspace and general requests',
    '- Writing and questions do NOT need a project folder. An essay, poem, email, explanation, summary or brainstorm is answered directly in your reply — never mention folders, directories, "attaching", or the workspace for these.',
    '- You CAN create and edit files (write_file) and run commands (run_terminal) when the request needs them. Never say you cannot create or write files.',
    '- Never ask the user to attach a folder, and never tell them to move files into a directory. If a request genuinely needs a workspace and none is attached, the app asks for one on its own — so just answer as best you can.',
    '- Treat a request as project work ONLY when it actually concerns the codebase or produces a file on disk. A general question that happens to contain a word like "class", "project", "test" or "document" is still a general question.',
    '',
    // WHY THIS BLOCK EXISTS. Asked to build a Tauri app, a model ran
    // `cargo --version` → exit 127 and then answered "I cannot install
    // system-level software like Rust on your host machine — I am physically
    // unable to build the Tauri application", handing the user a manual
    // `curl … | sh` step. It was not sandboxed at all; it had a real shell and
    // the user had just granted terminal permission (trace
    // trace-1791127992452-qzgodi). A missing prerequisite is a step to
    // complete, not a capability limit — so this states that plainly.
    '## Toolchains and missing prerequisites',
    '- You run on the user\u2019s REAL machine with a REAL shell (run_terminal). You are NOT sandboxed and NOT "enclosed".',
    '- If a command fails because a tool is missing (`command not found`, exit 127), INSTALL it yourself with run_terminal — e.g. `brew install <tool>`, `xcode-select --install`, the language installer (rustup for cargo/rust, nvm/npm for node, pyenv/pip for python, go, …), or apt/winget — then re-run the original command.',
    '- NEVER answer that you are unable or not permitted to install a prerequisite, and never hand the user an install step you were asked to do. A missing tool is a step to complete, not a wall.',
    '',
    TOOL_CONTRACT_JSON,
  ].join('\n');
}

/**
 * #30 — does this turn carry an HONESTY FLAG?
 *
 * A flagged answer must NEVER be written to the shared response cache. The cache
 * stores text only, so a later identical prompt — on the CLI, the dashboard or the
 * gateway — was served the reply with every flag absent: a known-unverified claim
 * (`unverifiedActionClaim` / `unverifiedEditClaim` / `unverifiedBuildClaim`), an
 * announced-but-unperformed action (`unfulfilledPromise`), a missing deliverable
 * (`undeliveredArtifact`) or an inert turn (`noActionTaken`) replayed as a clean
 * answer, on every surface at once. The flags exist because those answers must
 * not be replayed as settled, so the turn is not cached and re-derives instead.
 */
export function turnCarriesHonestyFlag(result: {
  unverifiedActionClaim?: boolean;
  unfulfilledPromise?: boolean;
  undeliveredArtifact?: boolean;
  unverifiedBuildClaim?: boolean;
  unverifiedEdit?: boolean;
  unverifiedEditClaim?: boolean;
  noActionTaken?: boolean;
  /** Bundle 19 — a file the turn wrote says its own content was omitted. */
  artifactIncomplete?: { path: string; statement: string };
  /** Bundle 20 — the reply claims a file was written and the turn wrote nothing. */
  unverifiedFileClaim?: boolean;
}): boolean {
  return Boolean(
    result.unverifiedActionClaim ||
      result.unfulfilledPromise ||
      result.undeliveredArtifact ||
      result.unverifiedBuildClaim ||
      result.unverifiedEdit ||
      result.unverifiedEditClaim ||
      result.noActionTaken ||
      result.artifactIncomplete ||
      result.unverifiedFileClaim,
  );
}

// ─── ChatCommand ────────────────────────────────────────────────────────────

export class ChatCommand extends BaseCommand {
  private devModeAuto = false;

  /**
   * Providers that failed MID-SESSION in auto mode, with the expiry of their
   * exclusion (ms epoch):
   * - AUTH failures (expired token/key) are definitive → excluded for the whole
   *   session (Number.MAX_SAFE_INTEGER), so a provider whose key died mid-session
   *   is never re-picked (and re-failed) on a later message.
   * - RATE-LIMIT failures (429 / exhausted quota / "token limit exceeded") are
   *   usually TRANSIENT (a 1-minute quota window) → excluded only for a short
   *   cooldown, then re-admitted, so a throttled-but-working provider isn't
   *   blacklisted for the entire chat.
   * - 5xx/network errors are NOT session-excluded at all — they flow through
   *   the circuit breaker (which needs repeated failures before opening).
   * Cleared when the chat exits.
   */
  private sessionFailedProviders = new Map<string, number>();

  /**
   * `provider|model` → expiry of a MODEL-scoped session exclusion.
   *
   * A 429 on ONE model now records HERE rather than in sessionFailedProviders:
   * free tiers meter per-model (RPD/TPM), so excluding the whole provider is
   * what stopped chat from ever reaching a provider's 2nd-best model. Siblings
   * of the failed model stay routable; the failure only escalates to the
   * provider-wide map when several distinct models of that provider are
   * rate-limited (a genuinely shared limit).
   */
  private sessionFailedModels = new Map<string, number>();

  /**
   * P3 (fix_model_routing) — task-level model CONTINUITY.
   *
   * The pair that produced usable work for a task is remembered per task
   * signature, and the next turn of the SAME task (a "resume"/"continue" whose
   * routing text resolves to the same ask) offers it FIRST. Routing re-decides
   * every turn, and a signal-free continuation re-decided from scratch is how a
   * working run degraded onto a model that then answered with nothing.
   *
   * A preference, never a pin: the recalled pair goes through the SAME
   * credential/exclusion/registry gates as any other candidate, and the normal
   * pool stands behind it — so a model that has since died costs one check.
   */
  private taskContinuity = new TaskModelContinuity();
  /** The task signature of the turn being routed (see routeMessageAuto). */
  private lastTaskSignature?: string;

  /**
   * P4 (fix_model_routing) — what THIS turn actually tried, and why each
   * candidate did not answer. Reset per turn; consumed by the exhaustion report
   * when a turn ends without an answer. Chat's own failover walk is the
   * authority here (the shared walk in `resilient-call.ts` keeps its own log for
   * the gateway/orchestrator paths), so the report can name the models the user
   * was actually served by — not a pool that was considered.
   */
  private turnAttempts: ExhaustionAttempt[] = [];

  /** Record one failed/skipped attempt for this turn's exhaustion report. */
  private recordTurnAttempt(attempt: ExhaustionAttempt): void {
    try {
      this.turnAttempts.push(attempt);
    } catch {
      // Best-effort — telemetry must never break a turn.
    }
  }

  // RATE_LIMIT_EXCLUSION_MS + TRANSIENT_FAILURE_EXCLUSION_MS now live in
  // src/learning/failure-bookkeeping.ts (shared with every action) — see
  // recordActionFailure. Behavior is identical: same values, same semantics.

  /**
   * Providers that failed TRANSIENTLY this session (server/network/timeout/
   * unknown). Tracked separately from the exclusion map so that when a
   * transient exclusion EXPIRES, the provider is only re-admitted to routing
   * after a quick on-demand spot-check confirms it's actually back — recovery
   * is discovered in seconds, not by blindly failing into it again.
   */
  private sessionTransientFailedProviders = new Set<string>();

  /**
   * P0.7 — default plan store for this ChatCommand instance (the dashboard
   * console injects a per-session store instead; this is the CLI/execute
   * default so a plan survives across turns within one chat session).
   */
  private planStore: import('../tools/plan-store.js').PlanStoreLike = createPersistentPlanStore(
    `cli:${process.cwd()}`,
  );

  /**
   * Whether the cold-start probe has fired this session. On a fresh registry
   * (no verified models yet) the FIRST auto pick fires a background
   * probe + spot-check so routing learns from real API data instead of
   * failing into dead ends — the fire-and-forget keeps the first message fast.
   */
  private coldStartProbeFired = false;

  /**
   * G5 — TRACE FIDELITY. The Auto-router decision snapshot for the current
   * turn, stashed at resolve time so the reasoning trace can record WHY a step
   * used the provider/model it did. The audit of the calculator session found
   * 98/99 steps stamped with the session default `gemini/gemini-3.1-flash-lite`
   * and **0/99** steps carrying a routing snapshot — so the Trace tab's "model
   * used" column was really "the session's default model".
   */
  private lastRouteSnapshot?: import('../learning/reasoning-trace.js').TraceRoutingSnapshot;

  /**
   * G5 — the provider/model of the LAST generation attempt (post-failover,
   * post-default-resolution). Read by the chat trace recorder so a step names
   * the model that actually ran it, instead of whatever the session default
   * happened to be.
   */
  private lastAttempt?: { provider: string; model?: string };

  /**
   * P3 — programmatic single-turn answer for the dashboard chat console.
   *
   * Runs one tool-loop turn — the EXACT engine behind `nuvira chat "<prompt>"` —
   * and returns content + followups as data instead of printing. Non-TTY by
   * construction: an injected ask_user renderer declines the clarification so
   * the model proceeds on best judgment (inquirer would hang on the server's
   * piped stdin), and no interactive prompts are ever reached. `history`
   * carries prior turns so the dashboard threads a real conversation.
   */
  async answerOnce(
    message: string,
    opts: {
      provider?: string;
      model?: string;
      dev?: boolean;      history?: Array<{ role: string; content: string }>;
    askUser?: ToolContext['askUser'];
    /**
     * P5 — this message is a CONTINUATION of the previous turn (it came from a
     * clicked followup). The continuation marker is prepended to the
     * model-facing thread ONLY — the raw text is what lands in history, so a
     * long session never accumulates markers. See FOLLOWUP_CONTINUATION_MARKER.
     */
    continuation?: boolean;
    /** P3 — live progress lines for the dashboard chat console. */
    onProgress?: (line: string) => void;
    /**
     * P0.6 — live step cards: forward tool-call lifecycle events (started /
     * called) so the GUI can render each call as a structured card. Passed
     * through to runChatAnswer's ctxOverrides; see ToolCallInfo.
     */
    onToolCall?: (phase: 'started' | 'called', info: ToolCallInfo) => void;
    /**
     * P0.7 — plan checklist: called on every plan_todo mutation with the
     * structured snapshot (goal + steps + revision) so the GUI's checklist
     * card updates in place.
     */    onPlanChange?: (snapshot: import('../tools/plan-store.js').PlanSnapshot) => void;
    /**
     * P3b — git diff card: called when the git tool runs `git diff` with the
     * structured per-file payload. The dashboard console forwards it as a
     * `diff` event so the GUI renders the 🔧 diff card.
     */
    onGitDiff?: (payload: import('../tools/git-tool.js').GitDiffPayload) => void;
    /** P6a — /learn preview card: skill_manage create/patch emits the draft. */
    onSkillDraft?: (payload: import('../tools/skill-tool.js').SkillDraftPayload) => void;
    /**
     * WS1 — a finding was recorded this turn, with the verdict the gate
     * computed from the evidence supplied. The wire shape on purpose: the same
     * object the gateway logs and the child ships over IPC.
     */
    onFinding?: (finding: WireFinding) => void;
    /**
     * P0.7 — the session's plan store (the dashboard console injects one per
     * conversation so plans never leak across sessions).
     */
    planStore?: import('../tools/plan-store.js').PlanStoreLike;
    /** Live gateway for gateway_send (gateway-triggered chat answers reuse the connected bridge). */
    gateway?: ToolContext['gateway'];
    /**
     * P3 — bounded project snapshot (path + file tree + symbol map) injected
     * as a `[Project context]` message so "assess THIS project" works without
     * the user describing the codebase. Built by the dashboard's
     * project-context module; the CLI never sends it (it already runs IN the
     * project, cwd-aware).
     */
    projectContext?: string;
    /**
     * Session 3 — CHANNEL / FORMAT POLICY for the STABLE layer.
     *
     * The gateway used to prepend the "RESPONSE FORMAT (non-negotiable…)" block
     * to every INBOUND USER TURN — i.e. the same policy was re-injected as
     * volatile content on every message (~80% of the visible user turn on
     * WhatsApp turns). Policy is identical every turn, so it belongs in the
     * system prompt: it is then byte-stable (prompt-cacheable) and shows up in
     * the layered trace's `systemDigest` instead of polluting the ask.
     */
    systemPolicy?: string;
    /**
     * P4 — the attached project's directory. When set, the turn ALSO recalls
     * that project's prior sessions + facts (`autoRecall`) and injects them
     * as a `[Recalled project context]` message — the dashboard's twin of the
     * CLI execute/plan auto-recall (which use process.cwd(); the dashboard
     * runs in its own cwd, so the attached project is the recall key).
     * Fresh per turn — the snapshot is cached, the recall is not.
     */
    projectPath?: string;
    /**
     * P4 — stream content tokens of the answer as the model generates them
     * (the dashboard's typewriter). Forwarded verbatim from the tool loop;
     * providers that stream deliver tokens live, others deliver the whole
     * step content at once. The CLI never passes it — pure dashboard opt-in.
     */
    onToken?: (token: string) => void;
    /**
     * P4 — external cancellation (the dashboard's Cancel button): the turn
     * stops at the next loop boundary and any in-flight provider request
     * aborts. A cancelled turn returns `cancelled: true` and is discarded
     * (no cache/history/memory). The CLI never passes it.
     */
    signal?: AbortSignal;
    /**
     * WS2 — which SURFACE this turn is running as, for the session debug log's
     * header. `answerOnce` is shared by three surfaces (the CLI, the dashboard
     * console and the gateway), so the label cannot be inferred here; a caller
     * that does not say is labelled `cli-chat`.
     */
    debugSurface?: string;
    /**
     * WS2 — the chat/thread this turn belongs to, when the caller has one.
     *
     * Recorded in the debug log's header so the log is FINDABLE, not merely
     * readable: the dashboard serves a support bundle per conversation, and it
     * can only do that if the log says which conversation it was. A caller with
     * no such identity (a one-shot `nuvira chat "..."`) omits it and the header
     * omits the line, rather than inventing an id.
     */
    debugSession?: string;
    /**
     * WS5 (#27) — run this TURN in its own git worktree of the project, and
     * report the diff against the base commit on the result.
     *
     * The whole turn moves: tools resolve relative to the worktree, so every
     * write lands in the isolated copy. When the directory cannot be isolated the
     * turn REFUSES — it never runs unisolated while claiming otherwise.
     */
    worktree?: boolean;
    /** WS5 (#27) — keep the worktree after the turn (its path is reported either way). */
    keepWorktree?: boolean;
    /**
     * WS5 (#27) — resume: replay this run's recorded steps whose input is
     * unchanged instead of paying for them again. `true` = the record for this
     * ask in this directory; a string = that record by name.
     */
    resume?: string | boolean;
  } = {},
): Promise<{
  content: string;
  followups: FollowupSuggestion[];
  generationFailed?: boolean;
  /**
   * WS5 (#27) — the turn REFUSED to run: it never reached a model, and `content`
   * is the reason rather than an answer.
   *
   * Always accompanied by `generationFailed` (a refusal IS a failed turn), but not
   * interchangeable with it — see the no-model fallback in `answerOnce`, which keys
   * on `generationFailed` and must never re-dispatch a refused turn.
   */
  refused?: boolean;
  /** WS5 (#27) — the isolation this turn had, and what it changed. */
  worktree?: IsolationOutcome;
  /** WS5 (#27) — what this turn's resume replayed, and what it saved. */
  resume?: ResumeOutcome;
  /** P4 — true when the turn was cancelled via opts.signal (discarded). */
  cancelled?: boolean;
  /** Phase 4 — true when the loop hit its step bound before an end turn. */
  bounded?: boolean;
  /** Names of the tools that actually executed this turn (honesty checks). */
  toolCalls?: string[];
  /**
   * True when the answer CLAIMED a delivery no delivery tool performed — an
   * unverified claim. Every surface must treat this as "not confirmed done".
   */
  unverifiedActionClaim?: boolean;
  /**
   * True when the answer closed on a promise to act that the turn never
   * carried out. Surfaces must not present such a turn as "in progress".
   */
  unfulfilledPromise?: boolean;
  /**
   * G13b — the request asked for an authored deliverable to be produced and
   * the turn wrote nothing to disk. The reply may be excellent prose; the
   * artifact does not exist, so no surface may read it as finished work.
   */
  undeliveredArtifact?: boolean;
  /**
   * A3 Part 2 — a BUILD command ran and FAILED this turn, no later build
   * succeeded, and the answer still asserted the artifact came out good.
   * Surfaces must not present such a turn as finished work.
   */
  unverifiedBuildClaim?: boolean;
  /**
   * Bundle 19 — a file this turn WROTE declares that its own content was omitted
   * (`## 1. Introduction ... (full content omitted for brevity) ...`). The artifact
   * admits it is incomplete, so the turn is not finished work however complete its
   * prose reads. Carries the artifact's own words as evidence.
   */
  artifactIncomplete?: { path: string; statement: string };
  /**
   * Bundle 20 — the answer ASSERTED a file was written while the turn wrote none
   * (`The guide has been written and saved as GUIDE.md …`). A function of the turn's
   * own claim, so it is disclosed even when the ask was never recognised as a
   * deliverable. Distinct from `undeliveredArtifact`, which keys on the ASK.
   */
  unverifiedFileClaim?: boolean;
  provider?: string;
  model?: string;
  /**
   * R2 — which tool transport served the turn: `native` (the provider's own
   * tool-calling API), `json` (the shared JSON fallback) or `none` (no tool
   * transport was involved). Reported here so every caller of the shared
   * engine — the CLI, the dashboard console, the gateway, `nuvira execute` —
   * attributes a turn with the SAME triple the subagent child announces, which
   * is what makes the surfaces comparable at all. Absent only when no loop ran
   * (the no-model pipeline fallback reports `none`).
   */
  transport?: 'native' | 'json' | 'none';
  /**
   * WS1 — every finding this turn recorded, in call order, already gated.
   * `[]` is a real answer ("this surface reports findings, and there were
   * none"), which is what lets five surfaces be compared honestly.
   */
  findings?: WireFinding[];
  /**
   * E — the derived plan → track → verify → report artifact for this turn.
   * Assembled from RECORDED evidence (plan store, tool outcomes, honesty
   * flags), never from the model's narration, so a caller/dashboard can show
   * the trust verdict instead of inferring it. Absent only on paths that never
   * ran the loop (a refused/no-model fallback).
   */
  turnReport?: TurnReport;
}> {
    // `'default'` is the config SENTINEL for "use the provider's default
    // model", never a real model id. Left in place it (a) disables auto routing
    // (isAutoModel('default') is false) and (b) is truthy, so the adapter's
    // `options?.model || requireAdapterModel(...)` fallback is skipped and the
    // literal string 'default' reaches the provider → "model not found".
    const requestedModel = opts.model && opts.model !== 'default' ? opts.model : undefined;
    const activeOpts = applyActiveModel({ provider: opts.provider, model: requestedModel });
    const mergedOpts = { ...opts, provider: activeOpts.provider, model: activeOpts.model };
    // When the CALLER supplies neither a provider nor a model — the dashboard
    // chat console and the gateway chat engine both call answerOnce with just a
    // message — fall back to the CONFIGURED defaultProvider instead of letting
    // resolveProvider() land on one fixed provider.
    //
    // Why this matters (live, 2026-09-20): the shipped config default is
    // `defaultProvider: "auto"`, but auto mode was only ever enabled by an
    // EXPLICIT 'auto' from the flags or the `nuvira model switch` state. The
    // dashboard passes neither, so every dashboard turn silently ran on ONE
    // concrete provider with NO auto-failover walk (the non-auto path only
    // walks `fallback.providers`, which ships empty). One 400/429/timeout then
    // ended the turn with the canned "the language model was unavailable"
    // line — while the CLI answered the identical prompt, because the CLI
    // resolves auto from the same config. Same engine, two modes: this closes
    // that gap.
    // Only the AUTO default changes behavior: a concrete `defaultProvider` is a
    // deliberate pin and keeps the non-auto path exactly as it is.
    if (!mergedOpts.provider && !mergedOpts.model) {
      try {
        const cfg = this.configManager.getAll() as { defaultProvider?: string };
        if (isAutoProvider(cfg.defaultProvider)) {
          mergedOpts.provider = cfg.defaultProvider;
        }
      } catch {
        // Best-effort — an unreadable config leaves the previous behavior.
      }
    }
    // A8 — a CONCRETE provider with `-m auto` means that provider's own auto
    // (e.g. an OmniRoute combo), NOT our auto-route. isAgentAutoRoute excludes
    // that case so the pin reaches the provider instead of being re-routed.
    let autoMode = isAgentAutoRoute(mergedOpts.provider, mergedOpts.model);
    let { type, provider } = autoMode
      ? await this.getProvider({})
      : await this.getProvider(mergedOpts);
    let model = mergedOpts.model;
    // B — captured from the route so the post-route capability gate below can
    // judge the FINAL pair without re-resolving anything.
    let routeVerdict:
      | {
          complexity: string;
          agenticCapable?: boolean;
          taskProfile?: { intent?: string; requiresVerification?: boolean };
        }
      | undefined;
    // C6 — the turn's economy window, taken before the FIRST provider call. The
    // turn report states what THIS turn cost from the persisted ledger; a
    // continuation or a resumed turn runs in a fresh process, so a session
    // counter would report zero for it (`costSince` reads timestamps instead).
    const turnCostSince = Date.now();

    let routedText: string | undefined;
    if (autoMode) {
      // Intent-aware escalation: a bare "yes"/"do it" continuing software work
      // routes on the prior ask, not on the signal-free continuation. When
      // there is no such hint the call is byte-identical to before.
      const routingText = continuationSoftwareText(message, opts.history ?? []) ?? undefined;
      const routed = routingText
        ? await this.routeMessageAuto(message, [], { routingText })
        : await this.routeMessageAuto(message);
      type = routed.type;
      provider = routed.provider;
      model = routed.model;
      routedText = routingText;
      routeVerdict = {
        complexity: routed.complexity,
        agenticCapable: routed.agenticCapable,
        taskProfile: routed.taskProfile,
      };
    }
    // P3 — tell the GUI where the turn is headed before the tool loop runs.
    const isLocalFallback = autoMode && type === 'local';
    const localWarning = isLocalFallback
      ? ' ⚠️ local model only — run `nuvira models` or `nuvira provider set` to add a cloud provider'
      : '';
    opts.onProgress?.(`   🧠 routed to ${provider.name}${model ? ` / ${model}` : ''} — working…${localWarning}`);

    // ── Workstream B — agentic capability gate (consent-first) ──────────────
    // The router RECORDED a verdict (A1); the turn must ACT on it. A software/
    // agentic ask must never silently run on a weak model. Consent is per
    // SESSION: one answer covers this session, and a new chat/task asks again.
    //
    // Interactive = an injected askUser (the dashboard console) or a real TTY.
    // A piped/headless run never reaches the ask — it falls to the configured
    // policy, whose default (`deny`/retry) can never silently downgrade.
    if (autoMode && routeVerdict && routeVerdict.agenticCapable === false) {
      const sessionId = opts.debugSession;
      const interactive = Boolean(opts.askUser) || Boolean(process.stdin.isTTY);
      const policy = resolveWeakModelPolicy(this.configManager);
      const asDecision = {
        complexity: routeVerdict.complexity as never,
        taskProfile: (routeVerdict.taskProfile ?? {
          intent: 'unknown',
          requiresVerification: false,
        }) as never,
        provider: type,
        model: model ?? '',
        agenticCapable: false,
      };
      let gate = assertAgenticRoute(asDecision, { sessionId, policy, interactive });
      if (gate.action === 'ask') {
        try {
          const ask =
            opts.askUser ??
            (await import('../tools/ask-user.js')).renderAskUser;
          const answer = await ask(
            `This is a software task, but only a weak model is available ` +
              `(${provider.name}${model ? ` / ${model}` : ''}). How should I proceed for this session?`,
            [
              { label: 'Approve the weak model for this session' },
              { label: 'Wait for a strong model only' },
            ] as never,
            false,
          );
          const granted = Number((answer as { index?: number }).index) === 0;
          if (sessionId) setWeakModelConsent(sessionId, granted ? 'granted' : 'denied');
          gate = { ...gate, action: granted ? 'proceed-weak-consented' : 'retry-strong' };
        } catch {
          // No answer reachable — treat as deny (never a silent downgrade).
          gate = { ...gate, action: 'retry-strong' };
        }
      }
      if (gate.action === 'retry-strong') {
        // Try ONE re-route that EXCLUDES the weak provider; accept it only if
        // the returned pair is genuinely agentic-capable. Nothing capable →
        // refuse honestly rather than run the weak model against consent.
        let next: AutoRoutedMessage | null = null;
        try {
          next = routedText
            ? await this.routeMessageAuto(message, [type], { routingText: routedText })
            : await this.routeMessageAuto(message, [type]);
        } catch {
          next = null;
        }
        if (next && isAgenticCapableModel(next.model, next.type)) {
          type = next.type;
          provider = next.provider;
          model = next.model;
          opts.onProgress?.(
            `   🧠 re-routed to an agentic-capable model: ${provider.name}${model ? ` / ${model}` : ''}`,
          );
        } else {
          return {
            content:
              gate.notice ??
              'No agentic-capable model is available for this software task right now.',
            followups: [],
            generationFailed: true,
            refused: true,
            provider: type,
            model,
            transport: 'none' as const,
          };
        }
      } else if (gate.notice) {
        // proceed-weak-consented — say so plainly; never a silent weak model.
        opts.onProgress?.(`   ${gate.notice}`);
      }
    }

    // P4 — when a project is attached, recall its prior sessions + facts
    // FRESH per turn (the snapshot is cached, the recall is not — prior work
    // may have landed since the last turn). Best-effort: empty recall injects
    // nothing, a recall failure never breaks the turn (maybeAutoRecall never
    // throws).
    let recallBlock: string | undefined;
    if (opts.projectPath) {
      try {
        const recall = await maybeAutoRecall(opts.projectPath, this.configManager.getWorkspaceStore());
        if (recall) recallBlock = recallContextBlock(recall);
      } catch {
        recallBlock = undefined;
      }
    }

    const parsed = parseRequestSync(message);
    const dispatchDecision = resolvePipelineDispatch(parsed, { dev: opts.dev, text: message });
    const answer = await this.runChatAnswer(
      message,
      opts.history ?? [],
      { type, provider, model },
      { provider: mergedOpts.provider, model: mergedOpts.model, dev: mergedOpts.dev, cache: true },
      true,
      { auto: autoMode },
      parsed,
      { askUser: opts.askUser, onProgress: opts.onProgress, onToolCall: opts.onToolCall, onPlanChange: opts.onPlanChange, onGitDiff: opts.onGitDiff, onSkillDraft: opts.onSkillDraft, onFinding: opts.onFinding, planStore: opts.planStore ?? this.planStore, gateway: opts.gateway, projectContext: opts.projectContext, recallContext: recallBlock, projectPath: opts.projectPath, onToken: opts.onToken, signal: opts.signal, continuation: opts.continuation, systemPolicy: opts.systemPolicy, debugSurface: opts.debugSurface ?? 'cli-chat', debugSession: opts.debugSession, worktree: opts.worktree, keepWorktree: opts.keepWorktree, resume: opts.resume },
    );

    // No-model fallback: the tool loop could not generate a single response
    // AND the rules assessed a high-confidence pipeline intent — run the
    // pipeline directly (rules decide only when the model is unavailable; the
    // pipeline resolves its own working provider/model).
    // WS5 (#27) — `!answer.refused` is not an optimisation, it is the guard: a
    // turn that REFUSED to run (see `runChatAnswer`) is failed, but it is not
    // UNANSWERED, and the no-model fallback exists for the second case. Re-
    // dispatching it here would run the ask on another engine entirely — the one
    // path that can run it UNISOLATED while the caller asked for isolation.
    if (answer.generationFailed && !answer.refused && dispatchDecision.dispatch && !dispatchDecision.needConfirm) {
      // E2 — this CHANGES THE EXECUTION MODEL: the ask leaves the single chat tool
      // loop and runs as a multi-agent pipeline. Falling back is legitimate
      // (nothing was generated), but it must never be silent. A pinned ask that
      // flips engines without saying so is the same defect as an unattended
      // auto-pick reported as the user's own choice: the user is owed the reason
      // and the fact that their pin is the pair being carried over.
      opts.onProgress?.(
        `   ⤵️ the chat turn produced no answer on ${provider.name}${model ? ` / ${model}` : ''} — ` +
          `running this ask in the multi-agent pipeline instead (a different execution model` +
          `${autoMode ? '' : ', on the same pinned pair'})`,
      );
      const r = await runPipelineTool(message, this.configManager, { provider: type, model, board: false });
      // `success`, not `error`: a pipeline that RAN and failed reports its
      // outcome in `summary` and only sometimes sets `error`, so keying off
      // `error` alone returned a failed run's summary with NO failure flag —
      // i.e. reported it as a successful turn on every surface.
      if (!r.success) {
        return {
          content: '',
          followups: [],
          generationFailed: true,
          provider: type,
          model,
          transport: 'none' as const,
          // WS5 — the isolation/resume this turn had, carried even on this path:
          // the worktree was made and measured before the fallback ran, and a
          // caller that never hears about it cannot tell an isolated turn from one
          // that ran in the real tree.
          ...this.turnEnvelopeOf(answer),
        };
      }
      // A pipeline turn carries no tool transport at all — reported as `none`
      // rather than left silent, so a caller can tell "no transport" apart from
      // "this surface never said".
      return {
        content: r.result?.summary ?? '',
        followups: [],
        provider: type,
        model,
        transport: 'none' as const,
        ...this.turnEnvelopeOf(answer),
      };
    }

    // E1 — assemble the turn report from RECORDED evidence (plan store, tool
    // outcomes, honesty flags). Derived, never narrated, so the trust verdict
    // cannot be talked up by the model.
    let turnReport: TurnReport | undefined;
    try {
      const planSnapshot = (opts.planStore ?? this.planStore).snapshot?.() ?? null;
      turnReport = buildTurnReport({
        goal: message,
        plan: planSnapshot,
        toolCalls: answer.toolCalls,
        successfulToolCalls: answer.successfulToolCalls,
        mutations: answer.runTrace?.mutations,
        changedPaths: answer.runTrace?.paths,
        // E1 — decisions the harness took on the user's behalf (an unattended
        // ask_user default), so the report discloses them instead of letting the
        // answer read as a choice the user made.
        assumptions: answer.runTrace?.assumptions,
        // C6 — what the turn cost, from the ledger, so an expensive turn is visible
        // where the turn is described instead of only in a session total.
        cost: (() => {
          const spend = costSince(turnCostSince);
          return { usd: spend.costUsd, tokens: spend.tokens, calls: spend.requests };
        })(),
        flags: {
          unverifiedActionClaim: answer.unverifiedActionClaim,
          unverifiedEdit: answer.unverifiedEdit,
          unverifiedEditClaim: answer.unverifiedEditClaim,
          unverifiedBuildClaim: answer.unverifiedBuildClaim,
          undeliveredArtifact: answer.undeliveredArtifact,
          unfulfilledPromise: answer.unfulfilledPromise,
          noActionTaken: answer.noActionTaken,
          // Bundle 19 — the artifact's own admission travels to the report, so the
          // turn cannot read as finished work on any surface that shows it.
          incompleteArtifactClaim: Boolean(answer.artifactIncomplete),
          // Bundle 20 — a fabricated "I wrote the file" reaches the report for the
          // same reason: no surface may read such a turn as finished work.
          unverifiedFileClaim: Boolean(answer.unverifiedFileClaim),
        },
      });
    } catch {
      // A report must never break the turn.
    }
    // E-trace — persist the report on the turn's reasoning trace so it is
    // reviewable after the fact (the Trace tab renders it), not only in this
    // turn's return value. Best-effort: a trace write never breaks a turn.
    recordTurnReport(answer.traceId, turnReport);
    // Feed the MEASURED outcome back into the bandit on the CHAT path too. The
    // orchestrator has done this for pipeline tasks all along; the chat turn —
    // the product's most common entry point — never did, so every turn's real
    // result was thrown away and the router learned from only one of its two
    // execution models. The signal is the turn report's derived VERIFICATION
    // verdict, never the model's own account of itself.
    //
    // Guarded exactly like the orchestrator: only when this turn was AUTO-routed
    // (otherwise `getLastProvider` could reward a stale provider noted by an
    // earlier auto run in this process) and only when bandit learning is on.
    if (autoMode && this.configManager.getAll().routing?.bandit !== false) {
      const observation = turnOutcomeObservation(turnReport);
      if (observation) {
        try {
          getAutoRouter().recordOutcome(
            'chat',
            message,
            observation.outcome,
            this.configManager,
            observation.outcomeData,
          );
        } catch {
          // Learning is best-effort — never break a turn on a bandit error.
        }
        // Bundle 3b: the SAME derived verdict also feeds the capability
        // scorecard's accuracy parameter for the pair that actually served the
        // turn. One translation of "did the work verify", two consumers — rather
        // than a second, parallel notion of success that could drift from it.
        // `blocked`/`not-applicable` write nothing (see the registry method).
        try {
          if (type && model) {
            getModelRegistry().recordCapabilityEvidence(
              type,
              model,
              turnReport?.verification ?? 'not-applicable',
            );
          }
        } catch {
          // Learning is best-effort — never break a turn on a scorecard write.
        }
      }
    }
    // E3 — surface a non-trivial report on the console. A plain answer (no
    // plan, nothing changed) produces no summary and stays silent.
    if (turnReport?.summary) {
      opts.onProgress?.(formatTurnReport(turnReport));
    }

    // E3b: strip raw suggest_followups JSON embedded in content by the model
    const cleanContent = stripToolCallArtifacts(answer.content || '');
    return {
      content: cleanContent,
      followups: answer.followups ?? [],
      ...(turnReport ? { turnReport } : {}),
      generationFailed: answer.generationFailed,
      cancelled: answer.cancelled,
      bounded: answer.bounded,
      toolCalls: answer.toolCalls,
      unverifiedActionClaim: answer.unverifiedActionClaim,
      unfulfilledPromise: answer.unfulfilledPromise,
      undeliveredArtifact: answer.undeliveredArtifact,
      unverifiedBuildClaim: answer.unverifiedBuildClaim,
      // Bundle 19/20 — the reliability flags must not be dropped at this
      // boundary, or a caller re-deriving the verdict would see a clean turn.
      artifactIncomplete: answer.artifactIncomplete,
      unverifiedFileClaim: answer.unverifiedFileClaim,
      // WS1 — the findings this turn recorded (empty when it recorded none).
      findings: answer.findings ?? [],
      provider: type,
      model,
      // R2 — the transport the loop's model-call seam reported for this turn.
      transport: answer.transport,
      // WS5 — and the isolation/resume the turn had. The engine reports them on
      // ITS result; this method builds a new object, so without this spread they
      // were dropped at the boundary — measured as a surface that isolated its
      // turn correctly and then told its caller nothing about it.
      ...this.turnEnvelopeOf(answer),
      // WS5 — and whether the turn refused to run at all, for the same reason:
      // a caller that cannot tell a refusal from a failed generation retries it,
      // and there is nothing to retry (see the refusal return in `runChatAnswer`).
      ...(answer.refused ? { refused: true } : {}),
    };
  }

  /**
   * WS5 (#27) — the isolation/resume facts of a finished turn, in the shape this
   * command's callers read.
   *
   * Extracted because THREE returns in `answerOnce` hand back a turn the engine
   * produced (the final answer, and the two no-model pipeline fallbacks), and a
   * fact that travelled on only one of them would be a capability that disappears
   * exactly when the model was unavailable — which is a failure mode, not an edge
   * case.
   */
  private turnEnvelopeOf(answer: {
    worktree?: IsolationOutcome;
    resume?: ResumeOutcome;
  }): { worktree?: IsolationOutcome; resume?: ResumeOutcome } {
    return {
      ...(answer.worktree ? { worktree: answer.worktree } : {}),
      ...(answer.resume ? { resume: answer.resume } : {}),
    };
  }

  create(): Command {
    const command = new Command('chat')
      .description('Start an interactive chat session with AI')
      .argument('[prompt]', 'Optional initial prompt')
      .option('-f, --file <path>', 'Include file content as context')
      .option('-p, --provider <provider>', 'Inference provider to pin this chat to')
      .option('-m, --model <model>', 'Model to pin this chat to (if omitted, an interactive picker will appear)')
      .option('--no-cache', 'Disable response caching')
      .option('-d, --dev', 'Always dispatch requests to the coding pipeline (no confirmation)', false)
      // WS5 (#27) — isolation and partial resume, as the two things an operator
      // asks for by hand. Both default to OFF and both are also readable from the
      // environment (`NUVIRA_ISOLATE` / `NUVIRA_RESUME`), which is how the
      // surfaces with no command line ask.
      // NO `false` DEFAULT on any of the three, and that is load-bearing: commander
      // would then hand this command `worktree: false` for a flag the operator never
      // typed, an explicit FALSE outranks the environment in
      // `resolveIsolationRequest`, and `NUVIRA_ISOLATE=1` would be silently ignored
      // on the one surface whose flags outrank it. Absent is `undefined` — "nobody
      // said" — which is what lets the environment ask for these on the CLI too.
      .option(
        '--worktree',
        'Run this turn in its own git worktree of the project and report the diff against the base commit. Refuses rather than running unisolated when the directory cannot be isolated (also asked for by NUVIRA_ISOLATE=1)',
      )
      .option('--keep-worktree', 'Keep the isolated worktree after the turn instead of removing it')
      .option(
        '--resume [id]',
        'Replay the recorded steps of this ask whose input is unchanged instead of paying for them again (defaults to the record for this goal + directory; also asked for by NUVIRA_RESUME=1)',
      )
      .addHelpText(
        'after',
        '\nModel routing:\n' +
          '  Pinning -p/--provider (and -m/--model) does NOT stop the router from falling\n' +
          '  over to another model if the pinned one is unavailable — auto routing takes\n' +
          '  over and the turn says so. To work with the pinned model ONLY, set\n' +
          '  NUVIRA_STRICT_MODEL=1: a dead pin then fails with a message naming the pair\n' +
          '  instead of substituting another model.\n',
      )
      .action(async (prompt?: string, options?: { file?: string; provider?: string; model?: string; cache?: boolean; dev?: boolean; worktree?: boolean; keepWorktree?: boolean; resume?: string | boolean }) => {
        await this.execute(prompt, options || {});
      });

    return command;
  }

  /**
   * WS5 (#27) — the isolation/resume request the CLI's own flags carry.
   *
   * One place, because three call sites in this command hand the request to the
   * shared engine (the one-shot turn, its picked followups, and every REPL
   * message) and a request that reached only some of them would be a flag that
   * worked until the second message. `undefined` (no flag) is passed through as
   * `undefined` rather than `false`, which is what lets the environment ask for
   * isolation on a surface the CLI did not.
   */
  private ws5Overrides(options?: {
    worktree?: boolean;
    keepWorktree?: boolean;
    resume?: string | boolean;
  }): { worktree?: boolean; keepWorktree?: boolean; resume?: string | boolean } {
    return {
      worktree: options?.worktree,
      keepWorktree: options?.keepWorktree,
      resume: options?.resume,
    };
  }

  private async execute(prompt?: string, options?: { file?: string; provider?: string; model?: string; cache?: boolean; dev?: boolean; worktree?: boolean; keepWorktree?: boolean; resume?: string | boolean }): Promise<void> {
    // Apply the active model state from `nuvira model switch` as defaults
    const activeOpts = applyActiveModel({ provider: options?.provider, model: options?.model });
    const mergedOpts = { ...options, provider: activeOpts.provider, model: activeOpts.model };

    // ── The CONFIG's defaultProvider is a routing directive too ──────────────
    // When the operator supplies neither a provider nor a model — no `-p`, no
    // `-m`, no `nuvira model switch` state — the config decides, and the shipped
    // default is `defaultProvider: "auto"`. This is the CLI's counterpart to the
    // block in `answerOnce` (see `chat-answer-once-auto-parity.test.ts`, which
    // pinned the dashboard/gateway side of it in 2026-09-20).
    //
    // WHY IT IS LOAD-BEARING, measured 2026-10-06: `execute` — the whole CLI
    // entry (`-t/--task`, `chat "<task>"`, the REPL) — did NOT honour it. With
    // neither flag nor active-model state, `autoMode` was `false`, so the turn
    // took the NON-auto path and `resolveProvider(config, undefined)` resolved
    // `defaultProvider: "auto"` through `rankAvailableProviders()` to ONE
    // concrete provider. Everything downstream of the auto router was therefore
    // skipped on the product's most common entry point: no `routeMessageAuto`
    // (so no routing-history row to audit which model served the turn, no
    // routing cache, and no capability gate), no pin pre-flight, and
    // `model explain` — which DOES use the auto router — predicting a model the
    // runtime never used. Measured with `NUVIRA_TRACE_ROUTE=1`: a `-t` turn
    // logged `[TRACE] execute {"autoMode":false,"type":"groq"}` and appended
    // ZERO rows to routing-history.
    //
    // Only the AUTO default changes behaviour: an explicit `-p`/`-m` or a
    // `model switch` pin is a deliberate choice and keeps the non-auto path
    // exactly as it is (and is checked FIRST, so a pin can never be re-routed).
    if (!mergedOpts.provider && !mergedOpts.model) {
      try {
        const cfg = this.configManager.getAll() as { defaultProvider?: string };
        if (isAutoProvider(cfg.defaultProvider)) mergedOpts.provider = cfg.defaultProvider;
      } catch {
        // Best-effort — an unreadable config leaves the previous behavior.
      }
    }

    // ── Auto routing mode: agent decides the best provider/model per message ──
    // A8 — a pinned concrete provider with `-m auto` is the provider's own auto,
    // not ours. See isAgentAutoRoute.
    let autoMode = isAgentAutoRoute(mergedOpts.provider, mergedOpts.model);
    let { type, provider } = autoMode
      ? await this.getProvider({})
      : await this.getProvider(mergedOpts);
    let model = mergedOpts.model;

    // In interactive mode (no prompt), show the model picker if no --model was specified
    if (!model && !prompt) {
      const picked = await this.showModelPicker();
      if (!picked) return;

      // ── Auto picked — enable per-message routing ──────────────────────────
      // NEVER hand 'auto' to resolveProvider(): it would hit the "Unknown
      // provider 'auto'" fallback and silently pick the default provider
      // (e.g. OpenRouter with no key → 401). Auto is a routing directive, so
      // we set autoMode and resolve a concrete route below instead.
      if (picked.provider === 'auto' || isAutoModel(picked.model)) {
        autoMode = true;
      } else {
        if (picked.provider !== type) {
          const resolved = resolveProvider(this.configManager, picked.provider);
          type = resolved.type;
          provider = resolved.provider;
        }
        model = picked.model;
      }
    }

    // ── Auto mode: resolve a concrete initial route for the header + gate ──
    // (Each real message re-routes via routeMessageAuto before generating.)
    if (autoMode) {
      const routed = await this.routeMessageAuto('chat session');
      type = routed.type;
      provider = routed.provider;
      model = routed.model;
    }

    const available = await provider.isAvailable();
    if (!available) {
      logger.error(`${provider.name} is not available. Check your configuration.`);
      logger.info(`Run: agent-nuvira config --help`);
      return;
    }

    // ── Setup SIGINT (Ctrl+C) handler for graceful exit ──────────────
    // When readline is active (user is typing), Ctrl+C byte is consumed by readline's
    // raw mode — the process-level SIGINT never fires. So we put the double-press
    // logic inside readline's SIGINT handler instead (see readMultiLineInput).
    //
    // This process-level handler fires when the user is NOT in readline (e.g., during
    // API calls). A single Ctrl+C during an API call aborts it immediately.
    const sigintHandler = () => {
      console.log('\n');
      process.exit(0);
    };
    process.on('SIGINT', sigintHandler);

    const cacheEnabled = options?.cache !== false;

    // Shared state for both single-shot + interactive paths.
    const history: Array<{ role: string; content: string }> = [];
    let effectiveModelForHistory = model || this.configManager.getProviderConfig(type as ProviderType).config.model || 'default';
    let effectiveModel = effectiveModelForHistory;
    this.devModeAuto = false;

    // K1: one chat session = one sessionId — created once, threaded through
    // the memory session AND every log line emitted by this session's turns.
    const chatSessionId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Phase B2: begin the persistent-memory session (provider.initialize).
    // The chat loop records each completed turn; endSession on exit distills
    // the buffered turns into project facts. Best-effort, fire-and-forget.
    try {
      await getMemoryManager().startSession(chatSessionId);
    } catch {
      // Best-effort — memory must never break chat startup.
    }

    if (prompt) {
      // ── Auto routing for single-shot prompts ────────────────────────────
      if (autoMode) {
        const routed = await this.routeMessageAuto(prompt);
        type = routed.type;
        provider = routed.provider;
        model = routed.model;
      }


      // E3c: model-decides — EVERY request runs as a TOOL-CALL TURN. The
      // model decides what to do; the rule assessment is NOT in its context
      // (4d30b7e) and acts ONLY as the no-model fallback below (generation
      // failed entirely), never as a bypass.
      const parsed = parseRequestSync(prompt);
      const dispatchDecision = resolvePipelineDispatch(parsed, { dev: options?.dev, text: prompt });

      const answer = await this.runChatAnswer(
        prompt,
        [],
        { type, provider, model },
        options || {},
        cacheEnabled,
        { auto: autoMode },
        parsed,
        // WS5 (#27) — isolation and resume ride on the CLI's own flags. Passed
        // per turn: in the REPL each message is its own turn (see the manual).
        this.ws5Overrides(options),
      );

      // No-model fallback: the tool loop could not generate a single response
      // AND the rules assessed a high-confidence pipeline intent — run the
      // pipeline directly (rules decide only when the model is unavailable;
      // the pipeline resolves its own working provider/model).
      // WS5 — never on a REFUSED turn: the pipeline would run it in the real tree
      // (see the guard in `answerOnce`).
      if (answer.generationFailed && !answer.refused && dispatchDecision.dispatch && !dispatchDecision.needConfirm) {
        // E2 — same rule as `answerOnce`: the engine changes here, so say so.
        logger.info(
          `   ⤵️ the chat turn produced no answer on ${provider.name}${model ? ` / ${model}` : ''} — ` +
            `running this ask in the multi-agent pipeline instead (a different execution model` +
            `${autoMode ? '' : ', on the same pinned pair'})`,
        );
        await runDeveloperMode(prompt, this.configManager, { provider: type, model });
        // After pipeline execution, show followups and continue conversation
        // (don't just return — keep user engaged with next steps)
        if (!process.stdin.isTTY) {
          return;
        }
        // Seed history with the pipeline result so followups have context
        history.push({ role: 'user', content: prompt });
        // Continue to interactive mode (don't return)
        logger.info('');
      }

      // Ordering: the ANSWER is always printed first, then followups — the
      // user asked for the content, not a menu. On a real terminal the
      // followups are SELECTABLE: picking a number runs that followup as the
      // next turn (conversation threaded), pressing Enter continues interactively.
      // Non-TTY (scripts/CI/pipes) keeps the current print-and-exit behavior
      // so automation is never blocked by a prompt.
      //
      // Print parity with the dashboard console + gateway: the answer must not
      // carry the model's tool-call artifacts (a raw trailing suggest_followups
      // JSON blob, or the empty ```json fence the fallback transport leaves
      // behind) — see stripToolCallArtifacts.
      else if (answer.content.trim()) {
        console.log('\n' + stripToolCallArtifacts(answer.content) + '\n');
      }
      if (!process.stdin.isTTY) {
        await this.renderFollowups(answer.followups ?? [], false);
        return;
      }
      // Seed the continuation history with turn 1 so a picked followup has
      // context (runChatAnswer pushes the user message itself).
      history.push(
        { role: 'user', content: prompt },
        ...(answer.content.trim() ? [{ role: 'assistant' as const, content: answer.content }] : []),
      );
      let singleAnswer = answer;
      while (true) {
        const picked = await this.renderFollowups(singleAnswer.followups ?? [], true);
        if (!picked) break;
        const next = await this.runChatAnswer(
          picked,
          history,
          { type, provider, model },
          options || {},
          cacheEnabled,
          { auto: autoMode },
          parseRequestSync(picked),
          // P5 — a picked followup continues the previous execution.
          { continuation: true, ...this.ws5Overrides(options) },
        );
        const nextText = stripToolCallArtifacts(next.content);
        if (nextText) {
          console.log('\n' + nextText + '\n');
          // NOTE: no history.push here — runChatAnswer already recorded the
          // assistant turn. The old duplicate push gave every subsequent turn
          // TWO copies of the previous answer (relevance noise).
        }
        singleAnswer = next;
      }
      // Fall through to interactive mode — the user can keep chatting.
      logger.info('');
    }

    logger.highlight(`\n🧠 Buff Chat — ${autoMode ? '🤖 Auto routing' : provider.name}`);
    if (autoMode) {
      logger.info('Model: auto (best provider/model picked per message)');
    } else if (model) {
      logger.info(`Model: ${model}`);
    }
    logger.info(`Type your messages, or /help for commands, /exit to quit.`);
    logger.info(`💡 Tip: every request runs through the agent loop — the model decides what to do (code, fix, docs, publish, analysis). /dev prefers file-creating actions.\n`);

    // D2: agent-driven background duties — one-line health + models status at
    // session start (throttled, best-effort). The agent does them, not the user.
    if (!prompt) {
      await maybeRunBackgroundDuties(this.configManager).catch(() => { /* best-effort */ });
    }

    let pendingMessage: string | undefined;
    // P5 — the followups the agent just suggested, so a message that MATCHES
    // one of them (a clicked chip, or the user re-typing it on the gateway) is
    // recognised as a continuation of the previous execution.
    let lastFollowups: FollowupSuggestion[] = [];
    while (true) {
      // E3b: a chosen follow-up recommendation becomes the next message.
      const pickedFollowup = pendingMessage !== undefined;
      const message = pendingMessage ?? (await this.readMultiLineInput('You:'));
      pendingMessage = undefined;
      if (!message) continue;

      if (message.startsWith('/')) {
        // K1: /commands also ride the session correlation.
        const result = await withLogCorrelation({ sessionId: chatSessionId }, () =>
          this.handleCommand(message, provider, model, type),
        );
        if (result.exit) break;
        if (result.auto) {
          autoMode = true;
          logger.success('🤖 Auto routing enabled — agent picks the best model per message');
          console.log('');
        } else if (result.newProvider) {
          type = result.newType!;
          provider = result.newProvider;
          model = result.newModel;
          effectiveModel = result.newModel || effectiveModelForHistory;
          effectiveModelForHistory = effectiveModel;
          autoMode = false; // explicit picker choice overrides auto routing
          logger.success(`✅ Switched to ${provider.name} / ${model}`);
          console.log('');
        }
        continue;
      }

      // ── Auto routing: pick the best provider/model for this message ──────
      // Runs BEFORE the dev-mode check so a creation request in auto mode uses
      // the routed provider/model — never a literal 'auto' or a stale default.
      if (autoMode) {
        // M2.5: estimate the growing conversation (prior turns + this message)
        // so context-fit routing reacts to a long session, not just the task
        // text. Estimation only — never a hard block.
        const historyEstimate = estimateTokens(
          history.map((h) => h.content).join('\n') + '\n' + message,
        );
        // Intent-aware escalation for a bare continuation of software work.
        const routingText = continuationSoftwareText(message, history) ?? undefined;
        const routed = await this.routeMessageAuto(message, [], {
          contextHintTokens: historyEstimate,
          ...(routingText ? { routingText } : {}),
        });
        type = routed.type;
        provider = routed.provider;
        effectiveModel = routed.model;
        effectiveModelForHistory = effectiveModel;
        model = effectiveModel;
      }

      // E3c: model-decides — EVERY message runs as a TOOL-CALL TURN; the model
      // decides what to do. The rule assessment is a
      // HINT in the model context — never a bypass. Rules act ONLY as the
      // no-model fallback below (generation failed entirely + high-confidence
      // pipeline intent), never to skip the loop. K1: the sessionId rides on
      // every log line from this turn's processing.
      // K2: rule-vs-LLM latency budget — time the C1 rule path (intent
      // parse + dispatch assessment) and the model path (tool-loop answer)
      // separately so the budget is measurable.
      const parsed = recordMetricTime('rule.parse.ms', () => parseRequestSync(message));
      const dispatchDecision = recordMetricTime('rule.dispatch.ms', () =>
        resolvePipelineDispatch(parsed, { dev: this.devModeAuto, text: message }),
      );
      const session = { type, provider, model: effectiveModel };
      const answer = await withLogCorrelation({ sessionId: chatSessionId }, () =>
        recordMetricTime('llm.answer.ms', () =>
          this.runChatAnswer(
            message,
            history,
            session,
            options || {},
            cacheEnabled,
            { auto: autoMode },
            parsed,
            // P5 — a picked followup (or a typed one that matches the last
            // suggestions) is a continuation, not a fresh independent request.
            {
              continuation: pickedFollowup || isSuggestedFollowup(message, lastFollowups),
              ...this.ws5Overrides(options),
            },
          ),
        ),
      );

      // No-model fallback: the tool loop could not generate a single response
      // AND the rules assessed a high-confidence pipeline intent — run the
      // pipeline directly (rules decide only when the model is unavailable).
      // WS5 — never on a REFUSED turn, for the same reason as above.
      if (answer.generationFailed && !answer.refused && dispatchDecision.dispatch && !dispatchDecision.needConfirm) {
        await runDeveloperMode(message, this.configManager, { provider: type, model });
        // After pipeline execution, continue conversation (don't just ask "press Enter")
        // The user can keep chatting or type /exit
        continue;
      }
      type = session.type;
      provider = session.provider;
      effectiveModel = session.model;
      effectiveModelForHistory = session.model || effectiveModelForHistory;
      model = effectiveModel;
      // Ordering: deliver the ANSWER first, then the follow-up menu (the
      // followup pick becomes the next message). The user asked for the
      // content — the menu must never print before it.
      if (answer.content.trim()) {
        console.log('\n' + answer.content + '\n');
      }
      lastFollowups = answer.followups ?? [];
      const followupPrompt = await this.renderFollowups(lastFollowups, true);
      if (followupPrompt) {
        pendingMessage = followupPrompt;
      }
      console.log('');
      continue;
    }

    // Cleanup SIGINT handler
    process.off('SIGINT', sigintHandler);

    // Phase B2: end the persistent-memory session — buffered turns are
    // distilled into project facts (best-effort; never blocks the exit path).
    try {
      await getMemoryManager().endSession();
    } catch {
      // Best-effort — memory extraction must never break chat exit.
    }

    // K2: persist runtime metrics (rule/LLM latency, memory hits/misses)
    // accumulated during this chat session.
    try {
      getMetrics().save();
    } catch {
      // Best-effort — a metrics write must never break chat exit.
    }

    // Store chat session in history when exiting
    if (history.length > 0) {
      try {
        const historyMessages = history.map((h) => ({
          role: h.role as 'user' | 'assistant',
          content: h.content,
          timestamp: Date.now(),
        }));
        const chatHistory = getChatHistory();
        const sessionId = chatHistory.storeSession(
          historyMessages,
          type,
          effectiveModelForHistory,
          true,
          deriveProjectId(process.cwd()).id,
        );
        logger.debug(`Chat session stored: ${sessionId}`);
        // Phase A2: workspace continuity — record the session in the project
        // registry (the last user goal + last assistant summary + session id)
        // so `nuvira doctor` and the D1 auto-recall can show what this project
        // was last working on. Best-effort — a workspace write must never
        // affect the chat exit path.
        try {
          const lastUser = [...history].reverse().find((h) => h.role === 'user');
          const lastAssistant = [...history].reverse().find((h) => h.role === 'assistant');
          this.configManager.getWorkspaceStore().recordRun({
            cwd: process.cwd(),
            goal: lastUser?.content || 'chat session',
            summary: lastAssistant?.content,
            sessionId,
          });
        } catch (wsErr) {
          logger.debug(`Workspace record failed (non-critical): ${wsErr}`);
        }
      } catch (err) {
        // Non-critical — history storage failure shouldn't affect user experience
        logger.debug(`Failed to store chat session: ${err}`);
      }
    }

    // Actually exit the process — Commander keeps the event loop alive otherwise
    process.exit(0);
  }

  /**
   * E3b — run one chat answer as a TOOL-CALL TURN.
   *
   * The model may call ask_user (clarify), verify_requirement, the pipeline
   * tools (build/repair/resume), and must end with suggest_followups (3
   * followups, the contract). Native tool-calling when the provider
   * supports it; JSON fallback otherwise. Carries the legacy generation
   * machinery forward: auto-mode failover + shared fallback chain inside
   * callModel, caching, memory recording, and registry telemetry.
   *
   * Returns the final content + followups as DATA — the CALLER prints the
   * content first, then renders the followup menu (answer-first ordering;
   * interactive mode turns a chosen followup into the next message).
   */
  private async runChatAnswer(
    message: string,
    history: Array<{ role: string; content: string }>,
    session: { type: string; provider: InferenceProvider; model: string | undefined },
    options: { file?: string; provider?: string; model?: string; cache?: boolean; dev?: boolean },
    cacheEnabled: boolean,
    mode: { auto: boolean },
    parsed?: ParsedRequest,
    ctxOverrides?: {
      askUser?: ToolContext['askUser'];
      onProgress?: (line: string) => void;
      /**
       * Cluster G — the surface says this turn has NO workspace: the dashboard
       * attached no folder, the user named none in the message, and no
       * `dashboard.cwd` is configured. Reaches the tool context as
       * `workspaceUnscoped`, which makes a write ASK where to put the file
       * instead of dropping it into `process.cwd()`. The CLI never sets it — a
       * CLI turn runs in the user's own directory, which is a real workspace.
       */
      unscopedWorkspace?: boolean;
      /**
       * P0.6 — live step cards: called once per tool-call lifecycle.
       * `started` fires BEFORE execution (with the call id + args), `called`
       * after (ok/error + duration + result). The dashboard console forwards
       * these as structured `tool` events so the GUI renders each tool call
       * as a card, not just a progress line.
       */
      onToolCall?: (phase: 'started' | 'called', info: ToolCallInfo) => void;
      /**
       * P0.7 — plan checklist: called on every plan_todo mutation with the
       * structured snapshot. The dashboard console forwards it as a `plan`
       * event so the GUI's checklist card updates IN PLACE.
       */
      onPlanChange?: (snapshot: import('../tools/plan-store.js').PlanSnapshot) => void;
      /**
       * P3b — git diff card: called when the git tool runs `git diff` with
       * the structured per-file payload (rendered as a diff card).
       */
      onGitDiff?: (payload: import('../tools/git-tool.js').GitDiffPayload) => void;
      /**
       * P6a — skill draft card: called when skill_manage create/patch emits
       * the structured draft payload (rendered as the /learn preview card
       * with accept / edit / reject).
       */
      onSkillDraft?: (payload: import('../tools/skill-tool.js').SkillDraftPayload) => void;
      /**
       * P0.7 — the session's plan store (per-session in the dashboard, one
       * per ChatCommand instance here as the default).
       */
      planStore?: import('../tools/plan-store.js').PlanStoreLike;
      /**
       * Session 3 — channel/format policy merged into the STABLE (system)
       * layer rather than re-injected into every user turn. See
       * `answerOnce`'s `systemPolicy`.
       */
      systemPolicy?: string;
      /** Live gateway for gateway_send (gateway-triggered chat answers reuse the connected bridge). */
      gateway?: ToolContext['gateway'];
      /**
       * P3 — bounded project snapshot injected as a `[Project context]`
       * message right after the system prompt (the dashboard attaches a
       * project; the CLI runs in one already).
       */
      projectContext?: string;
      /**
       * P4 — the recalled `[Recalled project context]` block (prior sessions
       * + facts for the attached project), fresh per turn. Injected after the
       * project snapshot.
       */
      recallContext?: string;
      /**
       * P4 — the attached project's directory path. When set, the tool
       * context's cwd is scoped to this directory so file tools (read_files,
       * write_file, str_replace, etc.) and terminal commands resolve
       * relative to the project root — the dashboard's equivalent of the
       * CLI running inside the project.
       */
      projectPath?: string;
      /**
       * P4 — stream answer tokens live to the GUI (dashboard opt-in; the CLI
       * never passes it). Delivered verbatim from the tool loop — see
       * ToolLoopOptions.onToken.
       */
      onToken?: (token: string) => void;
      /**
       * P4 — external cancellation (the dashboard Cancel button): passed to
       * the tool loop so an in-flight provider request aborts and the turn
       * stops at the next loop boundary.
       */
      signal?: AbortSignal;
      /**
       * P5 — the message is a picked FOLLOWUP: prepend the continuation marker
       * to the model-facing thread so the previous turn's execution is in
       * scope. History keeps the raw text (marker never accumulates).
       */
      continuation?: boolean;
      /** WS1 — a finding was recorded this turn (see the emit forwarding). */
      onFinding?: (finding: WireFinding) => void;
      /** WS2 — the surface label for the session debug log header. */
      debugSurface?: string;
      /** WS2 — the conversation this turn belongs to (see `answerOnce`). */
      debugSession?: string;
      /**
       * WS5 (#27) — ask this turn to run in its own git worktree of the project.
       * The lifecycle (create, measure the diff, tear down) is run HERE, around
       * the whole turn, because this method is the seam every in-process surface
       * shares. `undefined` defers to the environment.
       */
      worktree?: boolean;
      /** WS5 (#27) — keep the worktree after the turn (its path is reported either way). */
      keepWorktree?: boolean;
      /**
       * WS5 (#27) — ask this turn to resume: replay the recorded steps whose
       * input is unchanged instead of paying for them again. `undefined` defers
       * to the environment, which is how a deployment (or the parity harness)
       * asks every turn on a surface.
       */
      resume?: string | boolean;
    },
  ): Promise<{
    content: string;
    generationFailed?: boolean;
    /**
     * WS5 (#27) — the turn REFUSED to run: nothing was attempted, no model was
     * called, and `content` is the reason. Always with `generationFailed`, and
     * never interchangeable with it (see the fallback guard in `answerOnce`).
     */
    refused?: boolean;
    /** P4 — true when the turn was cancelled via the signal (discarded). */
    cancelled?: boolean;
    /** Phase 4 — true when the loop hit its step bound before an end turn. */
    bounded?: boolean;
    /** P3 — followups as data (the dashboard chat console renders them as chips). */
    followups?: FollowupSuggestion[];
    /** Names of the tools that actually executed (honest-action checks). */
    toolCalls?: string[];
    /** True when the answer claimed a delivery no delivery tool performed. */
    unverifiedActionClaim?: boolean;
    /** True when the answer closed on a promise the turn never carried out. */
    unfulfilledPromise?: boolean;
    /** G13b — asked for an authored file and wrote none (see the gate). */
    undeliveredArtifact?: boolean;
    /** A3 Part 2 — a build ran, failed, and the answer claimed it worked. */
    unverifiedBuildClaim?: boolean;
    /**
     * Bundle 19 — a file this turn WROTE declares that its own content was omitted
     * (measured: a 25-word "design document" reading `## 1. Introduction ... (full
     * content omitted for brevity) ...`, reported as complete). The artifact admits
     * it is incomplete, so the turn must not read as finished work.
     */
    artifactIncomplete?: { path: string; statement: string };
    /**
     * Bundle 20 — the answer asserted a file was written while the turn wrote
     * nothing. Surfaced to the caller so no surface replays it as settled.
     */
    unverifiedFileClaim?: boolean;
    /**
     * R2 — the tool transport this turn travelled on (`native` / `json` /
     * `none`), as the loop reported it. Absent only when no loop ran (a cache
     * replay, or a turn that died before a model call).
     */
    transport?: 'native' | 'json' | 'none';
    /**
     * WS1 — every finding this turn recorded, in call order, already gated.
     * `[]` is a real answer ("this surface reports findings, and there were
     * none"), which is what lets five surfaces be compared honestly.
     */      findings?: WireFinding[];
    /**
     * E — honest "what happened" facts the TurnReport is derived from (see
     * `learning/turn-report.ts`). Exposed so the report is built from records,
     * not from the answer text.
     */
    successfulToolCalls?: string[];
    runTrace?: import('../learning/run-trace.js').RunTraceSnapshot;
    /**
     * E-trace — the reasoning trace this turn was recorded under, so a caller
     * that assembles the TurnReport AFTER the turn (as `answerOnce` does) can
     * attach it to the same trace. Absent only when no trace was opened.
     */
    traceId?: string;
    unverifiedEdit?: boolean;
    unverifiedEditClaim?: boolean;
    noActionTaken?: boolean;
    /**
     * WS5 (#27) — the isolation this turn had, and the diff against its base.
     * Present only when isolation was asked for AND the turn happened; a refused
     * turn reports the refusal as its content instead.
     */
    worktree?: IsolationOutcome;
    /** WS5 (#27) — what this turn's resume replayed, and what it saved. */
    resume?: ResumeOutcome;
  }> {
    // WS2 (#24) — the optional session debug log for this turn. Null unless
    // `NUVIRA_DEBUG_LOG` is set, so the off path is one boolean check; when on,
    // the events below are redacted and bounded, and the file is written at the
    // END so its header can name the backend that actually served the turn.
    const debugLog = sessionDebugLog({
      surface: ctxOverrides?.debugSurface ?? 'cli-chat',
      goal: message,
      ...(ctxOverrides?.debugSession ? { session: ctxOverrides.debugSession } : {}),
      backend: { engine: 'loop', provider: session.type, ...(session.model ? { model: session.model } : {}) },
    });
    // ── The pair this surface RESOLVED is not the pair that served ───────────
    // MEASURED (2026-10-07): one log read `# backend.provider: local` /
    // `# backend.model: qwen2.5:0.5b` while its own first event said
    // `turn.start {"provider":"gemini"}`. Neither field was computed wrongly —
    // the header names the pair that ACTUALLY served (via `lastAttempt`, updated
    // by the provider walk and written at close) and this event named the pair
    // the turn was CONFIGURED with, before any walk. But a lone `provider` field
    // in an event called `turn.start` reads as "the turn started on gemini", so
    // the honest fix is to say which question each field answers: this one is the
    // REQUESTED route, and `turn.end` now carries the served one from the same
    // expression as the header, so the two can never disagree.
    debugLog?.event('turn.start', {
      requested: session.model ? `${session.type}/${session.model}` : session.type,
    });

    // WS3 (#25) — the turn's span root, when span export is on (else null). Same
    // identity as the log's: one surface, one conversation, one turn.
    const otelSpan = await startTurnSpan({
      surface: ctxOverrides?.debugSurface ?? 'cli-chat',
      ...(ctxOverrides?.debugSession ? { session: ctxOverrides.debugSession } : {}),
      goal: message,
    });

    /**
     * The workspace this turn is ABOUT: the attached project when one was given,
     * else this process's own cwd — the same directory `projectDir`/`turnCwd`
     * below resolve to, computed HERE because the response cache needs it.
     *
     * Without it in the cache key, an answer was reused across projects: "what's
     * the current status of this project?" asked in project B replayed the report
     * generated in project A, and because the replayed text is a confident,
     * well-formed answer about a real tree, it read as the agent ignoring the
     * attached folder. Scoping the key makes every cached answer a statement
     * about one directory.
     */
    const turnScope = ctxOverrides?.projectPath || process.cwd();

    // Cache check first (same as the legacy path).
    const cache = getCache();
    const cacheModel = this.cacheModelFor(session);
    if (cacheEnabled) {
      try {
        // #30 — read the entry WITH its recorded activity, not just the text: a
        // replay that dropped `toolCalls` rendered no tool cards on the dashboard
        // while the first run did, so a repeated prompt read as a turn that did
        // nothing. The text alone is still what the answer is; the activity is
        // reported so the surface is honest about what the cached turn DID.
        const cached = await cache.getEntry(message, cacheModel, session.type, turnScope);
        if (cached) {
          // NOTE: the cached answer is NOT printed here — the caller prints
          // content AFTER runChatAnswer returns (answer-first ordering). A
          // print here would show the answer before the turn's own progress
          // lines AND double-print it.
          history.push({ role: 'user', content: message });
          history.push({ role: 'assistant', content: cached.response });
          this.memoryNoteTurn(message, cached.response);
          // WS2 — a cache replay reached no model, so the log says exactly that
          // rather than borrowing an attribution from a turn that did not run.
          // The workspace the replayed answer belongs to is recorded with the hit:
          // a cache replay does no work, so "which project is this answer about?"
          // is the one fact needed to tell a replay from a real turn.
          debugLog?.event('cache.hit', { chars: cached.response.length, scope: turnScope });
          const cacheNotice = debugLogNotice(ctxOverrides?.debugSurface ?? 'cli-chat', debugLog?.write() ?? null);
          if (cacheNotice) logger.info(cacheNotice);
          return {
            content: cached.response,
            ...(cached.toolCalls ? { toolCalls: cached.toolCalls } : {}),
            ...(cached.successfulToolCalls ? { successfulToolCalls: cached.successfulToolCalls } : {}),
            ...(cached.bounded ? { bounded: cached.bounded } : {}),
          };
        }
      } catch {
        // Cache must never break the turn.
      }
    }

    // ─── WS5 (#27) — ISOLATION AND RESUME, the whole turn's envelope ────────
    //
    // HERE, and not in each caller, because this is the seam every in-process
    // surface already shares: the CLI's interactive REPL and one-shot answer, the
    // dashboard console, the gateway's inbound chat and `execute`'s direct-answer
    // arm all reach the tool loop through this method. A wrapper in each caller
    // would be four copies of one policy, and the one that drifted would be the
    // surface that quietly ran in the real tree.
    //
    // It sits AFTER the response-cache check on purpose: a cached answer does no
    // work, so there is nothing to isolate and no step to replay — paying for a
    // git checkout to replay a cached string would be pure cost.
    /**
     * Where a WS5 notice goes: the surface's own progress channel when it has one
     * (the dashboard renders it, the gateway logs it), else this process's log.
     *
     * Deliberately NOT `ctxOverrides.onProgress` directly: the CLI passes no
     * progress sink for a one-shot turn, and a notice that reached nothing would
     * hide exactly the facts it exists for — which directory the turn is isolated
     * in, and what it changed.
     */
    const report =
      ctxOverrides?.onProgress ?? ((line: string): void => void logger.info(line));
    // Same directory the cache key above is scoped to (see `turnScope`) — one
    // resolution per turn, so the cached answer and the work cannot disagree
    // about which project the turn belongs to.
    const projectDir = turnScope;
    const isolationRequest = resolveIsolationRequest({
      worktree: ctxOverrides?.worktree,
      keepWorktree: ctxOverrides?.keepWorktree,
    });
    const isolation = beginIsolation({ request: isolationRequest, repoCwd: projectDir, label: message });
    if (isolation && !isolation.ok) {
      // REFUSED, not degraded: the operator asked for isolation on purpose, and a
      // turn that ran unisolated while its result said otherwise would be the one
      // outcome this capability exists to prevent. Reported as a FAILED turn, so
      // no surface presents it as an answer.
      report(isolation.refusal);
      return {
        content: isolation.refusal,
        followups: [],
        // BOTH flags, and they say different things. `generationFailed` keeps the
        // turn a FAILED one, so no surface renders the refusal as an answer.
        // `refused` says WHY it failed — the turn never ran, no model was called —
        // and that distinction is load-bearing: the caller's no-model fallback
        // keys off `generationFailed` alone, so without this a refused turn was
        // silently re-dispatched to the PIPELINE, which ran the ask in the real
        // tree. Measured: `nuvira chat "write a file…" --worktree` outside a git
        // repository printed a three-task pipeline board and never mentioned the
        // refusal — the exact outcome isolation exists to prevent.
        generationFailed: true,
        refused: true,
      };
    }
    const worktree = isolation?.ok ? isolation.worktree : null;
    /**
     * The directory this turn works in: the worktree when isolated, the attached
     * project when one was given, else the process's own cwd.
     *
     * EVERY path that resolves a directory from here on reads this — the tools'
     * `cwd`, the ambient project snapshot, the working-state ledger — because a
     * turn that is isolated for its tools but reads its context from the original
     * tree is not isolated, it is confused.
     */
    const turnCwd = worktree?.dir ?? projectDir;
    // The ledger is only opened when a resume was asked for (a `--resume`, or the
    // environment asking for every turn on this surface). An ordinary turn never
    // touches the record store: no read, no write, no directory created.
    const resumeRequest = resolveResumeRequest({ resume: ctxOverrides?.resume });
    const resume: OpenResume | null = resumeRequest
      ? openResume({ goal: message, cwd: turnCwd, resume: resumeRequest })
      : null;
    if (worktree) report(worktreeNotice(worktree));
    // WS5 — what the RECORD holds, said before the turn. The outcome (what was
    // replayed, what it cost) is reported in `finish` below, where it is knowable —
    // this line used to state the outcome here, which meant every resumed turn
    // announced "nothing to replay" before it had tried anything.
    if (resume) report(resume.ledger.openNotice());
    /**
     * Attach this turn's isolation and resume outcomes to whatever it returns.
     *
     * A helper at every return rather than a `finally`, because the outcomes have
     * to ride ON the result a caller is waiting for: a diff reported later (or by
     * a separate command) is a diff most callers never see, and `endIsolation`
     * never throws, so a cleanup failure cannot replace the turn's own answer
     * with a git error.
     */
    const finish = <T,>(result: T): T & { worktree?: IsolationOutcome; resume?: ResumeOutcome } => {
      const extra: { worktree?: IsolationOutcome; resume?: ResumeOutcome } = {};
      if (worktree) {
        const outcome = endIsolation(worktree, { keep: isolationRequest.keep });
        extra.worktree = outcome;
        report(outcome.notice);
      }
      if (resume) {
        const outcome = closeResume(resume, { goal: message, cwd: turnCwd });
        extra.resume = outcome;
        // The wording lives in `ResumeOutcome.notice` — one sentence, every
        // surface, including the reason when nothing replayed.
        report(outcome.notice);
      }
      return { ...result, ...extra };
    };

    history.push({ role: 'user', content: message });

    // System prompt: base identity + the tool contract — the
    // model clarifies with ask_user and ends every response with followups.
    //
    // NO rule-based intent steering goes in here (commit 4d30b7e removed it on
    // purpose: "give the LLM tools and let it decide"). `dispatchDecision` is
    // computed for the generation-FAILED fallback only — it does NOT reach the
    // prompt, so on this surface the MODEL decides and the rules are invisible.
    const systemText = buildToolSystemPrompt(parsed);

    // Skill hint — MODE-DEPENDENT (see resolveSkillHintMode):
    //   - `match` (default) — the small keyword-matched hint: ONE skill, and
    //     only when the goal really matches; otherwise nothing. This is the
    //     3.3.10 behaviour and keeps the prompt small.
    //   - `catalog` (opt-in) — the full name+description catalog, which lets the
    //     MODEL pick a skill but costs ~24K chars on every turn, so it must be
    //     chosen (`NUVIRA_SKILL_CATALOG=catalog` or `skills.catalogHint`).
    //   - `off` — never inject one.
    // Best-effort: any failure returns '' and the turn proceeds byte-identically.
    let skillHint = '';
    try {
      const { buildConfiguredSkillHint, markLoopSkillUsed } = await import(
        '../tools/loop-skill-hint.js'
      );
      const injected: { value: import('../tools/loop-skill-hint.js').LoopSkillHintMatch | null } = {
        value: null,
      };
      skillHint = await buildConfiguredSkillHint(message, this.configManager, injected);
      await markLoopSkillUsed(injected.value);
    } catch {
      skillHint = ''; // best-effort — a hint failure never breaks the turn
    }

    // `-f/--file` file-context parity: the legacy generateWithContext loaded
    // + retrieval-reduced file context. Inject it as a context message before
    // the user's message so the tool-loop path keeps the flag working.
    let fileContext: string | null = null;
    if (options.file) {
      try {
        const parser = new ContextParser();
        const fileCtx = parser.parseFromFiles([options.file]);
        const fileCtxStr = ContextParser.formatContext(fileCtx);
        const retrievalOpts = retrievalOptionsFromConfig(this.configManager);
        const { context: reduced, stats } = await assembleContext(
          message,
          [options.file],
          fileCtxStr,
          retrievalOpts,
        );
        recordRetrievalStats(stats);
        fileContext = reduced;
      } catch {
        // A file-context failure must never break the turn.
        fileContext = null;
      }
    }

    // Ambient project context (assessment v4 Phase 1.4 — CLI twin of the
    // dashboard's project snapshot): when no explicit projectContext was
    // provided and the cwd looks like a project, build the bounded
    // file-tree + git-digest + assessment block. Best-effort: '' injects
    // nothing, a failure never breaks the turn.
    let ambientProjectContext: string | undefined;
    if (!ctxOverrides?.projectContext) {
      try {
        const built = await buildLoopProjectContext(turnCwd);
        if (built) ambientProjectContext = built;
      } catch {
        ambientProjectContext = undefined;
      }
    }

    // Phase 1 — deterministic, tag-scoped knowledge. A message that OPENS with
    // `#tag` retrieves that tag's relevant passages and puts them in front of
    // the model before the question. It is INERT otherwise: with no marker (or
    // with no tags defined at all) the builder returns an empty block WITHOUT
    // touching the embedder, so a turn that did not ask for a document is
    // byte-identical to one from a build without this feature — no extra cost,
    // no extra noise, and never a wrong corpus. Dynamically imported so the
    // retrieval modules are not loaded on a turn that will not use them, the
    // same best-effort contract as the ambient project context above. See
    // src/learning/knowledge-turn.ts for what the guarantee rests on.
    let knowledgeBlock = '';
    try {
      const { buildKnowledgeTurnContext } = await import('../learning/knowledge-turn.js');
      const knowledge = await buildKnowledgeTurnContext(message);
      knowledgeBlock = knowledge.block;
    } catch {
      knowledgeBlock = ''; // best-effort — a retrieval failure never breaks the turn
    }

    // G4 — carry THIS project's working state (files changed, verification debt,
    // user-reported regressions) into the turn, so the model does not re-derive
    // what previous turns already established. This is the fix for the
    // calculator session's core drift (it re-diagnosed the same root cause six
    // times, then undid its own earlier fixes).
    // G4 — the ledger is a claim about a PROJECT, so it is only read for a
    // directory that can honestly be one. A home directory (or a filesystem
    // root) is a container of unrelated checkouts: injecting its ledger as
    // "THIS project's" working state is how "what's the state of this project?"
    // came back describing an NVDA add-on nobody had mentioned. See
    // isProjectLedgerDir.
    const workingStatePath = turnCwd;
    const workingStateBlock = isProjectLedgerDir(workingStatePath)
      ? formatWorkingState(getWorkingState(workingStatePath))
      : '';

    // Session 3 — channel/format policy lives in the STABLE layer. It is
    // identical on every message, so keeping it here makes the system prompt
    // byte-stable (prompt-cacheable) AND removes it from the volatile user
    // turn, where it used to occupy ~80% of the ask on WhatsApp turns.
    const systemPolicyBlock = ctxOverrides?.systemPolicy ? `\n\n${ctxOverrides.systemPolicy}` : '';
    const thread: ToolMessage[] = [
      { role: 'system', content: systemText + systemPolicyBlock + skillHint },
      // P3 — the attached project's bounded snapshot (path + file tree +
      // symbol map) rides in before the conversation, exactly like --file
      // context: the model knows what it is looking at without being told.
      // v4: the CLI now gets the same treatment via the ambient builder
      // (loop-project-context.ts) when no explicit snapshot was provided.
      ...(ctxOverrides?.projectContext
        ? [{ role: 'user' as const, content: `[Project context]\n${ctxOverrides.projectContext}` }]
        : ambientProjectContext
          ? [{ role: 'user' as const, content: `[Project context]\n${ambientProjectContext}` }]
          : []),
      // Phase 1 — the tagged knowledge this ask selected, when it selected one.
      // It sits with the other CONTEXT blocks (before the history) so the
      // conversation stays contiguous, and it is a USER-TURN message rather than
      // system text, so the system prompt stays byte-stable and cacheable.
      ...(knowledgeBlock ? [{ role: 'user' as const, content: knowledgeBlock }] : []),
      // P4 — the recalled project context (prior sessions + facts) rides in
      // next, so the model starts from what this project was last doing.
      ...(ctxOverrides?.recallContext
        ? [{ role: 'user' as const, content: ctxOverrides.recallContext }]
        : []),
      // G4 — the deterministic working-state ledger (never a summary).
      ...(workingStateBlock ? [{ role: 'user' as const, content: workingStateBlock }] : []),
      ...(fileContext
        ? [{ role: 'user' as const, content: `[File context]\n${fileContext}` }]
        : []),
      ...history
        .slice(0, -1)
        .map((h) => ({
          role: (h.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
          content: h.content,
        })),
      // P5 — a picked followup reaches the model WITH the continuation marker
      // (the raw text stays in history), so "add a day in Hanoi" is resolved
      // against the plan the previous turn just produced instead of being read
      // as a brand-new request.
      { role: 'user', content: ctxOverrides?.continuation ? buildFollowupContinuationPrompt(message) : message },
    ];

    // I3: one artifact session per TURN — every tool
    // deliverable in this turn lands in the same store folder.
    const artifactSessionId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Tiered tool exposure (assessment v3/v4): when `tools.loopExposure` is
    // 'tiered', the loop exposes only the CORE primitives on the wire and
    // domain toolsets load mid-turn via tool_search — the Set below is the
    // loader channel the tool writes and the loop reads. 'all' (default)
    // keeps the pre-tiering behavior byte-identical.
    const loadedExtraTools = new Set<string>();
    // G3 — the files this turn mutates, observed on the tool event stream so
    // the ledger can remember them (the loop reports tool NAMES, not paths).
    const touchedFiles = new Set<string>();
    /**
     * WS1 — the findings this turn RECORDED, in call order.
     *
     * Collected from the same `finding:recorded` event the GUI hears, so the
     * result the caller returns and the live card a user watches are fed by one
     * source rather than two that can disagree. Empty is a real answer ("this
     * surface reports findings, and this turn recorded none"), never silence.
     */
    const findings: WireFinding[] = [];
    /**
     * G18 — the turn's trace id, for the autonomy-gate events that tools emit
     * DURING the loop. Assigned a few lines below (the trace begins once the
     * thread and tool surface exist); the emit can only fire from tool
     * execution, which is strictly after that assignment.
     */
    let traceIdForEvents: string | undefined;
    const toolContext: ToolContext = {
      configManager: this.configManager,
      loadedExtraTools,
      // P4 — when a project is attached, scope tools to its root so the
      // agent operates inside the project (not the dashboard server's cwd).
      cwd: turnCwd,
      // Cluster G — the surface's own verdict on whether `turnCwd` is the
      // user's workspace. `false` means this is an unscoped turn (no attachment,
      // no folder named in the message, no configured default), so `turnCwd` is
      // the dashboard process's own directory — a place that belongs to nobody.
      // A write there must ask; see `unscopedWriteRefusal` in coding-tools.ts.
      ...(ctxOverrides?.unscopedWorkspace ? { workspaceUnscoped: true } : {}),
      // P7 — is a PERSON watching this turn? It decides `run_terminal`'s DEFAULT
      // command timeout (60s here vs 120s unattended): two minutes of silence in
      // front of someone is not patience, it is a bug — the live run spent four
      // minutes on back-to-back 120-second timeouts while the console showed
      // nothing, then gave up.
      interactive: Boolean(ctxOverrides?.askUser) || Boolean(process.stdin.isTTY),
      emit: (event, data, source) => {
        // G3 — collect mutated file paths from `tool:started` (which carries
        // the arguments) so the working-state ledger knows what changed.
        if (event === 'tool:started') {
          const t = data as { tool?: string; args?: Record<string, unknown> } | undefined;
          if (t?.tool === 'edit_file' || t?.tool === 'write_file') {
            const p = t.args?.path ?? t.args?.file_path ?? t.args?.file;
            if (typeof p === 'string' && p) touchedFiles.add(p);
          }
        }
        // P0.6 — forward tool-call lifecycle events to the GUI before they
        // reach the bus (the bus drives hooks; the override drives the card
        // stream). Other events keep flowing to the bus untouched.
        if (ctxOverrides?.onToolCall && (event === 'tool:started' || event === 'tool:called')) {
          ctxOverrides.onToolCall(event === 'tool:started' ? 'started' : 'called', data as ToolCallInfo);
        }
        // WS2 — the same lifecycle into the session debug log: a bug report
        // needs the tool NAMES and their outcomes, in order. `write()` is never
        // called here (the log is buffered and written once at turn end); this
        // records, it does not persist per call.
        if (debugLog && (event === 'tool:started' || event === 'tool:called')) {
          const call = data as { tool?: string; ok?: boolean } | undefined;
          if (call?.tool) {
            debugLog.event(event === 'tool:started' ? 'tool.start' : 'tool.end', {
              tool: call.tool,
              ...(call.ok === undefined ? {} : { ok: call.ok }),
            });
          }
        }
        // P0.7 — forward plan mutations to the GUI (structured checklist).
        if (event === 'plan:changed') {
          const snapshot = data as import('../tools/plan-store.js').PlanSnapshot;
          if (ctxOverrides?.onPlanChange) {
            ctxOverrides.onPlanChange(snapshot);
          } else {
            // No GUI consumer (the interactive CLI): show the PROGRESS TABLE in
            // the terminal so a user watching the run sees the plan advance,
            // not just the model's narration. A settled plan prints its
            // achieved SUMMARY instead — the same text the turn closes on.
            const store = ctxOverrides?.planStore ?? this.planStore;
            const settled =
              snapshot.steps.length > 0 &&
              snapshot.steps.every((s) => s.status === 'done' || s.status === 'blocked');
            const rendered = settled ? store.summary?.() : store.toTable?.();
            if (rendered) logger.info(`\n${rendered}\n`);
          }
        }
        // P3b — forward git diff payloads to the GUI (the diff card).
        if (ctxOverrides?.onGitDiff && event === 'git:diff') {
          ctxOverrides.onGitDiff(data as import('../tools/git-tool.js').GitDiffPayload);
        }
        // P6a — forward skill draft payloads to the GUI (the /learn preview
        // card with accept / edit / reject).
        if (ctxOverrides?.onSkillDraft && event === 'skill:draft') {
          ctxOverrides.onSkillDraft(data as import('../tools/skill-tool.js').SkillDraftPayload);
        }
        // WS1 — a finding the turn recorded. Kept on this surface's own result
        // (so a caller that never sees the GUI still gets the verdict) AND
        // forwarded to the caller's live view, one event, two readers.
        if (event === FINDING_EVENT) {
          const finding = data as WireFinding;
          findings.push(finding);
          ctxOverrides?.onFinding?.(finding);
          // WS2 — a verdict is exactly the kind of fact a bug report is missing.
          debugLog?.event('finding', `${finding.verdict} ${finding.claim}`);
          // WS3 — and a span EVENT rather than a span: a finding has no
          // duration, so a point-in-time fact is the honest shape for it.
          otelSpan?.event('nuvira.finding', {
            'nuvira.verdict': finding.verdict,
            'nuvira.claim': finding.claim,
            'nuvira.outcome': finding.outcome,
          });
        }
        // G18 — an autonomy gate DECIDING to proceed is a fact about the turn
        // ("this change was applied without asking, and here is why"), not just
        // a bus notification: record it on the turn's trace so the decision is
        // auditable after the fact.
        if (event === 'autonomy:write-applied' && traceIdForEvents) {
          const d = data as { tool?: string; reason?: string } | undefined;
          recordTraceEvent(traceIdForEvents, {
            kind: 'gate',
            gate: 'autonomy',
            ...(d?.tool ? { tool: d.tool } : {}),
            summary: d?.reason
              ? `proceeded without asking — ${d.reason}`
              : 'proceeded without asking — the request itself was the authorization',
          });
        }
        getEventBus().emit(event as never, data, source);
      },
      // P3 — the dashboard chat console injects a NON-TTY ask_user renderer
      // (inquirer would hang on the server's piped stdin); the CLI keeps the
      // default interactive renderer.
      ...(ctxOverrides?.askUser ? { askUser: ctxOverrides.askUser } : {}),
      ...(ctxOverrides?.gateway ? { gateway: ctxOverrides.gateway } : {}),
      // P0.7 — the plan store. This was DROPPED here: `answerOnce` put a
      // per-session store on `ctxOverrides.planStore`, but only askUser/gateway
      // were threaded into the tool context, so every surface fell back to the
      // shared module store — which is why plans leaked across sessions and a
      // reload started a blank checklist. Thread it (per-session when injected,
      // else this command's project-scoped store).
      planStore: ctxOverrides?.planStore ?? this.planStore,
      // C2 verify with the actual session model (verify_requirement tool).
      callLLM: (prompt, opts) =>
        session.provider.generate(prompt, { ...(opts as Record<string, unknown> | undefined), model: session.model }),
      // I3: tools that return {artifact, result} deliverables are recorded to
      // the per-turn artifact session. Best-effort — a persistence failure
      // must never break the turn.
      artifacts: {
        push: (a) => {
          try {
            new ArtifactStore().append(artifactSessionId, a);
            logger.debug(`artifact: ${a.kind} '${a.title}' → ${a.path}`);
          } catch {
            // best-effort
          }
        },
      },
    };
    const callModel = this.buildToolCallModel(
      message,
      session,
      options,
      mode,
      ctxOverrides?.onToken,
      ctxOverrides?.signal,
      continuationSoftwareText(message, history) ?? undefined,
    );

    let result: ToolLoopResult;
    // v1.8x audit — CHAT TRACE CAPTURE: every LLM call in a chat turn is now
    // recorded to ~/.nuvira/memory/reasoning-traces.json (source 'chat'), so
    // the dashboard's Trace tab shows WHY a WhatsApp/Telegram/console answer
    // came from the provider+model it did — not just pipeline runs. The tool
    // loop drives calls through buildToolCallModel; wrapping it with
    // withTraceCapture would double-record (it already wraps at its own
    // creation sites), so the loop's onEvent stream is instead correlated by
    // prompt digest here — one record() per call, deduped.
    const chatTraceId = beginTrace({
      goal: message.slice(0, 200),
      source: 'chat',
      provider: session.type,
      model: session.model,
    });
    // G18 — the tool-context emit (declared above) now has somewhere to write.
    traceIdForEvents = chatTraceId;
    // A2 — record the routing DECISION as a first-class event, so a turn that
    // ran on a weak/incapable model is self-evident in the Trace tab. The
    // failed Tauri turn had no such record; this is the instrument that would
    // have shown `agenticCapable:false` at the moment of the choice.
    if (this.lastRouteSnapshot) {
      const snap = this.lastRouteSnapshot;
      recordTraceEvent(chatTraceId, {
        kind: 'decision',
        gate: 'routing',
        summary:
          `routed to ${snap.provider}/${snap.model} ` +
          `(complexity ${snap.complexity}, score ${snap.score.toFixed(3)})` +
          (snap.agenticCapable === false
            ? ` — NOT agentic-capable${snap.overrideReason ? ` (${snap.overrideReason})` : ''}`
            : ''),
        routing: snap,
      });
    }
    // D1 — measure the OUTBOUND context and, past the ceiling, degrade the
    // lowest-value optional contributor first (skill hint → work digest →
    // recall → …). The identity/tool contract is never trimmed. This is the
    // guard the 3.3.11 bloat (7.6K → 32.8K chars) never had.
    try {
      const contextBudget = resolvePromptBudget(this.configManager);
      const historyChars = history.reduce((n, h) => n + (h.content?.length ?? 0), 0);
      const report = measurePromptBudget(
        [
          { name: 'system:identity+tool-contract', chars: systemText.length },
          { name: 'system:channel-policy', chars: systemPolicyBlock.length },
          { name: 'skill-hint', chars: skillHint.length, dropPriority: 10 },
          { name: 'working-state', chars: workingStateBlock.length, dropPriority: 25 },
          { name: 'recall', chars: ctxOverrides?.recallContext?.length ?? 0, dropPriority: 30 },
          {
            name: 'project-context',
            chars: ctxOverrides?.projectContext?.length ?? ambientProjectContext?.length ?? 0,
            dropPriority: 40,
          },
          { name: 'file-context', chars: fileContext?.length ?? 0, dropPriority: 45 },
          { name: 'history+ask', chars: historyChars },
        ],
        { budget: contextBudget },
      );
      // Apply the FIRST ladder step (the documented, safe one): drop the skill
      // hint from the assembled system message.
      if (report.trims.includes('skill-hint') && skillHint) {
        thread[0] = { role: 'system', content: systemText + systemPolicyBlock };
      }
      if (report.level !== 'ok') {
        recordTraceEvent(chatTraceId, {
          kind: 'decision',
          gate: 'context-budget',
          summary:
            formatPromptBudgetBreakdown(report) +
            (report.trims.length ? ` — trimmed: ${report.trims.join(', ')}` : ''),
        });
      }
    } catch {
      // A budget measurement must never break the turn.
    }
    // The instant this turn's model walk began. A failed generation records the
    // WALK (below) relative to this mark, so the trace can say what was tried. 
    const modelWalkMark = Date.now();
    // P4 — a fresh attempt log for this turn (the report is about what THIS turn
    // tried, never a stale list from an earlier one).
    this.turnAttempts = [];
    const seenStepDigests = new Set<string>();
    const digestPrompt = (p: string): string => {
      try { return createHash('sha256').update(p).digest('hex').slice(0, 16); } catch { return String(p.length); }
    };
    const recordChatStep = (prompt: string, output: string, latencyMs: number, ok: boolean, error?: string): void => {
      try {
        const digest = digestPrompt(prompt);
        if (seenStepDigests.has(digest)) return;
        seenStepDigests.add(digest);
        // FIX: build a promptPreview that includes the user's actual message.
        // The old `prompt.slice(0, 300)` only showed the system prompt (which
        // is 2K+ chars with tool schemas), hiding the user's input entirely.
        const lastUserIdx = prompt.lastIndexOf('[User]\n');
        const promptPreview = lastUserIdx !== -1
          ? `${prompt.slice(0, 80)}…\n\n${prompt.slice(lastUserIdx)}`.slice(0, 500)
          : prompt.slice(0, 300);
        // G5 — the REAL per-call model/provider (post-failover) and the
        // Auto-router snapshot, plus estimateTokens (the old chars/4 estimate
        // misreported usage). Falls back to the session default only when no
        // attempt was recorded (e.g. a cached/offline step).
        recordStep(chatTraceId, {
          agentType: 'chat',
          description: message.slice(0, 120),
          // Session 3 — the FULL prompt feeds the layered digests and the
          // one-time stable-layer capture (see `promptFull` in recordStep).
          promptFull: prompt,
          provider: this.lastAttempt?.provider || session.type,
          model: this.lastAttempt?.model || session.model || 'unknown',
          promptDigest: digest,
          promptPreview,
          responsePreview: output.slice(0, 1000),
          responseLength: output.length,
          inputTokens: estimateTokens(prompt),
          outputTokens: estimateTokens(output),
          latencyMs,
          success: ok,
          error,
          ...(mode.auto && this.lastRouteSnapshot ? { routing: this.lastRouteSnapshot } : {}),
        });
      } catch {
        // Best-effort — a trace write must never break the turn.
      }
    };
    const callModelWithTrace: ToolLoopDeps['callModel'] = async (threadMsgs, schemas2, tok, sig) => {
      const start = Date.now();
      const prompt = threadMsgs.map((m) => (m.role === 'system' ? `[System]\n${m.content}` : m.role === 'user' ? `[User]\n${m.content}` : m.role === 'assistant' ? `[Assistant]\n${m.content}` : `[Tool result]\n${m.content}`)).join('\n\n');
      try {
        const resp = await callModel(threadMsgs, schemas2, tok, sig);
        recordChatStep(prompt, resp.content ?? '', Date.now() - start, true);
        return resp;
      } catch (err) {
        recordChatStep(prompt, '', Date.now() - start, false, err instanceof Error ? err.message : String(err));
        throw err;
      }
    };
    /**
     * P2 (fix_model_routing) — MID-TURN MODEL HANDOFF.
     *
     * The tool loop calls this when the model serving the turn resolved with
     * NOTHING usable (no answer text, no tool call) and has already had its one
     * retry. Until now that case re-asked the SAME model: a live dashboard run
     * took five consecutive empty responses from `local/gpt-oss:120b-cloud` and
     * ended as `bounded` with zero tool calls, while a healthy Gemini model sat
     * configured and unused — the user had to say "retry". The loop owns the
     * retry policy; this owns the POOL.
     *
     * Order of business, and why:
     *   1. Exclude the pair that returned nothing — MODEL-scoped, never the
     *      provider. Free tiers meter per model, so the provider's next-best
     *      model is usually perfectly healthy, and `pushCandidate` in the deep
     *      pool already honours this model-scoped exclusion set.
     *   2. Auto turns re-resolve through the same deep pool the first route used,
     *      first WITHOUT excluding the provider (its sibling models are the
     *      cheapest, lowest-latency handoff) and then WITH it, so a provider
     *      whose only models are dead is genuinely left behind.
     *   3. A pinned (non-auto) turn walks the configured fallback chain, and
     *      honours `strictModelMode()` by refusing to substitute at all — the
     *      same rule the thrown-error failover already follows.
     *
     * Resolving `false` is honest: it means no other candidate exists, and the
     * loop then falls back to its own bounded escalation instead of spinning.
     */
    const requestModelSwitch = async (): Promise<boolean> => {
      const failedModel = session.model;
      // P4 — this pair is one of the models the turn actually tried, and it
      // failed by answering with nothing. Recorded here because the report has
      // to name it, and because "the provider returned an empty response" is a
      // cause the user should see instead of a generic apology.
      this.recordTurnAttempt({
        provider: session.type,
        model: failedModel ?? 'default',
        kind: 'empty-response',
        reason: describeFailureKind('empty-response'),
      });
      // ── RC2: the failure must be LEARNED, not just survived ───────────────
      // The session exclusion alone only lasts this turn: the model stayed
      // `verified` with `errorRate` 0 across sessions, so the very next chat
      // could route to it again. `recordAutoProviderFailure` runs the FULL
      // shared composition for the pair — session exclusion (model-scoped),
      // registry write-through (which parks it for EMPTY_RESPONSE_PARK_MS), the
      // quota-timeline event, and the shared breaker (deliberately skipped for
      // an empty response: the breaker is provider-scoped and the provider was
      // fine). One `empty-response` failure nobody wrote down was the whole
      // reason a dead model kept its "verified" badge.
      try {
        this.recordAutoProviderFailure(
          session.type,
          new UnusableModelResponseError('empty', 'the provider returned nothing usable for this step'),
          failedModel,
        );
      } catch {
        // Best-effort — bookkeeping must never break the turn.
      }
      // P6 — and the bandit hears about it too: a step-level empty is NEGATIVE
      // evidence for this model in the arm the router samples (see
      // `RouterBandit.penalizeModel`), so the score that flipped a working run to
      // a broken model can actually decay.
      if (failedModel && failedModel !== 'default') {
        try {
          getRouterBandit().penalizeModel(
            failedModel,
            (this.lastRouteSnapshot?.complexity as ComplexityLevel | undefined) ?? undefined,
            this.lastTaskSignature?.split('|')[0],
          );
        } catch {
          // Best-effort — learning must never break the turn.
        }
      }
      /** Install a candidate and report whether it is genuinely a NEW pair. */
      const install = (next: { type: string; provider: InferenceProvider; model: string }): boolean => {
        const current = `${session.type}|${session.model ?? 'default'}`;
        const pair = `${next.type}|${next.model ?? 'default'}`;
        if (pair === current) return false;
        session.type = next.type;
        session.provider = next.provider;
        if (next.model && next.model !== 'default') session.model = next.model;
        this.lastAttempt = { provider: next.type, model: next.model };
        logger.warn(
          `   🔀 ${current} returned nothing usable — handing the turn to ${pair}`,
        );
        return true;
      };

      if (mode.auto) {
        // First keep the provider (its sibling models are the cheapest handoff),
        // then drop the provider entirely so a fully-dead provider is left behind.
        // The same intent hint the initial route and the failover walk use: a
        // bare continuation ("resume") must re-route on the ask it continues,
        // not on the signal-free word, or the handoff lands on a trivial model.
        const switchRoutingText = continuationSoftwareText(message, history) ?? undefined;
        for (const excludeProviders of [[], [session.type]] as string[][]) {
          try {
            const next = await this.routeMessageAuto(message, excludeProviders, {
              ...(switchRoutingText ? { routingText: switchRoutingText } : {}),
              fallbackFrom: session.type,
              // A handoff must NEVER reuse a decision computed before the failure
              // it is reacting to. The 30-second routing cache is keyed on inputs
              // that do not include the pair we just excluded, so a cached
              // decision could hand back the SAME model — making the handoff a
              // no-op and ending a recoverable turn. Observed shape: two routing
              // decisions 17 seconds apart carrying an identical score, one of
              // them a failover the cache had never re-evaluated.
              noCache: true,
            });
            if (install(next)) return true;
          } catch {
            // Unresolvable through this shape — try the next one.
          }
        }
        return false;
      }

      // A pinned turn: never substitute a model the user explicitly forbade.
      if (strictModelMode()) return false;
      try {
        const chain = getProviderFallback(this.configManager, this.configManager.getAll().fallback)
          .getFallbackChain(session.type);
        for (const fbType of chain) {
          if (fbType === session.type) continue;
          if (!hasCredentials(this.configManager, fbType)) continue;
          if (!governanceVerdict(this.configManager, fbType, { taskText: message }).allowed) continue;
          try {
            const resolved = resolveProvider(this.configManager, fbType);
            const model = getAutoRouter().resolveModel(fbType, 'chat', this.configManager);
            if (install({ type: resolved.type, provider: resolved.provider, model })) return true;
          } catch {
            // Next fallback candidate.
          }
        }
      } catch {
        // Fall through to `false` — the loop's bounded path still applies.
      }
      return false;
    };
    try {
      // R1 — the harness follows the MODEL, not only the config: config says
      // what this deployment prefers, the profile decides what this model can
      // actually use (a 0.5B local model must not get a 120B's surface).
      const harness = resolveModelHarnessProfile({
        model: session.model,
        configExposure: getLoopExposureMode(this.configManager),
      });
      result = await runToolLoop({
        messages: thread,
        // The route the model is TOLD about itself. Read fresh each step from the
        // session, which the failover path above updates — so a turn that moves
        // providers mid-answer describes what actually answered it, instead of
        // whatever the config or the model's training data suggests.
        servedRoute: () => ({ providerType: session.type, model: session.model ?? '' }),
        context: toolContext,
        maxSteps: 16,
        // Model-window-aware thread budget: a 1M-token model keeps its window
        // instead of being trimmed to the fixed ~50K-token default. Undefined
        // (unknown window) leaves the tool-loop default untouched.
        threadBudgetChars: resolveThreadBudgetChars({ provider: session.type, model: session.model }),
        // Tiered tool exposure — the tiered (core) set starts at ~16 schemas
        // (~3.8K tokens/step); 'all' hands over the full set (~17K tokens/step)
        // and is now additionally gated on the model having the context for it.
        toolExposure: harness.exposure,
        maxParallelReads: harness.maxParallelReads,
        // WS3 — the turn span the loop hangs each tool call under.
        otel: otelSpan,
        // WS4 — the label a tool hook reports this call under.
        surface: ctxOverrides?.debugSurface ?? 'cli-chat',
        // WS5 — the resume ledger, when this turn was asked to resume. Omitted
        // entirely otherwise, so an ordinary turn never consults it.
        ...(resume ? { resume: resume.ledger } : {}),
        onToken: ctxOverrides?.onToken,
        signal: ctxOverrides?.signal,
        // G18 — the same sink the execute loop uses: tool calls, gate decisions
        // and refusals land on the turn's trace, so the chat surface can answer
        // "what did it actually run, and what did it decline?" from evidence.
        onTraceEvent: (event) => recordTraceEvent(chatTraceId, event),
        deps: {
          callModel: callModelWithTrace,
          // P2 — the empty-response handoff (see `requestModelSwitch` above).
          requestModelSwitch,
          // C5 — `requestModelSwitch` installs the replacement on `session`, so
          // re-resolve the thread budget from the session AFTER a handoff: a
          // handoff to a smaller window is the case that overflows, and the
          // budget in hand was computed from the model that just failed.
          threadBudgetAfterSwitch: () =>
            resolveThreadBudgetChars({ provider: session.type, model: session.model }),
          executeTool: async (name, args, ctx) => {
            const tool = getTool(name);
            if (!tool) throw new Error(`Unknown tool: ${name}`);
            return tool.run(args, ctx);
          },
          onEvent: (line) => {
            // Clean output: the suggest_followups call is captured through the
            // followups sink and rendered as the pickable menu — the raw tool
            // JSON must never print as a progress line (v1.73 clean-messaging
            // parity for the CLI + dashboard console).
            if (line.includes('suggest_followups')) return;
            logger.info(line);
            // P3 — live progress for the dashboard chat console (the CLI
            // keeps logging to its own stdout).
            ctxOverrides?.onProgress?.(line);
          },
        },
      });
      // P3 — REMEMBER the worker that actually delivered this task, so the next
      // turn of the SAME task ("resume", "continue") prefers it instead of
      // re-deciding from a signal-free word. Only a DELIVERED turn is remembered:
      // a bounded, cancelled or failed one has taught us nothing about which
      // model can do this job, and remembering it would propagate the failure.
      if (
        !result.cancelled &&
        !result.generationFailed &&
        !result.bounded &&
        !result.termination?.includes('no-capable') &&
        result.content.trim() &&
        session.model
      ) {
        this.taskContinuity.remember(
          this.lastTaskSignature ?? taskSignature(undefined, undefined),
          session.type,
          session.model,
        );
      }
    } catch (err) {
      // The tool loop does not throw on its own; this catches the errors that
      // ARE meant to propagate — most importantly the ANSWER-QUALITY rejection
      // (`answerQualityError`), which the loop rethrows once every candidate has
      // narrated.
      logger.error(String(err));
      // DIAGNOSABILITY — a failed turn used to record only the LAST attempt's
      // provider/model beside the FIRST error, so a reader could not tell which
      // model actually ran, nor WHY other models were not used. Record the WALK:
      // what was tried, what was parked (and for how long), and how large the
      // eligible pool was — the facts that separate a real shortage from a
      // routing gap. This is the exact ambiguity in the traces that prompted it:
      // a step labelled `local/qwen2.5:0.5b` carrying Gemini's 429.
      try {
        const report = modelBreadthReport(modelWalkMark, this.configManager);
        const tried = report.tried.filter((a) => !a.skipped);
        const parked = report.parked.filter((r) => r.active);
        const triedList = tried
          .slice(0, 6)
          .map((a) => `${a.provider}/${a.model} (${a.reason})`)
          .join(', ');
        const parkedList = parked
          .slice(0, 6)
          .map((r) => `${r.provider}${r.model ? `/${r.model}` : ''} (${r.kind})`)
          .join(', ');
        recordTraceEvent(chatTraceId, {
          kind: 'failover',
          summary:
            `the model layer failed — eligible pool ${report.poolSize ?? '?'} model(s) across ` +
            `${report.poolProviders ?? '?'} provider(s), ${tried.length} tried, ${parked.length} parked` +
            (triedList ? `; tried: ${triedList}` : '') +
            (parkedList ? `; parked: ${parkedList}` : ''),
        });
      } catch {
        // Diagnosis is a courtesy — it must never break the failure path.
      }
      endTrace(chatTraceId, false, { kind: 'failed' });
      result = {
        // Sanitized on purpose: this content is delivered verbatim by every
        // surface (CLI print, dashboard bubble, gateway send).
        content: toUserFacingGenerationError(err),
        followups: [],
        toolCalls: [],
        steps: 0,
        bounded: false,
        // AND it is a FAILURE. Without this the honest line was returned as a
        // SUCCESSFUL turn: the dashboard offered no retry and queued nothing,
        // the gateway reported the turn as fine, and the line was free to be
        // cached as the model's answer. Caught live on the dashboard surface —
        // the bubble read "The model wrote its own working notes instead of an
        // answer…" while `generationFailed` was false, so the one thing the
        // reader could have done about it (retry) was never offered.
        generationFailed: true,
      };
    }
    // ── P4 — THE HONEST EXHAUSTION REPORT ────────────────────────────────
    // A turn that ends without an answer used to deliver a bare line ("the
    // language model was unavailable") or, worse, a QUESTION that made the user
    // the retry button. Instead, the user gets the measured facts: which models
    // were tried and why each did not answer, which targets are unavailable and
    // the WALL-CLOCK time each frees up, whether this was a routing gap or a real
    // shortage, and the levers only they can pull — with no request to retry.
    //
    // Gated on an actual ATTEMPT (or the loop's evidenced `no-capable-candidate`):
    // a governance refusal, an admin-budget stop or a bad pin fails with a
    // healthy pool and a message that is already the right answer, and dressing
    // those up as exhaustion would be a new lie in place of the old one.
    if (
      !result.cancelled &&
      (result.generationFailed || result.termination === 'no-capable-candidate')
    ) {
      try {
        const breadth = modelBreadthReport(modelWalkMark, this.configManager);
        const seen = new Set(this.turnAttempts.map((a) => `${a.provider}|${a.model}|${a.kind}`));
        const attempts: ExhaustionAttempt[] = [...this.turnAttempts];
        for (const a of breadth.tried) {
          const key = `${a.provider}|${a.model}|${a.kind}`;
          if (seen.has(key)) continue;
          seen.add(key);
          attempts.push({
            provider: a.provider,
            model: a.model,
            kind: a.kind,
            reason: a.reason || describeFailureKind(a.kind),
            ...(a.skipped ? { skipped: true } : {}),
          });
        }
        if (attempts.length > 0) {
          const exclusions = breadth.parked
            .filter((r) => r.active)
            .map((r) => ({
              provider: r.provider,
              ...(r.model ? { model: r.model } : {}),
              kind: r.kind,
              ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
              ...(r.source ? { source: r.source } : {}),
            }));
          const reportText = renderExhaustionReport({
            attempts,
            exclusions,
            ...(typeof breadth.poolSize === 'number' ? { poolSize: breadth.poolSize } : {}),
            ...(typeof breadth.poolProviders === 'number' ? { poolProviders: breadth.poolProviders } : {}),
            task: message,
            // The underlying line is kept as the REASON, so a specific,
            // actionable cause is never buried by the report.
            ...(result.generationFailed && result.content.trim() ? { cause: result.content } : {}),
          });
          if (reportText) {
            result.content = reportText;
            recordTraceEvent(chatTraceId, {
              kind: 'failover',
              summary:
                `exhaustion report delivered — ${attempts.filter((a) => !a.skipped).length} model(s) tried, ` +
                `${exclusions.length} unavailable, eligible pool ${breadth.poolSize ?? '?'}`,
            });
          }
        }
      } catch {
        // The report is a courtesy — the turn's own failure line still stands.
      }
    }
    // Record WHAT HAPPENED, not just "the model answered": a hallucinated
    // "I have sent it" (no tool ran) must be visible as an unverified claim in
    // the Trace tab instead of looking like a real delivery.
    const chatOutcome = buildTraceOutcome({
      generationFailed: result.generationFailed,
      cancelled: result.cancelled,
      // What actually RAN successfully, not what was attempted: a failed
      // `gateway_send` must not make the trace read
      // "✅ action performed — message sent".
      tools: result.successfulToolCalls ?? result.toolCalls,
      unverifiedActionClaim: result.unverifiedActionClaim,
      unfulfilledPromise: result.unfulfilledPromise,
      unverifiedEdit: result.unverifiedEdit,
      unverifiedEditClaim: result.unverifiedEditClaim,
      undeliveredArtifact: result.undeliveredArtifact,
      unverifiedBuildClaim: result.unverifiedBuildClaim,
      // Bundle 19/20 — the artifact's own omission, and a file claim no write
      // backs, both make the turn `incomplete` on the trace (not `answered`).
      incompleteArtifactClaim: Boolean(result.artifactIncomplete),
      unverifiedFileClaim: result.unverifiedFileClaim,
    });
    // A cancelled / failed / incomplete turn is NOT a success. `!generationFailed`
    // used to let a cancelled run record `success: true` while its outcome said
    // `cancelled`, so nothing downstream offered to continue it.
    endTrace(chatTraceId, traceOutcomeSucceeded(chatOutcome), chatOutcome);

    // WS1 (#23) — persist the turn's findings (claim, outcome, evidence and the
    // gate's verdict) on the trace, so the verdicts can be audited from the
    // Trace tab after the run instead of only existing in this turn's return.
    // Best-effort by construction; `endTrace` above cleared the in-progress id,
    // so the trace id is passed explicitly.
    recordTraceFindings(chatTraceId, findings);

    // G3 — record what this turn actually did so the NEXT turn starts from it
    // (files changed, whether anything verified the work, and whether the user
    // reported a regression). Best-effort: the ledger must never break a turn.
    try {
      const activity = result.successfulToolCalls ?? [];
      const verified = activity.some(
        (t) => t === 'run_terminal' || t === 'test' || t === 'browser' || t === 'run_cli',
      );
      // …and it is only WRITTEN for a real project, so a home-directory turn
      // stops growing a ledger that no future turn may honestly use. (The same
      // guard as the read above — read and write must agree on what a project is,
      // or the block would be empty forever while the file kept accumulating.)
      if (isProjectLedgerDir(workingStatePath)) {
        recordWorkingState(workingStatePath, {
          filesTouched: [...touchedFiles],
          toolsUsed: activity,
          verified,
          unverifiedEdit: result.unverifiedEdit === true,
          userMessage: message,
        });
      }
    } catch {
      // Best-effort.
    }

    // G1 + G2 — surface the unverified-edit warning ON THE CONSOLE too (the
    // trace badge alone is invisible to a CLI/gateway user). Printed, never
    // appended to `content`, so the delivered answer, the gateway bubble and
    // the answer cache all stay clean.
    try {
      if (result.unverifiedEditClaim) {
        logger.warn(
          '   ⚠️  This reply asserts a code change, but NOTHING verified it (no test / typecheck / build / browser run). Treat the change as UNVERIFIED.',
        );
      } else if (result.unverifiedEdit) {
        logger.warn('   ⚠️  Files were changed this turn but no verification ran — the change is unverified.');
      }
    } catch {
      // Best-effort — a warning must never break the turn.
    }

    // G13b — the DELIVERABLE warning, on the console for the same reason: the
    // trace badge is invisible to a CLI user, and this failure is the one that
    // looks most like success. The reply reads as a finished 12-page story while
    // no file exists, so the reader is told plainly that the deliverable is
    // missing rather than left to discover it when the path is not there.
    try {
      if (result.undeliveredArtifact) {
        logger.warn(
          '   ⚠️  This request asked for a written deliverable, but NO file was written this turn — the text above is the answer, not the artifact.',
        );
      }
      // A3 Part 2 — the build-honesty warning: the run's OWN evidence says the
      // build failed, so the success prose above is contradicted by the turn.
      if (result.unverifiedBuildClaim) {
        logger.warn(
          '   ⚠️  A build command FAILED this turn and no later build succeeded, but the reply reports success — treat the build as UNVERIFIED.',
        );
      }
      // Bundle 19 — the ARTIFACT-honesty warning. The file this turn wrote says its
      // own content was omitted, so the prose above describes a document that is not
      // on disk. The artifact's OWN WORDS are quoted, so the reader sees the evidence
      // (a specific line the file contains) rather than a verdict they must trust.
      // Without this the flag only changed the internal verdict; the user still saw
      // a confident "complete" reply with no sign of the admission inside it.
      if (result.artifactIncomplete) {
        logger.warn(
          `   ⚠️  The file ${result.artifactIncomplete.path} says its own content was omitted ("${result.artifactIncomplete.statement}") — the artifact is INCOMPLETE, whatever the reply above claims.`,
        );
      }
      // Bundle 20 — the FILE-CLAIM warning. The reply above says a file was
      // written and the turn's own record says none was. Found live: a turn wrote
      // nothing and replied "The guide has been written and saved as GUIDE.md …
      // contains a full ~5,000-word technical guide" — and the user saw no warning,
      // because the flag that exists for this failure is gated on the ASK and the
      // ask was not recognised as a deliverable. This one keys on the CLAIM.
      if (result.unverifiedFileClaim) {
        logger.warn(
          '   ⚠️  This reply says a file was written, but NO file was written this turn — treat the deliverable as MISSING, not as done.',
        );
      }
    } catch {
      // Best-effort.
    }

    // Finalize the turn (cache + memory + registry telemetry).
    // E3c: a generationFailed turn is NOT cached/persisted — the caller may
    // fall back to the rule decision, and the failure text must not pollute
    // history or the cache.
    // P4: a CANCELLED turn is likewise discarded entirely — no cache write,
    // no history/memory, no registry telemetry (the caller dropped it).
    if (result.content.trim() && !result.generationFailed && !result.cancelled) {
      if (cacheEnabled) {
        try {
          // #30 — NEVER cache a turn that carries an honesty flag. The cache
          // stores text only, so storing a flagged answer would let a later
          // identical prompt (or the same prompt on another surface) replay a
          // known-unverified claim as a clean one — a truthfulness hole the whole
          // flag system exists to close. A flagged turn re-derives instead.
          if (turnCarriesHonestyFlag(result)) {
            debugLog?.event('cache.skip', { reason: 'honesty-flag', scope: turnScope });
          } else {
            // Keyed by the model that ACTUALLY answered (tryGenerate records it
            // on success), so a weak model's reply is never replayed as a strong
            // model's. `cacheModel` is the pre-flight fallback for the paths that
            // never resolve one (e.g. a cached-hit turn).
            //
            // #30 — the turn ACTIVITY rides with the text so a replay reports what
            // the cached turn did (tool cards, bounded), rather than reading as a
            // turn that did nothing.
            await cache.set(
              message,
              result.content,
              this.cacheModelFor(session) || cacheModel,
              session.type,
              undefined,
              turnScope,
              {
                ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
                ...(result.successfulToolCalls ? { successfulToolCalls: result.successfulToolCalls } : {}),
                ...(result.bounded ? { bounded: true } : {}),
              },
            );
          }
        } catch {
          // Best-effort.
        }
      }
      history.push({ role: 'assistant', content: result.content });
      this.memoryNoteTurn(message, result.content);
      try {
        recordRegistrySuccess(session.type, session.model, 'chat');
      } catch {
        // Best-effort.
      }
    }

    // Followups are rendered by the CALLER (after the answer is printed) so
    // the menu never appears before the content. We return them as data.
    //
    // E3b — strip raw suggest_followups scaffolding from the delivered content
    // HERE (not only in answerOnce): the interactive path prints this string
    // directly, so a model that wrote the tool JSON as text used to leak it
    // into the chat. The loop already salvages such blocks into real tool
    // calls; this is the belt-and-braces strip for any residue.
    // WS2 — close the session debug log. The header names the backend that
    // ACTUALLY served the turn (`lastAttempt`, updated by the provider walk),
    // not the pair this surface merely resolved before the turn started — those
    // diverge exactly when failover happens, which is when a bug report needs
    // the right answer. Best-effort: a log that cannot be written must never
    // affect the answer.
    if (debugLog) {
      const servedModel = this.lastAttempt?.model ?? session.model;
      // ONE expression for the served pair, used by BOTH the header and the
      // `turn.end` event — so "what the header says" and "what the events say"
      // is a single fact rather than two that can drift (the A5/D3 class of
      // defect, in its last remaining face).
      const servedProvider = this.lastAttempt?.provider ?? session.type;
      debugLog.backendOf({
        provider: servedProvider,
        ...(servedModel ? { model: servedModel } : {}),
        transport: result.transport ?? null,
      });
      const requested = session.model ? `${session.type}/${session.model}` : session.type;
      const served = servedModel ? `${servedProvider}/${servedModel}` : servedProvider;
      debugLog.event('turn.end', {
        generationFailed: result.generationFailed === true,
        cancelled: result.cancelled === true,
        bounded: result.bounded === true,
        contentChars: result.content.length,
        toolCalls: result.toolCalls?.length ?? 0,
        findings: findings.length,
        // The pair that answered, and (only when it differs) the pair the turn
        // asked for — a reader can then tell a straight run from a failover
        // without cross-referencing the header.
        served,
        ...(served === requested ? {} : { requested }),
      });
      const notice = debugLogNotice(ctxOverrides?.debugSurface ?? 'cli-chat', debugLog.write());
      if (notice) logger.info(notice);
    }

    // WS3 (#25) — close the turn span and ship it. The status is the turn's own
    // outcome, so a failed turn is a RED span in the collector rather than an
    // absent one — the same rule the debug log follows for a crash.
    if (otelSpan) {
      otelSpan.attr('nuvira.findings', findings.length);
      otelSpan.end({
        ok: result.generationFailed !== true && result.cancelled !== true,
        ...(result.generationFailed === true
          ? { message: 'the turn did not produce a usable answer' }
          : result.cancelled === true
            ? { message: 'the turn was cancelled' }
            : {}),
      });
      const otelLine = otelNoticeOnce(ctxOverrides?.debugSurface ?? 'cli-chat');
      if (otelLine) logger.info(otelLine);
      await flushSpans();
    }

    // A4 — an unfinished turn (cancelled, or an outcome that did not conclude)
    // offers the way back in: Continue / Retry, on top of the model's own
    // suggestions. A concluded turn is left exactly as it was.
    const chatOutcomeForFollowups = buildTraceOutcome({
      generationFailed: result.generationFailed,
      cancelled: result.cancelled,
      tools: result.successfulToolCalls ?? result.toolCalls,
      unverifiedActionClaim: result.unverifiedActionClaim,
      unfulfilledPromise: result.unfulfilledPromise,
      undeliveredArtifact: result.undeliveredArtifact,
      unverifiedBuildClaim: result.unverifiedBuildClaim,
      // Bundle 20 — an unbacked file claim (or a self-admitted omission) means
      // the work did not conclude, so the continuation affordances must appear.
      incompleteArtifactClaim: Boolean(result.artifactIncomplete),
      unverifiedFileClaim: result.unverifiedFileClaim,
    });
    const chatFollowups = withContinuationFollowups(result.followups, {
      unfinished: !traceOutcomeSucceeded(chatOutcomeForFollowups),
      hadTools: (result.successfulToolCalls ?? result.toolCalls ?? []).length > 0,
    });

    return finish({
      content: stripToolCallArtifacts(result.content),
      generationFailed: result.generationFailed,
      cancelled: result.cancelled,
      bounded: result.bounded,
      followups: chatFollowups,
      toolCalls: result.toolCalls,
      unverifiedActionClaim: result.unverifiedActionClaim,
      unfulfilledPromise: result.unfulfilledPromise,
      undeliveredArtifact: result.undeliveredArtifact,
      unverifiedBuildClaim: result.unverifiedBuildClaim,
      // Bundle 19/20 — carried to the caller so the honesty flags survive the
      // return boundary instead of only living in the turn report.
      artifactIncomplete: result.artifactIncomplete,
      unverifiedFileClaim: result.unverifiedFileClaim,
      // R2 — the transport this turn travelled on (interactive REPL path).
      transport: result.transport,
      // WS1 — the findings this turn recorded, with their verdicts.
      findings,
      // E — the honest "what happened" facts the TurnReport is derived from.
      successfulToolCalls: result.successfulToolCalls,
      runTrace: result.runTrace,
      unverifiedEdit: result.unverifiedEdit,
      unverifiedEditClaim: result.unverifiedEditClaim,
      noActionTaken: result.noActionTaken,
      // E-trace — the trace this turn was recorded under, so `answerOnce` can
      // attach the TurnReport to it (see `recordTurnReport`).
      traceId: chatTraceId,
    });
  }

  /**
   * E3b — the model-call step for the tool loop:
   * native generateTools when the provider supports it, JSON fallback
   * otherwise. Auto-mode failover + the shared fallback chain live here — a
   * broken provider never crashes the turn (it answers from the next working
   * candidate, exactly like the legacy generation block).
   */
  /**
   * The model id used in the response-cache key.
   *
   * NEVER returns the `'default'` sentinel (or an empty string). Keying the
   * cache on `'default'` — which is what `session.model ?? 'default'` did —
   * collapsed EVERY model of a provider into a single entry (observed live:
   * `cache.json` held `provider: gemini, model: "default"`). Two consequences,
   * both real: an answer produced by a weak model was replayed as though a
   * strong one had written it, and switching `nuvira model switch` could never
   * take effect for a message already cached. Falls back to the provider's
   * effective model, then to a provider-qualified marker so distinct providers
   * still never collide.
   */
  private cacheModelFor(session: { type: string; model?: string }): string {
    if (session.model && session.model !== 'default') return session.model;
    try {
      const providers = (this.configManager.getAll() as { providers?: Record<string, { model?: string }> }).providers;
      return resolveAdapterDefault(session.type, providers?.[session.type]?.model) ?? `${session.type}:unresolved`;
    } catch {
      return `${session.type}:unresolved`;
    }
  }

  private buildToolCallModel(
    message: string,
    session: { type: string; provider: InferenceProvider; model: string | undefined },
    options: { file?: string; provider?: string; model?: string; cache?: boolean; dev?: boolean },
    mode: { auto: boolean },
    onToken?: (token: string) => void,
    signal?: AbortSignal,
    /**
     * Intent-aware failover: the prior software ask when this turn is a bare
     * continuation ("yes", "do it"), computed by the caller from the history
     * it owns. The initial route used it; the mid-turn failover walk needs it
     * too, or a continuation whose first cloud provider dies re-routes on the
     * signal-free message and can land on a tiny local model.
     */
    routingText?: string,
  ): ToolLoopDeps['callModel'] {
    return async (messages, schemas, stepOnToken, stepSignal) => {
      // The effective token sink: the caller's stream wins; when a step-level
      // sink is also given (loop passthrough) they are the same channel.
      const sink = stepOnToken ?? onToken;
      const abort = stepSignal ?? signal;
      /**
       * The CONCRETE model an attempt will use.
       *
       * `session.model` is undefined or the `'default'` sentinel whenever the
       * router picks a provider but no single model (which is the common auto
       * case). That value used to flow into four places at once — the provider
       * request, the reasoning trace, registry telemetry and the response
       * cache key — so traces read `model: unknown`, the literal `default`
       * reached provider APIs (`The model \`default\` does not exist`, observed
       * live), and EVERY model of a provider shared one cache entry (a bad
       * answer produced by a weak model was then replayed as if it came from a
       * good one). Resolving here keeps all four on the same real model id.
       * Falls back to undefined only when nothing can be resolved, which leaves
       * the adapter's own last-resort resolution in charge.
       */
      /**
       * Per-turn memo of candidates that REJECTED native tool calling, keyed by
       * `provider|model`. Once a model has answered "tool calling is not
       * supported", it can never start supporting it within this turn, so
       * re-issuing the native call is pure waste — the live execute run paid 13
       * failing native requests (one per step) before each fell back to the
       * JSON transport, burning the provider's rate limit for nothing.
       * Keyed per candidate on purpose: a DIFFERENT model that does support
       * native tools must still get them, so a failover re-enables the fast
       * path automatically.
       */
      const nativeToolsRejected = new Set<string>();

      /**
       * GOVERNANCE PRE-FLIGHT (pinned path).
       *
       * An explicit pin bypasses `autoRouter.resolve`, and the admin policy
       * (provider/model allow+deny lists, the PII privacy hard-gate) is enforced
       * inside resolve — so a pinned turn was the one way to serve a provider
       * the policy rules out, and a failed pinned turn would happily fall back
       * to one. A privacy policy any pin can bypass is not a policy. Checked
       * BEFORE the first network call so a blocked turn costs nothing, and
       * thrown as a typed policy error so `toUserFacingGenerationError` surfaces
       * the REASON instead of "the language model was unavailable".
       *
       * No policy configured → `governanceVerdict` is permissive and this is a
       * no-op (unchanged behaviour for every existing setup).
       */
      if (!mode.auto) {
        const verdict = governanceVerdict(this.configManager, session.type, {
          model: session.model,
          taskText: message,
        });
        if (!verdict.allowed) {
          // Prefixed so `toUserFacingGenerationError` reports the POLICY, not a
          // phantom unavailable model (nothing was unreachable — a rule
          // refused it). The reason names the provider and the rule.
          throw new Error(`Governance policy: ${verdict.reason}`);
        }
        // ADMIN BUDGET (pinned path). The pin still runs the model the user
        // chose — this only REFUSES it when the user's own declared budget
        // (routing.quota window, admin cost cap) is already exceeded, instead
        // of spending past the control they set in the dashboard. A no-op when
        // no budget is configured.
        const budget = adminBudgetVerdict(this.configManager, session.type, { model: session.model });
        if (!budget.allowed) {
          throw new Error(`Admin budget: ${budget.reason}`);
        }
      }

      /**
       * A2 — REACHABILITY PRE-FLIGHT (pinned path).
       *
       * The governance/admin checks above cover POLICY; this covers whether the
       * pin can work at all. Measured (Run D): `-p openrouter -m
       * deepseek/deepseek-v4.1-flash` on an unfunded account was sent, and the
       * operator learned the real cause from a raw 402 body — after a full round
       * trip, with a live 6-second failure that said nothing about what to do.
       *
       * `resolveRoute` refuses that pin, and every one of its callers therefore
       * does — but this method resolves its own model, so after the first fix the
       * same run still logged BOTH behaviours: the pipeline refused the pair
       * before any call ("Refusing to call …") while the chat tool loop sent the
       * request and got `402 Insufficient credits` back. Same gate, same wording,
       * same implementation (`strictPinRefusal`) — this is the one seam that was
       * still missing it.
       *
       * Strict mode only, exactly like `resolveRoute`: the refusal sentence says
       * strict mode forbids substituting, and on a non-strict turn the fallback
       * walk is the correct repair.
       */
      if (!mode.auto && strictModelMode()) {
        const refusal = strictPinRefusal(session.type, session.model);
        if (refusal) throw new Error(refusal);
      }

      const resolveEffectiveModel = (providerType: string, requested?: string): string | undefined => {
        if (requested && requested !== 'default') return requested;
        try {
          const providers = (this.configManager.getAll() as { providers?: Record<string, { model?: string }> }).providers;
          return resolveAdapterDefault(providerType, providers?.[providerType]?.model);
        } catch {
          return undefined;
        }
      };
      const tryGenerate = async (
        prov: InferenceProvider,
        typ: string,
        mdl: string | undefined,
      ): Promise<StepResponse> => {
        // One resolution per attempt — the request, the trace, the telemetry
        // and the cache key all read the same value (see above).
        const effectiveModel = resolveEffectiveModel(typ, mdl);
        // Record the ATTEMPTED model immediately so a failed step's trace and
        // telemetry name the model that failed, instead of "unknown".
        if (effectiveModel) session.model = effectiveModel;
        // G5 — and name the attempt itself, so the trace recorder reports the
        // real provider/model (post-failover) rather than the session default.
        this.lastAttempt = { provider: typ, model: effectiveModel };
        const nativeKey = `${typ}|${effectiveModel ?? ''}`;
        // Answer-quality resilience: a CONFUSED reply — the model talking about
        // the tool contract (e.g. apologizing that "the provided example call
        // to suggest_followups is incomplete") instead of executing it — never
        // throws, so failover never fired and the confusion went to the user
        // verbatim (live WhatsApp incident). Same for the OTHER quality failure:
        // the model delivering its own REASONING ("The user said \"Hi\" …
        // According to the instructions: …"). One shared detector
        // (`detectAnswerQualityFailure`) is used here and by the loop engine
        // (`nuvira execute` / the pipeline), so neither surface can drift.
        // Treat it like a generation failure: THROWS so the caller's failover
        // walk retries with the next candidate; the raw reply is carried on the
        // error for the final fallback.
        // `hasToolCalls` selects the strictness tier: a step that is ACTING may
        // legitimately open with a first-person narration ("Let me check the
        // config.") before its tool call, and rejecting it would throw the call
        // away — so a tool-carrying step is judged on the high-precision
        // signals only, while the step that IS the answer is judged on all.
        const confuseCheck = (content: string, hasToolCalls = false): void => {
          const failure = detectAnswerQualityFailure(content, undefined, {
            highPrecisionOnly: hasToolCalls,
          });
          if (failure) throw answerQualityError(content, failure);
        };
        /** Mark the model that actually produced this response. */
        const answered = <T extends StepResponse>(resp: T): T => {
          if (effectiveModel) session.model = effectiveModel;
          return resp;
        };
        // R1 — deterministic transport. A tiny model cannot use a native tool
        // API, and finding that out by trying cost a 400 on every turn (the
        // refusal memo is per-call). Unknown families are untouched: they still
        // try native and fall back, so nothing that works today stops working.
        if (shouldSkipNativeTools({ model: effectiveModel })) {
          nativeToolsRejected.add(nativeKey);
        }
        if (!nativeToolsRejected.has(nativeKey) && typeof prov.generateTools === 'function' && schemas.length > 0) {
          try {
            // P4 — stream when the provider supports it AND a sink is wired
            // (the dashboard); otherwise the one-shot path with the whole
            // content delivered as a single chunk so the typewriter channel
            // still receives the answer (appears at once — today's behavior).
            if (sink && typeof prov.generateToolsStream === 'function') {
              const result = await prov.generateToolsStream(messages, schemas, { ...options, model: effectiveModel, signal: abort, reasoningEffort: capabilityReasoningEffort(this.configManager) }, sink);
              confuseCheck(result.content, result.toolCalls.length > 0);
              return answered({ ...result, transport: 'native' as const });
            }
            const result = await prov.generateTools(messages, schemas, { ...options, model: effectiveModel, signal: abort, reasoningEffort: capabilityReasoningEffort(this.configManager) });
            confuseCheck(result.content, result.toolCalls.length > 0);
            if (sink && result.content) sink(result.content);
            return answered({ ...result, transport: 'native' as const });
          } catch (err) {
            // S3: a tool-call 400 often carries the model's COMPLETE answer in
            // `failed_generation` (the API rejected only the CALL). Salvage it
            // instead of losing the turn to failover/error — the essay was
            // sitting in the error payload and was being thrown away.
            const salvaged = salvageFailedGeneration(err);
            if (salvaged) {
              // The salvaged essay can itself be contract-confusion — check it
              // too, otherwise a confused 400 payload sails through salvage.
              confuseCheck(salvaged.content, (salvaged.followups?.length ?? 0) > 0);
              logger.warn("   ⚠️ Tool call rejected (400) — salvaging the model's generated answer.");
              // Re-run the recovered suggest_followups through the normal tool
              // path so the followups land in the sink (and the loop's
              // end-of-response early return fires on the substantive content).
              const toolCalls = salvaged.followups?.length
                ? [{ id: 'call_salvage_1', name: 'suggest_followups', arguments: { followups: salvaged.followups } }]
                : [];
              // R2 — the answer was excavated from a NATIVE tool-call attempt's
              // 400 payload, so it is still the native transport's output.
              return answered({ content: salvaged.content, toolCalls, transport: 'native' as const });
            }
            // The MODEL itself cannot do native tool calling — Groq answers
            // 400 "`tool calling` is not supported with this model". That is
            // not a reason to lose the turn: the loop already ships a transport
            // that needs no provider tool support, and the system prompt
            // carries the tool contract for it. Fall THROUGH to it (no throw)
            // so an otherwise-good model still answers.
            if (isToolCallingUnsupported(err)) {
              // Remember it for the REST of this turn so later steps go straight
              // to the JSON transport instead of re-paying the failing call.
              nativeToolsRejected.add(nativeKey);
              logger.warn(
                '   ⚠️ Model does not support native tool calling — retrying this step over the JSON tool transport.',
              );
            } else {
              throw err;
            }
          }
        }
        // JSON fallback transport: flatten the thread into one prompt with
        // the compact argument shapes appended (S2 — shared helper, so
        // execute/plan-style loops that add tool calling get the same fix).
        const prompt = buildJsonFallbackPrompt(messages, schemas);
        let raw: string;
        if (typeof prov.generateStream === 'function') {
          const chunks: string[] = [];
          await prov.generateStream(prompt, { ...options, model: effectiveModel, signal: abort, reasoningEffort: capabilityReasoningEffort(this.configManager) }, (t) => chunks.push(t));
          raw = chunks.join('');
        } else {
          raw = await prov.generate(prompt, { ...options, model: effectiveModel, signal: abort, reasoningEffort: capabilityReasoningEffort(this.configManager) });
        }
        const { text, calls } = extractFallbackToolCalls(raw);
        confuseCheck(text, calls.length > 0);
        // R2 — this IS the fallback transport, so say so: the same fact the
        // subagent child announces, and what makes a chat turn comparable with it.
        return answered({ content: text, toolCalls: calls, transport: 'json' as const });
      };

      try {
        // Same-provider transient retry FIRST (see the helper's contract): a
        // 503 spike at a shared endpoint must not become a dead run. Failover
        // only helps if a DIFFERENT provider exists — and it also hides the real
        // failure from the user while parking a healthy provider for 120s.
        return await generateWithTransientRetry(
          () => tryGenerate(session.provider, session.type, session.model),
          abort,
          (attempt, err) =>
            logger.warn(
              `   ⏳ ${session.provider.name} transient failure (attempt ${attempt}) — retrying shortly: ${
                err instanceof Error ? err.message.split('\n')[0] : String(err)
              }`,
            ),
        );
      } catch (err) {
        // P4 — the model this turn STARTED on failed. Recorded with a human
        // phrase (never the raw provider text, which is how a JSON quota dump
        // once reached a user verbatim) so the exhaustion report can name it.
        const primaryKind = classifyFallbackError(err);
        this.recordTurnAttempt({
          provider: session.type,
          model: session.model ?? 'default',
          kind: primaryKind,
          reason: describeFailureKind(primaryKind),
        });
        // Auto mode: fail over across the ranked candidates (never stuck).
        if (mode.auto) {
          const firstType = session.type;
          // Observable telemetry, identical to the shared single-shot runner
          // (the E2E repair-failover contract): one warn per walk, one
          // success log per landed candidate.
          logger.warn(`   ⚠️ ${session.provider.name} failed — trying the next auto candidate...`);
          const failed = new Set<string>([session.type]);
          // Intent-aware escalation for the FAILOVER walk (the live junk path):
          // a mid-turn failure used to re-route on the bare message alone, so a
          // software turn whose first cloud provider died fell through to a tiny
          // local model (`local/qwen2.5:0.5b`) that FABRICATED tool output
          // (trace-1791118650644-d73hyr). Pass the same prior-software-ask hint
          // the initial route used, so the router's agentic capability floor
          // applies here too — but NEVER drop a candidate the floor would keep,
          // so auto still cannot dead-end (local stays the last resort).
          const failoverRoutingText = routingText;
          // Try ALL ranked candidates (no 3-candidate cap) — bounded by
          // the number of known providers to prevent infinite loops.
          const maxAttempts = 10;
          for (let i = 0; i < maxAttempts; i++) {
            let next: AutoRoutedMessage | null = null;
            try {
              next = failoverRoutingText
                ? await this.routeMessageAuto(message, [...failed], {
                    routingText: failoverRoutingText,
                    fallbackFrom: firstType,
                  })
                : await this.routeMessageAuto(message, [...failed], { fallbackFrom: firstType });
            } catch {
              break;
            }
            if (!next || next.type === session.type || failed.has(next.type)) break;
            failed.add(next.type);
            // Last-resort truthfulness: if even the agentic floor could not
            // avoid a weak model, say so ONCE so a degraded answer is never
            // mistaken for a real one (the tiny local model fabricated tool
            // results instead of admitting it could not run them). C2 — the
            // wording comes from the SHARED helper so chat, the orchestrator
            // and the dashboard cannot describe this three different ways.
            if (!isAgenticCapableModel(next.model, next.type)) {
              const notice =
                weakRouteNotice({ provider: next.type, model: next.model }, true) ??
                `⚠️ no agentic-capable model left — falling back to ${next.type}/${next.model}`;
              logger.warn(`   no agentic-capable model left — ${notice}`);
            }
            // Opt-in confirmation (routing.promptOnFailover): 'manual' stops
            // the walk and lets the caller's error recovery handle it. Gated on
            // an interactive stdin (inherited from the shared single-shot
            // runner) — a piped/CI input must never block on an inquirer
            // prompt; it falls through to silent auto-failover instead.
            if (shouldConfirmFailover(this.configManager.getAll()) && process.stdin.isTTY) {
              try {
                const choice = await promptFailoverChoice(session.provider.name, next.provider.name, next.model);
                if (choice === 'manual') break;
              } catch {
                // Fall through to the candidate.
              }
            }
            try {
              const resp = await tryGenerate(next.provider, next.type, next.model);
              session.type = next.type;
              session.provider = next.provider;
              // Keep the model that actually answered: `next.model` is often
              // undefined ("provider default"), and assigning it here used to
              // erase the resolved id that tryGenerate just recorded.
              if (next.model && next.model !== 'default') session.model = next.model;
              logger.success(`✅ Auto failover: answered from ${next.provider.name} (${next.model}) after ${firstType} failed`);
              return resp;
            } catch (nextErr) {
              // P4 — record THIS candidate's failure too, so the report lists
              // every model the turn was actually served by, in order.
              const nextKind = classifyFallbackError(nextErr);
              this.recordTurnAttempt({
                provider: next.type,
                model: next.model ?? 'default',
                kind: nextKind,
                reason: describeFailureKind(nextKind),
              });
              // Next candidate.
            }
          }
        } else if (!strictModelMode() && isRetryableError(classifyFallbackError(err))) {
          // Non-auto: walk the shared fallback chain (retryable errors only).
          //
          // Under strict model mode the walk is exactly the substitution the
          // user forbade: `strictModelMode()` short-circuits this branch, so a
          // pinned model that cannot answer surfaces its own error instead of
          // quietly continuing on a provider the user did not choose (A2 — the
          // same defect the loop engine had, fixed for dashboard + CLI chat
          // here). The `tryGenerate` call above already reports the raw error.
          // Providers the admin policy rules out are collected here so the
          // failure can name POLICY as the reason instead of implying the model
          // was unreachable.
          const policyBlocked: Array<{ provider: string; reason: string }> = [];
          try {
            const fallback = getProviderFallback(this.configManager, this.configManager.getAll().fallback);
            const chain = fallback.getFallbackChain(session.type);
            /**
             * Order the chain the way `loop-executor`'s pinned pool does: a
             * registry-parked / cooling-down provider goes LAST (never dropped,
             * since the whole point of failover is to reach what the primary
             * could not). Best-effort — ordering must never cost us the chain.
             */
            let ordered = chain;
            try {
              const isExcluded = createFailoverExclusionFilter();
              ordered = [
                ...chain.filter((t) => !isExcluded(t)),
                ...chain.filter((t) => isExcluded(t)),
              ];
            } catch {
              // Ordering is an optimization only.
            }
            // The pair the turn was PINNED to. Captured before the walk because
            // the walk now installs what it serves (see below), and the warning
            // must still name the provider that actually failed.
            const pinnedType = session.type;
            for (const fbType of ordered) {
              if (fbType === session.type) continue;
              // ADMIN POLICY: never fall back to a provider the policy rules
              // out. This was the leak — a PII task whose pinned (compliant)
              // provider failed would silently continue on a provider the
              // privacy policy forbids. Recorded so the turn can SAY why the
              // walk found nothing instead of blaming the model.
              const policy = governanceVerdict(this.configManager, fbType, {
                taskText: message,
              });
              if (!policy.allowed) {
                policyBlocked.push({ provider: fbType, reason: policy.reason ?? 'blocked by policy' });
                continue;
              }
              // Only providers the user can actually CALL. An explicit
              // `fallback.providers` entry with no key is not filtered out by
              // the chain itself, so it used to cost a full connection timeout
              // (measured live at ~25s against an unauthenticated endpoint)
              // before the next candidate was tried — time the sender spends
              // waiting for a reply that is already failing. Same credential
              // gate `loop-executor`'s pinned pool applies.
              if (!hasCredentials(this.configManager, fbType)) continue;
              try {
                const resolved = resolveProvider(this.configManager, fbType);
                // The fallback provider gets ITS OWN model, not the primary's
                // id. Reusing `session.model` here sent e.g. gemini's
                // `gemini-3.1-flash-lite` to groq, which 404s “model not found”
                // — so every fallback candidate failed for a reason unrelated
                // to the outage and a pinned-provider turn dead-ended with
                // “the language model was unavailable” even though healthy
                // providers were available. (The auto branch below has always
                // passed `next.model`, which is why only the pinned path -
                // the dashboard console and the gateway chat engine - looked
                // dead.) Undefined = that provider's configured/adapter
                // default, which tryGenerate resolves per attempt.
                const fallbackModel = resolveEffectiveModel(resolved.type, undefined);
                const resp = await tryGenerate(resolved.provider, resolved.type, fallbackModel);
                // ── The pair that ANSWERED is the pair the turn ran on ───────
                // This walk used to serve the fallback and leave `session` still
                // naming the provider that had just failed. Everything the turn
                // then reported or learned read the WRONG provider against the
                // RIGHT model — one interlocking defect with four faces, all
                // measured:
                //   • the session debug log's `turn.start` named the pinned
                //     provider while its own header named the one that served
                //     (`backend.provider: deepseek` with `turn.start {"provider":
                //     "groq"}` — A5/D3);
                //   • `servedRoute()` told the MODEL it was a different model
                //     than the one answering;
                //   • the response cache stored `provider: "groq"` beside
                //     `model: "deepseek-flash"`;
                //   • and worst, `recordRegistrySuccess(session.type,
                //     session.model)` wrote a PAIR THAT CANNOT EXIST into the
                //     model registry as `verified`. That is the self-poisoning:
                //     `groq|deepseek-flash` and `groq|gemini-3.1-flash-lite` are
                //     both sitting in the live registry as `telemetry`-verified,
                //     and because `telemetry` outranks `spot-check` in
                //     `preferredModelsFor`, the NEXT groq call picked the bogus
                //     id as its adapter default, sent a foreign model name to
                //     groq, and 404'd into the same fallback walk — each run
                //     making the next one worse.
                // The auto branch above has always installed `next`; the pinned
                // branch is the one that drifted.
                session.type = resolved.type;
                session.provider = resolved.provider;
                if (fallbackModel) session.model = fallbackModel;
                logger.warn(
                  `   🔀 ${pinnedType} was unavailable — answered from ${resolved.provider.name} (${fallbackModel ?? 'default'})`,
                );
                return resp;
              } catch {
                // Next fallback candidate.
              }
            }
          } catch {
            // Fall through to rethrow.
          }
          // Every fallback candidate was refused by ADMIN POLICY (and none
          // answered): the honest answer is the policy block, not "the language
          // model was unavailable". Surfaced through the same
          // `Governance policy:` prefix the pre-flight check uses.
          if (policyBlocked.length > 0) {
            logger.warn(
              `   ⚠️ Governance policy blocked every fallback provider: ${policyBlocked
                .map((b) => `${b.provider} (${b.reason})`)
                .join('; ')}`,
            );
            throw new Error(
              `Governance policy: no permitted fallback provider was available — ${policyBlocked
                .map((b) => `${b.provider}: ${b.reason}`)
                .join('; ')}`,
            );
          }
        }
        // Answer-quality resilience: every candidate failed (or none was
        // tried) and the error carries the model's raw confused reply —
        // deliver THAT instead of failing the whole turn. A confusing answer
        // still beats an error banner in a messaging app; the confusion is
        // now also visible in the chat trace for post-mortem.
        // The old behavior here — DELIVER the confused reply as if it were the
        // answer (`return { content: confusedReply }`) — was the worst of both
        // worlds. It shipped contract meta-talk to the sender ("Sure, I can
        // help you with suggestions and followups. Please provide me with more
        // details…") AND marked the turn a SUCCESS, so the loop cached it for
        // an hour and every retry inside that window replayed the same
        // deflection. Live evidence: that exact string sat in
        // ~/.nuvira/cache.json with `model: "default"`.
        //
        // Now it stays a FAILURE: rethrow so the tool loop surfaces the
        // sanitized, user-facing line with `generationFailed: true` (never
        // cached, never persisted), while the raw reply is preserved in the
        // log and the reasoning trace for post-mortem.
        const confusedReply = (err as Error & { confusedReply?: string }).confusedReply;
        if (typeof confusedReply === 'string' && confusedReply.trim()) {
          logger.warn(
            `   ⚠️ No alternative model answered — contract-confusion reply suppressed (${confusedReply.length} chars, kept in the trace): ${confusedReply.slice(0, 160)}`,
          );
        }
        throw err;
      }
    };
  }

  /**
   * E3b — render suggest_followups results. Interactive:
   * numbered options; choosing one sends its prompt as the next message.
   * Single-shot: printed after the answer.
   */
  private async renderFollowups(
    followups: FollowupSuggestion[],
    interactive: boolean,
  ): Promise<string | undefined> {
    if (!followups || followups.length === 0) return undefined;
    console.log('');
    logger.highlight('➡️  Next steps:');
    followups.forEach((f, i) => {
      console.log(`  ${i + 1}. ${f.label || f.prompt}`);
    });
    if (!interactive) {
      console.log('');
      return undefined;
    }
    console.log('');
    try {
      const answer = await inquirer.prompt<{ n: string }>([
        {
          type: 'input',
          name: 'n',
          message: 'Pick a number to continue, or press Enter to keep chatting:',
          prefix: '',
        },
      ]);
      const idx = parseInt(answer.n.trim(), 10);
      if (idx >= 1 && idx <= followups.length) {
        return followups[idx - 1].prompt;
      }
    } catch {
      // The followup pick must never break the chat loop.
    }
    return undefined;
  }

  /**
   * Record a completed user↔assistant turn into the persistent-memory manager
   * (Phase B2). Best-effort and fire-and-forget: the provider only BUFFERS the
   * turn here (zero latency); extraction into project facts happens once at
   * session end. A memory failure must never break the chat loop.
   */
  private memoryNoteTurn(userText: string, assistantText: string): void {
    try {
      void getMemoryManager().recordTurn(userText, assistantText).catch(() => {
        // Best-effort — never break chat over memory.
      });
    } catch {
      // Best-effort — never break chat over memory.
    }
  }

  /**
   * Show a categorized model picker that groups models by capability.
   *
   * Example output:
   *
   *   🎯  Available Models
   *
   *   💬 Chat (General conversation)
   *    1. 🟢  llama-3.3-70b-versatile  ⭐ Best all-rounder — strong at...
   *    2. 🟢  gemma2-9b-it
   *
   *   💻 Code (Code generation, programming)
   *    3. 🔷  gemini-2.5-flash  ⭐ Latest Gemini — fast, multimodal...
   *
   *   Enter a number (0-8):
   */
  /**
   * Record an auto-mode provider failure so the session fails over instead of
   * getting stuck on a broken provider (the core of "auto routing should pick
   * another provider when the current one dies mid-session").
   *
   * Delegates to the SHARED failure-bookkeeping helper (Nuvira-Router M0.2
   * Stage A) so every action composes the exact same bookkeeping: session
   * exclusion (auth = whole session, rate-limit = short cooldown, transient =
   * short cooldown + re-verify marker), quota-ledger parking on rate-limit,
   * registry write-through (per-action telemetry), quota-timeline event, and
   * the shared circuit breaker. Best-effort: never throws.
   */
  private recordAutoProviderFailure(providerType: string, err: unknown, model?: string, apiKey?: string): void {
    recordActionFailure(
      {
        sessionFailedProviders: this.sessionFailedProviders,
        sessionTransientFailedProviders: this.sessionTransientFailedProviders,
        // Model tracking ON: a rate-limit on one model excludes THAT model and
        // leaves the provider's siblings routable (per-model RPD/TPM limits).
        sessionFailedModels: this.sessionFailedModels,
      },
      providerType,
      err,
      this.configManager,
      { model, action: 'chat', apiKey },
    );
  }

  private async showModelPicker(): Promise<{ provider: string; model: string } | null> {
    return showModelPicker(this.configManager);
  }

  /**
   * Resolve the best provider/model for a message via the AutoModelRouter.
   * Returns the routed type/provider/model; the caller applies them to the
   * active session state.
   */
  /**
   * Resolve the best provider/model for a message via the AutoModelRouter.
   *
   * ONLY AVAILABLE providers are returned: the router itself already excludes
   * unconfigured providers (no API key), and this method additionally walks
   * the ranked candidates and picks the first one whose isAvailable() passes —
   * so Auto routing never sends a request to a provider that would 401.
   */
  private async routeMessageAuto(
    message: string,
    excludeProviders: string[] = [],
    opts?: {
      contextHintTokens?: number;
      /**
       * Intent-aware escalation: when this turn is a BARE continuation of prior
       * software work ("yes", "do it"), the caller passes the recent software
       * ask here. Routing scores THAT text instead of the signal-free
       * continuation, so the follow-up is not sent to a trivial-tier model; the
       * answer still uses `message`. See `learning/continuation-intent.ts`.
       */
      routingText?: string;
      /** C3 — the pair this route is failing over FROM (the chain's origin). */
      fallbackFrom?: string;
      /**
       * P2/P3 (fix_model_routing) — skip the routing-decision cache.
       *
       * The cache key covers intent, complexity, provider health and session
       * exclusions, and a MID-TURN HANDOFF changes none of those in a way it
       * can see: the pair that just failed is excluded MODEL-scoped, which is
       * not part of the signature. So a handoff that ran within the 30s TTL
       * could be handed the very decision it is trying to escape — the same
       * provider and model — and the "switch" would silently do nothing. A
       * re-route that is reacting to a just-recorded failure must be computed
       * fresh.
       */
      noCache?: boolean;
    },
  ): Promise<AutoRoutedMessage> {
    // The text ROUTING is decided from — the prior software ask for a bare
    // continuation, otherwise the message itself. `message` is used everywhere
    // else (the answer, the tool loop).
    const taskText = opts?.routingText?.trim() ? opts.routingText : message;
    // Feed the SHARED circuit breaker into the router so a provider that has
    // failed repeatedly (recorded by recordFailure below) is deprioritized by
    // scoring, not just skipped by the candidate walk.
    let circuitBreakerStatus: Array<{ provider: string; cooldownRemaining: number }> = [];
    try {
      circuitBreakerStatus = getProviderFallback(this.configManager).getCircuitBreakerStatus();
    } catch {
      // Best-effort — routing must never crash on circuit-breaker bookkeeping
    }
    // ISSUE-003: ONE resolve-options assembly for every action point. The
    // shared helper supplies the full chat/orchestrator feature set (bandit
    // learning ON by default, quota-ledger status, runtime stats, cost/speed/
    // reasoning floors, paid-model gate, context preflight); chat layers its
    // circuit-breaker state on top.
    // C3: the NLU parser seeds the router task-intent (same vocabulary every
    // action command derives from resolveDispatch) when confident.
    const parsed = parseRequestSync(taskText);
    const dispatch = resolveDispatch(parsed);
    // Routing decision cache (assessment v4 Phase 2): the loop engine
    // resolves per turn; turns with identical STABLE routing inputs (intent,
    // complexity, provider-health signature) reuse the decision instead of
    // re-scoring 22+ providers. Provider health is IN the key, so a
    // mid-session failure changes the key and can never serve a stale
    // healthy-route. TTL 30s bounds the rest (bandit draws, benchmark data).
    const routingCfg = (() => {
      try { return this.configManager.getAll().routing ?? {}; } catch { return {}; }
    })();
    let registryUsable = 0;
    try { registryUsable = getModelRegistry().getUsableProviders().length; } catch { /* best-effort */ }
    const cacheSignature = routingCacheSignature([
      'chat',
      dispatch.taskIntentHint ?? null,
      analyzeComplexity(taskText),
      routingCfg.preferenceMode ?? null,
      routingCfg.bandit === false ? 'b' : 'B',
      routingCfg.mlRouter === true ? 'm' : 'M',
      routingCfg.allowPaid ?? null,
      registryUsable,
      circuitBreakerStatus.map((c) => `${c.provider}:${Math.ceil(c.cooldownRemaining / 60_000)}`).join(','),
      [...this.sessionFailedProviders.entries()]
        .filter(([, exp]) => exp > Date.now())
        .map(([p]) => p)
        .sort()
        .join(','),
    ]);
    const resolveFresh = () =>
      getAutoRouter().resolve(
        'chat',
        taskText,
        {
          ...buildAutoResolveOptions(this.configManager, {
            verbose: envBuff('DEBUG') === 'true',
            contextHintTokens: opts?.contextHintTokens,
          }),
          circuitBreakerStatus,
          ...(dispatch.taskIntentHint ? { taskIntentHint: dispatch.taskIntentHint } : {}),
        },
        this.configManager,
      );
    const decision =
      opts?.noCache === true
        ? resolveFresh()
        : withRoutingCache(cacheSignature, 30_000, resolveFresh);
    // G5 — record the routing snapshot now (the winner + why), so the reasoning
    // trace for this turn can show the decision instead of a blank column.
    // P3 — the TASK this turn belongs to, as far as model continuity is
    // concerned. Kept on the instance because the turn's SUCCESS path (the only
    // place that knows a model actually DELIVERED) does not hold the routing
    // decision; intent+complexity is the same key for the original ask and for a
    // continuation of it, which is exactly the pair that must match.
    this.lastTaskSignature = taskSignature(
      dispatch.taskIntentHint ?? decision.taskProfile?.intent,
      String(decision.complexity),
    );
    this.lastRouteSnapshot = {
      provider: decision.provider,
      model: decision.model,
      score: decision.score,
      complexity: String(decision.complexity),
      explanation: decision.explanation,
      // A1/A2/C3 — carry the capability verdict + override reason so the trace
      // and console can show WHY the pair was chosen, not just which pair.
      agenticCapable: decision.agenticCapable,
      overrideReason: decision.overrideReason,
    };

    // Walk the ranked candidates (winner first) and return the first available
    // provider — never a provider that lacks a key or endpoint. Providers that
    // already failed this message (excludeProviders) OR earlier in this session
    // with an ACTIVE exclusion (sessionFailedProviders, time-based) are skipped
    // so runtime failover walks forward instead of repeating a known-broken
    // provider. Expired rate-limit exclusions re-admit the provider.
    const exclusionTime = Date.now();
    const isActiveExclusion = (p: string) => {
      const expiresAt = this.sessionFailedProviders.get(p);
      return expiresAt !== undefined && expiresAt > exclusionTime;
    };
    // ── Cold-start probe (suggestion 3) ─────────────────────────────────────
    // Start the background warmup/exploration daemon on EVERY chat session, not
    // only a cold one (Models-page audit). It is idempotent (already-running is
    // a no-op) and unref'd, so it cannot hold the process open — and it is the
    // only thing that verifies models the router cannot see yet. Left cold-only,
    // the verified pool could only ever shrink as staleness retired models.
    try {
      startWarmupDaemon(this.configManager);
    } catch {
      // Best-effort — warmup must never break chat.
    }

    // A fresh registry has zero verified models → routing would fall back to
    // credential-based defaults and possibly fail into dead ends. Fire ONE
    // background probe+spot-check so the registry learns from real API data.
    if (!this.coldStartProbeFired) {
      this.coldStartProbeFired = true;
      try {
        const registry = getModelRegistry();
        if (registry.getUsableProviders().length === 0) {
          // Fire-and-forget: never block the first message on probe network I/O.
          void refreshModelRegistry(this.configManager, { spotCheck: true }).catch(() => {
            // Best-effort — cold-start probing must never break chat.
          });
        }
      } catch {
        // Best-effort.
      }
    }
    // ── Re-verify before re-admit (suggestion 2) ───────────────────────────
    // A provider whose TRANSIENT exclusion just expired is only re-admitted
    // after a quick on-demand spot-check confirms it's actually back — the
    // registry may still mark it unavailable (learned from the failure), and
    // blindly re-admitting would fail again on the very next message. Recovery
    // is discovered in SECONDS (a 1-token spot-check), not by re-failing.
    // The sweep itself now lives in `learning/provider-revival.ts` so every
    // entry path shares ONE implementation (chat was previously the only path
    // that read the transient-failure marker at all — the orchestrator, edit,
    // execute, plan and resilient-call allocated it and never acted on it, so a
    // recovered provider stayed excluded for the rest of their runs).
    await sweepTransientFailures(
      {
        ...collectionRevivalStore(this.sessionFailedProviders, this.sessionTransientFailedProviders),
        resolveProbeModel: (provider) =>
          getAutoRouter().resolveModel(provider, 'chat', this.configManager),
      },
      this.configManager,
      { agentType: 'chat' },
    );
    const excluded = new Set([
      ...excludeProviders,
      ...[...this.sessionFailedProviders.keys()].filter((p) => isActiveExclusion(p)),
    ]);
    // Predictive skip from the Model Availability Registry: providers whose
    // every tracked model the registry marks unavailable/quota-parked (learned
    // from real usage telemetry) are never even attempted — sub-ms, no
    // network, no failing call. This is what turns "fail gemini → fail nim →
    // local" on every message into "straight to local" after the first learn.
    let registryBlocked = new Set<string>();
    try {
      registryBlocked = new Set(getModelRegistry().getBlockedProviders());
    } catch {
      // Best-effort — registry bookkeeping must never break routing
    }
    // ── DEEP FAILOVER candidate list: {provider, model} PAIRS ──────────────
    // Several models PER PROVIDER, so a 429 on one model retries the SAME
    // provider's next-best model before abandoning it. The previous
    // provider-only list meant chat could only ever reach a single model per
    // provider no matter how many that provider actually served (free tiers
    // meter per-model, so the siblings were very often usable).
    // Model-scoped exclusions come from the SAME predicate the orchestrator's
    // resilient walk uses. Cross-pipeline persistence is OFF here (chat's own
    // session accounting is the authority for an interactive turn) and the
    // registry check is OFF because `resolveWorkingModel` below OWNS per-model
    // repair; the provider-wide `registryBlocked` pre-filter above already
    // removes dead providers.
    const isModelExcluded = createFailoverExclusionFilter({
      sessionFailedModels: this.sessionFailedModels,
      crossPipelineMemory: false,
      registryCheck: false,
    });
    // B2-a — each candidate carries the score OF ITS OWN PAIR, when the pool had
    // a real measurement for it, plus the scale that score is on. It used to
    // carry nothing at all and every row was recorded with `decision.score`, so
    // three different pairs shared one provider-level number (measured live:
    // `0.43836864406779663` on gemini/gemma-4-26b-a4b-it,
    // openrouter/cohere/command-r7b-12-2024 and deepseek/deepseek-flash).
    const chatCandidates: Array<{
      provider: string;
      model: string;
      score?: number;
      scoreBasis?: RoutingScoreBasis;
    }> = [];
    const seenPairs = new Set<string>();
    const pushCandidate = (
      prov: string,
      mdl?: string,
      score?: number,
      scoreBasis?: RoutingScoreBasis,
    ): void => {
      if (!prov || excluded.has(prov) || registryBlocked.has(prov)) return;
      const model = mdl && mdl !== 'default' ? mdl : 'default';
      // Model-scoped session exclusion — only THIS model, never its siblings.
      if (isModelExcluded(prov, model)) return;
      const key = `${prov}|${model}`;
      if (seenPairs.has(key)) return;
      // NOTE: deliberately NO registry-usability skip here. `resolveWorkingModel`
      // below OWNS model health — it repairs a dead/parked model to a live one
      // on the SAME provider. Filtering the candidate out first would skip the
      // whole provider and bypass that repair (observed: a stale gemini pin made
      // chat jump straight to local without ever trying gemini). The chain
      // already ranks healthy models first, so the parked pick is only ever a
      // last resort that the repair then fixes.
      seenPairs.add(key);
      chatCandidates.push({
        provider: prov,
        model,
        // Only a labelled measurement travels: an ordering placeholder must not
        // reach the audit trail as if it described this pair.
        ...(scoreBasis ? { score, scoreBasis } : {}),
      });
    };
    // The pool itself is the SAME one the orchestrator/tool/sub-agent path
    // walks: primary → model-first TIERED pool (same model on other providers,
    // same tier, escalate/de-escalate, local) → router chain (deep pairs +
    // reserve) → ranked placeholders → config fallback. Chat used to build a
    // shallower list here, which is why it reached strictly fewer models than
    // the orchestrator could.
    // P3 — TASK-LEVEL CONTINUITY (RC7). A continuation carries no signal about
    // its own task, so the router re-decides from scratch and can land on a model
    // that has never served it (the live `resume` degraded from a working Gemini
    // model to one that returned nothing). Offer the pair that DID serve this
    // task FIRST. It is pushed through the same `pushCandidate` gate as every
    // other candidate, so a dead key, an active exclusion or a registry block
    // simply drops it and the normal pool is used instead.
    if (opts?.routingText) {
      const recalled = this.taskContinuity.recall(this.lastTaskSignature);
      if (recalled) pushCandidate(recalled.provider, recalled.model);
    }
    const pool = buildDeepFailoverPool(decision, {
      taskDescription: message,
      complexity: decision.complexity,
      configManager: this.configManager,
    });
    for (const c of pool) pushCandidate(c.provider, c.model, c.score, c.scoreBasis);

    // Unique provider list (what callers use for their own failover) — derived
    // from the pair list so it stays consistent with what is actually tried.
    const candidates = [...new Set(chatCandidates.map((c) => c.provider))];

    for (const candidate of chatCandidates) {
      try {
        const resolved = resolveProvider(this.configManager, candidate.provider);
        if (await resolved.provider.isAvailable()) {
          const desired = candidate.model !== 'default'
            ? candidate.model
            : getAutoRouter().resolveModel(candidate.provider, 'chat', this.configManager);
          // Model health: only use models that actually exist on the provider.
          // A provider's pinned config.model can be deprecated or a placeholder
          // (e.g. gemini-2.0-flash-exp → 404) — repair to a live model. The pair
          // is validated against `resolved.provider`, the adapter that serves the
          // call, and a substitution is printed rather than made silently.
          const model = (await resolveRoute({
            providerType: candidate.provider,
            provider: resolved.provider,
            model: desired,
            source: 'chat',
            agentType: 'chat',
            task: message,
            verifyOnDemand: isMaxCapability(this.configManager),
          })).model;
          // Record the actually-used route for the dashboard audit trail.
          // B2-a — the score belongs to THE PAIR THIS ROW NAMES. `decision.score`
          // describes the router's own pick; a walked alternate has its own score
          // (`candidate.score`, a model-level measurement from the tiered pool) or
          // none at all (an ordering placeholder / a recalled pair). Writing the
          // decision's number here is what made a walk look like a tie.
          recordRoutingDecision({
            source: 'chat',
            agentType: 'chat',
            task: message,
            complexity: decision.complexity,
            provider: candidate.provider,
            model,
            ...(candidate.scoreBasis
              ? { score: candidate.score, scoreBasis: candidate.scoreBasis }
              : {}),
            agenticCapable: isAgenticCapableModel(model, candidate.provider),
            overrideReason: decision.overrideReason,
            ...(opts?.fallbackFrom ? { fallbackFrom: opts.fallbackFrom } : {}),
          });
          return {
            type: resolved.type,
            provider: resolved.provider,
            model,
            ranked: candidates,
            complexity: decision.complexity,
            score: decision.score,
            agenticCapable: isAgenticCapableModel(model, resolved.type),
            overrideReason: decision.overrideReason,
            taskProfile: {
              intent: decision.taskProfile.intent,
              requiresVerification: decision.taskProfile.requiresVerification,
            },
          };
        }
      } catch {
        // Unresolvable candidate — try the next one
      }
    }

    // Nothing available — surface a usable pick so the caller's isAvailable()
    // gate shows a clear, actionable error. Prefer the best-ranked provider
    // that has NOT failed this session and is NOT registry-blocked (the
    // literal router winner could be a provider whose key just died —
    // re-surfacing it would re-fail and confuse the user instead of failing
    // over).
    const usableProvider =
      [decision.provider, ...decision.ranked.map((r) => r.provider)]
        .find((p) => !isActiveExclusion(p) && !registryBlocked.has(p)) || decision.provider;
    // B2-a — this row names `decision.model` possibly on a DIFFERENT provider
    // than the decision's (`usableProvider`), so the decision's composite does
    // not describe it. The pair was never ranked as a whole; record it bare
    // rather than attaching a number that belongs to another provider.
    recordRoutingDecision({
      source: 'chat',
      agentType: 'chat',
      task: message,
      complexity: decision.complexity,
      provider: usableProvider,
      model: decision.model,
      agenticCapable: isAgenticCapableModel(decision.model, usableProvider),
      overrideReason: decision.overrideReason,
      ...(opts?.fallbackFrom ? { fallbackFrom: opts.fallbackFrom } : {}),
    });
    const resolved = resolveProvider(this.configManager, usableProvider);
    const model = (await resolveRoute({
      providerType: usableProvider,
      provider: resolved.provider,
      model: decision.model,
      source: 'chat',
      agentType: 'chat',
      task: message,
      verifyOnDemand: isMaxCapability(this.configManager),
    })).model;
    return {
      type: resolved.type,
      provider: resolved.provider,
      model,
      ranked: candidates,
      complexity: decision.complexity,
      score: decision.score,
    };
  }

  /**
   * Read multi-line input from stdin using readline.
   *
   * - First line prompt: "You: "
   * - Continuation lines prompt: "  > "
   * - Pressing Enter with no text on the first line re-prompts
   * - An empty line after non-empty input submits the message
   * - This allows pasting multi-line text (each line collected), then Enter to submit
   */
  private readMultiLineInput(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: prompt + ' ',
        // Don't let readline handle SIGINT — we handle it at process level
        terminal: true,
      });

      const lines: string[] = [];
      let isFirstLine = true;

      // Handle SIGINT on readline:
      // - If user was typing: cancel input and re-prompt
      // - If on empty line: first press shows warning, second press within 2s exits
      let rlSigintCount = 0;
      let rlSigintTimer: ReturnType<typeof setTimeout> | null = null;
      rl.on('SIGINT', () => {
        if (lines.length > 0 || !isFirstLine) {
          // User was typing something — cancel input and re-prompt
          lines.length = 0;
          isFirstLine = true;
          if (rlSigintTimer) clearTimeout(rlSigintTimer);
          rlSigintCount = 0;
          rl.setPrompt(prompt + ' ');
          rl.prompt();
          return;
        }
        // No input yet — handle double-press
        rlSigintCount++;
        if (rlSigintCount >= 2) {
          // Second press — exit cleanly
          console.log('');
          lines.push('/exit');
          rl.close();
          return;
        }
        // First press — show warning
        console.log('\n\n⚠️  Press Ctrl+C again to exit, or type /exit to quit.\n');
        rl.prompt(true);
        if (rlSigintTimer) clearTimeout(rlSigintTimer);
        rlSigintTimer = setTimeout(() => {
          rlSigintCount = 0;
        }, 2000);
      });

      rl.on('line', (line) => {
        if (isFirstLine) {
          isFirstLine = false;
          if (line === '') {
            // Just pressed Enter on first line with no text — re-prompt
            rl.prompt();
            isFirstLine = true;
            return;
          }
          lines.push(line);
          // Commands (starting with '/') should submit immediately — no continuation needed
          if (line.startsWith('/')) {
            rl.close();
            return;
          }
          rl.setPrompt('  > ');
          rl.prompt();
        } else {
          if (line === '') {
            // Empty line on continuation — submit the full message
            rl.close();
          } else {
            lines.push(line);
            rl.prompt();
          }
        }
      });

      rl.on('close', () => {
        resolve(lines.join('\n'));
      });

      rl.prompt();
    });
  }

  private async handleCommand(
    cmd: string,
    provider: any,
    model: string | undefined,
    currentType: string,
  ): Promise<{ exit: boolean; newType?: string; newProvider?: any; newModel?: string; auto?: boolean }> {
    switch (cmd.toLowerCase()) {
      case '/exit':
      case '/quit':
        console.log('Goodbye!');
        return { exit: true };
      case '/help':
        console.log(`
Commands:
  /exit, /quit          Exit the chat
  /clear                Clear conversation history
  /info                 Show provider & model info
  /help                 Show this help
  /dev                  Toggle developer mode (auto-create files)
  /search <query>       Search past conversations by keyword
  /model                Switch providers/models mid-session
        `.trim());
        return { exit: false };
      case '/clear':
        console.log('Conversation history cleared.');
        return { exit: false };
      case '/info':
        console.log(`\n${provider.getInfo()}${model ? `\n  Model: ${model}` : ''}\n`);
        return { exit: false };
      case '/dev':
        this.devModeAuto = !this.devModeAuto;
        if (this.devModeAuto) {
          logger.success('✅ Developer mode ACTIVATED — the rule hint prefers file-creating pipeline actions.');
        } else {
          logger.info('ℹ️  Developer mode DEACTIVATED — the model decides freely; rules are hints only.');
        }
        return { exit: false };
      case '/model': {
        const picked = await showModelPicker(this.configManager);
        if (!picked) {
          logger.info('Model selection cancelled.');
          return { exit: false };
        }
        // ── Auto selected — enable auto routing ──────────────────────
        if (picked.provider === 'auto' || isAutoModel(picked.model)) {
          return { exit: false, auto: true };
        }
        const resolved = resolveProvider(this.configManager, picked.provider);
        if (resolved.type !== currentType || picked.model !== model) {
          return {
            exit: false,
            newType: resolved.type,
            newProvider: resolved.provider,
            newModel: picked.model,
          };
        }
        return { exit: false };
      }
      case '/search': {
        let searchQuery = cmd.slice(8).trim();
        let useSemantic = false;

        if (searchQuery.startsWith('--semantic ')) {
          useSemantic = true;
          searchQuery = searchQuery.slice(11).trim();
        }

        if (!searchQuery) {
          console.log('Usage:');
          console.log('  /search <query>               Keyword search (default)');
          console.log('  /search --semantic <query>    Semantic search (using local embeddings)');
          console.log('');
          console.log('Examples:');
          console.log('  /search authentication');
          console.log('  /search --semantic how to add JWT auth to Express');
          return { exit: false };
        }

        const chatHistory = getChatHistory();
        const results = useSemantic
          ? await chatHistory.searchSemantic(searchQuery, 5)
          : chatHistory.search(searchQuery, 5);

        if (results.length === 0) {
          logger.info(`No past conversations found matching "${searchQuery}".`);
        } else {
          const mode = useSemantic ? '🧠' : '🔍';
          const modeLabel = useSemantic ? ' (semantic)' : '';
          logger.highlight(`${mode} Past conversations matching "${searchQuery}"${modeLabel}:`);
          console.log('');
          for (const session of results) {
            console.log(chatHistory.formatSessionSummary(session));
          }
          console.log('');
          logger.info('Use `nuvira history show <session-id>` to view a full conversation.');
        }
        return { exit: false };
      }
      default:
        console.log(`Unknown command: ${cmd}. Type /help`);
        return { exit: false };
    }
  }

}
