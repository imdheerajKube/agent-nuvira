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

import { getTool, toolJsonSchemas, type ToolContext, type ToolJsonSchema } from './registry.js';
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
import { stepDigest, type StepReplay } from '../learning/step-checkpoint.js';
// P2 (fix_model_routing) — the shared definition of "this response carries
// nothing usable". The loop does not re-invent the rule; it asks the same module
// the failover walk validates with, so "empty" means one thing in this repo.
import type { UnusableResponseKind } from '../learning/response-usability.js';
// P7 — the identical-command guard's memory. The loop drops it when a WRITE is
// applied, so a repaired project can re-run its own check (see the context below).
import { resetTerminalFailureStreaks } from './run-terminal.js';
import { createRunCommandMemo } from './command-memo.js';
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
import { wantsAuthoredArtifact } from '../learning/deliverable-class.js';
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
  detectUnverifiedEditClaim,
  isVerificationTool,
  verificationNudgeFor,
  THINK_ONLY_ESCALATION,
  AUTHORIZED_WORK_NUDGE,
  deliverableNudge,
  type ToolCallEvidence,
} from './edit-verification.js';
import { effectiveToolJsonSchemas, coreToolJsonSchemas, isToolEnabled, toolsetForTool } from './toolsets.js';
import { deliverablesNamedIn, recordStepHandoff } from '../agents/step-handoff.js';
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
    const text = (m.content ?? '').trim();
    if (!text || text.startsWith('[')) continue;
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
  /** Log a loop event (board note / console line). Defaults to logger.info. */
  onEvent?(line: string): void;
}

export interface ToolLoopOptions {
  /** The full conversation history INCLUDING the current user message. */
  messages: ToolMessage[];
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
      const parsed = JSON.parse(block) as { tool?: string; arguments?: Record<string, unknown> };
      if (parsed.tool && typeof parsed.tool === 'string') {
        calls.push({
          id: `call_${calls.length + 1}`,
          name: parsed.tool,
          arguments: parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {},
        });
      }
    } catch {
      // Unparseable block — dropped from the answer, no tool call.
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
 * Tools that are READ-ONLY and therefore safe to execute concurrently when the
 * model emits several of them in ONE step. Everything else — writes, terminal
 * commands, pipeline dispatch, delegation, `tool_search` (it mutates the
 * tiering state), `plan_todo`, `ask_user` (it blocks on user input) — stays
 * strictly serial and in the model's original order.
 *
 * Why this matters: tool results are fed back one step at a time and the step
 * budget is bounded (16), so N independent reads used to cost N sequential
 * round-trips of wall-clock. Reading several files/searches is the single most
 * common investigation pattern, so it becomes one bounded fan-out.
 *
 * The list is deliberately an ALLOWLIST (never a denylist): a tool added to
 * the registry later is SERIAL by default until it is reviewed as read-only.
 */
export const PARALLEL_SAFE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'list_dir',
  'glob',
  'code_search',
  'web_search',
  'read_page',
]);

/** Whether a tool may run concurrently with sibling calls in the same step. */
export function isParallelSafeTool(name: string): boolean {
  return PARALLEL_SAFE_TOOL_NAMES.has(name);
}

/** Max concurrent read-only calls per step (bounded fan-out) when the model
 *  has no harness opinion — see `ModelHarnessProfile.maxParallelReads`, which
 *  lowers this to 1 for tiny models that cannot use interleaved results. */
const MAX_PARALLEL_READS = 4;

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
 * Mutable turn-level progress shared with the wrapper. Kept OUT of the many
 * `runToolLoopInner` return sites so every exit path (cancel, bounded, terminal
 * dispatch, end-of-response) reports the same honest accounting.
 */
export interface ToolLoopProgress {
  /** Names of tool calls that ran successfully this turn. */
  successfulToolCalls: string[];
  /** True when a delivery tool reported an actual `✅` send. */
  deliveryConfirmed: boolean;
  /** Session 4 — paths mutated successfully this turn (for verification relevance). */
  mutatedPaths: string[];
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
  // Bounded dangling-promise nudges spent this turn (see INTENT_PROMISE_RE).
  let intentNudges = 0;
  // G1 — bounded verification nudges spent this turn (see requireVerification).
  let verificationNudges = 0;
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
  // ZERO-ACTION — bounded "the request directed work and NOTHING was done"
  // nudges (see requireAction / zeroActionGateApplies).
  let actionNudges = 0;
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
  /** Serving pairs the loop has already told the model about, oldest first. */
  const routeFeedState = { pairs: [] as string[] };
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
  const budgetChars = opts.threadBudgetChars ?? DEFAULT_THREAD_BUDGET_CHARS;
  // P3d — per-turn parallel suggester: after 2+ successful independent gather
  // steps, one advisory delegate suggestion fires (bounded, deterministic).
  const parallel = makeParallelSuggester();
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
    if (steps < SELF_REVIEW_MIN_STEPS) return null;
    if (progress.mutatedPaths.length === 0) return null;
    // The verification gate owns "did you check it"; self-review only runs once
    // that question is settled, so the two can never both fire in one turn.
    const activity = assessEditActivity(progress.successfulToolCalls, progress.verificationEvidence, progress.mutatedPaths);
    if (activity.needsVerification) return null;
    return selfReviewNudge(currentAsk(opts));
  };

  for (;;) {
    // ── Bounded auto-continuation on the STEP BOUND ────────────────────────
    // The model still wanted to act when the budget ran out (a long build, a
    // many-file edit). Extend the budget a bounded number of times and keep
    // the SAME thread — completed tool calls are never re-run — instead of
    // telling the user "I reached my step limit" with the task unfinished.
    if (steps >= stepLimit + handoffAttemptCredit) {
      if (continuations < maxContinuations) {
        continuations += 1;
        stepLimit += continuationSteps;
        deps.onEvent?.(
          `   🔄 Step bound reached with work remaining — continuing (continuation ${continuations}/${maxContinuations}, budget ${stepLimit} steps).`,
        );
        continue;
      }
      break;
    }
    // P4 — check cancellation BEFORE each step (a pre-aborted signal never
    // spends a model call) and after tool executions (below).
    if (opts.signal?.aborted) {
      return { content: '', followups, toolCalls: toolCallsRun, steps, ...(opts.resume ? { replayedSteps } : {}), bounded: false, cancelled: true, termination: 'cancelled' };
    }
    steps += 1;
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
      const trimmedResult = trimThreadBudget(thread, budgetChars);
      if (trimmedResult.trimmed > 0) {
        thread.length = 0;
        thread.push(...trimmedResult.thread);
        // Keep a memory of what the turn DID after its raw outputs are gone:
        // without this, a long turn loses the VERDICTS (did the build pass?) and
        // re-runs work it already finished. Deterministic and bounded — the same
        // philosophy as trimThreadBudget itself (facts, no summarizer, no drift).
        if (isWorkDigestEnabled(context.configManager)) {
          const digest = buildWorkDigest({
            successfulTools: progress.successfulToolCalls,
            mutatedPaths: progress.mutatedPaths,
            executedActions: progress.executedActions,
          });
          if (digest) upsertWorkDigest(thread, digest);
        }
        deps.onEvent?.(`   ✂️ ${trimmedResult.trimmed} old tool result(s) trimmed to fit the ${Math.round(budgetChars / 1000)}K-char context budget.`);
      }
    }
    // ── The route feed, re-synced before every call ────────────────────────
    // Placed here rather than at thread construction because THIS is the last
    // point before the call: a failover during step N must be visible at step
    // N+1, and a single up-front line would have the model answering about a
    // model that has since stopped serving it.
    syncRouteFeed(thread, opts.servedRoute, routeFeedState);
    let response: StepResponse;
    try {
      // WS5 (#27) — a resumed run replays this step when its input is unchanged.
      // The key is the step's POSITION and the digest is its whole input, so both
      // have to line up: a plan that shifted by one step replays nothing (the
      // positions hold different inputs), while a re-run of the same plan replays
      // every step whose thread and schema are byte-identical.
      const resumeKey = `model:${steps}`;
      const resumeDigest = opts.resume ? stepDigest(thread, schemas) : '';
      const replayed = opts.resume?.replay(resumeKey, resumeDigest) ?? null;
      if (replayed) {
        response = replayed;
        replayedSteps += 1;
        deps.onEvent?.(`   ↩️ step ${steps} replayed from the checkpoint — no model call`);
      } else {
        response = await deps.callModel(thread, schemas, opts.onToken, opts.signal);
        // Recorded AFTER the call, and only what the model actually returned: a
        // failed call records nothing, so a resume cannot inherit a failure as an
        // answer.
        if (opts.resume) opts.resume.record(resumeKey, resumeDigest, response);
      }
      // A provider/adapter that resolves with nothing usable (undefined, a
      // missing content field) must not crash the turn — treat it as this
      // step's generation failure so the bounded continuation logic below can
      // resume or return gracefully. Malformed steps used to throw a raw
      // TypeError out of the loop and kill an otherwise-recoverable turn.
      if (!response || typeof response.content !== 'string' || !Array.isArray(response.toolCalls)) {
        throw new Error('model returned a malformed step response (no content/toolCalls)');
      }
      // R2 — the transport the caller reported for THIS step. Recorded before
      // anything can return, so a turn that dies mid-way still attributes the
      // transport that served the steps it did complete.
      if (response.transport) progress.transport = response.transport;
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
      const delivered = lastContent.trim();
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
        generationFailed: delivered === '' || !madeProgress,
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
      lastContent = response.content;
      // Stamp what this answer is an account OF, so the next step can tell an
      // update from a wrapper (see `workCallsBeforeLastContent`). Deferred to the
      // top of the next iteration so it includes THIS step's own work.
      pendingContentStamp = true;
    }
    const { toolCalls } = response;
    // P2 — the model just produced something usable (text, or at least one tool
    // call), so its empty-response streak is over: a later blip starts a NEW
    // streak rather than inheriting one from twenty steps ago.
    if (toolCalls.length > 0 || !responseThinkOnly) emptyRetriesOnCurrentModel = 0;

    if (toolCalls.length === 0) {
      // No tools → end turn UNLESS the content is think-only (
      // isThinkOnlyResponse: continue instead of ending).
      if (deps.isThinkOnly ? deps.isThinkOnly(response.content) : isThinkOnlyResponse(response.content)) {
        // Feed an empty assistant step so the model continues in-context.
        thread.push({
          role: 'assistant',
          content: response.content,
          // Keep the thinking model's reasoning with the turn it belongs to.
          ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
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
          thread.push({ role: 'user', content: THINK_ONLY_ESCALATION });
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
      if (
        intentNudges < 1 &&
        progress.successfulToolCalls.length === 0 &&
        schemas.length > 0 &&
        detectUnfulfilledIntentPromise(
          response.content.length >= lastContent.length ? response.content : lastContent,
        )
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
        thread.push({
          role: 'user',
          content:
            'You announced an action you were about to take, but no tool was called and nothing was done. ' +
            'Either carry it out now with the tools available, or reply with the actual answer — do not end the turn on a promise.',
        });
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
        // The question must not become the delivered answer. When nothing was
        // done this turn the whole step is the question, so drop it. When real
        // work WAS done, keep the work and cut only the trailing question —
        // otherwise a longer "…Do you want me to…?" outranks a short, real
        // follow-up answer under the longest-substantive rule below.
        if (progress.successfulToolCalls.length === 0) {
          lastContent = '';
        } else {
          lastContent = stripTrailingPermissionSeek(
            response.content.length >= lastContent.length ? response.content : lastContent,
          );
        }
        thread.push({ role: 'assistant', content: response.content });
        thread.push({ role: 'user', content: AUTHORIZED_WORK_NUDGE });
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
          lastContent = stripTrailingPermissionSeek(closing);
        }
        thread.push({ role: 'assistant', content: response.content });
        thread.push({ role: 'user', content: repeatNudge(closing, runTrace.priorAnswer(closing)) });
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
        thread.push({ role: 'user', content: zeroActionNudge(currentAsk(opts)) });
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
        thread.push({ role: 'user', content: deliverableNudge(authorization.requestedPath) });
        continue;
      }
      //
      // G1 — VERIFICATION GATE: before the turn can end, if it MUTATED the
      // workspace and ran nothing that observed the result, spend ONE bounded
      // nudge asking for the check. The gate is deliberately a nudge, not a
      // hard block: a task with no runnable check (a prose answer, a config
      // edit outside the workspace) must still be deliverable — the residual
      // `unverifiedEdit` flag carries the honesty for that case.
      if (
        verificationNudges < 1 &&
        opts.requireVerification !== false &&
        schemas.length > 0 &&
        assessEditActivity(progress.successfulToolCalls, progress.verificationEvidence, progress.mutatedPaths)
          .needsVerification
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
        thread.push({
          role: 'user',
          content: verificationNudgeFor(ctx.cwd ?? process.cwd(), progress.mutatedPaths),
        });
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
        thread.push({ role: 'user', content: review });
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
      ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
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
    const deferredUserNudges: string[] = [];

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
      if (call.argumentsError) {
        // C — the call was never made: the argument payload did not arrive.
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
            deferredUserNudges.push(formatPreflightFindings(findings));
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
      deferredUserNudges.push(planRequiredNudge(currentAsk(opts)));
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
      const ranOk =
        refusal === null &&
        !rawResult.startsWith('Error:') &&
        (!DELIVERY_TOOL_NAMES.has(call.name) || deliveryResultSucceeded(rawResult));
      if (ranOk) {
        progress.successfulToolCalls.push(call.name);
        stepAnySuccess = true;
      }
      if (call.name === 'gateway_send' && deliveryResultSucceeded(rawResult)) {
        progress.deliveryConfirmed = true;
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
            // Stage 2 — the run's own record of what it CHANGED, so a self-report
            // can answer "what have you been doing" from data rather than from a
            // re-read of the transcript.
            runTrace.recordMutation(call.name, p);
          }
        } else if (isVerificationTool(call.name)) {
          progress.verificationEvidence.push({ tool: call.name, args: call.arguments, result: rawResult });
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
      });      thread.push({ role: 'tool', toolCallId: call.id, content: resultText });
    }

    // Flush the planning-time nudges now that the assistant's tool_calls group is
    // complete (every call id has a `tool` result). This is the first point a
    // user/system message may safely follow the batch.
    for (const nudge of deferredUserNudges) thread.push({ role: 'user', content: nudge });

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
      thread.push({ role: 'user', content: malformedCallNudge(malformedToolCalls) });
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
        thread.push({ role: 'user', content: repeatedFailureNudge(repeated) });
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
        thread.push({ role: 'user', content: noProgressNudge(runTrace.recentFailures(3), failedToolSteps) });
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
      if (
        verificationNudges < 1 &&
        opts.requireVerification !== false &&
        schemas.length > 0 &&
        assessEditActivity(progress.successfulToolCalls, progress.verificationEvidence, progress.mutatedPaths)
          .needsVerification
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
        thread.push({
          role: 'user',
          content: verificationNudgeFor(ctx.cwd ?? process.cwd(), progress.mutatedPaths),
        });
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
        thread.push({ role: 'user', content: deliverableNudge(authorization.requestedPath) });
        continue;
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
        thread.push({ role: 'user', content: zeroActionNudge(currentAsk(opts)) });
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
        thread.push({ role: 'user', content: review });
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
  } else {
    deps.onEvent?.(`   ⚠️ Tool loop reached its ${stepLimit}-step budget — returning the last response.`);
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
    content: lastContent || 'I reached my step limit for this request.',
    followups,
    toolCalls: toolCallsRun,
    steps,
    ...(opts.resume ? { replayedSteps } : {}),
    bounded: true,
    continuations,
    ...(modelHandoffs > 0 ? { modelHandoffs } : {}),
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
 * Tool-shaped actions a first-person imminent promise can drop. Matched by
 * STEM (`\w*` suffix) so "scaffold" covers "scaffolding", "write" covers
 * "writing", etc. — the promise is usually phrased as a gerund ("start by
 * scaffolding").
 */
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
function syncRouteFeed(
  thread: ToolMessage[],
  read: (() => ServedRoute | null) | undefined,
  observed: { pairs: string[] },
): void {
  if (!read) return;
  let route: ServedRoute | null = null;
  try {
    route = read();
  } catch {
    // A route read must never break the turn; an unknown route is a fact too.
    return;
  }
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
    verificationEvidence: [],
    executedActions: [],
  };
  const result = await runToolLoopInner(opts, progress);
  // R2 — relay the transport the caller's seam reported. Attached on EVERY
  // exit path, including a cancelled/failed turn: if a model call happened over
  // the JSON fallback before the turn died, that is a fact about the run.
  if (progress.transport) result.transport = progress.transport;
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
    );
    if (activity.needsVerification) {
      result.unverifiedEdit = true;
    }
    if (detectUnverifiedEditClaim(result.content, activity.mutations, activity.verifications)) {
      result.unverifiedEditClaim = true;
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
      wantsAuthoredArtifact(lastUserText(opts.messages))
    ) {
      result.undeliveredArtifact = true;
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
  }
  return result;
}

/**
 * Does the DELIVERABLE gate apply to this turn (G13b)?
 *
 * The conjunction is the whole point, and every term is an independent fact:
 *
 *   - the request asks for an AUTHORED deliverable to be PRODUCED
 *     (`wantsAuthoredArtifact` — the same predicate the engine router uses, so
 *     "what the user asked for" is defined once);
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
  return wantsAuthoredArtifact(requestText);
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
  /\b(?:file|files|function|functions|method|methods|class|classes|module|modules|script|scripts|component|components|test|tests|suite|api|endpoint|endpoints|route|routes|schema|schemas|migration|migrations|package|dependency|dependencies|import|imports|config|configuration|type|types|interface|interfaces|bug|bugs|repo|repository|codebase|project|source)\b/i;

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
function summarizeArgs(args: Record<string, unknown>): string {
  const first = Object.entries(args).slice(0, 1)[0];
  if (!first) return '{}';
  const [key, value] = first;
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

/** Estimated character size of one thread message (chars/4 ≈ tokens). */
function messageChars(m: ToolMessage): number {
  return (m.content?.length ?? 0) + (m.toolCalls?.length ? JSON.stringify(m.toolCalls).length : 0);
}

/**
 * Deterministically trim a thread to `maxChars`:
 * 1. Never touch the system prompt or the FIRST user message (the ask).
 * 2. Never touch the last `RECENT_KEEP` messages (recent context).
 * 3. Oldest-first: tool results longer than 500 chars collapse to the stub;
 *    if still over budget, remaining old tool results collapse entirely.
 * Returns a NEW array (input untouched) + how many messages were trimmed.
 */
export function trimThreadBudget(
  thread: ToolMessage[],
  maxChars: number = DEFAULT_THREAD_BUDGET_CHARS,
): { thread: ToolMessage[]; trimmed: number } {
  const total = thread.reduce((a, m) => a + messageChars(m), 0);
  if (total <= maxChars) return { thread, trimmed: 0 };

  const out = [...thread];
  // Indices eligible for trimming: skip the system prompt, the first user
  // message, and the RECENT_KEEP tail.
  const firstUserIdx = thread.findIndex((m) => m.role === 'user');
  const eligible: number[] = [];
  for (let i = 0; i < out.length - RECENT_KEEP; i++) {
    if (out[i].role === 'system') continue;
    if (i === firstUserIdx) continue;
    eligible.push(i);
  }

  let over = total - maxChars;
  let trimmed = 0;
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
  return { thread: out, trimmed };
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
