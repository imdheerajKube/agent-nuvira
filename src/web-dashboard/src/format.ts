/**
 * Dashboard-side entry point for the shared number formatter.
 *
 * The dashboard is a separate package tree, but its components already consume
 * root-tree utilities through a shim (`./mask.ts` re-exports
 * `../../utils/mask.js`), so the pinned-locale rule lives in ONE place instead of
 * being re-implemented per component — the per-component copies are what drifted:
 * `BatchEconomy.tsx` pinned 'en-US' while `CostDashboard.tsx`, `HealthPanel.tsx`,
 * `Overview.tsx` and `MemoryPanel.tsx` each used a bare `toLocaleString()`.
 */
export { formatCount } from '../../utils/format.js';

import { formatCount } from '../../utils/format.js';

/**
 * Money, at the precision the amount actually has.
 *
 * Sub-cent spend is normal here (a single small call can cost $0.00004), so a
 * fixed 2dp formatter prints $0.00 for real spend and makes the dashboard look
 * like it is not metering. Undefined is treated as $0.00 only because every
 * call site is a total the server has already summed.
 */
export function formatCost(usd: number | undefined): string {
  if (usd === undefined || usd === null) return '$0.00';
  if (usd < 0.00001) return '$0.00';
  if (usd < 0.01) return '$' + usd.toFixed(6);
  return '$' + usd.toFixed(4);
}

/** Counts large enough to be unreadable raw: 1.2K, 3.4M. */
export function formatNumber(n: number | undefined): string {
  if (n === undefined || n === null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return formatCount(n);
}
