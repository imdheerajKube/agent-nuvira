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
