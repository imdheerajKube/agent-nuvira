/**
 * WS0 (#22) — the capability matrix.
 *
 * The user-facing requirement this encodes: **the experience and the execution
 * must be the same on chat, execute, dashboard chat, the gateway and subagents.**
 * A requirement like that is only real if a capability cannot be added to one
 * surface without someone answering for the other four — otherwise it is a
 * promise in a document, and this repo has already been burned by exactly that
 * shape of promise (the dashboard bundle was hand-maintained generated output;
 * the Subagents tab shipped while the served bundle did not contain it).
 *
 * TWO ORTHOGONAL QUESTIONS, kept apart on purpose:
 *
 *   - `status`  — what we BELIEVE. Declared here by a human, per surface.
 *   - `verified` — what the parity tests PROVE today, per capability × surface.
 *
 * A capability believed to work everywhere but proven on two surfaces is a fair
 * thing to have mid-workstream — and a dishonest thing to call "at par". So
 * `unverifiedClaims(verified)` names every such cell, and the matrix test
 * asserts it equals a frozen list that can only shrink. Same ratchet as
 * `SURFACE_DEBT`: growth fails (a new unprovable claim appeared), and a stale
 * entry fails (one was proven and the list still claims it needs proof).
 *
 * The keys are per capability × surface, never per surface alone: a driver that
 * proves a turn ran does not thereby prove its tool-call lifecycle was reported,
 * and treating those as one thing is how a matrix starts flattering itself.
 *
 * Scope note: fault injection (WS6) and the seeded-bug benchmark (WS7) are test
 * infrastructure, not capabilities a surface can have, so they are deliberately
 * absent rather than marked "not applicable" five times.
 */

import { SURFACES, type SurfaceId } from './surfaces.js';

/** A capability a person could observe on a surface. */
export type CapabilityId =
  | 'turn-parity'
  | 'run-attribution'
  | 'tool-call-lifecycle'
  | 'findings-verdicts'
  | 'debug-log'
  | 'otel-export'
  | 'tool-hooks'
  | 'isolation-worktree'
  | 'partial-resume';

/**
 * What we believe about one capability on one surface.
 *
 *  - `supported` — believed to work here.
 *  - `planned`   — not built anywhere yet; the owning workstream adds it.
 *  - `scoped`    — deliberately different here, and the note says why. A scoped
 *                  cell is a decision, which is why it must be explained.
 */
export type CellStatus = 'supported' | 'planned' | 'scoped';

export interface MatrixCell {
  status: CellStatus;
  /** Required for `scoped`, and for every cell on the unverified debt list. */
  note?: string;
}

export interface Capability {
  id: CapabilityId;
  label: string;
  /** The tracker workstream that owns it, so the matrix and the issue list agree. */
  workstream: Workstream;
  /** One cell per surface. Typed so a missing surface is a compile error. */
  cells: Record<SurfaceId, MatrixCell>;
}

export type Workstream = 'existing' | 'WS0' | 'WS1' | 'WS2' | 'WS3' | 'WS4' | 'WS5' | 'WS6' | 'WS7';

/** The tracker issues, so a reader can go from a cell to the work that owns it. */
export const WORKSTREAM_ISSUES: Record<Workstream, number | null> = {
  existing: null,
  WS0: 22,
  WS1: 23,
  WS2: 24,
  WS3: 25,
  WS4: 26,
  WS5: 27,
  WS6: 28,
  WS7: 29,
};

/** Every surface, so a row can be built without repeating the list five times. */
const EACH: SurfaceId[] = SURFACES.map((s) => s.id);

/** A row with the same cell on every surface. */
function everywhere(status: CellStatus, note?: string): Record<SurfaceId, MatrixCell> {
  const cells = {} as Record<SurfaceId, MatrixCell>;
  for (const surface of EACH) cells[surface] = note ? { status, note } : { status };
  return cells;
}

/**
 * The subagent is DRIVEN for real — a forked child against a stub server — and
 * now AGREES, rather than diverging on identity.
 */
const SUBAGENT_AT_PAR =
  'Proven: a forked child at transport depth (the real Groq adapter talking to a stub server) is folded into the same comparison as the in-process surfaces and comes out at-par. The child still resolves its OWN provider from configuration — that is the isolation boundary, a separate process with its own provider object and loop — and the parity harness points that provider at the SAME id (`groq`) and transport (`native`) the other surfaces report, so agreement is evidence rather than a stub coincidence.';

export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'turn-parity',
    label: 'The same message produces the same status, answer and reported provider, with no divergent tool calls',
    workstream: 'WS0',
    cells: {
      'cli-chat': { status: 'supported', note: 'Proven: driven through ChatCommand.answerOnce with the stub at provider depth.' },
      'cli-execute': { status: 'supported', note: 'Proven: the driver drives the COMMAND`s own single-goal path (`runSingleGoal`) with the provider stubbed at the shared factory, so the surface itself — not just the loop engine it runs on — produces the same status, answer, provider, model and transport as the chat surfaces. The command no longer owns a provider or an orchestrator (SURFACE_DEBT is empty); its pipeline arm runs through runPipelineTool and its loop arm through runLoopExecutor.' },
      'dashboard-chat': { status: 'supported', note: 'Proven: driven through ChatConsole.answer with no injected engine, so the console loads the same real ChatCommand.' },
      'gateway-chat': { status: 'supported', note: 'Proven: driven through GatewayRegistry.handleInbound with no chat engine injected, so runInboundChat lazy-imports the same real ChatCommand and the reply path runs.' },
      subagent: { status: 'supported', note: SUBAGENT_AT_PAR },
    },
  },
  {
    id: 'run-attribution',
    label: 'A run records the provider, model and transport that served it, success or failure',
    workstream: 'existing',
    cells: {
      'cli-chat': { status: 'supported', note: 'Proven: answerOnce returns the full triple — provider, model and now transport (R2) — and the parity run asserts all three agree across the surfaces that hand the triple to their caller.' },
      'cli-execute': { status: 'supported', note: 'Proven: the command`s single-goal result carries provider, model and transport, and its `--json-events` result line carries the same two plus transport for the loop arm. Both engine arms report: the loop arm from `runLoopExecutor`, the pipeline arm from the wrapper it drives (provider/model; the pipeline`s per-agent tool transport is not tracked, so it is omitted rather than invented).' },
      'dashboard-chat': { status: 'supported', note: 'Proven: ChatAnswerResult carries provider, model and transport (R2), so the console hands its caller the same triple the CLI does, and the parity run asserts they agree.' },
      'gateway-chat': { status: 'supported', note: 'Proven: runInboundChat (src/gateway/registry.ts) returns provider, model and transport to its caller and writes the same triple to the gateway log (`inbound.chat`), so a messaging run is attributable after the fact — the one surface with no terminal to scroll. The driver reads the surface`s own return, not the engine`s.' },
      subagent: { status: 'supported', note: 'Proven: the child announces provider/model/transport before it can fail, repeats them on the error frame, and the manager records them on the run — asserted by the transport-depth parity case, which requires all three to be present and real.' },
    },
  },
  {
    id: 'tool-call-lifecycle',
    label: 'Tool calls are reported as structured lifecycle events (started → called), not just text',
    workstream: 'existing',
    cells: {
      'cli-chat': { status: 'supported', note: 'Verified by the parity harness: the executed call and its outcome are reported to the caller through onToolCall (chat.ts:1412).' },
      'cli-execute': { status: 'supported', note: 'Proven: the loop arm reports each call`s outcome in order (`toolOutcomes`), read from the loop`s own `tool`/`refusal` events and handed back by the command, so a caller can say WHICH call failed rather than pairing an ordered name list with a separate error set (ambiguous when a tool runs twice).' },
      'dashboard-chat': { status: 'supported', note: "Verified by the parity harness through the console event stream. Deliberately different for three tools: ask_user, suggest_followups and plan_todo render as their own cards (question / chips / checklist) instead of tool cards — a UI decision, cited at chat-console.ts:656." },
      'gateway-chat': { status: 'supported', note: 'Proven: runInboundChat wires the engine`s onToolCall seam, records each `called` outcome on its return and in the `inbound.chat` log — internal, exactly like onProgress and never sent to the channel sender. The driver reads the surface`s own return, so a gateway turn`s tool work is attributable.' },
      subagent: { status: 'supported', note: 'Proven: the child reports each call as two IPC frames — `tool_call` (the name) then `tool_result` (the name AND its outcome, on the same `Error:` convention the main loop uses) — and the driver records the call with its outcome. A call whose outcome frame never arrives keeps `ok` absent, which is the honest reading of a truncated run.' },
    },
  },
  {
    id: 'findings-verdicts',
    label: 'A finding carries CONFIRMED/PLAUSIBLE and an outcome, and cannot be promoted without evidence',
    workstream: 'WS1',
    // NOW PROVEN ON EVERY SURFACE, and the proof is two-sided on purpose. The
    // `finding` tool (`tools/finding-tool.ts`) lets the model state a claim and
    // the evidence it checked, and NEVER the verdict — the gate
    // (`findings/verdicts.ts`) decides, promoting only when a non-blank evidence
    // reference was supplied. Two parity scenarios drive it: `finding-confirmed`
    // (usable evidence ⇒ CONFIRMED, with the evidence carried) and
    // `finding-refused` (a blank reference ⇒ the promotion is refused and every
    // surface must report PLAUSIBLE). The second is the one that matters —
    // agreement on a promoted verdict that nothing earned is the defect this
    // whole workstream exists to close.
    cells: {
      'cli-chat': {
        status: 'supported',
        note: 'Proven: a turn that calls `finding` reports the gated wire finding on the engine result (ChatAnswerResult.findings) AND through the `onFinding` seam, driven by the `finding-confirmed` / `finding-refused` scenarios.',
      },
      'cli-execute': {
        status: 'supported',
        note: 'Proven: the command returns the findings its run recorded — the loop arm from its own context bus (`finding:recorded`), the direct-answer arm from the engine`s `onFinding` seam — asserted by the same two scenarios.',
      },
      'dashboard-chat': {
        status: 'supported',
        note: 'Proven: the console collects findings from the engine seam onto ChatAnswerResult.findings AND forwards each one live as a `finding` event over the chat SSE stream, so a dashboard caller reads the same wire verdicts as the CLI. The GUI draws a verdict card per finding (evidence for a CONFIRMED one, an explicit "no evidence — reported as PLAUSIBLE" for the rest) and the POST response stays authoritative for the snapshot — pinned by the ChatPage finding-card case.',
      },
      'gateway-chat': {
        status: 'supported',
        note: 'Proven: runInboundChat records each finding on its `inbound.chat` log entry and its return — internal, exactly like the tool lifecycle, and never sent to the channel sender. The driver reads the surface`s own durable record.',
      },
      subagent: {
        status: 'supported',
        note: 'Proven: the child ships each recorded finding on its own `finding` progress frame and the manager accumulates them on the run, so a forked subagent reports the verdicts it produced rather than leaving them inside its process.',
      },
    },
  },
  {
    id: 'debug-log',
    label: 'A session debug log you can attach to a bug report, with a header naming the backend',
    workstream: 'WS2',
    // NOW SUPPORTED ON EVERY SURFACE, and the proof is read from DISK rather
    // than from a return value. `observability/debug-log.ts` writes one plain
    // text file per turn — opt-in via `NUVIRA_DEBUG_LOG`, redacted with the
    // gateway's own `scrubSecrets`, bounded in lines and bytes, and written ONCE
    // at turn end so its header can name the backend that ACTUALLY served the
    // turn (the provider walk mutates `session.model`/`lastAttempt`/`servedRoute`
    // mid-turn, so anything captured at turn START would be wrong exactly when
    // failover happened). The parity harness turns logging on for the whole run,
    // then reads each surface's own file back: `written: true` on every surface
    // and the same provider/model/transport triple in every header — asserted by
    // 'writes a session debug log whose header names the backend, on every
    // surface' in `tests/parity/scenario-parity.test.ts`. The `written: false`
    // case is the load-bearing one: a surface that produces NOTHING must diverge,
    // not agree.
    cells: {
      'cli-chat': {
        status: 'supported',
        note: 'Proven: `ChatCommand.runChatAnswer` opens the log for the turn, records turn start, every tool start/end and every finding, then writes it with the backend from `lastAttempt` (which the provider walk keeps current) and reports the path on the console. Read back from disk by the cli-chat driver.',
      },
      'cli-execute': {
        status: 'supported',
        note: 'Proven: BOTH arms log. The loop arm (`runLoopExecutor`) opens the log before routing — so a run that dies in the provider walk still leaves evidence — and records each tool/gate/refusal event, closing with `servedRoute` (kept current through failover). The direct-answer arm passes `debugSurface: "cli-execute"` down to the shared chat engine, so its log is attributed to the command that ran it rather than mislabelled `cli-chat`.',
      },
      'dashboard-chat': {
        status: 'supported',
        note: 'Proven: the console passes `debugSurface: "dashboard-chat"` to the shared engine, so a dashboard turn\'s log names the dashboard rather than the CLI. Read back from the isolated profile the console wrote into. The console also records WHICH conversation the turn belonged to (`debugSession`), so the log is findable rather than only readable: `GET /api/chat/:sessionId/support-bundle` hands back the logs that conversation wrote (selected by each log`s own header, never by recency), plus the conversation and a manifest — pinned by the support-bundle cases in `tests/web-dashboard/chat-api.test.ts`.',
      },
      'gateway-chat': {
        status: 'supported',
        note: 'Proven: `runInboundChat` passes `debugSurface: "gateway-chat"` to the shared engine, so a messaging turn\'s attachable log names the gateway — the surface with no terminal to scroll, and therefore the one where a written artifact matters most.',
      },
      'subagent': {
        status: 'supported',
        note: 'Proven: the CHILD opens its own log after it constructs its own provider (so the header names the backend from the first line), records turn start, each tool start/end, refusals and findings, and writes into ITS isolated profile — the driver reads it from the child`s config dir, not the parent`s, because a forked process is the isolation boundary. A provider refusal still writes the log before throwing.',
      },
    },
  },
  {
    id: 'otel-export',
    label: 'A span tree exported over OTLP when configured, with trace context propagated to child processes',
    workstream: 'WS3',
    // `NUVIRA_OTEL=1` turns export on for every surface — the gate lives in ONE
    // module (`observability/otel.ts`) and each surface only opens a turn span
    // there. Off by default, and with it off the SDK is never imported.
    cells: {
      'cli-chat': {
        status: 'supported',
        note: 'Proven: `ChatCommand.runChatAnswer` opens the turn span beside the debug log (before the cache check and the provider walk, so a turn that dies in routing is still visible), passes it to `runToolLoop` so every executed call becomes a child span, records each finding as a span EVENT (a finding has no duration), and closes it with the turn`s own outcome before flushing. Proven by the `otel-export` parity scenario: a real collector receives `nuvira.turn` with a `nuvira.tool.list_dir` child, one trace, service `agent-nuvira`.',
      },
      'cli-execute': {
        status: 'supported',
        note: 'Proven: BOTH arms export. The loop arm opens the turn span in `runLoopExecutor` before routing and closes it on both the success and the THROW path (a crashed run is a red span rather than a missing one); the direct-answer arm reports `cli-execute` through the shared chat engine it passes `debugSurface` to. Proven by the `otel-export` parity scenario, which drives the command`s own `runSingleGoal`.',
      },
      'dashboard-chat': {
        status: 'supported',
        note: 'Proven: the console hands the shared engine its surface (`dashboard-chat`) and its session, so a dashboard turn`s span is attributed to the dashboard and to the conversation it belonged to — the same identity its session debug log carries. The engine flushes per turn, so the provider outlives the turn in a long-running server while each turn`s spans ship as it ends. Proven by the `otel-export` parity scenario.',
      },
      'gateway-chat': {
        status: 'supported',
        note: 'Proven: `runInboundChat` passes `debugSurface: "gateway-chat"` to the shared engine, so the messaging surface — the one with no terminal to scroll — exports the same turn tree as the CLI. Proven by the `otel-export` parity scenario, which drives the REAL registry handler with no engine injected.',
      },
      'subagent': {
        status: 'supported',
        note: 'Proven, INCLUDING the trace context across the fork: the child opens its OWN turn span in `runSubagent` (one-shot, so it flushes and shuts the provider down before it reports its result), and `subagent-spawner` injects the ambient W3C `traceparent` into the child`s environment — read from the ACTIVE span, so two turns interleaving in one server cannot hand each other`s trace ids to a child. The child resumes from that header, so its turn span hangs off the tool call that spawned it and the whole turn is ONE trace. Proven by the `otel-export` parity scenario (the child`s spans are read back from a real collector in its own process) and by the fork case in `tests/tools/subagent-end-to-end.test.ts`, which asserts the child`s remote parent IS the parent`s tool span and that both share one trace id.',
      },
    },
  },
  {
    id: 'tool-hooks',
    label: 'Tool lifecycle hooks (before/after/failed) an operator can subscribe to for instrumentation or veto',
    workstream: 'WS4',
    cells: everywhere('planned'),
  },
  {
    id: 'isolation-worktree',
    label: 'An investigation can be isolated in a git worktree and returns a diff against the base',
    workstream: 'WS5',
    cells: everywhere('planned'),
  },
  {
    id: 'partial-resume',
    label: 'A resumed run reuses unchanged steps instead of re-paying for every model call',
    workstream: 'WS5',
    cells: everywhere('planned'),
  },
];

/**
 * Cells that believe they are `supported` but that the parity tests do not
 * prove, as `capability@surface` keys. Frozen: a new key fails the matrix test,
 * and a key whose cell became verified also fails until it is deleted — so the
 * list can only shrink, and every line is a debt the harness has to pay off.
 *
 * EMPTY — and that is the ratchet working, not the rule being relaxed. Every
 * surface is driven, and every `supported` claim on every surface is backed by a
 * case in `tests/parity/`. The last three left in one step by REPORTING facts at
 * the surface boundary rather than building capabilities: the gateway wired the
 * engine`s onToolCall, the command reported each call`s outcome instead of a name
 * list beside an error set, and the subagent was driven on the same provider id
 * and transport as the in-process surfaces so its turn could be compared rather
 * than merely refused.
 *
 * The constant stays declared with an empty array on purpose: deleting it would
 * stop the rule being measured, and the next unprovable `supported` claim would
 * then be invisible instead of a one-line diff here. The REASON for any future
 * entry lives on the cell's `note`, which the matrix test requires to be
 * non-empty for every entry on the list — one place per fact, so the two cannot
 * drift apart.
 */
export const UNVERIFIED_SUPPORTED: readonly string[] = [];

/** The stable key for one cell, so nothing else invents its own format. */
export function cellKey(capability: CapabilityId, surface: SurfaceId): string {
  return `${capability}@${surface}`;
}

/** Every capability × surface cell, flattened, for reporting and assertions. */
export function matrixCells(): Array<{ capability: CapabilityId; surface: SurfaceId; cell: MatrixCell }> {
  const out: Array<{ capability: CapabilityId; surface: SurfaceId; cell: MatrixCell }> = [];
  for (const capability of CAPABILITIES) {
    for (const surface of EACH) {
      out.push({ capability: capability.id, surface, cell: capability.cells[surface] });
    }
  }
  return out;
}

/**
 * Cells that include `supported` but that the harness does not PROVE, as cell
 * keys. `verified` is the set the parity tests actually assert today.
 */
export function unverifiedClaims(verified: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const { capability, surface, cell } of matrixCells()) {
    if (cell.status !== 'supported') continue;
    if (verified.has(cellKey(capability, surface))) continue;
    out.push(cellKey(capability, surface));
  }
  return out.sort();
}

/** The frozen list, normalised the same way, for an equality assertion. */
export function declaredUnverifiedClaims(): string[] {
  return [...UNVERIFIED_SUPPORTED].sort();
}

/** Surfaces where a capability is deliberately different, and why. */
export function scopedExceptions(): Array<{ capability: CapabilityId; surface: SurfaceId; note: string }> {
  return matrixCells()
    .filter((entry) => entry.cell.status === 'scoped')
    .map((entry) => ({
      capability: entry.capability,
      surface: entry.surface,
      note: entry.cell.note ?? '',
    }));
}
