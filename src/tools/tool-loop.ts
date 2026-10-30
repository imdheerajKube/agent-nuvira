/**
 * E3b — The tool loop (`src/tools/tool-loop.ts`).
 *
 * The chat
 * loop continues while the model emits tool calls and ends on a no-tools
 * response; think-only responses continue; tool-call errors force another
 * step so the model retries in-context with the error message.
 *
 * The loop is PURE and provider-agnostic: `callModel` and `executeTool` are
 * injected by the caller (chat.ts wires real providers + the ToolExecutor),
 * so tests drive every path with mocks — no network, no TTY.
 *
 * Two transports (C3 acceptance b, H1):
 * - Native: the provider implements `generateTools` (tool_calls protocol).
 * - JSON fallback: the model emits `{"tool":"<name>","arguments":{...}}`
 *   blocks after its response text (contract in TOOL_CONTRACT_JSON).
 */

import { getTool, listTools, toolJsonSchemas, type ToolContext, type ToolJsonSchema } from './registry.js';
import { effectClassOfTool } from './capability-registry.js';
import type { ExecutedAction } from '../findings/verdicts.js';
// A1 — build-command recognition, shared with effect verification so "a build"
// means the same thing to both the launch check and the honesty guard.
import { isBuildCommand } from '../utils/effect-verification.js';
// WS3 (#25) — the turn's span tree. Null-safe throughout: with export off every
// helper below is a no-op and no span object is ever built.
import { TOOL_SPAN_PREFIX, withSpanActive, type SpanHandle } from '../observability/otel.js';
// WS4 (#26) — the operator's tool lifecycle hooks. Never able to break a call:
// `runBeforeToolHooks` always resolves, and a broken hook never vetoes.
import {
  runBeforeToolHooks,
  runToolOutcomeHooks,
  toolHookRefusalText,
} from './tool-hooks.js';
// WS5 (#27) — the resume ledger. A `StepReplay` is threaded through the turn
// when the run is a resume; `stepDigest` is over the whole input, so a step whose
// thread or tool schema changed MISSES and is paid for again (see the module).
import { stepDigest, stepShape, type StepReplay } from '../learning/step-checkpoint.js';
// P2 (fix_model_routing) — the shared definition of "this response carries
// nothing usable". The loop does not re-invent the rule; it asks the same module
// the failover walk validates with, so "empty" means one thing in this repo.
import type { UnusableResponseKind } from '../learning/response-usability.js';
// P7 — the identical-command guard's memory. The loop drops it when a WRITE is
// applied, so a repaired project can re-run its own check (see the context below).
import { existsSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';

import { RUN_TERMINAL_INCOMPLETE_PREFIX, resetTerminalFailureStreaks } from './run-terminal.js';
import { createRunCommandMemo } from './command-memo.js';
// Findings are the yield of an assessment (see `learning/finding-yield.ts`):
// an audit's budget is extended while its report is GAINING defects and ends
// when a whole round adds none. Imported here rather than computed in the loop
// so the counting rule (and its tests) live in one module.
import {
  assessmentExtensionCap,
  countSourceFiles,
  readFindingYield,
} from '../learning/finding-yield.js';
import { isProjectAssessmentGoal } from '../learning/assessment-protocol.js';
// Assessment BREADTH, as data the harness owns: what was opened, and the unread
// files the opened ones import (see `learning/coverage-ledger.ts`).
import { CoverageLedger } from '../learning/coverage-ledger.js';
// What this turn EXAMINED, for the NEXT run: the project-relative coverage map in
// the working-state ledger (see `learning/working-state.ts`). The breadth ledger
// above is per-turn and in memory; this one survives the run.
import { flushCoverage, isProjectLedgerDir, noteCoverage } from '../learning/working-state.js';
// The safety net a bad batch of edits needs: a restorable copy of the tree, taken
// BEFORE the first write of the turn (see `learning/workspace-checkpoint.ts`).
import {
  createWorkspaceCheckpoint,
  DEFAULT_AUTO_KEEP,
  formatBytes,
  pruneAutoCheckpoints,
} from '../learning/workspace-checkpoint.js';
// REQUIRED ARTIFACTS — the files and test classes an ask NAMED (see
// `learning/task-artifacts.ts`). Measured 2026-10-25: a 30-minute build task that
// named todo/progress/issues/changelog, a README and e2e tests ended with none of
// them, because the turn ends when the model stops calling tools.
import { artifactsGateApplies, artifactsNudge, deliverableFirstNudge } from '../learning/task-artifacts.js';
// A "production-ready" ask owes an operational artefact (see `learning/doc-claims.ts`):
// the README says how to run it locally, which is not how it reaches a server.
import { productionDutyNudge, productionReadinessDuty } from '../learning/doc-claims.js';
// DELIVERABLE COVERAGE — the surfaces the ask NAMED (frontend, API, schema, e2e,
// tests) checked against the tree (see `learning/deliverable-coverage.ts`).
// Measured 2026-10-26: a 210-step build ended with every existing-artifact gate
// satisfied and no frontend at all, because nothing asked about what was ABSENT.
import { missingSurfaceGaps, surfaceGapsNudge } from '../learning/deliverable-coverage.js';
// THE ADOPTION KIT — the documents that let a stranger USE the delivered service
// (see `learning/adoption-kit.ts`). Measured 2026-10-27, the head-to-head: Cline
// shipped an OpenAPI contract, an operations runbook, a threat model and ADRs;
// nuvira shipped every suite green with none of them, and that — not the code —
// was the whole difference in "a product is what a stranger can adopt".
import { adoptionKitNudge, missingAdoptionItems } from '../learning/adoption-kit.js';
// PLAN DEPTH — a build's breadth is set by the granularity of its plan (see
// `learning/plan-depth.ts`). Measured 2026-10-27: the arm with 69 endpoints had a
// 15-phase, ~150-task list; the arm with 51 had one step naming eight features.
import { MAX_FEATURES_PER_STEP, planDepthIssue, planDepthNudge } from '../learning/plan-depth.js';
// CHANGE REQUESTS — the requirement that arrives while the turn is still running,
// delivered mid-turn instead of at the ceiling (see `learning/change-request.ts`).
import {
  changeRequestNudge,
  changeRequestStatus,
  changeRequestUnheardNudge,
  readChangeRequest,
} from '../learning/change-request.js';
// The one-shot prefix compaction is gated on a provider that actually caches
// prefixes; on anything else the loop keeps trimming per call (see the module).
import { cacheStablePrefixPaysOff } from '../learning/prompt-cache.js';
// A request the provider cannot PARSE is repaired, not repeated: see the catch
// block below and `inference/wire-sanitize.ts`.
import { poisonedMessageIndex, repairPoisonedMessage } from '../inference/wire-sanitize.js';
// WS6 (#28) — the declared fault seam. `faultAt` is a null check when this
// process declared no fault (`NUVIRA_INJECT_FAULT`), so an ordinary turn is
// unaffected.
import { faultAt } from '../runtime/fault-injection.js';
import {
  detectPermissionSeeking,
  isAffirmativeReply,
  replyAsksTheReader,
  requestAuthorizesWrites,
  requestForbidsWrites,
  stripTrailingPermissionSeek,
} from '../learning/autonomy-policy.js';
import {
  envelopeFromPlan,
  envelopeFromRequest,
  getEnvelope,
  grantEnvelope,
  isEnvelopeKey,
  type IntentEnvelope,
} from '../learning/intent-envelope.js';
import {
  detectProcessComplaint,
  isTraceKey,
  noProgressNudge,
  repeatNudge,
  repeatedFailureNudge,
  runTraceFor,
  RunTrace,
  type RunTraceSnapshot,
} from '../learning/run-trace.js';
import { asksForAuthoredFile, isAuthoredGoal, wantsAuthoredArtifact } from '../learning/deliverable-class.js';
import { isAuthoredReadBack } from '../learning/turn-report.js';
import { parseLongFormTarget, countWords } from '../learning/long-form.js';
import { normalizeFollowups, type FollowupSuggestion } from './followup-utils.js';
import type { ToolArgumentsError } from '../inference/interface.js';
// The capability mode (balanced | max) — `max` widens the loop's own reasoning
// budget as well as routing, so "cost is not a concern" means the agent may
// keep working through a long build instead of stopping at the default bound.
import { isMaxCapability } from '../config/capability-mode.js';
// The digest's scope (all | max | off) — a user-facing control over whether the
// compaction digest is injected in every mode, only under `max`, or never.
import { isWorkDigestEnabled } from '../config/work-digest.js';
import {
  assessEditActivity,
  autoVerifyCheck,
  detectUnverifiedEditClaim,
  isVerificationTool,
  verificationNudgeFor,
  THINK_ONLY_ESCALATION,
  AUTHORIZED_WORK_NUDGE,
  deliverableNudge,
  type ToolCallEvidence,
} from './edit-verification.js';
import { createHarnessDirectiveSink, type HarnessObservation } from './harness-directive.js';
// The placeholder the wire layer uses when a thinking model's reasoning was not
// retained; the loop stamps it once the turn is known to be in thinking mode (see
// `thinkingModeSeen`).
import { REASONING_NOT_RETAINED } from '../inference/thinking-replay.js';
import type { PlanEvidence, PlanSnapshot } from './plan-store.js';
import { effectiveToolJsonSchemas, coreToolJsonSchemas, isToolEnabled, toolsetForTool } from './toolsets.js';
import { deliverablesNamedIn, recordStepHandoff } from '../agents/step-handoff.js';
import { verifyArtifacts } from '../agents/artifact-verification.js';
import { fenceUntrustedToolOutput } from './untrusted-content.js';
import {
  installableToolsFromFailure,
  resolveInstallCommand,
  toolTakeoverInstruction,
} from '../cli/tool-install-prompt.js';
import {
  matchPrerequisiteSignatures,
  prerequisiteTakeoverInstruction,
  checkProjectPrerequisites,
  createNodePrereqFs,
  formatPreflightFindings,
} from '../learning/build-prerequisites.js';
import type { TraceEvent, TraceGateName } from '../learning/reasoning-trace.js';
import {
  buildRequirementLedger,
  describeUnmet,
  resolveRequirementLedger,
  type RequirementLedger,
} from '../learning/requirement-ledger.js';
import {
  bindWrittenModulesToTests,
  isSourceModule,
  testBindingApplies,
  type BindingReport,
} from '../learning/test-binding.js';
import { auditDocClaims, docClaimsNudge, quickstartDuty, quickstartNudge } from '../learning/doc-claims.js';
import {
  parseFailingCount,
  redCheckNudge,
  unansweredRedChecks,
  type CheckRun,
  type RedCheck,
} from '../learning/check-ledger.js';
import {
  FINISH_ACCEPTED_MARKER,
  completionNudge,
  type TurnLedgerSnapshot,
} from '../learning/completion-contract.js';
import { isBuildShapedAsk } from '../learning/task-artifacts.js';
// The harness's own banners (`[Origin: …]`, `[Image: …]`, …) are not part of the
// ask. This is the ONE rule for removing them (measured in `hybrid-router.ts`:
// 63 of 98 area hits were the harness reading its own scaffolding), reused here so
// the gates that measure an ask — deliverables, shape, plan duty — read the user.
import { stripInjectedContext } from '../learning/hybrid-router.js';

/**
 * Tools that MUTATE the workspace. A refusal of one of these is the only
 * refusal that leaves work undone — a declined `read_file` costs a step, a
 * declined `write_file` means the deliverable was never produced.
 */
const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'propose_change',
  'run_terminal',
  'run_cli',
]);

/**
 * The subset of mutating tools the PLAN gate HARD-BLOCKS on the first call —
 * the ones that change the workspace's FILES. `run_terminal` / `run_cli` are
 * deliberately excluded from the BLOCK (they still trigger the nudge): a
 * terminal command is as often a test, a build or an inspection as it is an
 * edit, and refusing it outright would stop the very step a plan is meant to
 * reach. The nudge still tells the model to plan first.
 */
const PLAN_GATED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'propose_change',
]);

/**
 * Tools whose success is BOOKKEEPING, not work on the request.
 *
 * Used by the completion gate: a turn that only recorded a plan or a follow-up
 * suggestion has not begun the ask, and asking it to close requirement rows would
 * be the zero-action gate's job said twice. Deliberately small — a tool whose
 * result carries evidence about the workspace (a read, a search, a check) is work.
 */
const CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'suggest_followups',
  'ask_user',
  'plan_todo',
  'finish',
  'finding',
  'verify_requirement',
  'skill',
  'tool_search',
]);

/** The path a mutating call was aimed at, when it named one. */
function mutatedPathOf(args: unknown): string | undefined {
  const a = args as { path?: unknown; file_path?: unknown; file?: unknown } | undefined;
  const p = a?.path ?? a?.file_path ?? a?.file;
  return typeof p === 'string' && p.trim() ? p.trim() : undefined;
}

/**
 * The ACTION signature of a failed call — what it tried to do, so the identical
 * retry is recognizable. Prefers the shell `command`, then the file `path`,
 * then the tool name (a call that named neither still repeats as the same tool).
 * Used by the self-diagnosis gate (see RunTrace.repeatedFailure).
 */
function failureActionOf(call: { name: string; arguments?: unknown }): string {
  const a = call.arguments as { command?: unknown; query?: unknown } | undefined;
  const command = typeof a?.command === 'string' && a.command.trim() ? a.command.trim() : undefined;
  if (command) return command;
  const path = mutatedPathOf(call.arguments);
  if (path) return path;
  return call.name;
}

/**
 * Append what a tool call actually did to the turn's provenance ledger.
 *
 * Only the two things a finding may cite and a machine can check are recorded:
 * the shell `command` a call ran, and the `path` a file call touched. A call
 * that named neither (a plan, a follow-up, a search) contributes nothing, and a
 * value that is present but blank is treated as absent — the same standard the
 * finding gate applies to an evidence reference.
 */
function recordExecutedAction(
  ledger: ExecutedAction[],
  tool: string,
  args: unknown,
  ok: boolean,
): void {
  const a = args as { command?: unknown } | undefined;
  const command = typeof a?.command === 'string' && a.command.trim() ? a.command.trim() : undefined;
  const path = mutatedPathOf(args);
  if (command === undefined && path === undefined) return;
  ledger.push({ tool, ok, ...(command ? { command } : {}), ...(path ? { path } : {}) });
}

/**
 * The ask this turn is answering — the text a hand-off is keyed against.
 * `authorizationRequest` is the loop's own record of the last user message;
 * the thread scan is the fallback for callers that do not set it (tests, direct
 * invocations). Injected blocks (`[Project context]`, the route feed) are
 * skipped: they are the loop's own additions, not the user's words.
 */
function currentAsk(opts: ToolLoopOptions): string {
  const recorded = opts.context?.authorizationRequest?.trim();
  if (recorded) return recorded.slice(0, 600);
  const messages = opts.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    // The harness's OWN banners (`[Origin: …]` from the gateway, `[Image: …]`,
    // `[Attached: …]`) are stripped rather than treated as the ask's start: the
    // message IS the user's, it just arrives behind a line this product wrote.
    // Skipping the whole message (the earlier rule) threw the ask away on every
    // messaging turn, so the loop's gates measured nothing there.
    const text = stripInjectedContext(m.content ?? '').trim();
    if (!text) continue;
    return text.slice(0, 600);
  }
  return '';
}

/**
 * G18 — one NON-LLM fact about a loop turn, as the loop observed it.
 *
 * Type-only on purpose: the loop DESCRIBES what happened and the surface
 * decides where to record it (this module must not reach into the trace store,
 * which is what kept the loop invisible in the first place — see the G18 entry
 * in ENTERPRISE_GRADE_TRACKER.md). `seq`/`timestamp` belong to the store, so
 * they are assigned there, exactly like a trace step.
 */
export type LoopTraceEvent = Omit<TraceEvent, 'seq' | 'timestamp'>;
import { appendToolArtifact } from './artifact-append.js';
import type { ToolMessage } from '../inference/interface.js';
import type { ServedRoute } from '../inference/route-resolver.js';
import { ROUTE_FEED_MARKER, isUnresolvedModel, routeFeedFingerprint, routeFeedText } from './loop-route-feed.js';
import { logger } from '../utils/logger.js';
import {
  toUserFacingGenerationError,
  TEXTUAL_TOOL_CALL_HINT,
  isTextualFollowupsPayload,
  followupEntriesFromPayload,
  stripTrailingFollowupsHeader,
} from '../inference/tool-call-utils.js';

export { type ToolMessage };

// ─── P3c — tool-fallback hints (switch tools when one fails) ────────────────
// The ask: *"if one tool fails you switch to another and explore parallel
// ways"* (round-2 row 25). Today the raw `Error: …` text is fed back and a
// STRONG model retries with another tool — a weak model repeats the same
// failing call. These deterministic per-tool alternatives (no LLM call) make
// the fallback model-independent: on error/denial the hint is appended, on
// success it never fires.

/**
 * Concrete alternative-tool hints per tool. Each names the exact delegate
 * agent_type / syntax so a weak model can act without inventing one.
 */
const TOOL_FALLBACK_HINTS: Record<string, string> = {
  run_terminal:
    'Try delegate with agent_type "tester" for an isolated test/verify run, or retry run_terminal with a longer timeout_ms.',
  read_file:
    'Try code_search (pattern, cwd) to locate the relevant lines, or delegate to agent_type "context-gatherer" to map the file.',
  glob: 'Try list_dir or code_search to explore the workspace instead.',
  list_dir: 'Try glob (pattern) or code_search to find files by content/shape instead.',
  code_search: 'Try glob or read_file — or delegate to agent_type "context-gatherer" for a broader scan.',
  edit_file:
    'Re-read the target with read_file first (the match must be exact), then retry edit_file.',
  write_file: 'Check the parent directory with list_dir, then retry write_file.',
  web_search: 'Try read_page directly on the likely URL, or delegate to agent_type "researcher" for a broader web pass.',
  read_page: 'Try web_search to find the URL, or delegate to agent_type "researcher".',
  plan_todo: 'The plan is best-effort — mark the step blocked and continue with the remaining steps.',
  skill: 'Try listing available skills (skill tool with no name) — or delegate to the sub-agent that owns the capability.',
  clone_repo: 'Verify the URL with web_search, then retry clone_repo — or delegate to agent_type "context-gatherer" to assess the repo.',
  git: 'Try run_terminal with the read-only git command (git status / git diff), or delegate to agent_type "tester" to verify the change.',
  delegate: 'A sub-agent failed — retry with a narrower prompt, or run the subtask yourself with the direct tools.',
  gateway_send: 'Verify the target alias with the gateway directory, then retry gateway_send.',
};

/**
 * The P3c fallback hint for a failed tool call — appended to the error text
 * the model sees. Returns null when the tool has no hint (advisory only; the
 * model still decides). Falls back ONLY on error/denial, never on success.
 */
export function fallbackHintForTool(tool: string, resultText: string): string | null {
  if (!resultText || resultText.startsWith('Error:')) {
    return TOOL_FALLBACK_HINTS[tool] ?? null;
  }
  return null;
}

// ─── P3d — parallel suggestion (explore parallel ways) ─────────────────────
// The ask: *"explore parallel ways"* — independent subtasks should fan out,
// not serialize. The loop is strictly sequential (one tool call per step),
// but `delegate` → `spawnSubagents` (Promise.all, max 4) exists — the model
// just never hears about it. After 2+ SUCCESSFUL independent gather steps in
// a turn, inject an advisory delegate suggestion (exact syntax, bounded to
// delegate's max 4, never on dependent/sequential steps).

/** The gather-type tools whose calls are "independent" (fan-out candidates). */
const INDEPENDENT_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'code_search', 'web_search', 'read_page']);

/**
 * Should a parallel-delegate suggestion fire now? Tracks per-turn successful
 * independent calls; fires once after the 2nd independent success (then stays
 * quiet — one suggestion per turn is enough, the model decides whether to use
 * it). Pure + deterministic (no LLM).
 */
export function makeParallelSuggester(initialCounts: Record<string, number> = {}) {
  const counts: Record<string, number> = { ...initialCounts };
  let fired = false;
  return {
    /** Record a successful independent tool call. Returns the suggestion or null. */
    note(tool: string, ok: boolean): string | null {
      if (!INDEPENDENT_TOOLS.has(tool) || !ok || fired) return null;
      counts[tool] = (counts[tool] ?? 0) + 1;
      if (counts[tool] >= 2) {
        fired = true;
        return (
          `💡 Tip: you have gathered ${counts[tool]} independent items with ${tool} — if these are separate subtasks, ` +
          `consider delegate (agent_type "context-gatherer" or "tester") to run up to 4 of them IN PARALLEL ` +
          `instead of one at a time.`
        );
      }
      return null;
    },
    /** Whether the suggestion already fired this turn. */
    get hasFired(): boolean {
      return fired;
    },
  };
}

/** A step response — either a native tool-call response or parsed fallback. */
export interface StepResponse {
  /**
   * The provider's own token counts for this step, when the endpoint reported
   * any (see `ToolCallResponse.usage`). Carried through the loop so the surface
   * can report a MEASURED cost instead of a `chars/4` estimate.
   */
  usage?: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number };
  content: string;
  /** Parsed tool calls (empty = end turn). */
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    /** Provider-owned opaque data echoed back on replay (Gemini thoughtSignature). */
    providerMeta?: Record<string, unknown>;
    /**
     * Why the arguments are USELESS — set by the adapter when the call's
     * argument payload never arrived or could not be parsed (see
     * `inference/interface.ts` `ToolArgumentsError`). The loop REFUSES such a
     * call instead of executing it with an empty object; the measured cost of
     * executing it is 59 silent retries in one dashboard turn.
     */
    argumentsError?: ToolArgumentsError;
  }>;
  /**
   * The model's `reasoning_content` for this step, when it returned one. Carried
   * onto the assistant message so a thinking model (DeepSeek v4) can be handed
   * its own prior reasoning back — see {@link ToolMessage.reasoningContent}.
   */
  reasoningContent?: string;
  /**
   * How many tool-call turns this step's request had to have a reasoning
   * placeholder filled into before the endpoint accepted it. Present only when
   * the first attempt was rejected and repaired (inference/tools.ts), so the
   * loop can report the repair instead of passing it off as a clean request.
   */
  repairedReasoningTurns?: number;
  /**
   * The provider's `finish_reason` for this step, when it reported one.
   * `'length'` means the response was cut at the output-token cap — the reason a
   * call's arguments can arrive empty or truncated, and the fact the refusal in
   * `malformedToolCallRefusal` quotes instead of guessing.
   */
  finishReason?: string;
  /**
   * Which transport ACTUALLY carried this step's tool calls, in the same
   * vocabulary the subagent child announces
   * (`src/tools/child-agent-runtime.ts`):
   *
   *   - `native` — the provider's own tool-calling API served the step.
   *   - `json`   — the shared JSON-fallback transport served it (the provider
   *                could not do native tool calling, or is known not to).
   *   - `none`   — no tool schema was offered, so no tool transport was
   *                involved at all.
   *
   * The CALLER sets it, because only the caller knows which branch of its own
   * model-call seam ran (the loop above it just relays). Absent means "this
   * caller does not report a transport" — deliberately not the same fact as
   * `none`, and the reason a comparison treats a missing value as a missing
   * value rather than as silence that equals agreement.
   */
  transport?: 'native' | 'json' | 'none';
}

/** What the caller injects — chat.ts wires providers/failover, tests use mocks. */
export interface ToolLoopDeps {
  /**
   * Generate one step. `messages` is the FULL conversation so far (system
   * already prepended by the caller). `toolSchemas` are the available tools
   * (empty when the provider lacks native support — the contract text in the
   * system prompt handles the fallback transport).
   *
   * P4 — optional `onToken`: when provided, the caller streams content tokens
   * of this step as they arrive (the dashboard answer typewriter). The loop
   * passes ToolLoopOptions.onToken through; a provider without streaming
   * support simply ignores it and returns the whole step at once.
   * Optional `signal`: forwarded from ToolLoopOptions so an in-flight
   * provider request can abort (the dashboard Cancel button).
   *
   * R2 — the caller should set {@link StepResponse.transport} on every step it
   * returns: it is the only party that knows whether its own seam spoke the
   * provider's native tool protocol or the shared JSON fallback. The loop
   * relays the last value it saw to `ToolLoopResult.transport`, which is how a
   * surface that is NOT the subagent child can still be attributed a transport.
   */
  callModel(
    messages: ToolMessage[],
    toolSchemas: ToolJsonSchema[],
    onToken?: (token: string) => void,
    signal?: AbortSignal,
    /**
     * Display-only sink for the step's `reasoning_content` as it streams. The
     * loop forwards ToolLoopOptions.onReasoning; a caller that does not stream
     * reasoning simply ignores it.
     */
    onReasoning?: (token: string) => void,
  ): Promise<StepResponse>;
  /** Execute one tool call. Returns the tool-result text fed back to the model. */
  executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
  /** Whether a content-only response is a think-only block (continues, doesn't end). */
  isThinkOnly?(content: string): boolean;
  /**
   * P2 — MID-TURN MODEL HANDOFF. The loop calls this when the model it is
   * talking to resolved with NOTHING usable (no answer text and no tool call) and
   * the same model has already had its one retry. The caller owns the pool, so
   * it — not the loop — decides which model is next: install a DIFFERENT
   * provider/model and resolve `true`, or resolve `false` when there is genuinely
   * no other candidate left to try.
   *
   * Why the loop cannot do this itself: the pool, its exclusions, the credential
   * gate and the session cooldowns all live above it. Retrying the SAME model was
   * the defect (five consecutive empty responses from one model ended a real turn
   * while healthy models sat configured and unused), so the retry decision is
   * delegated out rather than guessed at.
   *
   * A `false` is NOT a dead end: the loop falls back to its own bounded
   * escalation, so a turn with no alternative still ends exactly as it did
   * before. Omitted entirely (mocks, sub-agent children, older callers) → the old
   * behaviour, byte for byte.
   */
  requestModelSwitch?(reason: UnusableResponseKind): Promise<boolean> | boolean;
  /**
   * P5 — HOW LONG TO STAY ON A PAIR THAT JUST ANSWERED WITH NOTHING, before the
   * loop is allowed to hand the turn to a different model.
   *
   * The loop owns ONE retry (`MAX_SAME_MODEL_EMPTY_RETRIES`) and then asks for a
   * handoff. That is the right shape for a pair that is simply broken, but it is
   * the wrong shape for a BLINK: a cloud endpoint routinely answers 200 with an
   * empty body for a few seconds and then serves normally again (that is the
   * measured behaviour the whole blip policy in `learning/retry-patience.ts`
   * exists for), and folding over a blink is how a strong model gets silently
   * replaced by a weaker one nobody chose.
   *
   * The schedule already guards the THROWN empty-response path (chat's
   * `generateWithTransientRetry`), but a 200 carrying no content never reaches it
   * — the loop handles that case, which is why the policy has to be reachable
   * from HERE as well. Two live turns failed exactly there
   * (trace-1791906998502-txddq4, trace-1791907393457-7seewg): both emptied out,
   * both handed off after the loop's single retry, and both ended up on the local
   * last resort while the granted patience was never spent.
   *
   * The caller owns the evidence (the registry track record, the reachable
   * alternatives, the plan), so it — not the loop — returns the delays (ms) to
   * spend on THIS pair. `[]` means "hand off on the next empty", which is the
   * previous behaviour and the honest answer for a caller with no evidence.
   *
   * The loop asks ONCE per empty streak and memoizes the answer, so a plan that
   * shifts mid-blip cannot extend the wait; each granted delay is slept and the
   * SAME pair is re-asked; only once the schedule is spent does the loop call
   * `requestModelSwitch`. Omitted entirely (mocks, sub-agent children, older
   * callers) → byte-for-byte the previous behaviour.
   */
  emptyResponsePatienceMs?(info: {
    /** Empties in a row on the current pair, including the one being handled. */
    emptyStreak: number;
    /** Handoffs already spent this turn. */
    handoffs: number;
    /** Has this turn produced real, observed work (a completed tool call)? */
    deliveredWorkThisTurn: boolean;
  }): readonly number[];
  /**
   * C5 — RE-FIT THE THREAD TO THE MODEL THAT NOW ANSWERS.
   *
   * `threadBudgetChars` (see `LoopOptions`) is resolved ONCE by the caller —
   * before this loop starts, from the pair the turn began on. But
   * `requestModelSwitch` may install a DIFFERENT pair mid-turn, and the handoff
   * that actually overflows is the one to a SMALLER window: the caller had just
   * looked that window up, and the budget in hand was computed from the model
   * that just returned nothing.
   *
   * The caller owns the session, so the caller — not the loop — knows which
   * model is now serving and re-resolves its window. A NUMBER replaces the
   * budget; `undefined` KEEPS the current one, so an unknown window can never
   * silently shrink a thread. Omitted (mocks, sub-agent children, older
   * callers) → the budget stays exactly as resolved, byte for byte.
   */
  threadBudgetAfterSwitch?(): number | undefined;
  /** Log a loop event (board note / console line). Defaults to logger.info. */
  onEvent?(line: string): void;
}

export interface ToolLoopOptions {
  /**
   * Live sink for a thinking model's reasoning tokens (display only). The CLI
   * renders them as the model's working notes; the model's ANSWER text keeps
   * its own channel (onToken), so reasoning can never be mistaken for it.
   */
  onReasoning?: (token: string) => void;
  /** The full conversation history INCLUDING the current user message. */
  messages: ToolMessage[];
  /**
   * The run's id (`trace-…`) when the surface keeps one.
   *
   * Stamped on the coverage entries this turn writes, so a path the run examined
   * can be traced back to the run that examined it — a ledger that says "someone
   * read this" without saying who or when is nearly useless to the next reader
   * (see `learning/working-state.ts`).
   */
  runId?: string;
  /** Tool names to expose (default: every registered tool). */
  tools?: string[];
  /**
   * Tiered tool exposure (assessment Addendum v3/v4). When 'tiered' and no
   * explicit `tools` list is given, the model's schema starts at the CORE
   * primitive set; domain toolsets are loaded mid-turn via `tool_search`
   * (action "load"), whose result names the loop unions into the live
   * schema set. Default 'all' preserves the pre-tiering behavior exactly —
   * callers opt in (chat reads `tools.loopExposure` from config).
   */
  toolExposure?: 'all' | 'tiered';
  /**
   * WS3 (#25) — the turn's span, when span export is on (else null/absent).
   *
   * Tool calls become child spans under it and each one is made ACTIVE while the
   * tool runs, so a tool that forks a subagent can hand that child the right
   * trace parent (`childTraceEnv` reads the active context, not module state).
   *
   * The name is built HERE rather than at each surface, so every surface's tree
   * has the same shape — which is the only reason a tree can be compared across
   * surfaces at all.
   */
  otel?: SpanHandle | null;
  /**
   * WS5 (#27) — the resume ledger for this run, or null when it is a fresh run.
   *
   * With one supplied, a model call whose EXACT input (thread + tool schema)
   * matches a recorded step is replayed from the record instead of being made
   * again, and every call that is still made is recorded so the next resume can
   * replay it. Omitted entirely on an ordinary run: the ledger is then never
   * consulted, never built, and the turn behaves exactly as it did before.
   */
  resume?: StepReplay | null;
  /**
   * WS4 (#26) — the surface label this loop is running as (`cli-chat`,
   * `cli-execute`, `dashboard-chat`, `gateway-chat`, `subagent`).
   *
   * Passed on to a tool hook, so an operator's hook can tell WHERE a call came
   * from — which is the difference between a policy that can be written and one
   * that has to be guessed at. It is the same label the debug log header and the
   * turn span carry; the loop is the only place that knows it, so a surface that
   * does not pass it simply reports its calls with no surface name.
   */
  surface?: string;
  /**
   * R1 — bound on concurrent read-only calls per step, from the model's harness
   * profile. Omit for the default (4); pass 1 for tiny models.
   */
  maxParallelReads?: number;
  /**
   * Mechanical thread budget in characters (deterministic compaction —
   * see trimThreadBudget). 0 disables (default: DEFAULT_THREAD_BUDGET_CHARS).
   */
  threadBudgetChars?: number;
  /** Bound on steps per turn (default: 8) — never an infinite loop. */
  maxSteps?: number;
  /**
   * G1 — VERIFICATION GATE (default ON). When a turn mutated the workspace
   * (`edit_file`/`write_file` succeeded) and ran nothing that could observe
   * the result (`run_terminal`/`test`/`browser`/`run_cli`), the loop spends
   * ONE bounded nudge asking the model to verify before it can end the turn.
   * The residual signal is `ToolLoopResult.unverifiedEdit` (which is annotated
   * whether or not the nudge runs). Set false to restore the pre-gate behavior
   * (kept for tests that assert step counts on pure-edit scripts).
   */
  requireVerification?: boolean;
  /**
   * SELF-REVIEW GATE (default ON). When a SUBSTANTIAL turn (>= 6 steps) that
   * changed files is about to end — and the verification gate has nothing to ask
   * (i.e. the change was already observed) — the loop spends ONE bounded nudge
   * asking the model to check its result against the ORIGINAL ask: is every part
   * satisfied, and is every claim backed by a tool result from THIS turn?
   *
   * Why it is separate from the verification gate: verification answers "did you
   * check it works", self-review answers "did you answer the WHOLE question" —
   * the failure mode it targets is a verified, confident answer to a slightly
   * wrong question. Bounded once and only for long turns, so a short edit turn is
   * byte-identical. Set false to disable.
   */
  requireSelfReview?: boolean;
  /**
   * SELF-REVIEW FOR A TURN THAT CHANGED NOTHING (default OFF).
   *
   * The gate above fires only when the turn mutated the workspace
   * (`progress.mutatedPaths.length > 0`), which is right for a change: with no
   * edit there is nothing to re-read. An ASSESSMENT turn is the exception the
   * condition cannot express — its deliverable is a set of CLAIMS about code
   * nobody changed, and "is every claim backed by a tool result from THIS turn?"
   * is exactly as load-bearing there as it is after an edit. Measured: an
   * assessment run on the same model published two findings about inputs the
   * shipped UI cannot produce; no gate asks that question today.
   *
   * Off by default, so every existing caller is byte-identical — the assessment
   * surface is what turns it on. Still bounded to ONE nudge, and still behind
   * `SELF_REVIEW_MIN_STEPS`, so a short read-only turn pays nothing.
   */
  selfReviewWhenUnchanged?: boolean;
  /**
   * G13b — DELIVERABLE GATE (default ON). When the request asks for an AUTHORED
   * deliverable to be produced ("write a 12 page story at /path/Mahagatha.md")
   * and the turn ends having written NOTHING to disk, the loop spends ONE
   * bounded nudge naming the destination the request gave, then reports the
   * residual honestly (`ToolLoopResult.undeliveredArtifact`).
   *
   * Why a nudge and not a refusal: the loop reaches this in the cases the engine
   * router cannot cover — a chat surface, or an explicit `engineMode='loop'`
   * override — and in those cases the right outcome is still the ARTIFACT, not a
   * lecture. The router sends the default path to the pipeline engine (which
   * plans units and assembles the document); this gate is what makes "the
   * artifact lands" true on every entry point rather than only the default one.
   * Set false to restore the pre-gate behaviour.
   */
  requireDeliverable?: boolean;
  /**
   * ZERO-ACTION GATE (default ON). When the request DIRECTS work on the
   * workspace (a create/maintenance ask — `requestAuthorizesWrites`) and the
   * turn is about to END having called no tool at all, the loop spends ONE
   * bounded nudge asking the model to actually do the work, then reports the
   * residual honestly (`ToolLoopResult.noActionTaken`).
   *
   * Why it exists: found live, a well-specified four-part coding ask (fix a bug,
   * add a function, write a test, run it) ended in prose five runs out of six —
   * "I'm sorry, but it seems you didn't…", "Based on the provided context, I'm
   * guessing…", or the thread echoed back — with ZERO tool calls and ZERO file
   * edits, while `generationFailed` stayed false so every surface read it as a
   * completed turn. The existing promise/permission/deliverable gates all key on
   * a POSITIVE shape in the reply (an announced action, a permission question, an
   * authored-artifact noun); none of them fire on a plain non-answer, which is why
   * the turn could end having done nothing.
   *
   * Deliberately narrow: it requires an asking request AND the absence of ANY
   * successful tool call this turn (a turn that read files and answered is out of
   * scope), it never fires on an authored-artifact ask (the deliverable gate owns
   * those), and it never overrides an explicit "do not write". Bounded once, so a
   * model that still does nothing ends the turn as before — but now flagged.
   */
  requireAction?: boolean;
  /**
   * COMPLETION CONTRACT (default ON). When a turn is about to END with checkable
   * work outstanding — a requirement row from `learning/requirement-ledger.ts`
   * that did not resolve, a check whose last run was red, or a module the turn
   * wrote that no test imports — the loop spends ONE bounded nudge naming them,
   * and offers the honest alternative (`finish` with `verified:false`).
   *
   * Why a nudge and not a refusal: the ending is still the model's to make. What
   * the loop refuses is the SILENT version — "the model stopped" is not a claim
   * that the request is satisfied, and after the measured 2026-10-25 run (a green
   * build, 22 tests, and four named tracking files never written) that silence is
   * the exact failure this option exists for.
   *
   * Empty ledger → no cost: an ask that names no artifact, check or obligation
   * takes exactly the steps it took before.
   */
  requireCompletion?: boolean;
  /**
   * DOCUMENTATION DUTY (default ON). When a turn wrote a runnable entry point
   * (`package.json`, `Makefile`, compose file) and left no README, or wrote a
   * markdown document whose claims name files/scripts that do not exist, the loop
   * spends ONE bounded nudge. Zero model calls to detect; at most one step.
   * Measured: three agents on one prompt all shipped docs and none shipped a
   * README, and nuvira's own ROADMAP cited tests it never wrote.
   */
  requireDocsAudit?: boolean;
  /**
   * PLAN GATE (E2, default ON). When a request DIRECTS work on the workspace and
   * the turn is about to run its FIRST mutating tool call having declared no
   * plan, the loop spends ONE bounded nudge asking the model to declare a short
   * plan with `plan_todo` first. The nudge is ADVISORY (like every other gate):
   * it never blocks the call, it only makes the plan → track → verify contract
   * structural rather than optional — and the residual (a turn that still
   * mutated without planning) is visible in the TurnReport as `planned:false`.
   * Set false to restore the pre-gate behaviour.
   */
  requirePlan?: boolean;
  /**
   * TOKENS this turn has spent so far, as the caller measures them.
   *
   * The loop does not meter usage (its provider seam does not report it), but the
   * requirement yield it computes is the denominator of the one cost metric that
   * makes a gate defensible: tokens per SATISFIED requirement. A surface that
   * tracks usage passes this and gets the ratio on `requirementYield`; one that
   * does not gets the counts only, and no invented number.
   */
  turnTokenCount?: () => number | undefined;
  /**
   * G18 — OBSERVABILITY SINK for the loop's non-LLM facts: every tool call that
   * ran (name, args, ok/error, duration), every gate DECISION (a nudge spent,
   * or a bound reached), and every REFUSAL (a call declined pending
   * confirmation, an unknown/disabled tool, a repeated dispatch).
   *
   * Why the loop must report its own refusals: they are the one class that
   * reads as nothing at all in a trace — the store showed 0 confirmation
   * refusals not because there were none but because it could not see them, and
   * the audit of the confirmation gates had to be done by reading code and
   * driving the real tools instead. A closed turn is a claim; this is the
   * evidence behind it.
   *
   * Best-effort by contract: the sink is called inside a try/catch, so a broken
   * recorder can never break the turn it observes.
   */
  onTraceEvent?: (event: LoopTraceEvent) => void;
  /**
   * Phase 4c — STEP-BOUNDARY SNAPSHOT sink, called once per completed step AFTER
   * that step's tool results are in the thread. The live thread and the honest
   * accumulators are handed over so a caller can persist a resumable session
   * snapshot (see `learning/session-store.ts`); a process that dies on the next
   * step still leaves a record through this one.
   *
   * Additive and optional: omitted, the loop is byte-identical to before. The
   * callback is invoked inside a try/catch, so a failing writer cannot break the
   * turn. The thread is the loop's OWN array — a caller must copy, not mutate.
   */
  onStep?: (step: {
    thread: readonly ToolMessage[];
    steps: number;
    successfulTools: readonly string[];
    mutatedPaths: readonly string[];
  }) => void;
  /**
   * Bounded auto-continuation budget (default: 2). A turn that dies MID-WAY —
   * the provider walk exhausted every candidate at step N, or the step bound
   * was reached while the model still had work to do — is RESUMED rather than
   * handed back to the user half-done. Each continuation grants
   * `continuationSteps` more steps and re-attempts the failed step. 0 disables
   * (byte-identical to the previous behavior). Never unbounded: the loop still
   * terminates after `maxSteps + maxContinuations * continuationSteps`. See
   * {@link ToolLoopResult.continuations}.
   */
  maxContinuations?: number;
  /** Extra steps granted per continuation (default: 8). */
  continuationSteps?: number;
  /**
   * AUTO-VERIFY (default: false; the CLI turns it on).
   *
   * When the turn is about to end having MUTATED the workspace with nothing that
   * observed the result, run the project's OWN check once (`autoVerifyCheck` —
   * tests/typecheck/build declared by the project) and hand the model the
   * verdict, instead of only asking it to verify.
   *
   * WHY (measured, 2026-10-25 head-to-head): the verification gate is a nudge, and
   * a nudge is advice. On the audit task the other agent RAN the suite and could
   * quote `125 failed / 476 passed`; this loop asked the model to run it, and the
   * model sometimes did not — so the deliverable had no measured verdict. Bounded
   * to two runs per turn (the first pass, plus one after the model reacts), and it
   * never runs for a prose-only deliverable (`isProseArtifactPath`), because a
   * written file is verified by its content, not by a test runner.
   *
   * Off by default so the loop's existing tests (and any caller that supplies its
   * own verification) keep their exact behaviour.
   */
  autoVerify?: boolean;
  /**
   * Progress-gated extensions granted AFTER the continuation budget is spent
   * (default: {@link MAX_PROGRESS_EXTENSIONS}).
   *
   * WHY THIS EXISTS. `maxContinuations` is a blind count: once it is spent the
   * turn ends even when the model is demonstrably still working. MEASURED
   * (trace-1792233823139-egmqc9, 2026-10-17, DeepSeek pinned, `max` capability):
   * a two-repo comparison ran 80 steps — 16 base + 4 × 16 continuations — wrote
   * the document, was mid-verification with 2 of 9 plan steps open, and stopped
   * with "I reached my step limit for this request." The model was healthy and
   * the budget was untouched; only the STEP COUNT ran out, and the first the
   * user heard of it was a truncated turn.
   *
   * THE GATE IS THE PLAN, NOT THE STEP COUNT. An extension is granted only when
   * (a) the turn's own plan still has a step that is not `done` and (b) a new
   * successful tool call landed since the previous grant. Both are checkable
   * facts: the plan is what the turn said the task IS, and new work is proof it
   * is still serving it. A turn with no plan, or one whose plan is complete, is
   * NOT extended — that is what keeps this from turning an endless read/search
   * loop into a 200-step bill.
   *
   * 0 disables the behaviour (the pre-fix ending), which is what pins the old
   * `budget-exhausted` test.
   */
  maxStepExtensions?: number;
  /**
   * REQUIREMENT-DRIVEN BUDGET (default: ON).
   *
   * WHY THIS REPLACES A STEP CAP. The extension count above is still a hardcoded
   * number, and a number cannot know whether the ask was answered. Measured three
   * times on one prompt (2026-10-26, SaaS platform): 178 steps → 84, 115 steps →
   * 70, 210 steps → 85, with the LOWEST run being the one that got the fewest
   * steps. A build's length is a property of the ASK — twelve features, a monorepo,
   * three test classes, four tracking files — so the thing that should end the turn
   * is the ask being satisfied (or the turn no longer advancing it), not a count
   * somebody picked for a different task.
   *
   * So, when this is on and the turn is not an assessment (an audit has its own
   * yield-based budget), the extension is UNBOUNDED while it is doing work that
   * moves a REQUIREMENT: an unmet ledger row still open, an open plan step, an
   * artifact the ask named that is not on disk. It stops in two cases, both facts
   * rather than counts:
   *
   *   - two consecutive grants moved NO requirement (the turn is spinning: the
   *     ledger's satisfied count, the files written and the green checks are all
   *     unchanged), which is the stall the count was approximating;
   *   - nothing is open any more, which is the honest end of a build.
   *
   * `maxTotalSteps` remains as an absolute escape hatch (a guard against a runaway
   * cost, not a budget): it is far above any measured build and, when it binds, the
   * message says so and names the flag. Setting this to false restores the old
   * fixed-extension behaviour.
   */
  requirementDrivenBudget?: boolean;
  /** Absolute escape hatch for the requirement-driven budget (default 1000). */
  maxTotalSteps?: number;
  /**
   * ADVISORY NUDGES — the loop's OPINIONS (default: on).
   *
   * The loop emits two kinds of message. OBSERVATIONS are facts about the environment:
   * a command failed, a check is red, a change request arrived, a tool returned an
   * error. OPINIONS are predictions about the shape of a good answer, made before the
   * repository was read: the plan is too coarse, the docs are missing, a module has no
   * test with a static import, the deliverable list is incomplete.
   *
   * An observation is always true. An opinion is sometimes false in a way the model
   * cannot argue with — measured 2026-10-27, an enterprise run ended at 9/100 while
   * holding a test that passed 7/7, because that test imported its settings modules
   * through `importlib` in a fresh interpreter and the static-import scanner could not
   * see it. A prediction was allowed to overrule a command that had already proved the
   * work, and the only ways out were to game the prediction or to stop.
   *
   * `false` silences the opinions and keeps the observations: the agent sets its own
   * plan, chooses its own work, and ends when it judges the task done. The completion
   * check still refuses a claim CONTRADICTED by a command, because that is evidence,
   * not a prediction. Advisory gaps are still reported to the user at the end.
   */
  advisoryNudges?: boolean;
  /**
   * WALL-CLOCK BUDGET FOR ONE TURN (default: none).
   *
   * WHY A STEP COUNT IS NOT ENOUGH. Every budget above is denominated in steps, and
   * a step is not a unit of time: measured 2026-10-27, the nuvira arm spent its last
   * ten minutes debugging a Playwright runner that would not start, and closed the
   * turn with no README — while the Cline arm finished in 48 minutes and shipped 42
   * paths of OpenAPI. Nothing in the loop knew how much time was left, so nothing
   * could prefer "close the deliverable" over "keep chasing this tool".
   *
   * So the caller may state the real budget. When the remaining time crosses the
   * closing window (20% of the budget, at least a minute), the turn is told — ONCE —
   * to stop opening work, to record a repeatedly-failing tool as a known limitation
   * instead of chasing it, and to write the handover documents and the answer. The
   * window also spends the last two steps and refuses further extensions, so the
   * answer happens instead of the next attempt.
   *
   * Unset by default: a caller that has no wall clock keeps the exact step-only
   * behaviour every existing test pins.
   */
  maxDurationMs?: number;
  /**
   * Clock for the wall-clock budget (default `Date.now`). Injectable so a test can
   * drive a ten-minute turn in a millisecond, and so a caller that measures elapsed
   * time itself (a resumed turn) can supply the same clock it used.
   */
  now?: () => number;
  /** Watch for a mid-turn `CHANGE_REQUEST.md` (default: ON; see change-request.ts). */
  watchChangeRequests?: boolean;
  /** Pause before re-attempting a failed step (default: 1500ms; tests set 0). */
  continuationDelayMs?: number;
  /** ToolContext for executions (configManager, followups sink, board, ...). */
  context: ToolContext;
  deps: ToolLoopDeps;
  /**
   * The route that is ACTUALLY serving this turn, read before every model call.
   *
   * The loop re-reads it each step so a mid-turn failover cannot leave the model
   * believing it is still the model it started on — the cheap alternative (state
   * the route once, in the system prompt) is a fact that decays. Returning `null`
   * injects nothing: a caller that does not know the route must not be "helped"
   * by a guess. See `src/tools/loop-route-feed.ts` for why the model is told at
   * all.
   */
  servedRoute?: () => ServedRoute | null;
  /**
   * P4 — stream content tokens as the model generates them (typewriter for
   * the dashboard's final answer). Passed to every callModel; providers that
   * stream deliver tokens live, others deliver the whole step at once.
   * The loop never buffers or reorders — the caller's onToken is verbatim.
   */
  onToken?: (token: string) => void;
  /**
   * P4 — external cancellation (the dashboard's Cancel button). The loop
   * checks the signal before every step and after every tool execution and
   * passes it into callModel so an in-flight provider request aborts (the
   * fetch itself stops — quota/tokens are not spent on a cancelled turn).
   * An aborted turn returns a `cancelled: true` result the caller discards.
   */
  signal?: AbortSignal;
}

export interface ToolLoopResult {
  /** The final assistant content (end-turn response). */
  content: string;
  /** Follow-ups collected from suggest_followups calls. */
  followups: FollowupSuggestion[];
  /** Tool names ATTEMPTED this turn (includes refused/unknown/failed calls). */
  toolCalls: string[];
  /**
   * Tool names that ACTUALLY ran successfully this turn — an `Error:` refusal,
   * an unknown tool, or a delivery tool that reported failure is NOT included.
   * This is the honest "what happened" list the trace outcome consumes (the
   * `acted` contract is "at least one tool executed successfully").
   */
  successfulToolCalls?: string[];
  /**
   * True when a delivery tool (`gateway_send`) ran AND reported success
   * (`✅ sent …`). A mere attempt is NOT a delivery — a failed send still lets
   * the model say "I have sent…", so the trace must not read
   * "action performed — message sent".
   */
  deliveryConfirmed?: boolean;
  /**
   * The workspace checkpoint taken before this turn's first file write, if one was.
   *
   * It is on the RESULT, not only in an event, because the thing a user needs after
   * a bad batch of edits is the id they can restore from — a message that scrolled
   * past is not a safety net (see `learning/workspace-checkpoint.ts`).
   */
  workspaceCheckpointId?: string;
  /**
   * Stage 2 — what this turn did to the USER, as counts: how many questions it
   * asked them (`shownAsks`), how many of those repeated an earlier one
   * (`repeatedAsks`), and what it changed. The behaviour metric: a good turn of
   * a multi-step task contains ZERO interruptions.
   */
  runTrace?: RunTraceSnapshot;
  /** Steps consumed. */
  steps: number;
  /** True when the step bound was hit before an end turn. */
  bounded: boolean;
  /**
   * P2 — how many times the turn handed the work to a DIFFERENT model after the
   * one serving it returned nothing usable (0 = it ran on one model throughout).
   * Reported rather than merely logged: "this turn moved models twice to get you
   * an answer" is the fact the trace and the dashboard show.
   */
  modelHandoffs?: number;
  /**
   * P3 — WHY the turn ended (see {@link TurnTermination}). Set on every exit so
   * a surface never has to infer the reason from a `bounded` boolean, which
   * cannot tell a model shortage from an exhausted budget.
   */
  termination?: TurnTermination;
  /**
   * How many bounded auto-continuations were spent this turn (0 = the turn ran
   * straight through). Telemetry only — a resumed turn reports the SAME content
   * contract as one that never stalled.
   */
  continuations?: number;
  /**
   * True when generation failed entirely (no model answered, no tool ran) —
   * the E3c no-model signal: the caller may fall back to the rule decision
   * (rules act only when the model is unavailable, never as a bypass).
   */
  generationFailed?: boolean;
  /**
   * WS5 (#27) — model calls this turn did NOT make because a recorded step with
   * the SAME input was replayed. Omitted on a run with no resume ledger.
   */
  replayedSteps?: number;
  /**
   * P4 — true when the turn was cancelled via ToolLoopOptions.signal (the
   * dashboard's Cancel button). The caller DISCARDS the turn: no cache write,
   * no history/memory recording, no followups — a cancelled turn must not
   * leave a half-answer in the session.
   */
  cancelled?: boolean;
  /**
   * HONESTY FLAG — the final answer CLAIMED a delivery/action ("I have sent…",
   * "message delivered…") but NO delivery tool actually ran this turn. A
   * model can write a tool call as prose, or skip it entirely and simply say
   * the action succeeded. When true, the answer is an unverified claim: the
   * caller must NOT present it as a completed action (the gateway appends a
   * correction; the trace records it). Set by the loop; never guessed by
   * callers.
   */
  unverifiedActionClaim?: boolean;
  /**
   * HONESTY FLAG — the answer closes by ANNOUNCING an imminent tool-shaped
   * action ("I will begin by scaffolding the project…", "Let me now create the
   * files") and the turn ends having performed NOTHING. The delivery-claim
   * guard deliberately ignores future tense (a truthful answer may say "I will
   * send it if you confirm"), so a dropped intent passed unreported and read
   * to the user as work in progress. The loop first spends ONE bounded nudge
   * asking the model to actually act; this flag is the residual signal for a
   * promise it still did not keep. The caller must never present such a turn
   * as "in progress".
   */
  unfulfilledPromise?: boolean;
  /**
   * COMPLETION CONTRACT — what the REQUEST named that this turn did NOT satisfy,
   * as sentences ("README.md — what this is and how to run it (no such file)").
   *
   * Set by the loop on every ending, whatever the reason, and only when the ask
   * named something checkable. A caller must not describe such a turn as finished:
   * this is the residual signal behind the measured 2026-10-25 run, which ended
   * "done" with four named tracking files never written.
   */
  unmetRequirements?: string[];
  /**
   * OBSERVATION CONTRACT — the gates that spoke this turn, and what the model said
   * after each one. A gate here is an OBSERVATION the model was free to judge (see
   * `harness-directive.ts`): the recorded answer is the model's own judgment, shown
   * so a reader can see a gate was considered and dismissed on the record rather
   * than silently obeyed or silently ignored. Absent when no gate spoke, so a clean
   * turn carries nothing.
   */
  observations?: HarnessObservation[];
  /**
   * REQUIREMENT YIELD — the cost metric's denominator. How many of the ask's
   * checkable rows resolved, how many did not, how many could not be checked, and
   * how much of what the turn wrote has a test that imports it.
   *
   * Present only when the ask named at least one row, so a conversation turn
   * carries no metric at all rather than a meaningless zero.
   */
  requirementYield?: {
    total: number;
    satisfied: number;
    unmet: number;
    unknown: number;
    /** bound / written modules, when the turn wrote enough to ask the question. */
    testBinding?: { modules: number; bound: number; ratio: number | null };
    /** Tokens spent per satisfied requirement — only when the caller reports usage. */
    tokensPerSatisfiedRequirement?: number;
  };
  /**
   * G1 — VERIFICATION GATE — a workspace mutation (`edit_file`/`write_file`)
   * SUCCEEDED this turn and NOTHING that could observe the result
   * (`run_terminal`/`test`/`browser`/`run_cli`) ran. The edit is real, but "it
   * works" is unproven: the caller must not present the turn as a verified
   * change (the dashboard shows a warning; the trace records it). Set by the
   * loop; never guessed by callers. Unlike `unverifiedActionClaim` (which is
   * about an outbound DELIVERY), this is about a CODE change.
   */
  unverifiedEdit?: boolean;
  /**
   * PER-FILE verification truth, from `assessEditActivity`. `verifiedPaths` are
   * the changed paths a check actually exercised this turn; `unverifiedPaths`
   * are the ones nothing did. The caller records both in the working-state
   * ledger, so the debt it owes is a set of paths — a whole-turn boolean cannot
   * say which change still needs a look, and (in a monorepo) cannot tell a root
   * check from the nested package's own suite that never ran.
   */
  verifiedPaths?: string[];
  /** @see ToolLoopResult.verifiedPaths */
  unverifiedPaths?: string[];
  /**
   * HONESTY FLAG (G13b) — the request asked for an AUTHORED deliverable to be
   * PRODUCED and this turn wrote NOTHING to disk, so the answer is prose about
   * the work rather than the work.
   *
   * Distinct from `unfulfilledPromise` (the model announced an action and did
   * nothing) and from `unverifiedEdit` (it wrote and nothing checked): here the
   * model DID the composition and simply never produced the artifact. Annotated
   * on every exit path and independent of the nudge being enabled, because a
   * caller must never read "the story is done" from a turn that wrote no file.
   */
  undeliveredArtifact?: boolean;
  /**
   * ZERO-ACTION HONESTY FLAG — the request DIRECTED work on the workspace (it
   * authorized writes) and this turn performed NONE: no tool call succeeded and
   * no file was changed. Distinct from `undeliveredArtifact` (which is about an
   * authored file-shaped deliverable) and from `unfulfilledPromise` (an
   * announced action the answer then dropped): this is the residual signal for a
   * work request answered with nothing at all. Set by the loop, never guessed
   * by callers, and independent of the nudge being enabled — so a caller can
   * never read "completed" from a turn whose request it did not touch.
   */
  noActionTaken?: boolean;
  /**
   * UNCHANGED-WORKSPACE HONESTY FLAG — the request asked for a CHANGE to the
   * workspace, the turn mutated NOTHING, and the answer is a PLAN or a PROMISE
   * rather than the work.
   *
   * WHY IT EXISTS (measured 2026-10-09, `trace-1791521608671-1bjnfa`). A user
   * reported three concrete bugs in their own project. The turn read one file
   * and replied with its own working notes — "I need to investigate… Plan: 1…
   * Let's start by reading `public/app.js`." — and was recorded `success: true`.
   * `noActionTaken` could not see it (a read had succeeded), and
   * `unfulfilledPromise` could not either (its list exemption — correct in
   * general — exempts exactly the plan-and-stop shape). This flag is the
   * edit-shaped sibling of `undeliveredArtifact`: that one covers an authored
   * DOCUMENT that was never written, this one a workspace CHANGE that was never
   * made. Deliberately narrow — it requires all three of "a change was asked
   * for", "nothing was mutated", and "the answer is a plan/promise" — so a
   * legitimate explanatory answer that merely enumerates steps is untouched.
   */
  undeliveredChange?: boolean;
  /**
   * UNBACKED-HEALTH-CLAIM HONESTY FLAG — the answer vouches for the project
   * ("stable, working state", "fully implemented", "ready for use") while the
   * turn mutated nothing and ran NOTHING that exercised the product.
   *
   * WHY IT EXISTS (measured 2026-10-09, `trace-1791521454725-e7s5ew`). Asked
   * "what's the state of this project?", the turn ran `npm test`, read 20 lines
   * of README, and answered *"the project is in a stable, working state… All 18
   * automated tests passed… ready for use"*. The app was a dead demo — its
   * `server.js` served no static route, so `GET /app.js` 404'd and EVERY button
   * on the page was inert. A unit suite for one module is not evidence about the
   * product, and nothing in the honesty family covered a claim about a SYSTEM'S
   * health (every other flag is action-shaped). Set by the loop, never guessed.
   */
  unbackedHealthClaim?: boolean;
  /**
   * G2 — HONESTY FLAG — the answer ASSERTS a completed code change ("I have
   * successfully fixed…", "now fully operational") while the turn mutated the
   * workspace and verified nothing. The delivery-claim guard deliberately
   * ignores code edits, so a false "I fixed it" after a botched `edit_file`
   * passed unreported eight turns in a row in the calculator session. When
   * true, the claim is unverified — the caller appends a correction and the
   * trace flags it.
   */
  unverifiedEditClaim?: boolean;
  /**
   * A3 PART 2 — HONESTY FLAG — a BUILD command ran this turn and FAILED, no
   * later build succeeded, and the answer nonetheless asserts the artifact came
   * out good ("successfully rebuilt", "launches without crashing"). Found live:
   * `pyinstaller AukatCheck.spec` exited 1, the model opened the STALE app and
   * reported success. Distinct from `unverifiedEditClaim` (a code edit nothing
   * observed): here the run observed the build, observed it FAIL, and the prose
   * contradicts the run's own evidence. The caller must not present such a turn
   * as done; the trace records it and the outcome is `incomplete`.
   */
  unverifiedBuildClaim?: boolean;
  /**
   * Bundle 19 — a file this turn WROTE declares that its own content was omitted.
   * The turn's artifact says it is incomplete, so no surface may read the turn as
   * finished work. Carries the path and the artifact's own words as evidence.
   */
  artifactIncomplete?: { path: string; statement: string };
  /**
   * Bundle 20 — the answer ASSERTS a file was written, and the turn's own record
   * says none was. Kept separate from `undeliveredArtifact` (a function of the
   * ASK): this is a function of the turn's OWN claim, so a fabricated "I saved it"
   * is disclosed even when the ask was never recognised as a deliverable.
   */
  unverifiedFileClaim?: boolean;
  /**
   * Bundle 23 (item 13) — the ask NAMED a magnitude ("about 5000 words", "a 100
   * page story") and this turn's written artifact is far short of it. A factual
   * comparison of the delivered file against the REQUEST — not a judgement of its
   * quality — which is why it is a shortfall of a stated number and never a phrase
   * list. Carries the measurement as evidence. Only set for a SINGLE written
   * artifact: an append/sectioned delivery cannot be measured from these records
   * without risking a false "short".
   */
  artifactShortfall?: { path: string; deliveredWords: number; targetWords: number; source: string };
  /**
   * Item 13 (round 3) — a SINGLE authored artifact that tripped neither the
   * omission nor the shortfall check: the "fluent, on-length" delivery that no
   * deterministic rule can judge. Reported as FACTS only (path, length, a bounded
   * excerpt) so a caller can COLLECT the case; no verdict is made here, and
   * nothing routes on it.
   */
  authoredDeliverable?: { path: string; deliveredWords: number; targetWords?: number; excerpt: string };
  /**
   * R2 — which transport carried this turn's tool calls (`native` / `json` /
   * `none`), as reported by the caller's own model-call seam. Absent when the
   * caller reports none (an in-process mock, or a surface that has not been
   * taught yet), which is why absence is not compared as equal to `none`.
   *
   * Recorded on EVERY exit path via the shared progress object, so a bounded
   * turn, a cancelled one and a clean end all say the same thing about how the
   * work travelled — the fact a run-attribution claim is made of.
   */
  transport?: 'native' | 'json' | 'none';
}

/** An orphan reasoning block or bare <think> is a think-only response. */
export function isThinkOnlyResponse(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  // Only a <think>…</think> block (no visible answer text).
  if (/^<think>[\s\S]*<\/think>\s*$/.test(trimmed)) return true;
  // Only reasoning keywords with no substantive answer (orphan reasoning).
  if (/^(hmm|thinking|let me think|ok,? let'?s|considering)[.:\s]*$/i.test(trimmed.slice(0, 60))) return true;
  return false;
}

/**
 * Extract JSON fallback tool calls from model text:
 * `{"tool":"name","arguments":{...}}` blocks, possibly fenced or multiple —
 * plus the name-keyed `{"suggest_followups":[…]}` shape models actually write.
 * Uses brace-matching (string-aware) so nested argument objects parse
 * correctly. Returns the cleaned content (blocks stripped) + parsed calls.
 */
export function extractFallbackToolCalls(content: string): { text: string; calls: StepResponse['toolCalls'] } {
  const calls: StepResponse['toolCalls'] = [];
  let cleaned = content;
  let strippedAny = false;
  // A real tool block always names the tool as a JSON STRING
  // (`{"tool":"name"`). Requiring the opening quote keeps unrelated prose
  // (`{"tool": broken`) untouched while still catching a truncated real call.
  const startsAt = /\(?\s*\{\s*"tool"\s*:\s*"/g;
  let m: RegExpExecArray | null;
  while ((m = startsAt.exec(cleaned)) !== null) {
    const end = findMatchingBrace(cleaned, m.index);
    if (end === -1) {
      // A QUOTED tool block with no closing brace: the model was cut off
      // mid-call. Everything from the marker on is leaked scaffolding, not
      // answer text — strip it and stop (nothing valid can follow).
      //
      // Item 6 — surface it as an UNPARSEABLE call when we saw the tool's name,
      // so the loop refuses it with the truncation cause and the sectioned path.
      // Dropping it silently (the old behaviour) is how a cut-off delivery failed
      // with nothing to tell the model why.
      const name = /^\s*\(?\s*\{\s*"tool"\s*:\s*"([^"]+)"/.exec(cleaned.slice(m.index))?.[1];
      if (name) {
        calls.push({ id: `call_${calls.length + 1}`, name, arguments: {}, argumentsError: 'unparseable' });
      }
      cleaned = cleaned.slice(0, m.index);
      strippedAny = true;
      break;
    }
    const block = cleaned.slice(m.index, end + 1);
    // A matched block is ALWAYS removed from the answer text — a raw
    // `{"tool":...}` block must never leak into the user-facing content,
    // even when it fails to parse (a malformed followups block was the cause
    // of the essay prompt's answer ending in raw JSON).
    cleaned = cleaned.slice(0, m.index) + cleaned.slice(end + 1);
    startsAt.lastIndex = m.index;
    strippedAny = true;
    try {
      const parsed = JSON.parse(block) as { tool?: string; arguments?: unknown };
      if (parsed.tool && typeof parsed.tool === 'string') {
        // Item 6 — the fallback transport is TEXT, so "did the arguments arrive?"
        // is decided HERE. A block that parses but carries no `arguments` object
        // is the empty-payload signature; flagging it lets the loop refuse it with
        // the REAL cause instead of executing `{}` and answering "path is required".
        const rawArgs = parsed.arguments;
        const isPlainObject =
          rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs);
        calls.push({
          id: `call_${calls.length + 1}`,
          name: parsed.tool,
          arguments: isPlainObject ? (rawArgs as Record<string, unknown>) : {},
          ...(isPlainObject ? {} : { argumentsError: rawArgs === undefined ? ('empty' as const) : ('unparseable' as const) }),
        });
      }
    } catch {
      // A brace-MATCHED but unparseable block (the model's own JSON typo, e.g. a
      // trailing comma) is dropped from the answer, no call — a truncation has no
      // closing brace and is handled above. Item 6 covers the truncated case there;
      // this stays silent by design so a typo cannot become a phantom refusal.
    }
  }
  // ── Pass 2: our tool's ARGUMENTS keyed by our own tool NAME ─────────────
  //   {"suggest_followups":[{"label":"…","prompt":"…"}, …]}
  // This is the shape models ACTUALLY hand-write: across 116 stored assistant
  // turns the canonical `{"tool":"…"}` form appeared ZERO times and this one
  // 14. Pass 1 could not see it at all, so the block was delivered verbatim to
  // the reader AND the suggestions were thrown away (no chips, no menu).
  //
  // The block is consumed in exactly two cases: it parses to OUR payload (the
  // shared predicate — the same one the strip uses, so the two can never
  // disagree), or it does not parse at all (truncated scaffolding is never
  // prose). A value that parses cleanly to something demonstrably NOT the
  // contract — `{"suggest_followups": "a note"}` — is left untouched, so a
  // user's own JSON still survives.
  const namedAt = /\(?\s*\{\s*"suggest_followups"\s*:/g;
  let named: RegExpExecArray | null;
  while ((named = namedAt.exec(cleaned)) !== null) {
    const end = findMatchingBrace(cleaned, named.index);
    if (end === -1) {
      // Cut off mid-call: everything from the marker on is scaffolding.
      cleaned = cleaned.slice(0, named.index);
      strippedAny = true;
      break;
    }
    const block = cleaned.slice(named.index, end + 1);
    let parsed: unknown = null;
    let unparseable = false;
    try {
      parsed = JSON.parse(block) as unknown;
    } catch {
      unparseable = true;
    }
    if (!unparseable && !isTextualFollowupsPayload(parsed)) continue;
    cleaned = cleaned.slice(0, named.index) + cleaned.slice(end + 1);
    namedAt.lastIndex = named.index;
    strippedAny = true;
    const entries = followupEntriesFromPayload(parsed);
    if (entries) {
      calls.push({
        id: `call_${calls.length + 1}`,
        name: 'suggest_followups',
        arguments: { followups: entries },
      });
    }
  }
  if (!strippedAny) return { text: content, calls };
  // Remove empty fenced blocks left behind when a fenced JSON block's BODY was
  // the tool call (e.g. "```json\n\n```"), plus any caption/separator the model
  // put in FRONT of the block. Without the second step the delivered answer
  // ends on a dangling `---` — the visible half of the leak this recovers from.
  const text = stripTrailingFollowupsHeader(
    cleaned.replace(/\n?```[a-z]*\s*\n?\s*```\s*/gi, '\n'),
  ).trim();
  return { text, calls };
}

/**
 * Whether content is a BARE acknowledgment — a short lead-in that agrees to
 * help but does NOT yet contain the answer ("Sure, I can help with that!",
 * "Let me write that for you."). The tool contract tells the model to deliver
 * the answer FIRST and call suggest_followups only AFTER it — but a model
 * that misorders them (followups in step 1 + a bare lead-in) must NOT end the
 * turn with only the acknowledgment, otherwise the real answer never arrives
 * (the user sees "Sure!" and no essay). When the loop sees a concluding
 * suggest_followups step whose only content is such a lead-in, it continues
 * so the model can deliver the actual answer.
 */
export function isBareAcknowledgment(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (trimmed.length >= 80) return false; // a real answer is longer than a lead-in
  if (/^[^.!?]*!$/.test(trimmed)) return true; // short exclamatory lead-in ("Sure!")
  return /^(sure|ok(?:ay)?|alright|absolutely|certainly|of course|no problem|sounds good|happy to|glad to|let me|i['’]d|i['’]ll|i will|i can|i would|i'm on it|on it)/i.test(trimmed) ||
    /(help with that|help you with|write (that|this|it) for|take a look|dive in|give it a shot)/i.test(trimmed);
}

/** Index of the brace matching the one at `start` (string-aware), or -1. */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ─── Parallel read-only execution (W2) ──────────────────────────────────────
/**
 * Tools that READ the world but must still run SERIALLY, because they change
 * HARNESS state or block on input rather than changing the world.
 *
 * `effectClass: 'read'` is NECESSARY but NOT SUFFICIENT for safe fan-out — this is
 * the second half of the fact, and it is a property of the HARNESS, not of the
 * effect. `tool_search` mutates the tiering state that decides which tools exist
 * in the NEXT step; `ask_user` blocks on the human. Fanning either out would let
 * two siblings disagree about the world they are reading.
 *
 * Pinned by `parallel-tool-exec.test.ts`, which asserts each of these is serial
 * WHILE its declared effect is genuinely `read`.
 */
const READ_BUT_SERIAL: ReadonlySet<string> = new Set([
  'tool_search', // mutates the tiering state
  'ask_user', // blocks on user input
]);

/**
 * Whether a tool may run concurrently with sibling calls in the same step.
 *
 * DERIVED FROM THE CAPABILITY REGISTRY, not a hand-maintained allowlist. This used
 * to be a six-name list that had to be reviewed by hand whenever a read tool was
 * added — so any new read tool, and every read-only MCP tool discovered at
 * runtime, silently lost the fan-out. The effect class answers it now.
 *
 * THE SAFETY DIRECTION IS UNCHANGED, which is the part that matters: a tool the
 * registry does not describe maps to `local-state`, so a newly registered tool is
 * still SERIAL until someone declares it a read. `READ_BUT_SERIAL` is the one
 * hand-written exception, and it is a harness fact rather than an effect guess.
 */
export function isParallelSafeTool(name: string): boolean {
  if (READ_BUT_SERIAL.has(name)) return false;
  return effectClassOfTool(name) === 'read';
}

let _parallelSafeNames: ReadonlySet<string> | null = null;

/**
 * Every REGISTRY tool that currently qualifies, derived by filtering with
 * `isParallelSafeTool` — so the set and the predicate can never disagree. Built
 * lazily, because the registry must be fully loaded before it can be enumerated.
 */
export function parallelSafeToolNames(): ReadonlySet<string> {
  if (!_parallelSafeNames) {
    _parallelSafeNames = new Set(listTools().map((t) => t.name).filter(isParallelSafeTool));
  }
  return _parallelSafeNames;
}

/** Max concurrent read-only calls per step (bounded fan-out) when the model
 *  has no harness opinion — see `ModelHarnessProfile.maxParallelReads`, which
 *  lowers this to 1 for tiny models that cannot use interleaved results. */
const MAX_PARALLEL_READS = 4;

// ─── WASTE GUARD — do not pay twice for the same read ───────────────────────
//
// MEASURED (2026-10-17, the Cline head-to-head on the slugkit task): 49 tool
// calls over 51 model calls on a task whose intrinsic shape is ~7 calls, 1.43 M
// input tokens for 6,303 output tokens. The biggest single avoidable block in
// the transcript was re-reading, not thinking: `npm test` run FOUR times with a
// different output filter each time (`| tail -40`, `| grep -E "^# …"`, `| tail
// -30`, `| head -20`), plus repeated listings of the same directory. Nothing had
// changed between those calls, so the 2nd…4th could only return what the 1st
// already returned — each one re-sent the whole thread to buy nothing.
//
// The contract now ASKS the model not to do this (registry.ts, TOOL_CONTRACT),
// and this guard makes the ask enforceable: an identical read on an UNCHANGED
// workspace is refused with the reason, instead of being executed again. The
// instant the turn mutates anything the memo is invalid, so a repaired project
// re-running its own check — the one repetition that is real work — is never
// blocked (same rule as run_terminal's failure-streak guard).

/** Tools whose result is a pure function of the workspace, so a repeat is waste. */
const MEMOIZABLE_READ_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'code_search']);

/**
 * Shell commands that only INSPECT (or run a project's own check). Repeated on
 * an unchanged workspace they can only return what they already returned, so
 * they are memoizable; anything not matching is treated as side-effecting and
 * always runs. Deliberately a positive allowlist: an unknown command is never
 * suppressed.
 */
// NOTE the allowlist is deliberately narrow on package scripts: `npm test` and
// `npm run test` are the project's CHECK (re-running one on an unchanged
// workspace is the observed waste), while `npm run build` / `npm run deploy` /
// `npx some-cli` can WRITE and are never suppressed.
const INSPECT_COMMAND =
  /^(?:cd\s+[^&;]+\s*&&\s*)?(?:ls|cat|head|tail|grep|rg|find|pwd|wc|stat|file|which|printenv|env|node\s+-\S+|npm\s+test\b|npm\s+run\s+test\b|npx\s+(?:vitest|jest|tsc|eslint)\b|yarn\s+test\b|pnpm\s+test\b|bun\s+test\b|git\s+(?:status|diff|log|show|rev-parse|tag|branch|remote|describe|ls-files|ls-tree))\b/;

/**
 * Drop trailing OUTPUT-FILTER pipelines from a command: `npm test | tail -40`
 * and `npm test | grep -E "^# pass"` are the same execution with a different
 * view, which is exactly the repetition observed live. Only filters that cannot
 * change the command's EFFECT are removed; a pipe the loop cannot classify
 * leaves the command as-is (a conservative miss beats a wrong suppression).
 */
export function stripOutputFilters(command: string): string {
  const FILTER = /^(?:tail|head|grep|rg|sort|uniq|wc|cut|tr|awk|sed|fold|column|jq|less|more)\b/;
  const segments = command.split('|');
  // Walk from the end, dropping filter stages; stop at the first non-filter.
  while (segments.length > 1) {
    const last = segments[segments.length - 1].trim().replace(/^(?:2>&1\s*)?/, '');
    if (!FILTER.test(last)) break;
    segments.pop();
  }
  // A leading `2>&1` on the surviving command is noise for identity purposes.
  return segments.join('|').replace(/\s*2>&1\s*$/, '').trim();
}

/**
 * The memo key for a call whose repetition would be pure waste, or `null` when
 * the call must always run (a mutation, an unknown tool, a page fetch, …).
 * Exported for the regression tests to pin both directions.
 */
export function memoizableReadSignature(name: string, args: unknown): string | null {
  if (name === 'run_terminal' || name === 'terminal' || name === 'code_execution') {
    // `code_execution` runs the SAME shell a model would otherwise reach for
    // through run_terminal, so a repeated `npm test` through it is the same
    // repetition — measured in the 2026-10-17 run of this very task: `npm test |
    // tail` via run_terminal, then `npm test` again via code_execution. Only a
    // snippet that IS an inspect command is memoizable; anything else (a script,
    // a build, a mutation) is left to run.
    const raw = name === 'code_execution'
      ? (args as { code?: unknown } | undefined)?.code
      : (args as { command?: unknown } | undefined)?.command;
    if (typeof raw !== 'string') return null;
    const base = stripOutputFilters(raw.replace(/\s+/g, ' '));
    if (!base || !INSPECT_COMMAND.test(base)) return null;
    return `inspect:${base}`;
  }
  if (!MEMOIZABLE_READ_TOOLS.has(name)) return null;
  // Stable key: argument ORDER must not matter (`{paths, offset}` vs
  // `{offset, paths}` are the same read), and `undefined` values are dropped so
  // an omitted optional field cannot split one read into two keys.
  let key: string;
  try {
    const entries = Object.entries((args ?? {}) as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    key = JSON.stringify(entries);
  } catch {
    return null; // unrepresentable args → never suppress
  }
  return `${name}:${key}`;
}

/**
 * The refusal text for a repeated read. It does NOT repeat the result: the
 * earlier tool result is already in the thread, and re-sending it is the exact
 * cost this guard exists to remove.
 */
export function repeatReadRefusal(name: string): string {
  return (
    `Error: ${name} was already called this turn on the SAME, unchanged workspace — its result is the earlier tool ` +
    'result above and nothing has changed since. Do NOT re-run it: use that result, call something different, or change ' +
    'the workspace first. (Re-running only to see a differently filtered view of the same output is not allowed.)'
  );
}

/**
 * The batching nudge — one bounded directive when a turn is spending a whole
 * model round-trip per read. It states the COST (every step re-sends the thread)
 * and the exact alternative, and it explicitly does not relax verification: the
 * turn still runs its real check, once.
 */
export function batchingNudge(steps: number, tool: string): string {
  return (
    `⚡ BATCHING — you have spent ${steps} model round-trips issuing ONE call per step (last: ${tool}), and each step ` +
    're-sends this whole conversation. If your next calls do not depend on each other, put them ALL in this one step: ' +
    'several read_file calls together, or ONE run_terminal chaining what you need ' +
    '(`ls -la; cat README.md; cat package.json; git status`). Read the full output once instead of re-running a ' +
    'command with a different filter (`| head`, `| tail`, `| grep`) — a repeat on an unchanged workspace is refused. ' +
    'This does not change WHAT you verify: still run the real check, once, when the work is changed.'
  );
}

/** A call that GATHERS information (so a step made of exactly one of these is a batching candidate). */
export function isGatherCall(name: string): boolean {
  return name === 'run_terminal' || name === 'terminal' || isParallelSafeTool(name);
}

// ─── PLAN AUTO-ADVANCE — the checklist advances from the loop's OWN ledger ───
//
// MEASURED (2026-10-17, the slugkit release task on the patched build): 9 of the
// turn's 34 tool calls were `plan_todo` — the model spending a whole model
// round-trip, with the entire conversation re-sent, to say "step 2 is done" about
// work the LOOP had already watched happen (`edit_file` on the exact path the
// step names). The same shape produced 7 plan calls on the Cline head-to-head and
// 10 on T2. Bookkeeping about executed work does not need a model.
//
// So the loop advances the steps its own ledger can justify, and ONLY those:
//
//   - a step that NAMES a file the turn successfully wrote/edited → done, with
//     that call recorded as the step's evidence (the store then renders ✅ rather
//     than the ⚠️ it uses for a `done` with nothing behind it — see
//     `plan-store.ts` R1);
//   - a step that NAMES a check (test/verify/lint/build/…) → done, but only when
//     a check of the KIND it names ACTUALLY SUCCEEDED this turn (see the
//     classification below — a successful `ls` is not a successful test run);
//   - never a step about reporting/delivering prose (there is no execution to
//     stand behind "write the final report");
//   - never a step nothing was observed for. An unattributable step stays open for
//     the model to settle — the auto-advance may not invent progress.
//
// This can only REMOVE a round-trip, never a check: the verification gate, the
// claim audit and the honesty flags are untouched, and a step marked done here
// carries MORE provenance than one the model asserted.

/** One step the loop's ledger closed, with the evidence that closes it. */
export interface PlanStepAdvance {
  id: string;
  description: string;
  /** One line saying WHAT was observed — the step note and the trace summary. */
  reason: string;
  evidence: PlanEvidence;
}

/**
 * A step about REPORTING rather than doing: prose has no execution behind it, so
 * the loop never advances it on the model's behalf.
 */
const REPORTING_STEP = /\b(report|summary|summarise|summarize|write[- ]up|explain|announce|deliver|tell the user|final answer)\b/i;

/** A step that names a CHECK rather than a change. */
const CHECK_STEP = /\b(run|re-?run|verify|verification|validate|test|tests|testing|check|checks|lint|typecheck|type-check|build|smoke)\b/i;

// ─── WHAT A CHECK ACTUALLY WAS — read the COMMAND, not the tool name ───────
//
// MEASURED (2026-10-25, the three-agent platform build). The check rule below
// used to accept ANY successful call to a verification TOOL, and `run_terminal`
// is one of them. In that run the model's plan had
//
//   s6  "Write and RUN unit + integration tests; add E2E (Playwright) spec"
//   s7  "Run typecheck/lint/build + test suite, fix failures, update
//        todo/progress/issues/changelog"
//
// and BOTH were marked ✅ within seconds of an `ls -la`:
//
//   🗺️ plan step "s6" → done (run_terminal ran `ls -la` and succeeded)
//   🗺️ plan step "s7" → done (run_terminal ran `ls -la` and succeeded)
//
// Two of seven steps were therefore closed before any test, typecheck, build or
// tracking file existed, the plan rendered 29 % complete on a turn that had not
// started, and the loop's own close-out gate then had nothing to push. That is
// the mechanical half of the 2026-10-25 testing / task-management gap — not a
// model that decided to skip the work.
//
// So a check is classified by what its COMMAND exercises. An inspection command
// (`ls`, `cat`, `git status`, …) is not a check of anything: it observes the
// workspace, never the artifact's behaviour. And a step that names SEVERAL kinds
// ("typecheck/lint/build + test suite") is closed only when every kind it names
// was actually run — "ran tsc" is not "ran the checks I listed".

export type CheckKind = 'tests' | 'typecheck' | 'lint' | 'build' | 'other';

/** The check kinds a command can exercise, in the order they are recognised. */
const CHECK_KINDS: Array<[CheckKind, RegExp]> = [
  ['tests', /\b(?:tests?|testing|vitest|jest|mocha|ava|tap|pytest|unittest|playwright|cypress|rspec|phpunit|node\s+--test|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test)\b/],
  ['typecheck', /\b(?:tsc|typecheck|type-check|mypy|pyright|flow)\b/],
  ['lint', /\b(?:lint|linting|eslint|ruff|flake8|pylint|stylelint|prettier)\b/],
  ['build', /\b(?:build|compile)\b/],
];

/** A command that only LOOKS at the workspace — never a check of the artifact. */
const INSPECTION_ONLY =
  /^(?:ls|cat|head|tail|wc|grep|rg|find|pwd|echo|stat|file|which|printenv|env|diff|tree|du|df|git\s+(?:status|diff|log|show|rev-parse|branch|remote|ls-files|describe|tag))\b/;

/**
 * What a successful verification call actually exercised, derived from its
 * COMMAND (never from the tool's name — `run_terminal` runs both `npm test` and
 * `ls`). `inspectionOnly` is the flag the plan rule refuses.
 */
export function classifyCheck(
  tool: string,
  command?: string,
): { kinds: CheckKind[]; inspectionOnly: boolean } {
  if (tool === 'test') return { kinds: ['tests'], inspectionOnly: false };
  if (tool !== 'run_terminal' && tool !== 'run_cli' && tool !== 'code_execution' && tool !== 'terminal') {
    // browser, checkpoint diff, any other observer of the artifact
    return { kinds: ['other'], inspectionOnly: false };
  }
  const text = String(command ?? '')
    .replace(/^\s*cd\s+[^&;]+&&\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!text) return { kinds: ['other'], inspectionOnly: false };
  const kinds: CheckKind[] = [];
  for (const [kind, re] of CHECK_KINDS) if (re.test(text)) kinds.push(kind);
  if (kinds.length > 0) return { kinds, inspectionOnly: false };
  return INSPECTION_ONLY.test(text)
    ? { kinds: [], inspectionOnly: true }
    : { kinds: ['other'], inspectionOnly: false };
}

/** The check kinds a step DESCRIPTION names (empty = "some check, any kind"). */
export function stepCheckKinds(description: string): CheckKind[] {
  const kinds: CheckKind[] = [];
  for (const [kind, re] of CHECK_KINDS) if (re.test(description)) kinds.push(kind);
  return kinds;
}

/**
 * The check that CLOSES a step, or null. Every kind the step names must have
 * been exercised by a non-inspection check; an unnamed kind accepts any real
 * check. Returns the LAST check that contributed, so the step's evidence is a
 * command the turn actually ran late.
 */
export function checkClosingStep(
  checks: ReadonlyArray<{ tool: string; command?: string }>,
  named: readonly CheckKind[],
): { tool: string; command?: string } | null {
  const usable = checks.filter((c) => !classifyCheck(c.tool, c.command).inspectionOnly);
  if (usable.length === 0) return null;
  if (named.length === 0) return usable[usable.length - 1];
  const covered = new Set<CheckKind>();
  let last: { tool: string; command?: string } | null = null;
  for (const check of usable) {
    const kinds = classifyCheck(check.tool, check.command).kinds;
    let hit = false;
    for (const kind of kinds) {
      if (named.includes(kind) && !covered.has(kind)) {
        covered.add(kind);
        hit = true;
      }
    }
    if (hit) last = check;
  }
  return covered.size === named.length ? last : null;
}

/** The file-ish token a step description names, when it names one. */
function namedFileIn(description: string): string | null {
  // `src/slugify.js`, `AUDIT.md`, `settings.py:150` — a path, or a bare filename
  // with an extension. A word like "tests" is deliberately NOT a file token.
  const m = description.match(/(?:[\w./-]*\/)?[\w.-]+\.[A-Za-z]{1,5}\b/);
  return m ? m[0] : null;
}

/**
 * Which of a plan's OPEN steps the turn's own ledger already closed. Pure, so the
 * rule set is testable without a model, a store or a terminal.
 */
export function planStepsClosedByEvidence(input: {
  snapshot: PlanSnapshot | null | undefined;
  /** Successful file writes/edits this step, in call order. */
  written: ReadonlyArray<{ tool: string; path: string }>;
  /** Successful verification calls this step (`isVerificationTool`). */
  checks: ReadonlyArray<{ tool: string; command?: string }>;
  /** Epoch ms for the evidence stamp (injected so tests are deterministic). */
  at: number;
}): PlanStepAdvance[] {
  const steps = input.snapshot?.steps ?? [];
  if (steps.length === 0) return [];
  const advances: PlanStepAdvance[] = [];
  for (const step of steps) {
    if (step.status === 'done' || step.status === 'blocked') continue;
    const description = String(step.description ?? '');
    if (!description.trim() || REPORTING_STEP.test(description)) continue;
    const named = namedFileIn(description);
    // 1. PATH RULE — the strongest: a call actually wrote the file the step names.
    if (named) {
      const base = named.split('/').pop() ?? named;
      const hit = [...input.written].reverse().find((w) => {
        const wBase = w.path.split('/').pop() ?? w.path;
        return wBase === base || w.path === named || w.path.endsWith(`/${named}`);
      });
      if (hit) {
        advances.push({
          id: step.id,
          description,
          reason: `${hit.path} was written by ${hit.tool}`,
          evidence: { tool: hit.tool, path: hit.path, ok: true, at: input.at },
        });
        continue;
      }
    }
    // 2. CHECK RULE — a step that names a check, closed only by a check of the
    // kind it names that RAN (never by an inspection command, and never by one
    // kind standing in for the four the step listed).
    if (CHECK_STEP.test(description) && input.checks.length > 0) {
      const check = checkClosingStep(input.checks, stepCheckKinds(description));
      if (!check) continue;
      advances.push({
        id: step.id,
        description,
        reason: check.command
          ? `${check.tool} ran \`${check.command}\` and succeeded`
          : `${check.tool} succeeded`,
        evidence: {
          tool: check.tool,
          ...(check.command ? { command: check.command } : {}),
          ok: true,
          at: input.at,
        },
      });
    }
  }
  return advances;
}

// ─── Bounded auto-continuation (mid-turn model death / step bound) ──────────
// The loop used to give up the MOMENT a step's generation failed (all provider
// candidates exhausted) or the step bound was reached: the user got a partial
// answer (or an error line) and had to re-ask, even though the work was
// half-done and resumable in-context. These defaults resume the SAME turn a
// bounded number of times — the model keeps its thread, completed tool calls
// are never re-run, and the loop can never spin forever.

/**
 * Consecutive REASONING-ONLY steps the loop tolerates before it escalates, and
 * then one more before it ends the turn.
 *
 * Small on purpose. A `<think>`-then-answer model needs a step or two, so the
 * limit cannot be zero — but unbounded, this path is a spin: two live eval runs
 * produced 31 reasoning-only steps, one tool call, and a 0% score on a task they
 * were well able to do (see `THINK_ONLY_ESCALATION`).
 */
export const MAX_THINK_CONTINUES = 3;
/**
 * P2 — how many times the SAME model may answer with nothing before the loop
 * insists on a handoff. One, deliberately: a single empty completion can be a
 * blip at a shared endpoint, but a model that resolves with nothing twice has
 * demonstrated it is not answering this step, and re-calling it is the loop that
 * killed a real turn (five consecutive empties, then the turn reported itself
 * bounded with zero tool calls).
 *
 * THIS IS THE HANDOFF TRIGGER, NOT THE WHOLE PATIENCE POLICY. Since P5 the caller
 * may grant extra same-pair attempts (`emptyResponsePatienceMs`), spent as
 * bounded waits BEFORE this threshold is honored — which is what tells a two
 * second blink apart from a dead pair. The threshold itself is unchanged, so a
 * caller that grants nothing, and every mock/sub-agent child, behaves exactly as
 * before.
 */
export const MAX_SAME_MODEL_EMPTY_RETRIES = 1;
/**
 * P2 — ceiling on mid-turn handoffs, so a caller whose pool churns through
 * unusable models cannot spin. Each handoff is a genuinely different candidate
 * (the caller must refuse to hand back the same pair), so this only bounds a
 * pathological pool; a real one is exhausted well before it.
 */
export const MAX_MODEL_HANDOFFS_PER_TURN = 5;
/**
 * P3 — the turn's ATTEMPT budget, kept separate from its STEP budget.
 *
 * A mid-turn handoff spends model calls that produced nothing: the empty
 * completion that triggered it, and the first call to the replacement (which
 * may itself come back empty). Charging those to the same budget that governs
 * the actual WORK means a run against two or three dead models exhausts its
 * road before it has done anything — the exact way a task gets abandoned while
 * capable models are still queued. Each handoff therefore GRANTS two extra
 * steps of credit (capped), so hand-offs cannot be cut short by step
 * accounting; everything else — the step budget, the continuation budget, the
 * think-only cap — is untouched.
 */
export const MAX_HANDOFF_ATTEMPT_CREDIT = MAX_MODEL_HANDOFFS_PER_TURN * 2;
/**
 * P3 — WHY a turn ended, named.
 *
 * `bounded: true` said only "stopped before finishing", conflating a genuine
 * shortage of capable models with a budget that ran out while models remained.
 * The two demand opposite responses (an exhaustion report vs. a longer road),
 * so the loop now says which one it was:
 *
 *   - `delivered`          — an answer was produced. Finished.
 *   - `cancelled`          — the user stopped it (the dashboard Cancel button).
 *   - `no-capable-candidate` — every model that answered returned NOTHING
 *                            usable (or none could be reached). An evidenced
 *                            claim, and the trigger for the exhaustion report.
 *   - `reasoning-spin`     — one model kept emitting reasoning and never acted
 *                            or answered, past the bound. A bounded stop, not a
 *                            model shortage.
 *   - `budget-exhausted`   — the step budget ran out. BUG SIGNAL when nothing
 *                            was delivered and a handoff was still available;
 *                            the loop logs that loudly at the exit.
 *   - `generation-failed`  — the model call threw and there was nothing to
 *                            deliver (the provider walk already gave up).
 */
export type TurnTermination =
  | 'delivered'
  | 'cancelled'
  | 'no-capable-candidate'
  | 'reasoning-spin'
  | 'budget-exhausted'
  | 'generation-failed';
/**
 * Consecutive steps that RAN tools and had NO success before the loop asks the
 * model to diagnose the stall. This generalises {@link RunTrace.repeatedFailure}
 * (the identical action retried): a weak model also loops by substituting a
 * different command each step, every one failing the same underlying way — none
 * of them repeats exactly, so the same-action gate never fires.
 *
 * The threshold is deliberately ABOVE the handful of distinct checks ordinary
 * iteration tries (`npm test` → `npm run build` → `npm run lint`), so a short run
 * of unrelated failures is left alone; only a sustained all-fail streak is a stall.
 */
export const NO_PROGRESS_STALL_STEPS = 4;
/**
 * How substantial a turn must be before the SELF-REVIEW gate may fire (see
 * `selfReviewNudge`). Short, single-edit turns already end with an obvious
 * result the model just looked at; a long turn is where scope drift hides, and
 * where an extra pass earns its latency.
 */
export const SELF_REVIEW_MIN_STEPS = 6;
/**
 * S5 — how many `plan_todo` UPDATE calls one turn may make. The guard refuses
 * repeated CREATES (the observed planner loop) but must allow updates, because
 * an update is how the user's checklist advances; this cap only stops a model
 * that replaces doing the work with spamming status changes. It sits well above
 * a genuine multi-step job (the largest real plans in the tree are single
 * digits) and far below a loop.
 */
export const PLAN_TODO_UPDATE_CAP = 64;
/** Default continuations granted per turn when the option is omitted. */
export const DEFAULT_MAX_CONTINUATIONS = 2;
/** Default extra steps granted per continuation. */
export const DEFAULT_CONTINUATION_STEPS = 8;

/**
 * How many times a still-working turn may extend past its continuation budget.
 *
 * Finite on purpose: "never stop" must still be answerable. With the default
 * 16-step base, 2 (or 4 in `max` mode) continuations and 8 extensions, the hard
 * ceiling is 16 + 32 + 128 = 176 steps on a normal turn and 16 + 64 + 128 = 208
 * in `max` mode. The measured turn needed fewer than 20 more.
 */
export const MAX_PROGRESS_EXTENSIONS = 8;

/**
 * The absolute escape hatch for a requirement-driven turn (see
 * `ToolLoopOptions.requirementDrivenBudget`).
 *
 * NOT A BUDGET: it exists so a pathological loop cannot bill forever, and it sits
 * far above every measured build (the SaaS-platform benchmark reached 210 steps in
 * 16 minutes of real work). A loop that reaches it kept ADVANCING requirements the
 * whole way, which is a task nobody could have finished — the message says so and
 * names the flag rather than pretending the ask was answered.
 */
export const HARD_STEP_ESCAPE = 1000;
/**
 * `max` capability mode — the loop's longest bounded reasoning budget. The
 * defaults above are sized to keep an ordinary turn responsive; under `max` the
 * user has said cost is not a concern, so the same session is allowed to run a
 * long build / many-file edit to completion instead of stopping at the default
 * bound. Still finite: the hard cap is `maxSteps + 4 * 16` extra steps.
 */
export const MAX_CAPABILITY_MAX_CONTINUATIONS = 4;
export const MAX_CAPABILITY_CONTINUATION_STEPS = 16;
/** Pause before re-attempting a failed step (lets a transient outage clear). */
export const CONTINUATION_DELAY_MS = 1_500;

/**
 * Whether a generation failure looks TRANSIENT — the only case where waiting
 * before the resume attempt helps. A 5xx / network / timeout / rate-limit spike
 * can clear in seconds; a hard failure (no credentialed candidate, dead key,
 * bad model id) cannot, so it resumes IMMEDIATELY. Waiting on a hard failure
 * only delays the user's answer (and made the interactive/gateway paths
 * measurably slower for no benefit).
 */
export function isTransientGenerationFailure(message: string): boolean {
  return /(?:\b429\b|\b5\d\d\b|rate.?limit|quota|too many requests|timeout|timed out|etimedout|econn\w*|enotfound|socket hang up|network|fetch failed|dns|temporarily|overloaded|unavailable|try again)/i.test(
    message,
  );
}

/** Sleep helper for the bounded pre-continuation pause. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep that a CANCELLED turn interrupts.
 *
 * The blip patience below can wait ten seconds on a pair, and a 10s wait that
 * ignores Esc is a 10s delay before the turn admits it was cancelled — the same
 * defect `chat.ts`'s `abortableSleep` was written to fix. Sliced rather than
 * event-driven because the loop only holds an `AbortSignal`, and at 250ms a slice
 * the granularity is imperceptible next to the wait it is bounding.
 */
async function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + Math.max(0, ms);
  for (;;) {
    if (signal?.aborted) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await sleep(Math.min(250, remaining));
  }
}

/**
 * Mutable turn-level progress shared with the wrapper. Kept OUT of the many
 * `runToolLoopInner` return sites so every exit path (cancel, bounded, terminal
 * dispatch, end-of-response) reports the same honest accounting.
 */
export interface ToolLoopProgress {
  /** Names of tool calls that ran successfully this turn. */
  successfulToolCalls: string[];
  /**
   * CHECKS this turn ran, in order, with the write-count at each verdict — the
   * evidence `check-ledger.ts` reads to tell a red check that was ANSWERED from
   * one the turn simply outlived. Kept on the shared progress object (not loop
   * locals) so the wrapper can judge the turn's ending from the same record.
   */
  checkRuns: Array<CheckRun & { kinds: string[] }>;
  /**
   * The model's OWN `finish({verified:false, unmet})` claim, when the contract
   * accepted it. It is the only list the user is shown verbatim: a model that says
   * "this could not be done" must not have that sentence swallowed by a turn that
   * otherwise delivered (see the annotation in `runToolLoop`).
   */
  finishClaim?: { verified: false; unmet: string[] };
  /** True when a delivery tool reported an actual `✅` send. */
  deliveryConfirmed: boolean;
  /**
   * The pre-write workspace checkpoint, when one was taken (see
   * `learning/workspace-checkpoint.ts`). Lives on the shared progress object so the
   * wrapper can put it on the RESULT on every exit path — a cancelled turn that
   * already wrote two files still needs its undo point.
   */
  workspaceCheckpointId?: string;
  /** Session 4 — paths mutated successfully this turn (for verification relevance). */
  mutatedPaths: string[];
  /**
   * Bundle 19 — the CONTENT of every file this turn successfully wrote or edited, so
   * the turn can be judged on its own ARTIFACT rather than on its prose. Bounded in
   * both size and count (see `AUTHORED_ARTIFACT_MAX*`).
   */
  authoredArtifacts: Array<{ tool: string; path: string; content: string; words: number }>;
  /** Session 4 — successful verification calls (args + result) to judge relevance. */
  verificationEvidence: ToolCallEvidence[];
  /**
   * The actions this turn actually PERFORMED, in execution order (success and
   * failure alike), shared with the tools so the `finding` gate can check a
   * citation's provenance, and read at the end of the turn for the honesty
   * flags (a failed build plus a success claim — see `unverifiedBuildClaim`).
   */
  executedActions: ExecutedAction[];
  /**
   * Stage 2 — the live run trace, handed out so the caller can report the
   * turn's own behaviour as NUMBERS (how many questions reached the user, how
   * many repeated). A live object, snapshotted at the end of the turn — every
   * surface that wants the metric (the loop result, the eval framework, the
   * dashboard) reads the same counting instead of re-deriving it.
   */
  runTrace?: RunTrace;
  /**
   * R2 — the tool transport that served this turn, as reported by the caller's
   * `callModel` on each step. Last write wins, deliberately: a turn that began
   * on native tool calling and finished over the JSON fallback IS a JSON turn,
   * because that is how its answer was finally produced.
   */
  transport?: 'native' | 'json' | 'none';
}

/**
 * Run one tool-call turn:
 * generate → execute tools → feed results back → repeat until the model
 * returns a no-tools response (end turn), bounded by maxSteps.
 */
async function runToolLoopInner(opts: ToolLoopOptions, progress: ToolLoopProgress): Promise<ToolLoopResult> {
  const { messages, tools: toolNames, maxSteps = 16, context, deps } = opts;
  // Read once. Everything guarded by this is an opinion about the shape of the answer;
  // nothing guarded by it is a fact the environment produced (see the option's comment).
  const advisoryNudges = opts.advisoryNudges !== false;
  // Advisory gaps seen during the turn. They are never enforced; they are reported at the
  // end, because a user still deserves to know what the loop noticed and the agent did
  // not act on.
  const advisoryGaps: string[] = [];
  // Bounded auto-continuation state (see ToolLoopOptions.maxContinuations).
  // `max` capability mode raises the DEFAULT budget (an explicit option still
  // wins, so callers that pin a bound keep it). Read once per turn from the
  // config, exactly like routing, so a mode change applies to the next turn.
  const maxCapability = isMaxCapability(context.configManager);
  const maxContinuations = Math.max(
    0,
    opts.maxContinuations ?? (maxCapability ? MAX_CAPABILITY_MAX_CONTINUATIONS : DEFAULT_MAX_CONTINUATIONS),
  );
  const continuationSteps = Math.max(
    1,
    opts.continuationSteps ?? (maxCapability ? MAX_CAPABILITY_CONTINUATION_STEPS : DEFAULT_CONTINUATION_STEPS),
  );
  let continuations = 0;
  // Progress-gated extensions past the continuation budget (see
  // ToolLoopOptions.maxStepExtensions). `actionsAtLastGrant` is the count of
  // successful tool calls at the previous grant, so "still working" is a fact
  // about NEW work rather than an assumption from the step number.
  const maxStepExtensions = Math.max(0, opts.maxStepExtensions ?? MAX_PROGRESS_EXTENSIONS);
  /** The absolute escape hatch (never a budget): see `requirementDrivenBudget`. */
  const maxTotalSteps = Math.max(1, opts.maxTotalSteps ?? HARD_STEP_ESCAPE);
  let progressExtensions = 0;
  let actionsAtLastGrant = 0;
  // REQUIREMENT-DRIVEN BUDGET state: the requirement fingerprint at the last grant,
  // and how many consecutive grants moved it not at all. Two silent grants is a
  // stall — that, not a step count, is what ends a build that is going nowhere.
  let fingerprintAtLastGrant = '';
  let stalledGrants = 0;
  // Did this turn ever see the model's reasoning? Once it has, every later
  // tool-call turn is stamped with `reasoningContent` even when the step returned
  // none, because the endpoint requires the field on tool-call turns and the only
  // per-conversation signal the wire layer has can be trimmed away.
  let thinkingModeSeen = false;
  /** The "rejected for a missing reasoning_content, then repaired" line, once. */
  let reasoningRepairReported = false;
  /**
   * WIRE REPAIRS spent this turn (see the generation-failure catch below).
   *
   * MEASURED (2026-10-25): a provider answered `400 … messages[36].content:
   * unexpected end of hex escape` on every retry of the same thread, because the
   * poisoned message stayed in it — 49 tool calls of work, no deliverable, exit
   * 0. Two repairs are enough to recover a real turn (sanitise, then stub).
   */
  let wireRepairs = 0;
  // Bounded dangling-promise nudges spent this turn (see INTENT_PROMISE_RE).
  let intentNudges = 0;
  // G1 — bounded verification nudges spent this turn (see requireVerification).
  let verificationNudges = 0;
  // AUTO-VERIFY runs executed this turn (see ToolLoopOptions.autoVerify).
  let autoVerifies = 0;
  // G13 — bounded "the request already authorized this" nudges (see
  // detectPermissionSeeking).
  let permissionNudges = 0;
  // Stage 2 — the repetition nudge's own bound (see the block after the
  // permission nudge). Separate from `permissionNudges` on purpose: that one
  // asks the model to PROCEED, this one asks it to stop REPEATING, and the two
  // fire on independent evidence.
  let repeatNudges = 0;
  // The loop's SELF-DIAGNOSIS nudge: bounded once per turn, fired when the SAME
  // action has failed more than once (see RunTrace.repeatedFailure). This is the
  // capability that turns "retry the identical failing command 10 times" into
  // "state the root cause and change the approach" — the live macOS-build turn
  // re-issued `npx tauri build` again and again against the same missing Cargo.
  let diagnosisNudges = 0;
  // Stage 2 — consecutive tool-running steps with NO success (the generalized
  // stall signal, see NO_PROGRESS_STALL_STEPS). Reset by any successful tool.
  let failedToolSteps = 0;
  // Stage 4 — bounded SELF-REVIEW nudge (see requireSelfReview / selfReviewNudge).
  let selfReviewNudges = 0;
  // Bounded think-only continuation (see THINK_ONLY_ESCALATION). Counts the
  // consecutive reasoning-only steps so the loop cannot spin on them.
  let thinkContinues = 0;
  // P2 — empty-response accounting. `emptyRetriesOnCurrentModel` is the streak
  // of usable-nothing responses from the model currently serving the turn; it
  // resets the moment that model produces anything usable (or is replaced), so
  // "twice in a row" means twice in a row from THAT model. `modelHandoffs`
  // bounds how many times the turn may move.
  let emptyRetriesOnCurrentModel = 0;
  let modelHandoffs = 0;
  // P5 — the empty-response patience plan for the CURRENT streak, asked for once
  // (see `emptyResponsePatienceMs`) plus how many of its delays have been spent.
  // `undefined` = not asked yet; an empty array = asked, and the caller granted
  // nothing. Both are reset wherever the streak resets.
  let emptyPatienceSchedule: readonly number[] | undefined;
  let emptyPatienceSpent = 0;
  // P3 — the ATTEMPT budget (see MAX_HANDOFF_ATTEMPT_CREDIT): step credit
  // granted by mid-turn handoffs, so a run against several dead models cannot
  // exhaust its road before it has done any work.
  let handoffAttemptCredit = 0;
  // Why the turn is ending. The two `break`s in the empty/think-only path mean
  // opposite things (a model shortage vs. one model spinning), so the reason is
  // recorded explicitly rather than re-derived at the exit.
  let exitTermination: TurnTermination | null = null;
  // G13b — bounded "the request asked for a file and none was written" nudges
  // (see wantsAuthoredArtifact).
  let deliverableNudges = 0;
  // REQUIRED ARTIFACTS — bounded nudges for artifacts the request named that do
  // not exist yet (see `learning/task-artifacts.ts`). Two, not one: a build task
  // can name six files, and a single nudge that lists them is often acted on
  // partially. Never unbounded — after the second the turn ends and the gap is
  // reported in the trace rather than papered over.
  let artifactNudges = 0;
  // ZERO-ACTION — bounded "the request directed work and NOTHING was done"
  // nudges (see requireAction / zeroActionGateApplies).
  let actionNudges = 0;
  // COMPLETION CONTRACT — the `finish` mechanism. `finishAccepted` is set only by
  // a tool result that the evidence accepted (a marker, never prose), and it is
  // what silences the end-of-turn completion gate: a model that stated completion
  // and had it checked does not need to be asked again.
  let finishAccepted = false;
  let finishCalls = 0;
  let completionNudges = 0;
  // DOCUMENTATION DUTY — one bounded pass for a missing quickstart and for doc
  // claims that name artifacts which do not exist.
  let docsNudges = 0;
  /**
   * The last documentation FACT this turn delivered, so the mid-build ask and the
   * closing safety net cannot repeat it. Two messages about the same missing README
   * are a nag; two about DIFFERENT gaps (a README, then a deployment artefact) are
   * two facts.
   */
  let lastDocsSummary = '';
  /** The step the last mid-build docs ask was made at (spacing for the one repeat). */
  let lastDocsStep = 0;
  /**
   * The documentation pass was ALREADY asked for at a real boundary (the first green
   * check). Measured 2026-10-26 against Cline's own tree: its docs were written in
   * one batch at 14:57 — mid-run, after the API and pages existed, before the last
   * web work — and its ADRs at 14:23 while the API was being built. That is a
   * MILESTONE, not a cadence: the natural moment to write down what now exists. nuvira
   * used a 40-step timer, which fires whether or not anything works yet.
   */
  let docsBoundaryUsed = false;
  // WALL-CLOCK BUDGET — see `ToolLoopOptions.maxDurationMs`. `closingWindowMs` is
  // how much time is RESERVED for closing; once it opens, the turn stops extending
  // and the next two steps are for the handover and the answer.
  const clock = opts.now ?? Date.now;
  const turnStartedAt = clock();
  const turnDurationMs = opts.maxDurationMs && opts.maxDurationMs > 0 ? opts.maxDurationMs : undefined;
  const closingWindowMs =
    turnDurationMs === undefined ? 0 : Math.min(turnDurationMs / 2, Math.max(60_000, Math.round(turnDurationMs * 0.2)));
  let closingWindowAnnounced = false;
  /** Steps granted inside the closing window: enough to write the handover and answer. */
  const CLOSING_WINDOW_STEPS = 2;
  // DELIVERABLE COVERAGE — bounded nudges for a surface the ask named and the tree
  // does not contain (see `learning/deliverable-coverage.ts`). Two, for the same
  // reason the artifacts gate gets two: a build can be missing a frontend AND an
  // e2e suite, and one message that lists both is often acted on partially.
  let surfaceNudges = 0;
  /**
   * How often the coverage check runs mid-build. A walk of up to `MAX_FILES` paths
   * is cheap but not free, and the fact it reports (a whole app is missing) cannot
   * change within a handful of steps — so it is sampled, not run per step.
   */
  const SURFACE_CHECK_EVERY = 40;
  /** Two mid-build asks and one at the end, at most: enough to be heard, not a nag. */
  const MAX_SURFACE_NUDGES = 2;
  /**
   * Documentation asks per turn. Two while there is budget (a quickstart, then the
   * deployment story or the adoption kit), plus the closing safety net when neither
   * ran. Measured 2026-10-27: the mid-build ask waits up to 80 steps for a repeat, so
   * on a long build this is at most one message per 40-step interval — a cadence a
   * 600-call turn cannot call a nag.
   */
  const MAX_DOCS_NUDGES = 3;
  // CHANGE REQUEST — the signature of the last `CHANGE_REQUEST.md` content whose
  // requirement was delivered to the model this turn (mid-turn, as a directive), so
  // an unchanged file cannot be re-announced and a REVISED one is not missed.
  let changeRequestSeen: string | null = null;
  // The end-of-turn change-request gate spends one bounded ask.
  let changeRequestNudges = 0;
  // The checks this turn ran, shared with the wrapper via `progress`.
  const checkRuns = progress.checkRuns;
  /**
   * G18 — the sink, wrapped so an observability failure can never become a
   * turn failure (a recorder that throws is a bug in the instrument, not in
   * the work being observed).
   */
  const traceEvent = (event: LoopTraceEvent): void => {
    try {
      opts.onTraceEvent?.(event);
    } catch {
      // Best-effort.
    }
  };
  // The EFFECTIVE bound: starts at maxSteps and is extended (never beyond the
  // continuation budget) so a turn that still has work can finish.
  let stepLimit = maxSteps;
  // R1 — the harness, not a constant, decides how wide a read fan-out this
  // model can consume. Tiny models get 1 (serial): they rarely emit parallel
  // calls and interleaved results cost them more than the latency they save.
  const maxParallelReads = Math.max(1, opts.maxParallelReads ?? MAX_PARALLEL_READS);

  const followups: FollowupSuggestion[] = [];
  const toolCallsRun: string[] = [];
  // A call whose arguments never ARRIVED is not a call the model made: it is a
  // payload that did not fit in one model output (measured: 59 of them in one
  // turn). Counted per turn so the loop can escalate, and once-nudged so the
  // escalation itself cannot loop.
  let malformedToolCalls = 0;
  let malformedCallNudges = 0;
  // S5 — the plan_todo loop guard is split by ACTION (see the guard below):
  // repeated CREATES were the observed planner loop; UPDATES are the tracking
  // that keeps the user's checklist honest. Counted across the whole turn, like
  // `toolCallsRun`, because a multi-step job runs many steps in one turn.
  let planTodoCreates = 0;
  let planTodoUpdates = 0;
  // The PLAN CLOSE-OUT gate's own once-per-turn budget (see `planCloseoutNudge`).
  let planCloseoutNudges = 0;
  /**
   * PLAN DEPTH — bounded asks, re-checked at PHASE BOUNDARIES (see `learning/plan-depth.ts`).
   * Measured: a plan with eight named features in one step is why one arm shipped 51
   * endpoints and the other 69 — the step closed when the FIRST feature existed.
   *
   * WHY IT RECURS. A decomposition is not a one-time event: a long build re-plans — the
   * model adds a step for something it just discovered, rewrites the board after a change
   * request, or quietly folds four finished steps back into one "finish the backend". A
   * check that fires once at creation would watch the good plan arrive and then never look
   * again. So it is re-evaluated when the plan CHANGES (rewritten, or a step completed —
   * the two things that make a phase boundary), still bounded, and never about a complaint
   * it has already made: the signature is the exact set of bundled steps and missing
   * requirements, so an unchanged plan is silent while a NEW collapse is a new fact.
   */
  let planDepthAsks = 0;
  let lastPlanDepthSignature = '';
  /** Plan state as of the last depth check, so "changed" is measured, not assumed. */
  let lastPlanDone = (opts.context?.planStore?.snapshot?.()?.steps ?? []).filter((s) => s.status === 'done').length;
  let lastPlanRevision = opts.context?.planStore?.snapshot?.()?.revision ?? -1;
  /** Three distinct complaints per turn: enough for a plan rewritten twice, never a nag. */
  const MAX_PLAN_DEPTH_ASKS = 3;
  // Every collected suggestion passes through the shared normalizer, so the
  // loop's output is ALWAYS clean + structured (1–3 items, deduped, no leaked
  // tool JSON, capped prompt/label) regardless of what the model emitted —
  // and every surface (CLI, dashboard chips, gateway list) inherits it.
  const sink = {
    push(f: FollowupSuggestion) {
      const next = normalizeFollowups([...followups, f]);
      followups.length = 0;
      followups.push(...next);
    },
  };
  // ── G13: does the CURRENT request authorize file writes? ────────────────
  // Derived once, from the last user message, and handed to every tool. The
  // confirm-before-write gate needs this to tell "is this write the user's
  // stated intent?" apart from "is this a surprise?" — without it the gate can
  // only ask, so an unattended run whose ask is literally "write a 12 page
  // story" stops to ask "Do you want me to create the files?". Callers that
  // pass no messages (direct tool tests) get `undefined`, which preserves the
  // gate exactly as it was.
  const requestText = lastUserText(opts.messages);
  const authorization = requestAuthorizesWrites(requestText);
  /**
   * COVERAGE LEDGER — assessment turns only (see `learning/coverage-ledger.ts`).
   *
   * It answers the one question the loop could not answer before: WHICH files did
   * this turn actually open, and which files do those depend on that were never
   * opened. The measured reason it exists: on an identical audit Cline found 24
   * defects and nuvira 19, and the gap was breadth — nuvira declared ~8 K lines of
   * parsers/DAISY/GUI "not covered" and stopped. Nothing in the agent knew what it
   * had not read, so nothing could spend the cache savings (W1) on reading it.
   *
   * Constructed lazily for cost: the census walk happens on the first read or on
   * the first snapshot, never for a turn that is not an assessment.
   */
  const projectRoot = opts.context?.cwd || process.cwd();
  /**
   * PRE-WRITE WORKSPACE CHECKPOINT — the undo button Cline has and this loop did not.
   *
   * The capability existed (`nuvira checkpoint create` / `restore`) and was simply
   * never used automatically, so a turn that rewrote twenty files left the pre-edit
   * contents unrecoverable: `git checkout --` only helps when the work was
   * committed, and `git stash` refuses once the writes ARE the working tree.
   *
   * Taken ONCE per turn, immediately before the first tool call that is guaranteed
   * to write. That ordering is the whole point — a snapshot after the write is an
   * archive, not a rollback. Bounded and best-effort throughout: content addressing
   * makes an unchanged file cost one hash, a file/dir tree that is not a project
   * (HOME, `/`) is refused, and the caps live in the checkpoint module. Disable with
   * `NUVIRA_CHECKPOINT_BEFORE_WRITE=0`. No model call, no tokens.
   */
  let workspaceCheckpointId: string | null = null;
  let workspaceCheckpointAttempted = false;
  const ensureWorkspaceCheckpoint = (toolName: string): void => {
    if (workspaceCheckpointAttempted) return;
    if (!PRE_WRITE_CHECKPOINT_TOOLS.has(toolName)) return;
    if (process.env.NUVIRA_CHECKPOINT_BEFORE_WRITE === '0') return;
    if (!isProjectLedgerDir(projectRoot)) return;
    workspaceCheckpointAttempted = true;
    try {
      const started = Date.now();
      const checkpoint = createWorkspaceCheckpoint(projectRoot, {
        label: `before ${toolName}`,
        origin: 'loop',
      });
      workspaceCheckpointId = checkpoint.id;
      // Bound the automatic ones every 10th take (see `pruneAutoCheckpoints`): the
      // bound is what stops the store growing without limit, and a tenth of the
      // turns is enough to keep it within `DEFAULT_AUTO_KEEP + 9` without paying a
      // directory listing on every write.
      workspaceCheckpointsTaken += 1;
      if (shouldPruneAutoStore(workspaceCheckpointsTaken)) {
        const pruned = pruneAutoCheckpoints();
        if (pruned.length > 0) {
          deps.onEvent?.(`   🧹 pruned ${pruned.length} older automatic checkpoint(s) — the store keeps the newest ${DEFAULT_AUTO_KEEP}.`);
        }
      }
      progress.workspaceCheckpointId = checkpoint.id;
      const elapsed = Date.now() - started;
      deps.onEvent?.(
        `   🧷 Workspace checkpoint ${checkpoint.id} taken before the first write ` +
          `(${checkpoint.totals.files} files, ${formatBytes(checkpoint.totals.bytes)}, ${elapsed} ms) — ` +
          `undo with: nuvira checkpoint restore ${checkpoint.id}`,
      );
      traceEvent({
        kind: 'gate',
        gate: 'workspace',
        summary:
          `checkpoint ${checkpoint.id} taken before the first write ` +
          `(${checkpoint.totals.files} files, ${formatBytes(checkpoint.totals.bytes)}, ${elapsed} ms; ` +
          `${checkpoint.skipped.length} skipped)`,
      });
    } catch {
      // Best-effort: a checkpoint failure must never block the write it protects.
    }
  };
  // Constructed on EVERY turn, not only an assessment ask.
  //
  // It used to exist only where `isProjectAssessmentGoal` matched, which left the
  // turns that CHANGE code with no breadth record at all — the exact turns where an
  // unseen caller is a bug rather than a missed paragraph. Construction is free (no
  // I/O until the first read), the census walk is bounded, and only the
  // ROUND-GRANTING below stays assessment-only: a build is never extended for a
  // coverage percentage, because breadth is not what a build owes.
  const coverage = new CoverageLedger(projectRoot);
  // ── INTENT ENVELOPE (the durable grant) ──────────────────────────────────
  // `writesAuthorized` above answers "does the LAST message ask for files?" —
  // once per turn, and forgotten at the turn boundary. That is why permission
  // was re-asked for every operation and why an approval given minutes ago was
  // worth nothing on the next turn. The envelope is the same verdict as a
  // DURABLE, SCOPED object, keyed to the conversation (the dashboard console
  // keeps one plan store per session and re-injects it every turn; the CLI keeps
  // one per ChatCommand), so an approval outlives the turn that granted it.
  //
  // Grant order is deliberate: an APPROVED PLAN is the high-trust path (the user
  // saw the plan and said yes), then a fresh directive request, then whatever is
  // still live for this conversation.
  const envelopeKey = isEnvelopeKey(context.planStore) ? (context.planStore as object) : undefined;
  let envelope: IntentEnvelope | null = getEnvelope(envelopeKey);
  if (envelopeKey) {
    const plan = context.planStore?.snapshot?.() ?? null;
    if (plan && isAffirmativeReply(requestText)) {
      envelope = envelopeFromPlan(plan.goal);
      grantEnvelope(envelopeKey, envelope);
      deps.onEvent?.('   ✅ Plan approved — running it under one grant; no per-step permission.');
    } else {
      const fresh = envelopeFromRequest(requestText);
      if (fresh) {
        envelope = fresh;
        grantEnvelope(envelopeKey, fresh);
      }
    }
  }
  // ── RUN TRACE (the loop's representation of its own behaviour) ────────────
  // The envelope above answers "what may I do"; the trace answers "what have I
  // been DOING" — the question nothing in the architecture could answer, which
  // is why it could not notice its own loop and could not respond to a user
  // asking about one. Keyed to the conversation like the envelope, with a
  // per-turn fallback when there is no session handle so repetition WITHIN a
  // single turn is still caught.
  const traceKey = isTraceKey(context.planStore) ? (context.planStore as object) : undefined;
  const runTrace: RunTrace = traceKey ? runTraceFor(traceKey) : new RunTrace();
  progress.runTrace = runTrace;
  // WS1/A3 — the actions this turn actually PERFORMED, in execution order.
  // Shared on the one context object every tool call receives, and appended in
  // `runOne` as each call finishes BEFORE the next call in the same step runs,
  // so a `finding` in the same step can check its cited command/path against
  // what really happened (see `enforceEvidenceProvenance`).
  const executedActions: ExecutedAction[] = progress.executedActions;
  // P7 — a WRITE makes the world different, so a command that already failed may
  // now succeed. `run_terminal`'s identical-command guard exists to stop blind
  // repeats (the live run burned three back-to-back attempts), but a repaired
  // project re-running its own check is the ONE case that must never be refused:
  // with the guard's cap, that call would be rejected before it could ever
  // succeed and clear the streak — a deadlock where a fixed project could not
  // run its check again. Every tool that mutates the workspace announces it on
  // `autonomy:write-applied`, so the streak is dropped exactly when something
  // changed, and a blind repeat at the same timeout still counts.
  //
  // `run_terminal` announces on the SAME event when IT proceeds autonomously, but
  // that is a statement about its own command, not a change to the world — letting
  // it invalidate the streak would mean the guard could never accumulate on the
  // exact commands it exists for. Payloads name their emitter, so its event is
  // excluded by name while any other write (write_file, edit_file, git, …) counts.
  const baseEmit = context.emit;
  const emitWithWriteInvalidation: ToolContext['emit'] = (event, data, source) => {
    if (event === 'autonomy:write-applied' && (data as { tool?: string } | undefined)?.tool !== 'run_terminal') {
      resetTerminalFailureStreaks();
    }
    baseEmit?.(event, data, source);
  };
  const ctx: ToolContext = {
    ...context,
    emit: emitWithWriteInvalidation,
    followups: context.followups || sink,
    executedActions,
    writesAuthorized: authorization,
    // The RAW text too, not only the file-shaped verdict: each gated tool needs
    // the evidence its own question requires (does the request name this file?
    // ask for a commit? resolve to this CLI command?), and a single boolean
    // computed for a different question cannot answer any of them.
    authorizationRequest: requestText,
    // The durable grant every gate consults FIRST (see learning/intent-envelope.ts).
    envelope,
    // The run's own behaviour, so a gate can refuse to RE-ASK a question the
    // user already answered (see learning/run-trace.ts).
    runTrace,
    // C3 — the commands THIS run already answered.
    //
    // Created here, so its lifetime is exactly the tool loop's: one answer's
    // worth of steps, discarded after. That is the honest granularity — a probe
    // (`node --version`) is a fact about this run's environment, while
    // idempotent setup (`mkdir -p out`) is only safely skippable while the run
    // that created the directory is still going. A caller may inject its own
    // memo (a test, or a longer-lived session scope), and then it is honoured.
    commandMemo: context.commandMemo ?? createRunCommandMemo(),
  };
  // COMPLETION CONTRACT — publish the turn's live evidence to the `finish` tool.
  // A function, not a value: a tool call happens mid-turn and the ledger moves
  // with every write. Hoisted function declaration, so referencing it here is
  // safe even though its body is defined below.
  ctx.turnLedger = () => completionSnapshot();

  // ── COMPLETION CONTRACT (requirement ledger + test binding + check ledger) ──
  /**
   * The turn's checkable state, computed from the filesystem and the turn's own
   * evidence. Memoized against (mutations, checks) because the `finish` tool may
   * ask more than once and each computation walks the project once.
   */
  let completionMemo: {
    writes: number;
    checks: number;
    snapshot: TurnLedgerSnapshot;
    ledger: RequirementLedger;
    binding: BindingReport | null;
    red: RedCheck[];
  } | null = null;

  function completionEvidence(): NonNullable<typeof completionMemo> {
    const writes = progress.mutatedPaths.length;
    const checks = checkRuns.length;
    if (completionMemo && completionMemo.writes === writes && completionMemo.checks === checks) {
      return completionMemo;
    }
    const cwd = ctx.cwd ?? process.cwd();
    const ledger = resolveRequirementLedger(buildRequirementLedger(requestText), {
      cwd,
      checks: checkRuns.map((c) => ({
        kinds: c.kinds,
        ok: c.ok,
        ...(c.command ? { command: c.command } : {}),
        tool: c.tool,
      })),
      mutatedPaths: progress.mutatedPaths,
    });
    const written = [...new Set(progress.mutatedPaths)];
    const sourceModules = written.filter((p) => isSourceModule(p, cwd));
    const binding = testBindingApplies({
      buildShapedAsk: isBuildShapedAsk(requestText),
      moduleCount: sourceModules.length,
    })
      ? bindWrittenModulesToTests({ cwd, writtenPaths: sourceModules })
      : null;
    const red = unansweredRedChecks(checkRuns, writes);
    // A runnable entry point with no followable README is a COMPLETION fact, not a
    // style preference: `finish({verified:true})` is refused on it, so the claim and
    // the docs gate cannot contradict each other.
    const duty = quickstartDuty({ cwd, writtenPaths: written });
    // The deployment fact travels with the completion snapshot for the same reason the
    // quickstart does: without it, a model that calls `finish` before the closing gate
    // runs ends the turn and the 25-point "how does it ship" row is never asked about.
    // `finish({verified:false, unmet:[…]})` stays an accepted ending, so the gate asks
    // for a decision (ship it, or say it does not ship), never for a lie.
    const production = productionReadinessDuty({ ask: requestText, cwd, writtenPaths: written });
    // THE DELIVERABLE THE ASK NAMED, checked as a fact (see
    // `CompletionEvidence.namedDeliverables`). This is the file the user asked for by
    // path — not the looser `required-artifacts` vocabulary — so `finish` can refuse a
    // "done" that leaves it on the keyboard. Reads disk every time the memo misses,
    // which is exactly when a write or a check changed the turn's state.
    // Only work-shaped asks can be refused on it: "why is there no docs/x.md?" names a
    // path too, and a question is answered, not delivered (the same guard the
    // requirement ledger uses). An EXISTING named file is always evidence.
    const workShaped = isBuildShapedAsk(askText);
    const namedState = namedDeliverables
      .map((path) => ({
        path,
        exists: (() => {
          try {
            return existsSync(resolve(cwd, path));
          } catch {
            return false;
          }
        })(),
      }))
      .filter((entry) => entry.exists || workShaped);
    const snapshot: TurnLedgerSnapshot = {
      unmet: describeUnmet(ledger.unmet),
      ...(namedState.length > 0 ? { namedDeliverables: namedState } : {}),
      redChecks: red.map((r) => ({
        command: r.command,
        stale: r.stale,
        ...(r.preExisting ? { preExisting: true } : {}),
      })),
      unboundModules: binding?.unbound ?? [],
      ...(duty.needed && duty.entry ? { quickstart: { entry: duty.entry } } : {}),
      ...(production.needed && production.asked && production.entry
        ? {
            production: {
              asked: production.asked,
              entry: production.entry,
              ...(production.pointerTo ? { pointerTo: production.pointerTo } : {}),
            },
          }
        : {}),
      wroteFiles: writes > 0,
      checksRan: checks,
      advisoryGates: advisoryNudges,
      satisfied: ledger.satisfied.length,
      total: ledger.rows.length,
      unknown: ledger.unknown.length,
    };
    completionMemo = { writes, checks, snapshot, ledger, binding, red };
    return completionMemo;
  }

  function completionSnapshot(): TurnLedgerSnapshot {
    return completionEvidence().snapshot;
  }

  /**
   * The last two bounded gates of a turn — evaluated at BOTH exits, at most one
   * step each, and only when the evidence can NAME what is wrong.
   *
   * `completion` is the mechanism the measured run lacked: the request named work
   * (tests, tracking files, a green build) and the turn ended with it outstanding.
   * `docs` is separate because its advice is different (produce a quickstart,
   * correct a document) and because it fires on a different trigger (a runnable
   * entry point was written; a doc cites what does not exist).
   */
  /**
   * THE DOCUMENTATION DUTY — one resolver, because it speaks TWICE.
   *
   * Measured 2026-10-26 on the 210-step benchmark turn: the README nudge fired at
   * step 209, one step before the step ceiling, and the run ended with no README
   * at all — while EVERY arm of every round deferred documentation to "the end"
   * and never reached it. A gate that only speaks when the turn is already ending
   * cannot win a row that is written at the end; it can only report the loss. The
   * same three facts are therefore checked mid-build as well (see the periodic
   * block below), when there are steps left to act on them.
   *
   * Both callers share `docsNudges`, so the duty still spends at most two
   * messages: one while there is budget, one as the closing safety net.
   */
  function documentationGate(opts2: { allowRepeat?: boolean; closing?: boolean } = {}):
    | { gate: 'docs'; nudge: string; summary: string; event: string }
    | null {
    if (opts.requireDocsAudit === false) return null;
    if (finishAccepted) return null;
    if (progress.mutatedPaths.length === 0) return null;
    const cwd = ctx.cwd ?? process.cwd();
    const written = [...new Set(progress.mutatedPaths)];
    const duty = quickstartDuty({ cwd, writtenPaths: written });
    let fact: { nudge: string; summary: string; event: string } | null = null;
    if (duty.needed) {
      fact = {
        nudge: quickstartNudge(duty),
        summary: `a runnable entry point (${duty.entry ?? 'package.json'}) was produced and no README a fresh clone could follow exists`,
        event: '   📘 The turn made the project runnable without saying how to run it — asking for a quickstart.',
      };
    } else {
      // THE PRODUCTION-CLAIM GATE. Only when the ask itself claims production/deploy,
      // so an ordinary script or library is untouched. Measured 2026-10-26: the
      // benchmark's "production-ready" ask shipped API docs and an architecture
      // document and lost the deployment row with no operational artefact at all.
      const production = productionReadinessDuty({ ask: requestText, cwd, writtenPaths: written });
      if (production.needed && production.pointerTo) {
        fact = {
          nudge: productionDutyNudge(production),
          summary: `the ask says \`${production.asked}\` and the only deployment artefact is \`${production.pointerTo}\`, whose name does not say what it is — asking for a pointer a reader can find`,
          event: `   📘 The deployment story lives in \`${production.pointerTo}\` — asking for one discoverable line saying how it ships.`,
        };
      } else if (production.needed) {
        fact = {
          nudge: productionDutyNudge(production),
          summary: `the ask says \`${production.asked}\` and the runnable project has no deployment artefact (compose/Dockerfile/deploy dir/deploy doc/deploy workflow)`,
          event: '   📘 The project is runnable and claimed production-ready, with nothing that says how it ships — asking for an operational artefact.',
        };
      } else {
        // THE ADOPTION KIT. Ordered after the two documents a reader needs first, so
        // this never competes with the README or the deployment story for the single
        // message a step can carry. Mid-build it names the ONE most valuable missing
        // item; at the close it names the whole remaining set, because a handover that
        // arrives one page per step is a handover nobody finishes.
        const kit = missingAdoptionItems({ ask: requestText, cwd });
        const gaps = opts2.closing ? kit : kit.slice(0, 1);
        if (gaps.length > 0) {
          fact = {
            nudge: adoptionKitNudge(gaps, { closing: opts2.closing }),
            summary: `the service is runnable and owes ${gaps.length === 1 ? 'a' : gaps.length} adoption document(s): ${gaps.map((g) => g.label).join(', ')}`,
            event: `   📘 ${gaps.map((g) => g.label).join(', ')} ${gaps.length === 1 ? 'is' : 'are'} missing — nothing in the tree lets a stranger ${gaps.some((g) => g.id === 'api-contract') ? 'integrate with' : 'operate'} it.`,
          };
        } else {
          const findings = auditDocClaims({ cwd, writtenPaths: written });
          if (findings.length > 0) {
            fact = {
              nudge: docClaimsNudge(findings),
              summary: `${findings.length} documentation claim(s) name artifacts that do not exist in the workspace`,
              event: `   📘 ${findings.length} doc claim(s) cite things that do not exist — asking the model to create or correct them.`,
            };
          }
        }
      }
    }
    if (!fact) return null;
    // The SAME fact twice is a nag — EXCEPT once, when a long turn ignored the first
    // ask and kept working. That exception is measured, not hypothetical: the
    // 2026-10-27 re-run of the benchmark asked for the README at step 40, the model
    // wrote 20 more backend files, never mentioned it again, ran to the 60-minute
    // wall-clock cap and shipped NO README (`readmeBytes: 0`, docs 70). One ask in a
    // 600-call turn is a message the model can drop; two, 80 steps apart, is a
    // requirement it can still act on. The caller decides when the repeat is allowed
    // (mid-build only, never twice in a row at the close).
    if (fact.summary === lastDocsSummary && !opts2.allowRepeat) return null;
    lastDocsSummary = fact.summary;
    return { gate: 'docs', ...fact };
  }

  function closingGates():
    | { gate: 'completion' | 'docs' | 'deliverables' | 'change-request'; nudge: string; summary: string; event: string }
    | null {
    // A turn that has not STARTED is the zero-action gate's case: it is already told
    // to do the work, and restating the requirement list to a model that has not
    // touched anything is the duplication that makes gates ignorable. A turn that
    // read something, wrote something or ran a check has begun, and owes the rest.
    const didBeginWork =
      progress.mutatedPaths.length > 0 ||
      checkRuns.length > 0 ||
      progress.successfulToolCalls.some((name) => !CONTROL_TOOL_NAMES.has(name));
    const cwd = ctx.cwd ?? process.cwd();

    // ── CHANGE REQUEST (a requirement that arrived DURING the turn) ──────────
    // Ordered first because it is the newest requirement and it can invalidate the
    // design the earlier gates are about to defend: asking a model to close 52
    // requirement rows on a schema the user has just replaced is asking for the
    // wrong work. Measured 2026-10-26: the harness had been writing
    // `CHANGE_REQUEST.md` for two benchmark rounds and no agent ever mentioned it.
    if (opts.requireCompletion !== false && changeRequestNudges < 1 && didBeginWork) {
      const request = readChangeRequest(cwd);
      if (request) {
        const status = changeRequestStatus({ cwd, request });
        if (status.unheard.length > 0) {
          changeRequestNudges += 1;
          return {
            gate: 'change-request',
            nudge: changeRequestUnheardNudge(status),
            summary: `\`${request.path}\` arrived mid-turn and ${status.unheard.length} of its bullet(s) appear nowhere in the tree`,
            event: `   📩 \`${request.path}\` asked for something the tree does not reflect (${status.unheard.length} bullet(s)) — asking the model to implement it.`,
          };
        }
      }
    }

    // ── DELIVERABLE COVERAGE (a named surface the tree does not contain) ─────
    // The gates below this one all ask about something that EXISTS (an unmet row, a
    // cited file, a missing script). None of them could see the measured 2026-10-26
    // failure: 210 steps of progress, 13 test files, a green suite — and no
    // frontend, because nothing asked about the parts that were never started.
    // NOT AFTER AN ACCEPTED `finish` (2026-10-30). Measured on the GREENFIELD-API
    // head-to-head: the completion contract ACCEPTED the turn's claims, and this
    // heuristic then reopened it twice with a factually wrong report — a working
    // `server.py` on `http.server` and a `sqlite3` store were called "missing
    // backend / API and database / schema" because every evidence pattern was a
    // JS/TS filename. The model spent its closing steps running `ls server.py` to
    // prove to a checker that the server existed. `documentationGate` and the
    // self-review pass already stop at an accepted finish for the same reason: a
    // settled verdict outranks a heuristic, and a gate that cries wolf is how
    // every other gate becomes ignorable. Mid-build (below) still fires, where
    // there is budget to act on a real gap.
    if (advisoryNudges && opts.requireCompletion !== false && !finishAccepted && surfaceNudges < 2 && didBeginWork) {
      const gaps = missingSurfaceGaps({ ask: requestText, cwd });
      if (gaps.length > 0) {
        surfaceNudges += 1;
        return {
          gate: 'deliverables',
          nudge: surfaceGapsNudge(gaps),
          summary: `${gaps.length} surface(s) the ask named are absent from the tree: ${gaps.map((g) => g.label).join(', ')}`,
          event: `   🧱 The ask named ${gaps.length} surface(s) the tree does not contain (${gaps.map((g) => g.label).join(', ')}) — asking the model to build or state them.`,
        };
      }
    }

    if (opts.requireCompletion !== false && completionNudges < 1 && !finishAccepted && didBeginWork) {
      const { snapshot, ledger } = completionEvidence();
      // The REQUIRED-ARTIFACTS gate already named missing files (twice). Repeating
      // them would be the nag that makes every gate ignorable, so this message
      // keeps to what that gate does not own. The artifacts stay in the RESULT,
      // and `finish` still refuses a claim that ignores them.
      const unmet = artifactNudges > 0
        ? ledger.unmet
            .filter((row) => row.kind === 'check')
            .map((row) => `${row.describe}${row.evidence ? ` (${row.evidence})` : ''}`)
        : snapshot.unmet;
      // A red check that an unmet REQUIREMENT row already reports would be the
      // same fact twice in one message — the row carries its command and verdict.
      const redChecks = snapshot.redChecks.filter(
        (r) => !unmet.some((row) => row.includes(r.command)),
      );
      // Test binding is a PREDICTION (a static import may not be how a test reaches a
      // module — see `advisoryNudges`), so it counts toward the ask only while
      // advisories are on; unmet rows and red checks are evidence and always count.
      const unbound = advisoryNudges ? snapshot.unboundModules : [];
      // A file the ask NAMED by path. The required-artifacts gate owns the fixed
      // vocabulary (todo.md, README, e2e…), so an arbitrary path like
      // `docs/BUGS_FOUND.md` was nobody's: the turn could end with it unwritten and
      // every gate stayed silent (measured 2026-10-29). Named here — and refused by
      // `finish` — because the requested artifact is the deliverable.
      const missingNamed = (snapshot.namedDeliverables ?? []).filter((entry) => !entry.exists);
      const outstanding = unmet.length + unbound.length + redChecks.length + missingNamed.length;
      if (outstanding > 0) {
        completionNudges += 1;
        const named = [
          ...unmet.slice(0, 2),
          ...unbound.slice(0, 2),
          ...redChecks.slice(0, 2).map((r) => `${r.command} is red`),
          ...missingNamed.slice(0, 2).map((d) => `${d.path} is missing`),
        ];
        return {
          gate: 'completion',
          nudge: completionNudge({
            unmet,
            unboundModules: unbound,
            redChecks: redChecks.map((r) =>
              r.stale ? `\`${r.command}\` FAILED and has not been re-run since the code changed` : `\`${r.command}\` is red`,
            ),
            extra: missingNamed.map(
              (entry) =>
                `\`${entry.path}\` is named in the request and is not on disk — write the file now, with the content the request described`,
            ),
          }),
          summary: `${outstanding} checkable requirement(s) outstanding at the end of the turn: ${named.join('; ')}`,
          event: `   ✅ The turn is ending with ${outstanding} outstanding requirement(s) — asking the model to close them or state them.`,
        };
      }
    }

    // Three docs asks at most: a quickstart first (a reader cannot even run it), the
    // deployment story second (nobody said how it ships), then the adoption kit
    // (nobody can integrate or operate it). Three is still a bound: the same fact is
    // never repeated at the close (see `documentationGate`), so the third ask can only
    // ever be about a document the turn has not been told about yet.
    if (advisoryNudges && docsNudges < MAX_DOCS_NUDGES) {
      const docs = documentationGate({ closing: true });
      if (docs) {
        docsNudges += 1;
        return docs;
      }
    }
    return null;
  }

  // Resolve the tool set — stable JSON schemas for every native step
  // (derived from the registry's zod schemas, single source of truth).
  // I1 (toolsets): when the caller did not explicitly pick tools, gate the
  // schema to ENABLED toolsets only — the model never sees a disabled tool
  // (Capability-gating). Explicit toolNames win (caller intent).
  //
  // Tiered exposure (Addendum v3/v4): when opts.toolExposure === 'tiered'
  // and no explicit toolNames were given, the wire schema starts at the CORE
  // primitive set. Domain toolsets load MID-TURN via `tool_search` (action
  // "load"): the tool writes names into ctx.loadedExtraTools and the loop
  // unions their schemas into `schemas` below before the next step. The
  // mutable array + loaded set are the tiering state machine.
  const tiered = opts.toolExposure === 'tiered' && !toolNames;
  // Tiered exposure: guarantee the loader set exists even when the caller
  // forgot — tool_search load writes here; mergeLoadedTools reads it.
  if (tiered && !(ctx.loadedExtraTools instanceof Set)) {
    ctx.loadedExtraTools = new Set<string>();
  }
  const schemas: ToolJsonSchema[] = toolNames
    ? toolJsonSchemas(toolNames)
    : tiered
      ? coreToolJsonSchemas(context.configManager)
      : effectiveToolJsonSchemas(context.configManager);
  // Names already unioned into `schemas` (beyond the initial set). The loop
  // consults ctx.loadedExtraTools after EVERY executed tool call and merges
  // newly-loaded names here.
  const schemaNames = new Set(schemas.map((s) => s.name));
  const mergeLoadedTools = (): number => {
    if (!tiered) return 0;
    const loaded = ctx.loadedExtraTools;
    if (!(loaded instanceof Set) || loaded.size === 0) return 0;
    let added = 0;
    for (const name of loaded) {
      if (schemaNames.has(name)) continue;
      if (!getTool(name)) continue; // never schema a non-registered name
      if (!isToolEnabled(name, context.configManager)) continue; // I1 gate
      const [schema] = toolJsonSchemas([name]);
      if (schema) {
        schemas.push(schema);
        schemaNames.add(name);
        added++;
      }
    }
    if (added > 0) {
      deps.onEvent?.(`   🧰 ${added} tool(s) loaded via tool_search — now callable (${schemas.length} total).`);
    }
    return added;
  };

  const thread: ToolMessage[] = [...messages];
  // Every harness-authored nudge is delivered through ONE channel: a marked
  // `system` directive that the model ACTS ON, deduped by gate within the turn,
  // instead of a `user` message it answers (see tools/harness-directive.ts).
  const harness = createHarnessDirectiveSink();
  /**
   * The observations this turn delivered, shaped for the result. Present only when a
   * gate spoke — a clean turn must not carry an empty list that reads as "gates fired".
   */
  const observationsField = (): { observations?: HarnessObservation[] } => {
    const log = harness.observations();
    return log.length > 0 ? { observations: log } : {};
  };
  /** Serving pairs the loop has already told the model about, oldest first. */
  const routeFeedState = { pairs: [] as string[] };
  // ── C4 residual: the plan the conversation ALREADY has is shown, not hidden ──
  // The C4 experiment measured the shape of this failure: the plan store keeps the
  // plan (and now carries its progress across a re-declaration), but the model was
  // never SHOWN it — the store was read only to answer "does a plan exist". So a
  // later turn could not reference "step 3 is done" (which the tool's own
  // description promises) and re-declared the plan instead. Handing the plan back
  // at the top of every turn makes the carried progress visible and names the one
  // correct move (update), instead of relying on the model to guess that a plan is
  // already tracked.
  //
  // Bounded, and only when there is work left: a finished plan is not re-shown, and
  // a long plan is capped rather than allowed to dominate the context it exists to
  // protect.
  const existingPlan = context.planStore?.snapshot?.() ?? null;
  if (existingPlan && existingPlan.steps.length > 0 && existingPlan.steps.some((s) => s.status !== 'done')) {
    thread.push({ role: 'system', content: planContextBlock(existingPlan) });
  }
  // ── Stage 2: answer a question ABOUT the run from the run ────────────────
  // The live audit's worst moment was the user asking "why are you asking me
  // this again and again?" and the turn replying with an edit plan — not through
  // indifference, but because nothing held the fact that it had asked four
  // times. Handing the trace in makes the honest answer possible; the framing
  // line keeps it from being mistaken for a plan.
  if (detectProcessComplaint(requestText)) {
    deps.onEvent?.('   🪞 The user asked about your own behaviour — answering from the run trace.');
    traceEvent({
      kind: 'gate',
      gate: 'repeat',
      summary: `the user asked about the agent's own behaviour — trace provided (${runTrace.countAsks()} ask(s), ${runTrace.repeatedAskCount()} repeated)`,
    });
    thread.push({
      role: 'system',
      content:
        `${runTrace.selfReport()}\n\n` +
        'The user is asking about THIS behaviour, not about the code. Answer them directly: ' +
        'state what you did (how many questions you asked, which one you repeated, and what they ' +
        'answered), acknowledge the repetition plainly if there was one, and say what you will do ' +
        'instead. Do not answer a question about your own process with a plan for the work.',
    });
  }
  // C5 — `let`, not `const`: a mid-turn handoff can install a different model, and
  // the budget must follow it (see `threadBudgetAfterSwitch`).
  let budgetChars = opts.threadBudgetChars ?? DEFAULT_THREAD_BUDGET_CHARS;
  /**
   * W1 — the compaction WATERMARK (see `trimThreadBudget`). Everything before
   * this index is part of the prompt prefix the provider has already cached, so
   * it is frozen for the rest of the turn. `sealedThrough` is 0 until the first
   * compaction, then it is the index of the single compaction message.
   *
   * MEASURED (2026-10-25, the Cline head-to-head audit): the old per-call
   * trimming rewrote earlier messages 22 times in a 52-call run, and the
   * provider's cache-read share collapsed from 99.8 % to 12–17 % on exactly
   * those calls — re-billing ~90 K tokens each at 50× the cached rate.
   */
  let sealedThrough = 0;
  /** One line, once per turn, when the prefix could not be frozen (see M5). */
  let noCacheNoticeShown = false;
  // P3d — per-turn parallel suggester: after 2+ successful independent gather
  // steps, one advisory delegate suggestion fires (bounded, deterministic).
  const parallel = makeParallelSuggester();
  /**
   * WASTE GUARD — read-only calls already answered this turn, by signature, with
   * the mutation count at which they ran (see `memoizableReadSignature`). A hit
   * AT THE SAME mutation count is refused; any workspace write invalidates it.
   */
  const answeredReads = new Map<string, number>();
  /** How many repeat reads this turn refused instead of paying for (reported). */
  let repeatsAvoided = 0;
  /**
   * Steps that spent a whole model round-trip on ONE information-gathering call.
   * TOTAL, not consecutive: measured in the 2026-10-17 run of the slugkit task,
   * the one-call gather steps were interleaved with bookkeeping calls
   * (`plan_todo`, `finding`), so a consecutive-only counter never reached 2 and
   * the nudge never fired.
   */
  let singleGatherSteps = 0;
  /** The batching nudge is spent at most once per turn. */
  let batchingNudged = false;
  /** Plan steps this turn already advanced from the ledger (never re-advanced). */
  const planAutoAdvanced = new Set<string>();
  let steps = 0;
  /**
   * WS5 (#27) — model calls this run did NOT make because the checkpoint had a
   * recorded answer for the exact same input. Zero on an ordinary run, and
   * reported rather than merely logged: "this turn cost one model call instead of
   * three" is the whole claim of a partial resume.
   */
  let replayedSteps = 0;
  // The last SUBSTANTIVE answer text. JSON-only steps (a `{"tool":...}` block
  // with no visible text, common after the model already answered) must NOT
  // clobber it — otherwise the delivered answer is lost and the turn ends
  // with an empty/bounded response (the "where is the essay?" bug).
  let lastContent = '';
  /**
   * The last SUBSTANTIVE answer this turn produced, kept ACROSS the bounded
   * NUDGE gates — `lastContent` is not.
   *
   * WHY THIS EXISTS (measured: `trace-1791754367868-vedwmp`, 2026-10-12, on the
   * dashboard surface). Step 0 delivered a complete 3,831-character answer to a
   * design question ("what if I add a button on chat…how will that be?"). The
   * ZERO-ACTION gate then judged that ask to be "work on the workspace" and
   * spent its one bounded nudge — clearing `lastContent` on the way out, because
   * a non-answer must not be handed back as the answer. The nudge step then died
   * (`local/wire-stub-model`, two empty steps). `delivered` was read from the
   * now-empty `lastContent`, so the turn reported `generationFailed` and the
   * caller replaced the answer with an EXHAUSTION REPORT: "Tried 25 models…".
   * The user's answer was thrown away and a failure message was shown for a turn
   * that had answered correctly — the complaint that produced this fix.
   *
   * The rule: a gate may invalidate the text it is judging as the FINAL answer,
   * but it may never erase the fact that an answer was produced. If the turn
   * dies on a nudge, the delivered answer is the best available truth, and
   * `generationFailed` (which answers exactly one question — "was an answer
   * delivered?") is FALSE. The turn's honesty flags (`undeliveredChange`,
   * `unverifiedEdit`, …) still carry the residual warning.
   */
  let lastDeliveredAnswer = '';
  /**
   * Store answer text: `lastContent` (nudge-clearable) AND the answer memory
   * (never cleared). Every assignment of a REAL answer goes through this, so the
   * two cannot drift; `lastContent = ''` stays a deliberate clear of the former
   * only.
   */
  const rememberContent = (text: string): void => {
    lastContent = text;
    if (text.trim()) lastDeliveredAnswer = text;
  };
  /**
   * How many PRODUCTIVE actions had SUCCEEDED when `lastContent` was written.
   *
   * WHY THIS EXISTS (D1 — the delivered answer contradicted the run's own
   * evidence). `lastContent` used to be replaced only when the new text was at
   * least as long, so the delivered answer was the LONGEST text of the turn —
   * and the model's own later correction could never take over. Measured in
   * `trace-1791300903944-upblb7` (an 82-step run): the longest step was **seq 65
   * (4,024 chars)** — the "Built and verified. Here's the rundown." draft — while
   * seq 80 ("Hold on — that README note claims `sentence-transformers` needs a
   * `torch` build, but I never actually tested that install. Let me check rather
   * than assert.") and seq 82 ("My README claim was **wrong** — torch-2.14.1 and
   * sentence-transformers-6.1.0 do resolve…") are 155 and 165 chars. Both are
   * corrections of the draft, both are shorter, so the run delivered the draft
   * and the user read an assertion the agent had already disproved itself.
   *
   * The rule the length check was reaching for is "a trailing WRAPPER must not
   * clobber the essay". Length is the wrong proxy for that, because a correction
   * is also short. What actually separates them is whether the turn DID something
   * in between: text written after real work is an account of a LATER state and
   * supersedes; a closing paragraph written with no work since is presentation.
   * So a later answer wins when real work happened after the stored one.
   *
   * The presentation calls in `NON_PRODUCTIVE_TOOLS` are excluded on purpose —
   * `suggest_followups` is what the end-of-response contract forces, it changes
   * nothing, and it is precisely the call that produces the trailing wrapper
   * this rule must still ignore (the same set `hasProductiveAction` uses, so the
   * two cannot drift).
   */
  let workCallsBeforeLastContent = 0;
  /** A capture happened this step; stamp it at the top of the NEXT one (see below). */
  let pendingContentStamp = false;
  let bounded = false;
  // D2.2 — has this turn already pre-flighted the project's build prerequisites?
  // Checked once, before the FIRST build command the turn plans to run.
  let prerequisitesPreflighted = false;
  // E2 — has this turn already spent its one bounded "declare a plan first"
  // nudge? Bounded once, like every other gate.
  let planNudged = false;
  // E2 (hard) — has this turn already spent its one bounded BLOCK of the first
  // mutation? The plan gate is a hard requirement the first time it fires and a
  // pure nudge after that: the first mutating batch is refused (see the gate
  // below), and the second attempt runs even without a plan — a bounded block,
  // never a wall.
  let planBlocked = false;

  /**
   * Should the SELF-REVIEW gate fire now? Returns the correction to inject, or
   * null. Extracted so the two end-of-turn exits ask the question identically —
   * nothing here is a function of which branch is ending.
   */
  const selfReviewCorrection = (): string | null => {
    if (selfReviewNudges >= 1) return null;
    if (opts.requireSelfReview === false) return null;
    // ALREADY REVIEWED — `finish` IS the review. The completion contract judged the
    // turn's claim against its own requirement ledger, check ledger and test
    // bindings, and ACCEPTED it; asking the model to re-read the result after a
    // settled verdict is a second opinion on a closed question, paid for with the
    // most expensive thing the loop spends: one model round-trip. Measured
    // 2026-10-30 on DEV-FEATURE (3 runs): the nudge fired after an accepted `finish`
    // in 3/3 runs, and each time the model re-read a file it had just written and
    // re-called `suggest_followups` — one step, no finding. A turn that never called
    // `finish` still gets the review, so the safety net stays where it is needed.
    if (finishAccepted) return null;
    if (steps < SELF_REVIEW_MIN_STEPS) return null;
    // A turn that changed nothing has nothing to re-read — UNLESS the turn is an
    // assessment, whose deliverable is claims rather than edits (see
    // `selfReviewWhenUnchanged`).
    if (progress.mutatedPaths.length === 0 && opts.selfReviewWhenUnchanged !== true) return null;
    // The verification gate owns "did you check it"; self-review only runs once
    // that question is settled, so the two can never both fire in one turn.
    const activity = assessEditActivity(
      progress.successfulToolCalls,
      progress.verificationEvidence,
      progress.mutatedPaths,
      ctx.cwd ?? process.cwd(),
    );
    if (activity.needsVerification) return null;
    return selfReviewNudge(currentAsk(opts));
  };

  /**
   * The artifacts the ASK itself names, resolved against the working directory.
   *
   * WHY THIS EXISTS (measured): an audit run spent its whole step budget and
   * returned a report that was 0 bytes on disk — the model had staged the file
   * inside the repo and never moved it out. The continuation budget could not
   * help, because the progress-gated extension below additionally required an
   * open PLAN, and a turn with no plan store never qualified. The deliverable
   * is the better proxy for "work remaining": a turn that still owes the file
   * it was asked to write has work left even when it has no plan.
   *
   * Only PLACED paths (containing a separator) are checked when the ask names
   * any, so "REPORT.md in the parent directory" does not also make the bare
   * `REPORT.md` inside the repo a phantom missing file.
   */
  // Assessment findings already CREDITED to the budget (see the yield block at
  // the step bound). Reset per turn, like every other accumulator here.
  const assessmentSeen = new Set<string>();
  /**
   * Bounds on the COVERAGE rounds (see `learning/coverage-ledger.ts`).
   *
   * Two rounds, each one `COVERAGE_ROUND_STEPS` steps, granted only where the
   * assessment budget was already spent and the report had stopped improving. The
   * saving that pays for them is produced earlier in the same run (the cache-stable
   * prefix, W1) — so breadth is funded, not bolted on. A round that opens nothing
   * new ends the turn: the stop condition is a measured fact, not a judgement.
   */
  const MAX_COVERAGE_ROUNDS = 2;
  const COVERAGE_ROUND_STEPS = 6;
  let coverageRounds = 0;
  let openedAtLastCoverageRound = 0;
  /**
   * Bounds on the EDIT-BREADTH nudge (build and refactor turns).
   *
   * One shot, and it grants NO steps of its own — it rides on a continuation or an
   * extension the turn was already given. That is deliberate: the assessment round
   * above can widen a budget because a report that stopped yielding under-read
   * evidence is a report that may be wrong. A build has no such argument, and the
   * last thing this loop needs is a second ladder. So the fact is stated once, for
   * free, and the turn is free to answer it with a reason instead of a read.
   */
  const MAX_EDIT_BREADTH_NUDGES = 1;
  let editBreadthNudges = 0;
  /** Whether this turn is an assessment (hoisted: the coverage gate asked once per bound). */
  const assessmentTurn = isProjectAssessmentGoal(requestText);
  // The USER's own words, not the composed prompt: a surface (the gateway, the
  // dashboard) wraps the message with its own context, and a path that appears in
  // that wrapper is not something the user asked to be written. Measured while
  // adding the deliverable gate: reading the composed prompt made a gateway turn
  // that only said "list the working directory" look like it owed a file, which
  // cost an extra model step and broke surface parity.
  const askText = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role === 'user' && typeof message.content === 'string') {
        // Stripped, not merely chosen: the gateway's user turn is this product's
        // `[Origin: … (WhatsApp/Telegram/etc.)]` banner followed by the ask, and
        // reading the banner as the ask made `/Telegram/etc` a "named deliverable"
        // — a phantom file the turn was then nudged, twice, to go and write
        // (measured 2026-10-29: one extra model step on every gateway turn).
        const text = stripInjectedContext(message.content).trim();
        if (text) return text;
      }
    }
    return stripInjectedContext(requestText).trim();
  })();
  const namedInAsk = deliverablesNamedIn(askText);
  const placedOnly = namedInAsk.filter((p) => p.includes('/') || p.includes('\\'));
  const namedDeliverables = (placedOnly.length > 0 ? placedOnly : namedInAsk).slice(0, 8);
  // ── DELIVERABLE-FIRST (measured 2026-10-29, BUG-SEEDED) ────────────────────
  // A request that names a file, answered by a turn that fixes everything and writes
  // no file, is the failure this says the order of work out loud for. Delivered as the
  // turn's opening observation, once, when acting on it is still cheap.
  if (namedDeliverables.length > 0 && isBuildShapedAsk(askText)) {
    harness.push(thread, 'deliverable-first', deliverableFirstNudge(namedDeliverables));
  }
  /**
   * Hand the turn ONE fact about the breadth of its own edit, when it is being
   * continued anyway.
   *
   * The gap this closes: the coverage ledger used to run only on assessment asks,
   * so the turns that CHANGE code had no breadth record at all — a refactor could
   * alter a function and never open the file that calls it, and nothing in the loop
   * knew. `unreadAround` answers both directions from the import graph (what the
   * change calls, and what calls the change), and this pushes the answer into the
   * thread while the turn still has steps to act on it.
   *
   * Bounded three ways: never on an assessment (its own round handles breadth),
   * once per turn, and never with a step grant of its own — see
   * `MAX_EDIT_BREADTH_NUDGES`. If no grant happens the turn simply ends, and the
   * evidence is still recorded on the trace.
   */
  const maybeNudgeEditBreadth = (): void => {
    if (!coverage || assessmentTurn || editBreadthNudges >= MAX_EDIT_BREADTH_NUDGES) return;
    if (progress.mutatedPaths.length === 0) return;
    let gaps;
    try {
      gaps = coverage.unreadAround(progress.mutatedPaths);
    } catch {
      return; // breadth is an accelerator, never a dependency
    }
    // The trace records the fact either way: a turn that ends before another grant
    // still leaves its own breadth on the record (see `learning/reasoning-trace.ts`).
    if (gaps.length === 0) return;
    editBreadthNudges += 1;
    const edited = new Set(progress.mutatedPaths).size;
    deps.onEvent?.(
      `   🔎 Breadth of this edit: ${gaps.length} related file(s) never opened ` +
        `(${gaps.filter((g) => g.direction === 'dependent').length} caller(s) of the changed code) — named once.`,
    );
    traceEvent({
      kind: 'gate',
      gate: 'coverage',
      summary:
        `${edited} edited file(s) have ${gaps.length} never-opened relative(s) ` +
        `(${gaps.map((g) => `${g.direction === 'dependent' ? 'caller ' : 'callee '}${g.file}`).join(', ')}) — ` +
        `stated once with no extra steps granted`,
    });
    thread.push({ role: 'user', content: coverage.editBreadthNudge(gaps, edited) });
  };

  const deliverableUnfinished = (): boolean => {
    if (namedDeliverables.length === 0) return false;
    try {
      return !verifyArtifacts(namedDeliverables, ctx.cwd ?? process.cwd()).ok;
    } catch {
      return false;
    }
  };

  for (;;) {
    // ── Bounded auto-continuation on the STEP BOUND ────────────────────────
    // The model still wanted to act when the budget ran out (a long build, a
    // many-file edit). Extend the budget a bounded number of times and keep
    // the SAME thread — completed tool calls are never re-run — instead of
    // telling the user "I reached my step limit" with the task unfinished.
    if (steps >= stepLimit + handoffAttemptCredit) {
      // ── ASSESSMENT YIELD (see `learning/finding-yield.ts`) ────────────────
      // An audit is not extended because time passed, or because a read landed:
      // it is extended because the report GAINED a finding since the last grant,
      // and it is stopped as soon as a whole round adds none. That is what makes
      // the same budget right for both ends of the range — a small project ends
      // after one dry round instead of spending every continuation on the same
      // twelve files, and a large project keeps earning steps while it is still
      // pulling real defects out of the parts of the tree nobody has opened yet.
      const isAssessmentTurn = assessmentTurn;
      const assessmentYield = isAssessmentTurn
        ? readFindingYield({
            content: lastContent || lastDeliveredAnswer,
            reportPaths: namedDeliverables,
            root: ctx.cwd ?? process.cwd(),
            seen: assessmentSeen,
          })
        : null;
      const freshFindings = assessmentYield?.fresh.length ?? 0;
      // A dry round is only DRY once findings exist: a report that has been
      // opened but has no defect in it yet is a report still being written, and
      // stopping there would truncate the run before its Bug Discovery section.
      const dryAssessmentRound =
        assessmentYield !== null && assessmentSeen.size > 0 && freshFindings === 0;
      // Size-scaled for assessments; the plan-driven cap for everything else.
      const extensionCap = isAssessmentTurn
        ? assessmentExtensionCap(countSourceFiles(ctx.cwd ?? process.cwd()))
        : maxStepExtensions;
      const rememberYield = (): void => {
        for (const title of assessmentYield?.fresh ?? []) assessmentSeen.add(title);
      };
      if (dryAssessmentRound) {
        // ── COVERAGE before stopping (see `learning/coverage-ledger.ts`) ─────
        // A DRY round means the report stopped gaining findings, which can mean
        // "nothing left to find" OR "read too little to find more". The ledger
        // distinguishes them from data: coverage against the census, and the
        // unread files the READ ones import. The gamble the earlier plan accepted
        // ("the model will read more because reading is cheap") is replaced by
        // three deterministic conditions: a budget was already spent, the tree is
        // demonstrably under-read or has a live frontier, and the LAST coverage
        // round actually opened something (otherwise it bought nothing and the
        // turn stops).
        if (
          advisoryNudges &&
          coverage &&
          coverageRounds < MAX_COVERAGE_ROUNDS &&
          coverage.openedCount() > openedAtLastCoverageRound
        ) {
          const artifacts = progress.authoredArtifacts.map((a) => a.content);
          const unbacked = coverage.unbackedCitations([...artifacts, lastContent || lastDeliveredAnswer]);
          const nudge = coverage.nudge({ unbacked });
          if (nudge) {
            const snapshot = coverage.snapshot();
            coverageRounds += 1;
            openedAtLastCoverageRound = coverage.openedCount();
            stepLimit += COVERAGE_ROUND_STEPS;
            deps.onEvent?.(
              `   📚 Coverage ${Math.round(snapshot.coverage * 100)}% ` +
                `(${snapshot.openedFiles}/${snapshot.totalFiles} source files), ` +
                `${snapshot.frontier.length} unread dependenc${snapshot.frontier.length === 1 ? 'y' : 'ies'}` +
                `${unbacked.length > 0 ? `, ${unbacked.length} finding(s) citing an unread file` : ''} — ` +
                `spending one bounded reading round before stopping (${coverageRounds}/${MAX_COVERAGE_ROUNDS}).`,
            );
            traceEvent({
              kind: 'gate',
              gate: 'coverage',
              summary:
                `the step budget ran out with no new finding, but only ${snapshot.openedFiles} of ` +
                `${snapshot.totalFiles} source files had been opened (${Math.round(snapshot.coverage * 100)}%) ` +
                `with ${snapshot.frontier.length} unread dependenc${snapshot.frontier.length === 1 ? 'y' : 'ies'} — ` +
                `one bounded reading round granted (${coverageRounds}/${MAX_COVERAGE_ROUNDS})`,
            });
            thread.push({ role: 'user', content: nudge });
            continue;
          }
        }
        deps.onEvent?.(
          `   ✅ No new findings this round — stopping at ${assessmentSeen.size} finding(s) (assessment budget spent after ${steps} steps).`,
        );
        traceEvent({
          kind: 'gate',
          gate: 'assessment-dry-round',
          summary:
            `the step budget ran out and the last round added no new finding — stopped at ` +
            `${assessmentSeen.size} finding(s) instead of spending another round`,
        });
        break;
      }
      if (continuations < maxContinuations) {
        continuations += 1;
        stepLimit += continuationSteps;
        maybeNudgeEditBreadth();
        actionsAtLastGrant = progress.successfulToolCalls.length;
        rememberYield();
        deps.onEvent?.(
          `   🔄 Step bound reached with work remaining — continuing (continuation ${continuations}/${maxContinuations}, budget ${stepLimit} steps` +
            `${freshFindings > 0 ? `, ${freshFindings} new finding(s)` : ''}).`,
        );
        continue;
      }
      // ── Progress-gated EXTENSION (see ToolLoopOptions.maxStepExtensions) ──
      // The continuation COUNT is spent, but the turn's OWN PLAN still has open
      // steps and a successful tool call landed since the last grant: the model
      // is serving the task, not spinning. Stopping here would throw away a live
      // thread mid-task (measured: 2 of 9 plan steps left, document written,
      // verification running) — the exact failure this branch exists to remove.
      const actionsNow = progress.successfulToolCalls.length;
      const planStillOpen = (opts.context?.planStore?.snapshot?.()?.steps ?? []).some(
        (step) => step.status !== 'done',
      );
      // A turn that still owes an artifact the ask named has work remaining even
      // with no plan to point at (see `namedDeliverables` above).
      const owesDeliverable = deliverableUnfinished();
      // For an assessment, a NEW FINDING is the progress that counts. The plan
      // half and the missing-deliverable half stay (a report not yet on disk is
      // work remaining), but a report that is on disk and still yielding
      // defects must keep going even with no plan and nothing left to place.
      const gainedFindings = isAssessmentTurn && freshFindings > 0;
      // An assessment that has not CREDITED a finding yet is still reading its
      // way to the Bug Discovery section: a report that exists but carries no
      // defect is work in progress, not a dry round. This half is bounded by the
      // same extension cap, so "still looking" cannot outlive the budget.
      const stillLooking = isAssessmentTurn && assessmentSeen.size === 0;
      // ── REQUIREMENT-DRIVEN BUDGET (see ToolLoopOptions.requirementDrivenBudget) ──
      //
      // A build ends when the ASK is satisfied, not when a count is spent. So on a
      // non-assessment turn the extension is bounded by the REQUIREMENT LEDGER, not
      // by a number: the turn gets more steps while a requirement row is still
      // unmet, a plan step is open, or a named artifact is missing — and stops when
      // a whole granted round moved no requirement (a measured stall), or when the
      // absolute escape hatch binds.
      const openRows = (() => {
        try {
          return completionEvidence().ledger.unmet.length;
        } catch {
          return 0;
        }
      })();
      // An EXPLICIT extension cap means the caller wants the fixed allowance (every
      // pre-existing test and any embedding that sized its own turn does), so the
      // requirement-driven road is the DEFAULT only where nobody pinned a number.
      const requirementDriven =
        (opts.requirementDrivenBudget ?? opts.maxStepExtensions === undefined) && !isAssessmentTurn;
      // What "advancing the ask" means, as a fingerprint. Satisfied rows and written
      // files are the two things every requirement row is ultimately evidenced by;
      // a green check is in both, so it is not counted twice.
      const requirementFingerprint = `${(() => {
        try {
          return completionEvidence().ledger.satisfied.length;
        } catch {
          return 0;
        }
      })()}|${progress.mutatedPaths.length}`;
      const requirementOpen = openRows > 0 || planStillOpen || owesDeliverable;
      const extensionReason = gainedFindings
        ? `${freshFindings} new finding(s) in the report`
        : openRows > 0
          ? `${openRows} requirement(s) the ask named are still unmet`
          : planStillOpen
            ? 'the plan has open steps'
            : owesDeliverable
              ? `the deliverable ${namedDeliverables.join(', ')} is not on disk yet`
              : 'the assessment has not credited a finding yet';
      // A STALL is the count's real job, done from evidence: two consecutive grants
      // that left every requirement row and the file count exactly where they were.
      const stalled = requirementDriven && requirementFingerprint === fingerprintAtLastGrant;
      if (stalled) stalledGrants += 1;
      else stalledGrants = 0;
      const withinBudget = requirementDriven
        ? stalledGrants < 2 && steps < maxTotalSteps
        : extensionCap > progressExtensions;
      const wantsMore = requirementDriven
        ? requirementOpen || gainedFindings || stillLooking
        : planStillOpen || owesDeliverable || gainedFindings || stillLooking;
      // A closing window refuses further extension on purpose: the budget the caller
      // gave is the one thing the turn cannot earn back.
      if (withinBudget && wantsMore && actionsNow > actionsAtLastGrant && !closingWindowAnnounced) {
        const gained = actionsNow - actionsAtLastGrant;
        progressExtensions += 1;
        stepLimit += continuationSteps;
        maybeNudgeEditBreadth();
        actionsAtLastGrant = actionsNow;
        fingerprintAtLastGrant = requirementFingerprint;
        if (requirementDriven) stalledGrants = 0;
        rememberYield();
        deps.onEvent?.(
          `   🔄 Still working — ${extensionReason} ` +
            `and ${gained} new successful tool call(s) landed — extending the step budget ` +
            `(extension ${progressExtensions}${requirementDriven ? ', no fixed cap: the ask decides when this turn is done' : `/${extensionCap}`}, budget ${stepLimit} steps).`,
        );
        traceEvent({
          kind: 'gate',
          gate: 'budget-extension',
          summary:
            `the continuation budget was spent but ${extensionReason} and ${gained} new successful ` +
            `tool call(s) landed — extended to ${stepLimit} steps (extension ${progressExtensions}/${extensionCap})`,
        });
        continue;
      }
      /**
       * LAST-MILE ASK — the ceiling is where the measured run actually ended.
       *
       * The end-of-turn gates live on the two MODEL-DECIDED exits (no tool calls,
       * or a concluding follow-up). A run that keeps calling tools never reaches
       * them: it hits the step ceiling instead. Measured 2026-10-26 on the
       * benchmark build — 178 steps, a monorepo with 10 test files, and STILL no
       * README and none of the four tracking files the prompt named, because the
       * gates were correct and unreachable, which is worse than absent: it looks
       * covered. So the ceiling gets the same ask, once per category, and grants
       * the single step that answering it costs.
       */
      const lastMile = advisoryNudges ? closingGates() : null;
      if (lastMile) {
        stepLimit += 1;
        deps.onEvent?.(lastMile.event);
        traceEvent({ kind: 'gate', gate: lastMile.gate, summary: lastMile.summary });
        // The thread already ends with this step's tool results, so the wire
        // contract is intact; the directive is the only thing added.
        harness.push(thread, lastMile.gate, lastMile.nudge);
        continue;
      }
      break;
    }
    // ── CHANGE REQUEST (mid-turn) ──────────────────────────────────────────
    //
    // A long autonomous turn has no second user message. `CHANGE_REQUEST.md` is the
    // channel the benchmark harness (and a user watching the run) already writes,
    // and until now it was a bet that the model re-reads its root at a milestone:
    // measured 2026-10-26, none of three agents mentioned it. So the loop reads the
    // file itself — one `stat` per step — and delivers a NEW requirement to the
    // model as a harness directive THE MOMENT it appears, while there is still
    // budget to act on it. Delivering at the ceiling would be a receipt, not a
    // requirement. See `learning/change-request.ts`.
    if (opts.watchChangeRequests !== false) {
      const request = readChangeRequest(ctx.cwd ?? process.cwd());
      if (request && request.signature !== changeRequestSeen) {
        changeRequestSeen = request.signature;
        harness.push(thread, `change-request:${request.signature}`, changeRequestNudge(request));
        deps.onEvent?.(
          `   📩 A change request arrived while you were working — \`${request.path}\`${request.title ? ` (“${request.title}”)` : ''} — delivered to the model now, not at the end.`,
        );
        traceEvent({
          kind: 'gate',
          gate: 'change-request',
          summary: `\`${request.path}\` changed mid-turn (${request.bullets.length} bullet(s)); the new requirement was injected as a directive`,
        });
      }
    }
    // ── DELIVERABLE COVERAGE, MID-BUILD ────────────────────────────────────
    //
    // Checked periodically rather than only at the ceiling, because the ceiling is
    // no longer a step count: on a requirement-driven turn the run can go for
    // hundreds of steps, and a gate that only speaks at the end would arrive after
    // the budget was spent on the parts that already existed. Measured 2026-10-26:
    // 210 steps, a green suite, 13 test files — and no frontend, because nothing
    // spoke while there was still time to build one.
    if (
      opts.requireCompletion !== false &&
      surfaceNudges < MAX_SURFACE_NUDGES &&
      steps > 0 &&
      steps % SURFACE_CHECK_EVERY === 0
    ) {
      const gaps = advisoryNudges ? missingSurfaceGaps({ ask: requestText, cwd: ctx.cwd ?? process.cwd() }) : [];
      if (gaps.length > 0) {
        surfaceNudges += 1;
        harness.push(thread, `deliverables:${surfaceNudges}`, surfaceGapsNudge(gaps));
        deps.onEvent?.(
          `   🧱 Still missing ${gaps.map((g) => g.label).join(', ')} — the ask named ${gaps.length === 1 ? 'it' : 'them'} and the tree does not contain ${gaps.length === 1 ? 'it' : 'them'} (asked mid-build, while there is budget left).`,
        );
        traceEvent({
          kind: 'gate',
          gate: 'deliverables',
          summary: `${gaps.length} surface(s) the ask named are still absent at step ${steps}: ${gaps.map((g) => g.label).join(', ')}`,
        });
      }
    }
    // ── CLOSING WINDOW (wall clock) ────────────────────────────────────────
    //
    // Measured 2026-10-27: the nuvira arm spent its last ten minutes debugging a
    // Playwright runner that would not start and closed with no README, while the
    // Cline arm finished in 48 minutes with 42 paths of OpenAPI. Every budget in this
    // loop counted STEPS, so nothing in it could prefer "close the deliverable" over
    // "keep chasing this tool". When the caller states the real budget, the last
    // stretch is reserved: one directive, no more extensions, two steps to close.
    const remainingMs = turnDurationMs === undefined ? Infinity : turnDurationMs - (clock() - turnStartedAt);
    if (remainingMs <= 0) {
      deps.onEvent?.(
        `   ⏳ The turn's ${Math.round((turnDurationMs ?? 0) / 60_000)}-minute budget is spent — stopping at step ${steps} instead of starting another action.`,
      );
      traceEvent({
        kind: 'gate',
        gate: 'closing-window',
        summary: `the caller's wall-clock budget (${Math.round((turnDurationMs ?? 0) / 60_000)} min) was exhausted after ${steps} steps`,
      });
      break;
    }
    if (!closingWindowAnnounced && remainingMs <= closingWindowMs) {
      closingWindowAnnounced = true;
      const minutesLeft = Math.max(1, Math.round(remainingMs / 60_000));
      // The per-step timer already asked for these when it could; at the wall clock
      // this is the last chance, so the whole remaining set is named in one message.
      const owedDocs = advisoryNudges ? documentationGate({ closing: true }) : null;
      harness.push(
        thread,
        'closing-window',
        [
          `⏳ CLOSING WINDOW — about ${minutesLeft} min left of this turn's budget.`,
          'Stop opening new work. A tool or test that has already failed twice this turn is a KNOWN LIMITATION now, not something to keep debugging: record it in the answer and move on.',
          `${CLOSING_WINDOW_STEPS} steps to close: write the handover the project owes, run the ONE check you can report, and answer with what is delivered and what is not.`,
          ...(owedDocs ? ['', owedDocs.nudge] : []),
        ].join('\n'),
      );
      if (owedDocs) docsNudges += 1;
      stepLimit = Math.min(stepLimit, steps + CLOSING_WINDOW_STEPS);
      deps.onEvent?.(
        `   ⏳ Closing window — about ${minutesLeft} min left; asked once to stop opening work and close the deliverable.`,
      );
      traceEvent({
        kind: 'gate',
        gate: 'closing-window',
        summary: `${minutesLeft} min of the caller's wall-clock budget left at step ${steps} — one close-out directive, further extensions refused, ${CLOSING_WINDOW_STEPS} steps reserved for the handover and the answer`,
      });
    }
    // ── DOCUMENTATION, MID-BUILD ───────────────────────────────────────────
    //
    // The docs duty used to exist ONLY as a closing gate, and a closing gate
    // reports the loss instead of preventing it: measured 2026-10-26, the README
    // nudge landed at step 209 of a 210-step budget and the turn ended with no
    // README, after 210 steps of real work. Documentation is the one deliverable
    // every agent defers to "the end", so the end is exactly when it cannot be
    // written — it is asked for here as soon as a runnable entry point exists, and
    // repeated ONCE two intervals later if the turn is still going and ignored it.
    // Measured 2026-10-27: one ask at step 40 was dropped, the model kept building
    // for another 40 minutes, and the run hit the wall-clock cap with no README at
    // all. The closing gate stays as the safety net; both share `docsNudges`, so the
    // turn still spends at most two messages on it.
    // A MILESTONE, NOT A CADENCE. The step numbers (40/80/…) are a FALLBACK for turns
    // that never get a green check. The primary trigger is the FIRST GREEN CHECK with
    // real work behind it — the moment the project actually works — because that is
    // when documentation is worth writing and when Cline's own run wrote its batch
    // (14:57, mid-run, after the API and pages existed).
    const greenBoundary =
      !docsBoundaryUsed && checkRuns.some((run) => run.ok) && progress.mutatedPaths.length >= 5;
    if (
      opts.requireCompletion !== false &&
      docsNudges < MAX_DOCS_NUDGES &&
      !closingWindowAnnounced &&
      (greenBoundary ||
        (steps > 0 &&
          steps % SURFACE_CHECK_EVERY === 0 &&
          // Spaced, so the duty cannot become a per-interval drumbeat. The gate may run
          // every interval (a NEW fact is worth saying at once — it is a different
          // document), but the same fact is only repeated after two intervals, which is
          // what `allowRepeat` below decides.
          (docsNudges === 0 || steps - lastDocsStep >= SURFACE_CHECK_EVERY)))
    ) {
      const docs = advisoryNudges
        ? documentationGate({
            allowRepeat: docsNudges > 0 && steps - lastDocsStep >= SURFACE_CHECK_EVERY * 2,
          })
        : null;
      // The boundary is spent by being EVALUATED, not by producing an ask: the check
      // walks the tree (up to 60 file reads), and re-running it on every step after the
      // first green check — because the project was already fully documented — would
      // turn a milestone into a per-step filesystem scan.
      if (greenBoundary) docsBoundaryUsed = true;
      if (docs) {
        docsNudges += 1;
        lastDocsStep = steps;
        harness.push(thread, `docs:${docsNudges}`, docs.nudge);
        deps.onEvent?.(
          `   📘 ${docs.event.trim().replace(/^📘\s*/, '')} (asked mid-build, at step ${steps}, while there is budget left).`,
        );
        traceEvent({ kind: 'gate', gate: 'docs', summary: `${docs.summary} — asked at step ${steps}` });
      }
    }
    // P4 — check cancellation BEFORE each step (a pre-aborted signal never
    // spends a model call) and after tool executions (below).
    if (opts.signal?.aborted) {
      return { content: '', followups, toolCalls: toolCallsRun, steps, ...(opts.resume ? { replayedSteps } : {}), bounded: false, cancelled: true, termination: 'cancelled' };
    }
    steps += 1;
    // ── ONE route read per iteration ───────────────────────────────────────
    // The route decides the trimming strategy (above) AND is what the model is
    // told about who is serving it (below). Reading it twice per step would make
    // a caller's getter observable twice as often — a route that changes between
    // the two reads would have the loop compact for one provider and announce
    // another. Read once, use for both.
    const stepRoute = readServedRoute(opts.servedRoute);
    // D1 — the work completed BEFORE this step's response is written. Snapshotted
    // at the TOP of the iteration, where the previous step's tool calls have
    // already run and been counted, so a step's OWN tool calls can never make its
    // own answer look superseded by the next step's closing wrapper. See
    // `workCallsBeforeLastContent`.
    const workAtIterationStart = countProductiveWork(progress);
    // Stamp an answer captured LAST step with the work count as of the END of that
    // step. Doing it here (rather than at capture) is what keeps a step's OWN tool
    // calls from making its own answer look superseded: the essay step that also
    // wrote a file must not be replaced by the closing paragraph written next.
    if (pendingContentStamp) {
      workCallsBeforeLastContent = workAtIterationStart;
      pendingContentStamp = false;
    }
    // Mechanical thread budget: trim BEFORE the model call so a provider
    // request never exceeds the window (deterministic — no LLM summarizer,
    // no latency, no drift; see trimThreadBudget).
    if (budgetChars > 0) {
      // Keep a memory of what the turn DID after its raw outputs are gone:
      // without this, a long turn loses the VERDICTS (did the build pass?) and
      // re-runs work it already finished. Deterministic and bounded — facts, no
      // summarizer, no drift. Built BEFORE the trim because a compaction carries
      // it inside the watermark message (see trimThreadBudget).
      const digest = buildWorkDigest({
        successfulTools: progress.successfulToolCalls,
        mutatedPaths: progress.mutatedPaths,
        executedActions: progress.executedActions,
      });
      // WHICH trimming strategy — decided from the route, every call, because a
      // mid-turn handoff can move the turn to a provider that does not cache.
      // A frozen prefix is only a discount where a prefix cache exists; see
      // `learning/prompt-cache.ts`. Unknown routes keep the old per-call trim.
      const prefixCacheable = stepRoute
        ? cacheStablePrefixPaysOff(stepRoute.providerType, stepRoute.model)
        : false;
      if (!prefixCacheable && stepRoute && !noCacheNoticeShown) {
        noCacheNoticeShown = true;
        deps.onEvent?.(
          `   🧠 ${stepRoute.providerType}${stepRoute.model ? `/${stepRoute.model}` : ''} has no known prompt ` +
            'prefix cache — trimming old messages per call instead of freezing the prefix.',
        );
      }
      const trimmedResult = trimThreadBudget(thread, budgetChars, {
        sealedThrough,
        digest,
        preferTrim: !prefixCacheable,
      });
      if (trimmedResult.trimmed > 0) {
        thread.length = 0;
        thread.push(...trimmedResult.thread);
        sealedThrough = trimmedResult.sealed;
        // A compaction already carries the digest; a plain trim (no safe cut) does
        // not, so the digest still goes in on its own.
        if (!trimmedResult.compacted && digest && isWorkDigestEnabled(context.configManager)) {
          upsertWorkDigest(thread, digest);
        }
        deps.onEvent?.(
          trimmedResult.compacted
            ? `   🧠 compacted ${trimmedResult.trimmed} earlier message(s) into the work digest ` +
              `(${Math.round(budgetChars / 1000)}K-char context budget) — everything before it is now frozen, ` +
              'so the prompt prefix stays cacheable for the rest of the turn.'
            : `   ✂️ ${trimmedResult.trimmed} message(s) trimmed to fit the ${Math.round(budgetChars / 1000)}K-char context budget.`,
        );
      }
    }
    // ── The route feed, re-synced before every call ────────────────────────
    // Placed here rather than at thread construction because THIS is the last
    // point before the call: a failover during step N must be visible at step
    // N+1, and a single up-front line would have the model answering about a
    // model that has since stopped serving it.
    syncRouteFeed(thread, stepRoute, routeFeedState);
    let response: StepResponse;
    try {
      // WS5 (#27) — a resumed run replays this step when its input is unchanged.
      // The key is the step's POSITION and the digest is its whole input, so both
      // have to line up: a plan that shifted by one step replays nothing (the
      // positions hold different inputs), while a re-run of the same plan replays
      // every step whose thread and schema are byte-identical.
      const resumeKey = `model:${steps}`;
      const resumeDigest = opts.resume ? stepDigest(thread, schemas) : '';
      // Diagnostics for a miss: sizes, not the digest (see `stepShape`).
      const resumeShape = opts.resume ? stepShape(thread, schemas) : undefined;
      const replayed = opts.resume?.replay(resumeKey, resumeDigest, resumeShape) ?? null;
      if (replayed) {
        response = replayed;
        replayedSteps += 1;
        deps.onEvent?.(`   ↩️ step ${steps} replayed from the checkpoint — no model call`);
      } else {
        response = await deps.callModel(thread, schemas, opts.onToken, opts.signal, opts.onReasoning);
        // Recorded AFTER the call, and only what the model actually returned: a
        // failed call records nothing, so a resume cannot inherit a failure as an
        // answer.
        if (opts.resume) opts.resume.record(resumeKey, resumeDigest, response, resumeShape);
      }
      // A provider/adapter that resolves with nothing usable (undefined, a
      // missing content field) must not crash the turn — treat it as this
      // step's generation failure so the bounded continuation logic below can
      // resume or return gracefully. Malformed steps used to throw a raw
      // TypeError out of the loop and kill an otherwise-recoverable turn.
      if (!response || typeof response.content !== 'string' || !Array.isArray(response.toolCalls)) {
        throw new Error('model returned a malformed step response (no content/toolCalls)');
      }
      // OBSERVATION CONTRACT — whatever the model said after the loop's last
      // directive IS its answer to it, recorded without parsing: an action taken,
      // a reason it does not apply, or both are all valid judgments. A step that
      // answers with a CALL and no prose is recorded as the call, because acting is
      // an answer and "(silent)" would read as a gate nobody saw. See
      // `harness-directive.ts`.
      harness.answerLast(
        response.content.trim() ||
          (response.toolCalls.length > 0
            ? `called ${response.toolCalls.map((c) => c.name).join(', ')}`
            : ''),
        steps,
      );
      // R2 — the transport the caller reported for THIS step. Recorded before
      // anything can return, so a turn that dies mid-way still attributes the
      // transport that served the steps it did complete.
      if (response.transport) progress.transport = response.transport;
      // A rejected-then-repaired request is a fact about THIS conversation, not a
      // detail of the wire layer: the endpoint refused the first attempt for a
      // missing `reasoning_content` and the helper filled the gap and re-sent it
      // (inference/tools.ts). Say so once per turn — a repair nobody can see is
      // indistinguishable from a request that was always valid, and the count is
      // the cheapest evidence available for whether compaction is dropping
      // reasoning the wire contract requires.
      if (response.repairedReasoningTurns && !reasoningRepairReported) {
        reasoningRepairReported = true;
        deps.onEvent?.(
          `   🩹 the endpoint rejected this request for a missing \`reasoning_content\`; filled ${response.repairedReasoningTurns} tool-call turn(s) and re-sent it.`,
        );
        traceEvent({
          kind: 'gate',
          gate: 'reasoning-replay-repair',
          summary: `${response.repairedReasoningTurns} tool-call turn(s) in the request carried no reasoning_content after a thinking-mode turn had produced some — filled with the "not retained" placeholder and re-sent once`,
        });
      }
      // THINKING MODE, rememberered for the REST OF THE TURN: the wire contract is
      // per conversation, but compaction can remove the messages that carried the
      // evidence, so the fact is kept here and stamped on every later tool-call turn
      // (see the assistant-message construction below).
      if (response.reasoningContent) thinkingModeSeen = true;
    } catch (err) {
      // P4 — an abort (the dashboard Cancel button) is a clean stop, NOT a
      // generation failure: the caller discards the turn. No error text, no
      // fallback — the fetch itself aborted on the caller's signal.
      if (opts.signal?.aborted) {
        return { content: '', followups, toolCalls: toolCallsRun, steps, ...(opts.resume ? { replayedSteps } : {}), bounded: false, cancelled: true, termination: 'cancelled' };
      }
      // Generation failure — surface what we have rather than crash the turn.
      // generationFailed is TRUE only when NOTHING happened yet (no content, no
      // tools ran): the caller may then fall back to the rule decision (E3c
      // no-model path). If a step already ran (tool executed / content emitted)
      // the loop made progress — generationFailed stays false so the caller
      // never re-runs work (e.g. the model already called `build`, and a later
      // step's generation died — the pipeline must NOT run twice).
      const message = err instanceof Error ? err.message : String(err);
      // ── WIRE REPAIR — a request the provider rejected as unparsable ────────
      // The retry used to send the SAME bytes, so the same message poisoned every
      // attempt until the turn died with nothing delivered. Repair the message
      // the provider NAMED (sanitise its content, or stub it) and try again: a bad
      // code unit costs one message, not three quarters of an hour of work.
      if (wireRepairs < 2 && !opts.signal?.aborted) {
        const poisoned = poisonedMessageIndex(message);
        if (poisoned !== null) {
          const repaired = repairPoisonedMessage(thread, poisoned);
          if (repaired.repaired) {
            wireRepairs += 1;
            stepLimit += 1;
            deps.onEvent?.(
              `   🩹 The provider rejected message ${poisoned} as unparsable — ` +
                `${repaired.sanitised ? 'sanitised it in place' : 'replaced its content with a stub'} and retrying ` +
                `(repair ${wireRepairs}/2).`,
            );
            traceEvent({
              kind: 'gate',
              gate: 'wire-repair',
              summary:
                `the provider refused the request because message ${poisoned} was unparsable — ` +
                `${repaired.sanitised ? 'its content was sanitised' : 'its content was stubbed'} and the request retried ` +
                `(repair ${wireRepairs}/2), instead of re-sending the same bytes until the turn died`,
            });
            continue;
          }
        }
      }
      // The RAW provider text is for the log/trace ONLY. It used to be
      // interpolated straight into the delivered answer, which is how a
      // WhatsApp/dashboard sender ended up reading a provider JSON dump
      // ("… API error (429): {\"error\":{\"code\":429, …, quotaValue, …}").
      logger.warn(`   ⚠️ Tool-loop generation failed: ${message}`);
      const madeProgress = lastContent.trim() !== '' || toolCallsRun.length > 0;
      // ── Bounded auto-continuation ────────────────────────────────────────
      // The step died mid-turn. Instead of handing the user a partial answer
      // (or an error line) and making them re-ask, resume the SAME turn while
      // the continuation budget lasts: the model keeps its thread, so every
      // completed tool call and gathered fact is still in context and is never
      // repeated. The failure is recorded on the provider walk already (which
      // is what makes the retry land on a fresh candidate), so a short pause
      // then a re-attempt is the honest, bounded recovery. Once the budget is
      // spent the previous behavior applies unchanged.
      // Resume only when the turn had already DONE something (a tool ran, or an
      // answer was written). This is the "model went away MID-WAY" case: the
      // thread holds real work that must not be thrown away, and one more walk
      // (with the failures just recorded) can land on a different candidate.
      //
      // When NOTHING happened, `callModel` has already walked every candidate —
      // re-walking immediately repeats the same exhausted list for no benefit,
      // so the honest thing is to surface the failure (generationFailed) and let
      // the caller's no-model path act. This also keeps the interactive/gateway
      // turns as fast as before on a hard outage.
      if (continuations < maxContinuations && madeProgress) {
        continuations += 1;
        stepLimit += continuationSteps;
        deps.onEvent?.(
          `   🔄 Model call failed mid-turn — resuming this turn (continuation ${continuations}/${maxContinuations}, budget ${stepLimit} steps).`,
        );
        const delayMs = opts.continuationDelayMs ?? (isTransientGenerationFailure(message) ? CONTINUATION_DELAY_MS : 0);
        await sleep(Math.max(0, delayMs));
        continue;
      }
      // `generationFailed` answers ONE question: was an ANSWER delivered? It
      // used to answer "did anything happen yet", which is `madeProgress`, and
      // the two are not the same: a turn that ran `code_search` and then died
      // has made progress but produced no answer, so `content` below is the
      // failure line — and returning it with `generationFailed: false` shipped
      // that line as a SUCCESS. Caught live on the dashboard surface: the bubble
      // read "The model wrote its own working notes instead of an answer…" while
      // the flag was false, so no retry was offered and nothing was queued, the
      // gateway would have reported the turn as fine, and the line was eligible
      // for the answer cache. `madeProgress` keeps its own meaning where it
      // belongs — deciding whether a no-model turn may be re-run through the
      // rules' pipeline fallback (E3c) — and a turn with NO answer at all is a
      // failure either way, because there is nothing to deliver.
      //
      // The answer memory is consulted second: a step that died while running a
      // NUDGE still leaves the turn with the answer it already produced, and
      // reporting that turn as a failure (with an exhaustion report in place of
      // the answer) is the measured 2026-10-12 defect on this very line — see
      // `lastDeliveredAnswer`.
      const deliveredFromNudge = lastContent.trim() === '' && lastDeliveredAnswer.trim() !== '';
      const delivered = lastContent.trim() || lastDeliveredAnswer.trim();
      if (deliveredFromNudge) {
        // Recorded, never printed: the answer stands on its own, and the fact a
        // follow-up step died is a trace fact, not something to pad the answer
        // with. The turn's honesty flags still mark any unverified work.
        traceEvent({
          kind: 'gate',
          gate: 'nudge-interrupted',
          summary:
            'a bounded nudge step failed after an answer was delivered — delivering the answer, not a failure report',
        });
      }
      return {
        content: delivered || toUserFacingGenerationError(err),
        followups,
        toolCalls: toolCallsRun,
        steps,
        ...(opts.resume ? { replayedSteps } : {}),
        bounded: false,
        continuations,
        ...(modelHandoffs > 0 ? { modelHandoffs } : {}),
        // Nothing to deliver means the provider walk itself gave up — every
        // candidate was tried and none answered. That IS the evidenced shortage.
        termination: delivered === '' ? 'no-capable-candidate' : 'delivered',
        generationFailed: delivered === '',
      };
    }

    // ── Recover tool calls the model wrote as TEXT ─────────────────────────
    // A provider can return a step with NO native tool call whose CONTENT is
    // the raw `{"tool":"suggest_followups",...}` block. Observed live
    // (2026-09-20, auto-routed): the followups printed verbatim as JSON to the
    // user and no menu/chips appeared — the JSON transport parses this shape,
    // the native path did not. Salvage it HERE so every caller (CLI, dashboard
    // console, gateway) recovers the calls, and strip the block from the
    // visible answer either way: a raw `{"tool":…}` block must never be the
    // answer. Idempotent with the JSON transport (which already strips it).
    if (response.toolCalls.length === 0 && TEXTUAL_TOOL_CALL_HINT.test(response.content)) {
      const extracted = extractFallbackToolCalls(response.content);
      if (extracted.text !== response.content) {
        response.content = extracted.text;
        if (extracted.calls.length > 0) {
          response.toolCalls = extracted.calls;
          deps.onEvent?.('   ♻️ recovered tool call(s) the model wrote as text');
        }
      }
    }

    // S1: LONGEST-substantive wins. A trailing wrapper (a short closing
    // paragraph written AFTER the real answer, common when the model repeats
    // suggest_followups) must not clobber the full answer delivered in an
    // earlier step — otherwise the turn ends with the wrapper instead of the
    // essay (the "where is the essay?" bug). Think-only responses are NOT
    // substantive — they are reasoning markers, never candidate answers —
    // so they never enter lastContent (both loop exits prefer the longer
    // of response.content / lastContent; a long <think>…</think> block
    // must not beat the real answer).
    const responseThinkOnly = deps.isThinkOnly
      ? deps.isThinkOnly(response.content)
      : isThinkOnlyResponse(response.content);
    const responseIsSubstantive =
      response.content.trim() !== '' && !responseThinkOnly && !isBareAcknowledgment(response.content);
    const workSinceLastContent = workAtIterationStart > workCallsBeforeLastContent;
    if (responseIsSubstantive && (response.content.length >= lastContent.length || workSinceLastContent)) {
      rememberContent(response.content);
      // Stamp what this answer is an account OF, so the next step can tell an
      // update from a wrapper (see `workCallsBeforeLastContent`). Deferred to the
      // top of the next iteration so it includes THIS step's own work.
      pendingContentStamp = true;
    }
    const { toolCalls } = response;
    // P2 — the model just produced something usable (text, or at least one tool
    // call), so its empty-response streak is over: a later blip starts a NEW
    // streak rather than inheriting one from twenty steps ago.
    if (toolCalls.length > 0 || !responseThinkOnly) {
      emptyRetriesOnCurrentModel = 0;
      // P5 — a usable response ends the blink, so the next streak asks for a
      // FRESH patience plan instead of inheriting spent patience from a step
      // twenty turns of the loop ago.
      emptyPatienceSchedule = undefined;
      emptyPatienceSpent = 0;
    }

    if (toolCalls.length === 0) {
      // No tools → end turn UNLESS the content is think-only (
      // isThinkOnlyResponse: continue instead of ending).
      if (deps.isThinkOnly ? deps.isThinkOnly(response.content) : isThinkOnlyResponse(response.content)) {
        // Feed an empty assistant step so the model continues in-context.
        thread.push({
          role: 'assistant',
          content: response.content,
          // Keep the thinking model's reasoning with the turn it belongs to (and,
          // when compaction has removed every trace of it, say so — see the same
          // rule at the tool-call turn below).
          ...(response.reasoningContent
            ? { reasoningContent: response.reasoningContent }
            : thinkingModeSeen && !thread.some((m) => m.role === 'assistant' && Boolean(m.reasoningContent))
              ? { reasoningContent: REASONING_NOT_RETAINED }
              : {}),
        });
        thinkContinues += 1;
        // AN EMPTY RESPONSE IS A FAILURE, NOT REASONING. `isThinkOnlyResponse('')`
        // returns true, so a provider returning nothing (the loop arm falls over
        // to `local/gpt-oss:120b-cloud`, which reliably returns length 0) was
        // reported as "model reasoning… (continuing)" — the system's own evidence
        // saying the agent was thinking when it was being handed nothing. That
        // is the exact class of defect this work exists to remove, so the two
        // cases are named apart even though they are bounded together.
        const emptyResponse = response.content.trim().length === 0;
        // ── P5 — WAIT OUT A BLINK ON THE PAIR THAT ANSWERED NOTHING ──────────
        //
        // An empty 200 is the one unusable response that never reaches the blip
        // policy: `chat.generateWithTransientRetry` applies the empty-response
        // schedule only when the attempt THROWS, and a provider that answers 200
        // with no content does not throw — it lands here. So the policy has to be
        // reachable from the loop too, or it is inert for exactly the failure it
        // was written for. Both traces that motivated this did precisely that:
        // two empties in a row, the loop's single retry spent, handoff, local last
        // resort, weak answer (trace-1791906998502-txddq4,
        // trace-1791907393457-7seewg).
        //
        // The caller decides how long to stay (see `emptyResponsePatienceMs`); the
        // loop memoizes that answer per streak so a shifting plan cannot extend the
        // wait, sleeps each granted delay, and re-asks the SAME pair. Cancelling
        // mid-wait is honored.
        if (emptyResponse && !opts.signal?.aborted) {
          if (emptyPatienceSchedule === undefined) {
            try {
              emptyPatienceSchedule = deps.emptyResponsePatienceMs?.({
                emptyStreak: emptyRetriesOnCurrentModel + 1,
                handoffs: modelHandoffs,
                deliveredWorkThisTurn: progress.successfulToolCalls.length > 0,
              }) ?? [];
            } catch {
              // A broken patience hook must neither extend nor block a turn.
              emptyPatienceSchedule = [];
            }
          }
          if (emptyPatienceSpent < emptyPatienceSchedule.length) {
            const waitMs = emptyPatienceSchedule[emptyPatienceSpent++];
            emptyRetriesOnCurrentModel += 1;
            thinkContinues = 0;
            // Name the pair generically when the route is unknown — a wrong name
            // would be worse than none (see `servedRoute`).
            let pairLabel = 'the same model';
            try {
              const route = opts.servedRoute?.();
              if (route?.model && !isUnresolvedModel(route.model)) {
                pairLabel = `${route.providerType}/${route.model}`;
              }
            } catch {
              // Unknown route reads generically.
            }
            if (waitMs > 0) {
              deps.onEvent?.(
                `   👀 ${pairLabel} returned nothing — waiting ${Math.round(waitMs / 100) / 10}s ` +
                  `before re-asking it (blip patience ${emptyPatienceSpent}/${emptyPatienceSchedule.length}).`,
              );
              await sleepUnlessAborted(waitMs, opts.signal);
            }
            traceEvent({
              kind: 'decision',
              gate: 'wait',
              summary:
                `the provider returned an empty response — waiting ${waitMs}ms and re-asking the SAME pair ` +
                `(blip patience ${emptyPatienceSpent}/${emptyPatienceSchedule.length}) instead of handing off`,
            });
            continue;
          }
        }
        // ── P2 — MID-TURN MODEL HANDOFF ────────────────────────────────────
        // An empty completion is a PROVIDER failure, not a state of mind, and
        // re-asking the model that just returned nothing is what killed a real
        // run: five consecutive empties from one model, then `bounded: true`
        // with zero tool calls, while healthy models sat configured and unused.
        // So once THIS model has had its single retry, the loop asks the caller
        // for a different candidate. The caller owns the pool (exclusions,
        // credentials, cooldowns) and refuses to hand back the same pair; a
        // `false` means there is genuinely nothing else, and we fall through to
        // the bounded escalation below — unchanged behaviour for a turn with no
        // alternative (and for every caller that supplies no hook at all).
        if (
          emptyResponse &&
          deps.requestModelSwitch &&
          modelHandoffs < MAX_MODEL_HANDOFFS_PER_TURN &&
          emptyRetriesOnCurrentModel >= MAX_SAME_MODEL_EMPTY_RETRIES
        ) {
          let switched = false;
          try {
            switched = (await deps.requestModelSwitch('empty')) === true;
          } catch {
            // A broken switch hook must never kill the turn — fall through to the
            // bounded path exactly as if it had answered `false`.
            switched = false;
          }
          if (switched) {
            modelHandoffs += 1;
            // ── CONTEXT HANDOFF NOTE (Proposal 2, reassessed) ─────────────
            //
            // The CONTEXT already travels: one `thread` is kept across the
            // switch, so the replacement receives the ask, every tool call and
            // every result. What deliberately does NOT travel is the previous
            // model's `reasoningContent` (replaying a stranger's chain-of-
            // thought is either rejected outright or anchors the new model to
            // the failed reading of the task) — that stays dropped.
            //
            // What was missing is the plain STATEMENT of the handoff: a model
            // that starts mid-thread with no note reads the transcript as its
            // own and re-plans from the ask, re-running finished commands and
            // re-reading files whose results are already in front of it. The
            // note names the change, tells it the context is its own, and hands
            // it the facts (files changed, commands with their verdicts) so it
            // continues instead of restarting.
            let servedNow: string | undefined;
            try {
              const route = opts.servedRoute?.();
              if (route?.model && !isUnresolvedModel(route.model)) {
                servedNow = `${route.providerType}/${route.model}`;
              }
            } catch {
              // An unknown route is fine — the note reads generically then.
            }
            upsertHandoffNote(
              thread,
              buildHandoffNote({
                route: servedNow,
                facts: isWorkDigestEnabled(context.configManager)
                  ? buildWorkDigest({
                      successfulTools: progress.successfulToolCalls,
                      mutatedPaths: progress.mutatedPaths,
                      executedActions: progress.executedActions,
                    })
                  : '',
              }),
            );
            deps.onEvent?.(
              '   🤝 handoff note written into the thread — the replacement model starts from the work already done.',
            );
            // ── C5 — RE-FIT THE THREAD TO THE MODEL THAT NOW ANSWERS ──────
            // `budgetChars` was resolved before this loop started, from the pair
            // the turn BEGAN on — and the handoff worth catching is the one to a
            // SMALLER window, which is precisely the case that overflows. The
            // caller knows the session, so it re-resolves; `undefined` keeps the
            // budget (an unknown window must not silently shrink the thread).
            // The trim runs at the TOP of the next iteration, before the call, so
            // a NEW budget is applied to the very next request — and when it is
            // smaller, that trim is what makes the handoff fit.
            const refitted = deps.threadBudgetAfterSwitch?.();
            if (typeof refitted === 'number' && refitted > 0 && refitted !== budgetChars) {
              deps.onEvent?.(
                `   📐 thread budget re-fitted for the handoff model: ` +
                  `${Math.round(budgetChars / 1000)}K → ${Math.round(refitted / 1000)}K chars.`,
              );
              budgetChars = refitted;
            }
            // P3 — the ATTEMPT budget: the empty completion that triggered this
            // handoff, and the first call to the replacement model, are not the
            // user's work — grant the step credit so a run against a couple of
            // dead models cannot exhaust its road before it has done anything.
            handoffAttemptCredit = Math.min(
              MAX_HANDOFF_ATTEMPT_CREDIT,
              handoffAttemptCredit + 2,
            );
            // The streak and the think streak belong to the model that failed.
            emptyRetriesOnCurrentModel = 0;
            thinkContinues = 0;
            // P5 — the replacement pair gets its OWN plan, not the one granted to
            // (and half-spent on) the model that just returned nothing.
            emptyPatienceSchedule = undefined;
            emptyPatienceSpent = 0;
            // ── DROP THE FAILED MODEL'S PRIVATE REASONING ─────────────────
            // Every assistant turn records `reasoningContent`, and the wire
            // layer echoes it back on that assistant message — which is
            // REQUIRED when the SAME model retries (some reasoning models fail
            // the request without their own prior reasoning; see
            // `reasoning-cache.ts`). After a HANDOFF the next model is a
            // DIFFERENT model, and replaying a stranger's chain-of-thought
            // either gets the request rejected by the target API (foreign
            // `reasoning_content` / tool-call ids) or anchors the new model to
            // the reasoning that already failed. Strip it on a pair change; a
            // same-model retry keeps it untouched, which is where the
            // requirement actually comes from.
            // NOTE: `thread` (the loop's own working copy, line ~1398), not
            // `messages` — the assistant turns live here.
            for (const prior of thread) {
              if (prior.role === 'assistant' && prior.reasoningContent) {
                delete prior.reasoningContent;
              }
            }
            deps.onEvent?.(
              `   🔀 That model returned nothing usable — handing the turn to a different model (handoff ${modelHandoffs}/${MAX_MODEL_HANDOFFS_PER_TURN}).`,
            );
            traceEvent({
              kind: 'gate',
              gate: 'handoff',
              summary:
                `the provider returned an empty response twice — the turn handed off to a different model ` +
                `(handoff ${modelHandoffs}/${MAX_MODEL_HANDOFFS_PER_TURN}) instead of re-asking the same one`,
            });
            continue;
          }
        }
        if (emptyResponse) emptyRetriesOnCurrentModel += 1;
        // BOUNDED (see THINK_ONLY_ESCALATION). Continuing on reasoning is right
        // for a `<think>`-then-answer model and catastrophic without a limit:
        // two live eval runs produced 31 reasoning-only steps, one tool call and
        // a 0% score, printing "model reasoning… (continuing)" the whole way.
        if (thinkContinues <= MAX_THINK_CONTINUES) {
          deps.onEvent?.(
            emptyResponse
              ? `   ⚠️ the provider returned an EMPTY response (${thinkContinues}/${MAX_THINK_CONTINUES}) — retrying the step.`
              : `   🧠 model reasoning… (continuing ${thinkContinues}/${MAX_THINK_CONTINUES})`,
          );
          traceEvent({
            kind: 'decision',
            summary: emptyResponse
              ? 'the provider returned an empty response — no answer text and no tool call; the step was retried'
              : 'the model replied with its own reasoning instead of an answer — the step continued',
          });
          continue;
        }
        if (thinkContinues === MAX_THINK_CONTINUES + 1) {
          // One escalation: it has no answer yet, so tell it to act or answer.
          stepLimit += 1;
          deps.onEvent?.(
            emptyResponse
              ? '   ⚠️ The provider keeps returning empty responses — asking for one real step.'
              : '   🧠 Reasoning only, repeatedly — telling the model to act or answer now.',
          );
          traceEvent({
            kind: 'gate',
            gate: 'repeat',
            summary: emptyResponse
              ? `the provider returned an empty response ${thinkContinues} times — one bounded escalation for a real step`
              : `the model produced reasoning-only output ${thinkContinues} times with no tool call and no answer — ` +
                'one bounded escalation to act or answer',
          });
          harness.push(thread, 'think-only', THINK_ONLY_ESCALATION);
          continue;
        }
        // Still spinning after the escalation: END the turn rather than burn the
        // rest of the budget. `bounded` is set so every surface reads this as
        // "stopped before finishing", never as a completed answer — and P3 names
        // WHICH kind of stop this is, because the two demand opposite responses:
        // every model that answered returned nothing (a model shortage, which
        // the caller must report as such) versus one model that kept thinking
        // (a bounded stop that says nothing about the other models).
        bounded = true;
        exitTermination = emptyResponse ? 'no-capable-candidate' : 'reasoning-spin';
        deps.onEvent?.(
          emptyResponse
            ? '   ⚠️ Empty responses kept coming — ending the turn instead of spinning. This is a PROVIDER failure, not the agent thinking.'
            : '   🧠 Reasoning-only output kept repeating — ending the turn instead of spinning.',
        );
        traceEvent({
          kind: 'gate',
          gate: 'repeat',
          summary: emptyResponse
            ? `the provider returned ${thinkContinues} consecutive empty responses — the turn ended; this is a transport failure, not agent stuckness`
            : `reasoning-only output repeated ${thinkContinues} times after an escalation — the turn ended to avoid an unbounded spin`,
        });
        break;
      }
      // ── Dangling-promise nudge (bounded, once) ──────────────────────────
      // The model closed the turn announcing what it is ABOUT to do ("I will
      // begin by scaffolding…", "Let me now create the files") without calling
      // a single tool — nothing ran and, in a chat surface, the turn simply
      // ends. Rather than hand the user a promise as the answer, spend ONE
      // extra step asking for the action. Gated on NOTHING having succeeded
      // this turn (a turn that already did work and narrates a next step is
      // not silently dropped), on tools being available, and on the bounded
      // counter. Any residual promise is reported via `unfulfilledPromise`.
      // The zero-success requirement is the original contract (a turn that did
      // NOTHING and announced an action). The second arm covers the measured
      // 2026-10-09 case this gate could not see: a CHANGE was asked for, only some
      // READS succeeded, and the answer is a plan/promise — so the nudge is spent
      // asking for the work instead of the plan being delivered as the answer.
      // Bounded identically (`intentNudges < 1`) and gated on the ask requiring a
      // change, so a legitimate plan answer is never nudged.
      const promiseCandidate =
        response.content.length >= lastContent.length ? response.content : lastContent;
      if (
        intentNudges < 1 &&
        schemas.length > 0 &&
        (progress.successfulToolCalls.length === 0
          ? detectUnfulfilledIntentPromise(promiseCandidate)
          : requestRequiresWorkspaceChange(lastUserText(opts.messages)) &&
            answeredWithAPlanInsteadOfWork(promiseCandidate))
      ) {
        intentNudges += 1;
        stepLimit += 1;
        deps.onEvent?.('   🔁 Answer announced an action but performed none — asking the model to carry it out.');
        traceEvent({
          kind: 'gate',
          gate: 'promise',
          summary: 'the turn closed on an announced action with nothing performed — one bounded nudge to carry it out',
        });
        // The promise is NOT a candidate answer: drop it from the
        // longest-substantive memory so the post-nudge answer (or result) is
        // what the turn delivers. Safe because the gate only fires when no
        // tool succeeded and the closing line is a promise — a real essay
        // would outrank and suppress the nudge entirely.
        lastContent = '';
        thread.push({ role: 'assistant', content: response.content });
        harness.push(
          thread,
          'promise',
          'You announced an action you were about to take, but no tool was called and nothing was done. ' +
            'Either carry it out now with the tools available, or reply with the actual answer — do not end the turn on a promise.',
        );
        continue;
      }
      // ── G13 — AUTHORIZED-WORK nudge (bounded, once) ──────────────────────
      // The model closed the turn asking PERMISSION for work the user's own
      // request already authorized ("Do you want me to create the full project
      // structure…?"). Over a chat surface that question IS the answer: the
      // turn ends, the user has to reply, and nothing gets built — the manual
      // cadence again. The autonomy policy decides it instead: the ask was the
      // authorization, so tell the model to proceed with its default and report
      // the decision. Deliberately a conjunction of two independent facts
      // (permission-seeking AND an authorized request) so a genuine question
      // about unrequested work — or a question naming an irreversible action —
      // is left exactly where it is for the user to answer.
      if (
        permissionNudges < 1 &&
        authorization.authorized &&
        // …for FILE work. A short authored deliverable ("write a poem", "write an
        // essay") is prose whose TEXT is the answer: it authorizes no file, so
        // there is no file work to permit and nothing to nudge (see
        // `isInlineAuthoredDeliverable`).
        !isInlineAuthoredDeliverable(requestText) &&
        schemas.length > 0 &&
        detectPermissionSeeking(
          response.content.length >= lastContent.length ? response.content : lastContent,
        )
      ) {
        permissionNudges += 1;
        stepLimit += 1;
        deps.onEvent?.('   🤖 Turn ended asking permission for work the request already authorized — telling the model to proceed.');
        traceEvent({
          kind: 'gate',
          gate: 'permission',
          summary: `the turn asked permission for authorized work (${authorization.reason}) — one bounded nudge to proceed`,
        });
        // The question must not become the delivered answer — but neither may the
        // work be deleted along with it. `stripTrailingPermissionSeek` removes
        // ONLY the trailing permission sentences, which is exactly the line:
        //   - a step that IS the question ("Do you want me to create the files?")
        //     strips to '' and stays a non-answer, as before;
        //   - a step that DELIVERED something (a poem, a plan, a report, a design)
        //     keeps every byte of it and loses only the offer that followed.
        // The older rule cleared the WHOLE step whenever no tool had succeeded,
        // which threw away a finished answer the user had already been charged
        // for: a WhatsApp poem request (trace-1792061511046-jdhgyy) returned the
        // complete poem and closed with "Want me to make it shorter…?", the gate
        // read the step as "the permission question", and the sender received a
        // dangling fragment and no poem at all.
        const judged = response.content.length >= lastContent.length ? response.content : lastContent;
        const kept = stripTrailingPermissionSeek(judged);
        if (kept) rememberContent(kept);
        else lastContent = '';
        thread.push({ role: 'assistant', content: response.content });
        harness.push(thread, 'permission', AUTHORIZED_WORK_NUDGE);
        continue;
      }
      // ── Stage 2 — REPETITION nudge (bounded, once) ───────────────────────
      // The permission nudge above fires only when the request AUTHORIZED the
      // work, and it asks the model to PROCEED. A repeated question is a defect
      // on its own terms: the user already answered it, whatever their latest
      // message authorized — which is precisely the case a live turn fell
      // through, because the complaint about repeated questions was itself the
      // message that failed to authorize. This nudge therefore does NOT depend
      // on authorization, and deliberately does NOT say "proceed" (unsafe when
      // the answer was no) — it says the answer is in hand, so act on it or say
      // what blocks you. The evidence is the RUN TRACE, not the current text.
      if (
        repeatNudges < 1 &&
        schemas.length > 0 &&
        detectPermissionSeeking(
          response.content.length >= lastContent.length ? response.content : lastContent,
        ) &&
        runTrace.priorAskMatches(
          response.content.length >= lastContent.length ? response.content : lastContent,
        ).length > 0
      ) {
        const closing = response.content.length >= lastContent.length ? response.content : lastContent;
        repeatNudges += 1;
        stepLimit += 1;
        deps.onEvent?.('   🔁 The turn asked a question the user has already answered — telling the model to act on the answer.');
        traceEvent({
          kind: 'gate',
          gate: 'repeat',
          summary: 'the turn repeated a question already asked and answered in this conversation — one bounded nudge to use the answer',
        });
        if (progress.successfulToolCalls.length === 0) {
          lastContent = '';
        } else {
          rememberContent(stripTrailingPermissionSeek(closing));
        }
        thread.push({ role: 'assistant', content: response.content });
        harness.push(thread, 'repeat', repeatNudge(closing, runTrace.priorAnswer(closing)));
        continue;
      }
      // ── ZERO-ACTION gate (bounded, once) ────────────────────────────────
      // The request DIRECTED work on the workspace and the turn is ending
      // without having run a single tool: not a dropped promise, not a
      // permission question, not an authored file — just prose where the work
      // should be. The gates above all key on a positive shape in the reply and
      // so miss a plain non-answer; this one keys on the REQUEST and the
      // ABSENCE of action, which is exactly the shape that ended a fully
      // specified four-part coding ask with nothing done. Bounded once; the
      // residual is reported by `noActionTaken` below, whether or not the nudge
      // is enabled.
      if (
        actionNudges < 1 &&
        zeroActionGateApplies(opts, progress, schemas.length, requestText, authorization.authorized)
      ) {
        actionNudges += 1;
        stepLimit += 1;
        deps.onEvent?.('   🛠️ The request asked for work and nothing was done — telling the model to do it now.');
        traceEvent({
          kind: 'gate',
          gate: 'action',
          summary: 'the request directed work on the workspace and the turn performed none — one bounded nudge to carry it out',
        });
        // The non-answer must not become the delivered answer either way.
        lastContent = '';
        thread.push({ role: 'assistant', content: response.content });
        harness.push(thread, 'action', zeroActionNudge(currentAsk(opts)));
        continue;
      }
      // S1 (both exits): the MOST SUBSTANTIVE content seen wins here too —
      // a short closing step ("Sent it to her! ✅") with no tool calls must
      // not clobber the deliverable (poem/essay) the model composed in an
      // earlier step alongside a real tool call. Same rule as the
      // suggest_followups exit below.
      //
      // G13b — DELIVERABLE GATE (no-tools path, the one a story ask actually
      // takes). Same rule and same bounded budget as the concluding path BELOW,
      // placed before it so the first ending that can satisfy the request gets
      // the nudge, never both.
      if (deliverableNudges < 1 && deliverableGateApplies(opts, response.content.length >= lastContent.length ? response.content : lastContent, progress, schemas.length, requestText)) {
        deliverableNudges += 1;
        stepLimit += 1;
        deps.onEvent?.('   📄 The request asked for a file and none was written — asking the model to produce it.');
        traceEvent({
          kind: 'gate',
          gate: 'deliverable',
          summary: authorization.requestedPath
            ? `an authored deliverable was requested at ${authorization.requestedPath} and no file was written — one bounded nudge to produce it`
            : 'an authored deliverable was requested and no file was written — one bounded nudge to produce it',
        });
        thread.push({ role: 'assistant', content: response.content });
        harness.push(thread, 'deliverable', deliverableNudge(authorization.requestedPath));
        continue;
      }
      // REQUIRED-ARTIFACTS GATE (no-tools path). The request NAMED files or test
      // classes; the turn built something and they do not exist. This is the exact
      // gap measured on 2026-10-25: an agent finished a build task in 14 of its 30
      // minutes, green build and green tests, with no todo.md, progress.md,
      // issues.md, changelog.md, README or e2e tests — because nothing in the loop
      // compared the RESULT against the ask's own list. Bounded to two nudges.
      if (artifactNudges < 2) {
        const missing = artifactsGateApplies({
          request: requestText,
          cwd: ctx.cwd ?? process.cwd(),
          didWork: progress.mutatedPaths.length > 0,
        });
        if (missing) {
          artifactNudges += 1;
          stepLimit += 1;
          deps.onEvent?.(`   📋 The request named ${missing.length} artifact(s) that do not exist yet — asking the model to produce them.`);
          traceEvent({
            kind: 'gate',
            gate: 'required-artifacts',
            summary: `the request named artifact(s) that are missing from the workspace: ${missing
              .map((m) => m.describe)
              .join('; ')}`,
          });
          thread.push({ role: 'assistant', content: response.content });
          // Distinct keys: the harness sink delivers ONE directive per gate, so a
          // second nudge under the same key would be dropped while the loop still
          // spent a step waiting for a reply to a message the model never saw.
          if (advisoryNudges) {
            harness.push(thread, artifactNudges === 1 ? 'artifacts' : 'artifacts-again', artifactsNudge(missing));
          } else {
            // Still observed, never enforced: the gap is kept for the closing report.
            advisoryGaps.push(...missing.map((m) => `${m.describe ?? m.id ?? 'artifact'} was not found`));
          }
          continue;
        }
      }
      //
      // AUTO-VERIFY — run the project's OWN check instead of only asking.
      //
      // A nudge is advice, and a model that ignores it leaves the turn with no
      // observed result (measured: the same audit produced a report with 19 bugs
      // and no test verdict, while the competing agent RAN the suite and could
      // quote `125 failed / 476 passed`). This executes the check the project
      // itself declares — chosen exactly as `verificationNudgeFor` chooses it —
      // records the outcome in the turn's ledger, and hands the model the verdict
      // in the same thread. Bounded to two runs (the first, plus one after it
      // reacts), and skipped for a prose-only deliverable.
      if (
        opts.autoVerify === true &&
        opts.requireVerification !== false &&
        autoVerifies < 2 &&
        schemas.length > 0 &&
        assessEditActivity(
          progress.successfulToolCalls,
          progress.verificationEvidence,
          progress.mutatedPaths,
          ctx.cwd ?? process.cwd(),
        ).needsVerification
      ) {
        const check = autoVerifyCheck(ctx.cwd ?? process.cwd(), progress.mutatedPaths);
        if (check) {
          autoVerifies += 1;
          stepLimit += 1;
          deps.onEvent?.(
            `   🧪 Auto-verify — running the project's own check: ${check.command} (${check.label})`,
          );
          let output: string;
          try {
            output = await deps.executeTool('run_terminal', { command: check.command }, ctx);
          } catch (err) {
            output = `Error: ${(err as Error).message}`;
          }
          // The loop's established success convention: a failed run_terminal (or a
          // cancellation) is prefixed `Error:` (see run-terminal's exit handler),
          // so this reads the same evidence the rest of the loop reads.
          const ok = !output.startsWith('Error:');
          recordExecutedAction(executedActions, 'run_terminal', { command: check.command }, ok);
          checkRuns.push({
            command: check.command,
            tool: 'run_terminal',
            ok,
            afterWrites: progress.mutatedPaths.length,
            kinds: classifyCheck('run_terminal', check.command).kinds,
            // The failure count is what tells a regression from a repo that was
            // already red when the turn arrived (see check-ledger preExisting).
            ...(ok ? {} : { failing: parseFailingCount(output) }),
          });
          if (ok) {
            progress.verificationEvidence.push({
              tool: 'run_terminal',
              args: { command: check.command },
              result: output,
            });
          }
          traceEvent({
            kind: 'gate',
            gate: 'verification',
            summary:
              `auto-verify ran the project's own check \`${check.command}\` (${check.label}) — ` +
              `${ok ? 'it passed' : 'it FAILED'}`,
          });
          thread.push({ role: 'assistant', content: response.content });
          harness.push(thread, 'verification', autoVerifyReport(check, output, ok));
          continue;
        }
      }
      //
      // G1 — VERIFICATION GATE: before the turn can end, if it MUTATED the
      // workspace and ran nothing that observed the result, spend ONE bounded
      // nudge asking for the check. The gate is deliberately a nudge, not a
      // hard block: a task with no runnable check (a prose answer, a config
      // edit outside the workspace) must still be deliverable — the residual
      // `unverifiedEdit` flag carries the honesty for that case.
      //
      // ONE LEDGER, ONE VERDICT — the same guard as the concluding exit below.
      // `judgeCompletion` reads this exact evidence (the check ledger) and has
      // already settled it if it accepted the claim; re-asking here is the two
      // readers disagreeing about one fact, which is what cost five steps on
      // DEV-FEATURE. It also punishes an honest `verified:false` ending.
      if (
        !finishAccepted &&
        verificationNudges < 1 &&
        opts.requireVerification !== false &&
        schemas.length > 0 &&
        assessEditActivity(
          progress.successfulToolCalls,
          progress.verificationEvidence,
          progress.mutatedPaths,
          ctx.cwd ?? process.cwd(),
        ).needsVerification
      ) {
        verificationNudges += 1;
        stepLimit += 1;
        deps.onEvent?.('   🔎 Files were changed but nothing verified them — asking the model to run a check.');
        traceEvent({
          kind: 'gate',
          gate: 'verification',
          summary: 'the turn mutated the workspace and nothing observed the result — one bounded nudge to verify',
        });
        thread.push({ role: 'assistant', content: response.content });
        // Stage 3 — name THIS project's strongest check instead of describing a
        // preference order. A live turn reached for `node -c` because the nudge
        // left the choice to the model; `verificationNudgeFor` reads the
        // workspace and asks for the real command, so there is nothing to guess.
        harness.push(thread, 'verification', verificationNudgeFor(ctx.cwd ?? process.cwd(), progress.mutatedPaths));
        continue;
      }
      // SELF-REVIEW (no-tools exit) — a substantial, already-verified turn is
      // ending; spend ONE bounded pass to check the result against the ask.
      const review = selfReviewCorrection();
      if (review) {
        selfReviewNudges += 1;
        stepLimit += 1;
        deps.onEvent?.('   🧭 Substantial turn ending — asking the model to review the result against the original ask.');
        traceEvent({
          kind: 'gate',
          gate: 'self-review',
          summary: 'a substantial turn that changed files reached its end — one bounded nudge to check the result against the original ask',
        });
        thread.push({ role: 'assistant', content: response.content });
        harness.push(thread, 'self-review', review);
        continue;
      }
      // PLAN CLOSE-OUT gate (no-tools exit) — same bounded pass as the concluding
      // exit, for a model that marks a step done and then answers in prose with
      // the rest of its plan still open. Fires ONLY when this turn engaged the
      // plan; a turn that merely carried one is left alone (the report labels it
      // carried, and the plan context is re-shown next turn).
      if (planCloseoutNudges < 1 && opts.requirePlan !== false && (planTodoCreates > 0 || planTodoUpdates > 0)) {
        const planSnapshot = opts.context?.planStore?.snapshot?.() ?? null;
        if (planSnapshot && planSnapshot.steps.some((s) => s.status !== 'done')) {
          planCloseoutNudges += 1;
          stepLimit += 1;
          deps.onEvent?.('   📋 The plan this turn opened still has unsettled steps — asking the model to close them out.');
          traceEvent({
            kind: 'gate',
            gate: 'plan-closeout',
            summary:
              'the turn declared or advanced a plan and is ending with steps still open — one bounded nudge to settle them',
          });
          thread.push({ role: 'assistant', content: response.content });
          harness.push(thread, 'plan-closeout', planCloseoutNudge(planSnapshot));
          continue;
        }
      }
      // COMPLETION / DOCS — the two bounded gates that ask whether the ASK is
      // satisfied, not whether the work was observed (the gates above own that).
      // Spent LAST, so every earlier gate settles its own question first.
      const closing = closingGates();
      if (closing) {
        stepLimit += 1;
        deps.onEvent?.(closing.event);
        traceEvent({ kind: 'gate', gate: closing.gate, summary: closing.summary });
        thread.push({ role: 'assistant', content: response.content });
        harness.push(thread, closing.gate, closing.nudge);
        continue;
      }
      return {
        content: response.content.length >= lastContent.length ? response.content : lastContent,
        followups,
        toolCalls: toolCallsRun,
        steps,
        ...(opts.resume ? { replayedSteps } : {}),
        bounded: false,
        continuations,
        ...(modelHandoffs > 0 ? { modelHandoffs } : {}),
        ...observationsField(),
        termination: 'delivered',
      };
    }

    // ── Execute tool calls (results fed back, next step) ──────────────
    thread.push({
      role: 'assistant',
      content: response.content,
      // `providerMeta` rides along verbatim: it is provider-owned data (Gemini's
      // thoughtSignature) that the adapter must send back on the next turn.
      // Rebuilding the call from id/name/arguments alone silently broke every
      // multi-step provider-tool-calling conversation.
      toolCalls: toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
        ...(tc.providerMeta ? { providerMeta: tc.providerMeta } : {}),
      })),
      // Thinking-mode reasoning is echoed back with the assistant turn that
      // carried these calls — DeepSeek v4 rejects the next request without it.
      //
      // MEASURED 2026-10-26 (`deepseek-flash`, live): the per-step rule is not
      // enough on a LONG turn. The wire layer fills a missing `reasoning_content`
      // only when SOME assistant turn in the current thread still carries one
      // (`inference/thinking-replay.ts`), and the thread budget trims old turns to
      // fit the context window. Once compaction had dropped the earlier reasoned
      // steps, nothing left in the thread signalled "thinking conversation" — four
      // identical `400 The reasoning_content in the thinking mode must be passed
      // back` rejections, one per remaining continuation.
      //
      // So the stamp is used ONLY once the evidence is gone: a turn that returns no
      // reasoning, in a turn that has seen some, in a thread that no longer carries
      // any. The transcript otherwise stays exactly what the model returned (which
      // is what `thinking-replay-invariant.test.ts` pins), and the one thing added
      // is a statement of fact — the reasoning for that call was not retained.
      ...(() => {
        if (response.reasoningContent) return { reasoningContent: response.reasoningContent };
        if (!thinkingModeSeen) return {};
        const threadStillHasReasoning = thread.some(
          (m) => m.role === 'assistant' && Boolean(m.reasoningContent),
        );
        return threadStillHasReasoning ? {} : { reasoningContent: REASONING_NOT_RETAINED };
      })(),
    });

    let endedAfterConcluding = false;

    // ── Provider-protocol safety: nudges decided while PLANNING must queue ──
    // An assistant message that carries `tool_calls` MUST be followed
    // immediately by a `tool` result for EVERY call id, before any other role.
    // A strict OpenAI-compatible API (DeepSeek native) rejects the NEXT request
    // otherwise: "An assistant message with 'tool_calls' must be followed by
    // tool messages responding to each 'tool_call_id'." The pre-flight and plan
    // gates decide during planning — before the results exist — so they push
    // their nudge into this queue and it is flushed after the results, keeping
    // the assistant→tool group intact. (Without this, a pinned/strict run died
    // on the third model call and looked like a provider fault.)
    // Planning-time directives, flushed as harness directives once the step's
    // tool-call group is complete. Kept as {gate, content} so the same channel
    // (and the same per-turn dedupe) covers them.
    const deferredUserNudges: Array<{ gate: string; content: string }> = [];

    // PLAN AUTO-ADVANCE — what THIS step's successful calls can stand behind, so
    // the checklist can advance without spending a model round-trip on it (see
    // planStepsClosedByEvidence).
    const stepWritten: Array<{ tool: string; path: string }> = [];
    const stepChecks: Array<{ tool: string; command?: string }> = [];
    // Turn-level check ledger: plan auto-advance judges the step against every
    // check that succeeded this turn, so a step listing four checks is closed
    // when all four ran — even across separate steps.
    const turnChecks: Array<{ tool: string; command?: string }> = [];

    // ── Phase 1 — decide, in order (deterministic) ─────────────────────────
    // Guards count calls that came BEFORE this one. Pushing the name first made
    // `prior >= 1` true on a tool's FIRST invocation, so plan_todo was refused
    // on EVERY call — the model then retried it and burned the step budget,
    // which is the very loop the guard was written to prevent. Telemetry still
    // records every attempted call, as before.
    type PlannedCall = { call: (typeof toolCalls)[number]; refuse?: string };
    const plans: PlannedCall[] = toolCalls.map((call) => {
      const tool = getTool(call.name);
      const priorSameTool = toolCallsRun.filter((t) => t === call.name).length;
      toolCallsRun.push(call.name);
      // S5 — PLANNER LOOP GUARD, now split by ACTION.
      //
      // The guard exists because of a real failure: the model called plan_todo
      // six times in one turn (trace-1788059239352-k7zl03 — 15.6K tokens,
      // 2m25s, FAILED) instead of doing the work. But `create` and `update` are
      // the SAME tool, and the original `priorSameTool >= 1` check refused BOTH
      // — so a plan could be declared once and then never advanced, and the
      // checklist the user watches went stale the moment the first step closed.
      // Only repeated CREATES are the loop; updates ARE the tracking. Anything
      // that is not an explicit update (absent/malformed action) is counted as
      // a create, so the original protection is unchanged for the loop case.
      if (call.name === 'plan_todo') {
        const action = ((): string | undefined => {
          try {
            const raw = call.arguments;
            const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return obj && typeof obj === 'object'
              ? String((obj as { action?: unknown }).action ?? '')
              : undefined;
          } catch {
            return undefined;
          }
        })();
        const isUpdate = action === 'update';
        if (!isUpdate && planTodoCreates >= 1) {
          return {
            call,
            refuse:
              'Error: a plan already exists for this turn — do NOT declare it again. Advance it instead: call plan_todo with action "update", the step id and its status, then keep doing the work.',
          };
        }
        if (isUpdate && planTodoUpdates >= PLAN_TODO_UPDATE_CAP) {
          return {
            call,
            refuse: `Error: plan_todo has been updated ${PLAN_TODO_UPDATE_CAP} times this turn — stop updating the plan and finish the remaining work.`,
          };
        }
        if (isUpdate) planTodoUpdates += 1;
        else planTodoCreates += 1;
      }
      if (tool?.category === 'pipeline' && priorSameTool >= 1) {
        // The guard this replaces tested the literal name `pipeline`, which is
        // NOT a registered tool — the dispatch tools are build / resume /
        // repair / document / website / analyze / test / publish — so it could
        // never fire and two identical pipeline runs could start in one turn
        // (pipeline-tool.ts has no in-flight guard of its own). Match the real
        // category, and only when the SAME dispatch tool is repeated.
        return {
          call,
          refuse: `Error: ${call.name} was already dispatched this turn — the pipeline is running. Do not call it again.`,
        };
      }
      if (!tool) {
        // Unknown tool — the error is fed back so the model retries with a
        // known tool (hadToolCallError handling).
        return { call, refuse: `Error: unknown tool "${call.name}". Available tools: ${schemas.map((s) => s.name).join(', ')}.` };
      }
      if (tiered && !schemaNames.has(call.name)) {
        // Tiered exposure gate: the tool is REGISTERED but its toolset was
        // never loaded this turn — do NOT execute it silently. Give the model
        // the exact load syntax so it can activate the toolset and retry.
        const ownerToolset = toolsetForTool(call.name);
        return {
          call,
          refuse:
            `Error: tool "${call.name}" exists but its "${ownerToolset?.name ?? 'domain'}" toolset is not loaded this turn. ` +
            `Call tool_search with {"action":"load","toolset":"${ownerToolset?.name ?? ''}"} first — its tools become callable immediately.`,
        };
      }
      if (
        call.argumentsError &&
        // 'unparseable' is unambiguous: argument bytes ARRIVED and could not be
        // used, which is the shape of a truncation. 'empty' is only a defect
        // when the tool actually REQUIRES an argument — a schema with no required
        // field is legitimately callable with none, and the Gemini wire omits an
        // empty `args` object, so a blanket refusal there would be a FALSE refusal
        // of a real no-argument call (git, plan_todo). Item 6.
        (call.argumentsError === 'unparseable' || toolRequiresArguments(call.name))
      ) {
        // F1 — the call was never made: the argument payload did not arrive.
        // Refusing here is the whole point: executing it as `{}` reported a tool
        // call that "ran" with no input, hid the real cause (an output-budget
        // truncation) from the model, and burned 59 round trips in one turn.
        malformedToolCalls += 1;
        return {
          call,
          refuse: malformedToolCallRefusal(
            { name: call.name, argumentsError: call.argumentsError },
            { finishReason: response.finishReason, attempt: malformedToolCalls },
          ),
        };
      }
      if (!isToolEnabled(call.name, context.configManager)) {
        // I1 execution gate: a disabled tool is rejected at runtime even if
        // the model hallucinated its name — the toggle is never cosmetic.
        return { call, refuse: `Error: tool "${call.name}" is disabled — its toolset is turned off. Enable it with \`nuvira tools toolsets\`.` };
      }
      // WASTE GUARD — a read this turn already answered, on a workspace that has
      // not changed since, cannot return anything new (see answeredReads).
      const signature = memoizableReadSignature(call.name, call.arguments);
      if (signature !== null) {
        const ranAtMutations = answeredReads.get(signature);
        if (ranAtMutations !== undefined && ranAtMutations === progress.mutatedPaths.length) {
          repeatsAvoided += 1;
          traceEvent({
            kind: 'refusal',
            gate: 'repeat-read',
            tool: call.name,
            summary:
              `${call.name} repeated on an UNCHANGED workspace — refused instead of paying for the same result twice ` +
              `(${repeatsAvoided} repeat read(s) avoided this turn)`,
          });
          return { call, refuse: repeatReadRefusal(call.name) };
        }
      }
      return { call };
    });

    // ── Phase 2 — execute (read-only runs fan out; everything else serial) ──
    /** Wall-clock per call id, so the G18 event can carry a real duration
     *  without re-timing (the emit below is the only place that knows it). */
    const toolDurations = new Map<string, number>();
    const runOne = async (plan: PlannedCall): Promise<string> => {
      const { call } = plan;
      if (plan.refuse !== undefined) return plan.refuse;
      if (call.name === 'suggest_followups') {
        // The LAST suggest_followups call wins (a model that repeats it after
        // already answering must not accumulate 15 stale suggestions).
        followups.length = 0;
      }
      // I2: emit `tool:started` (before execution) + `tool:called` (after)
      // on the observability bus — drives the dashboard's
      // step cards (P0.6: the GUI renders each call as a live card —
      // running → ok/error with duration + collapsible result). Timing is
      // wall-clock; `ok` mirrors the tool-result convention (Error: prefix).
      const startedAt = Date.now();

      // WS4 (#26) — the `before` hooks, and the ONE place an operator's veto can
      // stop a call. It happens before `tool:started` is announced and before a
      // span is created, so a vetoed call leaves no evidence of having run — and
      // it is reported as a `called` call with an `Error:` result, so every
      // surface's tool lifecycle shows the attempt and its outcome rather than an
      // unexplained gap.
      const beforeHooks = await runBeforeToolHooks({
        tool: call.name,
        args: call.arguments,
        callId: call.id,
        ...(opts.surface ? { surface: opts.surface } : {}),
        ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
        ...(ctx.configManager ? { configManager: ctx.configManager } : {}),
      });
      for (const problem of beforeHooks.problems) {
        // A hook that failed to run is REPORTED rather than swallowed: the seam
        // fails open, so without this a broken policy looks exactly like one that
        // allowed everything.
        traceEvent({ kind: 'gate', gate: 'tool-hook', tool: call.name, ok: false, summary: problem });
      }
      if (beforeHooks.denied) {
        const refusal = toolHookRefusalText(beforeHooks);
        traceEvent({
          kind: 'gate',
          gate: 'tool-hook',
          tool: call.name,
          ok: false,
          summary:
            `${beforeHooks.by ?? 'a tool hook'} refused ${call.name}` +
            (beforeHooks.reason ? `: ${beforeHooks.reason}` : ''),
        });
        deps.onEvent?.(`   ⛔ ${call.name} — refused by a tool hook`);
        ctx.emit?.('tool:called', {
          id: call.id,
          tool: call.name,
          ok: false,
          result: refusal,
          durationMs: Date.now() - startedAt,
        });
        return refusal;
      }

      /**
       * Tell the `after` / `failed` hooks what happened to this call.
       *
       * Observe-only by construction: the outcome has already been decided and
       * reported by the time this runs, so a hook here cannot rewrite history —
       * the phase it is named for is the fact it receives.
       */
      const reportToolOutcome = async (outcome: {
        ok: boolean;
        result?: string;
        error?: string;
      }): Promise<void> => {
        const report = await runToolOutcomeHooks({
          tool: call.name,
          args: call.arguments,
          callId: call.id,
          ...(opts.surface ? { surface: opts.surface } : {}),
          ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
          ...(ctx.configManager ? { configManager: ctx.configManager } : {}),
          durationMs: Date.now() - startedAt,
          ...outcome,
        });
        for (const problem of report.problems) {
          traceEvent({ kind: 'gate', gate: 'tool-hook', tool: call.name, ok: false, summary: problem });
        }
      };

      ctx.emit?.('tool:started', {
        id: call.id,
        tool: call.name,
        args: call.arguments,
      });
      // WS3 (#25) — the call as a child span of the turn. Created where the call
      // actually runs (not where it is announced), so a call that was REFUSED by
      // a gate above never gets a span claiming it happened.
      const toolSpan =
        opts.otel?.child(`${TOOL_SPAN_PREFIX}${call.name}`, { 'nuvira.tool': call.name }) ?? null;
      try {
        deps.onEvent?.(`   ⚙ ${call.name}(${summarizeArgs(call.arguments)})`);
        // The span is ACTIVE for the whole execution: that is what lets a tool
        // which spawns a subagent propagate the trace instead of starting a
        // second, unrelated one in the child.
        let resultText = await withSpanActive(toolSpan, async () => {
          // WS6 (#28) — a DECLARED fault, injected at the one place this loop runs
          // a tool, so every in-process surface (CLI chat, dashboard, gateway,
          // execute) is affected by the same declaration and none of them needs to
          // know the seam exists. The result is an `Error:` string rather than a
          // throw, which is exactly what a tool that really failed returns — so the
          // call is reported as FAILED, the `failed` hook fires, and the model is
          // handed the fault's own words. With no declaration this is a null check.
          const injected = faultAt('tool', call.name);
          if (injected) return `Error: ${injected.message}`;
          // The undo point is taken HERE: after every gate above has approved the
          // call and immediately before it can touch a file.
          ensureWorkspaceCheckpoint(call.name);
          return deps.executeTool(call.name, call.arguments, ctx);
        });
        // I3: a tool that returns {artifact, result} gets its deliverable
        // recorded on the session and only `result`
        // is fed back to the model — the JSON payload is runtime metadata.
        resultText = appendToolArtifact(resultText, ctx.artifacts);
        // The SAME outcome convention the loop uses everywhere else (`Error:`
        // prefix), so the span cannot report a success the result did not have.
        const toolOk = !resultText.startsWith('Error:');
        // Record what this call REALLY did, for evidence provenance. A call the
        // loop REFUSED never performed its command/path, so it is not evidence
        // that a claim's citation is real; an executed-but-failed call IS (a
        // failing command is real evidence about a failure).
        if (classifyToolRefusal(resultText) === null) {
          recordExecutedAction(executedActions, call.name, call.arguments, toolOk);
        }
        ctx.emit?.('tool:called', {
          id: call.id,
          tool: call.name,
          ok: toolOk,
          result: resultText,
          durationMs: Date.now() - startedAt,
        });
        toolSpan?.attr('nuvira.ok', toolOk);
        toolSpan?.end({ ok: toolOk });
        await reportToolOutcome({ ok: toolOk, result: resultText });
        if (call.name === 'suggest_followups') endedAfterConcluding = true;
        return resultText;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.emit?.('tool:called', {
          id: call.id,
          tool: call.name,
          ok: false,
          error: message,
          durationMs: Date.now() - startedAt,
        });
        toolSpan?.end({ ok: false, message });
        await reportToolOutcome({ ok: false, error: message });
        return `Error: ${message}`;
      } finally {
        toolDurations.set(call.id, Date.now() - startedAt);
        // A safety net, not a second report: `end()` is idempotent, so a call
        // that already ended its span is untouched, and one that reached here
        // without reporting says so rather than defaulting to success.
        toolSpan?.end({ ok: false, message: 'tool outcome was never reported' });
      }
    };

    // ── PROJECT PREREQUISITE PRE-FLIGHT (D2.2) ──────────────────────────
    // Before the FIRST build of the turn, check the project's markers so a
    // missing prerequisite (build.rs, a Cargo feature, an icon) is handed over
    // BEFORE a failed build — not after ten identical retries. Best-effort and
    // bounded: once per turn, only when a build is actually planned.
    if (!prerequisitesPreflighted) {
      const buildPlan = plans.find((p) => {
        if (p.refuse !== undefined) return false;
        if (p.call.name !== 'run_terminal' && p.call.name !== 'terminal') return false;
        try {
          const raw = p.call.arguments;
          const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const cmd = String((obj as { command?: unknown })?.command ?? '');
          return isBuildCommand(cmd);
        } catch {
          return false;
        }
      });
      if (buildPlan) {
        prerequisitesPreflighted = true;
        try {
          const findings = checkProjectPrerequisites(
            createNodePrereqFs(opts.context?.cwd || process.cwd()),
          );
          if (findings.length > 0) {
            deferredUserNudges.push({ gate: 'prerequisite', content: formatPreflightFindings(findings) });
            deps.onEvent?.(
              `   🧱 pre-flight: ${findings.length} missing project prerequisite(s) — handed the exact fix before building.`,
            );
            traceEvent({
              kind: 'gate',
              gate: 'prerequisite',
              summary:
                `pre-flight found ${findings.length} missing project prerequisite(s) before the build: ` +
                findings.map((f) => f.id).join(', '),
            });
          }
        } catch {
          // A pre-flight must never break the turn.
        }
      }
    }

    // ── PLAN GATE (E2) ──────────────────────────────────────────────────
    // A workspace-directing turn about to MUTATE without having declared a plan
    // is stopped ONCE: its first FILE mutation is refused and the model is told
    // to plan first (`plan_todo`). Terminal commands still trigger the nudge but
    // are not blocked (see PLAN_GATED_TOOL_NAMES) — a build or a test is a step
    // a plan is meant to reach, not a change to gate. Bounded by design: the
    // SECOND attempt runs even without a plan (see `planBlocked`), so this guides
    // the model into the plan → track → verify contract instead of walling the
    // turn off. A batch that DECLARES a plan itself is never blocked (the model
    // is already doing the right thing), and `requirePlan:false` leaves the gate
    // byte-identical to not existing.
    const declaresPlan = !opts.context?.planStore?.snapshot?.() && plans.some((p) => {
      if (p.call.name !== 'plan_todo') return false;
      try {
        const raw = p.call.arguments;
        const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const action = obj && typeof obj === 'object' ? String((obj as { action?: unknown }).action ?? '') : '';
        return action !== 'update';
      } catch {
        // Malformed args still count as a create attempt — the plan_todo guard
        // above already handles a repeated create, and a first one is honored.
        return true;
      }
    });
    if (
      !planNudged &&
      !declaresPlan &&
      opts.requirePlan !== false &&
      schemas.length > 0 &&
      !opts.context?.planStore?.snapshot?.() &&
      plans.some((p) => p.refuse === undefined && MUTATING_TOOL_NAMES.has(p.call.name)) &&
      requestRequiresWorkspaceAction(requestText, authorization.authorized)
    ) {
      planNudged = true;
      // Hard requirement, spent ONCE: refuse the first batch's FILE mutations
      // so nothing is written before a plan exists. It bumps the step budget by
      // one because it forces a genuine re-answer (the model must declare the
      // plan and retry), exactly like the zero-action nudge.
      const blocked: string[] = [];
      if (!planBlocked) {
        planBlocked = true;
        for (const p of plans) {
          if (p.refuse === undefined && PLAN_GATED_TOOL_NAMES.has(p.call.name)) {
            p.refuse =
              'Error: declare a plan first via plan_todo — call it with 2–6 ordered steps (action "create"), then retry this change. The plan is how the turn is tracked and verified.';
            blocked.push(p.call.name);
          }
        }
        if (blocked.length > 0) stepLimit += 1;
        for (const name of blocked) {
          traceEvent({
            kind: 'refusal',
            gate: 'plan',
            tool: name,
            summary:
              `refused ${name}: no plan declared — the first mutation is blocked once so the model plans before it changes files`,
          });
        }
      }
      deps.onEvent?.(
        blocked.length > 0
          ? '   🗺️ No plan declared — blocking the first change until the model plans.'
          : '   🗺️ No plan declared — asking the model to plan before it changes files.',
      );
      traceEvent({
        kind: 'gate',
        gate: 'plan',
        summary: blocked.length > 0
          ? `a workspace-directing turn was about to mutate without a plan — the first mutation batch (${blocked.join(', ')}) was refused once and the model asked to declare a plan first`
          : 'a workspace-directing turn was about to mutate without a plan — one bounded nudge to declare one first',
      });
      deferredUserNudges.push({ gate: 'plan', content: planRequiredNudge(currentAsk(opts)) });
    }

    const executed: string[] = new Array(plans.length).fill('');
    for (let i = 0; i < plans.length; ) {
      // A run of consecutive read-only calls is ONE bounded fan-out; any
      // refused call breaks the run (its error is cheap and order-sensitive).
      if (plans[i].refuse === undefined && isParallelSafeTool(plans[i].call.name)) {
        let j = i;
        while (j < plans.length && plans[j].refuse === undefined && isParallelSafeTool(plans[j].call.name)) j += 1;
        const run = plans.slice(i, j);
        if (run.length > 1) {
          deps.onEvent?.(`   ⚡ ${run.length} read-only tool calls in parallel`);
          for (let k = 0; k < run.length; k += maxParallelReads) {
            const chunk = run.slice(k, k + maxParallelReads);
            const chunkResults = await Promise.all(chunk.map((p) => runOne(p)));
            chunkResults.forEach((text, n) => {
              executed[i + k + n] = text;
            });
          }
        } else {
          executed[i] = await runOne(run[0]);
        }
        i = j;
      } else {
        executed[i] = await runOne(plans[i]);
        i += 1;
      }
    }

    // ── Phase 3 — post-process, in the model's original call order ─────────
    // Tool results MUST reach the thread in the assistant's tool_calls order:
    // providers pair them by `toolCallId`, and a reordered thread reads as a
    // different (worse) tool use. So the ordered pass below owns the push even
    // though the executions above may have completed out of order.
    // What each call actually delivered (post hint/tip decoration), kept in
    // call order for the endsAgentStep exit below.
    const delivered: string[] = new Array(plans.length).fill('');
    let stepAnySuccess = false;
    for (let i = 0; i < plans.length; i += 1) {
      const call = plans[i].call;
      const rawResult = executed[i];
      // HONEST ACCOUNTING: record what actually SUCCEEDED (an error/refusal is
      // not a success, and a delivery tool only counts when it reported `✅`).
      // `toolCallsRun` stays the attempted list for telemetry; these two drive
      // the honesty flag and the trace outcome.
      // A DECLINED call is not a success, whatever prefix it used. Found live on
      // the first G18 verification run: `write_file` refused an absolute path
      // that escaped the workspace and returned "… escapes the workspace … —
      // denied" with NO `Error:` prefix, so the loop counted it as a call that
      // RAN, pushed it to `successfulToolCalls`, and recorded it in the trace as
      // "write_file ran". That is the exact shape G18 exists to eliminate — an
      // outcome reading the same as its opposite — so the refusal classifier is
      // now the authority for both the event KIND and the success verdict.
      const refusal = classifyToolRefusal(rawResult);
      // A command that outlived its wait budget is STILL RUNNING under
      // monitoring: it has not verified anything yet, and it has not failed
      // either. Neither verdict may be recorded for it — `successfulToolCalls`
      // feeds the "did you check it" gate and the honest accounting, so counting
      // a live run as a success is how a turn claims "the tests pass" about a
      // suite still on its first file. The command's real verdict arrives when
      // it lands, via `run_terminal(action:'poll')` — which is a normal success
      // or `Error:` result and is accounted for like any other.
      const stillRunning = rawResult.startsWith(RUN_TERMINAL_INCOMPLETE_PREFIX);
      const ranOk =
        refusal === null &&
        !stillRunning &&
        !rawResult.startsWith('Error:') &&
        (!DELIVERY_TOOL_NAMES.has(call.name) || deliveryResultSucceeded(rawResult));
      if (ranOk) {
        progress.successfulToolCalls.push(call.name);
        stepAnySuccess = true;
      }
      // BREADTH, recorded from what actually happened: a file counts as OPENED
      // only when its content came back through a successful `read_file` — not a
      // grep hit, not a `list_dir`, not a path the model mentioned. A truncated
      // read still counts (its head entered the thread), which is the honest
      // reading: the audit saw part of the file.
      if (ranOk && coverage && call.name === 'read_file') {
        const a = call.arguments as { path?: unknown; paths?: unknown } | undefined;
        if (typeof a?.path === 'string') coverage.recordRead(a.path);
        if (Array.isArray(a?.paths)) {
          for (const entry of a.paths) {
            if (typeof entry === 'string') coverage.recordRead(entry);
            else if (entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string') {
              coverage.recordRead((entry as { path: string }).path);
            }
          }
        }
      }
      // COVERAGE FOR THE NEXT RUN — recorded as the reads land rather than at the
      // end of the turn, because the run that never reaches its end (crash,
      // cancel, quota) is the one whose reading a later run most needs back. Depth
      // is `read`: the content entered the thread. `executed` is never inferred
      // from a read — it is recorded by the turn's verification report, from what
      // a check actually covered.
      if (ranOk && call.name === 'read_file') {
        const a = call.arguments as { path?: unknown; paths?: unknown } | undefined;
        const read: string[] = [];
        if (typeof a?.path === 'string') read.push(a.path);
        if (Array.isArray(a?.paths)) {
          for (const entry of a.paths) {
            if (typeof entry === 'string') read.push(entry);
            else if (entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string') {
              read.push((entry as { path: string }).path);
            }
          }
        }
        if (read.length > 0) {
          noteCoverage(
            projectRoot,
            read.map((path) => ({ path, depth: 'read' as const })),
            { ...(opts.runId ? { runId: opts.runId } : {}), root: projectRoot },
          );
        }
      }
      if (call.name === 'gateway_send' && deliveryResultSucceeded(rawResult)) {
        progress.deliveryConfirmed = true;
      }
      // COMPLETION CONTRACT — the `finish` tool's verdict, read from its RESULT
      // marker (never from prose). An accepted claim is what lets the turn end
      // without the completion gate asking once more; a refused one is a normal
      // tool result and the model keeps working in the same turn.
      if (call.name === 'finish') {
        finishCalls += 1;
        if (rawResult.includes(FINISH_ACCEPTED_MARKER)) {
          finishAccepted = true;
          const claim = call.arguments as { verified?: unknown; unmet?: unknown } | undefined;
          const unmet = Array.isArray(claim?.unmet)
            ? claim.unmet.map((u) => String(u ?? '').trim()).filter(Boolean)
            : [];
          if (claim?.verified === false && unmet.length > 0) {
            progress.finishClaim = { verified: false, unmet };
          }
        }
      }
      // Session 4 — capture the EVIDENCE the gate needs to judge whether a
      // verification actually exercised the changed artifact: the mutated
      // paths, and each successful verification call's args + result.
      if (ranOk) {
        if (call.name === 'edit_file' || call.name === 'write_file') {
          const a = call.arguments as { path?: unknown; file_path?: unknown; file?: unknown } | undefined;
          const p = a?.path ?? a?.file_path ?? a?.file;
          if (typeof p === 'string' && p) {
            progress.mutatedPaths.push(p);
            stepWritten.push({ tool: call.name, path: p });
            // Bundle 19 — keep what was WRITTEN, so the turn can be judged on its
            // artifact. Capped: a turn cannot grow the loop's memory without bound.
            if (progress.authoredArtifacts.length < AUTHORED_ARTIFACT_MAX) {
              const written = extractWrittenText(call.arguments);
              progress.authoredArtifacts.push({
                tool: call.name,
                path: p,
                // The TEXT is capped for memory, but the WORD COUNT is taken from the
                // FULL text: a long document must be measured whole. Measuring the
                // first 20k characters instead under-counts a long-with-long-words
                // document and FALSELY flags it as short — see `detectArtifactShortfall`.
                content: written.slice(0, AUTHORED_ARTIFACT_MAX_CHARS),
                words: countWords(written),
              });
            }
            // Stage 2 — the run's own record of what it CHANGED, so a self-report
            // can answer "what have you been doing" from data rather than from a
            // re-read of the transcript.
            runTrace.recordMutation(call.name, p);
          }
        } else if (isVerificationTool(call.name)) {
          progress.verificationEvidence.push({ tool: call.name, args: call.arguments, result: rawResult });
          // PLAN AUTO-ADVANCE — a check that RAN is what closes a step that names
          // a check (see planStepsClosedByEvidence).
          const cmd = (call.arguments as { command?: unknown } | undefined)?.command;
          const entry = { tool: call.name, ...(typeof cmd === 'string' && cmd ? { command: cmd } : {}) };
          stepChecks.push(entry);
          turnChecks.push(entry);
          // CHECK LEDGER — what this check actually exercised, and how many writes
          // had landed when it returned, so a later edit makes the verdict STALE
          // rather than answered (see learning/check-ledger.ts).
          const ranKind = classifyCheck(call.name, typeof cmd === 'string' ? cmd : undefined);
          if (!ranKind.inspectionOnly) {
            checkRuns.push({
              command: typeof cmd === 'string' && cmd.trim() ? cmd.trim() : call.name,
              tool: call.name,
              ok: true,
              afterWrites: progress.mutatedPaths.length,
              kinds: ranKind.kinds,
            });
          }
        }
      } else if (refusal !== null || rawResult.startsWith('Error:')) {
        // SELF-DIAGNOSIS — record an action that RAN and FAILED (a non-zero
        // exit, a timeout, a tool error), keyed by the action itself (the
        // command / path). The gate below fires when the SAME action repeats:
        // a refusal was already remembered across runs (step-handoff), but a
        // command that RUNS and FAILS was not, so the live macOS-build turn
        // re-issued `npx tauri build` ~10 times against the same missing Cargo
        // and never once stopped to diagnose. Refusals are the other record
        // below; this one is for the calls that actually executed.
        if (refusal === null) {
          runTrace.recordFailure(call.name, failureActionOf(call), rawResult);
          // CHECK LEDGER — a check that RAN and FAILED is the verdict the turn has
          // to answer (fix and re-run, or say why it stands). A command still
          // running under monitoring has no verdict yet, so it is not recorded.
          if (!stillRunning && isVerificationTool(call.name)) {
            const failedCmd = (call.arguments as { command?: unknown } | undefined)?.command;
            const failedKind = classifyCheck(call.name, typeof failedCmd === 'string' ? failedCmd : undefined);
            if (!failedKind.inspectionOnly) {
              checkRuns.push({
                command: typeof failedCmd === 'string' && failedCmd.trim() ? failedCmd.trim() : call.name,
                tool: call.name,
                ok: false,
                afterWrites: progress.mutatedPaths.length,
                kinds: failedKind.kinds,
                // Fell out of the run: the count is how a later run proves the turn
                // did not make it worse (see `unansweredRedChecks`).
                ...(parseFailingCount(rawResult) !== undefined
                  ? { failing: parseFailingCount(rawResult) as number }
                  : {}),
              });
            }
          }
        }
        // Stage 2 — the other half of noticing a loop: the SAME refusal, twice.
        // The run records it with its reason, so a later step (or a self-report)
        // can see "blocked twice, identically" instead of rediscovering it — and
        // so the repetition gate has a refusal signal as well as an ask signal.
        runTrace.recordRefusal(call.name, refusal?.gate ?? 'error', rawResult);
        // ── DURABLE HAND-OFF ────────────────────────────────────────────────
        // A refused MUTATION is the one failure that must outlive the turn.
        // The live NVDA-addon failure is exactly this: `write_file` was refused
        // on every attempt because the target was outside the workspace, and
        // each of the 18 following attempts rediscovered it from zero — same
        // plan, same refusal, same empty package. Recording it here means the
        // next candidate, the next turn and the next RUN are told which path
        // could not be written and WHY, so they change approach instead of
        // repeating the identical call (see step-handoff.ts).
        //
        // Best-effort: a hand-off write must never break the loop.
        if (refusal !== null && MUTATING_TOOL_NAMES.has(call.name)) {
          try {
            const ask = currentAsk(opts);
            const aimedAt = mutatedPathOf(call.arguments);
            // Key on the deliverable the ASK names when there is one, so the
            // same work asked for in different words resumes the same hand-off.
            const named = deliverablesNamedIn(ask);
            recordStepHandoff({
              projectPath: opts.context?.cwd || process.cwd(),
              goal: ask,
              stepDescription: aimedAt
                ? `${call.name} → ${aimedAt} (refused: ${refusal.gate ?? 'gate'})`
                : `${call.name} (refused: ${refusal.gate ?? 'gate'})`,
              declared: named.length > 0 ? named : aimedAt ? [aimedAt] : [],
              route: 'loop',
              kind: 'refused',
              reason: `${refusal.summary}${aimedAt ? ` — path: ${aimedAt}` : ''}`,
            });
          } catch {
            // Best-effort — a hand-off write must never break the loop.
          }
        }
      }
      let resultText = executed[i];
      // ── STAGING DISCIPLINE (W4e) ─────────────────────────────────────────
      // MEASURED (2026-10-25 audit): the model wrote `REPORT.md` INSIDE the audited
      // tree three times and only a later move put it at `../REPORT.md`. A failed
      // move would have left the deliverable in a repository the task said not to
      // modify — the tree it was asked to leave clean was the one it dirtied.
      // The write is allowed (a staged draft is not a crime); the result says, in
      // the same step, where the deliverable actually belongs and what to clean up.
      if (ranOk && call.name === 'write_file') {
        const written = (call.arguments as { path?: unknown } | undefined)?.path;
        if (typeof written === 'string' && written) {
          const staging = stagedDeliverableNote(written, ctx.cwd ?? process.cwd(), namedDeliverables);
          if (staging) {
            resultText = `${resultText}\n\n${staging}`;
            deps.onEvent?.(`   📄 \`${written}\` is inside the workspace but the deliverable belongs outside it — told the model to write it at the final path.`);
          }
        }
      }
      // P3 — fence EXTERNAL content (web pages/search hits) as DATA, so a page
      // cannot smuggle instructions into the context. Local tool output is
      // untouched, and a tool's own failure text is left as it is.
      resultText = fenceUntrustedToolOutput(call.name, resultText);
      // P3c — on error/denial, append the deterministic fallback hint for
      // this tool (advisory — the model still decides; never on success).
      const hint = fallbackHintForTool(call.name, resultText);
      if (hint) resultText = `${resultText}\n\n💡 ${hint}`;
      // P3d — record successful independent gather steps; the suggestion
      // fires once after the 2nd (bounded, deterministic, advisory).
      const parallelTip = parallel.note(call.name, !resultText.startsWith('Error:'));
      if (parallelTip) resultText = `${resultText}\n\n${parallelTip}`;
      // ── MISSING-PREREQUISITE TAKEOVER ──────────────────────────────────
      // A `command not found` (exit 127) for a KNOWN, installable system tool
      // is a STEP, not a wall — but a model can read it as an environment
      // limit and stop: "I cannot install system-level software on your host
      // machine — I am physically unable" (live: trace-1791127992452-qzgodi,
      // where a user who had explicitly granted terminal permission was handed
      // a manual `curl … | sh` step instead of the install being done). Inject
      // the exact install command and forbid the refusal, deterministically, so
      // the NEXT model step acts. Advisory text only — the loop never runs the
      // install itself; that stays the model's governed `run_terminal` call.
      if (!ranOk && (call.name === 'run_terminal' || call.name === 'terminal')) {
        const failedCommand = String(
          (call.arguments as { command?: unknown } | undefined)?.command ?? '',
        );
        // EVERY installable tool the failing line needs, not just the first —
        // a `cd app && cargo build && cmake .` turn should hand the model all
        // the prerequisites in one takeover instead of one per round-trip.
        const missing = installableToolsFromFailure(failedCommand, rawResult);
        if (missing.length > 0) {
          const installCommands = missing.map((t) => resolveInstallCommand(t));
          resultText = `${resultText}\n\n${toolTakeoverInstruction(missing, installCommands)}`;
          deps.onEvent?.(
            `   🛠️ ${missing.map((t) => `'${t}'`).join(', ')} missing and installable — handing the model the install command(s) to run.`,
          );
          traceEvent({
            kind: 'gate',
            gate: 'tool-takeover',
            summary:
              `${missing.join(', ')} missing (command not found) and installable — the model is ` +
              'told to install them itself instead of declaring itself unable',
          });
        }
        // ── PROJECT PREREQUISITE BACKSTOP (D2.3) ──────────────────────────
        // No missing BINARY, but this failure may be a missing project FILE/
        // FEATURE (the other half of the same wall): `src-tauri/build.rs`, a
        // Cargo `custom-protocol` feature, an icon — none of which is a tool to
        // install, so the takeover above never fired and the live macOS turn
        // re-ran `npx tauri build` ~10 times. Match the OUTPUT SIGNATURE, hand
        // the model the exact fix on the FIRST failure, and record it.
        if (missing.length === 0) {
          const rules = matchPrerequisiteSignatures(rawResult);
          if (rules.length > 0) {
            resultText = `${resultText}\n\n${prerequisiteTakeoverInstruction(rules)}`;
            deps.onEvent?.(
              `   🧱 build prerequisite signature matched (${rules.map((r) => r.id).join(', ')}) — handing the model the exact fix.`,
            );
            traceEvent({
              kind: 'gate',
              gate: 'prerequisite',
              summary:
                `build failed on a missing PROJECT prerequisite (${rules.map((r) => r.id).join(', ')}) — ` +
                'the model is given the exact fix instead of retrying the identical command',
            });
          }
        }
      }
      delivered[i] = resultText;
      // G18 — record what this call DID, in the model's own call order, with the
      // evidence a later reader needs: the args the gate saw, the first line of
      // the result, the verdict, and the wall-clock. A declined call is recorded
      // as a REFUSAL with its cause, so "nothing happened here" can never again
      // read the same as "nothing was refused" (see classifyToolRefusal).
      // `rawResult` is the pre-decoration text — hints and tips are the loop's
      // own additions and must not be mistaken for what the tool returned.
      const durationMs = toolDurations.get(call.id);
      traceEvent({
        kind: ranOk ? 'tool' : 'refusal',
        tool: call.name,
        ...(refusal?.gate ? { gate: refusal.gate } : {}),
        summary: ranOk ? `${call.name} ran` : refusal?.summary ?? `${call.name} returned an error`,
        args: summarizeArgs(call.arguments),
        result: previewToolResult(rawResult),
        ok: ranOk,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      // WASTE GUARD — record what this read answered, so the identical call on
      // this same workspace state is refused instead of executed again.
      if (ranOk && plans[i].refuse === undefined) {
        const answered = memoizableReadSignature(call.name, call.arguments);
        if (answered !== null) answeredReads.set(answered, progress.mutatedPaths.length);
      }
      thread.push({ role: 'tool', toolCallId: call.id, content: resultText });
    }

    // Flush the planning-time nudges now that the assistant's tool_calls group is
    // complete (every call id has a `tool` result). This is the first point a
    // user/system message may safely follow the batch.
    for (const nudge of deferredUserNudges) harness.push(thread, nudge.gate, nudge.content);

    // ── PLAN AUTO-ADVANCE — the loop advances what its own ledger closed ───
    // A `plan_todo` call re-sends the entire conversation to say "step 2 is done"
    // about a call the loop already watched succeed. Measured 2026-10-17: 9 of
    // the turn's 34 tool calls were that bookkeeping. So the steps the ledger can
    // justify are advanced HERE, with the call recorded as their evidence (the
    // store then renders a real ✅ rather than the ⚠️ it uses for a done with
    // nothing behind it), and the model is left to settle only what it alone can
    // judge. Best-effort: a store that cannot update, or a plan that does not
    // cover this work, changes nothing.
    if (stepWritten.length > 0 || stepChecks.length > 0) {
      try {
        const planStore = context.planStore;
        const snapshot = planStore?.snapshot?.() ?? null;
        const advances = planStepsClosedByEvidence({
          snapshot,
          written: stepWritten,
          checks: turnChecks,
          at: Date.now(),
        }).filter((a) => !planAutoAdvanced.has(a.id));
        for (const advance of advances) {
          planAutoAdvanced.add(advance.id);
          planStore?.update?.(advance.id, 'done', `done from observed work: ${advance.reason}`, {
            hasLedger: true,
            evidence: advance.evidence,
          });
          deps.onEvent?.(
            `   🗺️ plan step "${advance.id}" → done (${advance.reason}) — no plan call spent ` +
              `(${planAutoAdvanced.size} advanced this turn).`,
          );
          traceEvent({
            kind: 'gate',
            gate: 'plan-auto',
            summary:
              `plan step "${advance.id}" was advanced to done from the turn's own action ledger — ${advance.reason} — ` +
              'instead of spending a model round-trip on plan_todo',
          });
        }
      } catch {
        // Best-effort: plan bookkeeping must never break a turn.
      }
    }

    // ── PLAN DEPTH (bounded, ONCE per turn) ────────────────────────────────
    //
    // Runs on the step that CREATED the plan, because the plan is what the rest of the
    // turn is measured against: a coarse plan makes every later gate agree that the
    // work is done. See `learning/plan-depth.ts` for the measurement (one step naming
    // eight of the ask's requirements) and for why this is one ask rather than a rule.
    if (planDepthAsks < MAX_PLAN_DEPTH_ASKS && opts.requirePlan !== false) {
      const snapshot = context.planStore?.snapshot?.() ?? null;
      if (snapshot) {
        const doneNow = snapshot.steps.filter((s) => s.status === 'done').length;
        // A PHASE BOUNDARY: the plan was rewritten this step, or a step reached done. Not a
        // timer — the plan is what changed, and that is when its depth is worth re-reading.
        const phaseBoundary =
          planTodoCreates > 0 || planTodoUpdates > 0 || doneNow > lastPlanDone || snapshot.revision !== lastPlanRevision;
        if (phaseBoundary) {
          lastPlanDone = doneNow;
          lastPlanRevision = snapshot.revision;
          // A requirement the user replaced mid-turn is not a missing step.
          const changeRequest = readChangeRequest(ctx.cwd ?? process.cwd());
          const issue = planDepthIssue({
            ask: requestText,
            steps: snapshot.steps,
            ...(changeRequest?.text ? { changeRequest: changeRequest.text } : {}),
          });
          // The signature is the COMPLAINT, not the plan: an unchanged coarse plan is
          // silent, a newly collapsed one is a new fact worth saying.
          const signature = issue
            ? `${issue.bundled.map((b) => b.step).sort().join(',')}|${[...issue.missing].sort().join(',')}`
            : '';
          if (issue && signature !== lastPlanDepthSignature) {
            lastPlanDepthSignature = signature;
            planDepthAsks += 1;
            // One step, so the rewrite costs the turn nothing it was not already spending.
            stepLimit += 1;
            if (advisoryNudges) harness.push(thread, 'plan-depth', planDepthNudge(issue));
            deps.onEvent?.(
              `   🗺️ The plan gives one checkbox to ${issue.bundled[0]?.features.length ?? 0} named requirement(s) — asking for it to be split (${planDepthAsks}/${MAX_PLAN_DEPTH_ASKS} this turn).`,
            );
            traceEvent({
              kind: 'gate',
              gate: 'plan-depth',
              summary:
                `the plan does not decompose the ask: ${issue.bundled.length} step(s) bundle more than ` +
                `${MAX_FEATURES_PER_STEP} of its ${issue.features.length} named requirement(s), ` +
                `${issue.missing.length} requirement(s) have no step — checked at step ${steps}, ` +
                `ask ${planDepthAsks}/${MAX_PLAN_DEPTH_ASKS}`,
            });
          }
        }
      }
    }
    // ── BATCHING nudge (bounded, ONCE per turn) ───────────────────────────
    // The loop already EXECUTES several calls per step in parallel when the
    // model sends them (`⚡ N read-only tool calls in parallel`). What was
    // missing is telling the model that it may, and what a one-call-per-step
    // habit costs: at ~29 K input tokens per step, a turn that reads three files
    // one at a time pays three times for the same context. Fire once, after the
    // SECOND consecutive whole-step-for-one-gather, and stay quiet after that —
    // the model decides, and this is advice, never a requirement (verification
    // rules are untouched: the real check still runs, once).
    const ranCalls = plans.filter((p) => p.refuse === undefined);
    const ranSingleGather = ranCalls.length === 1 && isGatherCall(ranCalls[0].call.name);
    if (ranSingleGather) singleGatherSteps += 1;
    if (advisoryNudges && !batchingNudged && singleGatherSteps >= 2 && maxParallelReads > 1) {
      batchingNudged = true;
      // NO extra step is granted, unlike the other gates: this directive rides on
      // the NEXT model call the turn was already going to make (the step that just
      // ran tools continues), so it forces no additional round-trip. Granting one
      // would silently lengthen every affected turn's budget.
      deps.onEvent?.(
        `   🧺 ${singleGatherSteps} steps spent one call each — asking the model to batch independent calls.`,
      );
      traceEvent({
        kind: 'gate',
        gate: 'batching',
        summary:
          `${singleGatherSteps} consecutive steps ran exactly ONE information-gathering call (last: ${ranCalls[0].call.name}) — ` +
          'one bounded nudge to batch independent calls into a single step (the loop executes them in parallel)',
      });
      harness.push(thread, 'batching', batchingNudge(steps, ranCalls[0].call.name));
    }

    // Track the generalized stall: a step that RAN tools but succeeded at none
    // of them extends the streak; any success clears it. A text-only step (no
    // tools) leaves it as it was — the model is thinking, not failing.
    if (plans.length > 0) failedToolSteps = stepAnySuccess ? 0 : failedToolSteps + 1;

    // ── SELF-DIAGNOSIS nudge (bounded, once) ──────────────────────────────
    // The loop's missing introspection: when the SAME action has failed more
    // than once, re-issuing it is a loop, not progress. This is the exact
    // shape of the live macOS-build turn — `npx tauri build` was retried ~10
    // times against the same missing Rust/Cargo, each attempt rediscovering
    // the same wall, and the run never stopped to ask WHY. Unlike the
    // end-of-turn gates (permission/repeat/deliverable), which fire only when
    // the model stops calling tools, this one must fire MID-TURN while the
    // model is still looping on the failing call — so it is injected here,
    // right after the step's results are in the thread, and the next model
    // step sees it. Bounded once per turn and keyed on the action so the same
    // repeat cannot trigger it twice.
    // ── A payload that does not fit in one output ────────────────────────────
    // The refusal above already says so per call; this adds ONE mid-turn nudge
    // naming the delivery strategy, because a model stuck re-emitting a too-large
    // call needs the alternative, not a third identical error.
    if (malformedToolCalls >= 3 && malformedCallNudges < 1) {
      malformedCallNudges += 1;
      stepLimit += 1;
      deps.onEvent?.(
        `   📦 ${malformedToolCalls} calls arrived with no usable arguments — telling the model to build the artifact in sections.`,
      );
      traceEvent({
        kind: 'gate',
        gate: 'malformed-call',
        summary: `${malformedToolCalls} tool calls this turn carried no usable arguments (payload larger than one model output) — one bounded nudge to deliver in sections`,
      });
      harness.push(thread, 'malformed-call', malformedCallNudge(malformedToolCalls));
    }

    if (diagnosisNudges < 1) {
      const repeated = runTrace.repeatedFailure();
      if (repeated && repeated.times >= 2) {
        diagnosisNudges += 1;
        stepLimit += 1;
        deps.onEvent?.(
          `   🩺 Same action failed ${repeated.times}× — asking the model to diagnose the cause instead of retrying.`,
        );
        traceEvent({
          kind: 'gate',
          gate: 'diagnosis',
          summary:
            `the same action failed ${repeated.times} times (${repeated.tool}: ${repeated.action.slice(0, 120)}) — ` +
            'one bounded nudge to diagnose the root cause and change the approach',
        });
        harness.push(thread, 'diagnosis', repeatedFailureNudge(repeated));
      } else if (failedToolSteps >= NO_PROGRESS_STALL_STEPS) {
        // Stage 2 — no SINGLE action repeated, but the last N steps each ran
        // tools and none succeeded. Same diagnosis demanded, different evidence.
        diagnosisNudges += 1;
        stepLimit += 1;
        deps.onEvent?.(
          `   🩺 ${failedToolSteps} steps with no successful action — asking the model to diagnose the stall.`,
        );
        traceEvent({
          kind: 'gate',
          gate: 'diagnosis',
          summary:
            `${failedToolSteps} consecutive steps ran tools and none succeeded — ` +
            'one bounded nudge to diagnose the shared cause and change the approach',
        });
        harness.push(thread, 'diagnosis', noProgressNudge(runTrace.recentFailures(3), failedToolSteps));
      }
    }

    // Tiered exposure: after EVERY executed tool call, union any newly
    // loaded toolset schemas into the live set so the NEXT model step can
    // call them natively (tool_search load → loadedExtraTools → here).
    mergeLoadedTools();

    // Phase 4c — STEP BOUNDARY. The step's tool results are now IN the thread,
    // so this is the first point at which the turn's work is fully reflected in
    // the conversation. A caller persisting a session snapshot (Phase 4b) is
    // handed the live thread + the honest accumulators HERE, so a process that
    // dies on the NEXT step leaves a record of everything through this one.
    //
    // Best-effort by contract: a snapshot writer that throws must never break
    // the loop it observes (same rule as `onTraceEvent`).
    if (opts.onStep) {
      try {
        opts.onStep({
          thread,
          steps,
          successfulTools: progress.successfulToolCalls,
          mutatedPaths: progress.mutatedPaths,
        });
      } catch {
        // Best-effort — a snapshot failure is not the turn's failure.
      }
    }

    // P4 — cancellation during/after tool execution: do NOT request another
    // model step on a cancelled turn (the user already walked away).
    if (opts.signal?.aborted) {
      return { content: '', followups, toolCalls: toolCallsRun, steps, ...(opts.resume ? { replayedSteps } : {}), bounded: false, cancelled: true, termination: 'cancelled' };
    }

    // ── endsAgentStep — a successful dispenser's RESULT is the answer ────────
    // `build`/`resume`/`repair`/`document`/`website`/`analyze`/`test`/`publish`
    // declare endsAgentStep: the pipeline they dispatch runs the entire task,
    // so their own result text (`✅ build succeeded` + summary + details) IS the
    // deliverable. The flag was declared on the Tool interface and read by
    // NOTHING (audit W4), so the loop always asked for one more model step —
    // a full round trip that re-sent the whole tool schema purely to have the
    // model paraphrase output it had not produced, with a live window for a
    // second dispatch of the same pipeline.
    //
    // Only a SUCCESS ends the step (a refused or failed dispatch must stay in
    // the loop so the model can react), and `ask_user` deliberately does not:
    // its result is the user's ANSWER — input the model must act on. See the
    // `endsAgentStep` docstring in registry.ts for the contract.
    const terminalIdx = delivered.findIndex(
      (text, i) => !text.startsWith('Error:') && getTool(plans[i].call.name)?.endsAgentStep === true,
    );
    if (terminalIdx >= 0) {
      // A real summary written THIS step wins (it is the model's own account
      // of the dispatch); a bare lead-in ("Running the build now…") does not —
      // the pipeline's summary is the answer then, not the wrapper.
      const thisStepIsSubstantive =
        response.content.trim() !== '' && !isBareAcknowledgment(response.content);
      return {
        content: thisStepIsSubstantive ? response.content : delivered[terminalIdx],
        followups,
        toolCalls: toolCallsRun,
        steps,
        ...(opts.resume ? { replayedSteps } : {}),
        bounded: false,
        continuations,
        ...(modelHandoffs > 0 ? { modelHandoffs } : {}),
        ...observationsField(),
        termination: 'delivered',
      };
    }

    // End-of-response semantics (the contract: "END EVERY RESPONSE by
    // calling suggest_followups"): when the model delivered its answer and
    // ended with a SUCCESSFUL suggest_followups, the turn is complete — do NOT
    // request another step. That previous behavior forced the model to keep
    // emitting followups (repeating it 4–5×, sometimes malformed), and the
    // repeats clobbered the delivered answer ("where is the essay?" / the
    // answer ending in raw JSON).
    //
    // S1: deliver the MOST SUBSTANTIVE content seen, not necessarily this
    // step's text — the concluding step often carries only a short trailing
    // wrapper while the real answer (the essay) landed in an earlier step
    // whose (invalid) followups call forced the loop to continue. Also covers
    // a JSON-only concluding step (empty text, valid followups): return the
    // substantive answer from earlier.
    // Premature-followups guard: a concluding step whose content is only a
    // bare acknowledgment ("Sure, I can help!") has NOT delivered the answer
    // yet — ending here would hand the user a lead-in instead of the essay.
    // Continue so the model writes the real answer (the S1 longest-substantive
    // logic guarantees an earlier real answer, if any, still wins).
    const hasRealAnswer = lastContent.trim() !== '' && !isBareAcknowledgment(lastContent);
    const thisStepIsReal = response.content.trim() !== '' && !isBareAcknowledgment(response.content);
    if (endedAfterConcluding && (thisStepIsReal || hasRealAnswer)) {
      // G1 — VERIFICATION GATE (concluding path). Most edit turns end here (the
      // model calls suggest_followups after editing), so the gate must fire on
      // this exit too or it would be inert in practice. Bounded exactly once,
      // same as the no-tools exit above.
      //
      // ONE LEDGER, ONE VERDICT (2026-10-30). `judgeCompletion` refuses a
      // `verified:true` claim when files changed and nothing observed them, and
      // ACCEPTS `verified:false` together with the gap it names — either way an
      // accepted `finish` has already read this exact evidence (the check ledger)
      // and settled it. Re-asking the same question here, from the same ledger, is
      // how the two readers contradicted each other: measured on DEV-FEATURE, a
      // suite that had run and passed was called unverified, and the model re-ran
      // it three times. It also punishes honesty — an accepted `verified:false`
      // ending says "not checked" out loud, and nagging it turns candour into a
      // step. So the gate speaks only when no verdict has been recorded.
      if (
        !finishAccepted &&
        verificationNudges < 1 &&
        opts.requireVerification !== false &&
        schemas.length > 0 &&
        assessEditActivity(
          progress.successfulToolCalls,
          progress.verificationEvidence,
          progress.mutatedPaths,
          ctx.cwd ?? process.cwd(),
        ).needsVerification
      ) {
        verificationNudges += 1;
        stepLimit += 1;
        deps.onEvent?.('   🔎 Files were changed but nothing verified them — asking the model to run a check.');
        traceEvent({
          kind: 'gate',
          gate: 'verification',
          summary: 'the turn mutated the workspace and nothing observed the result — one bounded nudge to verify',
        });
        thread.push({ role: 'assistant', content: response.content });
        // Stage 3 — name THIS project's strongest check instead of describing a
        // preference order. A live turn reached for `node -c` because the nudge
        // left the choice to the model; `verificationNudgeFor` reads the
        // workspace and asks for the real command, so there is nothing to guess.
        harness.push(thread, 'verification', verificationNudgeFor(ctx.cwd ?? process.cwd(), progress.mutatedPaths));
        continue;
      }
      // G13b — DELIVERABLE GATE (concluding path). AFTER the verification gate
      // on purpose: a turn that wrote nothing has nothing to verify, so the two
      // cannot both apply, and this order leaves edit turns byte-identical.
      if (deliverableNudges < 1 && deliverableGateApplies(opts, response.content.length >= lastContent.length ? response.content : lastContent, progress, schemas.length, requestText)) {
        deliverableNudges += 1;
        stepLimit += 1;
        deps.onEvent?.('   📄 The request asked for a file and none was written — asking the model to produce it.');
        traceEvent({
          kind: 'gate',
          gate: 'deliverable',
          summary: authorization.requestedPath
            ? `an authored deliverable was requested at ${authorization.requestedPath} and no file was written — one bounded nudge to produce it`
            : 'an authored deliverable was requested and no file was written — one bounded nudge to produce it',
        });
        thread.push({ role: 'assistant', content: response.content });
        harness.push(thread, 'deliverable', deliverableNudge(authorization.requestedPath));
        continue;
      }
      // REQUIRED-ARTIFACTS GATE (concluding path) — same check, same bound, for a
      // turn that ends through the follow-up exit instead of the no-tools one.
      //
      // IT DOES NOT DEFER TO AN ACCEPTED `finish`, unlike the verification gate
      // above, and the difference is deliberate: `finish` reads the path the request
      // NAMED (`docs/BUGS_FOUND.md`), while this gate reads the artifact list
      // (`todo.md`, `README`, test classes) — `completion-contract.ts` says so in its
      // own header. They are two ledgers, so an accepted claim here answers a
      // different question, and silencing this one would restore the measured
      // 2026-10-25 failure (a green build with none of the named tracking files).
      // Guard a gate only where its premise IS the contract's evidence; where the
      // evidence differs, the gate must keep its own voice.
      if (artifactNudges < 2) {
        const missing = artifactsGateApplies({
          request: requestText,
          cwd: ctx.cwd ?? process.cwd(),
          didWork: progress.mutatedPaths.length > 0,
        });
        if (missing) {
          artifactNudges += 1;
          stepLimit += 1;
          deps.onEvent?.(`   📋 The request named ${missing.length} artifact(s) that do not exist yet — asking the model to produce them.`);
          traceEvent({
            kind: 'gate',
            gate: 'required-artifacts',
            summary: `the request named artifact(s) that are missing from the workspace: ${missing
              .map((m) => m.describe)
              .join('; ')}`,
          });
          thread.push({ role: 'assistant', content: response.content });
          // Distinct keys: the harness sink delivers ONE directive per gate, so a
          // second nudge under the same key would be dropped while the loop still
          // spent a step waiting for a reply to a message the model never saw.
          harness.push(thread, artifactNudges === 1 ? 'artifacts' : 'artifacts-again', artifactsNudge(missing));
          continue;
        }
      }
      // ZERO-ACTION gate (concluding exit) — the same bounded pass as the
      // no-tools exit, for a turn that concluded (suggest_followups) without
      // ever touching the workspace a directed request asked it to change.
      if (
        actionNudges < 1 &&
        zeroActionGateApplies(opts, progress, schemas.length, requestText, authorization.authorized)
      ) {
        actionNudges += 1;
        stepLimit += 1;
        deps.onEvent?.('   🛠️ The request asked for work and nothing was done — telling the model to do it now.');
        traceEvent({
          kind: 'gate',
          gate: 'action',
          summary: 'the request directed work on the workspace and the turn performed none — one bounded nudge to carry it out',
        });
        lastContent = '';
        thread.push({ role: 'assistant', content: response.content });
        harness.push(thread, 'action', zeroActionNudge(currentAsk(opts)));
        continue;
      }
      // SELF-REVIEW (concluding exit) — same bounded pass, placed AFTER the
      // verification/deliverable gates so those settle their questions first.
      const review = selfReviewCorrection();
      if (review) {
        selfReviewNudges += 1;
        stepLimit += 1;
        deps.onEvent?.('   🧭 Substantial turn ending — asking the model to review the result against the original ask.');
        traceEvent({
          kind: 'gate',
          gate: 'self-review',
          summary: 'a substantial turn that changed files reached its end — one bounded nudge to check the result against the original ask',
        });
        thread.push({ role: 'assistant', content: response.content });
        harness.push(thread, 'self-review', review);
        continue;
      }
      // PLAN CLOSE-OUT gate (concluding exit) — the plan was engaged THIS turn
      // and the turn is ending with steps unsettled. Spent LAST so every earlier
      // gate (verify / deliverable / action / self-review) has settled its own
      // question first, and bounded once so it can never nag. It is the direct fix
      // for the frozen checklist (trace-1791542886258-pg42ox: "1/7 steps" for two
      // days): a plan declared and then abandoned mid-turn is worse than none.
      if (planCloseoutNudges < 1 && opts.requirePlan !== false && (planTodoCreates > 0 || planTodoUpdates > 0)) {
        const planSnapshot = opts.context?.planStore?.snapshot?.() ?? null;
        if (planSnapshot && planSnapshot.steps.some((s) => s.status !== 'done')) {
          planCloseoutNudges += 1;
          stepLimit += 1;
          deps.onEvent?.('   📋 The plan this turn opened still has unsettled steps — asking the model to close them out.');
          traceEvent({
            kind: 'gate',
            gate: 'plan-closeout',
            summary:
              'the turn declared or advanced a plan and is ending with steps still open — one bounded nudge to settle them',
          });
          thread.push({ role: 'assistant', content: response.content });
          harness.push(thread, 'plan-closeout', planCloseoutNudge(planSnapshot));
          continue;
        }
      }
      // COMPLETION / DOCS — same two bounded gates as the no-tools exit.
      const closing = closingGates();
      if (closing) {
        stepLimit += 1;
        deps.onEvent?.(closing.event);
        traceEvent({ kind: 'gate', gate: closing.gate, summary: closing.summary });
        thread.push({ role: 'assistant', content: response.content });
        harness.push(thread, closing.gate, closing.nudge);
        continue;
      }
      const content = response.content.length >= lastContent.length ? response.content : lastContent;
      return {
        content,
        followups,
        toolCalls: toolCallsRun,
        steps,
        ...(opts.resume ? { replayedSteps } : {}),
        bounded: false,
        continuations,
        ...(modelHandoffs > 0 ? { modelHandoffs } : {}),
        ...observationsField(),
        termination: 'delivered',
      };
    }
  }

  // Reaching here means the continuation budget is spent (the in-loop check
  // extends the bound otherwise) — the turn is honestly bounded.
  bounded = true;
  // P3 — the exit SAYS which ending this was. The live trace reported "the step
  // budget (17) was reached" after FIVE model calls and zero tool calls: the
  // empty-response path had ended the turn, and this shared tail claimed the road
  // had run out when it had not. A reader cannot tell a model shortage from a
  // budget from that line, which is the whole reason `termination` exists.
  if (exitTermination === 'no-capable-candidate') {
    deps.onEvent?.(
      '   ⚠️ Every model that answered returned nothing usable — ending the turn and reporting exactly what was tried.',
    );
  } else if (exitTermination === 'reasoning-spin') {
    deps.onEvent?.('   🧠 Reasoning-only output kept repeating — ending the turn instead of spinning.');
  } else if (stalledGrants >= 2) {
    // The requirement-driven ending, said in its own words: this turn did not run
    // out of an allowance, it stopped ADVANCING the ask. Two granted rounds left the
    // ledger and the file count exactly where they were, which is the measured
    // definition of spinning — and a count would have hidden which one it was.
    deps.onEvent?.(
      `   ⚠️ Two consecutive budget extensions moved no requirement — ending at ${steps} steps because the turn stopped advancing the ask, not because a cap was hit.`,
    );
  } else if (steps >= maxTotalSteps) {
    deps.onEvent?.(
      `   ⚠️ Absolute step guard reached (${maxTotalSteps}) — the turn was still advancing requirements. Raise \`maxTotalSteps\` to continue past it.`,
    );
  } else {
    deps.onEvent?.(`   ⚠️ Tool loop reached its ${stepLimit}-step budget — returning the last response.`);
  }
  /**
   * THE LAST WORK WAS NOT THE ANSWER, SO SAY WHY IT ENDED.
   *
   * A bounded turn used to deliver its final step's preamble as if it were the
   * reply (measured: "Data collection is complete. Writing the document now."
   * followed by silence, and a separate case whose whole answer was "I reached
   * my step limit for this request."). The user cannot tell a finished turn
   * from a truncated one, which is exactly what a "it stopped mid-way" report
   * is about. The notice is appended to whatever the model had written, so the
   * ending is visible in every surface without hiding the model's own words.
   */
  const planSteps = opts.context?.planStore?.snapshot?.()?.steps ?? [];
  const endingNotice =
    exitTermination === null
      ? boundedEndingNotice({
          stepLimit,
          planSteps,
          changedPaths: [...new Set(progress.mutatedPaths)],
        })
      : null;
  if (endingNotice) {
    // The console line carries the same fact as the delivered text, so a
    // `--json-events` reader and a human see one story.
    deps.onEvent?.(
      `   ⚠️ Step ceiling reached with the task still open — delivering what exists plus how to resume.`,
    );
  }
  // P3 — BUG SIGNAL. Nothing was delivered and the caller could still have
  // handed the work to another model, so this ending is a GAP IN THE ROAD, not a
  // shortage of models. It is said out loud (invariant 2: a failure is never
  // silent) and named on the result, so the caller's report does not have to
  // guess which of the two it was serving the user.
  // `exitTermination === null` is what makes this a BUDGET claim: when the empty
  // path already chose an ending it said WHY (a model shortage, a reasoning
  // spin), and re-labelling that as a budget gap would be the exact dishonesty
  // this work removes — the reason must be the one that actually applied.
  const budgetGapWithCandidates =
    exitTermination === null &&
    lastContent.trim() === '' &&
    !!deps.requestModelSwitch &&
    modelHandoffs < MAX_MODEL_HANDOFFS_PER_TURN;
  if (budgetGapWithCandidates) {
    logger.warn(
      `   ⚠️ the turn ran out of steps with nothing delivered while a model handoff was still available ` +
        `(handoffs used ${modelHandoffs}/${MAX_MODEL_HANDOFFS_PER_TURN}) — this is a BUDGET gap, not a model shortage`,
    );
  }
  traceEvent({
    kind: 'decision',
    gate: 'budget',
    summary: budgetGapWithCandidates
      ? `the step budget (${stepLimit}) was reached with nothing delivered while model handoffs were still available ` +
        `(handoffs used ${modelHandoffs}/${MAX_MODEL_HANDOFFS_PER_TURN}) — a budget gap, not a model shortage`
      : `the step budget (${stepLimit}) was reached — the turn ended on its last response instead of finishing`,
  });
  return {
    content: lastContent
      ? `${lastContent}${endingNotice ? `\n\n${endingNotice}` : ''}`
      : (endingNotice ?? 'I reached my step limit for this request.'),
    followups,
    toolCalls: toolCallsRun,
    steps,
    ...(opts.resume ? { replayedSteps } : {}),
    bounded: true,
    continuations,
    ...(modelHandoffs > 0 ? { modelHandoffs } : {}),
    ...observationsField(),
    // An exit the empty/think path chose says exactly why; otherwise the road
    // simply ran out, and `budget-exhausted` admits that rather than dressing it
    // up as a model shortage.
    termination: exitTermination ?? 'budget-exhausted',
  };
}

// ─── Honest-answer guard ────────────────────────────────────────────────────
// Tools whose successful execution is what actually performs an outbound
// delivery. If one of these ran, a "sent it" sentence is truthful.
const DELIVERY_TOOL_NAMES = new Set(['gateway_send']);

/**
 * The tools that are GUARANTEED to change a file — the only ones that justify
 * snapshotting the tree first.
 *
 * Deliberately narrower than `FILE_WRITE_CAPABLE_TOOLS`: that set includes the
 * shell, and most shell commands read. Snapshotting before an `ls` would pay the
 * walk for nothing, and the walk is the only cost this net has.
 */
const PRE_WRITE_CHECKPOINT_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'patch_file',
]);

/**
 * Bound the AUTOMATIC checkpoints: every Nth take prunes the store back to
 * `DEFAULT_AUTO_KEEP`.
 *
 * The net is one checkpoint per turn that writes, and nothing used to remove them —
 * MEASURED (2026-10-30): a few weeks of use left 1,120 checkpoints / ~966 MB of
 * manifests, which is the disk the projects live on. Pruning needs a directory
 * listing, so it is paid on a tenth of the turns: without a bound the store grows
 * without limit, and on every turn is a cost the write path does not owe. The
 * newest `keep` are exactly the ones a rollback of "what the agent just did" wants.
 *
 * Only checkpoints this loop marked (`origin: 'loop'`) are candidates — a
 * checkpoint the USER asked for is never auto-deleted.
 */
const AUTO_CHECKPOINT_PRUNE_EVERY = 10;

/**
 * Whether the Nth automatic checkpoint (1-based) is the one that bounds the store.
 *
 * A function rather than an inline `%` so the rule can be pinned without driving
 * ten turns first — the arithmetic is the part that can be wrong.
 */
export function shouldPruneAutoStore(taken: number): boolean {
  return taken > 0 && taken % AUTO_CHECKPOINT_PRUNE_EVERY === 0;
}

/** Automatic checkpoints taken by this process (module-level: one CLI = one store). */
let workspaceCheckpointsTaken = 0;

/**
 * True when a delivery-tool RESULT reports an actual delivery.
 *
 * `gateway_send` never throws: a failed send returns a `⚠️`/`🚫`/unknown-target
 * string, and the tool only writes `gateway_send: ✅ sent …` when the transport
 * accepted the message. So "the tool ran" is not the same as "the message was
 * delivered" — observed live: a WhatsApp send that was never received still
 * produced "I have sent…" and a trace reading "✅ action performed — message
 * sent", because delivery was inferred from the attempted tool NAME.
 */
function deliveryResultSucceeded(resultText: string): boolean {
  return /^gateway_send:\s*✅/m.test((resultText || '').trim());
}

/** Past-tense sentences that ASSERT a completed delivery/action. */
const DELIVERY_CLAIM_RE = [
  /\bi(?:'ve| have)\s+(?:just\s+|now\s+|also\s+)*(?:sent|delivered|forwarded|shared|messaged|texted|emailed)\b/i,
  /\bi\s+(?:just\s+|already\s+)*(?:sent|delivered|forwarded|shared|messaged|texted|emailed)\b/i,
  /\b(?:the\s+)?(?:message|poem|note|photo|image|file|it|that|this|result)\s+(?:has been|was|have been|is)\s+(?:sent|delivered|forwarded|shared|emailed|messaged)\b/i,
  /\bsuccessfully\s+(?:sent|delivered|forwarded|shared|emailed|messaged)\b/i,
  /\b(?:it|that|this|the\s+\w+)\s+(?:has been|was)\s+(?:delivered|sent)\s+to\b/i,
];

/** A sentence that is future/interrogative/negated is NOT a completed claim. */
const NON_CLAIM_CONTEXT_RE =
  /\b(?:not|n't|never|unable|cannot|can't|couldn't|didn't|won't|will|would|should|could|can|may|might|going to|about to|try(?:ing)? to|attempt|if you|let me|shall i|should i|do you want|i'?ll)\b/i;

/**
 * True when the answer asserts a delivery that no delivery tool performed.
 * Sentence-scoped so a negation or a future promise elsewhere in the answer
 * never turns a truthful statement into a flag (and vice-versa).
 *
 * This is the "unverified claim" detector — the model may write a tool call as
 * plain prose, or skip tools entirely and simply SAY the action succeeded.
 * A JSON-as-text call is recovered by the loop's salvage step (so the tool
 * really runs and the flag stays false); this catches the residual case where
 * there is no tool call at all.
 */
export function detectUnverifiedDeliveryClaim(content: string, toolsRun: readonly string[]): boolean {
  const text = (content || '').trim();
  if (!text) return false;
  if (toolsRun.some((n) => DELIVERY_TOOL_NAMES.has(n))) return false;
  // Split on sentence boundaries; test each independently.
  const sentences = text.split(/(?<=[.!?\u3002\uff01\uff1f])\s+|\n+/);
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s || NON_CLAIM_CONTEXT_RE.test(s)) continue;
    if (DELIVERY_CLAIM_RE.some((re) => re.test(s))) return true;
  }
  return false;
}

/**
 * Tools whose SUCCESS means a file could have been written, even though the loop
 * cannot see it: an editor (tracked in `mutatedPaths`), a shell whose command
 * redirected a file, an executed snippet. Used only to keep the file-claim guard
 * conservative — if any of these SUCCEEDED, the turn's own record does not
 * contradict a "I wrote the file" claim, so the guard stays silent.
 */
const FILE_WRITE_CAPABLE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'multi_edit',
  'patch_file',
  'run_terminal',
  'run_cli',
  'code_execution',
]);

/**
 * Past-tense sentences that ASSERT a FILE was produced. Deliberately about
 * writing/creating/saving a file — not about reading one, and not about sending
 * one (`detectUnverifiedDeliveryClaim` covers sends).
 */
const FILE_WRITE_CLAIM_RE: readonly RegExp[] = [
  /\b(?:has|have)\s+been\s+(?:written|saved|created|produced|generated)\b/i,
  /\bi(?:'ve|\s+have)\s+(?:just\s+|now\s+|successfully\s+)?(?:written|saved|created|produced|generated)\b/i,
  /\b(?:the\s+)?(?:file|document|guide|report|chapter|artifact|deliverable|write-?up|script|manifest)\b[^.]{0,50}\b(?:now\s+)?contains\b/i,
  /\b(?:written|saved|created|produced|generated)\s+(?:it\s+)?(?:to|into)\s+(?:disk\b|\S+\.\w{1,6}\b)/i,
  /\b(?:the\s+)?(?:file|document|report|guide|artifact|deliverable)\b[^.]{0,40}\b(?:is|are)\s+(?:now\s+)?(?:on\s+disk|written|saved|created|ready)\b/i,
];

/**
 * True when the answer CLAIMS a file was produced and the turn's own record says
 * none was. This is the sibling of `detectUnverifiedDeliveryClaim` (which covers
 * SENDS), and it closes a gap found live: a turn wrote nothing, then replied
 * "The guide has been written and saved as GUIDE.md … contains a full ~5,000-word
 * technical guide", and NO flag could see it.
 *
 * Why it is not redundant with `undeliveredArtifact`: that flag is a function of
 * the ASK (it is gated on the request classifying as an authored deliverable), so
 * an ask the classifier does not recognise — or a plain code ask that happens to
 * be answered with a fabricated "I saved it" — produced no disclosure at all. This
 * one is a function of what the turn DID: a completed file claim, contradicted by
 * the absence of any write. The two are made mutually exclusive at the call site so
 * one turn is never reported under two names.
 *
 * Conservative by construction, so an honest turn is never flagged: it fires only
 * when NOTHING was mutated AND no write-capable tool succeeded; a heredoc through
 * `run_terminal`, an `edit_file`, or any executed snippet therefore exempts the
 * turn, because the run's record cannot contradict the claim.
 */
export function detectUnverifiedFileClaim(
  content: string,
  evidence: { mutatedPaths: readonly string[]; successfulToolCalls: readonly string[] },
): boolean {
  const text = (content || '').trim();
  if (!text) return false;
  if (evidence.mutatedPaths.length > 0) return false;
  if (evidence.successfulToolCalls.some((n) => FILE_WRITE_CAPABLE_TOOLS.has(n))) return false;
  const sentences = text.split(/(?<=[.!?\u3002\uff01\uff1f])\s+|\n+/);
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s || NON_CLAIM_CONTEXT_RE.test(s)) continue;
    if (FILE_WRITE_CLAIM_RE.some((re) => re.test(s))) return true;
  }
  return false;
}

/**
 * Tool-shaped actions a first-person imminent promise can drop. Matched by
 * STEM (`\w*` suffix) so "scaffold" covers "scaffolding", "write" covers
 * "writing", etc. — the promise is usually phrased as a gerund ("start by
 * scaffolding").
 */
/**
 * Bundle 23 (item 13) — how far short of a stated magnitude counts as a miss.
 * Half, deliberately: "about 5000 words" delivered as 4,200 is a tighter draft,
 * not a shortfall, and an over-eager version of this flag would be ignored like
 * every other noisy guard. Under half is materially not what was asked for.
 */
export const ARTIFACT_SHORTFALL_RATIO = 0.5;

/**
 * How much of a delivered artifact travels to the corpus (item 13). Bounded on
 * purpose: a candidate row is a SAMPLE to fit a signal to, not a copy of the
 * user's document, and an unbounded row would turn a collection file into a
 * second copy of everything the agent ever wrote.
 */
export const AUTHORED_DELIVERABLE_EXCERPT_MAX = 2000;

/**
 * Compare a written artifact against an EXPLICIT magnitude the ask named.
 *
 * This is item 13's honest half: the delivered artifact is measured AGAINST THE
 * REQUEST, deterministically, instead of judging quality from a model's
 * vocabulary. It fires only when the ask states a number ("about 5000 words",
 * "a 100 page story") — a plain "write a long document" names no magnitude, so
 * there is nothing to compare against and this must not invent one.
 *
 * Returns null unless the file is under `ARTIFACT_SHORTFALL_RATIO` of the target,
 * so an honest document is never flagged. An empty file returns null too — a
 * missing artifact is the omission/undelivered gates' job, not a shortfall's.
 */
export function detectArtifactShortfall(
  ask: string,
  artifact: { path: string; content: string; words?: number },
): { path: string; deliveredWords: number; targetWords: number; source: string } | null {
  const target = parseLongFormTarget(ask || '');
  // Only an EXPLICIT magnitude counts: `source` is the quoted number the parser
  // matched, while the default-book branch (a book with no number in the ask) has
  // no quotes — inventing a target there would measure the document against a
  // number the user never said.
  if (!target || !target.source.startsWith('"')) return null;
  // `words` is the count of the FULL artifact when the caller supplies it; counting
  // `content` (which may be a capped prefix) instead would measure the storage
  // limit, not the document, and could flag a long deliverable as short.
  const deliveredWords = artifact.words ?? countWords(artifact.content);
  if (deliveredWords === 0) return null;
  if (deliveredWords >= target.wordsTarget * ARTIFACT_SHORTFALL_RATIO) return null;
  return {
    path: artifact.path,
    deliveredWords,
    targetWords: target.wordsTarget,
    source: target.source,
  };
}

const INTENT_ACTION_STEM =
  '(?:creat|writ|build|scaffold|implement|generat|add|edit|updat|modif|refactor|run|execut|install|configur|read|inspect|send|post|upload|deploy|publish|fetch|search|apply|fix|delet|remov|mov|renam|copi|compil|set\\s+up)';

/**
 * A first-person IMMINENT promise to act. Immediacy is required, because that
 * is what separates "I am doing this next, in this turn" (a dropped intent)
 * from "I will create a routine for her" (a description of the deliverable).
 * Four shapes cover the real phrasings:
 *   - "Let me now create the files."          (let me …)
 *   - "I will now scaffold the project."      (immediacy adverb)
 *   - "I'll start by reading the config."     (start/begin by …)
 *   - "I will go ahead and implement it."     (go ahead and …)
 */
const INTENT_PROMISE_RES: readonly RegExp[] = [
  new RegExp(
    `\\blet me\\s+(?:now\\s+|then\\s+|first\\s+|just\\s+)*` +
      `(?:start\\s+by\\s+|begin\\s+by\\s+|start\\s+|begin\\s+|go\\s+ahead\\s+and\\s+)?(?:${INTENT_ACTION_STEM}\\w*)`,
    'i',
  ),
  new RegExp(
    `\\bi(?:'ll| will| am going to| am about to|'m going to)\\s+` +
      `(?:now|next|first|immediately|right\\s+away)\\s+` +
      `(?:start\\s+by\\s+|begin\\s+by\\s+|start\\s+|begin\\s+|go\\s+ahead\\s+and\\s+)?(?:${INTENT_ACTION_STEM}\\w*)`,
    'i',
  ),
  new RegExp(
    `\\bi(?:'ll| will| am going to| am about to|'m going to)\\s+(?:start|begin)\\s+by\\s+(?:${INTENT_ACTION_STEM}\\w*)`,
    'i',
  ),
  new RegExp(
    `\\bi(?:'ll| will| am going to| am about to|'m going to)\\s+` +
      `(?:go\\s+ahead\\s+and|proceed\\s+to|get\\s+right\\s+to)\\s+(?:${INTENT_ACTION_STEM}\\w*)`,
    'i',
  ),
];

/** A list means a deliverable was produced (a plan enumerates phases). */
const LIST_STRUCTURE_RE = /^[ \t]*(?:[-*•·]|\d+[.)])\s+\S/m;

/**
 * A CONDITIONAL or interrogative promise is not dropped intent — "I will send
 * it once you confirm" is an offer, and "shall I proceed?" is a question. Only
 * an unconditional, declarative promise is a dangling one.
 */
const PROMISE_CONDITION_RE =
  /\b(?:if|once|when|after|unless)\s+(?:you|your|i\s+(?:get|receive|hear)|approved|confirmed|permission)\b|\b(?:shall|should)\s+i\b|\bdo you want\b|\blet me know\b|\bwould you\b|\byour\s+(?:approval|go-?ahead|confirmation|permission|ok)\b|\?/i;

/**
 * True when the answer CLOSES on an unconditional first-person promise to take
 * a tool-shaped action — the "I will begin by scaffolding…" shape that ends a
 * turn with nothing done.
 *
 * Deliberately narrow, because crying wolf is worse than staying silent:
 * - Only the closing sentences are judged; a promise mid-answer followed by
 *   real work is narration, not a dropped intent.
 * - An answer containing a list is never a dangling promise — a plan
 *   enumerates, and a prose answer that stops is what this catches.
 * - Immediacy is required ("I will NOW …", "Let me …", "I'll start by …"), so
 *   a descriptive future ("I will create a routine for her") is not a promise.
 * - Conditional/interrogative promises and pure chat verbs (explain, describe,
 *   summarise) are excluded.
 */
export function detectUnfulfilledIntentPromise(content: string): boolean {
  const text = (content || '').trim();
  if (!text) return false;
  if (LIST_STRUCTURE_RE.test(text)) return false;
  const sentences = text
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // Judge only the closing few sentences (the promise that ends the turn).
  for (const sentence of sentences.slice(-3).reverse()) {
    if (!INTENT_PROMISE_RES.some((re) => re.test(sentence))) continue;
    if (PROMISE_CONDITION_RE.test(sentence)) return false;
    return true;
  }
  return false;
}

// ─── Bundle 19 — an artifact that declares ITSELF incomplete ────────────────
/**
 * Statements an ARTIFACT makes about being incomplete — read from the file the turn
 * WROTE, never from the model's prose.
 *
 * WHY THIS EXISTS (measured 2026-10-07). Asked for a ~2500-word design document, a
 * real turn wrote 25 words to `DESIGN.md` and reported success. The file contained
 * `## 1. Introduction ... (full content omitted for brevity) ...` — it announced the
 * content and then omitted it — and its own verification ("read the file back and
 * confirm all sections are present") is true of a list of headings. No existing flag
 * could see it: `unverifiedEdit` needs an unobserved mutation (the file WAS read
 * back), `undeliveredArtifact` needs nothing written (a file exists), and there is
 * content, so nothing is empty.
 *
 * WHY THIS IS NOT A "PHRASE LIST" IN THE SENSE THIS PROGRAMME REMOVES. Those decide
 * whether work is GOOD, from a model's vocabulary. This reads a factual statement the
 * artifact makes about itself — the same distinction as `unfulfilledPromise` (an
 * announced action) and `detectUnverifiedDeliveryClaim` (a claim contradicted by the
 * run). A document saying "content omitted" is not a quality judgement; it is the
 * artifact reporting its own incompleteness.
 *
 * DELIBERATELY NARROW. Each pattern requires an OMISSION word bound to content or a
 * section. The bare word `placeholder` is NOT matched (HTML `placeholder=` attributes
 * would fire on ordinary code), and neither is a bare `TODO` — a TODO is a plan for
 * later work, not a claim that this file is finished.
 */
const ARTIFACT_OMISSION_RE: readonly RegExp[] = [
  /\(\s*(?:the\s+)?(?:full\s+)?content\s+omitted/i,
  /\bcontent\s+(?:is\s+|was\s+)?omitted\s+for\s+(?:brevity|space|length|conciseness|readability)\b/i,
  /\bomitted\s+for\s+(?:brevity|space|length|conciseness|readability)\b/i,
  /\b(?:the\s+)?(?:rest|remainder)\s+of\s+(?:this\s+)?(?:document|report|article|file)\s+(?:is|are|was|were)?\s*(?:omitted|not\s+included|intentionally\s+left\s+out)/i,
  // A section RANGE may sit between the noun and the adverb/verb: the measured
  // "Sections 2-9 intentionally omitted." failed the adjacency form that only
  // allowed whitespace there. The range is optional, so "Content omitted." and
  // "Details omitted." still match; a bare prose "omits" does not.
  /\b(?:sections?|content|details?)\s+(?:\d+(?:\s*[-–—]\s*\d+)?\s+)?(?:intentionally\s+|deliberately\s+)?omitted\b/i,
  /\bplaceholder\s+for\s+(?:the\s+)?(?:full|actual|real|complete)\s+(?:content|document|section|report|article)\b/i,
];

/**
 * The statement an artifact makes about its own incompleteness, or `null`.
 * Returns the MATCHED TEXT so the report can quote what the file said about itself.
 */
export function detectSelfDeclaredOmission(text: string): string | null {
  const body = text || '';
  if (!body) return null;
  for (const re of ARTIFACT_OMISSION_RE) {
    const m = body.match(re);
    if (m?.[0]) return m[0].trim();
  }
  return null;
}

/** Cap on the content kept per artifact, and on how many are kept, so a long turn cannot grow the loop's memory. */
const AUTHORED_ARTIFACT_MAX_CHARS = 20_000;
const AUTHORED_ARTIFACT_MAX = 40;

/**
 * The text a mutation call WROTE, from whichever field carries it. `''` when the call
 * carries no literal body (an append by path, a patch with no text).
 */
/**
 * The text a write actually carried — UNCAPPED, so a caller can measure the WHOLE
 * artifact (word count) and cap only what it stores. Capping here would make the
 * measurement a property of the storage limit rather than of the file.
 */
function extractWrittenText(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  for (const key of ['content', 'new_string', 'newText', 'text', 'body', 'patch']) {
    const v = a[key];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

// ─── Build honesty (A3 Part 2) ──────────────────────────────────────────────
/**
 * Past-tense sentences that ASSERT a BUILD, or its artifact, came out good.
 * Deliberately about a build/artifact and not about tests or edits: "all tests
 * pass" and "I fixed the parser" are other guards' territory, and widening the
 * claim set is how a guard starts crying wolf.
 */
const BUILD_SUCCESS_CLAIM_RE: readonly RegExp[] = [
  /\b(?:successfully\s+)?(?:re-?built|recompiled|repackaged)\b/i,
  /\b(?:built|compiled|packaged|bundled|produced|generated)\s+(?:successfully|cleanly|without\s+(?:errors?|issues?|warnings?))\b/i,
  /\bsuccessfully\s+(?:built|compiled|packaged|bundled|generated|rebuilt|launched)\b/i,
  /\b(?:the\s+)?(?:build|rebuild|compilation|compile|packaging|bundle|bundling)\s+(?:succeeded|passed|completed\s+successfully|is\s+(?:green|clean|successful|complete|done))\b/i,
  /\b(?:launches?|starts?|runs?|boots?)\s+(?:without\s+(?:crash\w*|errors?|issues?|problems?)|successfully|fine|correctly|smoothly|cleanly)\b/i,
  /\b(?:the\s+)?(?:app|application|binary|artifact|build|bundle|executable|program|tool)\s+(?:now\s+)?(?:works|launches|runs|starts|boots|is\s+(?:working|fixed|rebuilt|functional|up\s+and\s+running|complete))\b/i,
];

/**
 * A sentence that NEGATES or qualifies a build result is not a success claim.
 *
 * Distinct from `NON_CLAIM_CONTEXT_RE` (tuned for delivery promises) because
 * "without errors" / "without crashing" are POSITIVE phrasings that a blanket
 * `error`/`crash` block would wrongly reject — the alternation requires the
 * literal "with … errors", which "without errors" does not contain.
 */
const BUILD_NEGATIVE_RE =
  /\b(?:not|n't|never|unable|cannot|can't|couldn't|didn't|doesn't|hadn't|hasn't|fail(?:ed|s|ure)?|broke|broken|refus(?:e|ed|es)|with\s+(?:\d+\s+)?(?:errors?|warnings?|failures?|issues?))\b/i;

/**
 * True when the turn's OWN evidence contradicts its prose: a build command it
 * ran FAILED, no later build succeeded, and the answer still asserts the
 * artifact came out good.
 *
 * The live failure this closes (Aukat_check, 2026-10-02): `pyinstaller
 * AukatCheck.spec` exited 1 (stale `dist/`), the model opened the OLD app and
 * reported "The app is now successfully built and functional." The run knew the
 * build failed; the answer said otherwise; nothing compared the two.
 *
 * Conservative by construction, so an honest turn is never flagged:
 *   - only BUILD commands count (`isBuildCommand`), the same set the effect
 *     check uses — a failing `npm test` from a code edit is unaffected;
 *   - a build that succeeded AFTER the last failure is a real recovery, and no
 *     flag fires (the evidence now supports the claim);
 *   - the claim must be a completed, positive assertion — a negation, a
 *     condition, a future tense or a question is skipped, sentence by sentence.
 */
export function detectFailedBuildSuccessClaim(
  content: string,
  actions: readonly ExecutedAction[],
): boolean {
  const text = (content || '').trim();
  if (!text) return false;
  const builds = actions.filter((a) => typeof a.command === 'string' && isBuildCommand(a.command));
  if (builds.length === 0) return false;
  const lastFailure = builds.map((a) => a.ok).lastIndexOf(false);
  if (lastFailure === -1) return false;
  // A successful build after the last failure IS the verification the claim
  // needs; the turn did recover.
  if (builds.slice(lastFailure + 1).some((a) => a.ok)) return false;
  const sentences = text.split(/(?<=[.!?。！？])\s+|\n+/);
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if (NON_CLAIM_CONTEXT_RE.test(s) || BUILD_NEGATIVE_RE.test(s)) continue;
    if (BUILD_SUCCESS_CLAIM_RE.some((re) => re.test(s))) return true;
  }
  return false;
}

/**
 * Public entry point. Runs the loop, then annotates the result with the
 * honest-answer flags so every surface (CLI, dashboard, gateway, trace) can
 * distinguish "generated a reply" from "actually performed the action".
 */
/**
 * Keep ONE route frame in the thread, current with what is serving the turn.
 *
 * Insert/replace is deliberate: appending a frame per step would pile up stale
 * route claims the model can quote back ("I am gemini-2.5-flash" — from step 1,
 * after a failover), and rewriting unconditionally would churn the thread (and
 * the thread budget) on every step for no change in content.
 *
 * A caller with no route supplies nothing; a caller whose route resolves to the
 * same fact as last step gets no write.
 */
/**
 * Read the served route, safely. A caller's getter is application code: a throw
 * there must never break a turn, and "unknown route" is a fact the loop can act
 * on (it falls back to per-call trimming — see `learning/prompt-cache.ts`).
 */
function readServedRoute(read: (() => ServedRoute | null) | undefined): ServedRoute | null {
  if (!read) return null;
  try {
    return read() ?? null;
  } catch {
    return null;
  }
}

function syncRouteFeed(
  thread: ToolMessage[],
  route: ServedRoute | null,
  observed: { pairs: string[] },
): void {
  if (!route) return;

  // The loop OWNS the failover history, because the loop is the only thing that
  // sees the sequence of routes it told the model about. Requiring each caller
  // to track it means every future caller can silently forget, and a model told
  // only the current pair describes the whole turn as having been run by it —
  // the same fabricated answer, one layer down.
  const currentPair = isUnresolvedModel(route.model) ? '' : `${route.providerType}/${route.model}`;
  const previous = [...(route.previous ?? [])];
  for (const pair of observed.pairs) {
    if (pair !== currentPair && !previous.includes(pair)) previous.push(pair);
  }
  const rendered: ServedRoute = previous.length > 0 ? { ...route, previous } : route;

  const fingerprint = routeFeedFingerprint(rendered);
  const index = thread.findIndex(
    (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(ROUTE_FEED_MARKER),
  );

  if (currentPair && !observed.pairs.includes(currentPair)) observed.pairs.push(currentPair);

  if (index === -1) {
    const frame: ToolMessage = { role: 'system', content: routeFeedText(rendered) };
    // Immediately after the leading system prompt when there is one — the route
    // belongs with the run's own framing, not buried under tool output.
    const insertAt = thread.length > 0 && thread[0].role === 'system' ? 1 : 0;
    thread.splice(insertAt, 0, frame);
    routeFeedFingerprints.set(frame, fingerprint);
    return;
  }

  const existing = thread[index];
  if (routeFeedFingerprints.get(existing) === fingerprint) return;
  const updated: ToolMessage = { role: 'system', content: routeFeedText(rendered) };
  thread[index] = updated;
  routeFeedFingerprints.delete(existing);
  routeFeedFingerprints.set(updated, fingerprint);
}

/**
 * Fingerprint per frame object, so a thread that was trimmed and re-built does
 * not re-write identical content. A WeakMap: a frame the loop drops is garbage
 * the moment nothing references it.
 */
const routeFeedFingerprints = new WeakMap<ToolMessage, string>();

export async function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const progress: ToolLoopProgress = {
    successfulToolCalls: [],
    deliveryConfirmed: false,
    mutatedPaths: [],
    authoredArtifacts: [],
    verificationEvidence: [],
    executedActions: [],
    checkRuns: [],
  };
  // COVERAGE, DURABLE AT THE TURN BOUNDARY. The notes recorded during the turn
  // are flushed here on EVERY exit path — an answer, a cancellation, or a throw —
  // so what was examined survives a turn that never reached its own end. This is
  // the write half of "a broken run is n times faster": the next run reads it.
  const result = await runToolLoopInner(opts, progress).finally(() => {
    try {
      flushCoverage();
    } catch {
      // Best-effort — coverage bookkeeping never breaks a turn.
    }
  });
  // R2 — relay the transport the caller's seam reported. Attached on EVERY
  // exit path, including a cancelled/failed turn: if a model call happened over
  // the JSON fallback before the turn died, that is a fact about the run.
  if (progress.transport) result.transport = progress.transport;
  // The undo point travels on the result, so a surface that prints nothing but the
  // answer still carries the id a user needs to roll a bad batch back.
  if (progress.workspaceCheckpointId) result.workspaceCheckpointId = progress.workspaceCheckpointId;
  if (!result.cancelled && !result.generationFailed) {
    result.successfulToolCalls = [...progress.successfulToolCalls];
    result.deliveryConfirmed = progress.deliveryConfirmed;
    // Stage 2 — the turn's own behaviour, as counts (see learning/run-trace.ts).
    result.runTrace = progress.runTrace?.snapshot();
    // Judge the "I have sent it" claim against what actually DELIVERED, not
    // against the attempted tool list — a failed gateway_send must not silence
    // the honesty correction.
    if (detectUnverifiedDeliveryClaim(result.content, result.successfulToolCalls)) {
      result.unverifiedActionClaim = true;
    }
    // A3 PART 2 — BUILD HONESTY. The run's OWN ledger says a build command
    // FAILED and no later build succeeded; if the answer still asserts the
    // artifact came out good, it contradicts the evidence in the same turn.
    // Gated on the ledger, not on configuration: an honest turn is unaffected.
    if (detectFailedBuildSuccessClaim(result.content, progress.executedActions)) {
      result.unverifiedBuildClaim = true;
    }
    // Residual dangling promise: the bounded nudge either got the action
    // carried out (then a tool succeeded and this cannot fire) or it did not.
    // Gated on NOTHING having succeeded, so a turn that partially completed
    // and narrates remaining work is never reported as a dropped intent.
    if (result.successfulToolCalls.length === 0 && detectUnfulfilledIntentPromise(result.content)) {
      result.unfulfilledPromise = true;
    }
    // G1 + G2 — EDIT honesty. Classify what the turn actually did: a workspace
    // mutation with no observing run is an UNVERIFIED edit, and any completed
    // code-change assertion in the answer is then an unverified claim. This
    // runs whether or not the nudge was enabled, so the flag is never a
    // function of configuration.
    const activity = assessEditActivity(
      result.successfulToolCalls,
      progress.verificationEvidence,
      progress.mutatedPaths,
      opts.context.cwd ?? process.cwd(),
    );
    // The PER-FILE split of that judgement, so the caller's ledger owes a check
    // on the paths nothing exercised rather than on the turn as a whole. A root
    // `npm test` never loaded a nested package's suite, and until now the ledger
    // could not tell — it recorded a count, so any verification settled the lot.
    result.verifiedPaths = activity.verifiedPaths;
    result.unverifiedPaths = activity.unverifiedPaths;
    // COMPLETION CONTRACT — what the ask named and this turn did NOT satisfy.
    // Computed here, on ONE path, so every ending (delivered, bounded, silence)
    // reports the same residual instead of each exit deciding for itself.
    const ledgerAsk = currentAsk(opts);
    const askRows = buildRequirementLedger(ledgerAsk);
    if (askRows.length > 0) {
      const cwd = opts.context.cwd ?? process.cwd();
      const ledger = resolveRequirementLedger(askRows, {
        cwd,
        checks: progress.checkRuns.map((c) => ({
          kinds: c.kinds,
          ok: c.ok,
          ...(c.command ? { command: c.command } : {}),
          tool: c.tool,
        })),
        mutatedPaths: progress.mutatedPaths,
      });
      if (ledger.unmet.length > 0) result.unmetRequirements = describeUnmet(ledger.unmet, 8);
      const writtenSources = [...new Set(progress.mutatedPaths)].filter((p) => isSourceModule(p, cwd));
      const binding = testBindingApplies({
        buildShapedAsk: isBuildShapedAsk(ledgerAsk),
        moduleCount: writtenSources.length,
      })
        ? bindWrittenModulesToTests({ cwd, writtenPaths: writtenSources })
        : null;
      const tokens = opts.turnTokenCount?.();
      const satisfied = ledger.satisfied.length;
      // THE MODEL'S OWN GAP LIST REACHES THE USER. `finish({verified:false, unmet})`
      // tells the model the list "will be given to the user verbatim"; without this
      // annotation that promise would be false on the one path where it matters.
      // Appended here, on the single exit the caller reads, so no surface has to
      // remember to render it.
      const claimUnmet = progress.finishClaim?.unmet ?? [];
      if (claimUnmet.length > 0) {
        result.unmetRequirements = [
          ...new Set([...(result.unmetRequirements ?? []), ...claimUnmet]),
        ];
        const list = claimUnmet.slice(0, 8).map((u) => `- ${u}`).join('\n');
        result.content = `${result.content.trimEnd()}\n\n**Not done in this turn**\n${list}`.trim();
      }
      result.requirementYield = {
        total: ledger.rows.length,
        satisfied,
        unmet: ledger.unmet.length,
        unknown: ledger.unknown.length,
        ...(binding
          ? { testBinding: { modules: binding.written.length, bound: binding.bound.length, ratio: binding.ratio } }
          : {}),
        ...(typeof tokens === 'number' && tokens > 0 && satisfied > 0
          ? { tokensPerSatisfiedRequirement: Math.round(tokens / satisfied) }
          : {}),
      };
    }
    // Bundle 21/25 — the authored-document demotion, applied WHERE THE FLAGS ARE
    // SET so every surface agrees without a per-caller conditional: the trace
    // outcome, the console warning, the working-state ledger and the turn report all
    // read these two flags. For an authored deliverable that was written and then
    // READ BACK, the read-back IS the meaningful check — a code-style "no observing
    // run" verdict would contradict the `delivered-and-read-back` verdict the report
    // deliberately produces. Measured live: a turn that wrote and read back GUIDE.md
    // recorded `unverifiedEdit: true` on the trace while its report said
    // `delivered-and-read-back`.
    const authoredReadBack = isAuthoredReadBack(
      lastUserText(opts.messages),
      result.successfulToolCalls,
    );
    if (activity.needsVerification && !authoredReadBack) {
      result.unverifiedEdit = true;
    }
    if (
      detectUnverifiedEditClaim(result.content, activity.mutations, activity.verifications) &&
      !authoredReadBack
    ) {
      result.unverifiedEditClaim = true;
    }
    // Bundle 19 — ARTIFACT honesty. A file the turn wrote says its own content was
    // omitted, so the turn is NOT finished work however complete its prose reads.
    // Judged on the artifact, never on the model's vocabulary, and recorded with the
    // artifact's own words so a reader can see exactly what it admitted.
    for (const artifact of progress.authoredArtifacts) {
      const statement = detectSelfDeclaredOmission(artifact.content);
      if (statement) {
        result.artifactIncomplete = { path: artifact.path, statement };
        break;
      }
    }
    // Bundle 23 (item 13) — ARTIFACT-VS-ASK honesty. When the ask named an explicit
    // magnitude and the turn wrote a SINGLE artifact far short of it, the delivered
    // file is not what was asked for. Skipped when the artifact already admits its
    // own omission (that is the stronger, self-incriminating signal), and bounded to
    // one artifact because an append/sectioned delivery cannot be measured here
    // without risking a false "short".
    if (!result.artifactIncomplete && progress.authoredArtifacts.length === 1) {
      const shortfall = detectArtifactShortfall(lastUserText(opts.messages), progress.authoredArtifacts[0]);
      if (shortfall) result.artifactShortfall = shortfall;
    }
    // Item 13 (round 3) — COLLECT the case a quality signal would have to be fit
    // to, instead of inventing a rule for it. A single authored artifact that
    // tripped NEITHER check above is the "fluent, on-length" shape: the one no
    // live run has produced as a miss, and the one no deterministic rule can judge
    // (judging it from vocabulary is the defect this programme exists to remove).
    // So the FACTS travel — path, length, a bounded excerpt — and a caller records
    // them with a later user verdict as the label. No judgement is made here.
    if (!result.artifactIncomplete && !result.artifactShortfall && progress.authoredArtifacts.length === 1) {
      const artifact = progress.authoredArtifacts[0];
      const ask = lastUserText(opts.messages) || '';
      const target = parseLongFormTarget(ask);
      result.authoredDeliverable = {
        path: artifact.path,
        deliveredWords: artifact.words,
        // Only an EXPLICIT magnitude is carried — `source` is the quoted number the
        // parser matched, while the default-book branch invents one. A corpus that
        // recorded an invented target would fit a signal to a number nobody asked for.
        ...(target && target.source.startsWith('"') ? { targetWords: target.wordsTarget } : {}),
        excerpt: artifact.content.slice(0, AUTHORED_DELIVERABLE_EXCERPT_MAX),
      };
    }
    // G13b — DELIVERABLE honesty, the same way and for the same reason: the
    // flag is a function of what the turn DID, never of configuration. A turn
    // that was asked for a file and wrote none must not be readable as
    // "finished" by any caller, whether or not the gate was enabled.
    if (
      !result.cancelled &&
      progress.mutatedPaths.length === 0 &&
      !replyAsksTheReader(result.content) &&
      // A request that forbade writes cannot have "failed to deliver" a file.
      !requestForbidsWrites(lastUserText(opts.messages)) &&
      // The same predicate the gate above demands the file with, so "an artifact
      // was asked for" cannot mean two different things in two places: a short
      // poem answered in chat is not a turn that failed to deliver a file.
      asksForAuthoredFile(lastUserText(opts.messages))
    ) {
      result.undeliveredArtifact = true;
    }
    // Bundle 20 — FILE-CLAIM honesty, the complement of the flag above. That one
    // is a function of the ASK; this is a function of the ANSWER: a reply that says
    // a file was produced while the turn mutated nothing. Skipped when
    // `undeliveredArtifact` already fired, so one turn is never reported under two
    // names.
    if (
      !result.undeliveredArtifact &&
      detectUnverifiedFileClaim(result.content, {
        mutatedPaths: progress.mutatedPaths,
        successfulToolCalls: result.successfulToolCalls,
      })
    ) {
      result.unverifiedFileClaim = true;
    }
    // ZERO-ACTION honesty — a request that DIRECTED work on the workspace was
    // answered with nothing at all: no tool succeeded, nothing was written. The
    // flag is a function of what the turn DID, never of configuration, so a
    // caller can never read "completed" from a turn whose request it never
    // touched. Authored-artifact asks are left to `undeliveredArtifact` above so
    // one turn is never reported under two names.
    const askText = lastUserText(opts.messages);
    if (
      !hasProductiveAction(progress) &&
      progress.mutatedPaths.length === 0 &&
      requestRequiresWorkspaceAction(askText, requestAuthorizesWrites(askText).authorized)
    ) {
      result.noActionTaken = true;
    }
    // UNCHANGED-WORKSPACE honesty (measured 2026-10-09). A CHANGE was asked for,
    // nothing was mutated, and the answer is the model's plan or promise rather
    // than the work. Left to `undeliveredArtifact` when that already fired, so one
    // turn is never reported under two names.
    if (
      !result.cancelled &&
      !result.undeliveredArtifact &&
      progress.mutatedPaths.length === 0 &&
      requestRequiresWorkspaceChange(askText) &&
      answeredWithAPlanInsteadOfWork(result.content)
    ) {
      result.undeliveredChange = true;
    }
    // UNBACKED-HEALTH-CLAIM honesty (measured 2026-10-09). The answer vouches for
    // the product and nothing this turn observed the product running, so the
    // verdict rests on something else — usually a unit suite for one module.
    if (
      !result.cancelled &&
      !result.generationFailed &&
      detectUnbackedHealthClaim(
        result.content,
        result.successfulToolCalls,
        progress.executedActions,
        progress.mutatedPaths,
      )
    ) {
      result.unbackedHealthClaim = true;
    }
  }
  return result;
}

/**
 * Is this ask a SHORT authored deliverable — prose whose TEXT is the answer?
 *
 * WHY THIS EXISTS. G13's precondition is `requestAuthorizesWrites`, which reads a
 * creation verb applied to a file-shaped noun — precisely the shape of "write a
 * poem". So a WhatsApp turn asking for a Hindi poem was judged to have authorized
 * FILE work, and when the poem closed with "Want me to make it shorter…?" the gate
 * treated the step as the permission question and discarded it
 * (trace-1792061511046-jdhgyy: the sender got "Or perhaps help you draft a message
 * to send to her?" and no poem).
 *
 * The distinction is already in the codebase, and it is not a per-content-type
 * list: `isAuthoredGoal` says the deliverable is authored prose, and
 * `asksForAuthoredFile` says the user asked for the ARTIFACT (a magnitude needing
 * several units, or a named destination) rather than for the text. Only the second
 * is file work — for every authored class, poem through report, with no rule that
 * names a poem or an essay.
 */
function isInlineAuthoredDeliverable(requestText: string): boolean {
  const text = (requestText || '').trim();
  if (!text) return false;
  return isAuthoredGoal(text) && !asksForAuthoredFile(text);
}

/**
 * Does the DELIVERABLE gate apply to this turn (G13b)?
 *
 * The conjunction is the whole point, and every term is an independent fact:
 *
 *   - the request asks for an AUTHORED deliverable to be PRODUCED as a FILE
 *     (`asksForAuthoredFile` — a size needing more than one unit, or a named
 *     destination). The broader `wantsAuthoredArtifact` is deliberately NOT
 *     used here: it is true for "write a poem", where the text IS the answer,
 *     and demanding an artifact for it is how a chat poem turned into a nudge
 *     for a file nobody asked for;
 *   - the turn wrote NOTHING (`mutatedPaths` is the loop's own evidence that a
 *     write landed, so a turn that used a heredoc through `run_terminal` is not
 *     nudged for a file it already wrote);
 *   - tools are actually available (a caller that exposed none cannot comply);
 *   - the turn did not END on a question to the reader (`replyAsksTheReader`).
 *     This is the line between the two failures that look alike: "Do you want me
 *     to create the files?" is a stall, and the permission nudge already settles
 *     it above; "Which of these two titles do you prefer?" is a decision input
 *     the user asked to be consulted on, and bulldozing it would be the manual
 *     -cadence complaint in reverse;
 *   - the bound is unspent, and the caller has not disabled the gate.
 *
 * A turn that already wrote something is deliberately out of scope: the gate is
 * about the artifact never being produced, not about the artifact being short.
 */
function deliverableGateApplies(
  opts: ToolLoopOptions,
  content: string,
  progress: ToolLoopProgress,
  schemaCount: number,
  requestText: string,
): boolean {
  if (opts.requireDeliverable === false) return false;
  if (schemaCount === 0) return false;
  if (progress.mutatedPaths.length > 0) return false;
  if (!requestText.trim()) return false;
  if (replyAsksTheReader(content)) return false;
  // A negative instruction outranks every positive signal. "Do not write any
  // files — answer in chat" contains a creation verb and a file-shaped noun, so
  // without this the gate read it as an authored-artifact ask and wrote a file
  // against the user's explicit instruction.
  if (requestForbidsWrites(requestText)) return false;
  // The NARROW half of the authored-artifact rule: a size that needs more than
  // one unit ("a 12 page story", "a 20 chapter book") or a named destination.
  // `wantsAuthoredArtifact` — the broad half — is true for "write a poem" too,
  // and demanding a FILE for that is the defect: a short authored ask is answered
  // in chat, where the text IS the deliverable (see `asksForAuthoredFile`'s own
  // doc and its pinned tests). The two gates therefore speak one vocabulary: chat
  // prose is asked for no artifact, large or placed prose still is.
  return asksForAuthoredFile(requestText);
}

/**
 * Tools that do not count as having DONE anything on their own. `suggest_followups`
 * concludes a turn; it produces no work, so a turn that only called it has still
 * performed nothing the request asked for. Every other successful tool counts as
 * an action (a read is an action), which keeps the zero-action gate conservative.
 */
/**
 * A token that NAMES a file (a real source/config extension). The strongest
 * signal that the request is about the WORKSPACE, not a chat answer.
 */
const REQUEST_FILE_TOKEN_RE =
  /\b[\w./~-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|cs|cpp|cxx|cc|c|h|hpp|json|ya?ml|toml|ini|cfg|conf|md|markdown|txt|csv|tsv|html?|css|scss|sass|less|sql|sh|bash|zsh|fish|env|lock|xml|gradle|properties|vue|svelte|php|lua|pl|swift|dart|scala)\b/i;
/** A verb that asks for a change to the workspace. */
const WORK_EDIT_VERB_RE =
  /\b(?:fix|repair|refactor|edit|modify|updat|chang|add|implement|creat|writ|delet|remov|renam|rewrit|migrat|correct|debug|patch|tweak|scaffold)\w*/i;
/** A code/workspace noun that pairs with the verb above. */
const CODE_NOUN_RE =
  /\b(?:file|files|function|functions|method|methods|class|classes|module|modules|script|scripts|component|components|test|tests|suite|api|endpoint|endpoints|route|routes|schema|schemas|migration|migrations|package|dependency|dependencies|import|imports|config|configuration|type|types|interface|interfaces|bug|bugs|repo|repository|codebase|project|source|button|buttons|ui|ux|page|pages|screen|screens|form|forms|dialog|dialogs|menu|menus|widget|widgets|handler|handlers|frontend|backend|client|server|webpage|website|view|views|layout|styling|style|styles|css|html|markup|input|field|fields|dropdown|dropdowns|checkbox|toggle|modal|modals|label|labels)\b/i;

/**
 * Does this request DIRECT work on the workspace — the precondition for the
 * ZERO-ACTION gate?
 *
 * Deliberately narrower than "the request authorizes writes": the gate spends a
 * model step, so it must only fire on an ask that genuinely needs the tools.
 * `requestAuthorizesWrites` is true for a prose deliverable ("draft an
 * itinerary") or a review ("assess this project"), which are correctly answered
 * in chat — nudging those would turn one turn into two for no reason (found by
 * the existing suite). The workspace signal is therefore explicit: the request
 * either names a FILE, or pairs an edit verb with a code noun.
 */
function requestRequiresWorkspaceAction(requestText: string, authorized: boolean): boolean {
  const text = (requestText || '').trim();
  if (!text) return false;
  if (!authorized) return false;
  if (requestForbidsWrites(text)) return false;
  if (wantsAuthoredArtifact(text)) return false;
  if (REQUEST_FILE_TOKEN_RE.test(text)) return true;
  return WORK_EDIT_VERB_RE.test(text) && CODE_NOUN_RE.test(text);
}

/**
 * Does this request ask for a CHANGE to work that already exists?
 *
 * Deliberately NOT `requestRequiresWorkspaceAction`, which answers a different
 * question ("does this ask need the tools at all?") and deliberately returns
 * false for an authored-deliverable ask. This one is the precondition for
 * `undeliveredChange`: an EDIT verb applied to a code/UI noun — the shape of
 * "fix the settings button", "add drag-and-drop to the page", "why doesn't the
 * Add Document button work".
 *
 * The two optional guards are the same ones every other gate uses: a request
 * that forbade writes cannot have failed to change anything, and `authorized`
 * keeps `requestAuthorizesWrites`'s verdict authoritative where it is available.
 */
function requestRequiresWorkspaceChange(requestText: string, authorized?: boolean): boolean {
  const text = (requestText || '').trim();
  if (!text) return false;
  if (authorized === false) return false;
  if (requestForbidsWrites(text)) return false;
  return WORK_EDIT_VERB_RE.test(text) && CODE_NOUN_RE.test(text);
}

/**
 * A plan header the model writes for ITSELF: `Plan:`, `My plan:`, `Next steps—`.
 * Requires the label, so an ordinary numbered answer is not a plan.
 */
const PLAN_HEADER_RE =
  /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*[ \t]*)?(?:my|the|our|final|next)?[ \t]*(?:plan|steps|next\s+steps|approach)\s*(?:\*\*)?[ \t]*[:\u2014-]/im;

/**
 * A CLOSING first-person intent to act — the promise that ends a turn.
 *
 * Deliberately broader than `INTENT_PROMISE_RES` (which this file already uses
 * for the dangling-promise nudge): the live answer ended *"Let's start by
 * reading `public/app.js`."*, and the `let me` family that regex covers does not
 * match `let's`. Only an imminent, tool-shaped intent belongs here.
 */
const CLOSING_PROMISE_RES: readonly RegExp[] = [
  /\blet'?s\s+(?:now\s+|then\s+|first\s+|just\s+)*(?:start|begin)\s+by\s+\w+/i,
  /\blet'?s\s+(?:now\s+|then\s+|first\s+|just\s+)*(?:go\s+ahead\s+and\s+)?(?:start|begin|read|open|inspect|examine|check|look|search|grep|find|run|build|implement|create|write|fix|update|add)\b/i,
  /\bi(?:'ll| will| am going to| am about to|'m going to)\s+(?:now\s+|next\s+|first\s+|immediately\s+)*(?:start|begin|read|open|inspect|examine|check|look|search|grep|find|run|build|implement|create|write|fix|update|add)\b/i,
];

/** A completion claim the model would only make having actually done the work. */
const COMPLETION_CLAIM_RE =
  /\b(?:i(?:'ve| have)\s+(?:updated|created|added|written|fixed|changed|run|checked|found|built|removed|refactored|implemented)|here(?:'s| is| are)\s+(?:the|what|how)|the answer is|below is|as requested|i found|all set|that(?:'s| is)\s+(?:it|done))\b/i;

/** A fenced block is shipped code or content — a deliverable, not narration. */
const FENCED_BLOCK_RE = /```/;

/**
 * Did the turn answer a WORK request with a PLAN instead of the work?
 *
 * The four guards are what keep this off a real answer, and each was chosen
 * from a shape that would otherwise be a false positive:
 *   - a fenced block IS the deliverable (code, a diff, a command the user asked for);
 *   - a completion claim proves work was done, not described;
 *   - a plan header (`Plan:`, `Next steps:`) is the model writing itself a TODO —
 *     an explanation that answers the user says "the fix is", never "Plan:";
 *   - a closing imminent promise ("Let's start by reading X.") is the dropped intent.
 *
 * A bare numbered list is NOT enough on its own: "1. Install the CLI\n2. Run
 * `nuvira gateway start`" is a correct answer to a how-to ask. Only the plan
 * HEADER or the closing promise marks the turn as having stopped short.
 */
function answeredWithAPlanInsteadOfWork(content: string): boolean {
  const text = (content || '').trim();
  if (!text) return false;
  if (FENCED_BLOCK_RE.test(text)) return false;
  if (COMPLETION_CLAIM_RE.test(text)) return false;
  const closing = text
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-3);
  if (closing.some((s) => CLOSING_PROMISE_RES.some((re) => re.test(s)))) return true;
  return LIST_STRUCTURE_RE.test(text) && PLAN_HEADER_RE.test(text);
}

/**
 * A command that EXERCISES the product the way its user would — the only kind of
 * evidence that can back a claim that the product WORKS.
 *
 * Deliberately excludes a test suite: `npm test` observes a module, not the
 * running app, which is the exact confusion this flag exists to remove (the live
 * app answered "ready for use" off `npm test` while `GET /app.js` returned 404).
 */
const EXERCISES_PRODUCT_RE =
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:start|dev|serve|preview)\b|\bnode\s+\S*(?:server|app|index|main)\b|\b(?:curl|wget|http(?:ie)?)\s|\bhttps?:\/\/|\bplaywright|\bpuppeteer|\bchrome\b/i;

/**
 * A claim about the PRODUCT's health/readiness — strong, project-level phrasing.
 * Kept to readiness/working/completeness assertions so that reporting a test
 * result ("18 tests passed") is not, by itself, treated as one.
 */
const PRODUCT_HEALTH_CLAIM_RE =
  /\b(?:ready\s+for\s+use|ready\s+for\s+further\s+development|fully\s+implemented|fully\s+functional|stable,?\s+working|working\s+state|in\s+good\s+shape|production[-\s]ready|everything\s+works|(?:the\s+)?(?:project|app|application|codebase|repo|repository|service|system|website|web\s?app)\b[^.!?\n]{0,40}\b(?:works|is\s+stable|is\s+complete|is\s+functional|has\s+no\s+(?:issues|bugs|problems)))/i;

/**
 * Is this a health verdict the turn's own evidence cannot support?
 *
 * Requires the CONJUNCTION, because each term is what makes the claim unbacked:
 * the answer vouches for the product, the turn changed nothing (so this is an
 * ASSESSMENT, not a change the user can go and look at), and nothing ran that
 * exercised the product. A turn that started the server and hit a route is
 * untouched.
 */
function detectUnbackedHealthClaim(
  content: string,
  successfulToolCalls: readonly string[],
  executedActions: readonly ExecutedAction[],
  mutatedPaths: readonly string[],
): boolean {
  const text = content || '';
  if (!text.trim()) return false;
  if (!PRODUCT_HEALTH_CLAIM_RE.test(text)) return false;
  if (mutatedPaths.length > 0) return false;
  if (successfulToolCalls.includes('browser')) return false;
  return !executedActions.some(
    (a) => a.ok && typeof a.command === 'string' && EXERCISES_PRODUCT_RE.test(a.command),
  );
}

const NON_PRODUCTIVE_TOOLS: ReadonlySet<string> = new Set(['suggest_followups']);

/** True when the turn performed at least one action beyond merely concluding. */
function hasProductiveAction(progress: ToolLoopProgress): boolean {
  return progress.successfulToolCalls.some((name) => !NON_PRODUCTIVE_TOOLS.has(name));
}

/**
 * How many PRODUCTIVE actions have SUCCEEDED this turn — the cardinality of the
 * very predicate `hasProductiveAction` answers, so the two cannot drift. D1 uses
 * it to tell a later answer written after real work (an update, which supersedes)
 * from a closing wrapper written after none (presentation, which must not). It
 * reads the loop's own success record — `successfulToolCalls`, appended only for
 * calls that actually ran — so a refused or failed call is never mistaken for
 * work, and `suggest_followups` (which merely concludes) is never counted.
 */
function countProductiveWork(progress: ToolLoopProgress): number {
  let n = 0;
  for (const name of progress.successfulToolCalls) if (!NON_PRODUCTIVE_TOOLS.has(name)) n += 1;
  return n;
}

/**
 * The message an AUTO-VERIFY run leaves in the thread.
 *
 * It says who ran the check (the harness, not the model), what the verdict IS,
 * and what to do next — the three things a bare tool result does not say. The
 * output is bounded: the point is the verdict and the first failure, not a full
 * log the model will pay to re-read.
 */
export function autoVerifyReport(
  check: { command: string; label: string },
  output: string,
  ok: boolean,
  maxChars = 4_000,
): string {
  const body = output.trim();
  const shown =
    body.length > maxChars
      ? `${body.slice(0, maxChars)}\n[... output truncated — re-run a narrower command if you need the rest]`
      : body;
  return [
    `🧪 AUTO-VERIFY — this turn changed files and had not verified them, so the project's own check was run FOR you: ` +
      `\`${check.command}\` (${check.label}).`,
    `Result: ${ok ? '✅ passed' : '❌ FAILED'}.`,
    shown,
    ok
      ? 'The change is verified. State that in your answer, naming this command — do not re-run it.'
      : 'Fix the failure above, then re-run this exact command yourself. Do not repeat an unchanged run, and do not ' +
        'report the work as complete while this check fails.',
  ].join('\n');
}

/**
 * The closing notice of a turn that ran out of steps.
 *
 * It answers four questions, because a truncated turn that answers none of them
 * reads as a bug or (worse) as a completed task: WHAT ended it, WHAT is still
 * open, WHAT was already written, and HOW to continue.
 */
function boundedEndingNotice(input: {
  stepLimit: number;
  planSteps: ReadonlyArray<{ description: string; status: string }>;
  changedPaths: readonly string[];
}): string {
  const open = input.planSteps.filter((step) => step.status !== 'done');
  const lines: string[] = [];

  if (input.planSteps.length > 0 && open.length === 0) {
    // Every step is marked done but the turn never closed itself out. Claiming
    // "unfinished" here would be its own false statement; the honest one is
    // that the plan says done and the turn did not get to confirm it.
    lines.push(
      `I stopped because this turn reached its step ceiling (${input.stepLimit} model calls) just after the plan's last step. ` +
        'The plan says every step is done, but the turn did not close itself out — review the result before relying on it.',
    );
  } else {
    lines.push(
      `I stopped because this turn reached its step ceiling (${input.stepLimit} model calls) before the task was finished. ` +
        'That is a harness limit, not a model or provider failure — the work so far is preserved.',
    );
  }

  if (input.planSteps.length > 0 && open.length > 0) {
    const done = input.planSteps.length - open.length;
    const named = open.slice(0, 4).map((step) => step.description);
    lines.push(
      `Plan: ${done}/${input.planSteps.length} done — still open: ${named.join('; ')}` +
        `${open.length > named.length ? ` (+${open.length - named.length} more)` : ''}.`,
    );
  }

  if (input.changedPaths.length > 0) {
    const named = input.changedPaths.slice(0, 5);
    lines.push(
      `Files changed this turn: ${named.join(', ')}` +
        `${input.changedPaths.length > named.length ? ` (+${input.changedPaths.length - named.length} more)` : ''}.`,
    );
  }

  lines.push('Nothing was lost — reply "continue" and I will pick up from here.');
  return lines.join('\n');
}

/**
 * Does the ZERO-ACTION gate apply to this turn?
 *
 * Every term is an independent, checkable fact — the conjunction is what keeps
 * the gate from firing on turns that are legitimately answer-only:
 *
 *   - the request AUTHORIZES writes (`authorized`) — a create/maintenance ask,
 *     not a question (`requestAuthorizesWrites` already vetoes pure questions);
 *   - NO tool call succeeded this turn (a turn that gathered context and then
 *     answered is out of scope — it did something, even if it then stalled);
 *   - NOTHING was written (`mutatedPaths` is the loop's own proof a write
 *     landed, so a heredoc through `run_terminal` is not nudged);
 *   - tools are actually available (a caller that exposed none cannot comply);
 *   - the request did NOT forbid writes (a negative instruction outranks every
 *     positive signal — see `requestForbidsWrites`);
 *   - it is NOT an authored-artifact ask: `wantsAuthoredArtifact` requests are
 *     the DELIVERABLE gate's job, with their own narrower message, and running
 *     both would spend two nudges on one ask.
 */
function zeroActionGateApplies(
  opts: ToolLoopOptions,
  progress: ToolLoopProgress,
  schemaCount: number,
  requestText: string,
  authorized: boolean,
): boolean {
  if (opts.requireAction === false) return false;
  if (schemaCount === 0) return false;
  if (hasProductiveAction(progress)) return false;
  if (progress.mutatedPaths.length > 0) return false;
  return requestRequiresWorkspaceAction(requestText, authorized);
}

/**
 * The bounded PLAN-REQUIRED nudge (E2) — one advisory step telling the model to
 * declare a short plan before it mutates.
 *
 * Names the ask, states the contract (plan first, then work), and closes the
 * failure mode the nudge exists for: planning that REPLACES the work; the last
 * line forbids exactly that dormancy.
 */
export function planRequiredNudge(ask: string): string {
  const quoted = (ask || '').trim().replace(/\s+/g, ' ').slice(0, 300);
  return (
    'Before you change anything, declare a short PLAN for this turn — call `plan_todo` with 2–6 ordered steps' +
    ' (create the plan once, then advance it with action "update" as you go).' +
    (quoted ? ` The request: "${quoted}".` : '') +
    '\nA plan is how the user can follow along and how the turn is verified — keep it accurate, do not pad it,' +
    ' and do NOT let planning replace the work: declare it, then do the first step now.'
  );
}

/**
 * The bounded ZERO-ACTION correction — the loop telling the model, in one step,
 * that a directed request has not been touched yet.
 *
 * Names the ask (so the model cannot claim it did not know what was wanted),
 * states plainly that nothing ran and nothing changed, and closes the two escape
 * hatches that produced the observed non-actions: do not re-ask a request that is
 * already specified, and do not answer a work request with a plan, an apology or
 * a question. It still leaves a REAL blocker as a legitimate way out — the goal
 * is the work, not compliance theatre.
 */
export function zeroActionNudge(ask: string): string {
  const quoted = (ask || '').trim().replace(/\s+/g, ' ').slice(0, 300);
  return (
    'Nothing has been done yet: you have not called a single tool this turn, so no file was changed and nothing was checked.' +
    (quoted ? ` The request already asked for this work: "${quoted}".` : '') +
    '\nYou have the tools to do it — read what you need, make the change, and run the check NOW.' +
    ' Do NOT reply with a plan, a summary of what you would do, an apology, or a request for the user to restate or confirm' +
    ' a request that is already complete. If something genuinely blocks you, say exactly what it is and why; otherwise do the work.'
  );
}

/**
 * The text of the LAST user message in the thread — what the user is actually
 * asking for right now, as opposed to the history above it. Used to derive
 * write authorization for the turn (see `writesAuthorized`).
 *
 * The most recent user message wins because a continuation ("continue", "yes")
 * carries its own authorization, and an earlier, longer ask that has already
 * been partially served must not keep re-authorizing new work.
 */
function lastUserText(messages: readonly ToolMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    return typeof message.content === 'string' ? message.content : '';
  }
  return '';
}

/**
 * One bounded line from a tool result — the EVIDENCE a gate verdict read (G18).
 *
 * The first non-empty line, whitespace-collapsed: enough to tell an applied edit
 * from a declined one ("Error: write_file: … needs explicit confirmation"), a
 * failing test from a passing one, without pasting a whole file into the trace
 * store. The store keeps the tail of a long run; a full result per call would
 * push the interesting end of the turn out of it.
 */
function previewToolResult(result: string, max = 200): string {
  const first = (result || '').split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  const flat = first.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}\u2026` : flat;
}

/**
 * Classify a DECLINED call's result text (G18).
 *
 * The single class this exists for is the confirmation refusal: a tool that
 * says "call ask_user first, then retry with confirm:true" has not failed — it
 * has handed the decision to the user, and that is exactly the event the trace
 * store could not see at all (the G18 audit read "0 refusals" and could not
 * tell it from "no refusals"). The remaining cases are the loop's own guards,
 * named so the record distinguishes *why* work did not happen: a guard is not a
 * provider error — the turn can continue either way, and only the record knows.
 *
 * Returns null when the result is an ordinary tool/runtime error, so the caller
 * keeps its own wording rather than inventing a cause.
 */
/** How many steps of an existing plan are re-shown to the model (bounded). */
export const PLAN_CONTEXT_MAX_STEPS = 12;

/**
 * The block that hands the model the plan its own conversation already tracks.
 *
 * Written to make the correct next move obvious rather than merely possible: the
 * step ids are given verbatim (so `update` can address them), the statuses are the
 * stored truth, and the one thing a model tends to do instead — declare the plan
 * again — is named as wrong, because a re-declaration under the same goal now
 * carries progress but still replaces the step LIST the user is watching.
 */
export function planContextBlock(plan: {
  goal: string;
  steps: Array<{ id: string; description: string; status: string; note?: string }>;
  revision: number;
}): string {
  const shown = plan.steps.slice(0, PLAN_CONTEXT_MAX_STEPS);
  const hidden = plan.steps.length - shown.length;
  const lines = shown.map(
    (s) => `  - ${s.id} [${s.status}] ${s.description}${s.note ? ` — ${s.note}` : ''}`,
  );
  const open = plan.steps.filter((s) => s.status !== 'done').length;
  return [
    `📋 The plan this conversation is already tracking (${plan.steps.length - open}/${plan.steps.length} done, revision ${plan.revision}):`,
    `  goal: ${plan.goal}`,
    ...lines,
    ...(hidden > 0 ? [`  … and ${hidden} more step(s).`] : []),
    `Advance THIS plan: call \`plan_todo\` with action "update", the step id above and its new status. ` +
      'Do NOT declare it again with action "create" — the checklist the user is watching is this one, and ' +
      're-declaring replaces its steps. Work the next open step.',
  ].join('\n');
}

/**
 * The bounded PLAN CLOSE-OUT nudge — the loop asking the model to settle the
 * plan it opened this turn before the turn ends.
 *
 * WHY. The plan is the checklist the user watches, and a plan left with steps
 * `running`/`pending` at the end of a turn that engaged it is exactly the failure
 * the tracker exists to prevent: measured 2026-10-09
 * (trace-1791542886258-pg42ox), a plan sat frozen at "1/7 steps" for two days and
 * was only advanced after the user asked why. One nudge, once, naming the open
 * steps and requiring a REAL status (done, or blocked with a one-line note)
 * closes it. It fires only when this turn DECLARED or UPDATED the plan — never on
 * a turn that merely carried one, so an unrelated turn is not asked to advance
 * somebody else's checklist (the report labels a carried plan instead).
 */
export function planCloseoutNudge(plan: {
  goal: string;
  steps: Array<{ id: string; description: string; status: string; note?: string }>;
}): string {
  const open = plan.steps.filter((s) => s.status !== 'done');
  const shown = open.slice(0, PLAN_CONTEXT_MAX_STEPS);
  const hidden = open.length - shown.length;
  return [
    'Before you finish: the plan you declared this turn still has UNSETTLED steps, so the checklist the user is watching is stale.',
    `  goal: ${plan.goal}`,
    ...shown.map((s) => `  - ${s.id} [${s.status}] ${s.description}`),
    ...(hidden > 0 ? [`  … and ${hidden} more unsettled step(s).`] : []),
    'Call `plan_todo` with action "update" for each one NOW and set its REAL status: "done" for work you completed,' +
      ' or "blocked" (with a one-line note saying why) for work you could not. Do not leave a step "running" or' +
      ' "pending" unless it genuinely has not started — say so in your answer instead of marking it done.',
  ].join('\n');
}

/**
 * The refusal a tool call gets when its ARGUMENTS never arrived.
 *
 * Measured defect (dashboard session `4e2b0e51…-1791349543186`, 2026-10-07): the
 * goal "deliver complete document" produced **59 `write_file` calls with empty
 * arguments**, plus 14 `run_terminal` and 2 `code_execution` — 73 of the turn's 81
 * calls. Each one was executed as `{}`, so the model's feedback was
 * `write_file: path is required`, which names the wrong problem: the model HAD
 * asked for a write, with a payload (a whole design document) that could not fit
 * in one output. It diagnosed "my calls were emitted empty", retried 59 times,
 * and the turn ended `bounded: true` with no document. Two things were missing
 * and both are here: the REAL cause, and a way to succeed at all.
 *
 * The refusal is `Error:`-prefixed because the call genuinely did not run — the
 * loop's honest accounting (successful calls, mutations, verification) depends
 * on that prefix, so a call that never reached a tool is never counted as one.
 */
export function malformedToolCallRefusal(
  call: { name: string; argumentsError: ToolArgumentsError },
  opts: { finishReason?: string; attempt?: number } = {},
): string {
  const attempt = opts.attempt ?? 1;
  const cause =
    call.argumentsError === 'empty'
      ? 'the call arrived with NO arguments at all'
      : "the call's arguments arrived incomplete and could not be parsed";
  const why =
    opts.finishReason === 'length'
      ? 'the provider stopped this step at its output-token limit (finish_reason: "length"), so the payload was cut off before the arguments were complete'
      : 'this is what a payload too large to emit in ONE step looks like on the wire — nothing was lost on this side';
  const escape =
    'Send the payload in PIECES instead of one call: `write_file` the FIRST section, then call `write_file` again ' +
    'with mode:"append" for each further section (or write a smaller file and grow it with `edit_file`). ' +
    'Do NOT re-send this call unchanged — it cannot succeed, and every attempt is a full round trip.';
  const escalation =
    attempt >= 3
      ? ` (This is time ${attempt} this turn that a call arrived with no usable arguments — change the SHAPE of the call, not its wording.)`
      : '';
  return `Error: ${call.name}: NOT run — ${cause}, so the tool never saw your input. Reason: ${why}. ${escape}${escalation}`;
}

/**
 * Whether a tool's schema declares at least one REQUIRED argument (item 6).
 *
 * This is what lets the empty-arguments refusal reach the JSON-fallback and
 * Gemini wires without refusing a legitimate no-argument call: a `git` or
 * `plan_todo` call with `{}` is a real call, but a `write_file` with `{}` is a
 * truncated one. Read from the tool's own JSON schema (derived from its zod
 * schema, never hand-kept), so a tool added later is judged by what it declares.
 * When the schema cannot be read the answer is conservative (`true`): a
 * malformed payload is the more likely cause, and the refusal is guidance, not a
 * wall — the model can still retry with arguments.
 */
function toolRequiresArguments(name: string): boolean {
  try {
    const [schema] = toolJsonSchemas([name]);
    // An unregistered name is not a call to honour — refuse, as before.
    if (!schema) return true;
    const required = (schema.parameters as { required?: unknown }).required;
    // No `required` key means the tool declares no required argument, so an empty
    // payload IS a legitimate call (list_dir). An empty array means the same.
    if (Array.isArray(required)) return required.length > 0;
    return false;
  } catch {
    // A schema that cannot be read is treated conservatively: a malformed payload
    // is the more likely cause, and the refusal is guidance the model can act on.
    return true;
  }
}

/**
 * The one bounded mid-turn nudge for the same defect, pushed after the results of
 * the step that produced it — so a model that keeps re-sending a payload too large
 * for one output is told the strategy, not merely that it failed again.
 */
export function malformedCallNudge(attempts: number): string {
  return (
    `Your last ${attempts} tool call(s) this turn arrived WITHOUT usable arguments — the payload did not fit in one ` +
    'model output and was cut off. Nothing is wrong with your plan; the DELIVERY shape is. Build the artifact in ' +
    'sections: `write_file` the first part, then `write_file` with mode:"append" for each next part (keep each call ' +
    'under ~120 lines). Do not repeat the single large call.'
  );
}

export function classifyToolRefusal(result: string): { gate?: TraceGateName; summary: string } | null {
  const text = result || '';
  if (
    /needs explicit confirmation|requires confirmation|retry with confirm|call ask_user/i.test(text) ||
    // The REAL `confirmFirst` wording (coding-tools.ts: "write_file: state-changing
    // — NOT applied. Ask the user first via ask_user (…), then retry write_file with
    // confirm:true once they approve.") matched NONE of the patterns above: the
    // words are the same but the phrasing is "retry write_file with confirm", not
    // "retry with confirm". A write that was NOT applied therefore counted as a call
    // that ran — so the path it named counted as a MUTATION, the run trace recorded
    // a change that never happened, and the verification gate asked the model to
    // check a file nothing had written. Found by the child's gate, where the same
    // miscount reported `unverifiedEdit` for an empty diff.
    /\bstate-changing\b[^.]*\bNOT applied\b|\bretry\s+\w+\s+with\s+confirm/i.test(text)
  ) {
    return { gate: 'confirmation', summary: 'declined until the user approves — the gate asked before acting' };
  }
  // A BOUNDARY denial is the other refusal that did not read as one. The
  // workspace guard returns "… escapes the workspace (…) — denied" with no
  // `Error:` prefix, so it counted as a successful call (found live). Anchored
  // to the boundary phrasings rather than the bare word "denied", because a
  // `run_terminal` that reads a log containing "Permission denied" is a
  // successful call, not a refusal.
  if (/escapes the workspace|outside the workspace|outside the project|outside this project|not allowed by the workspace/i.test(text)) {
    return { gate: 'workspace', summary: 'declined — the path is outside the workspace the tools may touch' };
  }
  if (/already called|already dispatched/i.test(text)) {
    return { summary: 'declined by the loop guard — that dispatch already happened this turn' };
  }
  if (/^Error: unknown tool/i.test(text)) {
    return { summary: 'declined — the model called a tool that is not on its surface' };
  }
  if (/toolset is not loaded this turn/i.test(text)) {
    return { summary: 'declined — that tool\'s toolset was never loaded this turn' };
  }
  if (/is disabled — its toolset is turned off/i.test(text)) {
    return { summary: 'declined — the tool is turned off in configuration' };
  }
  return null;
}

/** Compact argument preview for the event line. */
/**
 * The argument fields that say WHAT a call acts on — the useful half of a
 * one-field preview, in preference order.
 *
 * MEASURED (2026-10-07, live): a routing-design run printed
 * `⚙ write_file({confirm: true})` five times and `⚙ edit_file({allow_multiple:
 * false})` four times on its console. Both calls were COMPLETE — the preview
 * simply took the FIRST key the model happened to emit, which is a boolean
 * default, so the one thing a watcher needs (WHICH FILE) was invisible. A
 * progress line that names `confirm` instead of the path is worse than no line:
 * it looks like the agent is confirming something it never wrote.
 *
 * The fallback stays "first entry" so an unknown tool is still previewed rather
 * than blanked.
 */
const IDENTIFYING_ARG_KEYS = [
  'path',
  'filePath',
  'file',
  'paths',
  'command',
  'pattern',
  'query',
  'url',
  'goal',
  'name',
  'question',
  'tool',
  'action',
  'claim',
] as const;

/**
 * A one-field preview of a tool call's arguments, preferring the IDENTIFYING
 * field ({@link IDENTIFYING_ARG_KEYS}) over whichever key was emitted first.
 *
 * Exported for the test that pins the preference — the bug it fixed was not a
 * crash but a true statement that named the wrong thing.
 */
export function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '{}';
  const picked =
    IDENTIFYING_ARG_KEYS.map((k) => entries.find(([key]) => key === k)).find(
      (e): e is [string, unknown] => e !== undefined,
    ) ?? entries[0];
  const [key, value] = picked;
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  return `{${key}: ${v.length > 40 ? v.slice(0, 40) + '…' : v}}`;
}

// ─── Mechanical thread budget (assessment Addendum v4 Phase 3.3) ────────────
// The loop had NO thread-size management: a read_file of a large file (or a
// long tool result chain) accumulated verbatim until the provider rejected
// the request. This is DETERMINISTIC compaction — no LLM call, no summary
// latency, no summarization drift (the compact-history pattern):
// the oldest tool results collapse to a stub first, the newest stay verbatim,
// and the system prompt + first user message are never touched.

/** Default thread budget in characters (~50K tokens at 4 chars/token). */
export const DEFAULT_THREAD_BUDGET_CHARS = 200_000;

/** Messages at the END of the thread that are never trimmed (recent context). */
const RECENT_KEEP = 6;

/** Stub left in place of a trimmed tool result. */
const TRIM_STUB = '[earlier tool result trimmed to fit the context budget]';

/**
 * Floor for the per-message tool-result clamp (the tail clamp). A single tool
 * result may never exceed half the thread budget, so one oversized output cannot
 * dominate the prompt; this floor keeps the clamp sane for a tiny budget.
 */
const MIN_TOOL_RESULT_CHARS = 8_000;

/**
 * Bounded scan window for the clamp's error-line rescue. An elided middle can be
 * megabytes, and scanning all of it would cost more CPU than the prompt costs
 * tokens, so only the EDGES of the middle are searched. Nothing here is
 * unrecoverable: a clipped result is re-runnable (`run_terminal` again) or
 * re-readable (`read_file` with offset/limit), which the notice says out loud.
 */
const CLAMP_SCAN_CHARS = 250_000;

/** Cap on rescued error-looking lines, and on the chars they may add back. */
const CLAMP_ERROR_LINES = 12;
const CLAMP_ERROR_CHARS = 2_000;

/**
 * A line that looks like the REASON something failed. Deliberately broad: one
 * extra line costs a few tokens, while dropping the only line that says WHY the
 * build broke costs a wrong fix built on a log the model never saw.
 */
const ERROR_LINE_RE =
  /\b(?:error|errors|fail|failed|failing|failure|exception|panic|fatal|traceback|assert|assertion|expected|received|refused|denied|unhandled|cannot|unable|timeout|enoent|econnrefused)\b|\btimed out\b|\bexit(?:ed)?(?: with)?(?: code)? [1-9]\d*\b|[✗✘✕]/i;

/** `5234567` → `5,234,567` (deterministic grouping — no locale/ICU dependence). */
function withThousands(n: number): string {
  return String(Math.max(0, Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Estimated character size of one thread message (chars/4 ≈ tokens). */
function messageChars(m: ToolMessage): number {
  return (m.content?.length ?? 0) + (m.toolCalls?.length ? JSON.stringify(m.toolCalls).length : 0);
}

/**
 * Rescue the error-looking lines from the MIDDLE of a result that is about to be
 * clamped away. The clamp keeps head + tail, and a tool's verdict usually lands
 * in the tail — but the REASON for a failure (an assertion, a stack frame, `exit
 * code 1`) can sit in the middle, and a model that never sees it fixes the wrong
 * thing. Deterministic: a line filter, no LLM, no summary, no drift.
 */
function errorLinesFrom(middle: string): string[] {
  const regions =
    middle.length <= CLAMP_SCAN_CHARS * 2
      ? [middle]
      : [middle.slice(0, CLAMP_SCAN_CHARS), middle.slice(-CLAMP_SCAN_CHARS)];
  const out: string[] = [];
  let used = 0;
  for (const region of regions) {
    for (const raw of region.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      // NO length filter. A tool's output rarely ends on a newline, so the tail
      // cut lands MID-LINE and fuses the last real line with the kept tail —
      // MEASURED: a 38-char `AssertionError: 2 !== 3 (received 3)` arrived here
      // as 1,036 chars, and a `> 1000` skip dropped it, i.e. the rescue silently
      // lost exactly the line it exists to save. Long lines are kept by their
      // first 200 chars instead (an error keyword in a minified blob is still
      // the start of the reason).
      if (!ERROR_LINE_RE.test(line)) continue;
      const kept = line.slice(0, 200);
      if (out.includes(kept)) continue;
      if (used + kept.length > CLAMP_ERROR_CHARS) return out;
      out.push(kept);
      used += kept.length;
      if (out.length >= CLAMP_ERROR_LINES) return out;
    }
  }
  return out;
}

/**
 * The notice a clamp leaves behind: it names the tool, counts the elided
 * characters and says how to get them back. A model handed a SILENTLY partial
 * result cannot tell whether anything is missing; one handed a QUANTIFIED cut
 * can re-run the command or re-read the file — far cheaper than a fix built on a
 * log it never saw.
 */
function clampNotice(tool: string | undefined, elided: number, errorLines: string[]): string {
  const who = tool ? `${tool}: ` : '';
  const rescued =
    errorLines.length > 0 ? '; the error-looking lines from the elided middle are kept below' : '';
  return (
    `\n[tool result trimmed to fit the context budget — ${who}${withThousands(elided)} chars elided ` +
    `from the middle${rescued}. The beginning and the end are kept verbatim; re-run the command, or ` +
    `read the file again with offset/limit, to see the rest.]\n` +
    (errorLines.length > 0 ? `${errorLines.join('\n')}\n` : '')
  );
}

/**
 * Clamp one oversized tool result to `cap` chars, keeping its HEAD and TAIL so
 * the model still sees which tool ran and how its output ended, plus any
 * error-looking lines from the elided middle. Deterministic — no summary, no
 * model call. The result never exceeds `cap`: the head absorbs what the notice
 * and the rescued lines do not use.
 */
function clampToolResult(content: string, cap: number, tool?: string): string {
  if (content.length <= cap) return content;
  const tailLen = Math.min(1_000, Math.floor(cap / 4));
  const tailStart = Math.max(0, content.length - tailLen);
  const middle = content.slice(0, tailStart);
  const errors = errorLinesFrom(middle);
  // Sized with the LARGEST possible elided count, so the exact (smaller) notice
  // that follows can never push the result past `cap`.
  const headLen = Math.max(0, cap - tailLen - clampNotice(tool, middle.length, errors).length);
  const head = content.slice(0, headLen);
  return head + clampNotice(tool, Math.max(0, middle.length - headLen), errors) + content.slice(tailStart);
}

/** Marker identifying the single compaction message inside a live thread. */
export const COMPACTION_MARKER = '[context compacted — earlier steps of this turn]';

/**
 * The note a `write_file` result carries when the deliverable was staged INSIDE
 * the workspace but the request names a path OUTSIDE it.
 *
 * MEASURED (2026-10-25 audit): `write_file({path: "REPORT.md"})` three times inside
 * the audited tree, then a move to `../REPORT.md`. Only the later move kept the
 * tree clean — and the task had said, verbatim, "do not modify the repository".
 * The staging write is not blocked (a draft inside the tree is recoverable); the
 * result now says where the deliverable belongs and what to remove, in the same
 * step, so the model does not have to remember a rule from the prompt.
 *
 * Returns null for the ordinary case: either the write is already outside, or the
 * ask names no outside path with that basename.
 */
export function stagedDeliverableNote(
  writtenPath: string,
  cwd: string,
  named: readonly string[],
): string | null {
  if (!writtenPath || named.length === 0) return null;
  const writtenAbs = resolve(cwd, writtenPath);
  const writtenRel = relative(cwd, writtenAbs);
  // Already at (or outside) the final location — nothing to warn about.
  if (writtenRel.startsWith('..') || isAbsolute(writtenRel)) return null;
  const base = basename(writtenAbs).toLowerCase();

  for (const candidate of named) {
    if (!candidate) continue;
    const target = resolve(cwd, candidate);
    const targetRel = relative(cwd, target);
    const outside = targetRel.startsWith('..') || isAbsolute(targetRel);
    if (!outside) continue;
    if (basename(target).toLowerCase() !== base) continue;
    return (
      `⚠️ STAGING: \`${writtenPath}\` is INSIDE the workspace, but the request names the deliverable at ` +
      `\`${candidate}\` — outside it. A task that says not to modify the project means the staging copy ` +
      `counts. Write the deliverable directly to \`${candidate}\` (one \`write_file\`), then delete ` +
      `\`${writtenPath}\` if it still exists. Do not leave a copy inside the tree.`
    );
  }
  return null;
}

/** State a caller carries between calls so the prefix is compacted ONCE per breach. */
export interface ThreadTrimOptions {
  /**
   * Index of the compaction message already in the thread (0 when none).
   *
   * Everything BEFORE it is FROZEN. This is the whole point of the parameter:
   * the provider caches the prompt prefix, and it can only do that while the
   * prefix is byte-identical to what it cached. Re-stubbing an older message —
   * what the pre-compaction code did on every call — invalidates the cache from
   * the first changed message onward, which is billed at the FRESH input rate
   * (50× the cached rate on DeepSeek: $0.15/M vs $0.003/M).
   *
   * MEASURED (2026-10-25, audit head-to-head, 52 model calls): 22 trim events
   * and a cache-read share that fell from 99.8 % to 12–17 % on the calls that
   * followed a trim. The same run's cost attributable to those rewrites was
   * ≈$0.21 of a ≈$0.28 bill.
   */
  sealedThrough?: number;
  /** Facts to preserve inside the compaction message (see `buildWorkDigest`). */
  digest?: string;
  /**
   * FALLBACK for a route with NO prefix cache: skip the one-shot compaction and
   * use the oldest-first trimming passes instead.
   *
   * Freezing a prefix is a discount only where the provider caches it. On a
   * local runner, a gateway route or an unknown provider, every call pays full
   * price for the whole frozen span and nothing ever shrinks it — strictly worse
   * than trimming. The loop decides this from `learning/prompt-cache.ts` and
   * passes `true` when the cache is not known to exist.
   *
   * An EXISTING watermark is still honoured (those messages were already
   * compacted away; there is nothing to re-expand), so a mid-turn handoff to a
   * non-caching provider cannot resurrect a span that no longer exists.
   */
  preferTrim?: boolean;
}

export interface ThreadTrimResult {
  thread: ToolMessage[];
  /** Messages replaced (compaction) or rewritten (single-result clamps). */
  trimmed: number;
  /** True when a whole span was replaced by ONE compaction message. */
  compacted: boolean;
  /** Index of the compaction message in the RETURNED thread; pass it back in. */
  sealed: number;
}

/**
 * The single message a compacted span leaves behind.
 *
 * It states three things the model cannot see for itself once the transcript is
 * gone: that the turn is continuing (nothing restarted, nothing undone), what
 * the span contained in numbers (`N message(s)`, `X chars`), and HOW to get any
 * of it back (`read_file` it, or re-run the command). Without the last part a
 * compaction turns `read_file` into the only way to rediscover anything — and
 * that is exactly what a long turn cannot afford.
 */
function compactionMessage(input: { messages: number; chars: number; digest: string; errors: string[] }): string {
  const facts = input.digest.replace(WORK_DIGEST_MARKER, '').trim();
  return [
    COMPACTION_MARKER,
    `${input.messages} earlier message(s) (${withThousands(input.chars)} chars) from THIS turn were collapsed ` +
      'into the facts below to keep the context inside its budget. Nothing was restarted and no work was undone.',
    'The old transcript is gone but every result is recoverable: `read_file` the path again, or re-run the ' +
      'command, to see its output. Do not re-run work whose result is recorded below.',
    facts || '• No actions had been recorded when the context was compacted.',
    // WHY the compacted output failed survives the compaction: a clamp already
    // rescues error lines, and a compaction that dropped them would be strictly
    // worse than the clamp it replaces — the model would rediscover the reason
    // with another command instead of fixing it.
    ...(input.errors.length > 0
      ? ['• Failure reasons kept from the compacted output:', ...input.errors.map((line) => `  ${line}`)]
      : []),
  ].join('\n');
}

/**
 * Deterministically bound a thread to `maxChars`.
 *
 * Order of payment:
 * 0. ONE compaction of the whole old span (everything between the watermark and
 *    the protected tail) into a single message carrying the work digest. This is
 *    the only pass allowed to rewrite the prefix, so it happens once per breach
 *    instead of once per call (see `ThreadTrimOptions.sealedThrough`).
 * 1–3. FALLBACK, only when no safe cut exists (a thread with no message that
 *    can end the span without orphaning a `tool` result): the oldest tool
 *    results collapse to the stub, then entirely, then oversized old user turns.
 * 4–5. The protected tail pays LAST: an oversized recent tool result is clamped
 *    to head + rescued error lines + tail, so the prompt actually fits.
 *
 * Never touched: the system prompt, the FIRST user message (the ask), anything
 * before the watermark, and the last `RECENT_KEEP` messages (except the 4–5
 * clamps). Returns a NEW array (input untouched).
 */
export function trimThreadBudget(
  thread: ToolMessage[],
  maxChars: number = DEFAULT_THREAD_BUDGET_CHARS,
  opts: ThreadTrimOptions = {},
): ThreadTrimResult {
  const total = thread.reduce((a, m) => a + messageChars(m), 0);
  const sealed = Math.max(0, Math.min(opts.sealedThrough ?? 0, thread.length));
  if (total <= maxChars) return { thread, trimmed: 0, compacted: false, sealed };

  const out = [...thread];
  // Indices eligible for trimming: skip the system prompt, the first user
  // message, the RECENT_KEEP tail, and everything the watermark already froze.
  const firstUserIdx = thread.findIndex((m) => m.role === 'user');
  const eligible: number[] = [];
  for (let i = sealed; i < out.length - RECENT_KEEP; i++) {
    if (out[i].role === 'system') continue;
    if (i === firstUserIdx) continue;
    eligible.push(i);
  }

  let over = total - maxChars;
  let trimmed = 0;
  let compacted = false;
  let sealIndex = sealed;
  // A single result may never exceed half the budget, whatever the passes below
  // do (see MIN_TOOL_RESULT_CHARS).
  const perMessageCap = Math.max(MIN_TOOL_RESULT_CHARS, Math.floor(maxChars / 2));

  // ── Pass 0 — ONE compaction instead of N prefix rewrites ───────────────────
  // The span ends at the protected tail, and it may never end between an
  // assistant `tool_calls` block and its results: a provider rejects a request
  // whose tool result has lost its parent.
  if (over > 0 && eligible.length > 0 && opts.preferTrim !== true) {
    const start = eligible[0];
    const tailStart = Math.max(start, out.length - RECENT_KEEP);
    let cut = tailStart;
    while (cut > start && out[cut]?.role === 'tool') cut -= 1;
    while (cut > start && (out[cut - 1]?.toolCalls?.length ?? 0) > 0) cut -= 1;
    if (cut - start >= 2) {
      const span = out.slice(start, cut);
      const spanChars = span.reduce((a, m) => a + messageChars(m), 0);
      const rescued: string[] = [];
      let rescuedChars = 0;
      for (const m of span) {
        if (m.role !== 'tool' || m.content.length <= 500) continue;
        for (const line of errorLinesFrom(m.content)) {
          if (rescued.includes(line)) continue;
          if (rescued.length >= CLAMP_ERROR_LINES || rescuedChars + line.length > CLAMP_ERROR_CHARS) break;
          rescued.push(line);
          rescuedChars += line.length;
        }
      }
      const marker: ToolMessage = {
        role: 'user',
        content: compactionMessage({
          messages: span.length,
          chars: spanChars,
          digest: opts.digest ?? '',
          errors: rescued,
        }),
      };
      out.splice(start, span.length, marker);
      over -= spanChars - messageChars(marker);
      trimmed += span.length;
      compacted = true;
      sealIndex = start;
    }
  }

  // ── Passes 1–3 — fallback for a thread with no safe cut ────────────────────
  // Deliberately skipped once a compaction happened: those passes rewrite
  // messages AFTER the watermark, which is the per-call churn the compaction
  // exists to remove. The tail clamps below still bound the prompt.
  if (over > 0 && !compacted) {

  // Pass 1: collapse long OLD tool results to the stub (keep the first 500
  // chars so the model retains the gist of what it did).
  for (const i of eligible) {
    if (over <= 0) break;
    const m = out[i];
    if (m.role !== 'tool' || m.content.length <= 500) continue;
    const delta = m.content.length - 500 - TRIM_STUB.length;
    if (delta <= 0) continue;
    out[i] = { ...m, content: m.content.slice(0, 500) + TRIM_STUB };
    over -= delta;
    trimmed++;
  }
  // Pass 2: still over — collapse remaining OLD tool results entirely.
  if (over > 0) {
    for (const i of eligible) {
      if (over <= 0) break;
      const m = out[i];
      if (m.role !== 'tool' || m.content === TRIM_STUB) continue;
      over -= m.content.length - TRIM_STUB.length;
      out[i] = { ...m, content: TRIM_STUB };
      trimmed++;
    }
  }
  // Pass 3: STILL over (pathological — huge old user turns) — trim old USER
  // messages to a short stub. User messages carry no tool_call pairing, so
  // this is wire-safe (an assistant toolCalls block + its tool stub stay
  // paired; never fabricate tool messages — providers validate ids).
  if (over > 0) {
    for (const i of eligible) {
      if (over <= 0) break;
      const m = out[i];
      if (m.role !== 'user' || m.content.length <= 200) continue;
      const delta = m.content.length - 200 - TRIM_STUB.length;
      if (delta <= 0) continue;
      out[i] = { ...m, content: m.content.slice(0, 200) + TRIM_STUB };
      over -= delta;
      trimmed++;
    }
  }
}
  // ── Pass 4 — only NOW does the PROTECTED TAIL pay ─────────────────────────
  // Nothing older could cover the deficit, so an oversized RECENT tool result
  // must be clamped — otherwise the prompt goes out verbatim and either the
  // provider rejects it or the model silently loses its middle.
  //
  // MEASURED (trace-1791879575576-x731yp): step 4 ran a 24s test command; its
  // result landed in the tail, the oldest-first passes could not reach it, and
  // step 5 — handed to `local/qwen2.5:0.5b` (32K window) — recorded 5,292,237
  // context chars (~1.18M tokens), carried into the dashboard and cost ledger
  // as REAL input. Running this pass here (rather than before the oldest-first
  // passes) is deliberate: recent context is the model's working memory, so it
  // is spent only when older output cannot pay for the overage.
  // A tool message carries only the call ID, so the notice's tool name comes
  // from the assistant message that made the call. Built lazily: a turn whose
  // thread fits never walks the thread for names it will not print.
  const toolNameById = new Map<string, string>();
  const toolNameOf = (m: ToolMessage): string | undefined => {
    if (!m.toolCallId) return undefined;
    if (toolNameById.size === 0) {
      for (const t of thread) {
        for (const call of t.toolCalls ?? []) {
          if (call?.id) toolNameById.set(call.id, call.name);
        }
      }
    }
    return toolNameById.get(m.toolCallId);
  };
  if (over > 0) {
    for (let i = Math.max(0, out.length - RECENT_KEEP); i < out.length && over > 0; i++) {
      const m = out[i];
      if (m.role !== 'tool' || m.content.length <= perMessageCap) continue;
      const clamped = clampToolResult(m.content, perMessageCap, toolNameOf(m));
      if (clamped.length >= m.content.length) continue;
      out[i] = { ...m, content: clamped };
      over -= m.content.length - clamped.length;
      trimmed++;
    }
  }
  // Pass 5: STILL over — the protected tail holds the bulk even after the clamp
  // above; clamp its tool results harder rather than ship a prompt the model's
  // window cannot hold. Only TOOL results in the tail are touched — the user's
  // ask and the latest assistant turn stay.
  if (over > 0) {
    const tailFloor = Math.max(500, Math.floor(perMessageCap / 4));
    for (let i = Math.max(0, out.length - RECENT_KEEP); i < out.length && over > 0; i++) {
      const m = out[i];
      if (m.role !== 'tool') continue;
      const clamped = clampToolResult(m.content, tailFloor, toolNameOf(m));
      if (clamped.length >= m.content.length) continue;
      out[i] = { ...m, content: clamped };
      over -= m.content.length - clamped.length;
      trimmed++;
    }
  }
  // Index of the compaction message in the RETURNED thread. A tail clamp does
  // not move it, so the watermark survives unchanged until the next compaction.
  return { thread: out, trimmed, compacted, sealed: sealIndex };
}

// ─── Within-turn work digest (the memory a trimmed thread keeps) ────────────
// `trimThreadBudget` keeps the first 500 chars of each old tool result, but past
// that the model loses the VERDICT of what it ran and can re-run finished work.
// `working-state` solves this ACROSS turns; this solves it WITHIN one. It is
// deliberately deterministic and LLM-free (facts: what changed, what commands
// ran and whether they passed, which tools were used) — no summarizer, no
// latency, no drift, exactly like the ledger and the budget it complements.

/** Marker prefix identifying the loop's within-turn work digest message. */
export const WORK_DIGEST_MARKER = '[work digest — your actions so far this turn]';

/**
 * Format the turn's actions so far as a bounded, model-readable digest. Returns
 * '' when there is nothing worth saying, so a pristine turn adds no noise.
 */
export function buildWorkDigest(input: {
  successfulTools: readonly string[];
  mutatedPaths: readonly string[];
  executedActions: readonly ExecutedAction[];
}): string {
  const lines: string[] = [];
  const changed = [...new Set(input.mutatedPaths.filter(Boolean))];
  if (changed.length > 0) {
    const shown = changed.slice(-12);
    lines.push(`• Files changed (${changed.length}): ${shown.join(', ')}${changed.length > shown.length ? ', …' : ''}`);
  }
  // Commands with their verdict, newest first, deduped by command+verdict — the
  // single most valuable thing to retain (did the build/test pass?).
  const cmds = input.executedActions.filter((a) => typeof a.command === 'string' && a.command.trim());
  if (cmds.length > 0) {
    const seen = new Set<string>();
    const shown: string[] = [];
    for (let i = cmds.length - 1; i >= 0 && shown.length < 8; i -= 1) {
      const a = cmds[i];
      const key = `${a.ok ? 'ok' : 'fail'}:${a.command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      shown.unshift(`${a.ok ? '✅' : '❌'} ${a.command}`);
    }
    lines.push('• Commands run:');
    for (const s of shown) lines.push(`  ${s}`);
  }
  const tools = [...new Set(input.successfulTools)];
  if (tools.length > 0) lines.push(`• Tools used: ${tools.join(', ')}`);
  if (lines.length === 0) return '';
  return `${WORK_DIGEST_MARKER}\n${lines.join('\n')}`;
}

/** Marker prefix identifying the loop's mid-turn HANDOFF note. */
export const HANDOFF_NOTE_MARKER = '[handoff — the model serving this turn changed]';

/**
 * The note a mid-turn model switch leaves in the thread.
 *
 * It says three things the TRANSCRIPT cannot say by itself: that the pair
 * answering this step is not the pair that answered the previous ones, that the
 * context above is genuinely this model's to use (nothing was restarted), and
 * which work is already DONE (files changed, commands and their verdicts) — so
 * the replacement continues instead of re-deriving a plan from the ask. It also
 * states the rule that costs real steps when broken: do not re-run finished
 * commands or restate the work in more words.
 *
 * Deterministic and LLM-free, like the digest it borrows its facts from — a
 * handoff must not spend a model call to describe itself.
 */
export function buildHandoffNote(input: { route?: string; facts?: string }): string {
  const served = input.route
    ? ` This step is served by ${input.route}.`
    : ' This step is served by a different model.';
  const facts = (input.facts ?? '').trim();
  return (
    `${HANDOFF_NOTE_MARKER}${served}\n` +
    'The pair that had been answering returned nothing usable, so the turn was handed to you mid-flight —\n' +
    'everything above is YOUR context: the ask, every tool call and every result. Nothing was restarted.\n' +
    (facts ? `${facts}\n` : '') +
    'Continue from the work that is already done. Do not re-run finished commands, re-read files whose results\n' +
    'are above, or restate the work in more words.'
  );
}

/**
 * Insert or refresh the single handoff note. Idempotent — a turn may hand off
 * more than once (a second pair can also answer with nothing), and stacking a
 * note per handoff would fill the thread with the same information. Kept with
 * the run's framing (right after the leading system prompt) so it is a `system`
 * message: the thread-budget passes never trim one, and it therefore survives
 * every compaction between the handoff and the answer.
 */
export function upsertHandoffNote(thread: ToolMessage[], note: string): void {
  const existing = thread.findIndex((m) => m.content.startsWith(HANDOFF_NOTE_MARKER));
  if (existing !== -1) {
    thread[existing] = { ...thread[existing], content: note };
    return;
  }
  const insertAt = thread.length > 0 && thread[0].role === 'system' ? 1 : 0;
  thread.splice(insertAt, 0, { role: 'system', content: note });
}

/**
 * Insert or refresh the single work-digest message. Idempotent: a digest already
 * in the thread is UPDATED in place, never stacked, so repeated compaction in a
 * long turn keeps one current digest rather than accumulating stale ones. Placed
 * just after the system prompt + first user message so it sits with the ask and
 * survives the NEXT compaction (the tail is never trimmed).
 */
export function upsertWorkDigest(thread: ToolMessage[], digest: string): void {
  const existing = thread.findIndex((m) => m.content.startsWith(WORK_DIGEST_MARKER));
  if (existing !== -1) {
    thread[existing] = { ...thread[existing], content: digest };
    return;
  }
  let at = 0;
  while (at < thread.length && thread[at].role === 'system') at += 1;
  const firstUser = thread.findIndex((m) => m.role === 'user');
  const insertAt = Math.min(thread.length, firstUser === -1 ? at : Math.max(at, firstUser + 1));
  thread.splice(insertAt, 0, { role: 'user', content: digest });
}

/**
 * The bounded SELF-REVIEW correction — the loop's stand-in for a reviewer who
 * asks "is this actually what was asked for?".
 *
 * Fired once, only for a substantial turn that changed files and has already
 * been verified (the verification gate owns "did you check"). Its job is
 * orthogonal: catch a result that is verified but does not satisfy the WHOLE
 * original ask. It demands evidence from THIS turn and forbids padding the
 * answer with more prose — the failure mode it targets is a confident, verified
 * answer to a slightly wrong question.
 */
export function selfReviewNudge(ask: string): string {
  const quoted = (ask || '').trim().replace(/\s+/g, ' ').slice(0, 300);
  return (
    'Before you finish, REVIEW your result against the ORIGINAL request' +
    (quoted ? `: "${quoted}".` : '.') +
    '\nAnswer these to yourself in one short pass, and fix anything that is not true:' +
    '\n  1. Does what you produced satisfy EVERY part of that request — not just the part you found easiest?' +
    '\n  2. Is each claim in your answer backed by a tool result from THIS turn — or is it an assumption you did not check?' +
    '\n  3. Is anything the request asked for still missing, half-done, or done for the wrong target?' +
    '\nIf everything is satisfied and evidenced, reply with a brief confirmation and stop.' +
    ' If something is missing, do it NOW — or state plainly and specifically what is not done and why.' +
    ' Do NOT restate the work in more words — verify it.'
  );
}
