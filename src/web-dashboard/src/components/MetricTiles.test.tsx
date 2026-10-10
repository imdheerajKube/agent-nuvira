/**
 * The metric band.
 *
 * The load-bearing half is `buildMetricTiles`, and specifically that it OMITS a
 * tile whose source is missing rather than printing a zero. "0 active tools"
 * and "this server cannot report active tools" look identical on screen and
 * only one of them is true, so the distinction has to be asserted somewhere —
 * here, against a payload with the fields removed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import MetricTiles, { buildMetricTiles } from './MetricTiles';
import type { DashboardData, HubData } from '../types';

afterEach(cleanup);

function hub(overrides: Partial<HubData> = {}): HubData {
  return {
    toolsets: {
      toolsets: [
        { name: 'core', label: 'Core', description: '', enabled: true, tools: [], toolCount: 6 },
        { name: 'extra', label: 'Extra', description: '', enabled: false, tools: [], toolCount: 4 },
        { name: 'more', label: 'More', description: '', enabled: true, tools: [], toolCount: 2 },
      ],
      enabled: 2,
      disabled: 1,
      totalTools: 12,
    },
    conversations: { total: 125, recent: [], analytics: {} as never },
    skills: { compiled: [], hub: [], total: 152, enabled: 140, disabled: 12 },
    ...overrides,
  } as unknown as HubData;
}

const data = (cost: number, conversations?: { total: number }) =>
  ({ cost: { totalCost: cost }, conversations } as unknown as DashboardData);

describe('buildMetricTiles', () => {
  it('counts only tools from ENABLED toolsets', () => {
    const tiles = buildMetricTiles(data(0, { total: 1 }), hub());
    // 6 + 2, not the 12 in `totalTools` — the disabled toolset's 4 are not
    // callable, and "Active" is the claim on the label.
    expect(tiles.find((t) => t.key === 'tools')?.value).toBe('8');
  });

  it('drops a tile whose source is absent instead of reporting zero', () => {
    const withoutHub = buildMetricTiles(data(0), null);
    expect(withoutHub.map((t) => t.key)).toEqual(['cost']);

    // No hub and no streamed conversation count: no conversation tile at all.
    expect(withoutHub.find((t) => t.key === 'conversations')).toBeUndefined();

    const withHub = buildMetricTiles(data(0), hub());
    expect(withHub.map((t) => t.key)).toEqual(['tools', 'conversations', 'skills', 'cost']);
  });

  it('falls back to the streamed count when the hub payload has none', () => {
    const noConv = hub({ conversations: undefined });
    const tiles = buildMetricTiles(data(0, { total: 7 }), noConv);
    expect(tiles.find((t) => t.key === 'conversations')?.value).toBe('7');
  });

  it('labels the ledger total as a total, not as this month', () => {
    const tiles = buildMetricTiles(data(1290), hub());
    const cost = tiles.find((t) => t.key === 'cost');
    expect(cost?.label).toBe('Total Cost');
    expect(cost?.label).not.toMatch(/month/i);
  });

  it('formats large counts and sub-cent spend legibly', () => {
    const tiles = buildMetricTiles(data(0.0000431), hub({ conversations: { total: 2400, recent: [], analytics: {} as never } }));
    expect(tiles.find((t) => t.key === 'conversations')?.value).toBe('2.4K');
    expect(tiles.find((t) => t.key === 'cost')?.value).toBe('$0.000043');
  });
});

describe('MetricTiles', () => {
  it('renders nothing at all when there is nothing to report', () => {
    const { container } = render(<MetricTiles tiles={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders each tile with its tone class, value and label', () => {
    render(<MetricTiles tiles={buildMetricTiles(data(1290), hub())} />);

    expect(screen.getByText('8')).toBeDefined();
    expect(screen.getByText('Active Tools')).toBeDefined();
    expect(screen.getByText('125')).toBeDefined();
    expect(screen.getByText('152')).toBeDefined();

    const tones = [...document.querySelectorAll('.metric-tile')].map((el) =>
      [...el.classList].find((c) => c.startsWith('metric-tile--')),
    );
    expect(tones).toEqual([
      'metric-tile--accent',
      'metric-tile--ok',
      'metric-tile--warn',
      'metric-tile--danger',
    ]);
  });

  it('drives every tone from an accent the contrast suite pins on the card', () => {
    // The colour coding is only verified in all 14 themes because the four
    // accents resolve to primitives `theme-contrast.test.ts` asserts at 4.5:1
    // against `--p-surface`. Point a tone at anything else and that guarantee
    // quietly lapses, so the chain is asserted rather than trusted.
    const read = (file: string) =>
      readFileSync(resolve(process.cwd(), 'src/styles', file), 'utf8');

    const dashboard = read('dashboard.css');
    const tones = [...dashboard.matchAll(/\.metric-tile--[a-z]+ \{ --metric-tone: var\((--[a-z-]+)\)/g)]
      .map((m) => m[1]);
    expect(tones).toEqual(['--accent', '--accent-green', '--accent-yellow', '--accent-red']);

    const themes = read('themes.css');
    const primitiveOf = (token: string) =>
      themes.match(new RegExp(`\\${token}: var\\((--p-[a-z-]+)\\)`))?.[1];
    expect(tones.map(primitiveOf)).toEqual([
      '--p-accent',
      '--p-ok',
      '--p-warn',
      '--p-danger',
    ]);

    // …and the contrast suite asserts exactly those four on --p-surface.
    const contrast = readFileSync(
      resolve(process.cwd(), 'src/styles/theme-contrast.test.ts'),
      'utf8',
    );
    for (const primitive of ['--p-accent', '--p-ok', '--p-warn', '--p-danger']) {
      expect(contrast).toContain(`['${primitive}', '--p-surface'`);
    }
  });
});
