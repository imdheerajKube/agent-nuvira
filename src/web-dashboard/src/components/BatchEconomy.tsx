import { useMemo, useState } from 'react';
import { formatSpendCell, SPEND_MARKS_LEGEND } from '../format';
import type { SpendBreakdown, UnattendedJobView } from '../types';

/**
 * Per-batch cost & latency for unattended runs (G27), on the dashboard.
 *
 * WHY. `nuvira execute` prints a per-batch table when a long unattended run
 * ends — what each batch cost, how long it took, and which batch failed. The
 * dashboard's Run Timeline showed the same run as a percentage, so the two
 * questions a 100-page book actually raises (what did it cost, is it slowing
 * down) were answerable only from a terminal. This renders the SAME measured
 * rows the CLI prints, from the same persisted store, so the surfaces cannot
 * disagree.
 *
 * HONESTY. A column the surface never measured renders as "—", never as 0.
 * A batch that was not metered must not read as "free", and a failed batch
 * keeps its row: it still spent tokens, and hiding its cost is exactly the
 * accounting gap that makes a long run's bill a surprise.
 */

/**
 * One cost cell, from the batch's OWN spend breakdown.
 *
 * A batch is not free just because nothing was billed: a list-priced call on a
 * provider whose tier was never declared has a price and no proof it was charged.
 * `formatSpendCell` (shared with the CLI table, via `utils/spend.ts`) says which of
 * those it is; this function only decides where the number comes from.
 *
 * LEGACY rows — persisted before `spend` existed — carry a bare `costUsd` with no
 * provenance, so they keep their figure and take the `?` mark: the money was
 * computed, the evidence behind it was not recorded.
 */
function spendCell(spend: SpendBreakdown | undefined, legacyCostUsd: number | undefined) {
  if (spend) return formatSpendCell(spend);
  if (legacyCostUsd === undefined) return { text: '—', marks: [] as string[] };
  return { text: `$${legacyCostUsd.toFixed(5)}?`, marks: ['?'] };
}

/** Compact human duration (`850ms`, `12.4s`, `3m 07s`, `1h 12m`). */
function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function formatTokens(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString('en-US');
}

interface BatchEconomyProps {
  jobs: UnattendedJobView[];
}

export default function BatchEconomy({ jobs }: BatchEconomyProps) {
  // Only runs that actually recorded measured batches are worth a table.
  const runs = useMemo(() => jobs.filter((j) => j.batchStats.length > 0), [jobs]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (runs.length === 0) return null;

  const selected = runs.find((r) => r.id === selectedId) ?? runs[0];
  const stats = selected.batchStats;

  const timed = stats.filter((s) => s.durationMs !== undefined);
  const totalMs = timed.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
  const averageMs = timed.length > 0 ? totalMs / timed.length : undefined;

  const cells = stats.map((s) => spendCell(s.spend, s.costUsd));
  const totalCell = spendCell(selected.spend, selected.costUsd);
  const totalTokens = selected.spend?.tokens ?? selected.tokens;
  // The legend prints only when a mark was actually used, so a table of plain
  // dollars does not carry an asterisk pointing at nothing.
  const marks = new Set<string>([...cells.flatMap((c) => c.marks), ...totalCell.marks]);

  return (
    <div className="dag-timeline-section" data-testid="batch-economy">
      <h2 className="section-subtitle">
        📊 Per-batch cost &amp; latency{' '}
        <span className="timeline-subtitle">— every figure labelled with its evidence</span>
      </h2>

      {runs.length > 1 && (
        <div className="dag-loop-turn-meta" style={{ marginBottom: 8 }}>
          {runs.slice(0, 5).map((run) => (
            <button
              key={run.id}
              type="button"
              className="dag-loop-turn-chip"
              onClick={() => setSelectedId(run.id)}
              style={{
                cursor: 'pointer',
                opacity: run.id === selected.id ? 1 : 0.55,
                fontWeight: run.id === selected.id ? 600 : 400,
              }}
            >
              {run.progressLine ?? run.goal.slice(0, 40)}
            </button>
          ))}
        </div>
      )}

      <div className="dag-loop-turn-meta" style={{ marginBottom: 8 }}>
        <span className="dag-loop-turn-chip">
          {selected.kind === 'long-form' ? '📖' : '🛠️'} {selected.status}
        </span>
        <span className="dag-loop-turn-chip">{selected.progress}% done</span>
        <span className="dag-loop-turn-chip">
          {selected.batches} batch{selected.batches === 1 ? '' : 'es'}
        </span>
        <span className="dag-loop-turn-chip dag-loop-turn-chip-dim">
          {formatTokens(totalTokens)} tokens · {totalCell.text}
        </span>
        {selected.stopReason && (
          <span className="dag-loop-turn-chip dag-loop-turn-chip-dim">
            stopped: {selected.stopReason}
          </span>
        )}
      </div>

      <div className="dag-table-wrapper">
        <table className="dag-table">
          <thead>
            <tr>
              <th>Batch</th>
              <th>Done</th>
              <th>Tokens</th>
              <th>Cost</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s, i) => (
              <tr key={s.index}>
                <td>{s.index}</td>
                <td>{`${Math.round(s.progress)}%`}</td>
                <td>{formatTokens(s.spend?.tokens ?? s.tokens)}</td>
                <td>{cells[i]!.text}</td>
                <td>{formatMs(s.durationMs)}</td>
              </tr>
            ))}
            {stats.some((s) => s.error) && (
              <tr>
                <td colSpan={5} style={{ opacity: 0.75 }}>
                  ✗ failures:{' '}
                  {stats
                    .filter((s) => s.error)
                    .map((s) => `#${s.index} ${s.error}`)
                    .join(' · ')}
                </td>
              </tr>
            )}
            <tr>
              <td>
                <strong>total</strong>
              </td>
              <td>
                <strong>{`${selected.progress}%`}</strong>
              </td>
              <td>
                <strong>{formatTokens(totalTokens)}</strong>
              </td>
              <td>
                <strong>{totalCell.text}</strong>
              </td>
              <td>
                <strong>{averageMs === undefined ? '—' : `~${formatMs(averageMs)} avg`}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {marks.size > 0 && (
        <p className="timeline-subtitle" data-testid="batch-economy-spend-legend">
          {SPEND_MARKS_LEGEND}
        </p>
      )}
    </div>
  );
}
