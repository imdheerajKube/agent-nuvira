import type { DashboardData } from '../types';
import { formatCount } from '../format';
import PageHeader from './PageHeader';

interface CostDashboardProps {
  data: DashboardData | null;
}

function formatCost(usd: number | undefined): string {
  if (usd === undefined || usd === null) return '$0.00';
  if (usd < 0.00001) return '$0.00';
  if (usd < 0.01) return '$' + usd.toFixed(6);
  return '$' + usd.toFixed(4);
}

function formatNumber(n: number | undefined): string {
  if (n === undefined || n === null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return formatCount(n);
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * The Cost page.
 *
 * THE HEADLINE IS NOT "TOTAL SPENT". The ledger cannot see a provider's invoice,
 * so this page reports what it can EVIDENCE and says so, in four buckets:
 *
 *   🧾 Billed        provider-reported (exact) + list-priced with a declared paid
 *                    account (an estimate of money owed).
 *   🎁 Value         the list price of calls a free/subscription tier absorbed —
 *                    never counted as spend.
 *   ❓ Unverified    list-priced calls whose account tier is undeclared. Shown
 *                    because hiding them would under-report a real bill, but
 *                    never counted as spend either.
 *   ⚪ Unpriced      calls with no price evidence at all (an unknown provider, or
 *                    a keyless pass-through gateway whose upstream bill is not
 *                    visible here).
 *
 * It used to print one number — the sum of a column the ledger had priced from its
 * own hardcoded table — under the words "Total Spent". On a real profile that read
 * $7.21 while inventing ~$1.26 of spend for free/self-hosted usage and
 * under-reporting the only paid provider by ~3×.
 */
export default function CostDashboard({ data }: CostDashboardProps) {
  if (!data) {
    // The header stays while the data arrives. It used to be skipped in this
    // branch, so a page that was still loading had no heading at all — the only
    // headings on screen were the sidebar's, and "which page am I on" was
    // unanswerable from the page itself.
    return (
      <>
        <PageHeader icon="💰" title="Cost Tracking" />
        <div className="loading-state"><p>Loading cost data...</p></div>
      </>
    );
  }

  const { cost } = data;
  // An older server sends no classification; fall back to the recorded total so the
  // page still works, and the label below says which number it is showing.
  const classified = cost.billedUsd !== undefined;
  const billed = cost.billedUsd ?? cost.totalCost;
  const byProvider = Object.entries(cost.byProvider || {}).sort(([, a], [, b]) => b - a);
  const byModel = Object.entries(cost.byModel || {}).sort(([, a], [, b]) => b - a).slice(0, 10);
  const providerTotal = byProvider.reduce((s, [, v]) => s + v, 0);
  const notes: string[] = [];
  if (cost.recomputedCalls) {
    notes.push(
      `${cost.recomputedCalls} row(s) predate cost classification and were re-derived here (the ledger file was not rewritten).`,
    );
  }
  if (cost.testOriginCalls) {
    notes.push(`${cost.testOriginCalls} test-origin row(s) excluded — a test run is not your usage.`);
  }

  return (
    <>
      <PageHeader icon="💰" title="Cost Tracking" />

      <div className="cost-summary">
        <div className="cost-total">
          <span className="cost-label">{classified ? '🧾 Billed (evidence)' : 'Ledger total (as recorded)'}</span>
          <span className="cost-amount">{formatCost(billed)}</span>
          {classified ? (
            <span className="cost-label">
              🧾 exact {formatCost(cost.billedReportedUsd)} · 📋 list-estimated {formatCost(cost.billedListedUsd)}
            </span>
          ) : (
            <span className="cost-label">this server predates the billed/value split</span>
          )}
        </div>
        <div className="cost-total">
          <span className="cost-label">Total Tokens</span>
          <span className="cost-amount">{formatNumber(cost.totalTokens)}</span>
        </div>
        <div className="cost-total">
          <span className="cost-label">Total Requests</span>
          <span className="cost-amount">{formatNumber(cost.totalRequests)}</span>
        </div>
      </div>

      {classified && (
        <div className="cost-summary cost-summary-sub">
          <div className="cost-total">
            <span className="cost-label">🎁 Value absorbed by free/subscription</span>
            <span className="cost-amount">{formatCost(cost.notBilledValueUsd)}</span>
            <span className="cost-label">
              {formatNumber(cost.notBilledValueCalls)} calls — at list price, NOT billed
            </span>
          </div>
          <div className="cost-total">
            <span className="cost-label">❓ List-priced, billing tier undeclared</span>
            <span className="cost-amount">{formatCost(cost.unverifiedListedUsd)}</span>
            <span className="cost-label">
              {formatNumber(cost.unverifiedListedCalls)} calls — not counted as spend
            </span>
          </div>
          <div className="cost-total">
            <span className="cost-label">⚪ Unpriced (no price evidence / gateway)</span>
            <span className="cost-amount">{formatNumber(cost.unpricedCalls)}</span>
            <span className="cost-label">{formatNumber(cost.unpricedTokens)} tokens, no dollars</span>
          </div>
        </div>
      )}

      <div className="cost-summary cost-summary-sub">
        <div className="cost-total">
          <span className="cost-label">📏 Measured (exact wire tokens)</span>
          <span className="cost-amount">{formatCost(cost.measuredCost)}</span>
          <span className="cost-label">{formatNumber(cost.measuredCalls)} calls</span>
        </div>
        <div className="cost-total">
          <span className="cost-label">📐 Estimated (length-based)</span>
          <span className="cost-amount">{formatCost(cost.estimatedCost)}</span>
          <span className="cost-label">{formatNumber(cost.estimatedCalls)} calls</span>
        </div>
        <div className="cost-total">
          {/* Provider-reported is a SUBSET of measured spend, so it is labelled
              "of which" — a free/subscription call's exact $0 shows here. */}
          <span className="cost-label">🧾 of which provider-reported (exact billed)</span>
          <span className="cost-amount">{formatCost(cost.reportedCost)}</span>
          <span className="cost-label">{formatNumber(cost.reportedCalls)} calls</span>
        </div>
      </div>

      {classified && (
        <p className="cost-note">
          Billed = calls with evidence (the provider's own figure, or a list price on an account you declared
          <code> providers.&lt;id&gt;.billingTier paid</code>). Value is what a free tier saved; unverified rows are
          priced but unclaimed. Reconcile against a provider invoice with
          <code> nuvira stats cost reconcile --provider &lt;id&gt; --amount &lt;usd&gt;</code>.
          {notes.length > 0 && <> {notes.join(' ')}</>}
        </p>
      )}

      <h2 className="section-subtitle">Checked against a provider invoice</h2>
      <div className="cost-list">
        {(!cost.reconciliations || cost.reconciliations.length === 0) ? (
          <div className="empty-state">
            Nothing checked yet. Everything above is an ESTIMATE of money owed — the only "actual" figure is the
            provider's own, and this ledger cannot see it. Enter one with <code> nuvira stats cost reconcile
            --provider &lt;id&gt; --amount &lt;usd&gt;</code>.
          </div>
        ) : (
          cost.reconciliations.map((rec) => (
            <div className="cost-row" key={`${rec.provider}-${rec.recordedAt}`}>
              <span className="cost-row-name">{rec.provider}</span>
              <div className="cost-row-bar">
                <div
                  className="cost-row-fill"
                  style={{
                    width: `${rec.invoiceUsd > 0 ? Math.min(100, (rec.billedUsd / rec.invoiceUsd) * 100) : 0}%`,
                  }}
                />
              </div>
              <span className="cost-row-value">invoice {formatCost(rec.invoiceUsd)}</span>
              <span className="cost-row-reported" title="What this ledger could evidence for the same window">
                ledger {formatCost(rec.billedUsd)}
              </span>
              <span
                className="cost-row-reported"
                title={
                  rec.verdict === 'match'
                    ? 'The invoice and this ledger agree'
                    : rec.verdict === 'under-evidenced'
                      ? 'The provider charged more than this ledger can prove'
                      : 'This ledger claims more than the provider charged'
                }
              >
                {rec.verdict === 'match' ? '✅ match' : rec.verdict === 'under-evidenced' ? '⚠️ under-evidenced' : '⚠️ over-recorded'}
                {rec.verdict !== 'match' ? ` by ${formatCost(Math.abs(rec.deltaUsd))}` : ''}
              </span>
              {rec.tier && (
                <span className="cost-row-reported" title="Billing tier the invoice PROVED — not assumed">
                  🔑 key is {rec.tier}
                </span>
              )}
              <span className="request-time">checked {formatTime(rec.recordedAt)}</span>
            </div>
          ))
        )}
      </div>

      <h2 className="section-subtitle">By Provider</h2>
      <div className="cost-list">
        {byProvider.length === 0 ? (
          <div className="empty-state">No costs recorded yet.</div>
        ) : (
          byProvider.map(([provider, amount]) => {
            const pct = providerTotal > 0 ? ((amount / providerTotal) * 100).toFixed(1) : '0';
            const reported = cost.byProviderReported?.[provider];
            const providerBilled = cost.byProviderBilled?.[provider];
            const unverified = cost.byProviderUnverified?.[provider];
            const value = cost.byProviderValue?.[provider];
            const unpriced = cost.byProviderUnpricedCalls?.[provider];
            return (
              <div className="cost-row" key={provider}>
                <span className="cost-row-name">{provider}</span>
                <div className="cost-row-bar">
                  <div className="cost-row-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="cost-row-value">{formatCost(amount)}</span>
                {/* Per-provider provider-REPORTED spend — the exact billed
                    figure, a subset of the total (shown only when reported). */}
                {typeof reported === 'number' && (
                  <span className="cost-row-reported" title="Provider-reported (exact billed) cost">🧾 {formatCost(reported)}</span>
                )}
                {/* The evidence split for this provider. Deliberately WORDED rather
                    than glyphed like the provider-reported chip above: "billed"
                    (an estimate from a declared paid account) and "reported" (the
                    provider's exact figure) are different claims, and one badge
                    for both would let a reader merge them. */}
                {typeof providerBilled === 'number' && providerBilled > 0 && (
                  <span className="cost-row-reported" title="Billed (evidence) for this provider">
                    billed {formatCost(providerBilled)}
                  </span>
                )}
                {typeof value === 'number' && value > 0 && (
                  <span className="cost-row-reported" title="List-price value absorbed by a free/subscription tier — not spend">
                    value {formatCost(value)}
                  </span>
                )}
                {typeof unverified === 'number' && unverified > 0 && (
                  <span className="cost-row-reported" title="List-priced with the billing tier undeclared — not counted as spend">
                    unverified {formatCost(unverified)}
                  </span>
                )}
                {typeof unpriced === 'number' && unpriced > 0 && (
                  <span className="cost-row-reported" title="Calls with no price evidence (unknown provider, or a pass-through gateway)">
                    {unpriced} uncosted
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      <h2 className="section-subtitle">By Model</h2>
      <div className="cost-list">
        {byModel.length === 0 ? (
          <div className="empty-state">No model costs recorded yet.</div>
        ) : (
          byModel.map(([model, amount]) => {
            const pct = providerTotal > 0 ? ((amount / providerTotal) * 100).toFixed(1) : '0';
            const displayModel = model.length > 30 ? model.slice(0, 28) + '..' : model;
            const value = cost.byModelValue?.[model];
            return (
              <div className="cost-row" key={model}>
                <span className="cost-row-name">{displayModel}</span>
                <div className="cost-row-bar">
                  <div className="cost-row-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="cost-row-value">{formatCost(amount)}</span>
                {typeof value === 'number' && value > 0 && (
                  <span className="cost-row-reported" title="List-price value absorbed by a free/subscription tier — not spend">
                    value {formatCost(value)}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      <h2 className="section-subtitle">Recent Requests</h2>
      <div className="request-list">
        {(!cost.recent || cost.recent.length === 0) ? (
          <div className="empty-state">No requests recorded yet.</div>
        ) : (
          cost.recent.slice(0, 30).map((req, i) => (
            <div className="request-row" key={i}>
              <span className="request-time">{formatTime(req.timestamp)}</span>
              <span className="request-provider">{req.provider || '--'}</span>
              <span className="request-model">{req.model || '--'}</span>
              {/* 🧾 marks a cost the PROVIDER reported, not one we priced. */}
              <span className="request-cost">{req.reported ? '🧾 ' : ''}{formatCost(req.costUsd)}</span>
              <span className="request-tokens">{formatNumber(req.totalTokens)} tok</span>
            </div>
          ))
        )}
      </div>
    </>
  );
}
