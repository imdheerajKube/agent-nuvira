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
    // GROUNDWORK ONLY, and deliberately still `planned` on every surface.
    // WS1 has started: the model and its evidence gate are real
    // (`src/findings/verdicts.ts`), and the intent audit the gateway runs on a
    // repeated failure now carries a verdict and reports it in the gateway log
    // (`gateway/registry.ts`, `intent.confirmed` / `intent.corrected`). What has
    // NOT landed is the CAPABILITY this row describes — a finding on an ordinary
    // turn OF THIS SURFACE, carrying a verdict — and no parity case proves one.
    // Marking it `supported` now would be the exact claim-without-a-proof the
    // matrix exists to catch, so the note records the progress and the status
    // stays honest until a harness case can flip a cell at a time.
    cells: everywhere(
      'planned',
      'Groundwork only: the model and its evidence gate exist (`src/findings/verdicts.ts`) and the intent audit reports a verdict, but nothing on this surface produces findings on an ordinary turn and no parity case proves one yet.',
    ),
  },
  {
    id: 'debug-log',
    label: 'A session debug log you can attach to a bug report, with a header naming the backend',
    workstream: 'WS2',
    cells: everywhere('planned'),
  },
  {
    id: 'otel-export',
    label: 'A span tree exported over OTLP when configured, with trace context propagated to child processes',
    workstream: 'WS3',
    cells: everywhere('planned'),
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
