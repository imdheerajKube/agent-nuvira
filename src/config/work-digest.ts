/**
 * Work-digest scope — WHO gets the loop's within-turn compaction digest.
 *
 * The digest itself (see `tools/tool-loop.ts`) is deterministic and additive:
 * when the thread is compacted, the loop injects one bounded record of what the
 * turn has DONE (files changed, commands + verdicts, tools used) so a long turn
 * does not lose its own history when old tool output is trimmed.
 *
 * It is ON for every mode by default, because losing the verdict of what you ran
 * is a defect in any mode. But a user who wants the very leanest `balanced`
 * prompt can scope it to `max` (the mode that already trades cost for depth), or
 * turn it off entirely. Three values:
 *
 *   - `all` (DEFAULT) — inject on every compaction, in every mode. Recommended.
 *   - `max` — inject ONLY under the `max` capability mode; `balanced` stays
 *     exactly as it was before the digest existed.
 *   - `off` — never inject.
 *
 * Resolution order (highest wins): the process environment (`NUVIRA_WORK_DIGEST`,
 * or the legacy `BUFF_WORK_DIGEST`), then `routing.workDigest` in the config
 * file, then the default. Pure and never throws — a broken config read falls
 * back to the default rather than breaking a turn.
 */

import type { ConfigManager } from './manager.js';
import { isMaxCapability } from './capability-mode.js';

/** Who receives the within-turn work digest. */
export type WorkDigestScope = 'all' | 'max' | 'off';

/** The default when nothing is configured — the digest is a pure improvement. */
export const DEFAULT_WORK_DIGEST_SCOPE: WorkDigestScope = 'all';

/** Env names, `NUVIRA_*` first with the legacy `BUFF_*` alias accepted. */
const ENV_NAMES = ['NUVIRA_WORK_DIGEST', 'BUFF_WORK_DIGEST'];

/**
 * Parse a raw value into a scope. Intuitive synonyms are accepted so a typo
 * cannot silently change behavior; returns null for anything unrecognized (the
 * caller then falls through to the next source rather than guessing).
 *   - all / always / on / true / 1        → 'all'
 *   - max / performance / performance-first → 'max'
 *   - off / none / never / false / 0      → 'off'
 */
export function parseWorkDigestScope(raw: string | undefined | null): WorkDigestScope | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'all' || v === 'always' || v === 'on' || v === 'true' || v === '1') return 'all';
  if (v === 'max' || v === 'performance' || v === 'performance-first') return 'max';
  if (v === 'off' || v === 'none' || v === 'never' || v === 'false' || v === '0') return 'off';
  return null;
}

/** The effective scope for this process. Env, then config, then the default. */
export function resolveWorkDigestScope(cm?: ConfigManager): WorkDigestScope {
  for (const name of ENV_NAMES) {
    const parsed = parseWorkDigestScope(process.env[name]);
    if (parsed) return parsed;
  }
  try {
    const routing = cm?.getAll?.()?.routing as { workDigest?: unknown } | undefined;
    const parsed = parseWorkDigestScope(typeof routing?.workDigest === 'string' ? routing.workDigest : undefined);
    if (parsed) return parsed;
  } catch {
    // Best-effort — a config failure must not break a turn.
  }
  return DEFAULT_WORK_DIGEST_SCOPE;
}

/**
 * Is the digest ACTIVE for this turn? Folds the scope together with the
 * capability mode so the loop has one question to ask: `scope === 'max'` is the
 * only case that depends on anything besides itself.
 */
export function isWorkDigestEnabled(cm?: ConfigManager): boolean {
  const scope = resolveWorkDigestScope(cm);
  if (scope === 'all') return true;
  if (scope === 'off') return false;
  return isMaxCapability(cm);
}
