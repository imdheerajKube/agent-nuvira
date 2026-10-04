/**
 * The model/provider counts shown on Overview, Timeline and the Models page.
 *
 * WHY ONE HOOK AND ONE ENDPOINT. These three pages used to headline different
 * numbers under the same word "models"/"providers" — the Models page counted
 * the LIVE provider listing, while Overview and the Timeline counted the
 * registry — so a reader comparing tabs saw 509 in one place and 561 in another
 * and reasonably concluded one of them was wrong. Both numbers are real; they
 * answer different questions. The fix is to fetch them from ONE source
 * (`/api/model-counts`) and always render them with their labels attached, so
 * "Tracked (registry)" matches everywhere and "Listed by providers (live
 * probe)" matches everywhere.
 *
 * Server-side the expensive live probe is cached for a minute, so polling this
 * hook is cheap and all three pages share the same snapshot.
 */

import { useEffect, useState } from 'react';

export interface ModelCounts {
  /** Registry entries routing consults (provider × model pairs it has learned). */
  trackedModels: number;
  /** Distinct providers the registry knows about. */
  trackedProviders: number;
  /** Models the providers currently advertise (live probe). */
  listedModels: number;
  /** Providers that answered the live probe. */
  listedProviders: number;
  /** Epoch ms of the live listing, or 0 when it has never been taken. */
  listingAt: number;
}

/** Poll every 60s (the server caches the live probe for the same window). */
export const MODEL_COUNTS_POLL_MS = 60_000;

export function useModelCounts(pollMs: number = MODEL_COUNTS_POLL_MS): ModelCounts | null {
  const [counts, setCounts] = useState<ModelCounts | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/model-counts')
        .then((r) => (r.ok ? r.json() : null))
        .then((d: ModelCounts | null) => {
          if (!cancelled && d && typeof d.trackedModels === 'number') setCounts(d);
        })
        .catch(() => {
          /* keep the last good snapshot */
        });
    };
    load();
    const timer = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollMs]);

  return counts;
}
