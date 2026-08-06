/**
 * Unit tests for Nuvira-Router P3-M3.3 — decision diff (`model explain --since`).
 * The diff module is PURE (no I/O), so these tests exercise the before → after
 * comparisons directly: winner change, per-candidate score deltas, bandit
 * weight shifts, governance additions/removals, and gate transitions.
 */

import { describe, it, expect } from 'vitest';
import { diffRoutingDecisions, formatDecisionDiff } from '../../src/learning/decision-diff.js';
import type { RoutingSnapshot } from '../../src/learning/routing-history.js';

const makeSnapshot = (overrides: Partial<RoutingSnapshot> = {}): RoutingSnapshot => ({
  complexity: 'moderate',
  taskType: 'code',
  weights: { reasoning: 0.3, speed: 0.2, cost: 0.2, privacy: 0.1, reliability: 0.2 },
  winner: { provider: 'groq', model: 'llama-3.3-70b-versatile', score: 0.84 },
  ranked: [
    { provider: 'groq', model: 'llama-3.3-70b-versatile', score: 0.84, reason: 'fast + free', capabilityFit: 0.9, costSource: 'estimated', contextFit: 0.7 },
    { provider: 'gemini', model: 'gemini-2.0-flash', score: 0.72, reason: 'capable', capabilityFit: 0.95, costSource: 'estimated', contextFit: 0.9 },
    { provider: 'nim', model: 'llama-3.1-8b-instruct', score: 0.55, reason: 'free tier', capabilityFit: 0.5, costSource: 'estimated' },
  ],
  fallbackChain: [
    { provider: 'gemini', model: 'gemini-2.0-flash', reason: 'backup' },
    { provider: 'local', model: 'llama3.2', reason: 'offline' },
  ],
  governanceBlocked: [{ provider: 'openrouter', reason: 'not in allow list' }],
  ...overrides,
});

describe('diffRoutingDecisions', () => {
  it('flags a winner change and reports the before → after pick', () => {
    const prev = makeSnapshot();
    const cur = makeSnapshot({
      winner: { provider: 'gemini', model: 'gemini-2.0-flash', score: 0.9 },
      ranked: [
        { provider: 'gemini', model: 'gemini-2.0-flash', score: 0.9, reason: 'reasoning win', capabilityFit: 0.95, costSource: 'estimated', contextFit: 0.9 },
        { provider: 'groq', model: 'llama-3.3-70b-versatile', score: 0.71, reason: 'slower for reasoning', capabilityFit: 0.8, costSource: 'estimated', contextFit: 0.7 },
        { provider: 'nim', model: 'llama-3.1-8b-instruct', score: 0.5, reason: 'free tier', capabilityFit: 0.5, costSource: 'estimated' },
      ],
    });

    const diff = diffRoutingDecisions(prev, cur);
    expect(diff.winnerChanged).toBe(true);
    expect(diff.prevWinner).toEqual({ provider: 'groq', model: 'llama-3.3-70b-versatile', score: 0.84 });
    expect(diff.curWinner).toEqual({ provider: 'gemini', model: 'gemini-2.0-flash', score: 0.9 });
  });

  it('classifies candidate changes: new / dropped / improved / regressed / unchanged', () => {
    const prev = makeSnapshot();
    const cur = makeSnapshot({
      winner: { provider: 'groq', model: 'llama-3.3-70b-versatile', score: 0.9 },
      ranked: [
        // groq improved 0.84 → 0.90
        { provider: 'groq', model: 'llama-3.3-70b-versatile', score: 0.9, reason: 'faster', capabilityFit: 0.9, costSource: 'measured', contextFit: 0.7 },
        // gemini regressed 0.72 → 0.6
        { provider: 'gemini', model: 'gemini-2.0-flash', score: 0.6, reason: 'congested', capabilityFit: 0.95, costSource: 'estimated', contextFit: 0.9 },
        // nim dropped entirely
        // claude is NEW
        { provider: 'anthropic', model: 'claude-3.5-sonnet', score: 0.68, reason: 'newly verified', capabilityFit: 0.8, costSource: 'estimated' },
      ],
    });

    const diff = diffRoutingDecisions(prev, cur);
    const byProvider = new Map(diff.candidates.map((c) => [c.provider, c]));
    expect(byProvider.get('groq')!.change).toBe('improved');
    expect(byProvider.get('groq')!.delta).toBeCloseTo(0.06, 3);
    expect(byProvider.get('gemini')!.change).toBe('regressed');
    expect(byProvider.get('nim')!.change).toBe('dropped');
    expect(byProvider.get('nim')!.curScore).toBeUndefined();
    expect(byProvider.get('anthropic')!.change).toBe('new');
    expect(byProvider.get('anthropic')!.prevScore).toBeUndefined();
    // Changed candidates sort before unchanged ones.
    expect(diff.candidates[0].change).not.toBe('unchanged');
  });

  it('detects bandit weight shifts (dimension weight deltas)', () => {
    const prev = makeSnapshot();
    const cur = makeSnapshot({
      weights: { reasoning: 0.5, speed: 0.2, cost: 0.1, privacy: 0.1, reliability: 0.1 },
    });
    const diff = diffRoutingDecisions(prev, cur);
    expect(diff.weightDeltas['reasoning']).toBeCloseTo(0.2, 3);
    expect(diff.weightDeltas['cost']).toBeCloseTo(-0.1, 3);
    // Unchanged dimensions are omitted.
    expect(diff.weightDeltas['speed']).toBeUndefined();
  });

  it('reports governance blocks added and removed (M2.4)', () => {
    const prev = makeSnapshot({ governanceBlocked: [{ provider: 'openrouter', reason: 'not in allow list' }] });
    const cur = makeSnapshot({ governanceBlocked: [{ provider: 'anthropic', reason: 'denied by policy' }] });
    const diff = diffRoutingDecisions(prev, cur);
    expect(diff.governance.removed).toEqual([{ provider: 'openrouter', reason: 'not in allow list' }]);
    expect(diff.governance.added).toEqual([{ provider: 'anthropic', reason: 'denied by policy' }]);
  });

  it('detects gate transitions: capability/context fit turning on/off', () => {
    const prev = makeSnapshot({
      ranked: [
        { provider: 'groq', model: 'm', score: 0.8, reason: 'r' }, // no capabilityFit/contextFit (gate OFF)
        { provider: 'gemini', model: 'g', score: 0.7, reason: 'r' },
      ],
    });
    const cur = makeSnapshot(); // gates ON with values
    const diff = diffRoutingDecisions(prev, cur);
    const gates = new Map(diff.gates.map((g) => [g.dimension, g]));
    expect(gates.get('capability-fit')!.change).toBe('on');
    expect(gates.get('capability-fit')!.prev).toBeUndefined();
    expect(gates.get('capability-fit')!.cur).toBe('90%');
    expect(gates.get('context-fit')!.change).toBe('on');
  });

  it('returns unchanged for identical snapshots', () => {
    const a = makeSnapshot();
    const diff = diffRoutingDecisions(a, makeSnapshot());
    expect(diff.winnerChanged).toBe(false);
    expect(diff.candidates.every((c) => c.change === 'unchanged')).toBe(true);
    expect(Object.keys(diff.weightDeltas)).toHaveLength(0);
    expect(diff.governance.added).toHaveLength(0);
    expect(diff.governance.removed).toHaveLength(0);
    expect(diff.gates).toHaveLength(0);
  });

  it('handles empty ranked lists on either side', () => {
    const prev = makeSnapshot({ ranked: [], fallbackChain: [] });
    const cur = makeSnapshot();
    const diff = diffRoutingDecisions(prev, cur);
    // Every candidate in cur is 'new' relative to an empty prev. The winner is
    // unchanged (same provider/model) — the ranking alone went from none to full.
    expect(diff.candidates.every((c) => c.change === 'new')).toBe(true);
    expect(diff.winnerChanged).toBe(false);
  });
});

describe('formatDecisionDiff', () => {
  it('renders a readable before → after summary', () => {
    const prev = makeSnapshot();
    const cur = makeSnapshot({
      winner: { provider: 'gemini', model: 'gemini-2.0-flash', score: 0.9 },
      ranked: [
        // gemini improved 0.72 → 0.90 and wins (▲ mark in the diff).
        { provider: 'gemini', model: 'gemini-2.0-flash', score: 0.9, reason: 'reasoning win', capabilityFit: 0.95, costSource: 'estimated', contextFit: 0.9 },
        { provider: 'groq', model: 'llama-3.3-70b-versatile', score: 0.71, reason: 'slower for reasoning', capabilityFit: 0.8, costSource: 'estimated', contextFit: 0.7 },
        { provider: 'nim', model: 'llama-3.1-8b-instruct', score: 0.5, reason: 'free tier', capabilityFit: 0.5, costSource: 'estimated' },
      ],
    });
    const diff = diffRoutingDecisions(prev, cur);
    const text = formatDecisionDiff(diff, { task: 'add auth', refLabel: 'route-abc' });
    expect(text).toContain('Task: "add auth"');
    expect(text).toContain('Compared against: route-abc');
    expect(text).toContain('groq/llama-3.3-70b-versatile → gemini/gemini-2.0-flash');
    expect(text).toContain('Candidate score changes');
    expect(text).toContain('▲ gemini');
  });
});
