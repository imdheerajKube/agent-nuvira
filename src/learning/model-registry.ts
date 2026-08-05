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
 * - A **canonical JSON mirror** (`~/.buff/memory/model-registry.json`) is the
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
 *      updates, auth/rate-limit failures mark unavailable / park quota
 *
 * Quota integration: `syncQuota()` reads the QuotaLedger's router feed and
 * applies `quotaParkedUntil` to every entry of a parked provider, so a token-
 * exhausted provider is excluded predictively (same source the AutoModelRouter
 * already consumes).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { getVectorStore, type VectorStore, type VectorEntry } from '../memory/vector-store.js';
import { getQuotaLedger } from './quota-ledger.js';
import { getEventBus, EventNames } from '../observability/event-bus.js';
import type { ConfigManager } from '../config/manager.js';

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
  /** Rolling error rate 0–1 (telemetry failures / calls). */
  errorRate: number;
  /** Epoch ms until which the entry is quota-parked (0 = not parked). */
  quotaParkedUntil: number;
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
  outcome: 'verified' | 'unavailable' | 'error';
  /** Classified reason when outcome is unavailable/error (auth / rate-limit / model not found / ...). */
  errorType?: string;
}

/** Aggregated "learned from real usage" view — per action (dashboard panel). */
export interface ActionTelemetryInsights {
  enabled: boolean;
  /** Total logged events (capped at MAX_ACTION_LOG_ENTRIES). */
  total: number;
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
    /** Provider × model combos this action verified (latest event each). */
    verifiedModels: Array<{ provider: string; model: string; at: number }>;
    /** Provider × model combos this action killed (latest event each). */
    killedModels: Array<{ provider: string; model: string; reason?: string; at: number }>;
    /**
     * Daily buckets over the last TIMELINE_DAYS — verified vs killed vs
     * transient counts per day (ascending), so the dashboard can render a
     * "learned from real usage over time" sparkline/bar chart per action.
     * Each bucket also carries the RAW events that landed that day, so the
     * chart can be scrubbed day-by-day to show that day's exact chips
     * (which provider × model the action killed or verified).
     */
    timeline: Array<{
      /** Start of the UTC day bucket (epoch ms). */
      day: number;
      verified: number;
      killed: number;
      transient: number;
      /** Raw events that day — the chips the scrubbable chart shows per day. */
      events: Array<{
        provider: string;
        model: string;
        outcome: 'verified' | 'unavailable' | 'error';
        errorType?: string;
        /** Epoch ms of the event. */
        at: number;
      }>;
    }>;
  }>;
}

// ─── Storage ────────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_DIR = join(homedir(), '.buff', 'memory');
const CURRENT_VERSION = 1;
/** Action-telemetry JSONL log — which action killed/verified which provider × model. */
export const ACTION_LOG_FILENAME = 'model-registry-actions.jsonl';
/** Keep at most this many action-log lines (rotated, newest kept). */
export const MAX_ACTION_LOG_ENTRIES = 2000;
/** Days of per-action daily buckets included in the telemetry timeline. */
export const TIMELINE_DAYS = 14;
/** VectorStore namespace that holds the enterprise mirror of the registry. */
const VECTOR_NAMESPACE = 'model-registry';
/** Single vector id holding the whole registry snapshot (1-dim — we never search). */
const VECTOR_SNAPSHOT_ID = 'snapshot';
/** Verified entries older than this are demoted to `unverified` on prune. */
export const DEFAULT_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function memoryDir(): string {
  return process.env.BUFF_MEMORY_DIR || DEFAULT_MEMORY_DIR;
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

function emptyState(): ModelRegistryData {
  return { version: CURRENT_VERSION, entries: {}, updatedAt: Date.now() };
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
    /** Deduped by provider × model × outcome — latest event wins. */
    events: Map<string, Event>;
  };
  const buckets = new Map<number, Bucket>();
  for (let i = days - 1; i >= 0; i--) {
    const day = startOfToday - i * DAY_MS;
    buckets.set(day, { verified: 0, killed: 0, transient: 0, events: new Map() });
  }
  for (const e of entries) {
    const day = new Date(e.timestamp).setUTCHours(0, 0, 0, 0);
    const bucket = buckets.get(day);
    if (!bucket) continue; // older than the window — totals still count it
    if (e.outcome === 'verified') bucket.verified++;
    else if (e.outcome === 'unavailable') bucket.killed++;
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
    });
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, counts]) => ({
      day,
      verified: counts.verified,
      killed: counts.killed,
      transient: counts.transient,
      events: [...counts.events.values()],
    }));
}

export function aggregateActionTelemetry(entries: ActionTelemetryEntry[]): ActionTelemetryInsights {
  const byAction = new Map<string, ActionTelemetryEntry[]>();
  for (const e of entries) {
    const list = byAction.get(e.action);
    if (list) list.push(e);
    else byAction.set(e.action, [e]);
  }
  const actions = [...byAction.entries()]
    .map(([action, evs]) => {
      const verifiedEvents = evs.filter((e) => e.outcome === 'verified');
      const killedEvents = evs.filter((e) => e.outcome === 'unavailable');
      const transientEvents = evs.filter((e) => e.outcome === 'error');
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
        verifiedModels: latest(verifiedEvents).map((e) => ({ provider: e.provider, model: e.model, at: e.timestamp })),
        killedModels: latest(killedEvents).map((e) => ({ provider: e.provider, model: e.model, reason: e.errorType, at: e.timestamp })),
        timeline: buildActionTimeline(evs),
      };
    })
    .sort((a, b) => a.action.localeCompare(b.action));
  return {
    enabled: actions.length > 0,
    total: entries.length,
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
  /** Cached VectorStore for the enterprise mirror (null until first mirror). */
  private vectorStore: VectorStore | null = null;
  /** Whether the vector mirror has been confirmed usable. */
  private vectorMirrored = false;
  /** Lines in the action-telemetry JSONL log (-1 = not yet counted). */
  private actionLogCount = -1;

  constructor() {
    this.data = this.loadMirror();
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
    if (e.quotaParkedUntil > now) return false;
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
      .sort((a, b) => b.lastVerifiedAt - a.lastVerifiedAt)
      .map((e) => e.model);
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

  /** Get the raw entry (for diagnostics). Sync. */
  getEntry(provider: string, model: string): ModelRegistryEntry | undefined {
    return this.data.entries[entryKey(provider, model)];
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
    // No curated pick usable — any verified model works.
    const verified = this.getVerifiedModels(provider, now);
    return verified.length > 0 ? verified[0] : undefined;
  }

  // ─── Writes (probe / spot-check / telemetry) ──────────────────────────────

  /**
   * listModels probe: mark the model as seen (unverified unless already
   * verified). Does NOT downgrade a verified entry — real verification wins.
   */
  markListed(provider: string, models: string[]): void {
    const now = Date.now();
    for (const model of models) {
      const key = entryKey(provider, model);
      const existing = this.data.entries[key];
      if (existing && existing.status === 'verified') {
        existing.lastProbedAt = now;
        continue;
      }
      this.data.entries[key] = {
        provider,
        model,
        status: 'unverified',
        lastVerifiedAt: existing?.lastVerifiedAt || 0,
        lastProbedAt: now,
        lastUsedAt: existing?.lastUsedAt || 0,
        latencyMs: existing?.latencyMs,
        errorRate: existing?.errorRate || 0,
        quotaParkedUntil: existing?.quotaParkedUntil || 0,
        source: 'probe',
        lastError: existing?.lastError,
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
  markVerified(provider: string, model: string, source: ModelRegistrySource, latencyMs?: number, action?: string): void {
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
      errorRate: existing?.errorRate || 0,
      // Verified ⇒ serving right now ⇒ not parked (syncQuota re-parks real exhaustion).
      quotaParkedUntil: 0,
      source,
      lastError: existing?.lastError,
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
      this.appendActionLog({ timestamp: now, action, provider, model, outcome: 'verified' });
    }
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
      quotaParkedUntil: Math.max(existing?.quotaParkedUntil || 0, quotaParkedUntil),
      source,
      lastError: reason,
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

  /** Apply the quota ledger's parked-provider status to all of a provider's entries. */
  parkProvider(provider: string, until: number): void {
    const now = Date.now();
    let touched = false;
    for (const e of Object.values(this.data.entries)) {
      if (e.provider === provider && until > now) {
        e.quotaParkedUntil = Math.max(e.quotaParkedUntil, until);
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
        touched = true;
      }
    }
    if (touched) {
      this.persist();
      this.emitUpdated([provider], 'quota park released', 'quota');
    }
  }

  /**
   * Manual escape hatch — `buff models unblock <provider>`.
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
   * bump; auth/rate-limit failures optionally park/mark-unavailable.
   *
   * @param ok        Did the call succeed?
   * @param errorType Optional classified error type ('auth' | 'rate-limit' | ...)
   */
  recordCall(provider: string, model: string, ok: boolean, errorType?: string, action?: string): void {
    const now = Date.now();
    const key = entryKey(provider, model);
    const existing = this.data.entries[key];

    if (ok) {
      this.markVerified(provider, model, 'telemetry', undefined, action);
      this.data.entries[key].lastUsedAt = now;
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
    if (errorType === 'auth' || errorType === 'rate-limit') {
      entry.status = 'unavailable';
      entry.lastError = errorType === 'auth' ? 'auth (invalid key / forbidden)' : 'rate-limit';
      flipped = true;
      if (errorType === 'rate-limit') {
        // Park until the likely reset window (aligned to the hour).
        const parkUntil = now + (60 - new Date().getMinutes()) * 60_000;
        entry.quotaParkedUntil = Math.max(entry.quotaParkedUntil, parkUntil);
      }
    }
    this.data.entries[key] = entry;
    this.persist();
    if (flipped) this.emitUpdated([provider], `telemetry failure (${errorType})`, 'telemetry');
    if (action) {
      this.appendActionLog({
        timestamp: now,
        action,
        provider,
        model,
        outcome: errorType === 'auth' || errorType === 'rate-limit' ? 'unavailable' : 'error',
        errorType,
      });
    }
  }

  /**
   * Action-attributed telemetry log (model-registry-actions.jsonl) — which
   * action killed or verified which provider × model, so the dashboard's
   * "learned from real usage" panel makes predictive skips visible. Capped
   * (rotation amortized). Best-effort — never breaks telemetry.
   */
  private appendActionLog(entry: ActionTelemetryEntry): void {
    try {
      const dir = memoryDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const path = actionLogPath();
      appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf-8');
      if (this.actionLogCount >= 0) {
        this.actionLogCount++;
      } else {
        this.actionLogCount = this.countActionLogLines(path);
      }
      // Rotate when the log doubles past the cap — amortized O(1) per write.
      if (this.actionLogCount > MAX_ACTION_LOG_ENTRIES * 2) {
        const raw = readFileSync(path, 'utf-8');
        const lines = raw.split('\n').filter((l) => l.trim()).slice(-MAX_ACTION_LOG_ENTRIES);
        writeFileSync(path, lines.length ? `${lines.join('\n')}\n` : '', 'utf-8');
        this.actionLogCount = lines.length;
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

  /** Aggregated per-action "learned from real usage" view (dashboard / CLI). Sync. */
  getActionTelemetry(): ActionTelemetryInsights {
    return aggregateActionTelemetry(readActionTelemetryFile(actionLogPath()));
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
      // 1. Cooldown parks (explicit + configured-limit exhaustion) — provider level.
      for (const { provider, cooldownRemaining } of ledger.getRouterQuotaStatus(configManager)) {
        if (cooldownRemaining <= 0) continue;
        const until = now + cooldownRemaining;
        for (const e of Object.values(this.data.entries)) {
          if (e.provider === provider && until > e.quotaParkedUntil) {
            e.quotaParkedUntil = until;
            changed = true;
            newlyParked.add(provider);
          }
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
      if (changed) {
        this.persist();
        // Mirror-applied parks are state changes too — report them the same way
        // parkProvider does, so the watcher re-verifies an exhausted provider
        // immediately instead of waiting for its next scheduled cycle.
        for (const provider of newlyParked) {
          this.emitUpdated([provider], 'quota-parked (window exhausted)', 'quota');
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
   * Persist: JSON mirror synchronously (canonical, guaranteed), then mirror to
   * the VectorStore namespace asynchronously (best-effort, auto-tiers to JSON
   * when FAISS/native aren't installed — so it can never throw).
   */
  private persist(): void {
    this.data.updatedAt = Date.now();
    const dir = memoryDir();
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(mirrorPath(), JSON.stringify(this.data, null, 2), 'utf-8');
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
   * promise from an earlier test would write to whatever BUFF_MEMORY_DIR is at
   * that later moment (the real ~/.buff/memory) and leak test data. A sync
   * write has no such race and is equally best-effort (never throws).
   */
  private mirrorToVector(dir: string): void {
    try {
      const indexPath = join(dir, 'vectors-model-registry.json');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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
      writeFileSync(indexPath, JSON.stringify({ entries, version: 2 }, null, 2), 'utf-8');
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
        // Unified-store quota telemetry: remaining tokens + time-to-wait (resets
        // in) come from the same sub-ms FAISS/JSON snapshot routing reads.
        const tokens = m.remainingTokens !== undefined && m.remainingTokens >= 0
          ? ` · ${m.remainingTokens.toLocaleString()} tokens left`
          : '';
        const resets = m.resetsInMs !== undefined && m.resetsInMs > 0
          ? ` · resets in ${this.formatMs(m.resetsInMs)}`
          : '';
        lines.push(`     ✅ ${m.model}${lat}${tokens}${resets}`);
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
    this.persist(); // persist() also overwrites the vector snapshot with the empty state.
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
