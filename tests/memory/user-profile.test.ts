import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  UserProfileManager,
  getUserProfile,
  resetUserProfile,
} from '../../src/memory/user-profile.js';

// Mock fs
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
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

describe('UserProfileManager', () => {
  let manager: UserProfileManager;

  beforeEach(() => {
    resetUserProfile();
    manager = new UserProfileManager();
  });

  afterEach(() => {
    resetUserProfile();
  });

  describe('updateUserProfile', () => {
    it('extracts detail level preference', () => {
      manager.updateUserProfile('Give me a brief explanation', '', true);
      const summary = manager.getSummary();
      expect(summary.preferenceCount).toBeGreaterThan(0);
    });

    it('detects expert-level vocabulary', () => {
      manager.updateUserProfile('Refactor the microservice architecture', '', true);
      const summary = manager.getSummary();
      expect(summary.expertise).toBe('expert');
    });

    it('detects intermediate vocabulary', () => {
      manager.updateUserProfile('Add an API endpoint', '', true);
      const summary = manager.getSummary();
      expect(summary.expertise).toBe('intermediate');
    });

    it('detects beginner vocabulary', () => {
      manager.updateUserProfile('Help me understand what is a component', '', true);
      const summary = manager.getSummary();
      expect(summary.expertise).toBe('beginner');
    });

    it('detects domains', () => {
      manager.updateUserProfile('Create a Python script', '', true);
      const summary = manager.getSummary();
      expect(summary.domains).toContain('python');
    });

    it('records decisions', () => {
      manager.updateUserProfile('Create a script', '', true);
      manager.updateUserProfile('Fix the bug', '', false);
      const summary = manager.getSummary();
      expect(summary.recentDecisions).toBe(2);
    });

    it('trims old decisions', () => {
      // Add 15 decisions (max is 10)
      for (let i = 0; i < 15; i++) {
        manager.updateUserProfile(`Task ${i}`, '', true);
      }
      const summary = manager.getSummary();
      expect(summary.recentDecisions).toBeLessThanOrEqual(10);
    });
  });

  describe('buildUserContextBlock', () => {
    it('returns empty string for empty profile', () => {
      const block = manager.buildUserContextBlock();
      expect(block).toBe('');
    });

    it('includes preferences', () => {
      manager.updateUserProfile('Give me a detailed explanation', '', true);
      const block = manager.buildUserContextBlock();
      expect(block).toContain('User Preferences');
    });

    it('includes expertise', () => {
      manager.updateUserProfile('Refactor the microservice', '', true);
      const block = manager.buildUserContextBlock();
      expect(block).toContain('User Expertise');
    });

    it('includes recent decisions', () => {
      manager.updateUserProfile('Create a script', '', true);
      const block = manager.buildUserContextBlock();
      expect(block).toContain('Recent Task Patterns');
    });

    it('respects max length', () => {
      // Fill profile with many preferences
      for (let i = 0; i < 20; i++) {
        manager.updateUserProfile(`Preference ${i} with long text`, '', true);
      }
      const block = manager.buildUserContextBlock();
      expect(block.length).toBeLessThanOrEqual(2000 + 100); // Allow some overhead
    });
  });

  describe('singleton', () => {
    it('returns same instance', () => {
      const m1 = getUserProfile();
      const m2 = getUserProfile();
      expect(m1).toBe(m2);
    });

    it('creates new instance after reset', () => {
      const m1 = getUserProfile();
      resetUserProfile();
      const m2 = getUserProfile();
      expect(m1).not.toBe(m2);
    });
  });
});
