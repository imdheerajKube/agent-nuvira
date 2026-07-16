import type { DashboardData } from '../types';

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
  return n.toLocaleString();
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function CostDashboard({ data }: CostDashboardProps) {
  if (!data) {
    return <div className="loading-state"><p>Loading cost data...</p></div>;
  }

  const { cost } = data;
  const byProvider = Object.entries(cost.byProvider || {}).sort(([, a], [, b]) => b - a);
  const byModel = Object.entries(cost.byModel || {}).sort(([, a], [, b]) => b - a).slice(0, 10);
  const providerTotal = byProvider.reduce((s, [, v]) => s + v, 0);

  return (
    <>
      <h2 className="section-title">💰 Cost Tracking</h2>

      <div className="cost-summary">
        <div className="cost-total">
          <span className="cost-label">Total Spent</span>
          <span className="cost-amount">{formatCost(cost.totalCost)}</span>
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

      <h3 className="section-subtitle">By Provider</h3>
      <div className="cost-list">
        {byProvider.length === 0 ? (
          <div className="empty-state">No costs recorded yet.</div>
        ) : (
          byProvider.map(([provider, amount]) => {
            const pct = providerTotal > 0 ? ((amount / providerTotal) * 100).toFixed(1) : '0';
            return (
              <div className="cost-row" key={provider}>
                <span className="cost-row-name">{provider}</span>
                <div className="cost-row-bar">
                  <div className="cost-row-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="cost-row-value">{formatCost(amount)}</span>
              </div>
            );
          })
        )}
      </div>

      <h3 className="section-subtitle">By Model</h3>
      <div className="cost-list">
        {byModel.length === 0 ? (
          <div className="empty-state">No model costs recorded yet.</div>
        ) : (
          byModel.map(([model, amount]) => {
            const pct = providerTotal > 0 ? ((amount / providerTotal) * 100).toFixed(1) : '0';
            const displayModel = model.length > 30 ? model.slice(0, 28) + '..' : model;
            return (
              <div className="cost-row" key={model}>
                <span className="cost-row-name">{displayModel}</span>
                <div className="cost-row-bar">
                  <div className="cost-row-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="cost-row-value">{formatCost(amount)}</span>
              </div>
            );
          })
        )}
      </div>

      <h3 className="section-subtitle">Recent Requests</h3>
      <div className="request-list">
        {(!cost.recent || cost.recent.length === 0) ? (
          <div className="empty-state">No requests recorded yet.</div>
        ) : (
          cost.recent.slice(0, 30).map((req, i) => (
            <div className="request-row" key={i}>
              <span className="request-time">{formatTime(req.timestamp)}</span>
              <span className="request-provider">{req.provider || '--'}</span>
              <span className="request-model">{req.model || '--'}</span>
              <span className="request-cost">{formatCost(req.costUsd)}</span>
              <span className="request-tokens">{formatNumber(req.totalTokens)} tok</span>
            </div>
          ))
        )}
      </div>
    </>
  );
}
