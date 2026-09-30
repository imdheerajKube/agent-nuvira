/**
 * "Verify next N" — a bounded, single-flight spot-check run a UI can start.
 *
 * WHY THIS EXISTS. The registered catalog is mostly UNKNOWN, not broken: on a
 * real profile 535 of 553 tracked models read `unverified`, which means "the
 * provider lists this id and nothing has ever been tried against it". Those rows
 * cannot be routed to (see `model-reachability.ts` — the router needs a proven
 * success within 7 days), and until this module the only thing that could turn
 * one into a routable model was the background warmup daemon, six models per
 * cycle, on an interval — a fix that works but that a user cannot ask for, watch,
 * or aim.
 *
 * WHAT IT IS NOT. It is not `refreshModelRegistry`. That is a bulk sweep: it
 * re-lists every provider's catalog and spends a per-provider spot-check budget.
 * This module spends the SAME 1-token primitive but does not re-list anything —
 * it takes the next N already-recorded never-verified ids and tries them. The
 * catalog does not change; only our knowledge of it does.
 *
 * THE FOUR PROPERTIES THAT KEEP IT SAFE TO PUT BEHIND A BUTTON:
 *
 *   1. **Single-flight.** A second run while one is in progress is refused, not
 *      queued. Concurrent runs would read the same candidate list and probe the
 *      same models twice — the candidate selector's per-model throttle is ten
 *      minutes, so the second run's picks would overlap the first's almost
 *      exactly. Two runs are one run at double the quota cost.
 *   2. **Bounded.** `VERIFY_BACKLOG_MAX_PER_RUN` (25) is a hard ceiling on a
 *      single request, because every model in the list is a REAL generation —
 *      1 token, but up to `SPOT_CHECK_TIMEOUT_MS` (20s) of wall clock each.
 *   3. **Never-verified only.** The candidate list comes from
 *      `selectExplorationCandidates`, which already excludes verified models,
 *      proven-dead ones, parked ones, providers we hold no credentials for, and
 *      the config sentinel. So a run cannot spend budget on something that
 *      cannot answer, and it cannot re-probe something already known.
 *   4. **Self-consuming.** A spot-check either verifies a model or marks it
 *      unavailable — both take it out of the never-verified set. Repeating the
 *      run therefore makes progress by construction rather than by luck, which
 *      is what "work the backlog down" means.
 *
 * SEQUENTIAL ON PURPOSE. `refreshModelRegistry` probes with a concurrency of 3;
 * this runs one model at a time. A bulk sweep tolerates a 429 because it is
 * unattended and long-lived, but here a 429 PARKS the model for
 * `PROBE_RATE_LIMIT_PARK_MS` and the user is watching a progress counter — so
 * the gentler shape buys a stable readout and fewer self-inflicted parks.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not treat a transient `error` as an
 * answer. `spotCheckModel` leaves the entry untouched for a network blip, so an
 * errored model stays in the backlog and is picked again next run. That is the
 * honest outcome — we still do not know — and it is reported as `errored`, never
 * folded into `verified`.
 */

import { selectExplorationCandidates } from './model-warmup.js';
import { spotCheckModel } from '../inference/model-probe.js';
import { getModelRegistry, type ModelRegistry, type ModelRegistryEntry } from './model-registry.js';
import type { ConfigManager } from '../config/manager.js';
import { logger } from '../utils/logger.js';

/** Hard ceiling on one run. Each model is a real (1-token) generation. */
export const VERIFY_BACKLOG_MAX_PER_RUN = 25;

/** What the UI asks for when the user does not choose. */
export const VERIFY_BACKLOG_DEFAULT_PER_RUN = 10;

/** Exactly the outcome vocabulary `spotCheckModel` returns. */
export type SpotCheckOutcome = 'verified' | 'unavailable' | 'skipped' | 'error';

/** One model's result, in the order it was tried. */
export interface VerifyBacklogResult {
  provider: string;
  model: string;
  outcome: SpotCheckOutcome;
}

/** A run's full state — everything the UI needs to render progress and outcome. */
export interface VerifyBacklogState {
  status: 'idle' | 'running' | 'done';
  /** Changes per run, so a poller can tell a new run from the one it was watching. */
  runId: string | null;
  /** What was asked for, before clamping. */
  requested: number;
  /** How many models this run will actually try. */
  planned: number;
  processed: number;
  verified: number;
  unavailable: number;
  skipped: number;
  errored: number;
  /** The model being probed right now, so the UI can name it. */
  current: { provider: string; model: string } | null;
  results: VerifyBacklogResult[];
  startedAt: number | null;
  finishedAt: number | null;
  /**
   * Why nothing ran. Distinguishes "already running" from "nothing left to do"
   * — the two cases where `status` is not `running` and no work happened.
   */
  refusal: string | null;
  /**
   * Actionable never-verified models left when the run finished — the number the
   * user is trying to move. `null` until a run has completed.
   */
  remaining: number | null;
}

/** Injectable seams for tests — the real spot-check talks to a provider. */
export interface VerifyBacklogDeps {
  spotCheck?: (
    provider: string,
    model: string,
    cm: ConfigManager,
  ) => Promise<SpotCheckOutcome>;
  registry?: ModelRegistry;
  now?: () => number;
}

function idleState(): VerifyBacklogState {
  return {
    status: 'idle',
    runId: null,
    requested: 0,
    planned: 0,
    processed: 0,
    verified: 0,
    unavailable: 0,
    skipped: 0,
    errored: 0,
    current: null,
    results: [],
    startedAt: null,
    finishedAt: null,
    refusal: null,
    remaining: null,
  };
}

/**
 * The in-process run state. One at a time, so one slot — this is a UI action on
 * a single machine, not a queue, and a queue would only hide the fact that the
 * second click was a duplicate of the first.
 */
let state: VerifyBacklogState = idleState();

/** Current state, safe to serialize straight to a client. */
export function getVerifyBacklogState(): VerifyBacklogState {
  return { ...state, results: [...state.results] };
}

/** Reset to idle (tests). Never called from the server path. */
export function resetVerifyBacklog(): void {
  state = idleState();
}

/** Clamp a requested count into the allowed band. */
export function clampVerifyCount(requested: number): number {
  if (!Number.isFinite(requested)) return VERIFY_BACKLOG_DEFAULT_PER_RUN;
  const n = Math.floor(requested);
  if (n < 1) return 1;
  return Math.min(n, VERIFY_BACKLOG_MAX_PER_RUN);
}

/** How many never-verified models are actionable right now (servable, unthrottled). */
function actionableBacklog(
  registry: ModelRegistry,
  configManager: ConfigManager,
  now: number,
): number {
  // The selector is the only place that decides what is actionable, so ask IT
  // for the full list rather than counting `status === 'unverified'` here —
  // otherwise the number would include providers with no credentials and models
  // inside their probe throttle, and would fall as the run worked while the
  // user's remaining work did not.
  return selectExplorationCandidates(registry, configManager, now, Number.MAX_SAFE_INTEGER).length;
}

/**
 * Start a run. Returns immediately — the probes continue in the background and
 * are observed through {@link getVerifyBacklogState}.
 *
 * The candidate list is computed SYNCHRONOUSLY, before returning, so the caller
 * learns "there was nothing to do" as a refusal rather than as a run that
 * finishes instantly. That distinction is the whole reason `refusal` exists: an
 * empty backlog is good news and should read as such, not as a failed run.
 */
export function startVerifyBacklogRun(
  configManager: ConfigManager,
  requested: number = VERIFY_BACKLOG_DEFAULT_PER_RUN,
  deps: VerifyBacklogDeps = {},
): { started: boolean; state: VerifyBacklogState; error?: string } {
  if (state.status === 'running') {
    return {
      started: false,
      state: getVerifyBacklogState(),
      error: 'A verify run is already in progress — wait for it to finish.',
    };
  }

  const count = clampVerifyCount(requested);
  const registry = deps.registry ?? getModelRegistry();
  const now = deps.now ?? Date.now;

  // Start from what is on DISK, not from this process's boot-time snapshot.
  // `ModelRegistry.persist()` writes the whole entry map from memory, and the
  // singleton loads the mirror exactly once at startup — so a dashboard that had
  // been up for hours would otherwise flush a hours-old view of every OTHER
  // model back over whatever the gateway and the CLI have learned since.
  try {
    registry.reloadFromMirror();
  } catch {
    // Best-effort: a reload failure must not block verification.
  }

  const candidates = selectExplorationCandidates(registry, configManager, now(), count);

  if (candidates.length === 0) {
    state = {
      ...idleState(),
      requested: count,
      finishedAt: now(),
      refusal:
        'Nothing to verify — every tracked model is either already proven, proven dead, parked, throttled, or behind a provider you have no credentials for.',
      remaining: 0,
    };
    return { started: false, state: getVerifyBacklogState() };
  }

  state = {
    ...idleState(),
    status: 'running',
    runId: `verify-${now()}`,
    requested: count,
    planned: candidates.length,
    startedAt: now(),
  };

  logger.info(
    `[verify-next] Verifying ${candidates.length} never-verified model(s) (asked for ${count}).`,
  );

  const spotCheck = deps.spotCheck ?? spotCheckModel;
  void runToCompletion(candidates, configManager, spotCheck, registry, now);

  return { started: true, state: getVerifyBacklogState() };
}

/**
 * The probe loop. Sequential, and one failing model never aborts the run — a
 * single dead id is a normal thing to find in a catalog, not a reason to stop
 * telling the user about the other twenty-four.
 */
async function runToCompletion(
  candidates: Array<{ provider: string; model: string }>,
  configManager: ConfigManager,
  spotCheck: (provider: string, model: string, cm: ConfigManager) => Promise<SpotCheckOutcome>,
  registry: ModelRegistry,
  now: () => number,
): Promise<void> {
  for (const candidate of candidates) {
    state.current = { provider: candidate.provider, model: candidate.model };
    let outcome: SpotCheckOutcome;
    try {
      outcome = await spotCheck(candidate.provider, candidate.model, configManager);
    } catch {
      // A throwing seam is an unanswered question, not a proof — same category
      // as `spotCheckModel`'s own transient path.
      outcome = 'error';
    }

    state.processed += 1;
    if (outcome === 'verified') state.verified += 1;
    else if (outcome === 'unavailable') state.unavailable += 1;
    else if (outcome === 'skipped') state.skipped += 1;
    else state.errored += 1;
    state.results.push({ provider: candidate.provider, model: candidate.model, outcome });
  }

  state.current = null;
  state.status = 'done';
  state.finishedAt = now();
  try {
    state.remaining = actionableBacklog(registry, configManager, now());
  } catch {
    state.remaining = null;
  }

  logger.info(
    `[verify-next] Done — ${state.verified} verified · ${state.unavailable} unavailable · ` +
      `${state.errored} errored · ${state.skipped} skipped. ${state.remaining ?? '?'} still never verified.`,
  );
}

/**
 * Never-verified models, as the registry currently holds them.
 *
 * Exported for the empty-state copy and for tests; the classification itself
 * lives in `selectExplorationCandidates`, not here.
 */
export function neverVerifiedEntries(registry: ModelRegistry): ModelRegistryEntry[] {
  const out: ModelRegistryEntry[] = [];
  for (const provider of registry.getTrackedProviders()) {
    for (const entry of registry.getAllModelsForProvider(provider)) {
      if (entry.status === 'unverified') out.push(entry);
    }
  }
  return out;
}
