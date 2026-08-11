/**
 * E3b — verify_requirement tool tests (the C2 requirementState check).
 *
 * Rule path is trusted at/above the threshold (zero network); below it, the
 * LLM verify runs when a callLLM is available; a failed verify falls back to
 * the rule result (never a guess).
 */

import { describe, it, expect, vi } from 'vitest';
import { assessRequirement } from '../../src/tools/verify-requirement.js';

describe('verify_requirement — rule path', () => {
  it('reports complete for a high-confidence create request', async () => {
    const state = await assessRequirement('create a CLI tool', {});
    expect(state.state).toBe('complete');
    expect(state.intent).toBe('create');
    expect(state.confidence).toBeGreaterThanOrEqual(0.8);
    expect(state.missingInfo.length).toBe(0);
  });

  it('reports needs-clarification for an unknown request with the missing info', async () => {
    const state = await assessRequirement('kaleidoscope', {});
    expect(state.state).toBe('needs-clarification');
    expect(state.missingInfo.length).toBeGreaterThan(0);
  });
});

describe('verify_requirement — LLM verify path (below the trust threshold)', () => {
  it('uses the LLM verify result when it crosses the threshold', async () => {
    const callLLM = vi.fn().mockResolvedValue(
      JSON.stringify({
        intent: 'fix',
        confidence: 0.9,
        entities: { files: ['src/x.ts'], frameworks: [], keywords: [] },
      }),
    );
    const state = await assessRequirement('make it work', { callLLM });
    expect(state.state).toBe('complete');
    expect(state.intent).toBe('fix');
    expect(callLLM).toHaveBeenCalled();
  });

  it('reports needs-clarification with the memoryHint when the LLM is unsure', async () => {
    const callLLM = vi.fn().mockResolvedValue(
      JSON.stringify({
        intent: 'unknown',
        confidence: 0.2,
        entities: { files: [], frameworks: [], keywords: [] },
        memoryHint: 'which module is failing?',
      }),
    );
    const state = await assessRequirement('something is off', { callLLM });
    expect(state.state).toBe('needs-clarification');
    expect(state.missingInfo.join(' ')).toContain('which module is failing?');
  });

  it('falls back to the rule result when the verify call fails (never a guess)', async () => {
    const callLLM = vi.fn().mockRejectedValue(new Error('API down'));
    const state = await assessRequirement('fix the bug', { callLLM });
    // 'fix the bug' is trusted by the rule path → complete.
    expect(state.state).toBe('complete');
    expect(state.intent).toBe('fix');
  });
});
