/**
 * CostDashboard — the cost-basis split.
 *
 * The dashboard must show spend by how it was KNOWN: measured token counts,
 * length-based estimates, and — separately — the exact figure a provider
 * reported. That last one is a subset of measured spend and is what makes a
 * free/subscription call's true $0 visible instead of a generic rate.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import CostDashboard from './CostDashboard';
import type { DashboardData, CostData } from '../types';

function cost(overrides: Partial<CostData> = {}): CostData {
  return {
    totalRequests: 2,
    totalCost: 0.02,
    totalTokens: 4900,
    byProvider: { openrouter: 0, anthropic: 0.02 },
    byModel: { 'claude-3.5-sonnet': 0.02 },
    byProviderMeasured: { anthropic: 0.02 },
    byProviderReported: { openrouter: 0 },
    measuredCalls: 2,
    estimatedCalls: 0,
    measuredCost: 0.02,
    estimatedCost: 0,
    reportedCalls: 1,
    reportedCost: 0,
    recent: [
      { provider: 'anthropic', model: 'claude-3.5-sonnet', costUsd: 0.02, totalTokens: 4000, timestamp: Date.now(), measured: true, reported: false },
      { provider: 'openrouter', model: 'llama-3.3-70b-instruct:free', costUsd: 0, totalTokens: 900, timestamp: Date.now(), measured: true, reported: true },
    ],
    ...overrides,
  };
}

function data(c: CostData): DashboardData {
  return { cost: c } as unknown as DashboardData;
}

describe('CostDashboard', () => {
  afterEach(cleanup);

  it('shows the provider-reported split as a subset of measured spend', () => {
    render(<CostDashboard data={data(cost())} />);

    expect(screen.getByText('📏 Measured (exact wire tokens)')).toBeTruthy();
    expect(screen.getByText('📐 Estimated (length-based)')).toBeTruthy();
    expect(screen.getByText('🧾 of which provider-reported (exact billed)')).toBeTruthy();
    // One reported call, and it is a true $0 (the free model).
    expect(screen.getByText('1 calls')).toBeTruthy();
  });

  it('shows the provider-reported figure on the By Provider row that has one', () => {
    render(<CostDashboard data={data(cost())} />);

    // Provider rows render in descending spend: anthropic then openrouter.
    // (Each name also appears on its recent-request row.)
    expect(screen.getAllByText('anthropic').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('openrouter').length).toBeGreaterThanOrEqual(1);
    // openrouter reported $0 — the chip appears (here and on its recent row).
    expect(screen.getAllByText('🧾 $0.00').length).toBeGreaterThanOrEqual(1);
  });

  it('marks only provider-reported recent rows with the 🧾 badge', () => {
    render(<CostDashboard data={data(cost())} />);

    // The free OpenRouter row: reported, $0, badged (appears on its provider
    // row and its recent row).
    expect(screen.getAllByText(/🧾 \$0\.00/).length).toBeGreaterThanOrEqual(1);
    // The anthropic row is locally priced, not reported — no badge.
    expect(screen.queryByText(/🧾 \$0\.02/)).toBeNull();
  });

  // ── The evidence split (2026-10-15) ──────────────────────────────────────
  // The page used to headline ONE number — the sum of a column the ledger had
  // priced from its own hardcoded table — under the words "Total Spent". These
  // pin the replacement: billed (with its evidence), the value a free tier
  // absorbed, list-priced rows whose tier is undeclared, and calls with no price
  // at all. Each is a different claim and none may be read as another.
  describe('the billed / value / unverified / unpriced split', () => {
    function classified(overrides: Partial<CostData> = {}): CostData {
      return cost({
        billedUsd: 5.94,
        billedReportedUsd: 0,
        billedListedUsd: 5.94,
        billedReportedCalls: 0,
        billedListedCalls: 1778,
        unverifiedListedUsd: 0.86,
        unverifiedListedCalls: 2364,
        notBilledValueUsd: 0.4,
        notBilledValueCalls: 335,
        unpricedCalls: 82,
        unpricedTokens: 164,
        recomputedCalls: 9405,
        testOriginCalls: 747,
        byProviderBilled: { anthropic: 5.94 },
        byProviderUnverified: { groq: 0.86 },
        byProviderValue: { omniroute: 0.4 },
        byProviderUnpricedCalls: { azure: 82 },
        ...overrides,
      });
    }

    it('headlines the billed figure with its evidence, never the recorded total', () => {
      render(<CostDashboard data={data(classified())} />);
      expect(screen.getByText('🧾 Billed (evidence)')).toBeTruthy();
      expect(screen.getByText('$5.9400')).toBeTruthy();
      // The recorded ledger total ($0.02 in the base fixture) is not the headline.
      expect(screen.queryByText('Total Spent')).toBeNull();
    });

    it('separates the free-tier value from spend', () => {
      render(<CostDashboard data={data(classified())} />);
      expect(screen.getByText('🎁 Value absorbed by free/subscription')).toBeTruthy();
      expect(screen.getByText(/calls — at list price, NOT billed/)).toBeTruthy();
    });

    it('shows undeclared-tier rows as unverified, not as spend', () => {
      render(<CostDashboard data={data(classified())} />);
      expect(screen.getByText('❓ List-priced, billing tier undeclared')).toBeTruthy();
      expect(screen.getByText(/not counted as spend/)).toBeTruthy();
    });

    it('reports unpriced calls as a count, with no invented dollars', () => {
      render(<CostDashboard data={data(classified())} />);
      expect(screen.getByText('⚪ Unpriced (no price evidence / gateway)')).toBeTruthy();
      expect(screen.getByText('82')).toBeTruthy();
      expect(screen.getByText(/tokens, no dollars/)).toBeTruthy();
    });

    it('says how to declare a tier, how to reconcile, and what was re-derived or excluded', () => {
      render(<CostDashboard data={data(classified())} />);
      expect(screen.getByText(/billingTier paid/)).toBeTruthy();
      expect(screen.getAllByText(/stats cost reconcile/).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText(/9405 row\(s\) predate cost classification/)).toBeTruthy();
      expect(screen.getByText(/747 test-origin row\(s\) excluded/)).toBeTruthy();
    });

    it('renders no split at all for a server that predates it', () => {
      render(<CostDashboard data={data(cost())} />);
      expect(screen.queryByText('🧾 Billed (evidence)')).toBeNull();
      expect(screen.getByText('Ledger total (as recorded)')).toBeTruthy();
    });
  });

  // ── Recent requests: one call, one claim ─────────────────────────────────
  // The list used to print `req.costUsd` with at most a 🧾 badge for a
  // provider-reported figure, so a list-priced call on an undeclared tier and a
  // billed one looked the same. Each row now carries its own one-call spend, and
  // renders with the marks the CLI and the batch table use.
  describe('recent requests say which dollar they are', () => {
    const oneCall = (over: Partial<NonNullable<CostData['recent']>[number]['spend']> = {}) => ({
      tokens: 1000,
      calls: 1,
      reportedCalls: 0,
      exactUsd: 0,
      listedCalls: 0,
      estimatedUsd: 0,
      unverifiedCalls: 0,
      unverifiedUsd: 0,
      unverifiedProviders: [],
      freeCalls: 0,
      freeValueUsd: 0,
      unpricedCalls: 0,
      ...over,
    });

    it('prints an exact figure, an undeclared-tier estimate and a free call differently', () => {
      render(
        <CostDashboard
          data={data(
            cost({
              recent: [
                {
                  provider: 'groq', model: 'llama-3.3-70b', costUsd: 0.002, totalTokens: 1000,
                  timestamp: Date.now(), measured: true, reported: true,
                  spend: oneCall({ reportedCalls: 1, exactUsd: 0.002 }),
                },
                {
                  provider: 'nim', model: 'llama-3.1-8b', costUsd: 0, totalTokens: 800,
                  timestamp: Date.now(), measured: true, reported: false,
                  spend: oneCall({ unverifiedCalls: 1, unverifiedUsd: 0.0012, unverifiedProviders: ['nim'] }),
                },
                {
                  provider: 'local', model: 'qwen2.5:0.5b', costUsd: 0, totalTokens: 400,
                  timestamp: Date.now(), measured: true, reported: false,
                  spend: oneCall({ tokens: 400, freeCalls: 1, freeValueUsd: 0.0004 }),
                },
              ],
            }),
          )}
        />,
      );

      // Provider-stated: the 🧾 badge, and no estimate mark.
      expect(screen.getByText('🧾 $0.002000')).toBeTruthy();
      // List price on an undeclared tier: an estimate that may not be spend.
      expect(screen.getByText('~$0.001200?')).toBeTruthy();
      // A local runtime is provably free — said as a word, not as a dollar.
      expect(screen.getByText('free')).toBeTruthy();
      // The marks are explained, with the one command that makes them exact.
      expect(screen.getByText(/declare providers\.<id>\.billingTier/)).toBeTruthy();
    });

    it('falls back to the reported badge alone for a server that sends no per-row spend', () => {
      render(<CostDashboard data={data(cost())} />);
      // The legacy rows are unchanged: a reported $0 keeps its badge, a locally
      // priced row prints its figure with no invented marks.
      expect(screen.getAllByText(/🧾 \$0\.00/).length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByTestId(/spend-legend/)).toBeNull();
    });
  });

  // ── Invoice checks (2026-10-15) ──────────────────────────────────────────
  // Every figure on the page above is an ESTIMATE of money owed. The only way to
  // earn the word "actual" is the provider's own number, entered with
  // `nuvira stats cost reconcile`. These pin that the page (a) says when nothing
  // has been checked rather than letting the estimate pass as a bill, and (b)
  // shows the two figures, the delta and the verdict when a check exists.
  describe('reconciliation against a provider invoice', () => {
    it('says no invoice has been checked, and how to check one', () => {
      render(<CostDashboard data={data(cost())} />);
      expect(screen.getByText('Checked against a provider invoice')).toBeTruthy();
      expect(screen.getByText(/Nothing checked yet/)).toBeTruthy();
      expect(screen.getAllByText(/stats cost reconcile/).length).toBeGreaterThanOrEqual(1);
    });

    it('shows the invoice, the ledger figure and the verdict for a check that ran', () => {
      render(
        <CostDashboard
          data={data(
            cost({
              reconciliations: [
                {
                  provider: 'deepseek',
                  invoiceUsd: 17.42,
                  billedUsd: 17.39,
                  deltaUsd: 0.03,
                  verdict: 'under-evidenced',
                  since: Date.now() - 86400000 * 30,
                  until: Date.now(),
                  recordedAt: Date.now(),
                  note: 'dashboard, Oct 2026',
                },
              ],
            }),
          )}
        />,
      );
      expect(screen.getByText('invoice $17.4200')).toBeTruthy();
      expect(screen.getByText('ledger $17.3900')).toBeTruthy();
      expect(screen.getByText(/under-evidenced by \$0\.0300/)).toBeTruthy();
    });

    it('marks the billing tier the invoice PROVED, when it proved one', () => {
      render(
        <CostDashboard
          data={data(
            cost({
              reconciliations: [
                {
                  provider: 'openrouter',
                  invoiceUsd: 0,
                  billedUsd: 0,
                  deltaUsd: 0,
                  verdict: 'match',
                  since: Date.now() - 86400000,
                  until: Date.now(),
                  recordedAt: Date.now(),
                  tier: 'free',
                },
              ],
            }),
          )}
        />,
      );
      expect(screen.getByText('✅ match')).toBeTruthy();
      expect(screen.getByText(/key is free/)).toBeTruthy();
    });
  });
});
