import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MemoryConsolidation,
  getMemoryConsolidation,
  resetMemoryConsolidation,
} from '../../src/memory/consolidation.js';

// Mock stores
vi.mock('../../src/memory/trajectory-store.js', () => ({
  getTrajectoryStore: () => ({
    getAll: vi.fn(() => []),
    pruneByPolicy: vi.fn(),
  }),
}));

vi.mock('../../src/learning/pattern-extractor.js', () => ({
  getPatternStore: () => ({
    getAll: vi.fn(() => []),
  }),
}));

vi.mock('../../src/learning/failure-lessons.js', () => ({
  getFailureLessonStore: () => ({
    extractLessons: vi.fn(async () => 0),
  }),
}));

vi.mock('../../src/learning/skill-store.js', () => ({
  getSkillStore: () => ({
    getAll: vi.fn(() => []),
  }),
}));

// Mock logger
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('MemoryConsolidation', () => {
  let consolidation: MemoryConsolidation;

  beforeEach(() => {
    resetMemoryConsolidation();
    consolidation = new MemoryConsolidation();
  });

  afterEach(() => {
    consolidation.stop();
    resetMemoryConsolidation();
  });

  describe('consolidateNow', () => {
    it('returns a valid result', async () => {
      const result = await consolidation.consolidateNow();
      expect(result).toHaveProperty('trajectoriesPruned');
      expect(result).toHaveProperty('patternsCompressed');
      expect(result).toHaveProperty('lessonsSummarized');
      expect(result).toHaveProperty('skillsPruned');
      expect(result).toHaveProperty('timestamp');
    });

    it('sets lastResult', async () => {
      await consolidation.consolidateNow();
      expect(consolidation.getLastResult()).not.toBeNull();
    });
  });

  describe('start/stop', () => {
    it('starts without error', () => {
      consolidation.start();
      // Should not throw
    });

    it('stops without error', () => {
      consolidation.start();
      consolidation.stop();
    });

    it('is idempotent', () => {
      consolidation.start();
      consolidation.start(); // Second call should be no-op
      consolidation.stop();
      consolidation.stop(); // Second call should be no-op
    });
  });

  describe('singleton', () => {
    it('returns same instance', () => {
      const c1 = getMemoryConsolidation();
      const c2 = getMemoryConsolidation();
      expect(c1).toBe(c2);
    });

    it('creates new instance after reset', () => {
      const c1 = getMemoryConsolidation();
      resetMemoryConsolidation();
      const c2 = getMemoryConsolidation();
      expect(c1).not.toBe(c2);
    });
  });
});
