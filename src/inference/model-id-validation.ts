/**
 * Model-id validation — the value saved as `providers.<type>.model` is checked
 * against the provider that will serve it, BEFORE it is persisted.
 *
 * WHY (A3). A config held `providers.deepseek.model = "DeepSeek-V4.1-Flash"`,
 * which the DeepSeek API rejects ("supported names are deepseek-flash,
 * deepseek-v4-pro"). At CALL time the router *repairs* a dead model
 * (`model-validator.resolveWorkingModel`) — but the repair is a substitution,
 * which is exactly what strict mode forbids and what produces the "the model
 * you pinned was not the model that ran" class of bug. Catching it at the
 * SAVE boundary is the only place a wrong id is genuinely cheap to fix: the
 * user is right there, and a suggestion is actionable.
 *
 * The rule is the same for every provider and every model — no per-provider
 * allow-list lives here:
 *   1. `default` (and the provider's own curated default) are always accepted.
 *   2. Ask the provider for its LIVE model list and accept the id only when it
 *      is present.
 *   3. When the list cannot be fetched (no key, offline, keyless endpoint
 *      down) the id is accepted UNVERIFIED — blocking a save because the
 *      provider is unreachable would make offline configuration impossible.
 *   4. When the list IS available and the id is absent, reject it and name the
 *      closest matches, so the failure is a typo corrected, not a run that
 *      silently substitutes.
 *
 * It is deliberately best-effort: validation must never throw into a caller and
 * must never be the reason a legitimate configuration cannot be saved.
 */

import type { ModelDescriptor } from './interface.js';
import type { ProviderConfig } from '../config/types.js';
import type { ConfigManager } from '../config/manager.js';
import { ProviderFactory } from './factory.js';
import { getDefaultModel } from './provider-catalog.js';

export interface ModelIdVerdict {
  /** False only when the live list was available AND lacked the id. */
  ok: boolean;
  /** True only when the live list was available and the id was present. */
  verified: boolean;
  /** The live model ids the provider reported (when available). */
  available?: string[];
  /** Closest ids to the rejected one, best first. */
  suggestions?: string[];
  /** A one-line reason, ready to show a user (present only when `!ok`). */
  message?: string;
}

/** Levenshtein distance, bounded — used only to rank suggestions. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

/**
 * Rank candidate ids for a rejected one. A substring hit ("flash" in
 * "deepseek-flash") beats edit distance, because model families share a
 * family token and differ in the tier — the suggestion a user wants is usually
 * the same family, not the lexically nearest string.
 */
export function suggestModelIds(wanted: string, ids: string[], max = 5): string[] {
  const lower = wanted.toLowerCase();
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const scored = ids.map((id) => {
    const lid = id.toLowerCase();
    let score = 0;
    for (const t of tokens) if (lid.includes(t)) score -= 100;
    if (lid.includes(lower) || lower.includes(lid)) score -= 200;
    score += editDistance(lower, lid);
    return { id, score };
  });
  scored.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  return scored.slice(0, max).map((s) => s.id);
}

/**
 * Validate `model` against `providerType`'s live list. Never throws.
 *
 * `configManager` supplies the provider's credentials/baseUrl; when omitted the
 * adapter is built from an empty config (fine for keyless endpoints, and it
 * simply yields an unverifiable verdict when a key is missing).
 */
export async function validateModelIdForProvider(
  providerType: string,
  model: string,
  configManager?: ConfigManager,
): Promise<ModelIdVerdict> {
  const wanted = (model ?? '').trim();
  // Empty / sentinel / curated default: there is nothing to verify, and the
  // router resolves these itself.
  if (!wanted || wanted === 'default') return { ok: true, verified: false };
  const curated = getDefaultModel(providerType);
  if (curated && wanted === curated) return { ok: true, verified: false };

  let provider;
  try {
    const cfg = (configManager?.getAll?.()?.providers?.[providerType] ?? {}) as ProviderConfig;
    provider = ProviderFactory.createProvider(providerType, { ...cfg, model: wanted });
  } catch {
    // Unknown / plugin provider with no adapter — cannot verify; do not block.
    return { ok: true, verified: false };
  }

  let models: ModelDescriptor[] = [];
  try {
    models = await provider.listModels();
  } catch {
    models = [];
  }
  const ids = models.map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0);

  // No live list: unreachable, keyless endpoint down, or an empty catalog. An
  // unverifiable id is ACCEPTED — offline configuration stays possible.
  if (ids.length === 0) return { ok: true, verified: false };

  if (ids.includes(wanted)) return { ok: true, verified: true, available: ids };

  const suggestions = suggestModelIds(wanted, ids);
  return {
    ok: false,
    verified: true,
    available: ids,
    suggestions,
    message:
      `'${wanted}' is not a model '${providerType}' serves` +
      (suggestions.length > 0 ? ` — did you mean ${suggestions.map((s) => `'${s}'`).join(', ')}?` : '.'),
  };
}
