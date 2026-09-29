/**
 * WS0 (#22) — what "the same experience on every surface" means, in code.
 *
 * A parity test is only worth having if its comparison can FAIL for the right
 * reason and PASS for the right reason. Two traps:
 *
 *   1. Comparing everything. Turn ids, timestamps, durations, the working
 *      directory and token counts differ on every invocation by construction, so
 *      a byte comparison would fail for surfaces that behave identically and
 *      teach everyone to ignore it.
 *   2. Comparing nothing that matters. If the projection drops the tool calls
 *      and the error taxonomy, every surface "passes" while one of them silently
 *      answers without touching a file.
 *
 * So the projection here is deliberate: WHAT THE TURN DID (status, the ordered
 * tool calls, the terminal answer, the typed refusal/error code) and WHICH
 * BACKEND DID IT (provider, model, transport) are compared; identity and timing
 * are not. `compare` names each difference and which surface it came from,
 * because a parity failure that does not say "gateway" is not actionable.
 *
 * A THIRD TRAP, found by measurement rather than reasoning: comparing turns that
 * never reached a model. The response cache is shared and on-disk
 * (`src/context/cache.ts`, enabled for `answerOnce` at `src/cli/chat.ts:690`),
 * so an identical message on the second surface of a run is served from the
 * first one's cache entry — same answer, no model call, no tool lifecycle. Two
 * such replays agree perfectly and mean nothing. `modelCalls` records whether
 * the turn was real, and both `compare` and the runner refuse to read a zero as
 * agreement.
 */

import type { EngineMode } from '../learning/engine-router.js';
import type { WireFinding } from '../findings/verdicts.js';
import type { SurfaceId } from './surfaces.js';

/** How a turn ended, in the taxonomy every surface already reports. */
export type TurnStatus = 'completed' | 'failed' | 'refused';

/** Volatile per-invocation values. Recorded for the failure report, never compared. */
/**
 * One tool call, as an observer sees it.
 *
 * Deliberately not a bare tool name. A call that SUCCEEDED on one surface and
 * FAILED on another is not agreement, and comparing names alone would report it
 * as a pass — which is the same class of mistake as the tool descriptions this
 * repo has spent a workstream fixing (a call reported as done when it was not).
 * `ok` is optional because a surface may report the call without an outcome yet
 * (the `started` phase); an absent `ok` never equals `false`.
 */
export interface ToolCallObs {
  tool: string;
  ok?: boolean;
}

export interface ObservationNoise {
  turnId?: string;
  sessionId?: string;
  at?: number;
  durationMs?: number;
  cwd?: string;
  tokens?: number;
}

/**
 * WS2 — the session debug log a surface produced for the turn, reduced to what
 * the attachable header carries.
 *
 * `written` is separate from the backend on purpose: "this surface wrote no log"
 * and "this surface wrote a log that names no backend" are different failures,
 * and collapsing them would let a surface that produces NOTHING read as one that
 * produces an honest `unknown`. The backend triple is what a bug report cannot
 * be reconstructed without, so it is what is compared — the file's path, size
 * and timestamps differ per run by construction (the same reason `turnId` and
 * `at` are noise).
 */
export interface DebugLogObs {
  /** True when the surface actually wrote a log file for this turn. */
  written: boolean;
  /** The provider named in the log's header (null = not named). */
  provider: string | null;
  /** The model named in the log's header. */
  model: string | null;
  /** The transport named in the log's header (`native`/`json`/`none`). */
  transport: string | null;
}

/** The honest "this surface produced no log" value. Fresh each call. */
export function noDebugLog(): DebugLogObs {
  return { written: false, provider: null, model: null, transport: null };
}

/**
 * One surface's view of one turn. Fields the surface does not report stay
 * `undefined` — and `compare` treats "absent on one surface, present on another"
 * as a difference, because a surface that cannot say which model served a turn
 * is exactly the gap WS1-WS5 are closing.
 */
export interface TurnObservation {
  surface: SurfaceId;
  engine: EngineMode;
  status: TurnStatus;
  /**
   * How many times this turn reached the model.
   *
   * EXACTLY ZERO IS NOT "no model needed" — it means the turn was served
   * without one: a response-cache replay, or a surface that answered from a
   * shortcut. Such a turn carries no routing, no tool loop and no work, so it
   * cannot be evidence of parity in either direction. Recorded as a required
   * field so a driver cannot forget to say, and refused by the runner rather
   * than compared.
   */
  modelCalls: number;
  /** Provider that served the turn (the child reports this on failure too). */
  provider?: string;
  model?: string;
  transport?: 'native' | 'json' | 'none';
  /** Tool calls in call order, with the outcome each surface reported. Order is part of the behaviour. */
  toolCalls: readonly ToolCallObs[];
  /**
   * WS2 — the session debug log this surface wrote for the turn.
   *
   * REQUIRED, for the reason `modelCalls` and `findings` are: the capability is
   * "every surface produces an attachable log whose header names the backend",
   * and an optional field would let a surface that produces nothing go on
   * reading as at-par. `noDebugLog()` is the honest answer when logging is off
   * or the surface wrote nothing — the harness turns logging ON for the run, so
   * a `written: false` there is a failure, not a neutral value.
   */
  debugLog: DebugLogObs;
  /**
   * WS1 — the findings the turn recorded, in call order, in the shared wire
   * form (`findings/verdicts.ts`).
   *
   * REQUIRED, for the reason `modelCalls` is: a surface that cannot report its
   * verdicts is precisely the gap this row closes, and an optional field would
   * let it go on being silent while still reading as at-par. `[]` is the honest
   * answer for a turn that recorded none — not the same statement as "this
   * surface does not say". Compared in ORDER and by VALUE, because the verdict
   * (CONFIRMED vs PLAUSIBLE) and the evidence behind it are the whole point: two
   * surfaces agreeing that a finding exists while disagreeing about whether it
   * was checked have not agreed on anything.
   */
  findings: readonly WireFinding[];
  /** Terminal answer text. Compared exactly: parity runs use one stub provider. */
  answer?: string;
  /** Typed refusal code (no provider, unreachable backend, tools on a non-tool provider). */
  refusalCode?: string;
  /** Typed error code for a failure that is not a refusal. */
  errorCode?: string;
  noise?: ObservationNoise;
}

/** The compared projection: no identity, no timing. */
export interface ComparableObservation {
  engine: EngineMode;
  status: TurnStatus;
  modelCalls: number;
  provider: string | null;
  model: string | null;
  transport: string | null;
  toolCalls: readonly ToolCallObs[];
  findings: readonly WireFinding[];
  debugLog: DebugLogObs;
  answer: string | null;
  refusalCode: string | null;
  errorCode: string | null;
}

/** Strip everything that legitimately differs between two runs of the same turn. */
export function comparableOf(observation: TurnObservation): ComparableObservation {
  return {
    engine: observation.engine,
    status: observation.status,
    modelCalls: observation.modelCalls,
    provider: observation.provider ?? null,
    model: observation.model ?? null,
    transport: observation.transport ?? null,
    toolCalls: observation.toolCalls.map((call) => ({ tool: call.tool, ...(call.ok === undefined ? {} : { ok: call.ok }) })),
    // Absent at runtime is normalised to `[]` rather than compared as a
    // difference: the field is required by the type, and a driver that forgot it
    // should fail the typecheck, not silently diverge at runtime.
    findings: observation.findings ?? [],
    debugLog: observation.debugLog ?? noDebugLog(),
    answer: observation.answer ?? null,
    refusalCode: observation.refusalCode ?? null,
    errorCode: observation.errorCode ?? null,
  };
}

/** Stable serialisation, so a failure report can show both sides and their digest. */
export function serialize(value: ComparableObservation): string {
  return JSON.stringify(value);
}

function show(value: string | null): string {
  return value === null ? '(none)' : JSON.stringify(value);
}

/** How one call reads in a failure report. */
function showCall(call: ToolCallObs): string {
  if (call.ok === undefined) return call.tool;
  return call.ok ? `${call.tool}(ok)` : `${call.tool}(FAILED)`;
}

/** Same tool, same outcome. An absent outcome equals only an absent outcome. */
function sameCall(a: ToolCallObs, b: ToolCallObs): boolean {
  return a.tool === b.tool && a.ok === b.ok;
}

/**
 * Every difference between two observations, each named with the field and both
 * surfaces. Empty array means parity for this pair.
 *
 * Deliberately granular on `toolCalls`: "both called 3 tools" is not the
 * question; "which call came first and did the other one make it at all" is.
 */
export function compare(a: TurnObservation, b: TurnObservation): string[] {
  const left = comparableOf(a);
  const right = comparableOf(b);
  const differences: string[] = [];
  const who = `${a.surface} vs ${b.surface}`;

  const scalars: Array<keyof ComparableObservation> = [
    'engine',
    'status',
    'modelCalls',
    'provider',
    'model',
    'transport',
    'answer',
    'refusalCode',
    'errorCode',
  ];
  for (const field of scalars) {
    const l = left[field] as string | number | null;
    const r = right[field] as string | number | null;
    if (l !== r) {
      differences.push(
        `${who}: ${field} differs — ${show(l === null ? null : String(l))} vs ${show(r === null ? null : String(r))}`,
      );
    }
  }

  const max = Math.max(left.toolCalls.length, right.toolCalls.length);
  for (let i = 0; i < max; i += 1) {
    const l = left.toolCalls[i];
    const r = right.toolCalls[i];
    if (l && r && sameCall(l, r)) continue;
    differences.push(
      l === undefined
        ? `${who}: ${b.surface} made an extra call at #${i + 1} — ${showCall(r!)}`
        : r === undefined
          ? `${who}: ${a.surface} made a call the other surface did not, at #${i + 1} — ${showCall(l)}`
          : `${who}: tool call #${i + 1} differs — ${showCall(l)} vs ${showCall(r)}`,
    );
  }

  // WS1 — findings, in order, by value. The VERDICT is part of the value: two
  // surfaces that both recorded the claim while one called it CONFIRMED and the
  // other PLAUSIBLE have not agreed, and the evidence decides which is honest.
  const maxFindings = Math.max(left.findings.length, right.findings.length);
  for (let i = 0; i < maxFindings; i += 1) {
    const l = left.findings[i];
    const r = right.findings[i];
    if (l && r && JSON.stringify(l) === JSON.stringify(r)) continue;
    const say = (f: WireFinding | undefined): string =>
      f === undefined ? '(none)' : `${show(f.claim)} [${f.verdict}]`;
    differences.push(
      l === undefined
        ? `${who}: ${b.surface} recorded a finding the other surface did not, at #${i + 1} — ${say(r)}`
        : r === undefined
          ? `${who}: ${a.surface} recorded a finding the other surface did not, at #${i + 1} — ${say(l)}`
          : `${who}: finding #${i + 1} differs — ${say(l)} vs ${say(r)}`,
    );
  }

  // WS2 — the session debug log's header. Compared field by field (rather than
  // by object identity) so a failure names WHICH part of the header diverged:
  // "one surface wrote no log" and "one named a different model" are very
  // different bugs, and a bare `debugLog differs` would hide that.
  const debugFields: Array<keyof DebugLogObs> = ['written', 'provider', 'model', 'transport'];
  for (const field of debugFields) {
    const l = left.debugLog[field];
    const r = right.debugLog[field];
    if (l !== r) {
      differences.push(
        `${who}: debugLog.${field} differs — ${show(l === null ? null : String(l))} vs ${show(r === null ? null : String(r))}`,
      );
    }
  }

  return differences;
}

/** True when the two observations are interchangeable as far as a user can tell. */
export function isAtPar(a: TurnObservation, b: TurnObservation): boolean {
  return compare(a, b).length === 0;
}

/**
 * True when the turn actually reached a model.
 *
 * Separate from `status === 'completed'` on purpose: a cache replay completes.
 * A caller that wants a parity verdict must require this on every surface (the
 * runner does), and a caller that wants to prove a surface *did* the work must
 * assert it rather than infer it from an answer it likes the look of.
 */
export function reachedModel(observation: TurnObservation): boolean {
  return observation.modelCalls > 0;
}

/**
 * A one-block report for a failing parity case: both projections plus the named
 * differences. Kept here rather than in the test so the wording is consistent
 * across every workstream that adds a case.
 */
export function reportParityFailure(
  observations: readonly TurnObservation[],
  differences: readonly string[],
): string {
  const lines = ['cross-surface parity FAILED', ''];
  for (const observation of observations) {
    lines.push(
      `  ${observation.surface} [${observation.engine}] ${serialize(comparableOf(observation))}`,
    );
    if (observation.noise && Object.keys(observation.noise).length > 0) {
      lines.push(`    noise: ${JSON.stringify(observation.noise)}`);
    }
  }
  lines.push('', 'differences:');
  for (const difference of differences) lines.push(`  - ${difference}`);
  return lines.join('\n');
}
