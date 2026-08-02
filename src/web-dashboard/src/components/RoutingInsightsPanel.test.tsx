/**
 * Unit tests for the PromotionGateSection rendered by RoutingInsightsPanel.
 *
 * Covers the three verdict states (promoted / not-promoted / collecting data),
 * the honest neutral latency chip when latency is unmeasured, and the
 * hidden-when-empty behavior. Rendered through the default RoutingInsightsPanel
 * export so the `hasPromotion` wiring and empty-state gating are exercised too.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import RoutingInsightsPanel from './RoutingInsightsPanel';
import type { DashboardData, PromotionInsights } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeData(promotion?: PromotionInsights): DashboardData {
  return {
    routing: {
      providers: [],
      bestModels: [],
      preference: [],
      promotion,
      updatedAt: Date.now(),
    },
  } as unknown as DashboardData;
}

const basePromotion: PromotionInsights = {
  decisionCount: 30,
  divergedCount: 22,
  minDecisions: 20,
  qualityDelta: 0.05,
  costDelta: 0.005,
  latencyDelta: 0.02,
  latencyMeasured: true,
  criteria: { quality: true, cost: true, latency: true },
  sufficient: true,
  promoted: true,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PromotionGateSection (via RoutingInsightsPanel)', () => {
  it('renders the promoted verdict when all criteria pass with sufficient data', () => {
    render(<RoutingInsightsPanel data={makeData(basePromotion)} />);

    expect(screen.getByText('Promoted — the bandit beats the heuristic')).toBeTruthy();
    expect(screen.getByText('Quality ↑')).toBeTruthy();
    expect(screen.getByText('Cost ↓')).toBeTruthy();
    expect(screen.getByText('Latency ↓')).toBeTruthy();
    // All three criteria pass
    expect(screen.getAllByText('✓ pass')).toHaveLength(3);
    expect(screen.queryByText('✗ fail')).toBeNull();
  });

  it('shows the collecting-data state when there are not enough diverged decisions', () => {
    const promo: PromotionInsights = {
      ...basePromotion,
      divergedCount: 5,
      sufficient: false,
      promoted: false,
    };
    render(<RoutingInsightsPanel data={makeData(promo)} />);

    expect(screen.getByText('Collecting data — need more diverged decisions')).toBeTruthy();
    expect(screen.getByText('5 diverged decisions')).toBeTruthy();
    expect(screen.getByText('need 20 for a verdict')).toBeTruthy();
    // Not enough data → no promotion claim
    expect(screen.queryByText('Promoted — the bandit beats the heuristic')).toBeNull();
    expect(screen.queryByText('Not promoted — the bandit is not (yet) better')).toBeNull();
  });

  it('shows the not-promoted verdict when sufficient but a criterion fails', () => {
    const promo: PromotionInsights = {
      ...basePromotion,
      criteria: { quality: false, cost: true, latency: true },
      promoted: false,
    };
    render(<RoutingInsightsPanel data={makeData(promo)} />);

    expect(screen.getByText('Not promoted — the bandit is not (yet) better')).toBeTruthy();
    // Quality fails, cost + latency pass
    expect(screen.getByText('✗ fail')).toBeTruthy();
    expect(screen.getAllByText('✓ pass')).toHaveLength(2);
  });

  it('renders a neutral latency chip when latency is unmeasured — never a green pass', () => {
    const promo: PromotionInsights = {
      ...basePromotion,
      latencyMeasured: false,
    };
    render(<RoutingInsightsPanel data={makeData(promo)} />);

    expect(screen.getByText('○ neutral')).toBeTruthy();
    expect(screen.getByText('no latency measurements yet')).toBeTruthy();
    // Measured criteria (quality + cost) still show green — only latency is neutral
    expect(screen.getAllByText('✓ pass')).toHaveLength(2);
    expect(screen.getAllByText('○ neutral')).toHaveLength(1);
    expect(screen.queryByText('✗ fail')).toBeNull();
  });

  it('hides the promotion card entirely when there are no decisions yet', () => {
    render(<RoutingInsightsPanel data={makeData({ ...basePromotion, decisionCount: 0 })} />);

    expect(screen.queryByText('Promotion Gate — is the bandit better than the heuristic?')).toBeNull();
  });

  it('renders nothing promotion-related when routing data is absent', () => {
    render(<RoutingInsightsPanel data={null} />);

    expect(screen.queryByText('Promotion Gate — is the bandit better than the heuristic?')).toBeNull();
  });
});
