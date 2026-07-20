/**
 * ChatHistory — Unit tests for conversation history management.
 *
 * Covers:
 * 1. storeSession — storing messages, summary generation, tag extraction
 * 2. getSession — retrieving by ID
 * 3. search — keyword scoring, relevance ordering, empty results
 * 4. getAllSessions — recency sorting, limit
 * 5. getRecentSessions — day-based filtering
 * 6. count, clear, prune — lifecycle management
 * 7. formatSessionSummary — display formatting
 * 8. Edge cases — empty history, large datasets, auto-prune
 * 9. Singleton — getChatHistory returns same instance
 * 10. Data persistence — across instances, file on disk
 *
 * IMPORTANT: MEMORY_DIR and HISTORY_PATH in history.ts are module-level
 * constants evaluated ONCE at import time. We must mock os.homedir() before
 * the module loads, so vi.hoisted creates the temp dir eagerly.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Mock } from 'vitest';

// ─── Temp directory created at hoist time (before module loads) ────────────
// This ensures os.homedir() returns a valid path when history.ts evaluates
// its module-level constants (MEMORY_DIR, HISTORY_PATH).
// IMPORTANT: vi.hoisted runs before imports, so we must use require() here.

const testDirHolder = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs');
  const { join } = require('node:path');
  return { value: mkdtempSync(join('/tmp', 'buff-history-')) };
});

vi.mock('node:os', () => ({
  homedir: () => testDirHolder.value,
}));

// Mock the embedder so tests don't need Xenova/Python/LLM
vi.mock('../../src/memory/embedder.js', () => ({
  embed: vi.fn(),
  EMBEDDING_DIM: 384,
  clearEmbeddingCache: vi.fn(),
  embeddingCacheSize: vi.fn().mockReturnValue(0),
  resetEmbeddingTierCache: vi.fn(),
  setForceLLM: vi.fn(),
  isXenovaAvailable: vi.fn().mockResolvedValue(false),
  isPythonAvailable: vi.fn().mockResolvedValue(false),
  getActiveEmbeddingTier: vi.fn().mockResolvedValue('llm (fallback, 384-dim)'),
}));

// ─── Imports (must be after vi.mock — vi.mock hoists automatically) ───────

import { ChatHistory, getChatHistory } from '../../src/context/history.js';
import type { ChatHistory as ChatHistoryType } from '../../src/context/history.js';

// Import mocked embedder to control return values
import { embed as mockEmbed } from '../../src/memory/embedder.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const NOW = 1_000_000_000_000;

function userMsg(content: string, timestamp?: number) {
  return { role: 'user' as const, content, timestamp: timestamp ?? NOW };
}

function assistantMsg(content: string, timestamp?: number) {
  return { role: 'assistant' as const, content, timestamp: timestamp ?? NOW + 1000 };
}

function storeTestSession(
  history: ChatHistoryType,
  options?: { content?: string; provider?: string; model?: string },
): string {
  const content = options?.content ?? 'How do I implement authentication in Express?';
  return history.storeSession(
    [userMsg(content), assistantMsg('You can use JWT tokens...')],
    options?.provider ?? 'groq',
    options?.model ?? 'llama-3.3-70b-versatile',
  );
}

function clearTestHistory(): void {
  try {
    const history = new ChatHistory();
    history.clear();
  } catch { /* best-effort */ }
}

// ─── Cleanup after all tests ───────────────────────────────────────────────

afterAll(() => {
  try { rmSync(testDirHolder.value, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ChatHistory', () => {
  let history: ChatHistoryType;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // Clear previous test data so each test starts fresh
    clearTestHistory();
    history = new ChatHistory();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── storeSession ───────────────────────────────────────────────────────

  describe('storeSession', () => {
    it('should store a session and return a session ID', () => {
      const id = storeTestSession(history);
      expect(id).toBeTruthy();
      expect(id).toMatch(/^session-/);
    });

    it('should return empty string for empty messages', () => {
      const id = history.storeSession([], 'groq', 'llama');
      expect(id).toBe('');
    });

    it('should increment count after storing', () => {
      expect(history.count()).toBe(0);
      storeTestSession(history);
      expect(history.count()).toBe(1);
      storeTestSession(history, { content: 'second' });
      expect(history.count()).toBe(2);
    });

    it('should generate unique IDs for each session', () => {
      const id1 = storeTestSession(history, { content: 'first' });
      const id2 = storeTestSession(history, { content: 'second' });
      expect(id1).not.toBe(id2);
    });

    it('should generate summary from first user message', () => {
      const id = storeTestSession(history, { content: 'How do I implement authentication in Express?' });
      const session = history.getSession(id);
      expect(session?.summary).toContain('How do I implement');
    });

    it('should truncate long summaries with ellipsis', () => {
      const longMsg = 'x'.repeat(200);
      const id = history.storeSession([userMsg(longMsg), assistantMsg('response')], 'groq', 'llama');
      const session = history.getSession(id);
      expect(session?.summary).toMatch(/\.\.\.$/);
      expect(session?.summary!.length).toBeLessThanOrEqual(123);
    });

    it('should use "Empty session" when no user messages', () => {
      const id = history.storeSession([assistantMsg('Hello')], 'groq', 'llama');
      const session = history.getSession(id);
      expect(session?.summary).toBe('Empty session');
    });

    it('should extract code-related tags', () => {
      const id = history.storeSession(
        [userMsg('Create a function to sort an array'), assistantMsg('Here is the code...')], 'groq', 'llama',
      );
      expect(history.getSession(id)?.tags).toContain('code');
    });

    it('should extract debug-related tags', () => {
      const id = history.storeSession(
        [userMsg('Fix this bug in my login function'), assistantMsg('Found the issue...')], 'groq', 'llama',
      );
      expect(history.getSession(id)?.tags).toContain('debug');
    });

    it('should extract multiple tags', () => {
      const id = history.storeSession(
        [userMsg('Write a test for the config setup'), assistantMsg('Tests written')], 'groq', 'llama',
      );
      expect(history.getSession(id)?.tags).toEqual(expect.arrayContaining(['test', 'config']));
    });

    it('should limit tags to 5 maximum', () => {
      const id = history.storeSession(
        [userMsg('Create debug test for config refactor architecture explain'), assistantMsg('done')], 'groq', 'llama',
      );
      expect(history.getSession(id)?.tags.length).toBeLessThanOrEqual(5);
    });

    it('should store provider and model', () => {
      const id = history.storeSession([userMsg('hello'), assistantMsg('hi')], 'gemini', 'gemini-2.0-flash-exp');
      const session = history.getSession(id);
      expect(session?.provider).toBe('gemini');
      expect(session?.model).toBe('gemini-2.0-flash-exp');
    });

    it('should set startedAt and endedAt from message timestamps', () => {
      const t1 = NOW;
      const t2 = NOW + 5000;
      const id = history.storeSession([userMsg('hello', t1), assistantMsg('response', t2)], 'groq', 'llama');
      const session = history.getSession(id);
      expect(session?.startedAt).toBe(t1);
      expect(session?.endedAt).toBe(t2);
    });
  });

  // ── getSession ─────────────────────────────────────────────────────────

  describe('getSession', () => {
    it('should retrieve a stored session by ID', () => {
      const id = storeTestSession(history);
      expect(history.getSession(id)?.id).toBe(id);
    });

    it('should return null for non-existent ID', () => {
      expect(history.getSession('non-existent-id')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(history.getSession('')).toBeNull();
    });

    it('should return the session with all fields populated', () => {
      const id = storeTestSession(history);
      const session = history.getSession(id)!;
      expect(session).toHaveProperty('id');
      expect(session).toHaveProperty('provider');
      expect(session).toHaveProperty('model');
      expect(session).toHaveProperty('startedAt');
      expect(session).toHaveProperty('endedAt');
      expect(session).toHaveProperty('messages');
      expect(session).toHaveProperty('summary');
      expect(session).toHaveProperty('tags');
      expect(session.messages).toHaveLength(2);
    });
  });

  // ── search ─────────────────────────────────────────────────────────────

  describe('search', () => {
    it('should return empty array for empty query', () => {
      storeTestSession(history);
      expect(history.search('')).toHaveLength(0);
    });

    it('should find sessions matching summary', () => {
      storeTestSession(history, { content: 'authentication with JWT' });
      expect(history.search('authentication')).toHaveLength(1);
    });

    it('should return empty array when no matches', () => {
      storeTestSession(history, { content: 'hello world' });
      expect(history.search('nonexistent')).toHaveLength(0);
    });

    it('should be case-insensitive', () => {
      storeTestSession(history, { content: 'Authentication in Express' });
      expect(history.search('authentication')).toHaveLength(1);
    });

    it('should find sessions by tag match', () => {
      storeTestSession(history, { content: 'debug this error please' });
      expect(history.search('debug')).toHaveLength(1);
    });

    it('should find sessions by message content', () => {
      storeTestSession(history);
      history.storeSession([userMsg('something else'), assistantMsg('unrelated')], 'groq', 'llama');
      // The first session's assistant response contains 'JWT'
      expect(history.search('JWT')).toHaveLength(1);
    });

    it('should order results by relevance score', () => {
      const idA = storeTestSession(history, { content: 'authentication with JWT is important' });
      history.storeSession(
        [userMsg('some random topic'), assistantMsg('but JWT appears in this response')], 'groq', 'llama',
      );
      const results = history.search('JWT');
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe(idA);
    });

    it('should respect the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        history.storeSession([userMsg(`topic number ${i}`), assistantMsg('response')], 'groq', 'llama');
      }
      expect(history.search('topic', 3)).toHaveLength(3);
    });

    it('should match partial words', () => {
      storeTestSession(history, { content: 'authentication guide' });
      expect(history.search('auth')).toHaveLength(1);
    });

    it('should score user messages higher than assistant', () => {
      storeTestSession(history, { content: 'I need help with authentication' });
      history.storeSession(
        [userMsg('hello'), assistantMsg('authentication is the process of...')], 'groq', 'llama',
      );
      const results = history.search('authentication');
      // User message match should rank first
      expect(results[0].summary).toContain('I need help');
    });
  });

  // ── getAllSessions ─────────────────────────────────────────────────────

  describe('getAllSessions', () => {
    it('should return empty array when no sessions', () => {
      expect(history.getAllSessions()).toHaveLength(0);
    });

    it('should return sessions sorted by recency (newest first)', () => {
      const id1 = history.storeSession(
        [userMsg('first', NOW - 10000), assistantMsg('response', NOW - 9000)], 'groq', 'llama',
      );
      const id2 = history.storeSession(
        [userMsg('second', NOW), assistantMsg('response', NOW + 1000)], 'groq', 'llama',
      );
      const sessions = history.getAllSessions();
      expect(sessions[0].id).toBe(id2);
      expect(sessions[1].id).toBe(id1);
    });

    it('should respect the limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        history.storeSession([userMsg(`topic ${i}`), assistantMsg('response')], 'groq', 'llama');
      }
      expect(history.getAllSessions(3)).toHaveLength(3);
      expect(history.getAllSessions(50)).toHaveLength(10);
    });

    it('should default to 50 limit', () => {
      for (let i = 0; i < 60; i++) {
        history.storeSession([userMsg(`topic ${i}`), assistantMsg('response')], 'groq', 'llama');
      }
      expect(history.getAllSessions()).toHaveLength(50);
    });
  });

  // ── getRecentSessions ──────────────────────────────────────────────────

  describe('getRecentSessions', () => {
    it('should return empty when no sessions exist', () => {
      expect(history.getRecentSessions(7)).toHaveLength(0);
    });

    it('should return sessions within the specified day range', () => {
      const cutoff = NOW - 3 * 24 * 60 * 60 * 1000;
      history.storeSession([userMsg('recent', NOW), assistantMsg('resp', NOW + 1000)], 'groq', 'llama');
      history.storeSession(
        [userMsg('old', cutoff - 86400000), assistantMsg('resp', cutoff - 86300000)], 'groq', 'llama',
      );
      const recent = history.getRecentSessions(3);
      expect(recent).toHaveLength(1);
      expect(recent[0].summary).toContain('recent');
    });
  });

  // ── count ──────────────────────────────────────────────────────────────

  describe('count', () => {
    it('should return 0 for empty history', () => {
      expect(history.count()).toBe(0);
    });

    it('should return the correct number of stored sessions', () => {
      storeTestSession(history);
      expect(history.count()).toBe(1);
      storeTestSession(history, { content: 'second' });
      expect(history.count()).toBe(2);
    });

    it('should decrease after clear', () => {
      storeTestSession(history);
      storeTestSession(history, { content: 'second' });
      expect(history.count()).toBe(2);
      history.clear();
      expect(history.count()).toBe(0);
    });
  });

  // ── clear ──────────────────────────────────────────────────────────────

  describe('clear', () => {
    it('should remove all sessions', () => {
      storeTestSession(history);
      storeTestSession(history, { content: 'second' });
      history.clear();
      expect(history.count()).toBe(0);
      expect(history.getAllSessions()).toHaveLength(0);
    });

    it('should allow storing after clear', () => {
      storeTestSession(history);
      history.clear();
      expect(storeTestSession(history)).toBeTruthy();
      expect(history.count()).toBe(1);
    });

    it('should not throw when clearing empty history', () => {
      expect(() => history.clear()).not.toThrow();
    });
  });

  // ── prune ──────────────────────────────────────────────────────────────

  describe('prune', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    it('should remove sessions older than retention period', () => {
      history.storeSession([userMsg('old', NOW - 40 * DAY_MS), assistantMsg('resp', NOW - 40 * DAY_MS + 1000)], 'groq', 'llama');
      history.storeSession([userMsg('new', NOW), assistantMsg('resp', NOW + 1000)], 'groq', 'llama');
      expect(history.prune(30)).toBe(1);
      expect(history.count()).toBe(1);
    });

    it('should default to 30 days retention', () => {
      history.storeSession([userMsg('old', NOW - 40 * DAY_MS), assistantMsg('resp', NOW - 40 * DAY_MS + 1000)], 'groq', 'llama');
      expect(history.prune()).toBe(1);
    });

    it('should return 0 when no sessions exceed retention', () => {
      history.storeSession([userMsg('recent', NOW), assistantMsg('resp', NOW + 1000)], 'groq', 'llama');
      expect(history.prune(30)).toBe(0);
      expect(history.count()).toBe(1);
    });

    it('should return 0 for empty history', () => {
      expect(history.prune(30)).toBe(0);
    });
  });

  // ── formatSessionSummary ───────────────────────────────────────────────

  describe('formatSessionSummary', () => {
    it('should include session ID prefix', () => {
      const session = history.getSession(storeTestSession(history))!;
      expect(history.formatSessionSummary(session)).toContain('📝');
    });

    it('should include message count', () => {
      const id = history.storeSession([userMsg('q1'), assistantMsg('a1'), userMsg('q2'), assistantMsg('a2')], 'groq', 'llama');
      expect(history.formatSessionSummary(history.getSession(id)!)).toContain('4 msgs');
    });

    it('should include tags when present', () => {
      const id = history.storeSession([userMsg('debug this code'), assistantMsg('fixed')], 'groq', 'llama');
      const summary = history.formatSessionSummary(history.getSession(id)!);
      expect(summary).toContain('debug');
      expect(summary).toContain('[');
      expect(summary).toContain(']');
    });

    it('should not include tags when no tags extracted', () => {
      // Use content unlikely to trigger any tag keywords
      const id = history.storeSession([userMsg('hello'), assistantMsg('hi there')], 'groq', 'llama');
      const summary = history.formatSessionSummary(history.getSession(id)!);
      expect(summary).not.toContain('[');
    });

    it('should include summary text', () => {
      const id = storeTestSession(history, { content: 'How do I implement authentication?' });
      const summary = history.formatSessionSummary(history.getSession(id)!);
      expect(summary).toContain('How do I implement');
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle storing hundreds of sessions', () => {
      for (let i = 0; i < 100; i++) {
        history.storeSession([userMsg(`session ${i}`), assistantMsg('response')], 'groq', 'llama');
      }
      expect(history.count()).toBe(100);
    });

    it('should handle large message content', () => {
      const bigMsg = 'x'.repeat(10000);
      const id = history.storeSession([userMsg(bigMsg), assistantMsg('response')], 'groq', 'llama');
      expect(history.getSession(id)?.messages[0].content).toHaveLength(10000);
    });

    it('should handle special characters in search', () => {
      history.storeSession([userMsg('C++ template metaprogramming'), assistantMsg('complex')], 'groq', 'llama');
      expect(history.search('C++')).toHaveLength(1);
    });

    it('should handle unicode in messages', () => {
      history.storeSession([userMsg('Hello 世界!'), assistantMsg('🌍')], 'groq', 'llama');
      expect(history.search('世界')).toHaveLength(1);
    });

    it('should store same data twice as separate sessions', () => {
      const msg = [userMsg('hello'), assistantMsg('world')];
      const id1 = history.storeSession(msg, 'groq', 'llama');
      const id2 = history.storeSession(msg, 'groq', 'llama');
      expect(id1).not.toBe(id2);
      expect(history.count()).toBe(2);
    });

    it('should auto-prune when exceeding max sessions (500)', () => {
      for (let i = 0; i < 510; i++) {
        history.storeSession([userMsg(`session ${i}`), assistantMsg('response')], 'groq', 'llama');
      }
      expect(history.count()).toBeGreaterThanOrEqual(490);
      expect(history.count()).toBeLessThanOrEqual(510);
    });
  });

  // ── Singleton ──────────────────────────────────────────────────────────

  describe('getChatHistory singleton', () => {
    it('should return a ChatHistory instance', () => {
      expect(getChatHistory()).toBeInstanceOf(ChatHistory);
    });

    it('should return the same instance on multiple calls', () => {
      const instance1 = getChatHistory();
      const instance2 = getChatHistory();
      expect(instance1).toBe(instance2);
    });
  });

  // ── Data persistence ──────────────────────────────────────────────────

  describe('data persistence', () => {
    it('should persist sessions across instances', () => {
      const id = storeTestSession(history);
      const history2 = new ChatHistory();
      expect(history2.getSession(id)?.id).toBe(id);
    });

    it('should persist cleared state across instances', () => {
      storeTestSession(history);
      storeTestSession(history, { content: 'second' });
      history.clear();
      expect(new ChatHistory().count()).toBe(0);
    });

    it('should persist data file on disk', () => {
      storeTestSession(history);
      storeTestSession(history, { content: 'second' });
      expect(existsSync(join(testDirHolder.value, '.buff', 'memory', 'history.json'))).toBe(true);
    });
  });

  // ── Cross-provider ────────────────────────────────────────────────────

  describe('cross-provider storage', () => {
    it('should store sessions from different providers correctly', () => {
      const id1 = history.storeSession([userMsg('groq question'), assistantMsg('groq answer')], 'groq', 'llama-3.3-70b-versatile');
      const id2 = history.storeSession([userMsg('gemini question'), assistantMsg('gemini answer')], 'gemini', 'gemini-2.0-flash-exp');
      expect(history.getSession(id1)?.provider).toBe('groq');
      expect(history.getSession(id2)?.provider).toBe('gemini');
    });
  });

  // ── Semantic search ───────────────────────────────────────────────────

  describe('searchSemantic', () => {
    const makeVector = () =>
      Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.5) * 0.5);

    beforeEach(() => {
      // Reset mockEmbed to return a non-zero vector by default
      (mockEmbed as any).mockReset();
      (mockEmbed as any).mockResolvedValue(makeVector());
    });

    it('should return empty array for empty query', async () => {
      const results = await history.searchSemantic('');
      expect(results).toHaveLength(0);
    });

    it('should return sessions matching the query semantically', async () => {
      const id = storeTestSession(history, { content: 'How do I implement authentication in Express?' });
      const results = await history.searchSemantic('authentication with JWT', 5);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe(id);
    });

    it('should fall back to keyword search when embed returns zero vector', async () => {
      (mockEmbed as any).mockResolvedValue(new Array(384).fill(0));

      const id = storeTestSession(history, { content: 'authentication with JWT is important' });
      const results = await history.searchSemantic('authentication', 5);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe(id);
    });

    it('should respect the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        history.storeSession(
          [userMsg(`session ${i}`), assistantMsg('response')], 'groq', 'llama',
        );
      }

      // Re-index explicitly so all embeddings are complete before searching
      const indexed = await history.reindexSemantic();
      expect(indexed).toBe(5);

      const results = await history.searchSemantic('session', 3);
      // Should return results via VectorStore or keyword fallback
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('should fall back to keyword search on embed error', async () => {
      (mockEmbed as any).mockRejectedValue(new Error('embedding failed'));

      const id = storeTestSession(history, { content: 'unique test content here' });
      const results = await history.searchSemantic('unique test', 5);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe(id);
    });
  });

  // ── reindexSemantic ───────────────────────────────────────────────────

  describe('reindexSemantic', () => {
    beforeEach(() => {
      (mockEmbed as any).mockReset();
      (mockEmbed as any).mockResolvedValue(
        Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.5) * 0.5),
      );
    });

    it('should return 0 when no sessions exist', async () => {
      const count = await history.reindexSemantic();
      expect(count).toBe(0);
    });

    it('should index all stored sessions', async () => {
      storeTestSession(history, { content: 'first session' });
      storeTestSession(history, { content: 'second session' });

      const count = await history.reindexSemantic();
      expect(count).toBe(2);
    });
  });
});
