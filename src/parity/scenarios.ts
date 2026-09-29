/**
 * WS0 (#22) — one scenario, every surface, one verdict.
 *
 * The registry (`surfaces.ts`) answers "which surfaces exist and what do they
 * run through". This module answers the harder question: did they behave the
 * same, and is the verdict trustworthy.
 *
 * THREE RULES, each closing a way a parity test lies:
 *
 *   1. STUB DEPTH MUST BE COMPARABLE. Every driver records where its stub sits.
 *      `provider` (a stub provider object) and `transport` (a real provider
 *      object talking to a stub SERVER — the forked subagent child) both run the
 *      real turn code end to end, so they are ONE comparable class; folding them
 *      together is what makes the child readable against the in-process
 *      surfaces. `engine` replaces the very behaviour under test, so it never
 *      compares with anything, itself included. A run that would have to compare
 *      incomparable depths is refused rather than answered.
 *
 *   2. SKIPPED SURFACES ARE NAMED. A surface that cannot be driven appears in
 *      `skipped` with the reason it is missing. Silence is how a harness ends up
 *      "passing" for months while covering one surface.
 *
 *   3. TWO SURFACES IS THE MINIMUM. One available driver is not a parity run; it
 *      is a smoke test wearing a parity label. That case reports
 *      `insufficient`, never `at-par`.
 *
 *   4. THE TURN MUST HAVE REACHED A MODEL. The response cache is shared and
 *      enabled on the `answerOnce` path, so the second surface of a run can be
 *      served from the first one's entry — same answer, no model call, no tool
 *      lifecycle, and a flawless "agreement" between two replays that proves
 *      nothing. Measured, not hypothetical: before this rule existed, the second
 *      surface of every two-driver run was a cache hit (the drivers now isolate
 *      the cache per turn as well — belt and braces, because either guard alone
 *      would be one edit away from being removed).
 *      A zero is refused as `unreached-model` rather than compared.
 *
 * Pure by construction: no `fs`, no `vi`, no process env — which is what lets
 * both the test suite and `nuvira parity run` import it. The drivers that
 * actually drive a turn live in `./drivers.ts` (transport depth, a loopback stub
 * server), so the CLI and CI run the SAME mechanism instead of two copies that
 * could disagree.
 */

import { compare, type TurnObservation } from './observation.js';
import type { SurfaceId } from './surfaces.js';

/** What one parity case asks every surface to do. */
export interface ParityScenario {
  id: string;
  /** The user message every surface receives, verbatim. */
  message: string;
  /**
   * The tool the stub provider asks for on its FIRST model call. Absent means
   * the scenario is a plain completion with no tool use.
   */
  toolCall?: { tool: string; args: Record<string, unknown> };
  /** The terminal answer the stub provider returns once the tool work is done. */
  answer: string;
  /** Files the scenario expects to exist, as `path` → contents, for a deterministic tool result. */
  fixtures?: Record<string, string>;
  /**
   * WS4 (#26) — the operator's tool hooks this scenario asks the harness to
   * DECLARE for its turn.
   *
   * A scenario field rather than a harness-wide setting, because a hook changes
   * what the turn does: declaring one for every scenario would make the earlier
   * cases measure a different system than the one they were written against, and
   * the harness cannot tell a deliberate declaration from a leftover. Absent means
   * no hook is declared, which is the default the surfaces must also be correct
   * under.
   *
   * This is DATA, not a command: the harness writes the hook script itself (see
   * `src/parity/drivers.ts`) and the surface runs it the way an operator's own
   * hook would be run — a real process, a real pipe, the payload as JSON on stdin.
   */
  hooks?: {
    /** The phases to declare a hook for. The harness declares one command per phase. */
    phases: readonly ('before' | 'after' | 'failed')[];
    /** Tool names a `before` hook VETOES. Absent or empty = the hook observes only. */
    deny?: readonly string[];
  };
  /**
   * WS5 (#27) — ask this turn to run in its own git worktree and report the diff
   * against its base commit.
   *
   * A scenario field rather than a harness-wide setting, for the same reason the
   * hooks are: isolation CHANGES where the turn writes, so declaring it for every
   * scenario would make the earlier cases measure a different system than the one
   * they were written against. Absent means no isolation is asked for — the
   * default every surface must also be correct under.
   *
   * The harness declares it through `NUVIRA_ISOLATE`, which is how a surface with
   * no command line (the dashboard server, the gateway, the forked child) is
   * asked, so ONE declaration covers all five rather than five different flags.
   */
  isolation?: boolean;
  /**
   * WS5 (#27) — ask this turn to RESUME: replay the steps of a previous run of the
   * same ask whose input is unchanged, instead of paying for them again.
   *
   * The driver runs the scenario TWICE — once to write the record and once to
   * replay it — and reports what the second turn avoided, because the claim is
   * about a pair of runs and one turn cannot show it (see `ResumeObs`).
   */
  resume?: boolean;
}

/**
 * Where a driver's stub sits. Only equal depths may be compared.
 *
 *  - `provider`  — the real turn code runs end to end and only the model I/O is
 *                  replaced. The strongest and the default for parity work.
 *  - `transport` — a real provider object talks to a stub server (subagent IPC).
 *                  Comparable with `provider`: both run the real turn code end
 *                  to end, only the model I/O is replaced. Kept distinct so the
 *                  distinction stays a stated decision rather than an accident.
 *  - `engine`    — the engine itself is replaced (a fake `answerOnce`). Only good
 *                  for exercising a surface's own plumbing; never for behaviour
 *                  parity, and refused even against another `engine` stub.
 */
export type StubDepth = 'provider' | 'transport' | 'engine';

/** A way to drive one surface through one scenario. */
export interface ParityDriver {
  surface: SurfaceId;
  depth: StubDepth;
  /** False when this surface cannot be driven yet; `blockedBy` must then say why. */
  available: boolean;
  /** Required when `available` is false: what is missing, concretely. */
  blockedBy?: string;
  /** Drives the turn and returns what an observer could see. */
  run(scenario: ParityScenario): Promise<TurnObservation>;
}

/** A surface that was not driven, and why. Never dropped silently. */
export interface SkippedSurface {
  surface: SurfaceId;
  reason: string;
}

export interface DepthMismatch {
  kind: 'depth-mismatch';
  depths: Array<{ surface: SurfaceId; depth: StubDepth }>;
  message: string;
}

export interface InsufficientCoverage {
  kind: 'insufficient-coverage';
  available: SurfaceId[];
  message: string;
}

/**
 * At least one surface's turn never reached a model, so nothing was compared.
 *
 * Distinct from a divergence: a replay and a real turn say nothing about each
 * other, and reporting either as a difference would be as wrong as reporting
 * them as agreement.
 */
export interface UnreachedModel {
  kind: 'unreached-model';
  /** Surfaces whose turn completed without a single model call. */
  surfaces: SurfaceId[];
  message: string;
}

export interface ParityRun {
  scenario: string;
  /** The depth compared, when a comparison happened. */
  depth: StubDepth | null;
  /** Observations in driver order, for the failure report. */
  observations: TurnObservation[];
  /** Named differences against the first observation. Empty means every surface agreed. */
  differences: string[];
  skipped: SkippedSurface[];
  /** `at-par` · `divergent` · `not-run` (with `refusal` explaining why). */
  verdict: 'at-par' | 'divergent' | 'not-run';
  refusal?: DepthMismatch | InsufficientCoverage | UnreachedModel;
}

/**
 * Drive one scenario through every available driver and compare the results.
 *
 * Order matters only for the report: the first available driver is the baseline.
 * Driver order is the caller's, so a scenario can pin a baseline deliberately.
 */
export async function runParityScenario(
  scenario: ParityScenario,
  drivers: readonly ParityDriver[],
): Promise<ParityRun> {
  const skipped: SkippedSurface[] = drivers
    .filter((d) => !d.available)
    .map((d) => ({ surface: d.surface, reason: d.blockedBy ?? 'no reason recorded' }));

  const available = drivers.filter((d) => d.available);

  if (available.length < 2) {
    return {
      scenario: scenario.id,
      depth: null,
      observations: [],
      differences: [],
      skipped,
      verdict: 'not-run',
      refusal: {
        kind: 'insufficient-coverage',
        available: available.map((d) => d.surface),
        message:
          `only ${available.length} surface(s) can be driven for "${scenario.id}"` +
          (skipped.length > 0 ? `; skipped: ${skipped.map((s) => `${s.surface} (${s.reason})`).join('; ')}` : '') +
          '. A parity verdict needs at least two.',
      },
    };
  }

  const depths = [...new Set(available.map((d) => d.depth))];
  // R2 — `provider` and `transport` are one comparable class (see rule 1 in the
  // header). `engine` never compares, whether or not it is paired with anything.
  if (depths.includes('engine')) {
    return {
      scenario: scenario.id,
      depth: null,
      observations: [],
      differences: [],
      skipped,
      verdict: 'not-run',
      refusal: {
        kind: 'depth-mismatch',
        depths: available.map((d) => ({ surface: d.surface, depth: d.depth })),
        message:
          `a stub sits at the ENGINE depth (${depths.join(', ')}), so a verdict would be meaningless: ` +
          'that surface has had the behaviour under test replaced, and it can never be compared — ' +
          'not with a provider stub, and not with another engine stub. ' +
          'Re-drive it at provider or transport depth, or declare the gap.',
      },
    };
  }
  /** No single depth to report when comparable depths were mixed. */
  const reportedDepth: StubDepth | null = depths.length === 1 ? depths[0] : null;

  const observations: TurnObservation[] = [];
  for (const driver of available) observations.push(await driver.run(scenario));

  // Rule 4. Checked BEFORE comparing, because a zero would otherwise surface as
  // a "divergence" in modelCalls — the right refusal with the wrong name.
  const unreached = observations.filter((observation) => observation.modelCalls === 0);
  if (unreached.length > 0) {
    return {
      scenario: scenario.id,
      depth: reportedDepth,
      observations,
      differences: [],
      skipped,
      verdict: 'not-run',
      refusal: {
        kind: 'unreached-model',
        surfaces: unreached.map((observation) => observation.surface),
        message:
          `no model call on: ${unreached.map((o) => o.surface).join(', ')}. ` +
          'A turn served without reaching a model — a response-cache replay, or a ' +
          'surface answering from a shortcut — did no routing and no tool work, so ' +
          'comparing it says nothing. Isolate the cache (or use a distinct message) ' +
          'and re-run before reading any verdict from this scenario.',
      },
    };
  }

  const [baseline, ...rest] = observations;
  const differences = rest.flatMap((observation) => compare(baseline, observation));

  return {
    scenario: scenario.id,
    depth: reportedDepth,
    observations,
    differences,
    skipped,
    verdict: differences.length === 0 ? 'at-par' : 'divergent',
  };
}
