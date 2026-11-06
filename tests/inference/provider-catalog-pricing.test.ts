/**
 * Catalog pricing PROVENANCE — where each price came from, and how old it is.
 *
 * The defect this pins: `pricing` used to be two bare numbers per provider. Four
 * numbers with no date cannot be wrong in a way anybody notices, so a provider
 * that re-priced in June kept billing at the January rate, and every dollar the
 * ledger derived from it (and every turn line that quoted one) carried that error
 * silently. A price is now only allowed to exist WITH the page that justifies it
 * and the day it was last changed.
 *
 * What this file does NOT claim: that the numbers are correct. Checking 23
 * providers' price pages is not a unit test. It claims (a) nobody can add a price
 * without saying where it came from, (b) nobody can leave one undated, and (c) a
 * price that has gone a year without being revisited fails the build instead of
 * quietly pricing calls. Correctness is `stats cost reconcile`'s job — it compares
 * the ledger to the provider's OWN invoice, which is the only thing that settles it.
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG_PROVIDER_IDS,
  PRICING_MAX_AGE_DAYS,
  PROVIDER_CATALOG,
  catalogPricing,
  pricingAgeDays,
} from '../../src/inference/provider-catalog.js';

/** A priced provider that is not free by construction (so its source must be a page). */
function isZeroPriced(id: string): boolean {
  const p = PROVIDER_CATALOG[id]?.pricing;
  return p.inputPer1K === 0 && p.outputPer1K === 0;
}

describe('catalog pricing — every price names its evidence', () => {
  it('covers every catalog provider', () => {
    for (const id of CATALOG_PROVIDER_IDS) {
      expect(PROVIDER_CATALOG[id]?.pricing, `${id} has no pricing entry`).toBeDefined();
    }
  });

  it('states a source for every price', () => {
    for (const id of CATALOG_PROVIDER_IDS) {
      const source = PROVIDER_CATALOG[id].pricing.source;
      expect(typeof source, `${id}: source is not a string`).toBe('string');
      expect(source.trim().length, `${id}: empty price source`).toBeGreaterThan(0);
    }
  });

  it('gives a NON-ZERO price a page to re-check, not a claim', () => {
    // A zero price is a property of the runtime (local, a keyless gateway) and the
    // honest source is the fact that makes it zero. A non-zero price is a market
    // number, and a market number with no page behind it is a guess.
    for (const id of CATALOG_PROVIDER_IDS) {
      if (isZeroPriced(id)) continue;
      const source = PROVIDER_CATALOG[id].pricing.source;
      expect(
        source.startsWith('https://'),
        `${id}: priced provider must name an https page, got "${source}"`,
      ).toBe(true);
    }
  });

  it('dates every price with a real ISO day', () => {
    for (const id of CATALOG_PROVIDER_IDS) {
      const asOf = PROVIDER_CATALOG[id].pricing.asOf;
      expect(asOf, `${id}: no asOf date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(pricingAgeDays(asOf), `${id}: unparseable asOf "${asOf}"`).not.toBeUndefined();
    }
  });

  it('refuses a price dated in the future', () => {
    // A future date would buy a year of unearned freshness — the exact cheat the
    // date exists to prevent.
    for (const id of CATALOG_PROVIDER_IDS) {
      const age = pricingAgeDays(PROVIDER_CATALOG[id].pricing.asOf)!;
      expect(age, `${id}: asOf is in the future`).toBeGreaterThanOrEqual(0);
    }
  });

  it(`fails when a price has not been revisited in ${PRICING_MAX_AGE_DAYS} days`, () => {
    const stale = CATALOG_PROVIDER_IDS.map((id) => {
      const p = PROVIDER_CATALOG[id].pricing;
      return { id, age: pricingAgeDays(p.asOf)!, asOf: p.asOf, source: p.source };
    }).filter((r) => r.age > PRICING_MAX_AGE_DAYS);

    // The failure message is the remedy: it says which provider, how old, and the
    // page to check — so this is actionable from CI alone.
    expect(
      stale.map((r) => `${r.id}: ${r.asOf} (${r.age}d old) — re-check ${r.source}`),
      'stale catalog prices',
    ).toEqual([]);
  });

  it('hands the age through the helper the accounting path reads', () => {
    // Structural guard: `catalogPricing()` is what `model-pricing` prices a call
    // from. A refactor that returned only the two numbers would drop the age from
    // every surface downstream, and nothing else in this file would notice.
    for (const id of CATALOG_PROVIDER_IDS) {
      const p = catalogPricing(id)!;
      expect(p.asOf, `${id}: catalogPricing dropped asOf`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.source.length, `${id}: catalogPricing dropped source`).toBeGreaterThan(0);
    }
  });
});
