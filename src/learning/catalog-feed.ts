/**
 * The OpenRouter model catalogue as a SOURCE OF PRIORS — never measurements.
 *
 * WHY THIS ONE FEED, AND NOT A LEADERBOARD. `docs/DESIGN_CAPABILITY_BY_MEASUREMENT.md` §6 assessed every
 * public ranking source proposed for the scorecard and found two retired (the HF Open LLM Leaderboard,
 * Papers With Code), one unrelated (Graphify), and one whose sample names cannot be verified at all —
 * and then identified exactly one value that attaches to a pair **without an identity guess**:
 * `GET https://openrouter.ai/api/v1/models`, keyless and documented, returning each catalogue model's
 * pricing, `context_length` and `supported_parameters` for the ids this router actually routes to.
 *
 * It supplies `cost` and `ecosystem` priors. Nothing else, and never `accuracy`: an offline catalogue
 * says what a model costs and what it advertises, and says nothing about whether OUR work succeeded.
 *
 * THE FIVE RULES FROM §6.2 ARE EACH A LINE OF CODE HERE, not an aspiration:
 *
 *  1. PRIOR ONLY. Every value this module returns is labelled with its source and fetch time, and
 *     `capabilityLines` prints it as a prior. Samples always outrank it.
 *  2. NEVER ON THE ROUTING PATH. Nothing in the router imports this module; a turn cannot wait on —
 *     or fail because of — a third-party network call. Only the CLI and the dashboard refresh it.
 *  3. IDENTITY-MAPPED OR UNUSED. A catalogue row attaches to our pair only through A1's `sameModel`
 *     (exact id, bare id, or a DECLARED alias). No similarity, no prefixes, no vendor guessing —
 *     an unmatched row is dropped, which is the whole reason the catalogue was chosen over LMArena.
 *  4. PROVENANCE IS PRINTED. `source` + `fetchedAt` travel with every prior to the scorecard.
 *  5. OPT-IN, WITH A TTL. Default OFF (`NUVIRA_CATALOG_FEED`); an EXPIRED snapshot is treated as
 *     absent rather than kept, because a stale prior is worse than none.
 *
 * The snapshot lives in the memory dir and is written through `atomic-store`, so two processes cannot
 * tear it and a reader never parses a half-written file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { withFileLockSync, writeFileAtomicSync } from '../utils/atomic-store.js';
import { sameModel } from './model-identity.js';
// Static, not lazy: nothing imports THIS module, so there is no cycle to avoid — and a lazy `require`
// would simply not exist in this ESM build.
import { computeCostScore } from './auto-router.js';

/** The opt-in switch. Absent / 0 / false / off / no ⇒ DISABLED (rule 5). */
export const CATALOG_FEED_ENV = 'NUVIRA_CATALOG_FEED';

export const CATALOG_FEED_URL = 'https://openrouter.ai/api/v1/models';

/** A snapshot older than this is treated as ABSENT (rule 5), not as a slightly-wrong prior. */
export const CATALOG_FEED_TTL_MS = 24 * 60 * 60 * 1000;

const SNAPSHOT_VERSION = 1;

/**
 * `ecosystem` priors derived from the catalogue's TOOL-SUPPORT fact.
 *
 * WHY THESE NUMBERS ARE ALL BELOW 0.7. §7.2 decided that `ecosystem`'s cold-start prior is 0.5 and that
 * this "keeps a pair OUT of the `Frontier` tier (that needs ≥ 0.7) — a pair we have never watched call a
 * tool is not a frontier agent model". A catalogue row saying `tools` is advertised is still not us
 * having watched it call a tool, so it must not cross that gate either: 0.6 informs the ranking without
 * promoting the tier. The demotion is factual and may be stronger than the promotion — a model the
 * catalogue says CANNOT call tools is a real negative, and no amount of measurement-free optimism should
 * hide it.
 */
export const ECOSYSTEM_PRIOR_WITH_TOOLS = 0.6;
export const ECOSYSTEM_PRIOR_WITHOUT_TOOLS = 0.25;

/** One catalogue row, normalised. Pricing is USD per 1K tokens (the router's own unit). */
export interface CatalogModelRow {
  id: string;
  /** USD per 1K input tokens, from the catalogue's per-token figure. */
  inputPer1K?: number;
  /** USD per 1K output tokens. */
  outputPer1K?: number;
  contextLength?: number;
  /** Lower-cased catalogue parameter names, verbatim. */
  supportedParameters: string[];
}

export interface CatalogSnapshot {
  version: number;
  source: 'openrouter';
  /** Epoch ms of the fetch this snapshot came from. */
  fetchedAt: number;
  ttlMs: number;
  models: Record<string, CatalogModelRow>;
}

/** A prior that knows where it came from — rule 4's whole point. */
export interface ExternalPrior {
  parameter: 'cost' | 'ecosystem';
  /** 0–1, on the scorecard's scale. */
  value: number;
  /** e.g. `openrouter catalogue` — printed beside the number, never omitted. */
  source: string;
  fetchedAt: number;
  /** Human basis: the fact the number was derived FROM (so a reader can disagree with it). */
  basis: string;
}

/**
 * Is the feed switched on?
 *
 * The vocabulary is EXACTLY the dashboard's `asks` rule (`1`/`true`/`yes` enable; everything else,
 * including unset, is off) rather than something friendlier like `truthy`. Two reasons: this switch
 * causes a NETWORK fetch, so an unrecognised value must fail CLOSED; and the dashboard's process-env page
 * states a rule per variable, so a reader that behaved differently from its declared rule would make that
 * page lie — the one thing it exists not to do. `nuvira config catalog-feed set on` writes the canonical `1`.
 */
export function catalogFeedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[CATALOG_FEED_ENV] ?? envBuff(CATALOG_FEED_ENV);
  if (raw === undefined) return false;
  return ['1', 'true', 'yes'].includes(String(raw).trim().toLowerCase());
}

export function catalogSnapshotPath(): string {
  return join(
    envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory'),
    'catalog-feed.json',
  );
}

/** Parse an OpenRouter `/api/v1/models` payload into a snapshot. Pure — no clock, no I/O. */
export function parseOpenRouterModels(payload: unknown, fetchedAt: number): CatalogSnapshot {
  const models: Record<string, CatalogModelRow> = {};
  const data = (payload as { data?: unknown })?.data;
  if (Array.isArray(data)) {
    for (const raw of data as Array<Record<string, unknown>>) {
      const id = typeof raw?.id === 'string' ? raw.id : '';
      if (!id) continue;
      // The catalogue gives USD per TOKEN as a decimal string. This router's pricing unit is per 1K,
      // and the earlier per-1K/per-MTok mix-up is recorded in the parity tracker — so convert exactly
      // once, here, and never re-derive it downstream.
      const prompt = Number((raw.pricing as Record<string, unknown> | undefined)?.prompt);
      const completion = Number((raw.pricing as Record<string, unknown> | undefined)?.completion);
      const context = Number(raw.context_length);
      const params = Array.isArray(raw.supported_parameters)
        ? (raw.supported_parameters as unknown[]).filter((p): p is string => typeof p === 'string')
        : [];
      models[id] = {
        id,
        ...(Number.isFinite(prompt) ? { inputPer1K: prompt * 1000 } : {}),
        ...(Number.isFinite(completion) ? { outputPer1K: completion * 1000 } : {}),
        ...(Number.isFinite(context) && context > 0 ? { contextLength: context } : {}),
        supportedParameters: params.map((p) => p.toLowerCase()),
      };
    }
  }
  return { version: SNAPSHOT_VERSION, source: 'openrouter', fetchedAt, ttlMs: CATALOG_FEED_TTL_MS, models };
}

/**
 * Read the cached snapshot, or `undefined` when there is none OR it has expired.
 *
 * Expiry is deliberately indistinguishable from absence: rule 5 says an expired entry is treated as
 * absent rather than kept, so callers need no separate staleness branch.
 */
export function loadCatalogSnapshot(now: number = Date.now()): CatalogSnapshot | undefined {
  try {
    const path = catalogSnapshotPath();
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as CatalogSnapshot;
    if (!parsed || typeof parsed !== 'object' || !parsed.models) return undefined;
    if (typeof parsed.fetchedAt !== 'number') return undefined;
    const ttl = typeof parsed.ttlMs === 'number' ? parsed.ttlMs : CATALOG_FEED_TTL_MS;
    if (now - parsed.fetchedAt > ttl) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function saveCatalogSnapshot(snapshot: CatalogSnapshot): void {
  const path = catalogSnapshotPath();
  withFileLockSync(`${path}.lock`, () => {
    writeFileAtomicSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  });
}

/** Fetch and store a fresh snapshot. Out-of-band only — the CLI/dashboard call this, the router does not. */
export async function refreshCatalogFeed(
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<{ ok: true; snapshot: CatalogSnapshot } | { ok: false; reason: string }> {
  try {
    const res = await fetchImpl(CATALOG_FEED_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, reason: `catalogue returned HTTP ${res.status}` };
    const snapshot = parseOpenRouterModels(await res.json(), now());
    const count = Object.keys(snapshot.models).length;
    if (count === 0) return { ok: false, reason: 'catalogue returned no models' };
    saveCatalogSnapshot(snapshot);
    return { ok: true, snapshot };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'fetch failed' };
  }
}

/** The catalogue row for OUR `provider × model`, or `undefined` — identity-mapped, never guessed (rule 3). */
export function catalogRowFor(
  provider: string,
  model: string,
  snapshot = loadCatalogSnapshot(),
): CatalogModelRow | undefined {
  if (!snapshot) return undefined;
  // A catalogue row is an OpenRouter row. For any OTHER provider the id may still be the same model
  // (A1's whole subject), so the match goes through `sameModel`, which only widens by DECLARATION.
  if (snapshot.models[model]) return snapshot.models[model];
  for (const row of Object.values(snapshot.models)) {
    if (sameModel(row.id, model)) return row;
  }
  return undefined;
}

/**
 * The priors this feed can supply for one pair, with provenance. Empty when disabled, expired or
 * unmatched — every one of which is a legitimate "no prior", never a invented number.
 */
export function externalPriorsFor(
  provider: string,
  model: string,
  opts: { now?: number; snapshot?: CatalogSnapshot; env?: NodeJS.ProcessEnv } = {},
): ExternalPrior[] {
  // The gate is checked HERE, not at each call site: rule 5 makes the feed opt-in, and a consumer that
  // forgot to ask would silently use priors the operator switched off. One place, impossible to miss.
  if (!catalogFeedEnabled(opts.env)) return [];
  const snapshot = opts.snapshot ?? loadCatalogSnapshot(opts.now ?? Date.now());
  if (!snapshot) return [];
  const row = catalogRowFor(provider, model, snapshot);
  if (!row) return [];

  const priors: ExternalPrior[] = [];
  const base = { source: `${snapshot.source} catalogue`, fetchedAt: snapshot.fetchedAt };

  // `cost` — only from real pricing, only through the router's OWN scoring formula, so a catalogue
  // number lands on the same scale as a measured one instead of on a second, private scale.
  if (typeof row.inputPer1K === 'number' && typeof row.outputPer1K === 'number') {
    const value = computeCostScore('openrouter', {
      inputPer1K: row.inputPer1K,
      outputPer1K: row.outputPer1K,
    });
    priors.push({
      ...base,
      parameter: 'cost',
      value,
      basis: `$${row.inputPer1K.toFixed(5)}/1K in, $${row.outputPer1K.toFixed(5)}/1K out`,
    });
  }

  // `ecosystem` — from the TOOL-SUPPORT fact only. The context window is deliberately NOT scored here:
  // it already reaches routing as `contextWindowTokens` from the listModels probe, so turning it into a
  // second, invented 0–1 curve would be a number nobody measured.
  if (row.supportedParameters.length > 0) {
    const hasTools = row.supportedParameters.some((p) => p === 'tools' || p === 'tool_choice');
    priors.push({
      ...base,
      parameter: 'ecosystem',
      value: hasTools ? ECOSYSTEM_PRIOR_WITH_TOOLS : ECOSYSTEM_PRIOR_WITHOUT_TOOLS,
      basis: hasTools ? 'catalogue advertises tool calling' : 'catalogue advertises no tool calling',
    });
  }

  return priors;
}
