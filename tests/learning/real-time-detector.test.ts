import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RealTimeSkillDetector,
  getRealTimeDetector,
  resetRealTimeDetector,
} from '../../src/learning/real-time-detector.js';

// Mock the event bus
vi.mock('../../src/observability/event-bus.js', () => ({
  getEventBus: () => ({
    emit: vi.fn(),
    on: vi.fn(() => vi.fn()),
  }),
  EventNames: {},
}));

// Mock skill-drafts
vi.mock('../../src/learning/skill-drafts.js', () => ({
  writeDraft: vi.fn(() => ({ ok: true, name: 'test-skill' })),
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

describe('RealTimeSkillDetector', () => {
  let detector: RealTimeSkillDetector;

  beforeEach(() => {
    resetRealTimeDetector();
    detector = new RealTimeSkillDetector('test-session');
  });

  afterEach(() => {
    resetRealTimeDetector();
  });

  describe('onToolCallSuccess', () => {
    it('buffers successful tool calls', () => {
      detector.onToolCallSuccess({
        tool: 'write_file',
        ok: true,
        durationMs: 100,
      });

      const status = detector.getStatus();
      expect(status.bufferSize).toBe(1);
    });

    it('ignores failed tool calls', () => {
      detector.onToolCallSuccess({
        tool: 'write_file',
        ok: false,
        durationMs: 100,
      });

      const status = detector.getStatus();
      expect(status.bufferSize).toBe(0);
    });

    it('respects buffer size limit', () => {
      // Add 35 events (MAX_BUFFER_SIZE is 30)
      for (let i = 0; i < 35; i++) {
        detector.onToolCallSuccess({
          tool: `tool_${i}`,
          ok: true,
          durationMs: 100,
        });
      }

      const status = detector.getStatus();
      expect(status.bufferSize).toBe(30);
    });
  });

  describe('pattern detection', () => {
    it('detects repeated patterns', async () => {
      // Add the same pattern twice
      detector.onToolCallSuccess({
        tool: 'write_file',
        ok: true,
        durationMs: 100,
      });
      detector.onToolCallSuccess({
        tool: 'run_terminal_command',
        ok: true,
        durationMs: 200,
      });

      // Wait for async detection
      await new Promise((r) => setTimeout(r, 50));

      // Add same pattern again
      detector.onToolCallSuccess({
        tool: 'write_file',
        ok: true,
        durationMs: 100,
      });
      detector.onToolCallSuccess({
        tool: 'run_terminal_command',
        ok: true,
        durationMs: 200,
      });

      // Wait for async detection
      await new Promise((r) => setTimeout(r, 50));

      const status = detector.getStatus();
      expect(status.patternsTracked).toBeGreaterThan(0);
    });

    it('respects min pattern length', () => {
      // Add only 1 event (below MIN_PATTERN_LENGTH of 2)
      detector.onToolCallSuccess({
        tool: 'write_file',
        ok: true,
        durationMs: 100,
      });

      const status = detector.getStatus();
      expect(status.patternsTracked).toBe(0);
    });
  });

  describe('status', () => {
    it('reports correct status', () => {
      const status = detector.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.bufferSize).toBe(0);
      expect(status.patternsTracked).toBe(0);
    });

    it('respects enabled flag', () => {
      detector.setEnabled(false);
      detector.onToolCallSuccess({
        tool: 'write_file',
        ok: true,
        durationMs: 100,
      });

      const status = detector.getStatus();
      expect(status.bufferSize).toBe(0);
    });
  });

  describe('reset', () => {
    it('clears buffer and patterns', () => {
      detector.onToolCallSuccess({
        tool: 'write_file',
        ok: true,
        durationMs: 100,
      });
      detector.onToolCallSuccess({
        tool: 'run_terminal_command',
        ok: true,
        durationMs: 200,
      });

      detector.reset();

      const status = detector.getStatus();
      expect(status.bufferSize).toBe(0);
      expect(status.patternsTracked).toBe(0);
    });
  });

  describe('singleton', () => {
    it('returns same instance', () => {
      const d1 = getRealTimeDetector();
      const d2 = getRealTimeDetector();
      expect(d1).toBe(d2);
    });

    it('creates new instance after reset', () => {
      const d1 = getRealTimeDetector();
      resetRealTimeDetector();
      const d2 = getRealTimeDetector();
      expect(d1).not.toBe(d2);
    });
  });
});
