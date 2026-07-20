/**
 * Tests for HybridModelRouter — complexity analysis, fallback chain building,
 * budget checking, multi-model consensus, and the HybridModelRouter class.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  analyzeComplexity,
  buildFallbackChain,
  checkBudget,
  checkConsensus,
  HybridModelRouter,
  getHybridRouter,
  resetHybridRouter,
  type ComplexityLevel,
  type ModelCandidate,
  type RoutingDecision,
  type HybridRouterOptions,
  type ConsensusResult,
} from '../../src/learning/hybrid-router.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../src/learning/cost-tracker.js', () => ({
  getCostTracker: vi.fn(() => ({
    getSummary: vi.fn(() => ({
      sessionCost: 0.01,
      totalCost: 0.05,
      sessionRequests: 2,
      totalRequests: 10,
      byProvider: {},
      byModel: {},
      totalTokens: 5000,
      sessionStart: Date.now(),
    })),
  })),
  calculateCost: vi.fn((_p: string, _m: string, _i: number, _o: number) => 0.002),
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4.5)),
}));

vi.mock('../../src/learning/benchmark.js', () => ({
  getBenchmarkRuns: vi.fn(() => []),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<ModelCandidate> = {}): ModelCandidate {
  return {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    estimatedCost: 0.002,
    qualityScore: 0.7,
    reason: 'Primary choice for moderate complexity',
    ...overrides,
  };
}

function makeDecision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    agentType: 'writer',
    complexity: 'moderate',
    provider: 'groq',
    model: 'default',
    fallbackChain: [makeCandidate()],
    useConsensus: false,
    userOverridden: false,
    explanation: 'writer (moderate) → groq/default',
    ...overrides,
  };
}

// ─── analyzeComplexity ──────────────────────────────────────────────────────

describe('analyzeComplexity', () => {
  it.each([
    // [text, expected]
    ['format my code', 'trivial'],
    ['fix the spelling in this comment', 'trivial'],
    ['add a simple comment block', 'trivial'],
    ['make a trivial edit to the readme', 'trivial'],
    ['rename the variable x to y', 'trivial'],
  ])('detects trivial complexity for "%s"', (text, expected) => {
    expect(analyzeComplexity(text)).toBe(expected);
  });

  it.each([
    ['refactor the login function', 'simple'],
    ['extract the validation logic', 'simple'],
    ['move the helper to a new file', 'simple'],
    ['fix bug in login flow', 'simple'],
    ['refactor the cache wrapper', 'simple'],
  ])('detects simple complexity for "%s"', (text, expected) => {
    expect(analyzeComplexity(text)).toBe(expected);
  });

  it.each([
    ['implement a new feature', 'moderate'],
    ['create a user dashboard component', 'moderate'],
    ['build the authentication module', 'moderate'],
    ['add an API endpoint for users', 'moderate'],
    ['integrate the payment gateway', 'moderate'],
  ])('detects moderate complexity for "%s"', (text, expected) => {
    expect(analyzeComplexity(text)).toBe(expected);
  });

  it.each([
    ['design the system architecture', 'complex'],
    ['architect the microservices layout', 'complex'],
    ['optimize the database queries', 'complex'],
    ['implement multi-threaded processing', 'complex'],
    ['migrate the schema to Postgres', 'complex'],
  ])('detects complex complexity for "%s"', (text, expected) => {
    expect(analyzeComplexity(text)).toBe(expected);
  });

  it.each([
    ['deploy to production', 'critical'],
    ['fix the production outage', 'critical'],
    ['urgent security patch needed', 'critical'],
    ['p0 bug in payment system', 'critical'],
    ['prevent data loss during migration', 'critical'],
  ])('detects critical complexity for "%s"', (text, expected) => {
    expect(analyzeComplexity(text)).toBe(expected);
  });

  it('returns moderate as default for unrecognized text', () => {
    expect(analyzeComplexity('write a simple hello world program that says hi')).toBe('moderate');
  });

  it('is case-insensitive', () => {
    expect(analyzeComplexity('DEPLOY TO PRODUCTION')).toBe('critical');
    expect(analyzeComplexity('Refactor The Login')).toBe('simple');
  });

  it('critical keywords take priority over lower levels', () => {
    // Even though this has "format" (trivial), "deploy" (critical) should win
    expect(analyzeComplexity('format and deploy the release')).toBe('critical');
    expect(analyzeComplexity('fix the critical security vulnerability')).toBe('critical');
  });

  it('handles empty string gracefully', () => {
    // Empty string doesn't match anything, falls to default
    expect(analyzeComplexity('')).toBe('moderate');
  });

  it('handles strings with only punctuation/numbers', () => {
    expect(analyzeComplexity('123!@#')).toBe('moderate');
  });

  it('detects keywords embedded in longer words', () => {
    // "deployment" contains "deploy" — the regex tests for /deploy/i which matches
    expect(analyzeComplexity('running the deployment script')).toBe('critical');
  });
});

// ─── buildFallbackChain ─────────────────────────────────────────────────────

describe('buildFallbackChain', () => {
  it('uses user-specified provider/model when provided', () => {
    const chain = buildFallbackChain('writer', 'complex', {
      userProvider: 'gemini',
      userModel: 'gemini-2.0-flash-exp',
    });

    expect(chain).toHaveLength(1);
    expect(chain[0].provider).toBe('gemini');
    expect(chain[0].model).toBe('gemini-2.0-flash-exp');
    expect(chain[0].reason).toContain('User-specified');
  });

  it('returns a 3-level fallback chain by default', () => {
    const chain = buildFallbackChain('writer', 'moderate');
    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain.length).toBeLessThanOrEqual(3);
  });

  it('primary provider matches complexity: trivial → local', () => {
    const chain = buildFallbackChain('writer', 'trivial');
    expect(chain[0].provider).toBe('local');
  });

  it('primary provider matches complexity: simple → groq', () => {
    const chain = buildFallbackChain('writer', 'simple');
    expect(chain[0].provider).toBe('groq');
  });

  it('primary provider matches complexity: complex → gemini', () => {
    const chain = buildFallbackChain('writer', 'complex');
    expect(chain[0].provider).toBe('gemini');
  });

  it('primary provider matches complexity: critical → openrouter', () => {
    const chain = buildFallbackChain('writer', 'critical');
    expect(chain[0].provider).toBe('openrouter');
  });

  it('quality score is higher for critical complexity', () => {
    const trivial = buildFallbackChain('writer', 'trivial');
    const critical = buildFallbackChain('writer', 'critical');
    expect(critical[0].qualityScore).toBeGreaterThan(trivial[0].qualityScore);
    expect(critical[0].qualityScore).toBe(0.9);
  });

  it('fallback order differs from primary', () => {
    const chain = buildFallbackChain('writer', 'moderate');
    if (chain.length > 1) {
      expect(chain[1].provider).not.toBe(chain[0].provider);
    }
  });

  it('all candidates have required fields', () => {
    const chain = buildFallbackChain('planner', 'critical');
    for (const c of chain) {
      expect(c.provider).toBeTruthy();
      expect(c.model).toBeTruthy();
      expect(typeof c.estimatedCost).toBe('number');
      expect(c.qualityScore).toBeGreaterThanOrEqual(0);
      expect(c.qualityScore).toBeLessThanOrEqual(1);
      expect(c.reason).toBeTruthy();
    }
  });
});

// ─── checkBudget ────────────────────────────────────────────────────────────

describe('checkBudget', () => {
  it('returns withinBudget=true when no budget is set', () => {
    const result = checkBudget({}, 0.50);
    expect(result.withinBudget).toBe(true);
    expect(result.remainingBudget).toBe(Infinity);
  });

  it('returns withinBudget=true when estimated cost fits', () => {
    const result = checkBudget({ sessionBudget: 1.00 }, 0.002);
    expect(result.withinBudget).toBe(true);
    expect(result.remainingBudget).toBeGreaterThan(0);
  });

  it('returns withinBudget=false when estimated cost exceeds remaining', () => {
    // sessionBudget is 1.00, sessionCost is 0.01 (from mock), estimated 1.50
    const result = checkBudget({ sessionBudget: 1.00 }, 1.50);
    expect(result.withinBudget).toBe(false);
  });

  it('calculates remaining budget correctly', () => {
    const result = checkBudget({ sessionBudget: 0.50 }, 0.002);
    // remaining = 0.50 - 0.01 (from mock getSummary sessionCost)
    expect(result.remainingBudget).toBeCloseTo(0.49, 4);
  });

  it('handles zero budget', () => {
    const result = checkBudget({ sessionBudget: 0.01 }, 0.10);
    expect(result.withinBudget).toBe(false);
  });
});

// ─── checkConsensus ─────────────────────────────────────────────────────────

describe('checkConsensus', () => {
  it('returns true when responses are similar above threshold', () => {
    const responseA = 'The solution is to use a factory pattern that creates objects based on input parameters.';
    const responseB = 'I recommend using the factory pattern to create objects dynamically based on user input.';
    expect(checkConsensus(responseA, responseB)).toBe(true);
  });

  it('returns false when responses are very different', () => {
    const responseA = 'Use a binary search algorithm with O(log n) complexity.';
    const responseB = 'The answer is 42. Consider using a hash map for O(1) lookups.';
    expect(checkConsensus(responseA, responseB)).toBe(false);
  });

  it('returns true when both responses are empty (fallback)', () => {
    expect(checkConsensus('', '')).toBe(true);
  });

  it('returns true when one response is empty (fallback)', () => {
    expect(checkConsensus('some meaningful content here', '')).toBe(true);
  });

  it('respects custom threshold', () => {
    const responseA = 'apple banana cherry date';
    const responseB = 'apple banana cherry date elderberry';

    // Lower threshold should more easily find agreement
    expect(checkConsensus(responseA, responseB, 0.1)).toBe(true);

    // Very high threshold should fail
    expect(checkConsensus(responseA, responseB, 0.99)).toBe(false);
  });

  it('matches on words longer than 3 characters', () => {
    const responseA = 'the cat sat on the mat';  // only "cat", "sat", "mat" count (>3 chars? No, all <=3)
    const responseB = 'the dog ran in the park'; // only "dog", "ran", "park" count
    // All tokens are <=3 chars, so both sets are empty → returns true (fallback)
    expect(checkConsensus(responseA, responseB)).toBe(true);
  });

  it('differentiates responses with shared key terms', () => {
    const responseA = 'Implement authentication using JWT tokens with refresh token rotation.';
    const responseB = 'Use JWT tokens for authentication, with proper token refresh and rotation.';
    // Shared (>3 char): authentication, JWT, tokens, refresh, token, rotation
    expect(checkConsensus(responseA, responseB, 0.2)).toBe(true);
  });

  it('reports disagreement when similarity is below threshold', () => {
    const responseA = 'The sky is blue and the ocean is blue.';
    const responseB = 'Quantum mechanics describes the behavior of particles at the subatomic level.';
    expect(checkConsensus(responseA, responseB, 0.1)).toBe(false);
  });
});

// ─── HybridModelRouter class ────────────────────────────────────────────────

describe('HybridModelRouter', () => {
  let router: HybridModelRouter;

  beforeEach(() => {
    resetHybridRouter();
    router = new HybridModelRouter({ verbose: false });
  });

  afterEach(() => {
    resetHybridRouter();
  });

  // ── resolveRouting ──────────────────────────────────────────────────────

  describe('resolveRouting', () => {
    it('returns a RoutingDecision with correct agentType', async () => {
      const decision = await router.resolveRouting('writer', 'implement a login form');
      expect(decision.agentType).toBe('writer');
    });

    it('detects complexity from task description', async () => {
      const trivial = await router.resolveRouting('writer', 'format this code');
      expect(trivial.complexity).toBe('trivial');

      const critical = await router.resolveRouting('writer', 'deploy to production');
      expect(critical.complexity).toBe('critical');
    });

    it('sets useConsensus=true for critical tasks by default', async () => {
      const decision = await router.resolveRouting('writer', 'critical security fix needed');
      expect(decision.useConsensus).toBe(true);
    });

    it('sets useConsensus=false for non-critical tasks', async () => {
      const decision = await router.resolveRouting('writer', 'refactor the login page');
      expect(decision.useConsensus).toBe(false);
    });

    it('sets userOverridden when userProvider is set', async () => {
      const decision = await router.resolveRouting(
        'writer',
        'write some code',
        { userProvider: 'gemini', userModel: 'gemini-2.0-flash' },
      );
      expect(decision.userOverridden).toBe(true);
    });

    it('uses fallback chain with first candidate matching provider', async () => {
      const decision = await router.resolveRouting('planner', 'complex distributed system design');
      expect(decision.fallbackChain.length).toBeGreaterThanOrEqual(1);
      expect(decision.fallbackChain[0].provider).toBeTruthy();
    });

    it('generates a non-empty explanation', async () => {
      const decision = await router.resolveRouting('writer', 'fix the bug in auth');
      expect(decision.explanation.length).toBeGreaterThan(10);
      expect(decision.explanation).toContain('writer');
    });

    it('explanation includes consensus mention when critical', async () => {
      const decision = await router.resolveRouting('writer', 'critical security vulnerability');
      expect(decision.explanation).toContain('consensus');
    });

    it('explanation includes budget info when sessionBudget is set', async () => {
      const budgetRouter = new HybridModelRouter({ sessionBudget: 1.00, verbose: false });
      const decision = await budgetRouter.resolveRouting('writer', 'implement feature');
      expect(decision.explanation).toContain('remaining');
    });
  });

  // ── runConsensus ────────────────────────────────────────────────────────

  describe('runConsensus', () => {
    it('calls both models in parallel and returns combined result', async () => {
      const primary = makeCandidate({ provider: 'groq', model: 'model-a' });
      const secondary = makeCandidate({ provider: 'gemini', model: 'model-b' });

      const callLLM = vi.fn()
        .mockResolvedValueOnce('I recommend using a factory pattern approach to create objects.')
        .mockResolvedValueOnce('The solution uses a factory pattern to create objects dynamically.');

      const result = await router.runConsensus(
        'test prompt',
        primary,
        secondary,
        callLLM,
      );

      expect(result.providerA).toBe('groq');
      expect(result.modelA).toBe('model-a');
      expect(result.providerB).toBe('gemini');
      expect(result.modelB).toBe('model-b');
      expect(result.agreed).toBe(true);
      expect(result.combinedResponse).toBe('I recommend using a factory pattern approach to create objects.');
      expect(result.responseA).toBe('I recommend using a factory pattern approach to create objects.');
      expect(result.responseB).toBe('The solution uses a factory pattern to create objects dynamically.');
      expect(callLLM).toHaveBeenCalledTimes(2);
    });

    it('handles disagreement gracefully', async () => {
      const primary = makeCandidate();
      const secondary = makeCandidate({ provider: 'gemini', model: 'gemini-2.0-flash' });

      const callLLM = vi.fn()
        .mockResolvedValueOnce('Use red for the primary button action.')
        .mockResolvedValueOnce('The quantum algorithm provides faster search results.');

      const result = await router.runConsensus(
        'What color should the button be?',
        primary,
        secondary,
        callLLM,
      );

      expect(result.agreed).toBe(false);
      // Falls back to primary's response
      expect(result.combinedResponse).toBe('Use red for the primary button action.');
    });

    it('throws when callLLM rejects', async () => {
      const primary = makeCandidate();
      const secondary = makeCandidate({ provider: 'gemini', model: 'gemini-2.0-flash' });

      const callLLM = vi.fn().mockRejectedValue(new Error('API error'));

      await expect(
        router.runConsensus('prompt', primary, secondary, callLLM),
      ).rejects.toThrow('API error');
    });
  });

  // ── tryFallbackChain ────────────────────────────────────────────────────

  describe('tryFallbackChain', () => {
    it('returns response from first successful candidate', async () => {
      const chain = [
        makeCandidate({ provider: 'groq', model: 'model-a' }),
        makeCandidate({ provider: 'gemini', model: 'model-b' }),
      ];

      const callLLM = vi.fn()
        .mockResolvedValueOnce('response from model-a');

      const result = await router.tryFallbackChain('prompt', chain, callLLM);
      expect(result.response).toBe('response from model-a');
      expect(result.usedCandidate.provider).toBe('groq');
      expect(callLLM).toHaveBeenCalledTimes(1);
    });

    it('tries fallback when primary fails', async () => {
      const chain = [
        makeCandidate({ provider: 'groq', model: 'model-a' }),
        makeCandidate({ provider: 'gemini', model: 'model-b' }),
      ];

      const callLLM = vi.fn()
        .mockRejectedValueOnce(new Error('Primary failed'))
        .mockResolvedValueOnce('response from model-b');

      const result = await router.tryFallbackChain('prompt', chain, callLLM);
      expect(result.response).toBe('response from model-b');
      expect(result.usedCandidate.provider).toBe('gemini');
      expect(callLLM).toHaveBeenCalledTimes(2);
    });

    it('throws when all candidates fail', async () => {
      const chain = [makeCandidate(), makeCandidate()];

      const callLLM = vi.fn().mockRejectedValue(new Error('All fail'));

      await expect(
        router.tryFallbackChain('prompt', chain, callLLM),
      ).rejects.toThrow('All models in fallback chain failed');
    });

    it('stops on first success even if later candidates would also succeed', async () => {
      const chain = [
        makeCandidate({ provider: 'groq', model: 'model-a' }),
        makeCandidate({ provider: 'gemini', model: 'model-b' }),
        makeCandidate({ provider: 'openrouter', model: 'model-c' }),
      ];

      const callLLM = vi.fn()
        .mockImplementation(async (_p: string, provider: string) => `response from ${provider}`);

      // Return response for model-a first
      callLLM.mockReset();
      callLLM.mockResolvedValueOnce('from model-a');

      const result = await router.tryFallbackChain('prompt', chain, callLLM);
      expect(result.response).toBe('from model-a');
      expect(callLLM).toHaveBeenCalledTimes(1);
    });

    it('tries all 3 fallbacks and fails with combined error message', async () => {
      const chain = [
        makeCandidate({ provider: 'groq', model: 'model-a' }),
        makeCandidate({ provider: 'gemini', model: 'model-b' }),
        makeCandidate({ provider: 'openrouter', model: 'model-c' }),
      ];

      const callLLM = vi.fn().mockRejectedValue(new Error('fail'));

      await expect(
        router.tryFallbackChain('prompt', chain, callLLM),
      ).rejects.toThrow('All models in fallback chain failed');
    });
  });

  // ── updateOptions / getOptions ─────────────────────────────────────────

  describe('updateOptions / getOptions', () => {
    it('returns the options passed at construction', () => {
      const r = new HybridModelRouter({ sessionBudget: 0.50, verbose: true });
      expect(r.getOptions().sessionBudget).toBe(0.50);
      expect(r.getOptions().verbose).toBe(true);
    });

    it('updates options when updateOptions is called', () => {
      router.updateOptions({ sessionBudget: 2.00 });
      expect(router.getOptions().sessionBudget).toBe(2.00);
    });

    it('preserves unspecified options after updateOptions', () => {
      router = new HybridModelRouter({ verbose: true, sessionBudget: 0.50 });
      router.updateOptions({ sessionBudget: 1.00 });
      expect(router.getOptions().verbose).toBe(true);
      expect(router.getOptions().sessionBudget).toBe(1.00);
    });

    it('enableConsensus defaults to true', () => {
      const r = new HybridModelRouter();
      expect(r.getOptions().enableConsensus).toBe(true);
    });
  });

  // ── getBenchmarkRecommendations ────────────────────────────────────────

  describe('getBenchmarkRecommendations', () => {
    it('returns empty array when no benchmark runs exist', () => {
      const recs = router.getBenchmarkRecommendations();
      expect(recs).toEqual([]);
    });

    it('returns recommendations with proper structure when data exists', async () => {
      // Re-mock benchmark to return data
      const benchModule = await import('../../src/learning/benchmark.js');
      vi.mocked(benchModule.getBenchmarkRuns).mockReturnValue([
        {
          id: 'bench-1',
          provider: 'groq',
          model: 'llama-3.3-70b-versatile',
          startedAt: 1000,
          endedAt: 5000,
          results: [
            {
              taskId: 'writer',
              provider: 'groq',
              model: 'llama-3.3-70b-versatile',
              output: 'output',
              success: true,
              latencyMs: 100,
              inputTokens: 10,
              outputTokens: 20,
              costUsd: 0.0001,
              qualityScore: 0.85,
              timestamp: 2000,
            },
            {
              taskId: 'writer',
              provider: 'groq',
              model: 'llama-3.3-70b-versatile',
              output: 'output',
              success: true,
              latencyMs: 150,
              inputTokens: 10,
              outputTokens: 20,
              costUsd: 0.0001,
              qualityScore: 0.9,
              timestamp: 3000,
            },
          ],
          summary: {
            totalTasks: 2,
            tasksPassed: 2,
            tasksFailed: 0,
            avgQualityScore: 0.875,
            medianLatencyMs: 125,
            totalCostUsd: 0.0002,
            totalTokens: 60,
          },
        },
      ]);

      // Re-instantiate to pick up new mock data
      const r = new HybridModelRouter();
      const recs = r.getBenchmarkRecommendations();
      expect(recs.length).toBeGreaterThanOrEqual(1);
      expect(recs[0].agentType).toBe('writer');
      expect(recs[0].recommendedModel).toContain('groq');
      expect(['high', 'medium', 'low']).toContain(recs[0].confidence);
    });
  });
});

// ─── Singleton ──────────────────────────────────────────────────────────────

describe('singleton', () => {
  afterEach(() => {
    resetHybridRouter();
  });

  it('getHybridRouter returns an instance', () => {
    const instance = getHybridRouter();
    expect(instance).toBeInstanceOf(HybridModelRouter);
  });

  it('getHybridRouter returns the same instance on repeated calls', () => {
    const a = getHybridRouter();
    const b = getHybridRouter();
    expect(a).toBe(b);
  });

  it('resetHybridRouter creates a new instance on next getHybridRouter', () => {
    const a = getHybridRouter();
    resetHybridRouter();
    const b = getHybridRouter();
    expect(a).not.toBe(b);
  });
});
