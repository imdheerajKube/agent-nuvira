/**
 * EvalsPage — P2 eval runner in the GUI (GUI parity with `buff eval run`).
 *
 * Runs the REAL `buff eval run` through the task runner (shared TaskConsole),
 * with live output and cancel. Past runs come from the dashboard data feed
 * (evals.json, auto-refreshed every 10s), so results appear in the table as
 * soon as a run finishes.
 */

import TaskConsole from './TaskConsole';
import type { DashboardData, EvalRun } from '../types';
import PageHeader from './PageHeader';

const PRESETS = [
  { label: '⚡ Quick smoke', args: ['eval', 'run', '--tasks', 'quick', '--format', 'text'] },
  { label: '⏱ Medium suite', args: ['eval', 'run', '--tasks', 'medium', '--format', 'text'] },
  { label: '🐢 Slow suite', args: ['eval', 'run', '--tasks', 'slow', '--format', 'text'] },
  { label: '🏆 M2B parity', args: ['eval', 'run', '--suite', 'm2b', '--format', 'text'] },
  { label: '📦 Full suite', args: ['eval', 'run', '--suite', 'full', '--format', 'text'] },
];

function fmtPct(v: number | undefined): string {
  if (typeof v !== 'number') return '—';
  return `${Math.round(v * 100)}%`;
}

function fmtDate(at: number): string {
  return new Date(at).toLocaleString();
}

export default function EvalsPage({ data }: { data: DashboardData | null }) {
  const runs: EvalRun[] = data?.evals?.runs ?? [];

  return (
    <div className="panel">
      <PageHeader icon="🏆" title="Evals — run buff eval from the GUI" />

      <TaskConsole
        presets={PRESETS}
        customPlaceholder="e.g. eval run --tasks my-task --provider groq --model llama"
        timeoutMs={900_000}
        hint={
          <>
            Runs the real <code>buff eval run</code> as an isolated process — same engine, same ledger, same results
            as the CLI. Long suites can take minutes; you can cancel mid-run.
          </>
        }
      />

      <h2 className="section-subtitle">📜 Past runs (auto-refreshes)</h2>
      {runs.length > 0 ? (
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Provider</th>
                <th>Model</th>
                <th>Tasks</th>
                <th>Pass</th>
                <th>Completion</th>
                <th>Composite</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDate(r.startedAt)}</td>
                  <td className="admin-provider-type">{r.provider}</td>
                  <td>{r.model}</td>
                  <td>{r.summary.totalTasks}</td>
                  <td>{r.summary.tasksPassed}/{r.summary.totalTasks}</td>
                  <td>{fmtPct(r.summary.completionRate)}</td>
                  <td>{fmtPct(r.summary.avgCompositeScore)}</td>
                  <td>${(r.summary.totalCostUsd ?? 0).toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">No eval runs yet — start one above (or `buff eval run` from the CLI).</div>
      )}
    </div>
  );
}
