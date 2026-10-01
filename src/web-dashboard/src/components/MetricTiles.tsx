import type { DashboardData, HubData } from '../types';
import { formatCost, formatNumber } from '../format';

/**
 * The tone is a CSS hook, not a colour, and the four tones map onto accents the
 * contrast suite already asserts against the card surface (`--p-accent`,
 * `--p-ok`, `--p-warn`, `--p-danger` on `--p-surface`, all at 4.5:1 in every
 * theme). That is deliberate: the reference design fills these tiles with solid
 * colour and white text, which is precisely how a yellow tile ends up at
 * ~2:1 — the number is coloured instead, so the colour coding cannot drift out
 * of AA without the existing test failing.
 */
export type MetricTone = 'accent' | 'ok' | 'warn' | 'danger';

export interface MetricTile {
  key: string;
  icon: string;
  value: string;
  label: string;
  tone: MetricTone;
}

/**
 * Tiles for the numbers we actually have.
 *
 * A tile is OMITTED when its source is absent rather than rendered as 0: "0
 * skills" and "this server does not report skills" are different claims, and
 * only one of them is true. Same rule the optional panels follow.
 *
 * `Monthly Cost` in the reference is labelled `Total Cost` here, because the
 * ledger reports a running total and the page would otherwise be crediting the
 * current month with every call ever made.
 */
export function buildMetricTiles(
  data: DashboardData | null,
  hub: HubData | null,
): MetricTile[] {
  const tiles: MetricTile[] = [];

  if (hub) {
    // Tools in ENABLED toolsets — the same summation the hub's `totalTools`
    // uses, restricted to the ones the router can actually call.
    const activeTools = hub.toolsets.toolsets
      .filter((toolset) => toolset.enabled)
      .reduce((sum, toolset) => sum + toolset.toolCount, 0);

    tiles.push({
      key: 'tools',
      icon: '🔧',
      value: formatNumber(activeTools),
      label: 'Active Tools',
      tone: 'accent',
    });
  }

  // The hub is authoritative when present; the SSE-merged count is the fallback
  // so the tile survives on a server that predates /api/hub.
  const conversations = hub?.conversations?.total ?? data?.conversations?.total;
  if (conversations !== undefined) {
    tiles.push({
      key: 'conversations',
      icon: '💬',
      value: formatNumber(conversations),
      label: 'Active Conversations',
      tone: 'ok',
    });
  }

  if (hub) {
    tiles.push({
      key: 'skills',
      icon: '🧩',
      value: formatNumber(hub.skills.total),
      label: 'Skills Loaded',
      tone: 'warn',
    });
  }

  if (data) {
    tiles.push({
      key: 'cost',
      icon: '💰',
      value: formatCost(data.cost.totalCost),
      label: 'Total Cost',
      tone: 'danger',
    });
  }

  return tiles;
}

export default function MetricTiles({ tiles }: { tiles: MetricTile[] }) {
  if (tiles.length === 0) return null;

  return (
    <ul className="metric-tiles">
      {tiles.map((tile) => (
        <li className={`metric-tile metric-tile--${tile.tone}`} key={tile.key}>
          <span className="metric-tile-icon" aria-hidden="true">
            {tile.icon}
          </span>
          <span>
            {/* Value then label, which is how it reads aloud: the number is the
                headline and the label names it. */}
            <span className="metric-tile-value">{tile.value}</span>
            <span className="metric-tile-label">{tile.label}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
