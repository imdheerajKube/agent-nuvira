/**
 * ResilientCallLLM — Smart proxy that wraps the auto-router and provides
 * automatic failover for ANY LLM call, anywhere in the codebase.
 *
 * Problem it solves:
 * - Tools, skills, sub-agents, memory all receive a FIXED callLLM bound to
 *   one provider at task start. If that provider fails mid-execution, the
 *   tool just fails.
 * - The 3-candidate cap in chat.ts means only 3 providers are tried.
 * - Session failures aren't persisted across pipelines.
 *
 * Solution:
 * - callLLM becomes a smart proxy that internally re-routes on ANY failure
 * - Tries ALL ranked candidates (no cap)
 * - Tracks failures across the entire session (not just per-task)
 * - Tools/sub-agents use it transparently — they don't know failover happens
 *
 * Usage:
 *   const callLLM = createResilientCallLLM(task, configManager, options);
 *   // Now callLLM automatically re-routes on failure
 *   const result = await callLLM("Implement JWT auth");
 *
 * Integration:
 *   - Orchestrator: replace createAutoRoutedLLM with createResilientCallLLM
 *   - Chat: replace buildToolCallModel's tryGenerate with resilient wrapper
 *   - Tools: ctx.callLLM is already resilient (inherited from orchestrator)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { formatCount } from '../utils/format.js';
import { join } from 'node:path';
import { resolveNuviraConfigDir, resolveNuviraDataPath } from '../config/paths.js';
import { getAutoRouter, type AutoRouteResult, type ScoredProvider } from './auto-router.js';
import { analyzeComplexity, type ComplexityLevel } from './hybrid-router.js';
import { buildAutoResolveOptions } from './resolve-options.js';
import { buildModelCandidates, buildTieredFailoverChain, countEligibleModels } from './model-first-router.js';
import { recordModelUsage } from './model-warmup.js';
import { getDefaultModel } from '../inference/provider-catalog.js';
import { resolveRoute } from '../inference/route-resolver.js';
import { getModelRegistry } from './model-registry.js';
import { recordActionFailure, type FailureSessionState } from './failure-bookkeeping.js';
import { sweepTransientFailures } from './provider-revival.js';
import { getProviderFallback, recordRegistrySuccess } from './provider-fallback.js';
import { ProviderFactory } from '../inference/factory.js';
import { recordRoutingDecision } from './routing-history.js';
import { EventNames, getEventBus } from '../observability/event-bus.js';
import { logger } from '../utils/logger.js';
import type { ConfigManager } from '../config/manager.js';
import type { InferenceOptions } from '../config/types.js';
import type { LLMCallFn } from '../agents/agent.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Failure classification for routing decisions. */
type FailureKind = 'auth' | 'rate-limit' | 'timeout' | 'network' | 'model-not-found' | 'unknown';

/** A candidate provider×model pair in the failover chain. */
export interface FailoverCandidate {
  provider: string;
  model: string;
  score: number;
}

/**
 * Options for {@link buildDeepFailoverPool}. The task text + complexity let the
 * model-first tiered layer contribute candidates; without them the pool is the
 * router chain alone (still deep, just not tier-aware).
 */
export interface DeepFailoverOptions {
  /** Task/goal text — feeds the model-first capability analysis. */
  taskDescription?: string;
  /** Pre-computed complexity (falls back to a plain analysis when omitted). */
  complexity?: ComplexityLevel;
  /** Config manager for the config-declared fallback providers. */
  configManager?: ConfigManager;
}

/** Configuration for the resilient proxy. */
export interface ResilientCallOptions {
  /** Whether to persist failures to disk for cross-pipeline memory (default: true). */
  crossPipelineMemory?: boolean;
  /** Verbose logging (default: false). */
  verbose?: boolean;
  /** Original task info for routing decisions. */
  task: {
    agentType: string;
    description: string;
    complexity?: string;
    taskId?: string;
    contextHintTokens?: number;
  };
}

/** Internal state for a resilient callLLM instance. */
interface ResilientState {
  /**
   * PROVIDER-level exclusions — reserved for failures that genuinely indict the
   * whole provider (auth: the key is dead; unresolved model). A per-model 429
   * must NOT land here or it would exclude the provider's healthy siblings.
   */
  sessionFailed: Map<string, { expiresAt: number; kind: FailureKind }>;
  /**
   * MODEL-level exclusions, keyed `provider|model`. This is what a transient /
   * rate-limit failure records so the walk retries the SAME provider with its
   * NEXT model instead of abandoning every model it has.
   */
  sessionFailedModels: Map<string, { expiresAt: number; kind: FailureKind }>;
  /** Number of failover attempts in the current call. */
  currentAttempt: number;
  /** The current provider/model (mutated on failover). */
  currentProvider: string;
  currentModel: string;
  /** Whether we've exhausted all candidates. */
  exhausted: boolean;
}

/** Key for a model-scoped exclusion / persisted failure. */
function modelKey(provider: string, model: string): string {
  return `${provider}|${model}`;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * How long a provider is excluded after an auth failure.
 *
 * This used to be `Number.MAX_SAFE_INTEGER` — "the key is dead, skip it
 * always" — which made a REPAIRED key invisible forever. The record is written
 * to `nuvira-routing-failures.json` and the loader only prunes entries whose
 * `expiresAt <= now`, so one 401 (a missing env var during setup, a rotated
 * key, an expired OAuth token, or a quota-exhausted key misclassified as auth)
 * excluded that provider in EVERY future process with no route back except a
 * revival probe triggered by a config edit. Observed on disk 2026-09-21:
 * `deepinfra → kind: auth`, expiresAt = now + MAX_SAFE_INTEGER.
 *
 * One hour is long enough that a genuinely dead key costs at most one wasted
 * request per hour, and short enough that a corrected key self-heals with no
 * user action. A CHANGED credential skips the cooldown entirely — see
 * {@link credentialFingerprint}.
 */
const AUTH_FAILURE_EXCLUSION_MS = 60 * 60_000;
/** How long a provider is excluded after rate-limit (short cooldown). */
const RATE_LIMIT_EXCLUSION_MS = 60_000;
/** How long a provider is excluded after timeout/network (medium cooldown). */
const NETWORK_FAILURE_EXCLUSION_MS = 30_000;
/** How long a provider is excluded after model-not-found (long cooldown). */
const MODEL_NOT_FOUND_EXCLUSION_MS = 300_000;
/** Cross-pipeline failure persistence path. */
const FAILURE_PERSIST_PATH = 'nuvira-routing-failures.json';

// ─── Failure Classification ─────────────────────────────────────────────────

function classifyFailure(err: unknown): FailureKind {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('authentication')) {
    return 'auth';
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('quota') || lower.includes('too many requests')) {
    return 'rate-limit';
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('abort')) {
    return 'timeout';
  }
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('network') || lower.includes('fetch failed') || lower.includes('dns')) {
    return 'network';
  }
  if (lower.includes('model not found') || lower.includes('404') || lower.includes('does not exist') || lower.includes('deprecated')) {
    return 'model-not-found';
  }
  return 'unknown';
}

function exclusionDuration(kind: FailureKind): number {
  switch (kind) {
    case 'auth': return AUTH_FAILURE_EXCLUSION_MS;
    case 'rate-limit': return RATE_LIMIT_EXCLUSION_MS;
    case 'timeout': return NETWORK_FAILURE_EXCLUSION_MS;
    case 'network': return NETWORK_FAILURE_EXCLUSION_MS;
    case 'model-not-found': return MODEL_NOT_FOUND_EXCLUSION_MS;
    case 'unknown': return NETWORK_FAILURE_EXCLUSION_MS;
  }
}

// ─── Cross-Pipeline Failure Persistence ─────────────────────────────────────

/**
 * Cross-pipeline failures. Keys are EITHER a bare provider id (provider-wide
 * exclusion — legacy shape, still honored) or `provider|model` (per-model
 * exclusion). Model keys let a failure on one model survive a restart without
 * taking the provider's other models with it.
 */
interface PersistedFailures {
  [key: string]: {
    expiresAt: number;
    kind: FailureKind;
    recordedAt: number;
    /**
     * Fingerprint of the credential that was in force when this failure was
     * recorded (see {@link credentialFingerprint}). Absent on records written
     * before this field existed and on providers whose secret is not readable —
     * those fall back to the time-based cooldown alone.
     */
    credentialFingerprint?: string;
  };
}

/**
 * Shape of a provider's config as far as credentials matter. Kept structural so
 * this module does not depend on the full provider-config union.
 */
type ProviderConfigLike = Record<string, unknown>;

/** One entry of the "why is this provider being skipped?" report. */
export interface RoutingExclusionReport {
  provider: string;
  /** Present when the record rules out ONE model, absent when provider-wide. */
  model?: string;
  kind: FailureKind;
  scope: 'provider' | 'model';
  recordedAt: number;
  /** When the exclusion lifts (0 once it no longer applies). */
  expiresAt: number;
  /** Excluding right now? */
  active: boolean;
  /** Why it is NOT in force, when it is not. */
  note?: 'expired' | 'legacy-expired' | 'credential-changed';
  /** `nuvira-routing-failures.json` (cross-process) vs the model registry. */
  source: 'routing-failures' | 'registry';
}

/**
 * WHY a provider is not being tried — the report behind `nuvira models excluded`.
 *
 * This is the surface the auth-exclusion bug was missing. A provider could be
 * skipped for days with a valid key in place and NOTHING anywhere said so: the
 * record lived in a JSON file, the decision happened inside a failover walk, and
 * the only symptom was that routing quietly used something else. Diagnosis took
 * forensic work on `~/.nuvira/nuvira-routing-failures.json`; it should take one
 * command.
 *
 * Deliberately built on `evaluateFailureRecord` — the SAME function enforcement
 * uses — so this report can never disagree with what routing actually does.
 * Includes records that are NOT active (`credential-changed`, `expired`) because
 * "I fixed the key and it is STILL skipped" is exactly the case worth showing.
 */
export function describeRoutingExclusions(configManager?: ConfigManager): RoutingExclusionReport[] {
  const reports: RoutingExclusionReport[] = [];
  const now = Date.now();
  const fingerprintOf = fingerprintResolver(configManager);

  // 1. Cross-process failure records.
  try {
    const path = resolveNuviraDataPath(FAILURE_PERSIST_PATH);
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as PersistedFailures;
      for (const key of Object.keys(data)) {
        const entry = data[key];
        if (!entry || typeof entry.expiresAt !== 'number') continue;
        const provider = providerOfKey(key);
        const model = key.indexOf('|') === -1 ? undefined : key.slice(key.indexOf('|') + 1);
        const verdict = evaluateFailureRecord(entry, provider, now, fingerprintOf);
        reports.push({
          provider,
          model,
          kind: entry.kind ?? 'unknown',
          scope: model ? 'model' : 'provider',
          recordedAt: entry.recordedAt ?? 0,
          expiresAt: verdict.active ? entry.expiresAt : 0,
          active: verdict.active,
          note: verdict.note,
          source: 'routing-failures',
        });
      }
    }
  } catch {
    // Best-effort — a corrupt file must not break the report.
  }

  // 2. Registry-learned blocks (all tracked models unusable / quota-parked).
  try {
    const registry = getModelRegistry();
    for (const provider of registry.getBlockedProviders()) {
      reports.push({
        provider,
        kind: 'unknown',
        scope: 'provider',
        recordedAt: 0,
        expiresAt: 0,
        active: true,
        source: 'registry',
      });
    }
    // 3. DEAD PAIRS — a model this provider answered "not found" for. Unlike a
    // parked provider, the pair will never come back on its own, so it is the
    // most explainable exclusion there is: without this the pair simply
    // vanished from every failure report (it was never even "tried").
    for (const pair of registry.getDeadPairs()) {
      reports.push({
        provider: pair.provider,
        model: pair.model,
        kind: 'model-not-found',
        scope: 'model',
        recordedAt: 0,
        expiresAt: 0,
        active: true,
        source: 'registry',
      });
    }
  } catch {
    // Best-effort.
  }

  return reports.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.provider.localeCompare(b.provider);
  });
}

/**
 * One line of English for a report entry — the reason a user (or a support
 * conversation) needs, with the timing so "will it come back?" is answerable.
 */
export function formatRoutingExclusion(r: RoutingExclusionReport, now = Date.now()): string {
  const target = r.model ? `${r.provider}/${r.model}` : r.provider;
  if (r.source === 'registry' && r.model) {
    return `🚫 ${target} — this model does not exist on that provider (it answered "not found"). It will not be offered again unless a probe proves it works.`;
  }
  if (r.source === 'registry') {
    return `🔒 ${target} — skipped by the model registry (every tracked model is unavailable or quota-parked). Run \`nuvira models unblock ${r.provider}\` once it recovers.`;
  }
  if (!r.active && r.note === 'credential-changed') {
    return `✅ ${target} — ${r.kind} failure recorded against a DIFFERENT credential; IGNORED, this provider is routable now.`;
  }
  if (!r.active) {
    const when = r.recordedAt ? new Date(r.recordedAt).toISOString().slice(0, 16).replace('T', ' ') : 'unknown time';
    const why = r.note === 'legacy-expired' ? 'the pre-1h "never expires" auth record' : 'expired';
    return `✅ ${target} — ${r.kind} failure from ${when} UTC has ${why}; routable now.`;
  }
  const secs = Math.max(0, Math.round((r.expiresAt - now) / 1000));
  const mins = secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs}s`;
  return `🔒 ${target} — ${r.kind} failure; retried in ~${mins} (${r.scope}-scoped). If the key changed since, this lifts automatically.`;
}

/**
 * A short, non-reversible fingerprint of a provider's SECRET material.
 *
 * Answers one question: "are we still using the credential this exclusion was
 * earned with?". A different key means the old 401 says nothing about the new
 * one, so the exclusion is dropped. Only a SHA-256 prefix is stored — never the
 * secret itself — so the persisted file stays safe to read and to log.
 *
 * Returns `undefined` when nothing credential-shaped is readable, in which case
 * the caller keeps the (now bounded) time cooldown.
 */
export function credentialFingerprint(
  configManager: ConfigManager | undefined,
  provider: string,
): string | undefined {
  if (!configManager || typeof configManager.getProviderConfig !== 'function') return undefined;
  try {
    const { config } = configManager.getProviderConfig(provider);
    const secret = extractSecretMaterial(config as ProviderConfigLike);
    if (!secret) return undefined;
    return createHash('sha256').update(`${provider}\u0000${secret}`).digest('hex').slice(0, 16);
  } catch {
    return undefined;
  }
}

/**
 * Concatenate every credential-shaped string in a provider config, in stable
 * key order, so the fingerprint moves iff a secret actually changes. Names that
 * merely CONTAIN "key" are included deliberately (`apiKey`, `accessKeyId`,
 * `refreshToken`, …); non-secret settings change the fingerprint only if we
 * guessed wrong about them, which is the safe direction (a re-try, not a
 * permanent skip).
 */
function extractSecretMaterial(config: ProviderConfigLike): string {
  const parts: string[] = [];
  for (const name of Object.keys(config).sort()) {
    if (!/key|token|secret|password|credential/i.test(name)) continue;
    const value = config[name];
    if (typeof value === 'string') {
      // A vault REFERENCE (`vault:provider/name`) is resolved by the config
      // manager before we see it; an unresolved ref still varies with the
      // provider entry, so it remains a valid (if weaker) signal.
      parts.push(`${name}=${value}`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${name}=${String(value)}`);
    }
  }
  return parts.join('\u0001');
}

/** The evaluated fate of ONE persisted record — the single place the healing
 * rules live, so the enforcement path and the reporting path cannot drift. */
interface FailureRecordVerdict {
  /** Effective expiry AFTER legacy re-anchoring (0 = pruned outright). */
  effectiveExpiresAt: number;
  /** Still excluding its provider×model right now? */
  active: boolean;
  /** A human reason when the record is NOT (or no longer) in force. */
  note?: 'expired' | 'legacy-expired' | 'credential-changed';
}

function evaluateFailureRecord(
  entry: { expiresAt: number; recordedAt?: number; credentialFingerprint?: string },
  provider: string,
  now: number,
  fingerprintOf: (provider: string) => string | undefined,
): FailureRecordVerdict {
  let expiresAt = entry.expiresAt;
  // LEGACY record from the `Number.MAX_SAFE_INTEGER` auth policy — an expiry
  // further out than any cooldown this version can write. Re-anchor it to the
  // bounded window measured from when it was recorded, so upgrading heals the
  // provider instead of inheriting a permanent exclusion (live: `deepinfra →
  // auth` on disk, 2026-09-21).
  const legacy = expiresAt > now + AUTH_FAILURE_EXCLUSION_MS;
  if (legacy) expiresAt = (entry.recordedAt || now) + AUTH_FAILURE_EXCLUSION_MS;

  if (expiresAt <= now) {
    return { effectiveExpiresAt: 0, active: false, note: legacy ? 'legacy-expired' : 'expired' };
  }
  // RECORDED AGAINST A DIFFERENT CREDENTIAL → the exclusion is stale. This is
  // the fix for "I fixed my API key and the provider still never got tried":
  // the moment the secret changes, every failure that key earned is discarded,
  // however long its cooldown was.
  if (entry.credentialFingerprint) {
    const current = fingerprintOf(provider);
    if (current && current !== entry.credentialFingerprint) {
      return { effectiveExpiresAt: expiresAt, active: false, note: 'credential-changed' };
    }
  }
  return { effectiveExpiresAt: expiresAt, active: true };
}

/**
 * Build the effective fingerprint resolver for a load/report pass. Fingerprints
 * each provider ONCE per pass, not per record.
 */
function fingerprintResolver(configManager?: ConfigManager): (provider: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (provider: string): string | undefined => {
    if (!cache.has(provider)) cache.set(provider, credentialFingerprint(configManager, provider));
    return cache.get(provider);
  };
}

function loadPersistedFailures(configManager?: ConfigManager): PersistedFailures {
  try {
    // Resolved through the active config dir (`$NUVIRA_CONFIG_DIR` aware) — a
    // hardcoded `~/.nuvira` here made an isolated process inherit (and mutate)
    // the real profile's exclusions, so a cooldown earned by a live run
    // silently suppressed models inside tests and sandboxes.
    const path = resolveNuviraDataPath(FAILURE_PERSIST_PATH);
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as PersistedFailures;
    const now = Date.now();
    const fingerprintOf = fingerprintResolver(configManager);
    for (const key of Object.keys(data)) {
      const provider = providerOfKey(key);
      const verdict = evaluateFailureRecord(data[key], provider, now, fingerprintOf);
      if (!verdict.active) delete data[key];
      else data[key].expiresAt = verdict.effectiveExpiresAt;
    }
    return data;
  } catch {
    return {};
  }
}

/** The provider part of a persisted key — `provider` or `provider|model`. */
function providerOfKey(key: string): string {
  const sep = key.indexOf('|');
  return sep === -1 ? key : key.slice(0, sep);
}

/**
 * Persist a failure for cross-pipeline memory. When the failing MODEL is known
 * the entry is keyed `provider|model` so a sibling model on the same provider
 * is still routable in the next process; without a model it stays
 * provider-wide (the legacy, honest answer).
 */
function persistFailure(
  provider: string,
  kind: FailureKind,
  model?: string,
  fingerprint?: string,
): void {
  try {
    const dir = resolveNuviraConfigDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, FAILURE_PERSIST_PATH);
    const existing = loadPersistedFailures();
    const key = model && model !== 'default' ? modelKey(provider, model) : provider;
    existing[key] = {
      expiresAt: Date.now() + exclusionDuration(kind),
      kind,
      recordedAt: Date.now(),
      ...(fingerprint ? { credentialFingerprint: fingerprint } : {}),
    };
    writeFileSync(path, JSON.stringify(existing, null, 2));
  } catch {
    // Best-effort — persistence must never break routing.
  }
}

// ─── Provider Resolution ────────────────────────────────────────────────────

function resolveProviderAdapter(configManager: ConfigManager, providerType: string) {
  try {
    const { type, config } = configManager.getProviderConfig(providerType);
    return ProviderFactory.createProvider(type, config);
  } catch {
    return null;
  }
}

function resolveDesiredModel(
  autoRouter: ReturnType<typeof getAutoRouter>,
  providerType: string,
  agentType: string,
  configManager: ConfigManager,
  taskDescription?: string,
): string {
  return autoRouter.resolveModel(providerType, agentType, configManager, taskDescription);
}

// ─── Main Factory ───────────────────────────────────────────────────────────

/**
 * Create a resilient callLLM that auto-routes on ANY failure.
 *
 * Unlike the orchestrator's fixed-bound callLLM, this proxy:
 * 1. Routes to the auto-router's best candidate initially
 * 2. On ANY failure (not just rate-limit), re-routes to the next candidate
 * 3. Tries ALL ranked candidates (no 3-candidate cap)
 * 4. Tracks failures across the session AND persists to disk
 * 5. Tools/sub-agents use it transparently
 */
export function createResilientCallLLM(
  configManager: ConfigManager,
  options: ResilientCallOptions,
): LLMCallFn {
  const autoRouter = getAutoRouter();
  const state: ResilientState = {
    sessionFailed: new Map(),
    sessionFailedModels: new Map(),
    currentAttempt: 0,
    currentProvider: '',
    currentModel: '',
    exhausted: false,
  };

  // Providers excluded by a TRANSIENT failure (server/network/timeout) during
  // this session. Tracked separately from `state.sessionFailed` because a
  // transient exclusion is PROVISIONAL: it is only upheld until a spot-check
  // proves the provider is still down. The state previously allocated this
  // marker for bookkeeping and never read it, so a provider that recovered kept
  // being skipped for the entire task.
  const transientProviders = new Set<string>();

  // Load cross-pipeline failures. Passing the config manager lets the loader
  // discard records earned with a credential that is no longer in force.
  const persistedFailures = options.crossPipelineMemory !== false
    ? loadPersistedFailures(configManager)
    : {};

  // Initial routing decision
  const initialDecision = resolveWithExclusions(
    autoRouter,
    configManager,
    options.task,
    state.sessionFailed,
    persistedFailures,
    options.verbose,
  );

  if (initialDecision) {
    state.currentProvider = initialDecision.provider;
    state.currentModel = initialDecision.model;
  }

  // Build the ranked candidate list (all candidates, no cap)
  // Pass task description + complexity for model-first failover
  const allCandidates = buildDeepFailoverPool(initialDecision, {
    taskDescription: options.task.description,
    complexity: options.task.complexity ? analyzeComplexity(options.task.description) : undefined,
    configManager,
  });

  // ONE shared exclusion predicate (session provider-wide + session per-model +
  // cross-pipeline persisted + registry per-entry). The session maps are read
  // LIVE, so a failure recorded mid-walk takes effect on the next candidate.
  const failoverFilter = createFailoverExclusionFilter({
    sessionFailed: state.sessionFailed,
    sessionFailedModels: state.sessionFailedModels,
    crossPipelineMemory: options.crossPipelineMemory !== false,
    persistedFailures,
    credentialFingerprint: (provider) => credentialFingerprint(configManager, provider),
  });

  // The resilient callLLM
  const callLLM: LLMCallFn = async (prompt: string, inferenceOptions?: InferenceOptions): Promise<string> => {
    if (state.exhausted) {
      throw new Error(`All LLM providers exhausted. No more candidates available for: ${options.task.description}`);
    }

    // ── Re-verify before re-admit ──────────────────────────────────────────
    // Before choosing a candidate, give any provider excluded by a TRANSIENT
    // failure the one-more-round the state always intended: a 1-token
    // spot-check. Verified → back in the pool for THIS call; still down → its
    // exclusion is re-armed. Best-effort and bounded (the sweep stops at 3
    // probes and skips still-active exclusions without a network call).
    try {
      await sweepTransientFailures(
        {
          transientProviders: () => transientProviders,
          isExclusionActive: (provider, now) => expiryAt(state.sessionFailed.get(provider)) > now,
          clearProvider: (provider) => {
            transientProviders.delete(provider);
            state.sessionFailed.delete(provider);
          },
          reArmProvider: (provider, until) => {
            state.sessionFailed.set(provider, { expiresAt: until, kind: 'unknown' });
            transientProviders.add(provider);
          },
          resolveProbeModel: (provider) =>
            autoRouter.resolveModel(provider, options.task.agentType, configManager),
        },
        configManager,
        { agentType: options.task.agentType },
      );
    } catch {
      // Best-effort — revival must never break the call.
    }

    // Try current provider first, then walk all candidates
    const candidatesToTry: FailoverCandidate[] = [
      { provider: state.currentProvider, model: state.currentModel, score: 1.0 },
      ...allCandidates.filter(c =>
        c.provider !== state.currentProvider ||
        c.model !== state.currentModel
      ),
    ];

    let lastError: unknown = null;

    for (const candidate of candidatesToTry) {
      // MODEL-scoped exclusions are honored before provider-wide ones, and the
      // registry is checked per ENTRY: a failed or parked model rules out only
      // itself, so the provider's other candidates in this list stay reachable
      // (deep failover). Shared with chat/execute via the same factory.
      if (failoverFilter(candidate.provider, candidate.model)) {
        recordFailoverAttempt({
          provider: candidate.provider,
          model: candidate.model,
          kind: 'skipped',
          skipped: true,
          reason: 'ruled out by a recent failure or the model registry',
        });
        if (options.verbose) {
          logger.debug(`   ⏭️  ${candidate.provider}/${candidate.model} excluded (failure or registry) — skipping`);
        }
        continue;
      }

      // Resolve the provider adapter
      const adapter = resolveProviderAdapter(configManager, candidate.provider);
      if (!adapter) {
        recordFailoverAttempt({
          provider: candidate.provider,
          model: candidate.model,
          kind: 'skipped',
          skipped: true,
          reason: 'no credential configured for it',
        });
        if (options.verbose) {
          logger.debug(`   ⏭️  ${candidate.provider} unresolvable — skipping`);
        }
        continue;
      }

      // Check availability
      try {
        if (!(await adapter.isAvailable())) {
          recordFailoverAttempt({
            provider: candidate.provider,
            model: candidate.model,
            kind: 'skipped',
            skipped: true,
            reason: 'adapter reported itself unavailable',
          });
          if (options.verbose) {
            logger.debug(`   ⏭️  ${candidate.provider} unavailable — skipping`);
          }
          continue;
        }
      } catch {
        continue;
      }

      // Try the call
      try {
        // Resolve the model at call time (ScoredProvider doesn't carry model)
        const desiredModel = candidate.model === 'default'
          ? resolveDesiredModel(autoRouter, candidate.provider, options.task.agentType, configManager, options.task.description)
          : candidate.model;
        // CRITICAL: 'default' is a sentinel that must NEVER reach a provider API.
        // resolveDesiredModel may return 'default' when the registry is cold and
        // the config has model:'default'.
        //
        // The pair is validated against `adapter` — the instance resolved from
        // THIS candidate that the generate call below uses — for EVERY candidate
        // model, not only an empty/`default` one (issue #10: a non-empty model
        // that belongs to another provider skipped the validator entirely and
        // went straight to the API as a 404). Substitutions are printed and
        // recorded, not made silently (issue #11).
        let resolvedModel = desiredModel;
        try {
          const route = await resolveRoute({
            providerType: candidate.provider,
            provider: adapter,
            model: desiredModel,
            source: 'failover',
            agentType: options.task.agentType,
            task: options.task.description,
          });
          resolvedModel = route.model;
        } catch {
          // Validator failed (offline, no key): keep a real id rather than the
          // 'default' sentinel, which 404s on every provider.
          try {
            resolvedModel = desiredModel && desiredModel !== 'default'
              ? desiredModel
              : getDefaultModel(candidate.provider);
          } catch {
            resolvedModel = 'unknown';
          }
        }
        const mergedOptions: InferenceOptions = {
          ...inferenceOptions,
          model: resolvedModel,
        };

        // Update current provider for next call
        state.currentProvider = candidate.provider;
        state.currentModel = candidate.model;

        const result = await adapter.generate(prompt, mergedOptions);

        // Success — reset failover counter for this candidate
        state.currentAttempt = 0;

        // Record success in registry
        try {
          recordRegistrySuccess(candidate.provider, resolvedModel, 'execute');
        } catch {
          // Best-effort.
        }

        // Record usage for warmup daemon
        try {
          recordModelUsage(candidate.provider, resolvedModel);
        } catch {
          // Best-effort — warmup must never break routing
        }

        // Record routing decision for audit
        recordRoutingDecision({
          source: 'orchestrator',
          agentType: options.task.agentType,
          task: options.task.description,
          complexity: options.task.complexity || 'moderate',
          provider: candidate.provider,
          model: resolvedModel,
          score: candidate.score,
        });

        if (state.currentAttempt > 0 && options.verbose) {
          logger.success(`✅ Resilient failover: answered from ${candidate.provider}/${candidate.model} after ${state.currentAttempt} attempts`);
        }

        return result;
      } catch (err) {
        lastError = err;
        state.currentAttempt++;

        // Classify and record the failure
        const kind = classifyFailure(err);
        const duration = exclusionDuration(kind);
        // Telemetry for the failure report: the user is told which models were
        // actually called and why each one did not answer.
        recordFailoverAttempt({
          provider: candidate.provider,
          model: candidate.model,
          kind: String(kind),
          skipped: false,
          reason: failureKindPhrase(String(kind)),
        });

        // PER-MODEL EXCLUSION when the failing model is known. Excluding the
        // whole provider here is what stopped a provider's 2nd-best model from
        // ever being tried: one 429 on model A took models B and C with it.
        // Only a failure that indicts the whole provider (auth: the key is
        // dead) still records a provider-wide exclusion.
        const failedModel = candidate.model;
        const modelScoped = kind !== 'auth' && !!failedModel && failedModel !== 'default';
        if (modelScoped) {
          state.sessionFailedModels.set(modelKey(candidate.provider, failedModel), {
            expiresAt: Date.now() + duration,
            kind,
          });
        } else {
          state.sessionFailed.set(candidate.provider, {
            expiresAt: Date.now() + duration,
            kind,
          });
        }

        // TRANSIENT failures are PROVISIONAL: mark the provider as awaiting a
        // spot-check so a later call re-verifies it instead of skipping it for
        // the rest of the task. auth = the key is dead (never revives on its
        // own), rate-limit = the provider's own reset window governs, and
        // model-not-found is definitive for that model — none of those are
        // helped by a probe, so they are deliberately NOT marked.
        if (kind === 'network' || kind === 'timeout' || kind === 'unknown') {
          transientProviders.add(candidate.provider);
        }

        // Persist for cross-pipeline memory. The credential fingerprint is
        // recorded WITH the failure so a later key change invalidates it
        // instead of leaving the provider excluded (see
        // `loadPersistedFailures`).
        if (options.crossPipelineMemory !== false) {
          persistFailure(
            candidate.provider,
            kind,
            modelScoped ? failedModel : undefined,
            credentialFingerprint(configManager, candidate.provider),
          );
        }

        // Record failure in shared bookkeeping
        try {
          const session: FailureSessionState = {
            sessionFailedProviders: new Map([[candidate.provider, Date.now() + duration]]),
            sessionTransientFailedProviders: new Set(),
          };
          recordActionFailure(
            session,
            candidate.provider,
            err,
            configManager,
            { model: candidate.model, action: options.task.agentType },
          );
        } catch {
          // Best-effort.
        }

        // Emit failover event
        try {
          getEventBus().emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
            agentType: options.task.agentType,
            stage: 'routing',
            message: `⚠️ ${candidate.provider} failed (${kind}) — trying next candidate`,
          }, 'orchestrator');
        } catch {
          // Best-effort.
        }

        if (options.verbose) {
          logger.warn(`   ⚠️ ${candidate.provider} failed (${kind}): ${err instanceof Error ? err.message : String(err)}`);
        }

        // Continue to next candidate
        continue;
      }
    }

    // All candidates exhausted
    state.exhausted = true;
    throw new Error(
      `All LLM providers exhausted for: ${options.task.description}. ` +
      `Tried ${candidatesToTry.length} candidates. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  };

  // Expose metadata for debugging
  (callLLM as any).__resilient = {
    getState: () => ({ ...state }),
    getCandidates: () => [...allCandidates],
    getCurrentProvider: () => state.currentProvider,
    getCurrentModel: () => state.currentModel,
    isExhausted: () => state.exhausted,
  };

  return callLLM;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveWithExclusions(
  autoRouter: ReturnType<typeof getAutoRouter>,
  configManager: ConfigManager,
  task: { agentType: string; description: string; complexity?: string; contextHintTokens?: number },
  sessionFailed: Map<string, { expiresAt: number; kind: FailureKind }>,
  persistedFailures: PersistedFailures,
  verbose?: boolean,
): AutoRouteResult | null {
  try {
    const decision = autoRouter.resolve(
      task.agentType,
      task.description,
      {
        ...buildAutoResolveOptions(configManager, {
          verbose,
          contextHintTokens: task.contextHintTokens,
        }),
        complexityHint: task.complexity as any,
      },
      configManager,
    );

    // Filter out excluded providers
    const now = Date.now();
    const isExcludedLocal = (p: string): boolean => {
      const sessionExcl = sessionFailed.get(p);
      if (sessionExcl && sessionExcl.expiresAt > now) return true;
      const persisted = persistedFailures[p];
      if (persisted && persisted.expiresAt > now) return true;
      return false;
    };

    // Find first non-excluded ranked provider
    const allRanked = [decision.provider, ...decision.ranked.map(r => r.provider)];
    const firstAvailable = allRanked.find(p => !isExcludedLocal(p));

    if (firstAvailable && firstAvailable !== decision.provider) {
      // Sink to the first available
      const rankedEntry = decision.ranked.find(r => r.provider === firstAvailable);
      const model = resolveDesiredModel(autoRouter, firstAvailable, task.agentType, configManager, task.description);
      return {
        ...decision,
        provider: firstAvailable,
        model,
        score: rankedEntry?.score ?? decision.score,
        explanation: `${decision.explanation} — sank to ${firstAvailable} (original excluded)`,
      };
    }

    return decision;
  } catch {
    return null;
  }
}

/**
 * Build the DEEP failover pool — the ONE candidate list every entry path walks.
 *
 * This used to live only here, which is why the orchestrator/tool/sub-agent path
 * was the deepest walker and chat/execute reached strictly fewer models. It is
 * now exported so chat, execute, the dashboard console and the gateway all walk
 * the SAME pool:
 *
 *   1. the router's primary win
 *   2. the model-first TIERED pool (same model on other providers → same tier →
 *      escalate → de-escalate → local; quota pre-checked, so every provider's
 *      siblings are reachable, not just its one pin)
 *   3. the router's own chain — ranked alternates PLUS the reserve pool
 *   4. any ranked provider the chain never resolved a model for
 *   5. the config-declared fallback providers
 *
 * Sorted best-first. Callers layer their OWN exclusions on top (session/model
 * cooldowns, registry blocks) — the pool itself is never filtered, so a caller
 * that deliberately wants to reach a parked model (to let `resolveWorkingModel`
 * repair it) still can.
 */
export function buildDeepFailoverPool(
  decision: AutoRouteResult | null,
  opts: DeepFailoverOptions = {},
): FailoverCandidate[] {
  if (!decision) return [];

  const { taskDescription, complexity, configManager } = opts;
  const candidates: FailoverCandidate[] = [];

  // Primary candidate
  candidates.push({
    provider: decision.provider,
    model: decision.model,
    score: decision.score,
  });

  // ── TIERED FAILOVER: capability-based with quota pre-check ────────────
  // Strategy (Dheeraj's design):
  //   1. Same model, different provider (fastest transition)
  //   2. Same capability tier, different models (pre-check quota)
  //   3. Escalate to higher tier (pre-check quota)
  //   4. De-escalate to lower tier, cheaper models (pre-check quota)
  //   5. Local model (always available, last resort)
  //   6. Any remaining (last resort before neural response)
  // Only the providers the ROUTER actually considered (winner + ranked) may
  // contribute tiered candidates. `ranked` is the post-governance, credentialed
  // set, so this keeps the pool to really-callable providers — without it the
  // tiered layer returns the whole CATALOG and every walk pointlessly probes
  // providers the user has no key for (measured: 23 pairs, 16 of them
  // un-credentialed, before this restriction).
  const allowedProviders = [...new Set([decision.provider, ...decision.ranked.map((r) => r.provider)])];
  try {
    if (taskDescription && complexity) {
      const modelCandidates = buildModelCandidates(taskDescription, complexity, configManager, allowedProviders);
      const tieredChain = buildTieredFailoverChain(
        { model: decision.model, provider: decision.provider, dimensions: { capabilityFit: 0.5 } } as any,
        modelCandidates,
      );
      // Flatten tiers into candidate list, maintaining tier order
      for (const tier of tieredChain) {
        for (const fc of tier.candidates) {
          if (fc.provider === decision.provider && fc.model === decision.model) continue;
          const key = `${fc.provider}:${fc.model}`;
          if (candidates.some(c => `${c.provider}:${c.model}` === key)) continue;
          candidates.push({
            provider: fc.provider,
            model: fc.model,
            score: fc.score,
          });
        }
      }
    }
  } catch {
    // Best-effort — tiered failover must never break routing
  }

  // The router's OWN fallback chain — ranked alternates PLUS the RESERVE pool
  // (credentialed providers the registry hasn't verified yet). Each entry now
  // carries a REAL model, and there are several per provider (DEEP FAILOVER),
  // so dedupe must be by provider × model — dedupe by provider alone is what
  // silently dropped every alternate model and made the chain one-model-per-
  // provider. The reserve is strictly last-resort: scored below every ranked
  // candidate so it is only reached once the verified pool is exhausted.
  for (const fb of decision.fallbackChain) {
    const model = fb.model && fb.model !== 'default' ? fb.model : 'default';
    // The primary candidate is already candidates[0].
    if (fb.provider === decision.provider && model === decision.model) continue;
    const key = `${fb.provider}|${model}`;
    if (candidates.some((c) => `${c.provider}|${c.model}` === key)) continue;
    candidates.push({
      provider: fb.provider,
      model,
      // Keep the chain's own order meaningful: the router already ranked these
      // (primary picks before alternates, reserve last). A real model from the
      // chain outranks a bare provider placeholder.
      score: model === 'default' ? 0.05 : 0.5,
    });
  }

  // Any ranked provider still missing entirely (no chain entry resolved a
  // model) — added LAST with the placeholder; resolveModel fills it in at call
  // time via the per-model path.
  for (const ranked of decision.ranked) {
    if (ranked.provider === decision.provider) continue;
    if (candidates.some(c => c.provider === ranked.provider)) continue;
    candidates.push({
      provider: ranked.provider,
      model: 'default', // Will be resolved at call time
      score: ranked.score,
    });
  }

  // Add fallback chain candidates (from the config's fallback.providers)
  try {
    const fallbackChain = getProviderFallback({} as any).getFallbackChain(decision.provider);
    for (const fb of fallbackChain) {
      if (candidates.some(c => c.provider === fb)) continue;
      candidates.push({
        provider: fb,
        model: 'default',
        score: 0.1, // Low score — these are last-resort
      });
    }
  } catch {
    // Best-effort — fallback chain must never break routing.
  }

  // Sort by score descending (best first)
  candidates.sort((a, b) => b.score - a.score);

  // The router's own win MUST stay first. The score-sort above compares the
  // router's COMPOSITE score against the tiered layer's raw capability scores,
  // and a tiered candidate can outscore the winner — which would silently
  // override the router for every caller that walks the pool in order (chat and
  // execute do exactly that). The router's decision is authoritative; the pool
  // only extends failover BEYOND it.
  const primaryIdx = candidates.findIndex(
    (c) => c.provider === decision.provider && c.model === decision.model,
  );
  if (primaryIdx > 0) {
    const [primary] = candidates.splice(primaryIdx, 1);
    candidates.unshift(primary);
  }

  return candidates;
}

/**
 * Expiry read from either a bare timestamp (`Map<string, number>`, the shape
 * chat keeps) or a record with `expiresAt` (resilient-call's internal maps and
 * the persisted-failure store). Duck-typing both shapes is what lets ONE
 * predicate serve every entry path without an adapter allocation per call.
 */
function expiryAt(value: number | { expiresAt: number } | undefined): number {
  if (value === undefined) return 0;
  return typeof value === 'number' ? value : value.expiresAt;
}

/** A session-exclusion map in EITHER of the shapes used across the codebase. */
type ExclusionMap = Map<string, number | { expiresAt: number }>;

/**
 * Options for {@link createFailoverExclusionFilter}.
 */
export interface FailoverExclusionOptions {
  /** PROVIDER-wide session exclusions (dead key, unresolved model). */
  sessionFailed?: ExclusionMap;
  /** MODEL-scoped session exclusions, keyed `provider|model`. */
  sessionFailedModels?: ExclusionMap;
  /**
   * Cross-pipeline failures recorded by ANY path (default: on). Pass `false` to
   * keep the decision purely in-process.
   */
  crossPipelineMemory?: boolean;
  /**
   * Already-loaded persisted failures — avoids a second disk read when the
   * caller has one. Ignored when `crossPipelineMemory` is false.
   */
  persistedFailures?: PersistedFailures;
  /** Consult the registry's per-ENTRY usability (default: on). */
  registryCheck?: boolean;
  /**
   * Resolver for a provider's CURRENT credential fingerprint (see
   * {@link credentialFingerprint}). When supplied, a persisted exclusion whose
   * fingerprint no longer matches is ignored — a repaired key is never skipped.
   * Optional so the predicate stays usable without a config manager.
   */
  credentialFingerprint?: (provider: string) => string | undefined;
}

/**
 * Build the ONE failover-exclusion predicate every entry path shares, so the
 * deep walk can never drift between chat, execute, the gateway and the
 * orchestrator.
 *
 * It answers exactly the question the orchestrator's walk used to answer alone:
 * "should this provider×model be skipped?". Provider-wide AND model-scoped
 * exclusions are honored separately — a 429 on one model rules out that model
 * only, never its healthy siblings. Session maps are read LIVE at call time, so
 * a failure recorded mid-walk takes effect on the very next candidate.
 *
 * Best-effort by construction: a registry failure never rules a candidate out.
 */
export function createFailoverExclusionFilter(
  opts: FailoverExclusionOptions = {},
): (provider: string, model?: string) => boolean {
  const persisted: PersistedFailures = opts.crossPipelineMemory === false
    ? {}
    : opts.persistedFailures ?? loadPersistedFailures();
  const registryCheck = opts.registryCheck !== false;
  const fingerprintOf = opts.credentialFingerprint;
  return (provider: string, model?: string): boolean => {
    if (isExcluded(provider, model, opts.sessionFailed, opts.sessionFailedModels, persisted, fingerprintOf)) {
      return true;
    }
    return registryCheck ? isRegistryRuledOut(provider, model) : false;
  };
}

function isExcluded(
  provider: string,
  model: string | undefined,
  sessionFailed: ExclusionMap | undefined,
  sessionFailedModels: ExclusionMap | undefined,
  persistedFailures: PersistedFailures,
  credentialFingerprintOf?: (provider: string) => string | undefined,
): boolean {
  const now = Date.now();
  //
  // A persisted record is only honored while the credential it was earned with
  // is still the credential in force. `loadPersistedFailures` prunes mismatches
  // at read time; this re-check covers a map that was loaded BEFORE a key was
  // fixed (a long-lived process, or an already-built filter).
  const persistedActive = (entry: PersistedFailures[string] | undefined): boolean => {
    if (!entry || expiryAt(entry) <= now) return false;
    const recorded = entry.credentialFingerprint;
    if (!recorded || !credentialFingerprintOf) return true;
    const current = credentialFingerprintOf(provider);
    return !current || current === recorded;
  };
  // Provider-wide (auth / unresolved model).
  if (expiryAt(sessionFailed?.get(provider)) > now) return true;
  if (persistedActive(persistedFailures[provider])) return true;
  // Model-scoped — only this exact provider × model is ruled out.
  if (model && model !== 'default') {
    const key = modelKey(provider, model);
    const modelExcl = sessionFailedModels?.get(key);
    if (expiryAt(modelExcl) > now) return true;
    if (persistedActive(persistedFailures[key])) return true;
  }
  return false;
}

/**
 * Has the Model Availability Registry already ruled this candidate out?
 *
 * Model-aware on purpose: with a concrete model the check is per-ENTRY
 * (parked/unavailable/stale → skip just that candidate), so a parked model no
 * longer blocks its healthy siblings on the same provider. Only an unresolved
 * ('default') model falls back to the provider-wide blocked check.
 * Best-effort — a registry failure never rules a candidate out.
 */
function isRegistryRuledOut(provider: string, model: string | undefined): boolean {
  try {
    const registry = getModelRegistry();
    if (model && model !== 'default') {
      // Untracked model → unproven, not ruled out: the failover chain exists
      // precisely to reach models the registry has no data on yet.
      if (!registry.getEntry(provider, model)) return false;
      return !registry.isUsable(provider, model);
    }
    return registry.getBlockedProviders().includes(provider);
  } catch {
    return false;
  }
}

// ─── What the walk actually ATTEMPTED ──────────────────────────────────────
//
// `describeRoutingExclusions` answers "why is this provider being SKIPPED?" —
// it is a snapshot of records. It cannot answer "what did you actually TRY?",
// because an attempt is an EVENT, not a record. A failure report needs both
// halves: a user told "the model was unavailable" has no way to tell a genuinely
// exhausted pool from one provider that rate-limited while three others sat
// parked on quota.
//
// Recording is a ring buffer, not state: a caller marks a position before
// starting work and asks for what was recorded since. Nothing here can change a
// routing decision — it is telemetry, and every write is guarded.

/** One model the failover walk attempted, and why it did not answer. */
export interface FailoverAttempt {
  provider: string;
  model: string;
  /** Classified failure kind, or `skipped` when it was never called. */
  kind: string;
  /** True when the candidate was skipped rather than called and failed. */
  skipped: boolean;
  /** Short human phrase — what a user can act on. */
  reason: string;
}

const FAILOVER_ATTEMPT_LIMIT = 200;
let failoverSeq = 0;
const failoverAttempts: Array<FailoverAttempt & { seq: number; at: number }> = [];

/** Mark the current position in the attempt log (pass the result to `attemptsSince`). */
export function markFailoverAttempts(): number {
  return failoverSeq;
}

/** Attempts recorded since `mark`, oldest first. */
export function attemptsSince(mark: number): FailoverAttempt[] {
  return failoverAttempts.filter((a) => a.seq > mark).map(({ seq: _s, at: _a, ...rest }) => rest);
}

/** Record one attempt. Best-effort: telemetry must never break routing. */
export function recordFailoverAttempt(attempt: FailoverAttempt): void {
  try {
    failoverSeq += 1;
    failoverAttempts.push({ ...attempt, seq: failoverSeq, at: Date.now() });
    if (failoverAttempts.length > FAILOVER_ATTEMPT_LIMIT) {
      failoverAttempts.splice(0, failoverAttempts.length - FAILOVER_ATTEMPT_LIMIT);
    }
  } catch {
    /* never break routing for telemetry */
  }
}

/** A short, human phrase for a failure kind — what the user can act on. */
export function failureKindPhrase(kind: string): string {
  switch (kind) {
    case 'rate-limit':
      return 'rate limited (quota) — still logged in, just throttled';
    case 'auth':
      return 'rejected its credential';
    case 'timeout':
      return 'timed out';
    case 'network':
      return 'network error';
    case 'model-not-found':
      return 'model not found';
    case 'context-window':
      return 'the prompt was too large for its window';
    case 'server':
      return 'provider-side error';
    default:
      return 'failed';
  }
}

/** Both halves of "why did this fail": what was tried, what is parked. */
export interface ModelBreadthReport {
  tried: FailoverAttempt[];
  /** Active exclusions right now — the models that were NOT available to try. */
  parked: RoutingExclusionReport[];
  /** ms until the soonest parked model frees up (absent when none will). */
  nextFreeInMs?: number;
  /**
   * How many models the router would ACTUALLY consider right now (dead pairs
   * and non-chat models already excluded). Optional so callers that construct
   * a report by hand (tests, focused diagnostics) keep working, but the real
   * producer always fills it — without it, no drought claim can be justified.
   */
  poolSize?: number;
  /** Providers with at least one eligible model. */
  poolProviders?: number;
}

/**
 * Should a failed ask be QUEUED for a background retry?
 *
 * G9: the retry offer used to be printed unconditionally, and the gateway then
 * dutifully queued 40 attempts over 6 hours. But a retry only helps when the
 * cause is transient availability — something waitable, or a genuinely empty
 * pool that later fills. A task-shape failure (the plan was wrong, the writer
 * cannot emit that artifact) fails identically on every retry, so promising
 * "I will keep trying until it is done" is a 6-hour lie. This predicate is the
 * single source of truth for that decision, shared by every caller.
 */
/**
 * What KIND of failure is being reported — the report alone cannot always tell.
 *
 * A chat turn that failed to GENERATE is a model-layer failure by construction,
 * so a retry is the right remedy even when nothing was parked and no attempt
 * was recorded (the walk may have thrown before it recorded anything). A
 * PIPELINE that failed to complete its tasks with a healthy pool is a
 * task-shape failure, and a retry only reproduces it. The caller knows which
 * one it is; the report does not.
 */
export interface FailureContext {
  /** The model layer itself failed (no answer was generated at all). */
  modelLayerFailure?: boolean;
}

export function reportWarrantsRetry(report: ModelBreadthReport | undefined, ctx?: FailureContext): boolean {
  if (!report) return false;
  // A generation failure can only be retried — the task never got to run.
  if (ctx?.modelLayerFailure) return true;
  // Something with an expiry is coming back — waiting is honest.
  if (report.nextFreeInMs !== undefined) return true;
  // Nothing to wait for, but the pool is genuinely empty — a later turn may
  // have models again (a key added, a provider restored).
  if ((report.poolSize ?? 0) === 0) return true;
  // The pool is healthy AND at least one model was actually reached and failed.
  // That is a real model-layer outage, and retrying is the right response.
  const attempted = report.tried.filter((a) => !a.skipped).length;
  if (attempted > 0) return true;
  // Healthy pool, and NOTHING was ever called: the failure is not the model
  // layer (live: six identical orchestrator runs, zero attempts recorded, 507
  // models eligible). A retry reproduces it exactly, so no retry is offered.
  return false;
}

/**
 * Collect what the walk tried since `mark`, plus every model parked right now.
 * Deliberately assembled from `describeRoutingExclusions` — the SAME evaluation
 * enforcement uses — so the report can never disagree with what routing did.
 */
export function modelBreadthReport(mark: number, configManager?: ConfigManager): ModelBreadthReport {
  const tried = attemptsSince(mark);
  let parked: RoutingExclusionReport[] = [];
  try {
    parked = describeRoutingExclusions(configManager).filter((r) => r.active);
  } catch {
    parked = [];
  }
  const now = Date.now();
  const nextFreeInMs = parked.reduce<number | undefined>((acc, r) => {
    if (!r.expiresAt) return acc;
    const wait = Math.max(0, r.expiresAt - now);
    return acc === undefined || wait < acc ? wait : acc;
  }, undefined);
  // The pool size is measured, never assumed — it is what decides whether a
  // "no model is available" claim is allowed to be made at all (G9).
  const pool = countEligibleModels();
  return {
    tried,
    parked,
    poolSize: pool.models,
    poolProviders: pool.providers,
    ...(nextFreeInMs !== undefined ? { nextFreeInMs } : {}),
  };
}

/** "2m", "55m", "3h" — a wait a person can read. */
export function formatWait(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

/**
 * The honest failure message: what was tried, what was parked and WHY, and
 * whether waiting would help.
 *
 * Replaces a bare "the language model was unavailable", which names no cause and
 * offers no next step. The agent's job is to deliver a task, so a failure it
 * cannot avoid must at least tell the user which models were in play and
 * whether the situation is temporary — a pool that is genuinely empty and a
 * pool that is briefly throttled look identical from a one-line apology.
 *
 * Returns undefined when there is nothing concrete to report, so callers keep
 * their existing (already-actionable) error line rather than printing an empty
 * report.
 */
export function renderModelBreadthReport(
  report: ModelBreadthReport,
  opts: { task?: string } & FailureContext = {},
): string | undefined {
  const tried = report.tried.filter((a) => !a.skipped);
  const skipped = report.tried.filter((a) => a.skipped);
  // A registry RULING is not a park: the pair will never come back on its own,
  // so it is reported separately (and without a "free in ~" that would wrongly
  // promise a recovery). Everything else in `parked` is a temporary exclusion.
  const isRuling = (r: RoutingExclusionReport): boolean => r.source === 'registry' && !!r.model;
  const retired = report.parked.filter(isRuling);
  const parked = report.parked.filter((r) => !isRuling(r));
  const poolSize = report.poolSize ?? 0;
  const poolProviders = report.poolProviders ?? 0;
  // `poolSize === undefined` means the caller built the report by hand and the
  // pool was never measured. Treat that as "unknown" and stay silent about it
  // rather than asserting a shortage we did not check.
  const poolMeasured = typeof report.poolSize === 'number';
  const emptyPool = poolMeasured && poolSize === 0;
  const nothingTried = tried.length === 0 && skipped.length === 0;
  // Nothing concrete to say → keep the caller's existing (already actionable)
  // error line rather than printing an empty report. A ruled-out pair DOES
  // count as concrete: it is the thing the user was told about while the pool
  // was in fact healthy, so it must be rendered and corrected (G9).
  if (nothingTried && report.parked.length === 0) return undefined;

  const lines: string[] = [];
  lines.push(opts.task ? `😞 I couldn't finish: ${opts.task.slice(0, 120)}` : "😞 I couldn't finish that task.");

  // "Nothing was attempted" and "everything was attempted and failed" are
  // different failures with different fixes. Saying neither (as the old
  // renderer did) is what let a two-entry park list read as a dead pool.
  if (nothingTried) {
    lines.push('');
    lines.push('No model call was made for this run — it failed before reaching the pool.');
  } else if (tried.length > 0) {
    lines.push('');
    lines.push(`I tried ${tried.length} model${tried.length === 1 ? '' : 's'}:`);
    for (const a of tried.slice(0, 8)) {
      lines.push(`  • ${a.provider}/${a.model} — ${a.reason}`);
    }
  }

  if (parked.length > 0) {
    const now = Date.now();
    lines.push('');
    lines.push('Not available to try (parked), and why:');
    for (const r of parked.slice(0, 8)) {
      const target = r.model ? `${r.provider}/${r.model}` : r.provider;
      const wait = r.expiresAt ? ` — free in ~${formatWait(Math.max(0, r.expiresAt - now))}` : '';
      lines.push(`  • ${target} — ${failureKindPhrase(r.kind)}${wait}`);
    }
  }

  if (retired.length > 0) {
    lines.push('');
    lines.push('Ruled out (this model does not exist on that provider):');
    for (const r of retired.slice(0, 4)) {
      lines.push(`  • ${r.provider}/${r.model}`);
    }
    if (!emptyPool) {
      // The critical correction: a ruled-out pair is not a shortage. The
      // excluded pairs are listed as a NOTE, never as the reason the task died.
      lines.push('  (these are excluded pairs only — they are not the reason above)');
    }
  }

  if (skipped.length > 0 && tried.length === 0) {
    lines.push('');
    lines.push(`Every candidate was skipped before it could be called (${skipped.length}).`);
  }

  if (poolMeasured && !emptyPool) {
    lines.push('');
    lines.push(
      `Pool at the time: ${formatCount(poolSize)} eligible model${poolSize === 1 ? '' : 's'} across ${poolProviders} provider${poolProviders === 1 ? '' : 's'}.`,
    );
  }

  lines.push('');
  // MODELS WERE AVAILABLE AND UNREACHED — a routing gap, not a shortage — so
  // do not LEAD WITH A WAIT. A user reported exactly this: the reply said "a
  // model frees up in ~4m" while a healthy pool (other providers, credentialed
  // and verified) sat unused. This only overrides the WAIT framing: when some
  // model was tried and other eligible models remain, the honest next step is an
  // immediate retry that routes to a different model, not "wait".
  const modelsRemain = poolMeasured && tried.length > 0 && poolSize > tried.length;
  if (report.nextFreeInMs !== undefined) {
    if (modelsRemain) {
      lines.push(
        `Note: ${formatCount(poolSize)} model${poolSize === 1 ? '' : 's'} were eligible but only ${tried.length} ${tried.length === 1 ? 'was' : 'were'} tried — so waiting is not the fix. ` +
          'Want me to retry now and route to one of the untried models? Reply *yes* and I will run it.',
      );
    } else {
      // `nextFreeInMs` is computed from ACTIVE exclusions with an expiry, so a
      // retired pair (expiresAt 0) can never be the thing we are waiting for.
      lines.push(
        `A model frees up in about ${formatWait(report.nextFreeInMs)}. Want me to keep checking and run this the moment one is available, then update you here? Reply *yes* and I will keep trying until it is done.`,
      );
    }
  } else if (emptyPool) {
    lines.push(
      'No suitable model is available right now — the eligible pool is empty. Want me to keep checking in the background and run this as soon as one comes back? Reply *yes* and I will keep trying until it is done.',
    );
  } else if (reportWarrantsRetry(report, opts)) {
    // Availability-shaped: models were reached and failed (or the caller knows
    // the model layer itself failed). Waiting is a real remedy, so the offer
    // stands and the caller queues it.
    lines.push(
      'Want me to keep checking in the background and run this as soon as one comes back? Reply *yes* and I will keep trying until it is done.',
    );
  } else {
    // Healthy pool, nothing attempted: NOT a model shortage. Queuing a retry
    // would burn hours reproducing an identical failure (live: 6 identical
    // orchestrator runs in 32 minutes), so no retry is offered — and the user
    // is told why, instead of being asked to wait for a model that was never
    // the problem. The retry decision uses the same predicate the QUEUE uses,
    // so the offer and the queue can never disagree.
    lines.push(
      'This was not a model shortage, so queuing a retry would only repeat the same failure. The ask needs a different approach rather than a different model.',
    );
  }
  return lines.join('\n');
}
