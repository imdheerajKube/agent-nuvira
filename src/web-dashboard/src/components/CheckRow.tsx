/**
 * One doctor check, rendered the same way on every tab that shows checks.
 *
 * WHY THIS IS ITS OWN MODULE. The Admin tab has rendered these rows since
 * Session 17, and the System tab now shows the same checks under their real
 * name. Two copies of one row is how two tabs come to describe the same check
 * differently — the exact class of defect the Models/Timeline split produced
 * (one screen, three answers). So the badge, the icon and the fix line live here
 * once, and both panels import them.
 *
 * The row is deliberately presentational: it renders what the server said and
 * nothing else. `status` is the server's verdict from `runAllChecks()`, which is
 * the same code `nuvira doctor` runs — so a PASS here is the same PASS the CLI
 * prints, not a second opinion.
 */

import type { AdminCheck, CheckStatus } from '../types';

export const STATUS_ICON: Record<CheckStatus, string> = { pass: '✅', warn: '⚠️', fail: '❌' };
export const STATUS_LABEL: Record<CheckStatus, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };

/** Tallies for a set of checks — the "3 pass · 1 warn" line and the rollup. */
export function countByStatus(checks: AdminCheck[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) {
    // An unknown status from a newer server must not silently become a pass.
    if (counts[c.status] !== undefined) counts[c.status] += 1;
  }
  return counts;
}

/**
 * The one-line verdict for a group: failures first, because a green summary
 * that buries a single FAIL is worse than no summary.
 */
export function summarise(counts: Record<CheckStatus, number>): string {
  const parts: string[] = [];
  if (counts.fail > 0) parts.push(`${counts.fail} failing`);
  if (counts.warn > 0) parts.push(`${counts.warn} warning${counts.warn === 1 ? '' : 's'}`);
  if (counts.pass > 0) parts.push(`${counts.pass} passing`);
  return parts.length > 0 ? parts.join(' · ') : 'no checks';
}

export function CheckRow({ check }: { check: AdminCheck }) {
  return (
    <div className="admin-check-row" data-status={check.status} data-testid={`check-${check.name}`}>
      <span className={`admin-check-badge admin-check-${check.status}`}>
        {STATUS_ICON[check.status]} {STATUS_LABEL[check.status]}
      </span>
      <div className="admin-check-body">
        <div className="admin-check-name">{check.name}</div>
        <div className="admin-check-message">{check.message}</div>
        {check.detail ? <div className="admin-check-detail">{check.detail}</div> : null}
        {check.fix ? <div className="admin-check-fix">💡 {check.fix}</div> : null}
      </div>
    </div>
  );
}
