/**
 * Reasoning-replay cache tests (Nuvira-Router P4 M4.2).
 *
 * Covers: conversation-key fingerprints (stable, content-free), store/retrieve
 * round-trip per (provider, model, conversation), replace-on-newer semantics,
 * and hermetic BUFF_MEMORY_DIR isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildConversationKey,
  cacheReasoning,
  getCachedReasoning,
  clearReasoningCache,
  readReasoningCache,
} from '../../src/learning/reasoning-cache.js';

let tempDir: string;
let originalMemoryDir: string | undefined;

describe('reasoning-replay cache (M4.2)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-reasoning-cache-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
  });

  afterEach(() => {
    if (originalMemoryDir === undefined) delete process.env.BUFF_MEMORY_DIR;
    else process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('buildConversationKey is stable and content-free', () => {
    const messages = [
      { role: 'user' as const, content: 'explain JWT auth' },
      { role: 'assistant' as const, content: 'JWT is a token...' },
    ];
    expect(buildConversationKey(messages)).toBe(buildConversationKey(messages));
    // The fingerprint must not contain the raw content.
    expect(buildConversationKey(messages)).not.toContain('JWT');
    expect(buildConversationKey(messages)).not.toContain('explain');
  });

  it('round-trips reasoning per (provider, model, conversation)', () => {
    const key = buildConversationKey([{ role: 'user', content: 'hi' }]);
    cacheReasoning({
      provider: 'nuvira',
      model: 'gateway/reasoner',
      conversationKey: key,
      reasoningContent: 'The user greeted me. I should respond warmly.',
    });
    expect(getCachedReasoning('nuvira', 'gateway/reasoner', key)).toContain('greeted me');
    // Other provider / model / conversation → null (no cross-talk).
    expect(getCachedReasoning('groq', 'gateway/reasoner', key)).toBeNull();
    expect(getCachedReasoning('nuvira', 'other-model', key)).toBeNull();
    const otherKey = buildConversationKey([{ role: 'user', content: 'different question' }]);
    expect(getCachedReasoning('nuvira', 'gateway/reasoner', otherKey)).toBeNull();
  });

  it('a newer entry for the same triple replaces the older one', () => {
    const key = buildConversationKey([{ role: 'user', content: 'x' }]);
    cacheReasoning({ provider: 'p', model: 'm', conversationKey: key, reasoningContent: 'first pass' });
    cacheReasoning({ provider: 'p', model: 'm', conversationKey: key, reasoningContent: 'second pass' });
    expect(getCachedReasoning('p', 'm', key)).toBe('second pass');
    // And the cache holds exactly one entry for the triple.
    const entries = readReasoningCache().filter(
      (e) => e.provider === 'p' && e.model === 'm' && e.conversationKey === key,
    );
    expect(entries.length).toBe(1);
  });

  it('clear empties the cache', () => {
    const key = buildConversationKey([{ role: 'user', content: 'y' }]);
    cacheReasoning({ provider: 'p', model: 'm', conversationKey: key, reasoningContent: 'r' });
    expect(getCachedReasoning('p', 'm', key)).toBe('r');
    clearReasoningCache();
    expect(getCachedReasoning('p', 'm', key)).toBeNull();
    expect(readReasoningCache()).toEqual([]);
  });
});
