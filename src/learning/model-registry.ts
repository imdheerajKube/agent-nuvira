/**
 * ModelRegistry — persistent Model Availability Registry ("known vs usable").
 *
 * The gap this closes: an API key being configured (`hasRequiredCredentials`)
 * does NOT mean the models you route to actually work. OpenRouter lists 300+
 * models even when credits can't buy most; Gemini paid models 403 without
 * billing; NIM exposes entries that aren't served. Auto routing needs to know
 * "which provider × model combos are VERIFIED to work right now" — fast.
 *
 * Design (enterprise-grade, zero hard dependencies):
 * - A **canonical JSON mirror** (`~/.nuvira/memory/model-registry.json`) is the
 *   source of truth for READS: loaded synchronously into memory once, so every
 *   `isUsable()` / `getVerifiedModels()` is a sub-ms map lookup — model
 *   selection never blocks on I/O or the network.
 * - The same data is **mirrored to a VectorStore namespace** (`model-registry`)
 *   whenever the vector stack is usable. The VectorStore ALREADY auto-tiers
 *   native FAISS → pure-JS IVF → JSON, so "vector DB when available, JSON
 *   otherwise" is satisfied with zero extra failure modes — the JSON mirror is
 *   the guaranteed fallback that can never break.
 * - **Writes are best-effort**: a failed save must never break routing or a
 *   live LLM call (same contract as QuotaLedger / CostTracker).
 *
 * Three data feeds keep it fresh:
 *   1. **Probe** (listModels)  → marks models `unverified`-listed
 *   2. **Spot-check** (1-token generation) → `verified` (works) or `unavailable`
 *      (403 permission / 404 / auth) — catches "key exists but model not
 *      purchasable" up front
 *   3. **Telemetry** (real usage) → success upgrades to `verified`, latency EMA
 *      updates, auth failures mark unavailable, rate-limit failures park
 *      quota without demoting (auto-recovery after the window)
 *
 * Quota integration: `syncQuota()` reads the QuotaLedger's router feed and
 * applies `quotaParkedUntil` to every entry of a parked provider, so a token-
 * exhausted provider is excluded predictively (same source the AutoModelRouter
 * already consumes).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import {envBuff, resolveNuviraHome} from '../config/paths';
import { formatCount } from '../utils/format.js';
import { stableJson, withFileLockSync, writeFileAtomicSync } from '../utils/atomic-store.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { getVectorStore, type VectorStore, type VectorEntry } from '../memory/vector-store.js';
import type { ModelDescriptor } from '../inference/interface.js';
import type { ReasoningCapability, ReasoningShape } from '../config/types.js';
import { reasoningCapabilityFromAdvertised } from '../inference/reasoning-effort.js';
import { isNonChatModel } from '../inference/model-catalog.js';
import {
  emptyCapabilityRecord,
  foldCallOutcome,
  foldLatency,
  foldVerification,
  type CapabilityRecord,
} from './capability-evidence.js';
import { getQuotaLedger } from './quota-ledger.js';
import { getEventBus, EventNames } from '../observability/event-bus.js';
import type { ConfigManager } from '../config/manager.js';
import {
  appendChainedRecordFast,
  rechainRecords,
  writeHeadState,
  headOfLines,
} from '../enterprise/audit-chain.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** How an entry's status was established. */
export type ModelRegistrySource = 'probe' | 'spot-check' | 'telemetry';

/** Availability status of one provider × model combo. */
export type ModelAvailabilityStatus = 'verified' | 'unverified' | 'unavailable';

/** One entry in the model registry — provider × model → availability. */
export interface ModelRegistryEntry {
  provider: string;
  model: string;
  status: ModelAvailabilityStatus;
  /** Epoch ms of the last successful verification (spot-check or telemetry). */
  lastVerifiedAt: number;
  /** Epoch ms this model was last seen in a listModels probe. */
  lastProbedAt: number;
  /** Epoch ms of the last real usage. */
  lastUsedAt: number;
  /** Rolling average latency (ms) — measured by spot-checks. */
  latencyMs?: number;
  /**
   * Live provider-advertised nominal context window (tokens) for this model,
   * recorded from the listModels probe when the endpoint exposes it (Ollama
   * `general.context_length`, OpenRouter `context_length`). The auto-router's
   * context preflight prefers this LIVE descriptor over the static
   * provider-level default. Undefined = the provider doesn't advertise it.
   */
  contextWindowTokens?: number;
  // ── M2.2 wire-token metering (measured cost inputs) ─────────────────────
  /** Rolling EMA of input tokens per call, from provider-reported usage. */
  measuredInputTokens?: number;
  /** Rolling EMA of output tokens per call, from provider-reported usage. */
  measuredOutputTokens?: number;
  /** How many measured calls contributed to the token EMAs. */
  measuredSamples?: number;
  /**
   * Learned support for a request-side reasoning parameter, keyed to this exact
   * provider × model. Absent/`supported:false` ⇒ never send one (default-deny).
   * Populated from the provider's own advertised parameters when it exposes
   * them, from a probe, or from a `learned-unsupported` rejection. See
   * `src/inference/reasoning-effort.ts`. Preserved across status changes.
   */
  reasoningCapability?: ReasoningCapability;
  /** Rolling error rate 0–1 (telemetry failures / calls). */
  errorRate: number;
  /**
   * P4 M4.4 rolling mid-stream flakiness 0–1 (EMA): how often this provider ×
   * model STARTED streaming but DIED before completion (partial). Distinct
   * from `errorRate` — a partial is not an error (the model is real and
   * authenticated) but it IS a reliability signal: the router deprioritizes
   * flaky mid-stream providers. Never flips status (a partial today may
   * complete tomorrow); decays toward 0 on clean successes.
   */
  partialRate?: number;
  /**
   * P4 M4.4: recent mid-stream flakiness EMA samples [{ t, rate }] — newest
   * last, capped at MAX_PARTIAL_HISTORY. Powers the dashboard's "flakiness
   * over time" sparkline: a trend toward 0 = the provider is HEALING via
   * clean successes; climbing = flakiness accumulating.
   */
  partialHistory?: Array<{ t: number; rate: number }>;
  /** Epoch ms until which the entry is quota-parked (0 = not parked). */
  quotaParkedUntil: number;
  /**
   * FIX (Gemini parking bug): when true, the parking was set by a provider-
   * level operation (parkProvider / syncQuota) rather than a model-specific
   * failure (recordCall). Verified models skip provider-level parking — a
   * verified model has proven it works and should not be blanket-blocked
   * because a DIFFERENT model in the same provider hit a rate limit.
   */
  providerParked?: boolean;
  /**
   * A model-not-found is DEFINITIVE for the pair: `provider/model` does not
   * exist and can never serve a request, however healthy the provider is.
   *
   * Observed live (2026-09-21): the failover walk offered `local/gemini-3.1-
   * flash-lite` — the `local` provider is an Ollama runner that cannot serve a
   * Google model. The pair had been marked `unavailable` ('model not found') and
   * was STILL handed back as a candidate on every walk, paying a 404 round trip
   * and taking the fallback slot a servable sibling should have had.
   *
   * An ordinary `unavailable` entry stays offerable on purpose (auth/quota may
   * be repaired, and the walk reaches parked models deliberately). A DEAD PAIR
   * is not offerable at all — only a real success clears it (see `markVerified`),
   * so a provider that later adds the model re-earns its place automatically.
   */
  deadPair?: boolean;
  /**
   * The measured capability scorecard for THIS pair (Bundle 3b, B1–B4).
   *
   * Five named parameters, each 0–100 with its own sample count, folded from what
   * the harness OBSERVED while doing real work — never from the model's id. Absent
   * or sample-free means "nothing measured", which reports as the declared prior
   * (see `learning/capability-evidence.ts`), so a cold registry behaves exactly as
   * it did before this field existed. Model metadata like the token EMAs above:
   * it survives every availability write, because an auth failure says nothing
   * about how well the model answered.
   */
  capability?: CapabilityRecord;
  /** Where the current status came from. */
  source: ModelRegistrySource;
  /** Human reason for `unavailable` (e.g. '403 permission denied'). */
  lastError?: string;
  // ── Quota telemetry (mirrored from QuotaLedger by syncQuota) ───────────────
  /** Tokens consumed in the current quota window (0 = no window tracked). */
  tokensConsumed?: number;
  /** Requests made in the current quota window. */
  requests?: number;
  /** Ms until the current quota window resets (0 = no window tracked). */
  resetsInMs?: number;
  /** Tokens remaining in the window (-1 = no limit configured / unlimited). */
  remainingTokens?: number;
}

/** Persisted registry state (JSON mirror + vector metadata shape). */
export interface ModelRegistryData {
  version: number;
  updatedAt: number;
  /** Key: `${provider}|${model}` */
  entries: Record<string, ModelRegistryEntry>;
}

/** Public status snapshot (CLI / dashboard / tests). */
export interface ModelRegistryStatus {
  backend: string;
  vectorMirrored: boolean;
  total: number;
  verified: number;
  unverified: number;
  unavailable: number;
  parked: number;
  updatedAt: number;
  /** Per-provider breakdown. */
  providers: Array<{
    provider: string;
    total: number;
    verified: number;
    unavailable: number;
    parked: number;
    models: ModelRegistryEntry[];
  }>;
}

/**
 * One "learned from real usage" event — which ACTION taught the registry what.
 * Written by chat / execute / plan / edit / skill / learn / ci / doctor calls
 * (and probe/spot-check maintenance) so the dashboard can show exactly which
 * action killed or verified each provider × model — the predictive skips.
 */
export interface ActionTelemetryEntry {
  /** Epoch ms of the write. */
  timestamp: number;
  /** The action that produced the call (chat / execute / plan / edit / ...). */
  action: string;
  provider: string;
  model: string;
  /** What the action learned: verified (works), unavailable (killed), error (transient decay). */
  outcome: 'verified' | 'unavailable' | 'error' | 'partial';
  /** Classified reason when outcome is unavailable/error (auth / rate-limit / model not found / ...). */
  errorType?: string;
  /** Measured round-trip latency (ms) of the call — feeds the Requests panel p50/p95/p99 (P3-M3.2). */
  latencyMs?: number;
  /** Measured cost (USD) of the call when the caller had usage data — feeds the Requests panel cost column. */
  costUsd?: number;
  /** Correlation id of the call when the caller has one (traceability). */
  callId?: string;
  /**
   * Where this record came from — `live` (a real run) or `test` (a test process).
   *
   * WHY: the charts read this log, and a test suite driving the real pipeline
   * used to write real records for models that do not exist. One fake model
   * (`local/nonexistent-fast-fail`) reached **2,110 of 3,436 lines** and was the
   * largest row in "Learned from real usage". The harness leak is now fixed at
   * the source (`tests/setup/hermetic-env.ts`), so this is the second layer:
   * even if a record is written from a test process, the VIEW can tell, without
   * rewriting a tamper-evident chain to hide it.
   *
   * Absent means `live` — an old record predates this field and was not
   * necessarily synthetic.
   */
  origin?: 'live' | 'test';
  /**
   * P4 M4.4: tokens already streamed before a `partial` (mid-stream
   * interruption) — the bigger the number, the more "almost finished" the
   * provider was. Only set for outcome 'partial'.
   */
  streamedChunks?: number;
}

/** Aggregated "learned from real usage" view — per action (dashboard panel). */
export interface ActionTelemetryInsights {
  enabled: boolean;
  /** Total logged events INCLUDED in this view (test-origin records excluded). */
  total: number;
  /**
   * Records in the log that were written by a test process and are therefore
   * excluded from every number in this view.
   *
   * Reported rather than silently dropped: the log is hash-chained, so the
   * records remain on disk, and a reader who knows the total log size can see
   * exactly how much of it is synthetic. Silence here would just be a different
   * way of lying about the data.
   */
  synthetic: number;
  updatedAt: number;
  /** Per-action aggregates (actions with at least one event, sorted by name). */
  actions: Array<{
    action: string;
    /** Events where the action verified a provider × model. */
    verified: number;
    /** Events where the action marked a provider × model unavailable (predictive skip). */
    killed: number;
    /** Events where a transient failure decayed health (no flip). */
    transient: number;
    /**
     * Events where the action hit a MID-STREAM interruption (P4 M4.4 partial
     * learning) — the provider started streaming then died before completion.
     * A distinct signal from `transient` (a failed request) because a provider
     * that starts-but-can't-finish is worse than one that errors cleanly: the
     * router learns to deprioritize flaky mid-stream providers.
     */
    partial: number;
    /** Provider × model combos this action verified (latest event each). */
    verifiedModels: Array<{ provider: string; model: string; at: number }>;
    /** Provider × model combos this action killed (latest event each). */
    killedModels: Array<{ provider: string; model: string; reason?: string; at: number }>;
    /**
     * Provider × model combos this action interrupted MID-STREAM (latest
     * event each) — P4 M4.4 partial learning: the provider started streaming
     * then died before completion. Surfaced as chips in the dashboard so a
     * flaky-but-responsive provider is distinguishable from a clean error.
     */
    partialModels: Array<{ provider: string; model: string; reason?: string; at: number; streamedChunks?: number }>;
    /**
     * Daily buckets over the last TIMELINE_DAYS — verified vs killed vs
     * transient vs partial counts per day (ascending), so the dashboard can
     * render a "learned from real usage over time" sparkline/bar chart per
     * action. Each bucket also carries the RAW events that landed that day,
     * so the chart can be scrubbed day-by-day to show that day's exact chips
     * (which provider × model the action killed or verified).
     */
    timeline: Array<{
      /** Start of the UTC day bucket (epoch ms). */
      day: number;
      verified: number;
      killed: number;
      transient: number;
      /** Mid-stream partial-interruption events that day (P4 M4.4). */
      partial: number;
      /** Raw events that day — the chips the scrubbable chart shows per day. */
      events: Array<{
        provider: string;
        model: string;
        outcome: 'verified' | 'unavailable' | 'error' | 'partial';
        errorType?: string;
        /** Epoch ms of the event. */
        at: number;
        /** P4 M4.4: chunks streamed before a partial died (surfaced in the chip tooltip). */
        streamedChunks?: number;
      }>;
    }>;
  }>;
}

// ─── Storage ────────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_DIR = join(resolveNuviraHome(), 'memory');
const CURRENT_VERSION = 1;
/** Action-telemetry JSONL log — which action killed/verified which provider × model. */
export const ACTION_LOG_FILENAME = 'model-registry-actions.jsonl';
/** Keep at most this many action-log lines (rotated, newest kept). */
export const MAX_ACTION_LOG_ENTRIES = 2000;
/** Days of per-action daily buckets included in the telemetry timeline. */
export const TIMELINE_DAYS = 14;
/** VectorStore namespace that holds the enterprise mirror of the registry. */
const VECTOR_NAMESPACE = 'model-registry';
/** Cap on per-entry partialRate history samples (dashboard sparkline points). */
export const MAX_PARTIAL_HISTORY = 16;
/** Single vector id holding the whole registry snapshot (1-dim — we never search). */
const VECTOR_SNAPSHOT_ID = 'snapshot';
/** Verified entries older than this are demoted to `unverified` on prune. */
export const DEFAULT_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/**
 * Minimum unavailable entries (with zero verified models) before a provider is
 * deemed DEGRADED by `getDegradedProviders()` — the registry pre-filter that
 * stops the router from scoring a provider it already knows is dead. ISSUE-002.
 */
export const DEGRADED_UNAVAILABLE_THRESHOLD = 3;

/**
 * How far a single SUCCESS decays the error-rate EMA (mirrors the 0.1 partial-
 * rate heal step). errorRate must heal on success, otherwise a transient blip
 * permanently penalizes a recovered model in preferredModelsFor().
 */
export const ERROR_RATE_HEAL_STEP = 0.1;

/**
 * How long a pair that resolved with an UNUSABLE (empty) response is parked.
 *
 * fix_model_routing P1/P2. Short enough to self-heal (a genuinely transient
 * empty), long enough that the same broken pair is not re-picked on the next
 * turn. Model-scoped: the provider's healthy siblings stay routable.
 */
export const EMPTY_RESPONSE_PARK_MS = 120_000;

function memoryDir(): string {
  return envBuff('MEMORY_DIR') || DEFAULT_MEMORY_DIR;
}

/**
 * Where a telemetry record originated: a real run (`live`) or a test process
 * (`test`).
 *
 * WHY THIS IS A RUNTIME CHECK, NOT A CALLER ARGUMENT. Relying on every call site
 * to pass the right value means the one that forgets silently poisons the
 * production store — which is exactly how `local/nonexistent-fast-fail` came to
 * be the largest row on the dashboard. Detecting it at the single write path
 * fails closed: an unrecognised process is `live`, and a known test runner is
 * `test` whether or not the caller remembered.
 *
 * Three signals, cheapest first: an explicit override (so a harness can pin the
 * value), then the test runners' own env markers (`vitest`/`jest` both set
 * these), then `NODE_ENV=test`.
 */
export function telemetryOrigin(): 'live' | 'test' {
  // Both spellings: the bare var for an explicit operator override, and the
  // namespaced one (NUVIRA_/BUFF_) which `envBuff` resolves — the harness sets
  // the namespaced form so "this is a test process" is stated, not inferred.
  const override = process.env.TELEMETRY_ORIGIN ?? envBuff('TELEMETRY_ORIGIN');
  if (override === 'test' || override === 'live') return override;
  if (process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.JEST_WORKER_ID) {
    return 'test';
  }
  if (envBuff('NODE_ENV') === 'test') return 'test';
  return 'live';
}

function mirrorPath(): string {
  return join(memoryDir(), 'model-registry.json');
}

function actionLogPath(): string {
  return join(memoryDir(), ACTION_LOG_FILENAME);
}

function entryKey(provider: string, model: string): string {
  return `${provider}|${model || 'default'}`;
}

/**
 * Does an `unavailable` REASON mean the provider/model pair cannot exist?
 *
 * Deliberately narrow: it must be an explicit "this model does not exist on
 * this endpoint", never a permission/per-account answer (a 403 or a quota
 * denial can be repaired, so the pair must stay reachable).
 */
const MODEL_NOT_FOUND_REASON_RE = /model not found|not in live model list|does not exist|no such model|model_not_found/i;

/**
 * Is this entry a NONEXISTENT pair — the provider cannot serve this id at all?
 *
 * The flag is the primary signal, but the reason check heals data written
 * BEFORE the flag existed (and by any surface): an entry sitting at
 * `unavailable` with a not-found reason IS a retired pair, and without this the
 * live `local/gemini-3.1-flash-lite` entry would keep being offered until it
 * failed one more time.
 *
 * EXPORTED for `learning/pair-entitlement.ts`, which needs the SAME verdict the
 * dead-pair machinery uses. Two predicates for one question is how the registry
 * and the router start disagreeing about which pairs are offerable.
 */
export function isNonexistentPair(e: {
  deadPair?: boolean;
  status?: string;
  lastError?: string;
}): boolean {
  if (e.deadPair) return true;
  return e.status === 'unavailable' && MODEL_NOT_FOUND_REASON_RE.test(e.lastError ?? '');
}

/**
 * Does an `unavailable` REASON describe an ACCOUNT-level refusal that a fresh
 * catalogue listing cannot refute?
 *
 * The complement of {@link MODEL_NOT_FOUND_REASON_RE}, and deliberately disjoint
 * from it. "This model does not exist on this endpoint" IS refuted by the
 * provider listing the model again — but "this account cannot pay for this
 * call" and "this key is not authorized" are facts about the ACCOUNT, and a
 * public model list says nothing about them. Collapsing the two is what let a
 * metadata probe re-arm a pair `recordCall` had already proven dead (see the
 * note in `markListed`).
 *
 * Narrow on purpose: transient refusals (`rate-limit`, quota parks, 5xx) are
 * NOT entitlement failures — a listing, a park expiry or a recovered key may
 * legitimately re-open those, and `quotaParkedUntil` already models the clock.
 *
 * EXPORTED for `learning/pair-entitlement.ts` — see `isNonexistentPair`.
 */
export function isEntitlementFailure(lastError: string | undefined | null): boolean {
  if (!lastError) return false;
  if (MODEL_NOT_FOUND_REASON_RE.test(lastError)) return false;
  const t = lastError.toLowerCase();
  return (
    t.includes('credit-exhausted') ||
    t.includes('insufficient credit') ||
    t.includes('payment required') ||
    t.includes('billing') ||
    t.includes('unauthorized') ||
    t.includes('forbidden') ||
    t.includes('invalid api key') ||
    t.includes('invalid_api_key') ||
    t.includes('authentication failed') ||
    /\bauth\b/.test(t) ||
    /\b40[123]\b/.test(t)
  );
}

/**
 * The config value `'default'` is a SENTINEL meaning "use the provider's
 * default model" — it is NOT a model id. Telemetry must never track it: a
 * `groq|default` entry marked `verified` (observed live, its lastError being
 * "model not found") ranked first by error-rate and was handed to the adapter
 * as a literal model name. Every registry WRITE ignores the sentinel.
 */
export function isSentinelModel(model: string | undefined | null): boolean {
  return !model || model === 'default';
}

function emptyState(): ModelRegistryData {
  return { version: CURRENT_VERSION, entries: {}, updatedAt: Date.now() };
}

/** A deep copy of registry state, so a snapshot cannot be mutated through aliasing. */
function cloneRegistryData(data: ModelRegistryData): ModelRegistryData {
  return JSON.parse(JSON.stringify(data)) as ModelRegistryData;
}

/**
 * Merge three views of the registry into the one that should be on disk.
 *
 * The problem it solves, measured (2026-10-07): the singleton loads the mirror
 * once at construction and `persist()` writes its WHOLE entry map back, so a
 * long-lived process flushes a snapshot of every model it never touched —
 * silently reverting what the dashboard, the gateway or a CLI run verified in
 * the meantime. On this machine that flipped a strict-pin verdict from
 * `credit-exhausted` back to `unverified` between two runs of one command, which
 * re-armed the exact pre-flight F6 had just closed.
 *
 * The resolution needs no bookkeeping in the mutators, because `boot` already
 * records what this process was told:
 *
 *  - an entry this process CHANGED since boot (`memory` differs from `boot`) is
 *    this process's knowledge, and wins;
 *  - an entry it never touched is whatever `disk` now holds, because another
 *    process may have learned something about it;
 *  - an entry present at boot but ABSENT from `memory` was deliberately dropped
 *    (`pruneAbsentModels`), so the deletion wins — otherwise the prune would
 *    undo itself the moment the next persist re-added it from disk;
 *  - an entry in neither `boot` nor `memory` but on `disk` is a peer's new row,
 *    and is adopted.
 *
 * Comparing with `stableJson` (not a bare deep-equal) is deliberate: two entries
 * built by different code paths can be structurally identical yet serialize with
 * different key order, which would read as "changed" and clobber the peer.
 */
export function mergeRegistryMirror(
  boot: ModelRegistryData,
  memory: ModelRegistryData,
  disk: ModelRegistryData,
): ModelRegistryData {
  const entries: Record<string, ModelRegistryEntry> = {};
  const keys = new Set([
    ...Object.keys(boot.entries),
    ...Object.keys(memory.entries),
    ...Object.keys(disk.entries),
  ]);
  for (const key of keys) {
    const mine = memory.entries[key];
    const base = boot.entries[key];
    const theirs = disk.entries[key];
    if (!mine) {
      if (base) continue; // this process removed it — the deletion is the update
      if (theirs) entries[key] = theirs; // a peer's new row
      continue;
    }
    const changedHere = !base || stableJson(mine) !== stableJson(base);
    if (changedHere) {
      entries[key] = mine;
      continue;
    }
    // Unchanged HERE, so the file decides — including its ABSENCE. Re-adding a
    // key the file no longer has would resurrect a peer's deletion (a prune, or
    // a `reset`), which is the same lost-update bug pointing the other way.
    if (theirs === undefined) continue;
    entries[key] = theirs;
  }
  // Scalars (version, updatedAt) come from this process; only the entry map merges.
  return { ...disk, ...memory, entries };
}

/**
 * Aggregate raw action-telemetry entries into the per-action dashboard view.
 * Pure + sync — the dashboard server calls this on the raw JSONL lines, and
 * the registry uses it for `getActionTelemetry()`. Dedupes repeated writes of
 * the same provider × model within an action (latest event wins) for the
 * "verified/killed" chips; counts stay raw so volumes are honest.
 */
/**
 * Parse a model-registry-actions.jsonl file into entries (skips corrupt lines).
 * Shared by the registry's getActionTelemetry() AND the dashboard server, so
 * both always agree on the parse — and on the filename (ACTION_LOG_FILENAME).
 */
export function readActionTelemetryFile(path: string): ActionTelemetryEntry[] {
  try {
    if (!existsSync(path)) return [];
    const entries: ActionTelemetryEntry[] = [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as ActionTelemetryEntry;
        if (e && typeof e === 'object' && e.action && e.provider && e.model) entries.push(e);
      } catch {
        // Skip corrupt lines.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Daily buckets covering the last TIMELINE_DAYS days (ascending, oldest first).
 * Pure — used by aggregateActionTelemetry so the dashboard gets a per-action
 * verified/killed/transient series over time.
 */
export function buildActionTimeline(
  entries: ActionTelemetryEntry[],
  days: number = TIMELINE_DAYS,
  now: number = Date.now(),
): ActionTelemetryInsights['actions'][number]['timeline'] {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now).setUTCHours(0, 0, 0, 0);
  type Event = ActionTelemetryInsights['actions'][number]['timeline'][number]['events'][number];
  type Bucket = {
    verified: number;
    killed: number;
    transient: number;
    partial: number;
    /** Deduped by provider × model × outcome — latest event wins. */
    events: Map<string, Event>;
  };
  const buckets = new Map<number, Bucket>();
  for (let i = days - 1; i >= 0; i--) {
    const day = startOfToday - i * DAY_MS;
    buckets.set(day, { verified: 0, killed: 0, transient: 0, partial: 0, events: new Map() });
  }
  for (const e of entries) {
    const day = new Date(e.timestamp).setUTCHours(0, 0, 0, 0);
    const bucket = buckets.get(day);
    if (!bucket) continue; // older than the window — totals still count it
    if (e.outcome === 'verified') bucket.verified++;
    else if (e.outcome === 'unavailable') bucket.killed++;
    else if (e.outcome === 'partial') bucket.partial++;
    else bucket.transient++;
    // Carry the event so the scrubbable chart can render that day's chips —
    // deduped per provider × model × outcome (latest wins) so the dashboard
    // payload stays bounded as usage grows. Chips are one-per-combo-per-day
    // anyway; the COUNTS above stay raw and honest.
    bucket.events.set(`${e.provider}|${e.model}|${e.outcome}`, {
      provider: e.provider,
      model: e.model,
      outcome: e.outcome,
      errorType: e.errorType,
      at: e.timestamp,
      streamedChunks: e.outcome === 'partial' ? e.streamedChunks : undefined,
    });
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, counts]) => ({
      day,
      verified: counts.verified,
      killed: counts.killed,
      transient: counts.transient,
      partial: counts.partial,
      events: [...counts.events.values()],
    }));
}

export function aggregateActionTelemetry(
  entries: ActionTelemetryEntry[],
  options: { includeSynthetic?: boolean } = {},
): ActionTelemetryInsights {
  // Test-origin records are EXCLUDED from what the dashboard reports as learned
  // behaviour — the view stays honest without rewriting the chain that records
  // them (see `origin` on ActionTelemetryEntry). Records with no `origin`
  // predate the field and are treated as live, so old data keeps working.
  const syntheticEntries = entries.filter((e) => e.origin === 'test');
  const usable = options.includeSynthetic
    ? entries
    : entries.filter((e) => e.origin !== 'test');
  const byAction = new Map<string, ActionTelemetryEntry[]>();
  for (const e of usable) {
    const list = byAction.get(e.action);
    if (list) list.push(e);
    else byAction.set(e.action, [e]);
  }
  const actions = [...byAction.entries()]
    .map(([action, evs]) => {
      const verifiedEvents = evs.filter((e) => e.outcome === 'verified');
      const killedEvents = evs.filter((e) => e.outcome === 'unavailable');
      const transientEvents = evs.filter((e) => e.outcome === 'error');
      const partialEvents = evs.filter((e) => e.outcome === 'partial');
      // Latest event per provider|model (a success/failure repeats per call).
      const latest = (list: ActionTelemetryEntry[]): ActionTelemetryEntry[] => {
        const map = new Map<string, ActionTelemetryEntry>();
        for (const e of list) map.set(`${e.provider}|${e.model}`, e);
        return [...map.values()].sort((a, b) => b.timestamp - a.timestamp);
      };
      return {
        action,
        verified: verifiedEvents.length,
        killed: killedEvents.length,
        transient: transientEvents.length,
        partial: partialEvents.length,
        verifiedModels: latest(verifiedEvents).map((e) => ({ provider: e.provider, model: e.model, at: e.timestamp })),
        killedModels: latest(killedEvents).map((e) => ({ provider: e.provider, model: e.model, reason: e.errorType, at: e.timestamp })),
        partialModels: latest(partialEvents).map((e) => ({ provider: e.provider, model: e.model, reason: e.errorType, at: e.timestamp, streamedChunks: e.streamedChunks })),
        timeline: buildActionTimeline(evs),
      };
    })
    .sort((a, b) => a.action.localeCompare(b.action));
  return {
    enabled: actions.length > 0,
    total: usable.length,
    synthetic: options.includeSynthetic ? 0 : syntheticEntries.length,
    updatedAt: Date.now(),
    actions,
  };
}

// ─── ModelRegistry ──────────────────────────────────────────────────────────

/**
 * Persistent model availability registry with sub-ms synchronous reads.
 *
 * Reads hit an in-memory snapshot (loaded synchronously from the JSON mirror
 * at construction). Writes update the snapshot, persist to the JSON mirror
 * synchronously (best-effort), then mirror to the VectorStore namespace
 * asynchronously (best-effort) when the vector stack is available.
 */
export class ModelRegistry {
  private data: ModelRegistryData;
  /**
   * The registry as this process loaded it, kept so `persist()` can tell WHICH
   * entries this process actually changed (see `mergeRegistryMirror`). Without
   * it, a persist flushes every entry it merely READ back over whatever other
   * processes have learned since — the measured lost-update bug.
   */
  private bootSnapshot: ModelRegistryData;
  /** Cached VectorStore for the enterprise mirror (null until first mirror). */
  private vectorStore: VectorStore | null = null;
  /** Whether the vector mirror has been confirmed usable. */
  private vectorMirrored = false;
  /** Lines in the action-telemetry JSONL log (-1 = not yet counted). */
  private actionLogCount = -1;

  constructor() {
    this.data = this.loadMirror();
    this.bootSnapshot = cloneRegistryData(this.data);
  }

  // ─── Synchronous read path (lightning fast — no I/O, no network) ─────────

  /**
   * Is `provider/model` usable RIGHT NOW?
   * True when the entry is verified, not quota-parked, and not stale.
   * Sub-ms: in-memory lookup only.
   */
  isUsable(provider: string, model: string, now: number = Date.now()): boolean {
    const e = this.data.entries[entryKey(provider, model)];
    if (!e) return false;
    if (e.status !== 'verified') return false;
    // FIX (Gemini parking bug): verified models skip provider-level parking.
    // A verified model has proven it works — blanket-parking it because a
    // DIFFERENT model in the same provider hit a rate limit is the root cause
    // of providers being blocked despite having working models. Only model-
    // specific parking (from recordCall, providerParked=false) blocks a
    // verified model. Provider-level parking (providerParked=true or undefined
    // for old data) is skipped for verified models.
    if (e.quotaParkedUntil > now && e.providerParked === false) return false;
    if (now - e.lastVerifiedAt > DEFAULT_STALE_MS) return false;
    return true;
  }

  /**
   * All verified, usable models for a provider (best first: latest verified).
   * Sync — the fast path for routing and the model picker.
   */
  getVerifiedModels(provider: string, now: number = Date.now()): string[] {
    return Object.values(this.data.entries)
      .filter((e) => e.provider === provider && this.isUsable(provider, e.model, now))
      // `'default'` is the config SENTINEL ("use the provider's default
      // model"), not a model id. Telemetry can erroneously record it as a
      // VERIFIED model — observed live: `groq|default` had status=verified
      // while its lastError was "model not found". With errorRate 0 it sorts
      // first and gets handed to the adapter, so the provider rejects it.
      // Never expose the sentinel as a routable model.
      .filter((e) => !!e.model && e.model !== 'default')
      .sort((a, b) => b.lastVerifiedAt - a.lastVerifiedAt)
      .map((e) => e.model);
  }

  /**
   * Every provider the registry holds ANY data for — verified, unverified or
   * dead, sorted.
   *
   * Deliberately broader than {@link getUsableProviders} (verified only). The
   * warmup sweep needs the providers whose models it could VERIFY — which are
   * exactly the ones still invisible to the router, i.e. the ones missing from
   * the usable set.
   */
  getTrackedProviders(): string[] {
    return [...new Set(Object.values(this.data.entries).map((e) => e.provider))].sort();
  }

  /**
   * ALL tracked models for a provider (verified + unverified + unavailable).
   * Returns full ModelRegistryEntry objects so callers can inspect context
   * windows, latency, error rates, etc. Sync.
   */
  getAllModelsForProvider(provider: string): ModelRegistryEntry[] {
    return Object.values(this.data.entries).filter((e) => e.provider === provider);
  }

  /**
   * Provider × model pairs that are DEFINITIVELY dead — the provider answered
   * "model not found" for them (see `ModelRegistryEntry.deadPair`). Sync + sub-ms.
   *
   * The candidate builders consult this so an impossible pair can never be
   * offered again, and `nuvira models excluded` reports it, so "why is this
   * model never tried?" is answerable instead of silent.
   */
  getDeadPairs(): Array<{ provider: string; model: string }> {
    const out: Array<{ provider: string; model: string }> = [];
    for (const e of Object.values(this.data.entries)) {
      if (isNonexistentPair(e)) out.push({ provider: e.provider, model: e.model });
    }
    return out;
  }

  /** Is this exact provider × model pair retired as definitively nonexistent? */
  isDeadPair(provider: string, model: string | undefined): boolean {
    if (!model || model === 'default') return false;
    const entry = this.data.entries[entryKey(provider, model)];
    return !!entry && isNonexistentPair(entry);
  }

  /** Providers that currently have at least one verified, usable model. Sync. */
  getUsableProviders(now: number = Date.now()): string[] {
    const providers = new Set<string>();
    for (const e of Object.values(this.data.entries)) {
      if (this.isUsable(e.provider, e.model, now)) providers.add(e.provider);
    }
    return [...providers];
  }

  /**
   * Providers the registry has DEFINITIVELY ruled out right now: every tracked
   * model for the provider is `unavailable` and/or quota-parked, with no
   * verified usable alternative. Sync + sub-ms (in-memory only) — the
   * predictive skip that lets routing avoid a provider the registry already
   * knows is dead instead of failing into it reactively.
   *
   * Providers with ONLY `unverified` entries are NOT blocked — "not yet
   * probed" is not "dead" — and a provider with any verified model stays
   * routable (model repair will pick the working one).
   */
  getBlockedProviders(now: number = Date.now()): string[] {
    const byProvider = new Map<string, ModelRegistryEntry[]>();
    for (const e of Object.values(this.data.entries)) {
      const list = byProvider.get(e.provider);
      if (list) list.push(e);
      else byProvider.set(e.provider, [e]);
    }
    const blocked: string[] = [];
    for (const [provider, entries] of byProvider) {
      if (entries.some((e) => this.isUsable(provider, e.model, now))) continue;
      // All tracked models unusable — block only if at least one is a
      // DEFINITIVE no (unavailable or quota-parked), never on unverified alone.
      const definitive = entries.some((e) => e.status === 'unavailable' || e.quotaParkedUntil > now);
      if (definitive) blocked.push(provider);
    }
    return blocked;
  }

  /**
   * Providers the registry has effectively written off: ZERO verified models
   * AND at least DEGRADED_UNAVAILABLE_THRESHOLD (3) unavailable entries.
   *
   * Stronger than `getBlockedProviders()` (which requires EVERY tracked model
   * to be unusable): a provider that has never verified a single model while
   * accumulating ≥3 definitive failures is a dead candidate — it should not
   * be scored, because the registry already knows it will fail. It stays
   * excluded until a re-probe / spot-check verifies something or the user
   * unblocks it (unblockProvider demotes to unverified, which no longer
   * meets the degraded bar). Sync + sub-ms.
   */
  getDegradedProviders(now: number = Date.now()): string[] {
    const byProvider = new Map<string, ModelRegistryEntry[]>();
    for (const e of Object.values(this.data.entries)) {
      const list = byProvider.get(e.provider);
      if (list) list.push(e);
      else byProvider.set(e.provider, [e]);
    }
    const degraded: string[] = [];
    for (const [provider, entries] of byProvider) {
      if (entries.some((e) => this.isUsable(provider, e.model, now))) continue;
      const unavailable = entries.filter((e) => e.status === 'unavailable').length;
      if (unavailable >= DEGRADED_UNAVAILABLE_THRESHOLD) degraded.push(provider);
    }
    return degraded;
  }

  /**
   * Per-provider availability snapshot for a provider (sync) — the raw counts
   * the router and `models explain` cite when a provider is excluded by
   * registry data ("openrouter excluded — 0 verified, 6 unavailable").
   */
  getProviderStats(provider: string, now: number = Date.now()): {
    verified: number;
    unverified: number;
    unavailable: number;
    parked: number;
  } {
    let verified = 0;
    let unverified = 0;
    let unavailable = 0;
    let parked = 0;
    for (const e of Object.values(this.data.entries)) {
      if (e.provider !== provider) continue;
      if (e.quotaParkedUntil > now) parked++;
      else if (e.status === 'verified') verified++;
      else if (e.status === 'unavailable') unavailable++;
      else unverified++;
    }
    return { verified, unverified, unavailable, parked };
  }

  /** Get the raw entry (for diagnostics). Sync. */
  getEntry(provider: string, model: string): ModelRegistryEntry | undefined {
    return this.data.entries[entryKey(provider, model)];
  }

  /**
   * Every verified, usable pair across ALL providers (A1).
   *
   * `getVerifiedModels(provider)` answers "what works on THIS provider"; this
   * answers "what works anywhere", which is the question a pin pre-flight has to
   * ask: when a pair is refused, the useful next sentence is "the same model is
   * verified on <other provider>". Built on the SAME `isUsable()` gate as
   * routing, so a suggestion here can never name a pair the router would reject.
   *
   * The `'default'` sentinel is excluded — it is a config marker ("use the
   * provider's default"), not a model id, and suggesting it would be nonsense.
   */
  getAllUsablePairs(now: number = Date.now()): Array<{ provider: string; model: string }> {
    return Object.values(this.data.entries)
      .filter((e) => !isSentinelModel(e.model) && this.isUsable(e.provider, e.model, now))
      .map((e) => ({ provider: e.provider, model: e.model }));
  }

  /**
   * The learned reasoning-parameter support for a provider × model, or
   * `undefined` when nothing has been established (callers treat absent as
   * "do not send" — default-deny). Sync, sub-ms.
   */
  getReasoningCapability(provider: string, model: string): ReasoningCapability | undefined {
    return this.data.entries[entryKey(provider, model)]?.reasoningCapability;
  }

  /**
   * Record that a provider × model ACCEPTS a reasoning parameter (from the
   * provider's advertised metadata, a successful probe, or a successful call
   * that carried the parameter).
   */
  markReasoningSupported(
    provider: string,
    model: string,
    param: string,
    shape: ReasoningShape,
    source: ReasoningCapability['source'] = 'probed',
  ): void {
    if (isSentinelModel(model)) return;
    const entry = this.ensureEntry(provider, model);
    entry.reasoningCapability = { supported: true, param, shape, verifiedAt: Date.now(), source };
    this.persist();
  }

  /**
   * Record that a provider × model REJECTED a reasoning parameter — positive
   * negative evidence that stops the parameter being sent here on the next
   * call (default-deny now has a reason to deny). Best-effort.
   */
  markReasoningUnsupported(provider: string, model: string, param: string): void {
    if (isSentinelModel(model)) return;
    const entry = this.ensureEntry(provider, model);
    entry.reasoningCapability = {
      supported: false,
      param,
      shape: entry.reasoningCapability?.shape ?? 'openai-reasoning-effort',
      verifiedAt: Date.now(),
      source: 'learned-unsupported',
    };
    this.persist();
  }

  /**
   * Get an entry for writing, creating a neutral `unverified` one when absent —
   * WITHOUT disturbing an existing entry's status/latency. Used by the
   * reasoning-capability writes, which are orthogonal to availability.
   */
  private ensureEntry(provider: string, model: string): ModelRegistryEntry {
    const key = entryKey(provider, model);
    const existing = this.data.entries[key];
    if (existing) return existing;
    const now = Date.now();
    const created: ModelRegistryEntry = {
      provider,
      model,
      status: 'unverified' as ModelAvailabilityStatus,
      lastVerifiedAt: 0,
      lastProbedAt: now,
      lastUsedAt: 0,
      errorRate: 0,
      quotaParkedUntil: 0,
      source: 'telemetry' as ModelRegistrySource,
    };
    this.data.entries[key] = created;
    return created;
  }

  /**
   * Resolve a WORKING model for a provider, preferring a curated known-good
   * verified model. Sync — used by the model validator's fast path.
   *
   * @param preferred Ordered candidate models (curated defaults first).
   * @returns The first candidate that is verified+usable, else undefined.
   */
  resolveVerifiedModel(provider: string, preferred: string[], now: number = Date.now()): string | undefined {
    for (const m of preferred) {
      if (this.isUsable(provider, m, now)) return m;
    }
    // No curated pick usable — any verified model works, minus NON-CHAT
    // families (a probe can verify a classifier/embedding/speech/image model,
    // which can never serve a chat turn — observed live with
    // llama-prompt-guard-2).
    const verified = this.getVerifiedModels(provider, now).filter((m) => !isNonChatModel(m));
    return verified.length > 0 ? verified[0] : undefined;
  }

  // ─── Writes (probe / spot-check / telemetry) ──────────────────────────────

  /**
   * P4 M4.4: append the entry's current partialRate to its history (newest
   * last, capped at MAX_PARTIAL_HISTORY). Callers invoke this right after a
   * partialRate mutation so the dashboard sparkline sees the exact trajectory.
   */
  private pushPartialHistory(entry: ModelRegistryEntry, now: number = Date.now()): void {
    const rate = entry.partialRate || 0;
    const history = entry.partialHistory ? [...entry.partialHistory] : [];
    history.push({ t: now, rate });
    entry.partialHistory = history.slice(-MAX_PARTIAL_HISTORY);
  }

  /**
   * listModels probe: mark the model as seen (unverified unless already
   * verified). Does NOT downgrade a verified entry — real verification wins —
   * and does NOT clear a definitive ACCOUNT-level refusal (see
   * `isEntitlementFailure`).
   * Accepts either bare ids (legacy callers) or full model descriptors; when
   * a descriptor carries the provider-advertised context window, it is
   * recorded so the router's context preflight can use the LIVE value.
   */
  markListed(provider: string, models: Array<string | ModelDescriptor>): void {
    const now = Date.now();
    for (const raw of models) {
      const model = typeof raw === 'string' ? raw : raw.id;
      if (isSentinelModel(model)) continue; // never track the 'default' sentinel
      const contextWindowTokens = typeof raw === 'string' ? undefined : raw.contextWindowTokens;
      const advertisedReasoning = typeof raw === 'string' ? undefined : reasoningCapabilityFromAdvertised(raw.supportedParameters, now);
      const key = entryKey(provider, model);
      const existing = this.data.entries[key];
      // Advertised reasoning support is PROVIDER-DECLARED metadata: learn it from
      // the list probe so a model the provider serves with reasoning is usable at
      // max the moment it is first seen. A prior `learned-unsupported` (a real
      // rejection) OUTRANKS the catalog claim and is kept.
      const reasoningCapability = existing?.reasoningCapability?.source === 'learned-unsupported'
        ? existing.reasoningCapability
        : advertisedReasoning ?? existing?.reasoningCapability;
      if (existing && existing.status === 'verified') {
        existing.lastProbedAt = now;
        if (contextWindowTokens && contextWindowTokens > 0) existing.contextWindowTokens = contextWindowTokens;
        if (reasoningCapability) existing.reasoningCapability = reasoningCapability;
        continue;
      }
      // ── A DEFINITIVE ENTITLEMENT REFUSAL SURVIVES A CATALOGUE LISTING ───────
      // Being in the provider's model list proves the provider SERVES the model.
      // It proves nothing about whether THIS ACCOUNT may use it — and those are
      // different axes, the same distinction `errorRate`/`partialRate` already
      // draw below. Measured (2026-10-06): `openrouter|deepseek/deepseek-v4.1-flash`
      // is in OpenRouter's public catalogue, while the account behind the key had
      // never purchased credits. `recordCall` had learned the definitive
      // `credit-exhausted` verdict; a catalogue refresh re-listed the provider,
      // this loop reset the entry to `unverified`, and the pin that one run
      // refused before any network call was offered again by the next — which got
      // a raw `402 Insufficient credits` body back. Same pin, same registry,
      // opposite outcomes, decided by a metadata probe. An entitlement verdict
      // only real traffic can clear.
      const entitled = existing?.status === 'unavailable' && isEntitlementFailure(existing?.lastError);
      this.data.entries[key] = {
        provider,
        model,
        status: entitled ? 'unavailable' : 'unverified',
        lastVerifiedAt: existing?.lastVerifiedAt || 0,
        lastProbedAt: now,
        lastUsedAt: existing?.lastUsedAt || 0,
        latencyMs: existing?.latencyMs,
        contextWindowTokens: contextWindowTokens && contextWindowTokens > 0
          ? contextWindowTokens
          : existing?.contextWindowTokens,
        errorRate: existing?.errorRate || 0,
        // P4 M4.4: a re-list never wipes the flakiness signal (same contract
        // as markVerified — availability and reliability are separate axes).
        partialRate: existing?.partialRate,
        partialHistory: existing?.partialHistory,
        quotaParkedUntil: existing?.quotaParkedUntil || 0,
        reasoningCapability,
        source: 'probe',
        capability: existing?.capability,
        lastError: existing?.lastError,
        // The provider's OWN model list is authoritative about what it serves:
        // a pair that appears in a fresh list is not a dead pair, so the flag is
        // dropped. A bogus list re-earns the flag on the next call (one 404), so
        // this is self-correcting rather than a permanent re-offer loop.
        deadPair: undefined,
      };
    }
    this.persist();
  }

  /**
   * Mark a model verified (spot-check success or real telemetry success).
   * Optionally records measured latency (rolling EMA).
   *
   * A genuine verification CLEARS any quota park: a real 1-token spot-check or
   * a real usage success is direct evidence the provider serves requests again,
   * so a stale learned park (e.g. an hour-aligned rate-limit park) must not
   * keep a recovered provider blocked. This is safe because `syncQuota()`
   * re-applies genuine ledger parks on the next routing read — a provider that
   * is REALLY still quota-exhausted gets re-parked immediately, while one that
   * merely had a stale learned park stays routable (the recovery loop).
   *
   * Asymmetry note: parks set by the REGISTRY's own rate-limit telemetry
   * (`recordCall(ok=false, 'rate-limit')`) live only here and are NOT re-applied
   * by syncQuota (which mirrors ledger cooldowns). Clearing them on any
   * successful verification is deliberate and self-correcting: a probe or real
   * call that SUCCEEDED is proof the limit lifted; if the limit persists, the
   * next real call fails again and re-parks.
   */
  markVerified(
    provider: string,
    model: string,
    source: ModelRegistrySource,
    latencyMs?: number,
    action?: string,
    costUsd?: number,
    callId?: string,
  ): void {
    if (isSentinelModel(model)) return; // never verify the 'default' sentinel
    const now = Date.now();
    const key = entryKey(provider, model);
    const existing = this.data.entries[key];
    const prevLatency = existing?.latencyMs;
    this.data.entries[key] = {
      provider,
      model,
      status: 'verified',
      lastVerifiedAt: now,
      lastProbedAt: existing?.lastProbedAt || now,
      lastUsedAt: existing?.lastUsedAt || now,
      // EMA (α=0.3): smooth noisy spot-checks but stay responsive to regressions.
      latencyMs: latencyMs !== undefined
        ? prevLatency !== undefined
          ? Math.round(0.3 * latencyMs + 0.7 * prevLatency)
          : Math.round(latencyMs)
        : prevLatency,
      // Success HEALS reliability: decay the error EMA toward 0 (never hard-reset,
      // so one lucky call can't erase a genuinely flaky streak). Before this a
      // verified model that once hit a transient 429 stayed penalized FOREVER
      // (errorRate was monotonically non-decreasing), permanently sinking it in
      // preferredModelsFor() even after it recovered.
      errorRate: Math.max(0, (existing?.errorRate ?? 0) - ERROR_RATE_HEAL_STEP),
      // The provider-advertised context window survives a re-verify (it is
      // model metadata, independent of the verify event).
      contextWindowTokens: existing?.contextWindowTokens,
      // Verified ⇒ serving right now ⇒ not parked (syncQuota re-parks real exhaustion).
      quotaParkedUntil: 0,
      source,
      lastError: existing?.lastError,
      // M2.2: measured wire-token EMAs survive a re-verify (they are
      // model-level usage data, independent of the verify event).
      measuredInputTokens: existing?.measuredInputTokens,
      measuredOutputTokens: existing?.measuredOutputTokens,
      measuredSamples: existing?.measuredSamples,
      // P4 M4.4: mid-stream flakiness survives a re-verify too — a success
      // DECAYS it (recordCall) rather than wiping it, so a single clean call
      // can't erase a flaky streak (that's the whole point of the EMA). The
      // trajectory (partialHistory) survives alongside it.
      partialRate: existing?.partialRate,
      partialHistory: existing?.partialHistory,
      // Reasoning-parameter support is model metadata, independent of the verify
      // event — it survives a re-verify exactly like contextWindowTokens does.
      reasoningCapability: existing?.reasoningCapability,
      // Bundle 3b: the measured scorecard is model metadata too. A verification
      // proves the pair ANSWERS; it says nothing about how well it does the work,
      // so the accuracy samples must not be reset by it (nor by any availability
      // flip — see markListed/markUnavailable).
      capability: existing?.capability,
    };
    this.persist();
    // A GENUINE promotion (was not verified → now verified) is a state change
    // the agent should know about — real usage just proved the model works.
    // Emitting only on transitions (not every success) avoids event storms.
    if (existing?.status !== 'verified') {
      this.emitUpdated([provider], `verified: ${model}`, source);
    }
    // Action-attributed telemetry: which action proved this provider × model
    // works (dashboard "learned from real usage" panel). Only when the caller
    // passed an action — anonymous writes (e.g. the cost-tracker mirror) update
    // health but don't add panel rows.
    if (action) {
      this.appendActionLog({ timestamp: now, action, provider, model, outcome: 'verified', latencyMs, costUsd, callId });
    }
  }

  /**
   * Fold one observation into this pair's capability scorecard (Bundle 3b).
   *
   * Silent and best-effort by design: a scorecard write must never fail a call or
   * an availability write. The record is model metadata — created on first
   * observation, never reset by an availability flip (see `markVerified`).
   */
  private foldCapability(
    provider: string,
    model: string,
    observation: {
      verification?: 'verified' | 'unverified' | 'blocked' | 'not-applicable' | 'delivered-and-read-back';
      ok?: boolean;
      latencyMs?: number;
      now?: number;
    },
  ): void {
    if (isSentinelModel(model)) return;
    try {
      const key = entryKey(provider, model);
      const entry = this.data.entries[key];
      if (!entry) return;
      const now = observation.now ?? Date.now();
      let record = entry.capability ?? emptyCapabilityRecord(now);
      if (observation.verification !== undefined) {
        record = foldVerification(record, observation.verification, now);
      }
      if (observation.ok !== undefined) {
        record = foldCallOutcome(record, observation.ok, now);
      }
      if (observation.latencyMs !== undefined) {
        record = foldLatency(record, observation.latencyMs, now);
      }
      if (record === entry.capability) return;
      entry.capability = record;
      this.persist();
    } catch {
      // Best-effort — the scorecard is learning, never a gate.
    }
  }

  /**
   * Record a completed TURN's verification verdict for a pair (Bundle 3b).
   *
   * The accuracy parameter's real feed: `TurnReport.verification` is derived from
   * recorded tool/plan evidence and cannot be talked up by the model, so the
   * sample this writes is an observation rather than a claim. `blocked` and
   * `not-applicable` contribute NOTHING — a wall the run hit, and a turn with
   * nothing to check, are both silent about the model.
   *
   * A pair with no entry yet is skipped rather than invented: the scorecard hangs
   * off a registry row, and creating one from a turn would claim the pair exists.
   */
  recordCapabilityEvidence(
    provider: string,
    model: string,
    verification: 'verified' | 'unverified' | 'blocked' | 'not-applicable' | 'delivered-and-read-back',
  ): void {
    this.foldCapability(provider, model, { verification });
  }

  /** This pair's measured scorecard, or undefined when nothing was measured. */
  getCapability(provider: string, model: string): CapabilityRecord | undefined {
    return this.data.entries[entryKey(provider, model)]?.capability;
  }

  /**
   * M2.2: record EXACT tokens from a provider-reported usage payload. The
   * per-call token EMAs (α=0.3, matching latency) feed getMeasuredUsage(),
   * which Auto routing uses to replace TYPICAL-token estimates with measured
   * cost. Best-effort — never throws.
   */
  recordMeasuredUsage(provider: string, model: string, inputTokens: number, outputTokens: number): void {
    const now = Date.now();
    const key = entryKey(provider, model);
    const existing = this.data.entries[key];
    const base = existing || {
      provider,
      model,
      status: 'unverified' as ModelAvailabilityStatus,
      lastVerifiedAt: 0,
      lastProbedAt: now,
      lastUsedAt: now,
      errorRate: 0,
      quotaParkedUntil: 0,
      source: 'telemetry' as ModelRegistrySource,
    };
    const prevIn = base.measuredInputTokens;
    const prevOut = base.measuredOutputTokens;
    base.measuredInputTokens = prevIn !== undefined
      ? Math.round(0.3 * inputTokens + 0.7 * prevIn)
      : inputTokens;
    base.measuredOutputTokens = prevOut !== undefined
      ? Math.round(0.3 * outputTokens + 0.7 * prevOut)
      : outputTokens;
    base.measuredSamples = (base.measuredSamples || 0) + 1;
    base.lastUsedAt = now;
    this.data.entries[key] = base;
    this.persist();
  }

  /**
   * M2.2: aggregated measured token profile for a provider (sample-weighted
   * average across its tracked models). Returns undefined when no measured
   * usage exists → callers fall back to TYPICAL-token estimates (flagged).
   * Sync + sub-ms.
   */
  getMeasuredUsage(
    provider: string,
  ): { inputTokens: number; outputTokens: number; samples: number } | undefined {
    let totalIn = 0;
    let totalOut = 0;
    let samples = 0;
    for (const e of Object.values(this.data.entries)) {
      if (e.provider !== provider || !e.measuredSamples) continue;
      totalIn += (e.measuredInputTokens || 0) * e.measuredSamples;
      totalOut += (e.measuredOutputTokens || 0) * e.measuredSamples;
      samples += e.measuredSamples;
    }
    if (samples === 0) return undefined;
    return {
      inputTokens: Math.round(totalIn / samples),
      outputTokens: Math.round(totalOut / samples),
      samples,
    };
  }

  /**
   * Mark a model unavailable (spot-check auth/403/404, or telemetry failure).
   * Optionally applies a quota park (e.g. rate-limit).
   */
  markUnavailable(
    provider: string,
    model: string,
    reason: string,
    source: ModelRegistrySource,
    quotaParkedUntil: number = 0,
    action?: string,
  ): void {
    if (isSentinelModel(model)) return; // never track the 'default' sentinel
    const now = Date.now();
    const key = entryKey(provider, model);
    const existing = this.data.entries[key];
    this.data.entries[key] = {
      provider,
      model,
      status: 'unavailable',
      lastVerifiedAt: existing?.lastVerifiedAt || 0,
      lastProbedAt: existing?.lastProbedAt || now,
      lastUsedAt: existing?.lastUsedAt || 0,
      latencyMs: existing?.latencyMs,
      errorRate: existing?.errorRate || 0,
      // P4 M4.4: an availability flip never resets reliability — the flaky
      // streak (and its trajectory) survives an auth/403 mark, same contract
      // as markVerified/markListed (a later success decays it, never a wipe).
      partialRate: existing?.partialRate,
      partialHistory: existing?.partialHistory,
      contextWindowTokens: existing?.contextWindowTokens,
      reasoningCapability: existing?.reasoningCapability,
      quotaParkedUntil: Math.max(existing?.quotaParkedUntil || 0, quotaParkedUntil),
      source,
      capability: existing?.capability,
      lastError: reason,
      // A "model not found" answer is definitive for this provider × model, so
      // the pair is retired from every candidate pool (see `deadPair`). The flag
      // is sticky across ordinary failures and cleared only by a real success.
      deadPair: existing?.deadPair || MODEL_NOT_FOUND_REASON_RE.test(reason),
      tokensConsumed: existing?.tokensConsumed,
      requests: existing?.requests,
      resetsInMs: existing?.resetsInMs,
      remainingTokens: existing?.remainingTokens,
    };
    this.persist();
    this.emitUpdated([provider], `unavailable: ${reason}`, source);
    if (action) {
      this.appendActionLog({
        timestamp: now,
        action,
        provider,
        model,
        outcome: 'unavailable',
        errorType: reason.slice(0, 120),
      });
    }
  }

  /**
   * Park a SINGLE model for a quota window (rate-limit / 429) WITHOUT demoting
   * its status.
   *
   * This is the probe-side counterpart to `recordCall(ok=false,'rate-limit')`:
   * a transient quota blip must never flip a model to `unavailable` (which
   * `isUsable()` then treats as permanently dead until a manual unblock), or a
   * single 429 during a refresh would exclude a perfectly good model forever.
   * The entry keeps its prior status (verified stays verified) and is gated
   * only by `quotaParkedUntil`, so it re-enters routing automatically the
   * moment the window lapses — "probed, and made available again when it is".
   *
   * @param until Absolute epoch ms when the park expires (must be > now to gate).
   */
  parkModel(
    provider: string,
    model: string,
    reason: string,
    until: number,
    source: ModelRegistrySource,
  ): void {
    if (isSentinelModel(model)) return; // never track the 'default' sentinel
    const now = Date.now();
    const key = entryKey(provider, model);
    const existing = this.data.entries[key];
    const entry: ModelRegistryEntry = existing ?? {
      provider,
      model,
      status: 'unverified' as ModelAvailabilityStatus,
      lastVerifiedAt: 0,
      lastProbedAt: now,
      lastUsedAt: 0,
      errorRate: 0,
      quotaParkedUntil: 0,
      source: 'telemetry' as ModelRegistrySource,
    };
    entry.lastProbedAt = now;
    entry.lastError = reason;
    entry.quotaParkedUntil = Math.max(entry.quotaParkedUntil || 0, until);
    // providerParked=false → isUsable() blocks THIS model only; a sibling model
    // on the same provider is untouched (per-model granularity).
    entry.providerParked = false;
    this.data.entries[key] = entry;
    this.persist();
    this.emitUpdated([provider], `quota-parked: ${model} (${reason})`, source);
  }

  /** Apply the quota ledger's parked-provider status to a provider's entries.
   *
   * FIX: Only park models that are NOT verified. A verified model has proven
   * it works — blanket-parking it because a DIFFERENT model in the same
   * provider hit a rate limit blocks working models unnecessarily (the
   * "Gemini parking bug"). The per-model parking from recordCall() already
   * handles the specific rate-limited model.
   */
  parkProvider(provider: string, until: number): void {
    const now = Date.now();
    let touched = false;
    for (const e of Object.values(this.data.entries)) {
      if (e.provider === provider && until > now && e.status !== 'verified') {
        e.quotaParkedUntil = Math.max(e.quotaParkedUntil, until);
        e.providerParked = true;
        touched = true;
      }
    }
    if (touched) {
      this.persist();
      this.emitUpdated([provider], `quota-parked until ${new Date(until).toISOString()}`, 'quota');
    }
  }

  /** Clear a quota park for a provider (manual re-enable / window reset). */
  releaseProvider(provider: string): void {
    let touched = false;
    for (const e of Object.values(this.data.entries)) {
      if (e.provider === provider && e.quotaParkedUntil > 0) {
        e.quotaParkedUntil = 0;
        e.providerParked = false;
        touched = true;
      }
    }
    if (touched) {
      this.persist();
      this.emitUpdated([provider], 'quota park released', 'quota');
    }
  }

  /**
   * Manual escape hatch — `nuvira models unblock <provider>`.
   *
   * Releases a provider that routing has predictively blocked (`getBlockedProviders()`):
   * demotes every `unavailable` entry back to `unverified` and clears all quota
   * parks, so the provider is no longer skipped before scoring. `unverified`
   * alone never blocks ("not yet probed" ≠ "dead"), which is exactly the state
   * an unblock should produce — the caller then RE-PROBES against the live API
   * so the registry re-learns the truth: if the provider genuinely recovered it
   * becomes `verified` again; if it is still dead the re-probe flips it back to
   * `unavailable` (one honest probe, not a permanent skip).
   *
   * Also used by the ledger-sync boundary: the caller should release the central
   * quota ledger's cooldown too, otherwise `syncQuota()` re-parks the provider
   * on the very next routing read (this method only clears REGISTRY state).
   *
   * @returns How many entries were demoted / un-parked (0/0 when untracked).
   */
  unblockProvider(provider: string): { demoted: number; unparked: number } {
    const now = Date.now();
    let demoted = 0;
    let unparked = 0;
    for (const e of Object.values(this.data.entries)) {
      if (e.provider !== provider) continue;
      if (e.status === 'unavailable') {
        // Demote the definitive no back to unverified — routing may try it again.
        e.status = 'unverified';
        e.source = 'probe'; // availability is now unknown until re-probed
        // Clear the stale learned reason so a later re-verification can't carry
        // a misleading old 'auth'/'403' message into `models status`.
        e.lastError = 'manually unblocked — re-probe pending';
        demoted++;
      }
      if (e.quotaParkedUntil > now) {
        e.quotaParkedUntil = 0;
        e.providerParked = false;
        unparked++;
      }
    }
    if (demoted > 0 || unparked > 0) {
      this.persist();
      this.emitUpdated([provider], `manually unblocked (${demoted} demoted, ${unparked} un-parked)`, 'quota');
    }
    return { demoted, unparked };
  }

  /**
   * Telemetry write-through from a real LLM call.
   * Success → verified (source 'telemetry') + lastUsedAt. Failure → errorRate
   * bump; auth failures demote to unavailable; rate-limit failures park the
   * entry WITHOUT demoting it (transient exclusion, auto-recovery after the
   * window lapses).
   *
   * @param ok        Did the call succeed?
   * @param errorType Optional classified error type ('auth' | 'rate-limit' | ...)
   */
  recordCall(
    provider: string,
    model: string,
    ok: boolean,
    errorType?: string,
    action?: string,
    latencyMs?: number,
    costUsd?: number,
    callId?: string,
    /** Provider-reported reset hint in ms (Retry-After / "try again in Ns"). */
    retryAfterMs?: number,
  ): void {
    if (isSentinelModel(model)) return; // never record calls against the sentinel
    const now = Date.now();
    const key = entryKey(provider, model);
    const existing = this.data.entries[key];

    if (ok) {
      this.markVerified(provider, model, 'telemetry', latencyMs, action, costUsd, callId);
      this.data.entries[key].lastUsedAt = now;
      // Bundle 3b: every real call is also capability evidence — how the pair held
      // up (robustness) and how fast it answered (performance). Folded HERE (the
      // single telemetry entry point) and AFTER markVerified, because markVerified
      // is what creates the row for a pair's first-ever call — folding earlier
      // would silently drop the first observation of every model. Availability is
      // not touched: this is evidence about the model, not a status write.
      this.foldCapability(provider, model, { ok, latencyMs, now });
      // P4 M4.4: a clean success heals mid-stream flakiness (the provider
      // demonstrably finishes). Decay the EMA toward 0 — never hard-reset,
      // so a single success doesn't erase a flaky streak. markVerified already
      // persisted the rebuild (which preserved partialRate), so the decayed
      // value must be persisted again to survive a restart.
      const prevPartial = this.data.entries[key].partialRate || 0;
      if (prevPartial > 0) {
        this.data.entries[key].partialRate = Math.max(0, prevPartial - 0.1);
        // Record the healed point so the dashboard sparkline shows the decay
        // (the provider demonstrably finishes → flakiness trending down).
        this.pushPartialHistory(this.data.entries[key]);
        this.persist();
      }
      return;
    }

    // Failure — update error rate.
    const prevRate = existing?.errorRate || 0;
    const entry = existing || {
      provider,
      model,
      status: 'unverified' as ModelAvailabilityStatus,
      lastVerifiedAt: 0,
      lastProbedAt: now,
      lastUsedAt: now,
      errorRate: 0,
      quotaParkedUntil: 0,
      source: 'telemetry' as ModelRegistrySource,
    };
    // EMA with a small α — a single failure shouldn't nuke a good model.
    entry.errorRate = Math.min(1, 0.2 + 0.8 * prevRate);
    entry.lastUsedAt = now;
    let flipped = false;
    if (errorType === 'auth') {
      // Auth is DEFINITIVE — the key is dead; demote permanently until the
      // user fixes it and re-probes (unblockProvider / models refresh).
      entry.status = 'unavailable';
      entry.lastError = 'auth (invalid key / forbidden)';
      flipped = true;
    } else if (errorType === 'rate-limit') {
      // Rate-limit is TRANSIENT (429 / quota window). Park the entry — the
      // park is the exclusion mechanism (isUsable() gates on quotaParkedUntil
      // and the provider feeds getBlockedProviders while parked) — but do NOT
      // flip the status to 'unavailable'. A verified model must come back
      // automatically when the window lapses; demoting it permanently was a
      // real bug: isUsable() requires status === 'verified', so rate-limited
      // cloud models (groq/gemini free tiers) stayed dead forever even after
      // the park expired, silently forcing everything onto weak local models.
      entry.lastError = 'rate-limit';
      // Honor the provider's OWN reset hint when the caller extracted one:
      // a 429 that says "resets in 16 minutes" must park ~16 minutes, not a
      // fixed window. Capped at 1h — LONGER parks are the quota ledger's job
      // (syncQuota extends from there); this registry park is only a FLOOR.
      // No hint → a SHORT 60s floor: the authoritative exclusion is the
      // ledger park, and an hour-aligned floor could OUTLIVE a short ledger
      // park (syncQuota only extends, never shrinks) and strand the provider.
      const hintMs = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : null;
      const parkMs = Math.min(60 * 60 * 1000, Math.max(10 * 1000, hintMs ?? 60_000));
      const parkUntil = now + parkMs;
      entry.quotaParkedUntil = Math.max(entry.quotaParkedUntil, parkUntil);
      // Model-specific parking (from recordCall) — providerParked=false means
      // isUsable() WILL block this verified model (correct: it was rate-limited).
      entry.providerParked = false;
      flipped = true;
    } else if (errorType === 'empty-response') {
      // fix_model_routing P1/P2 — the provider RESOLVED but carried nothing.
      // This used to be recorded as a SUCCESS (the walk had no notion of a
      // usable response), so a model that answers every turn with an empty body
      // kept `verified` and `errorRate 0` and the router kept choosing it. The
      // error-rate bump above already sinks it in scoring; the park is the hard
      // stop, and it is MODEL-scoped so the provider's healthy siblings remain
      // routable and the pair returns automatically after the window.
      entry.lastError = 'empty-response (no text, no tool call)';
      entry.quotaParkedUntil = Math.max(entry.quotaParkedUntil, now + EMPTY_RESPONSE_PARK_MS);
      entry.providerParked = false;
      flipped = true;
    } else if (errorType === 'credit-exhausted') {
      // DEFINITIVE, and NOT a cooldown (A4). The account cannot pay, so there is
      // no window to wait out — a park would expire and the router would offer
      // the pair again, which is precisely how `openrouter/deepseek-v4.1-flash`
      // kept being chosen and kept answering 402. Demoted like `auth`: it takes
      // a funded key (or `models unblock` / a re-probe) to restore.
      //
      // This is honest about WHAT failed: the check is on the PAIR because that
      // is the granularity the registry stores, but the sentence names the
      // account, not the model — a different host may serve this same model,
      // and the failover walk is free to try one.
      entry.status = 'unavailable';
      entry.lastError = 'credit-exhausted (that provider account cannot pay for this call)';
      entry.quotaParkedUntil = 0;
      entry.providerParked = false;
      flipped = true;
    }
    this.data.entries[key] = entry;
    this.persist();
    // Bundle 3b — a FAILED call is capability evidence too (robustness), and the
    // row now exists on both paths (markVerified above, or the entry built here).
    this.foldCapability(provider, model, { ok, latencyMs, now });
    if (flipped) this.emitUpdated([provider], `telemetry failure (${errorType})`, 'telemetry');
    if (action) {
      this.appendActionLog({
        timestamp: now,
        action,
        provider,
        model,
        outcome: errorType === 'auth' || errorType === 'rate-limit' ? 'unavailable' : 'error',
        errorType,
        latencyMs,
        costUsd,
        callId,
      });
    }
  }

  /**
   * P4 M4.4: record a MID-STREAM interruption (the provider started streaming
   * then died before completion) as a distinct `partial` telemetry event.
   *
   * Unlike `recordCall(ok=false)` — which flips status for definitive failures
   * and decays errorRate — a partial death is neither a clean error nor a
   * definitive kill: the provider demonstrably STARTED serving (its model is
   * real and authenticated) but couldn't FINISH. That is the exact flaky-
   * mid-stream signal the roadmap wants the router to learn from, so it is
   * recorded as a dedicated outcome in the action log WITHOUT flipping status
   * or mutating health (a partial today may complete tomorrow).
   *
   * Best-effort — never throws, never breaks the streaming call.
   *
   * @param action     The action that hit the interruption (chat / execute / ...).
   * @param errorType  Classified reason (server / timeout / network / ...).
   * @param streamedChunks  How many tokens had already streamed (context for
   *   the dashboard — the bigger the partial, the more "almost finished").
   */
  recordPartial(
    provider: string,
    model: string,
    action: string,
    errorType?: string,
    streamedChunks?: number,
  ): void {
    if (isSentinelModel(model)) return; // never record the 'default' sentinel
    try {
      this.appendActionLog({
        timestamp: Date.now(),
        action,
        provider,
        model,
        outcome: 'partial',
        errorType,
        streamedChunks,
      });
      // P4 M4.4 flakiness signal: bump the entry's mid-stream EMA so the
      // router can deprioritize providers that start-but-die. The status is
      // NEVER flipped (a partial today may complete tomorrow) — only the
      // partialRate EMA moves, so the signal is a soft reliability nudge, not
      // a hard block.
      const key = entryKey(provider, model);
      const existing = this.data.entries[key];
      if (existing) {
        const prev = existing.partialRate || 0;
        existing.partialRate = Math.min(1, prev + (1 - prev) * 0.25);
        this.pushPartialHistory(existing);
        this.persist();
      }
    } catch {
      // Best-effort — a partial telemetry write must never break streaming.
    }
  }

  /**
   * P4 M4.4: worst mid-stream flakiness (partialRate) across a provider's
   * tracked models — the router's single-number signal for "this provider
   * keeps starting streams that die." 0 = no partials recorded (or healed).
   */
  getProviderFlakiness(provider: string): number {
    let worst = 0;
    for (const [k, e] of Object.entries(this.data.entries)) {
      if (k.startsWith(provider + '|') && (e.partialRate || 0) > worst) {
        worst = e.partialRate || 0;
      }
    }
    return worst;
  }

  /**
   * Action-attributed telemetry log (model-registry-actions.jsonl) — which
   * action killed or verified which provider × model, so the dashboard's
   * "learned from real usage" panel makes predictive skips visible. Capped
   * (rotation amortized). Best-effort — never breaks telemetry.
   */
  private appendActionLog(entry: ActionTelemetryEntry): void {
    try {
      // Stamp provenance ONCE, at the single write path, so every consumer (the
      // registry API, the dashboard, a CLI report) sees the same origin.
      if (!entry.origin) entry.origin = telemetryOrigin();
      const dir = memoryDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const path = actionLogPath();
      // P6 M6.2 + M6.3: every action line is scrubbed (no secrets) and
      // hash-chained (tamper-evident). O(1) append on the hot path; the
      // amortized rotation below re-chains the surviving slice.
      appendChainedRecordFast(path, 'model-registry-actions', entry);
      this.actionLogCount = this.actionLogCount >= 0 ? this.actionLogCount + 1 : this.countActionLogLines(path);
      // Rotate when the log doubles past the cap — amortized O(1) per write.
      if (this.actionLogCount > MAX_ACTION_LOG_ENTRIES * 2) {
        const raw = readFileSync(path, 'utf-8');
        const lines = raw.split('\n').filter((l) => l.trim()).slice(-MAX_ACTION_LOG_ENTRIES);
        const rechained = rechainRecords(lines);
        writeFileSync(path, rechained.length ? `${rechained.join('\n')}\n` : '', 'utf-8');
        // Keep the sidecar head in sync with the re-chained slice.
        writeHeadState(path, 'model-registry-actions', headOfLines(rechained), rechained.length);
        this.actionLogCount = rechained.length;
      }
    } catch {
      // Best-effort — a failed action log must never break telemetry.
    }
  }

  private countActionLogLines(path: string): number {
    try {
      if (!existsSync(path)) return 0;
      return readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim()).length;
    } catch {
      return 0;
    }
  }

  /**
   * Aggregated per-action "learned from real usage" view (dashboard / CLI). Sync.
   *
   * `includeSynthetic` is for callers whose subject IS the log rather than the
   * production view — a test asserting the write path, or an operator auditing a
   * store that has test-origin rows in it. The default excludes them, because
   * the charts read this and a test process must not be able to move them.
   */
  getActionTelemetry(options: { includeSynthetic?: boolean } = {}): ActionTelemetryInsights {
    return aggregateActionTelemetry(readActionTelemetryFile(actionLogPath()), options);
  }

  /**
   * Sync quota parks AND full usage telemetry from the QuotaLedger, so the
   * registry's FAISS/JSON snapshot alone answers "is it healthy, how many
   * tokens remain, how long until the window resets". The ledger stays the
   * WRITER of usage; the registry is the enterprise READ model the router
   * consumes — one sub-ms sync store on the pick path.
   *
   * Parks are applied only when the new window actually EXTENDS the existing
   * park (no redundant writes), and the usage fields are only written when
   * they differ, so calling this on every routing decision is cheap and never
   * rewrites the mirror on a hot path.
   */
  syncQuota(configManager?: ConfigManager): void {
    try {
      const ledger = getQuotaLedger();
      const now = Date.now();
      let changed = false;
      const newlyParked = new Set<string>();
      // 1. Cooldown parks (explicit + configured-limit exhaustion) — MODEL level.
      // FIX: Only park models that are NOT verified. A verified model has proven
      // it works — blanket-parking it because a DIFFERENT model in the same
      // provider hit a rate limit is the root cause of providers being blocked
      // despite having working models (the "Gemini parking bug").
      // Mirror the ledger's cooldown state directly — the provider's own
      // reset hint (Retry-After) is the authoritative source for parking
      // duration. syncQuota's role is to reflect ledger state in the registry,
      // not to override or cap it.
      for (const { provider, cooldownRemaining } of ledger.getRouterQuotaStatus(configManager)) {
        if (cooldownRemaining <= 0) continue;
        const until = now + cooldownRemaining;
        for (const e of Object.values(this.data.entries)) {
          if (e.provider === provider && until > e.quotaParkedUntil && e.status !== 'verified') {
            e.quotaParkedUntil = until;
            e.providerParked = true;
            changed = true;
            newlyParked.add(provider);
          }
        }
      }
      // 1b. MODEL-level parks — mirror the ledger's PER-MODEL cooldowns onto the
      // EXACT entry. This is the per-model quota key end to end: one model
      // resting on its own limit must never block its siblings, so the park is
      // written with providerParked=false (model-specific) and only that entry's
      // `isUsable()` turns false — `preferredModelsFor()` still ranks the
      // provider's other models and routing serves from them. The park EXPIRES
      // by itself (quotaParkedUntil is absolute), so the model is automatically
      // re-admitted the moment its window lapses — and because a genuine success
      // clears the park (markVerified), a recovered model is picked up as soon
      // as it is used or re-probed.
      for (const { provider, model, cooldownRemaining } of ledger.getModelQuotaStatus(configManager)) {
        if (cooldownRemaining <= 0 || model === '*') continue;
        const entry = this.data.entries[entryKey(provider, model)];
        if (!entry) continue;
        const until = now + cooldownRemaining;
        if (until > entry.quotaParkedUntil) {
          entry.quotaParkedUntil = until;
          entry.providerParked = false;
          changed = true;
          newlyParked.add(provider);
        }
      }
      // 2. Full usage telemetry mirror — tokens / requests / reset / remaining.
      const limits = configManager?.getAll()?.routing?.quota || {};
      for (const s of ledger.getStatus(configManager)) {
        const entry = this.data.entries[entryKey(s.provider, s.model)];
        if (!entry) continue;
        if (entry.tokensConsumed !== s.tokensConsumed) {
          entry.tokensConsumed = s.tokensConsumed;
          changed = true;
        }
        if (entry.requests !== s.requests) {
          entry.requests = s.requests;
          changed = true;
        }
        if (entry.resetsInMs !== s.resetsInMs) {
          entry.resetsInMs = s.resetsInMs;
          changed = true;
        }
        const tokenLimit = limits[s.provider]?.tokensPerWindow;
        const remaining = tokenLimit !== undefined ? Math.max(0, tokenLimit - s.tokensConsumed) : -1;
        if (entry.remainingTokens !== remaining) {
          entry.remainingTokens = remaining;
          changed = true;
        }
      }
      // 3. RECOVERY WAKE-UP: an entry whose park has LAPSED is already routable
      // again (quotaParkedUntil is absolute and `isUsable()` gates on it), but
      // nothing told the watcher or the dashboard it RECOVERED. Emit once per
      // lapse so the event-driven re-verification re-probes the healed model
      // (proving it really serves again instead of trusting a stale entry) and
      // the dashboard's quota view refreshes — "keep checking models that are
      // available again, and keep the ledger/dashboard current".
      const recovered = new Set<string>();
      for (const e of Object.values(this.data.entries)) {
        if (e.quotaParkedUntil > 0 && e.quotaParkedUntil <= now) {
          e.quotaParkedUntil = 0;
          e.providerParked = false;
          changed = true;
          recovered.add(e.provider);
        }
      }

      if (changed) {
        this.persist();
        // Mirror-applied parks are state changes too — report them the same way
        // parkProvider does, so the watcher re-verifies an exhausted provider
        // immediately instead of waiting for its next scheduled cycle.
        for (const provider of newlyParked) {
          this.emitUpdated([provider], 'quota-parked (window exhausted)', 'quota');
        }
        for (const provider of recovered) {
          this.emitUpdated([provider], 'quota park lapsed — re-admitted', 'quota');
        }
      }
    } catch {
      // Best-effort — quota sync must never break the registry.
    }
  }

  /**
   * UNIFIED router feed: providers that must sink below healthy candidates
   * because they are quota-exhausted or in cooldown — computed from the
   * registry's own mirrored data (sub-ms, no I/O) with a cheap union fallback
   * to the in-memory ledger for providers the registry has never tracked (so
   * an exhausted-but-unprobed provider is still excluded). Shape mirrors
   * `circuitBreakerStatus` so the AutoModelRouter consumes it identically.
   * The ledger remains the WRITER of usage; the registry is the primary READ
   * model — the union is a same-process in-memory read, never disk or network.
   */
  getRouterQuotaStatus(configManager?: ConfigManager): Array<{ provider: string; cooldownRemaining: number }> {
    try {
      this.syncQuota(configManager); // fresh mirror first (cheap, no-op when unchanged)
    } catch {
      // Best-effort — routing must never crash on quota bookkeeping.
    }
    const now = Date.now();
    const parked = new Map<string, number>();
    for (const e of Object.values(this.data.entries)) {
      if (e.quotaParkedUntil > now) {
        const remaining = e.quotaParkedUntil - now;
        const current = parked.get(e.provider) ?? 0;
        if (remaining > current) parked.set(e.provider, remaining);
      }
    }
    // Providers the ledger parked but the registry has no entries for (never
    // probed/used) must still be excluded — union the ledger feed.
    try {
      for (const { provider, cooldownRemaining } of getQuotaLedger().getRouterQuotaStatus(configManager)) {
        if (cooldownRemaining <= 0) continue;
        const current = parked.get(provider) ?? 0;
        if (cooldownRemaining > current) parked.set(provider, cooldownRemaining);
      }
    } catch {
      // Best-effort.
    }
    return [...parked.entries()].map(([provider, cooldownRemaining]) => ({ provider, cooldownRemaining }));
  }

  /**
   * Emit a MODEL_REGISTRY_UPDATED event so the watch daemon (the dedicated
   * model-health agent) learns about a mid-session state change IMMEDIATELY
   * and can re-verify the affected provider instead of waiting for its next
   * scheduled cycle. Best-effort — observability must never break the registry.
   *
   * @param source Who wrote the change: 'telemetry' (real session usage),
   *   'quota' (parks/releases), or 'probe' / 'spot-check' (the watcher's OWN
   *   writes). The watcher only reacts to telemetry/quota — it ignores its own
   *   probe writes so its re-verification can't self-trigger an infinite loop.
   */
  private emitUpdated(providers: string[], detail: string, source: string): void {
    try {
      getEventBus().emit(EventNames.MODEL_REGISTRY_UPDATED, {
        providers,
        blocked: this.getBlockedProviders(),
        updatedAt: Date.now(),
        detail,
        source,
      }, 'model-registry');
    } catch {
      // Best-effort — event emission must never break the registry.
    }
  }

  /**
   * Demote verified entries that haven't been re-verified recently to
   * `unverified` (they may have been retired / access revoked). Returns the
   * number demoted. Called by the watch daemon and refresh.
   */
  pruneStale(maxAgeMs: number = DEFAULT_STALE_MS): number {
    const now = Date.now();
    let demoted = 0;
    for (const e of Object.values(this.data.entries)) {
      if (e.status === 'verified' && now - e.lastVerifiedAt > maxAgeMs) {
        e.status = 'unverified';
        e.lastError = 'stale (not verified recently)';
        demoted++;
      }
    }
    if (demoted > 0) this.persist();
    return demoted;
  }

  /**
   * ISSUE-004 (4c): clean up entries for models that no longer exist on the
   * LOCAL system. When the user deletes a model (e.g. `ollama rm modelname`),
   * the registry was still holding its entry and every probe/stats pass kept
   * re-checking a model that's gone — the "deleted model is still checked every
   * time" feedback.
   *
   * Only call this with an AUTHORITATIVE live list (the refresh probe of a
   * keyless/local runner). Entries whose model is NOT in the list are handled:
   *   - UNVERIFIED / UNAVAILABLE entries are DELETED entirely (never checked
   *     again — they have no learned value worth keeping), EXCEPT an entry whose
   *     unavailability is an ACCOUNT-level refusal (`isEntitlementFailure`): that
   *     one is the only record that this key cannot pay or is not authorized, so
   *     deleting it loses the verdict and the next model listing re-creates the
   *     pair as `unverified` — re-arming exactly the pin A2 exists to refuse.
   *   - VERIFIED entries are DEMOTED to `unavailable` with reason "model
   *     deleted from local system" instead of being hard-deleted — a partial
   *     listModels response (a model mid-pull, a gateway hiccup) must not
   *     silently destroy the learned latency/token telemetry of a model that
   *     may merely be temporarily unlisted. The demote keeps it out of routing
   *     while preserving its history for re-verification.
   *
   * Returns the number of entries cleaned up (deleted + demoted). Best-effort
   * — never throws.
   */
  pruneAbsentModels(provider: string, liveModels: string[]): number {
    const live = new Set(liveModels);
    const removedKeys: string[] = [];
    const demotedKeys: string[] = [];
    for (const [key, e] of Object.entries(this.data.entries)) {
      if (e.provider !== provider || live.has(e.model)) continue;
      if (e.status === 'verified') demotedKeys.push(key);
      // Absence from a model list is evidence about the CATALOGUE, not about the
      // account. Deleting an entitlement verdict hands the pair straight back to
      // the next `markListed` as a fresh `unverified` entry (observed live: the
      // `credit-exhausted` verdict on `openrouter/deepseek/deepseek-v4.1-flash`
      // was gone after a refresh, so the strict pre-flight stopped firing and a
      // run that had refused before any call sent the request and got a raw 402).
      else if (isEntitlementFailure(e.lastError)) continue;
      else removedKeys.push(key);
    }
    const now = Date.now();
    for (const k of demotedKeys) {
      const e = this.data.entries[k];
      e.status = 'unavailable';
      e.lastError = 'model deleted from local system';
      e.lastProbedAt = now;
    }
    for (const k of removedKeys) delete this.data.entries[k];
    const touched = demotedKeys.length + removedKeys.length;
    if (touched > 0) {
      this.persist();
      this.emitUpdated([provider], `pruned ${touched} deleted local model(s)`, 'probe');
    }
    return touched;
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  /** Load the JSON mirror synchronously (never throws). */
  private loadMirror(): ModelRegistryData {
    try {
      if (!existsSync(mirrorPath())) return emptyState();
      const raw = readFileSync(mirrorPath(), 'utf-8');
      const data = JSON.parse(raw) as ModelRegistryData;
      if (!data || typeof data !== 'object' || !data.entries) return emptyState();
      return { ...emptyState(), ...data };
    } catch {
      return emptyState();
    }
  }

  /**
   * Re-read the JSON mirror into memory — adopt what OTHER processes learned.
   *
   * The singleton loads the mirror exactly ONCE, in the constructor, and
   * {@link persist} writes the WHOLE entry map from `this.data`. Those two facts
   * together mean a long-lived process holds a snapshot of every model it never
   * touched, and flushes that snapshot back over the file the moment it persists
   * anything — silently reverting anything another process (the gateway, a CLI
   * run, the warmup daemon) verified in the meantime.
   *
   * Callers that are about to spend a probe budget and persist should reload
   * first so that `this.data` is as current as the file allows. The window does
   * not close — a write from another process DURING a long run is still lost on
   * this process's next persist — but it shrinks from "since this process booted"
   * to "since this run started".
   *
   * DISCARDING, deliberately: this drops any in-memory change this process has
   * made but not yet persisted. Every mutator on this class persists immediately,
   * so there is normally nothing pending — but that is the contract that makes
   * this safe, and it is why this is not called from arbitrary paths.
   */
  reloadFromMirror(): void {
    this.data = this.loadMirror();
    this.bootSnapshot = cloneRegistryData(this.data);
  }

  /**
   * Persist: JSON mirror synchronously (canonical, guaranteed), then mirror to
   * the VectorStore namespace asynchronously (best-effort, auto-tiers to JSON
   * when FAISS/native aren't installed — so it can never throw).
   */
  private persist(opts: { replace?: boolean } = {}): void {
    this.data.updatedAt = Date.now();
    const dir = memoryDir();
    const path = mirrorPath();
    try {
      mkdirSync(dir, { recursive: true });
      // The read-merge-write runs UNDER the lock, so two processes cannot
      // interleave it: the second one to run re-reads what the first wrote and
      // merges rather than overwriting. `writeFileAtomicSync` then makes the
      // publication all-or-nothing, so a concurrent READER can never parse a
      // half-written file (which every loader here turns into an empty state
      // that the next persist would write back).
      const merged = withFileLockSync(`${path}.lock`, () => {
        // A deliberate wipe (`reset`) must not adopt a peer's concurrent row —
        // the operator asked for an empty registry, so it is written as-is.
        const next = opts.replace
          ? this.data
          : mergeRegistryMirror(this.bootSnapshot, this.data, this.loadMirror());
        writeFileAtomicSync(path, JSON.stringify(next, null, 2));
        return next;
      });
      // Adopt the merge, and re-baseline: this process's view is now the file's,
      // so the NEXT persist compares against it instead of against boot.
      this.data = merged.value;
      this.bootSnapshot = cloneRegistryData(this.data);
    } catch {
      // Best-effort — a failed mirror write must never break routing.
    }
    this.mirrorToVector(dir);
  }

  /**
   * Synchronous mirror to the vector-store namespace file.
   *
   * Writes the snapshot directly into the SHARED `vectors-model-registry.json`
   * file — the exact on-disk entry format every VectorStore backend (JSON,
   * pure-JS IVF, native FAISS) reads via `readNamespaceEntries`. This is
   * deliberately SYNCHRONOUS and pinned to the persist-time dir: an async
   * fire-and-forget write resolves its path lazily after awaits, so a dangling
   * promise from an earlier test would write to whatever NUVIRA_MEMORY_DIR is at
   * that later moment (the real ~/.nuvira/memory) and leak test data. A sync
   * write has no such race and is equally best-effort (never throws).
   */
  private mirrorToVector(dir: string): void {
    try {
      const indexPath = join(dir, 'vectors-model-registry.json');
      mkdirSync(dir, { recursive: true });
      // Same cross-process shape as `persist()`: the read-merge-write is one
      // critical section, and the publication is atomic. Two processes mirroring
      // this namespace concurrently would otherwise drop each other's snapshot.
      withFileLockSync(`${indexPath}.lock`, () => {
        let entries: Record<string, VectorEntry> = {};
        try {
          if (existsSync(indexPath)) {
            const raw = JSON.parse(readFileSync(indexPath, 'utf-8')) as {
              entries?: Record<string, VectorEntry>;
            };
            if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') {
              entries = raw.entries;
            }
          }
        } catch {
          // Corrupt/missing file — start from an empty index.
        }
        entries[VECTOR_SNAPSHOT_ID] = {
          id: VECTOR_SNAPSHOT_ID,
          vector: [1], // 1-dim placeholder — we never search, only store.
          metadata: { snapshot: this.data },
          createdAt: Date.now(),
        };
        writeFileAtomicSync(indexPath, JSON.stringify({ entries, version: 2 }, null, 2));
      });
      this.vectorMirrored = true;
    } catch {
      this.vectorMirrored = false;
    }
  }

  /** Load the vector-store mirror into memory if it's newer than the JSON file. */
  async hydrateFromVector(): Promise<boolean> {
    try {
      const store = getVectorStore(VECTOR_NAMESPACE);
      const entry = await store.get(VECTOR_SNAPSHOT_ID);
      const meta = entry?.metadata as { snapshot?: ModelRegistryData } | undefined;
      const snapshot = meta?.snapshot;
      if (snapshot && typeof snapshot === 'object' && snapshot.entries && snapshot.updatedAt > this.data.updatedAt) {
        this.data = { ...emptyState(), ...snapshot };
        this.vectorMirrored = true;
        return true;
      }
      this.vectorMirrored = true;
      return false;
    } catch {
      return false;
    }
  }

  // ─── Diagnostics ──────────────────────────────────────────────────────────

  /** Name of the vector backend in use ('json' | 'faiss-ivf' | 'faiss-native' | 'unavailable'). */
  async vectorBackendName(): Promise<string> {
    try {
      if (!this.vectorStore) this.vectorStore = getVectorStore(VECTOR_NAMESPACE);
      return await this.vectorStore.backendName();
    } catch {
      return 'unavailable';
    }
  }

  /** Full status snapshot (CLI `models status` / dashboard). */
  async getStatus(): Promise<ModelRegistryStatus> {
    const entries = Object.values(this.data.entries);
    const now = Date.now();
    const byProvider = new Map<string, ModelRegistryEntry[]>();
    for (const e of entries) {
      if (!byProvider.has(e.provider)) byProvider.set(e.provider, []);
      byProvider.get(e.provider)!.push(e);
    }
    const providers = [...byProvider.entries()]
      .map(([provider, models]) => {
        models.sort((a, b) => a.model.localeCompare(b.model));
        return {
          provider,
          total: models.length,
          verified: models.filter((m) => m.status === 'verified' && m.quotaParkedUntil <= now).length,
          unavailable: models.filter((m) => m.status === 'unavailable').length,
          parked: models.filter((m) => m.quotaParkedUntil > now).length,
          models,
        };
      })
      .sort((a, b) => a.provider.localeCompare(b.provider));

    return {
      backend: await this.vectorBackendName(),
      vectorMirrored: this.vectorMirrored,
      total: entries.length,
      verified: entries.filter((e) => e.status === 'verified' && e.quotaParkedUntil <= now).length,
      unverified: entries.filter((e) => e.status === 'unverified').length,
      unavailable: entries.filter((e) => e.status === 'unavailable').length,
      parked: entries.filter((e) => e.quotaParkedUntil > now).length,
      updatedAt: this.data.updatedAt,
      providers,
    };
  }

  /** Human-readable summary for the CLI (incl. quota telemetry from the unified store). */
  async formatStatus(): Promise<string> {
    const s = await this.getStatus();
    const now = Date.now();
    const lines: string[] = [];
    lines.push(`📦 Model Registry — backend: ${s.backend}${s.vectorMirrored ? ' (vector-mirrored)' : ''}`);
    lines.push(`   ${s.total} tracked · ${s.verified} verified · ${s.unverified} unverified · ${s.unavailable} unavailable · ${s.parked} quota-parked`);
    for (const p of s.providers) {
      const verified = p.models.filter((m) => m.status === 'verified');
      const unavailable = p.models.filter((m) => m.status === 'unavailable');
      lines.push(`   ${p.provider}: ${p.verified} verified · ${p.unavailable} unavailable${p.parked ? ` · ${p.parked} parked` : ''}`);
      for (const m of verified) {
        const lat = m.latencyMs !== undefined ? ` · ${m.latencyMs}ms` : '';
        // P4 M4.4 flakiness trend: when a trajectory exists, surface whether
        // the model is HEALING (clean successes decay the EMA) or WORSENING
        // (more mid-stream interruptions) — one glance at `models status`.
        let flaky = '';
        if (m.partialRate !== undefined && m.partialRate > 0) {
          const pct = Math.round(m.partialRate * 100);
          const h = m.partialHistory;
          if (h && h.length >= 2) {
            const first = h[0].rate;
            const last = h[h.length - 1].rate;
            if (last < first) flaky = ` · ⏸ flaky ${pct}% healing`;
            else if (last > first) flaky = ` · ⏸ flaky ${pct}% worsening`;
            else flaky = ` · ⏸ flaky ${pct}%`;
          } else {
            flaky = ` · ⏸ flaky ${pct}%`;
          }
        }
        // Unified-store quota telemetry: remaining tokens + time-to-wait (resets
        // in) come from the same sub-ms FAISS/JSON snapshot routing reads.
        const tokens = m.remainingTokens !== undefined && m.remainingTokens >= 0
          ? ` · ${formatCount(m.remainingTokens)} tokens left`
          : '';
        const resets = m.resetsInMs !== undefined && m.resetsInMs > 0
          ? ` · resets in ${this.formatMs(m.resetsInMs)}`
          : '';
        lines.push(`     ✅ ${m.model}${lat}${flaky}${tokens}${resets}`);
      }
      for (const m of unavailable.slice(0, 3)) {
        const wait = m.quotaParkedUntil > now ? ` · retry in ${this.formatMs(m.quotaParkedUntil - now)}` : '';
        lines.push(`     ⛔ ${m.model} — ${m.lastError || 'unavailable'}${wait}`);
      }
    }
    return lines.join('\n');
  }

  /** Compact human duration (e.g. '3h 12m', '45s'). */
  private formatMs(ms: number): string {
    if (ms <= 0) return 'now';
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${Math.ceil(ms / 1000)}s`;
  }

  /** Clear the registry (CLI / tests). */
  reset(): void {
    this.data = emptyState();
    // Also overwrites the vector snapshot with the empty state.
    this.persist({ replace: true });
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let registryInstance: ModelRegistry | null = null;

/** Get or create the ModelRegistry singleton. */
export function getModelRegistry(): ModelRegistry {
  if (!registryInstance) {
    registryInstance = new ModelRegistry();
  }
  return registryInstance;
}

/** Reset the singleton (tests + after vector-backend changes). */
export function resetModelRegistry(): void {
  registryInstance = null;
}
