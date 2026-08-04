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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { getVectorStore, type VectorStore, type VectorEntry } from '../memory/vector-store.js';
import { getQuotaLedger } from './quota-ledger.js';
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

// ─── Storage ────────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_DIR = join(homedir(), '.buff', 'memory');
const CURRENT_VERSION = 1;
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

function entryKey(provider: string, model: string): string {
  return `${provider}|${model || 'default'}`;
}

function emptyState(): ModelRegistryData {
  return { version: CURRENT_VERSION, entries: {}, updatedAt: Date.now() };
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
   */
  markVerified(provider: string, model: string, source: ModelRegistrySource, latencyMs?: number): void {
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
      quotaParkedUntil: existing?.quotaParkedUntil || 0,
      source,
      lastError: existing?.lastError,
    };
    this.persist();
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
    };
    this.persist();
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
    if (touched) this.persist();
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
    if (touched) this.persist();
  }

  /**
   * Telemetry write-through from a real LLM call.
   * Success → verified (source 'telemetry') + lastUsedAt. Failure → errorRate
   * bump; auth/rate-limit failures optionally park/mark-unavailable.
   *
   * @param ok        Did the call succeed?
   * @param errorType Optional classified error type ('auth' | 'rate-limit' | ...)
   */
  recordCall(provider: string, model: string, ok: boolean, errorType?: string): void {
    const now = Date.now();
    const key = entryKey(provider, model);
    const existing = this.data.entries[key];

    if (ok) {
      this.markVerified(provider, model, 'telemetry');
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
    if (errorType === 'auth' || errorType === 'rate-limit') {
      entry.status = 'unavailable';
      entry.lastError = errorType === 'auth' ? 'auth (invalid key / forbidden)' : 'rate-limit';
      if (errorType === 'rate-limit') {
        // Park until the likely reset window (aligned to the hour).
        const parkUntil = now + (60 - new Date().getMinutes()) * 60_000;
        entry.quotaParkedUntil = Math.max(entry.quotaParkedUntil, parkUntil);
      }
    }
    this.data.entries[key] = entry;
    this.persist();
  }

  /** Sync quota parks from the QuotaLedger's router feed. */
  syncQuota(configManager?: ConfigManager): void {
    try {
      const parked = getQuotaLedger().getRouterQuotaStatus(configManager);
      const now = Date.now();
      for (const { provider, cooldownRemaining } of parked) {
        if (cooldownRemaining > 0) this.parkProvider(provider, now + cooldownRemaining);
      }
    } catch {
      // Best-effort — quota sync must never break the registry.
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

  /** Human-readable summary for the CLI. */
  async formatStatus(): Promise<string> {
    const s = await this.getStatus();
    const lines: string[] = [];
    lines.push(`📦 Model Registry — backend: ${s.backend}${s.vectorMirrored ? ' (vector-mirrored)' : ''}`);
    lines.push(`   ${s.total} tracked · ${s.verified} verified · ${s.unverified} unverified · ${s.unavailable} unavailable · ${s.parked} quota-parked`);
    for (const p of s.providers) {
      const verified = p.models.filter((m) => m.status === 'verified');
      const unavailable = p.models.filter((m) => m.status === 'unavailable');
      lines.push(`   ${p.provider}: ${p.verified} verified · ${p.unavailable} unavailable${p.parked ? ` · ${p.parked} parked` : ''}`);
      for (const m of verified) {
        const lat = m.latencyMs !== undefined ? ` · ${m.latencyMs}ms` : '';
        lines.push(`     ✅ ${m.model}${lat}`);
      }
      for (const m of unavailable.slice(0, 3)) {
        lines.push(`     ⛔ ${m.model} — ${m.lastError || 'unavailable'}`);
      }
    }
    return lines.join('\n');
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
