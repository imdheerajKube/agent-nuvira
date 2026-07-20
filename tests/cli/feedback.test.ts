/**
 * FeedbackCommand — Unit tests for buff feedback record/list/stats/clear.
 *
 * Covers:
 * 1. Record feedback with CLI flags (--positive, --negative, --neutral)
 * 2. Record feedback with --comment
 * 3. List feedback entries
 * 4. List feedback for specific trajectory
 * 5. Show feedback stats
 * 6. Clear feedback with confirmation
 * 7. Edge cases: empty feedback, missing trajectory, clear cancelled
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import inquirer from 'inquirer';

import { logger } from '../../src/utils/logger.js';

// ─── Hoisted mock state ─────────────────────────────────────────────────────

const mockEntries: ReturnType<typeof vi.hoisted> = vi.hoisted(() => [] as Array<{
  id: string;
  trajectoryId: string;
  rating: string;
  goal: string;
  provider: string;
  model: string;
  createdAt: number;
  source: string;
  comment?: string;
}>);

const mockStore = vi.hoisted(() => ({
  record: vi.fn((trajectoryId: string, rating: string, context: any) => {
    const entry = {
      id: `feedback-${Date.now()}`,
      trajectoryId,
      rating,
      ...context,
      createdAt: Date.now(),
      source: 'cli',
    };
    mockEntries.push(entry);
    return entry;
  }),
  getAll: vi.fn(() => [...mockEntries]),
  getByTrajectory: vi.fn((id: string) => mockEntries.filter(e => e.trajectoryId === id)),
  getStats: vi.fn(() => {
    const total = mockEntries.length;
    const positives = mockEntries.filter(e => e.rating === 'positive').length;
    const negatives = mockEntries.filter(e => e.rating === 'negative').length;
    return {
      totalRatings: total,
      positiveRatio: total > 0 ? positives / total : 0,
      negativeRatio: total > 0 ? negatives / total : 0,
      neutralRatio: total > 0 ? (total - positives - negatives) / total : 0,
      recentTrend: 'stable' as const,
    };
  }),
  clear: vi.fn(() => {
    mockEntries.length = 0;
  }),
  ratingToScoreDelta: vi.fn((rating: string) => {
    if (rating === 'positive') return 0.3;
    if (rating === 'negative') return -0.3;
    return 0;
  }),
  getLastRating: vi.fn(),
}));

vi.mock('../../src/learning/feedback.js', () => ({
  getFeedbackStore: vi.fn(() => mockStore),
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function muteConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

async function runFeedback(args: string[]): Promise<void> {
  const { FeedbackCommand } = await import('../../src/cli/feedback.js');
  const cmd = new FeedbackCommand();
  const command = cmd.create();
  await command.parseAsync(['node', 'buff', ...args]);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('FeedbackCommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockEntries.length = 0;
    muteConsole();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── record ────────────────────────────────────────────────────────────

  describe('record', () => {
    it('should record positive feedback with --positive flag', async () => {
      const successSpy = vi.spyOn(logger, 'success');

      await runFeedback(['record', 'trajectory-001', '--positive']);

      expect(successSpy).toHaveBeenCalledWith(expect.stringContaining('positive'));
      expect(mockStore.record).toHaveBeenCalledWith(
        'trajectory-001',
        'positive',
        expect.objectContaining({ goal: 'cli-feedback' }),
      );
    });

    it('should record negative feedback with --negative flag', async () => {
      await runFeedback(['record', 'trajectory-002', '--negative']);

      expect(mockStore.record).toHaveBeenCalledWith(
        'trajectory-002',
        'negative',
        expect.any(Object),
      );
    });

    it('should record neutral feedback with --neutral flag', async () => {
      await runFeedback(['record', 'trajectory-003', '--neutral']);

      expect(mockStore.record).toHaveBeenCalledWith(
        'trajectory-003',
        'neutral',
        expect.any(Object),
      );
    });

    it('should include comment when --comment is given', async () => {
      await runFeedback(['record', 'trajectory-004', '--positive', '--comment', 'Great work!']);

      expect(mockStore.record).toHaveBeenCalledWith(
        'trajectory-004',
        'positive',
        expect.objectContaining({ comment: 'Great work!' }),
      );
    });

    it('should use a generated ID when no trajectory ID provided', async () => {
      await runFeedback(['record', '--positive']);

      // Should record with a trajectory-{timestamp} id
      const callArgs = mockStore.record.mock.calls[0];
      expect(callArgs[0]).toMatch(/^trajectory-/);
    });

    it('should handle interactive prompt when no flag given', async () => {
      vi.spyOn(inquirer, 'prompt').mockResolvedValue({ rating: 'positive' });
      const successSpy = vi.spyOn(logger, 'success');

      await runFeedback(['record', 'trajectory-005']);

      expect(successSpy).toHaveBeenCalledWith(expect.stringContaining('positive'));
    });

    it('should skip when user selects skip in interactive prompt', async () => {
      vi.spyOn(inquirer, 'prompt').mockResolvedValue({ rating: 'skip' });
      const infoSpy = vi.spyOn(logger, 'info');

      await runFeedback(['record', 'trajectory-006']);

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Feedback skipped'));
      expect(mockStore.record).not.toHaveBeenCalledWith('trajectory-006', 'skip', expect.any(Object));
    });

    it('should show score impact for positive feedback', async () => {
      const infoSpy = vi.spyOn(logger, 'info');

      await runFeedback(['record', 'trajectory-007', '--positive']);

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Score impact'));
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('+0.3'));
    });

    it('should show score impact for negative feedback', async () => {
      const infoSpy = vi.spyOn(logger, 'info');

      await runFeedback(['record', 'trajectory-008', '--negative']);

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('-0.3'));
    });
  });

  // ── list ──────────────────────────────────────────────────────────────

  describe('list', () => {
    it('should show message when no feedback exists', async () => {
      const infoSpy = vi.spyOn(logger, 'info');

      await runFeedback(['list']);

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('No feedback recorded'));
    });

    it('should list feedback entries when data exists', async () => {
      // Add some entries to the mock store
      mockEntries.push(
        { id: 'fb-1', trajectoryId: 'traj-001', rating: 'positive', goal: 'test', provider: 'groq', model: 'llama', createdAt: Date.now(), source: 'cli' },
        { id: 'fb-2', trajectoryId: 'traj-002', rating: 'negative', goal: 'test2', provider: 'gemini', model: 'gemini-2', createdAt: Date.now(), source: 'cli' },
      );

      const highlightSpy = vi.spyOn(logger, 'highlight');

      await runFeedback(['list']);

      expect(highlightSpy).toHaveBeenCalledWith(expect.stringContaining('Feedback Entries'));
      // Should show both entries
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('traj-001'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('traj-002'));
    });

    it('should filter by trajectory when --trajectory is given', async () => {
      mockEntries.push(
        { id: 'fb-3', trajectoryId: 'traj-003', rating: 'positive', goal: 'test', provider: 'groq', model: 'llama', createdAt: Date.now(), source: 'cli' },
        { id: 'fb-4', trajectoryId: 'traj-004', rating: 'negative', goal: 'test', provider: 'gemini', model: 'gemini', createdAt: Date.now(), source: 'cli' },
      );

      await runFeedback(['list', '--trajectory', 'traj-003']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('traj-003'));
      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('traj-004'));
    });

    it('should respect --limit flag', async () => {
      for (let i = 0; i < 20; i++) {
        mockEntries.push({ id: `fb-${i}`, trajectoryId: `traj-${i}`, rating: 'positive', goal: 'test', provider: 'groq', model: 'llama', createdAt: Date.now(), source: 'cli' });
      }

      await runFeedback(['list', '--limit', '5']);

      // Should show total entry count in the info line
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Total entries'));
    });
  });

  // ── stats ─────────────────────────────────────────────────────────────

  describe('stats', () => {
    it('should show empty message when no feedback', async () => {
      const infoSpy = vi.spyOn(logger, 'info');

      await runFeedback(['stats']);

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('No feedback recorded'));
    });

    it('should show stats when feedback exists', async () => {
      mockEntries.push(
        { id: 'fb-a', trajectoryId: 'traj-a', rating: 'positive', goal: 'test', provider: 'groq', model: 'llama', createdAt: Date.now(), source: 'cli' },
        { id: 'fb-b', trajectoryId: 'traj-b', rating: 'positive', goal: 'test', provider: 'groq', model: 'llama', createdAt: Date.now(), source: 'cli' },
        { id: 'fb-c', trajectoryId: 'traj-c', rating: 'negative', goal: 'test', provider: 'groq', model: 'llama', createdAt: Date.now(), source: 'cli' },
      );

      const highlightSpy = vi.spyOn(logger, 'highlight');

      await runFeedback(['stats']);

      expect(highlightSpy).toHaveBeenCalledWith(expect.stringContaining('Feedback Statistics'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Total ratings'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('66.7%')); // 2/3 positive
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('stable'));
    });
  });

  // ── clear ─────────────────────────────────────────────────────────────

  describe('clear', () => {
    it('should not clear without confirmation', async () => {
      vi.spyOn(inquirer, 'prompt').mockResolvedValue({ confirm: false });
      const infoSpy = vi.spyOn(logger, 'info');

      await runFeedback(['clear']);

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Clear cancelled'));
      expect(mockStore.clear).not.toHaveBeenCalled();
    });

    it('should clear feedback when confirmed', async () => {
      vi.spyOn(inquirer, 'prompt').mockResolvedValue({ confirm: true });
      const successSpy = vi.spyOn(logger, 'success');

      await runFeedback(['clear']);

      expect(successSpy).toHaveBeenCalledWith(expect.stringContaining('cleared'));
      expect(mockStore.clear).toHaveBeenCalled();
    });
  });
});
