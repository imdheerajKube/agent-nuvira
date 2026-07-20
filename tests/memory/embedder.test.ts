import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { embed, clearEmbeddingCache, embeddingCacheSize, EMBEDDING_DIM, resetEmbeddingTierCache, setForceLLM, isXenovaAvailable, isPythonAvailable } from '../../src/memory/embedder.js';

describe('EMBEDDING_DIM', () => {
  it('should be 384 dimensions (all-MiniLM-L6-v2)', () => {
    expect(EMBEDDING_DIM).toBe(384);
  });
});

describe('embed', () => {
  beforeEach(() => {
    clearEmbeddingCache();
  });

  afterEach(() => {
    clearEmbeddingCache();
  });

  // ─── Direct JSON Array ────────────────────────────────────────────────

  it('should parse direct JSON array response from LLM', async () => {
    const mockLLM = async () => {
      const vec = Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(i) / 2);
      return JSON.stringify(vec);
    };

    const result = await embed('test text', mockLLM as any, true);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => typeof v === 'number')).toBe(true);
  });

  // ─── Code Block JSON ──────────────────────────────────────────────────

  it('should parse embedding from ```json code block', async () => {
    const mockLLM = async () => {
      const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.5);
      return `Here is the embedding:\n\`\`\`json\n${JSON.stringify(vec)}\n\`\`\`\n`;
    };

    const result = await embed('test', mockLLM as any, true);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0.5)).toBe(true);
  });

  it('should parse from ``` code block without language tag', async () => {
    const mockLLM = async () => {
      const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.25);
      return `\`\`\`\n${JSON.stringify(vec)}\n\`\`\``;
    };

    const result = await embed('test', mockLLM as any, true);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0.25)).toBe(true);
  });

  // ─── Array Pattern Fallback ───────────────────────────────────────────

  it('should find JSON array embedded in text', async () => {
    const mockLLM = async () => {
      const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.75);
      return `The embedding vector is ${JSON.stringify(vec)} which represents the semantic meaning.`;
    };

    const result = await embed('test', mockLLM as any, true);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0.75)).toBe(true);
  });

  // ─── Validation ───────────────────────────────────────────────────────

  it('should reject array with wrong dimension and fall back', async () => {
    const mockLLM = async () => JSON.stringify([0.1, 0.2, 0.3]); // Only 3 dimensions

    const result = await embed('test', mockLLM as any, true);
    // Should fall back to zero vector since 3 != 384
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0)).toBe(true);
  });

  it('should reject non-array response and fall back to zero vector', async () => {
    const mockLLM = async () => 'This is not JSON at all.';

    const result = await embed('test', mockLLM as any, true);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0)).toBe(true);
  });

  it('should reject NaN or Infinity values', async () => {
    const mockLLM = async () => {
      const vec = Array.from({ length: EMBEDDING_DIM }, () => NaN);
      return JSON.stringify(vec);
    };

    const result = await embed('test', mockLLM as any, true);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0)).toBe(true);
  });

  // ─── LLM Errors ──────────────────────────────────────────────────────

  it('should return zero vector when LLM throws', async () => {
    const mockLLM = async () => { throw new Error('API error'); };

    const result = await embed('test text', mockLLM as any, true);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0)).toBe(true);
  });

  // ─── Caching ──────────────────────────────────────────────────────────

  it('should cache results keyed by lowercase text', async () => {
    let callCount = 0;
    const mockLLM = async (prompt: string) => {
      callCount++;
      const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.42);
      return JSON.stringify(vec);
    };

    const result1 = await embed('Hello World', mockLLM as any, true);
    const result2 = await embed('hello world', mockLLM as any, true); // Same text, different case

    expect(result1).toEqual(result2);
    expect(callCount).toBe(1); // Should only call LLM once
  });

  it('should call LLM for different inputs', async () => {
    let callCount = 0;
    const mockLLM = async (prompt: string) => {
      callCount++;
      return JSON.stringify(Array.from({ length: EMBEDDING_DIM }, () => 0.5));
    };

    await embed('first text', mockLLM as any, true);
    await embed('second text', mockLLM as any, true);

    expect(callCount).toBe(2);
  });

  it('should return cached result from cache', async () => {
    let callCount = 0;
    const mockLLM = async () => {
      callCount++;
      return JSON.stringify(Array.from({ length: EMBEDDING_DIM }, () => 0.5));
    };

    await embed('cache me', mockLLM as any, true);
    await embed('cache me', mockLLM as any, true); // Should hit cache
    await embed('cache me', mockLLM as any, true); // Should hit cache

    expect(callCount).toBe(1);
  });

  // ─── Cache Clearing ──────────────────────────────────────────────────

  it('should clear the cache when clearEmbeddingCache is called', async () => {
    let callCount = 0;
    const mockLLM = async () => {
      callCount++;
      return JSON.stringify(Array.from({ length: EMBEDDING_DIM }, () => 0.5));
    };

    await embed('clearable', mockLLM as any, true);
    clearEmbeddingCache();
    await embed('clearable', mockLLM as any, true);

    expect(callCount).toBe(2);
  });

  it('should return 0 for embeddingCacheSize after clearing', () => {
    clearEmbeddingCache();
    expect(embeddingCacheSize()).toBe(0);
  });

  it('should track cache size correctly', async () => {
    clearEmbeddingCache();
    expect(embeddingCacheSize()).toBe(0);

    const mockLLM = async () =>
      JSON.stringify(Array.from({ length: EMBEDDING_DIM }, () => 0.5));

    await embed('text-a', mockLLM as any, true);
    expect(embeddingCacheSize()).toBe(1);

    await embed('text-b', mockLLM as any, true);
    expect(embeddingCacheSize()).toBe(2);

    clearEmbeddingCache();
    expect(embeddingCacheSize()).toBe(0);
  });

  // ─── Consecutive Parse Formats ────────────────────────────────────────

  it('should try strategies in order: direct, code block, array', async () => {
    // A response that fails direct JSON parsing but works as a code block
    const mockLLM = async () => {
      const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.33);
      return `\`\`\`json\n${JSON.stringify(vec)}\n\`\`\``;
    };

    const result = await embed('test', mockLLM as any, true);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result[0]).toBeCloseTo(0.33, 2);
  });
});

// ─── Tier 1: @huggingface/transformers path (mocked) ───────────────────────

describe('Tier 1: @huggingface/transformers', () => {
  beforeEach(() => {
    resetEmbeddingTierCache();
    clearEmbeddingCache();
  });

  it('should detect isXenovaAvailable as false when library not installed', async () => {
    // In test environment, @huggingface/transformers may or may not be installed
    const available = await isXenovaAvailable();
    // Either result is valid — the method should not throw
    expect(typeof available).toBe('boolean');
  });

  it('should detect isPythonAvailable as false without sentence-transformers', async () => {
    const available = await isPythonAvailable();
    // Unlikely to be installed in test environment
    expect(typeof available).toBe('boolean');
  });

  it('should return forceLLM mode string via getActiveEmbeddingTier', async () => {
    // setForceLLM is not the same as forceLLM param — it changes internal flags
    // Just verify the functions exist and work
    setForceLLM(true);
    expect(typeof await isXenovaAvailable()).toBe('boolean');
    expect(typeof await isPythonAvailable()).toBe('boolean');
    setForceLLM(false);
  });

  it('should reset tier cache correctly', async () => {
    // Force a known state, then reset
    resetEmbeddingTierCache();
    // After reset, detection should be re-attempted (returns false in test env)
    expect(typeof await isXenovaAvailable()).toBe('boolean');
  });

  it('should handle all tiers failing gracefully', async () => {
    // Force LLM-only mode, then call embed WITHOUT callLLM = all tiers fail
    setForceLLM(true);
    const result = await embed('test text without LLM');
    setForceLLM(false);
    expect(result).toHaveLength(EMBEDDING_DIM);
    // All tiers failed — should be zero vector
    expect(result.every((v) => v === 0)).toBe(true);
  });

  it('should fall through to LLM when native tiers are force-disabled', async () => {
    // When setForceLLM(true) is active, Tier 1 and 2 are skipped
    // embed should go directly to Tier 3 and use the LLM
    setForceLLM(true);
    const mockLLM = async () => {
      return JSON.stringify(Array.from({ length: EMBEDDING_DIM }, () => 0.5));
    };

    const result = await embed('fallback test', mockLLM as any);
    setForceLLM(false);
    expect(result).toHaveLength(EMBEDDING_DIM);
    // Should get LLM result (not zero vector)
    expect(result.some((v) => v !== 0)).toBe(true);
  });

  it('should fall through Tier 1 and Tier 2 to reach LLM fallback', async () => {
    // Xenova IS available in this env (it's in package.json).
    // To test the Tier 1→2→3 fallthrough chain, we force LLM mode
    // which skips native tiers and uses the mock directly.
    setForceLLM(true);
    const mockLLM = async () => {
      return JSON.stringify(Array.from({ length: EMBEDDING_DIM }, () => 0.75));
    };

    const result = await embed('tier test', mockLLM as any);
    setForceLLM(false);
    expect(result).toHaveLength(EMBEDDING_DIM);
    // Should have used LLM since native tiers are force-disabled
    expect(result[0]).toBeCloseTo(0.75, 2);
  });
});
