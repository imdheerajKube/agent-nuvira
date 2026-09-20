/**
 * Memory unification regressions.
 *
 * The defect: the model-facing memory tools (`add_memory` / `search_memory`)
 * wrote and read a JSON store of their own, while session recall and the
 * narrative memory provider read `memory/fact-store.ts`. A memory the model
 * recorded was therefore invisible to recall — and a fact learned from an
 * earlier session was invisible to `search_memory`. Two halves of one feature.
 *
 * These tests pin the fix:
 *   1. an entry written through the memory tools shows up in recall;
 *   2. `searchMemories` returns memory-store hits WITHOUT any embedding tier;
 *   3. the same text in both stores is deduped to one hit;
 *   4. fact-store hits are included when the semantic half is available.
 *
 * `node:os` is mocked at hoist time (the stores resolve paths from homedir on
 * import), and the fact store is spied so no embedding model is ever loaded.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const testDirHolder = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs');
  const { join } = require('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { value: mkdtempSync(join(base, 'memory-union-')) };
});

vi.mock('node:os', () => ({
  homedir: () => testDirHolder.value,
}));

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { getMemoryStore, resetMemoryStore, searchMemories } from '../../src/tools/memory-tools.js';
import { autoRecall, recallContextBlock } from '../../src/context/session-recall.js';
import { getFactStore, resetFactStore } from '../../src/memory/fact-store.js';
import { getChatHistory } from '../../src/context/history.js';
import { resetWorkspaceStore } from '../../src/config/workspace.js';

const ORIGINAL_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;
const PROJECT_DIR = join(testDirHolder.value, 'project');

beforeAll(() => {
  process.env.NUVIRA_MEMORY_DIR = join(testDirHolder.value, 'memory');
});

afterAll(() => {
  if (ORIGINAL_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIGINAL_MEMORY_DIR;
  rmSync(testDirHolder.value, { recursive: true, force: true });
});

beforeEach(() => {
  resetMemoryStore();
  resetFactStore();
  resetWorkspaceStore();
  getChatHistory().clear();
  vi.restoreAllMocks();
  // No embeddings in these tests: the semantic half is stubbed per-test.
  vi.spyOn(getFactStore(), 'retrieveFacts').mockResolvedValue([]);
  vi.spyOn(getFactStore(), 'listFacts').mockResolvedValue([]);
});

afterEach(() => {
  getChatHistory().clear();
  resetMemoryStore();
  resetFactStore();
  resetWorkspaceStore();
  vi.restoreAllMocks();
});

/** A fact-store row shaped like a real one. */
function factRow(text: string, tags: string[] = []) {
  return {
    id: `fact-${text.length}`,
    text,
    projectId: 'p1',
    agentRole: 'extractor',
    tags,
    source: 'chat',
    timestamp: Date.now(),
  };
}

describe('agent-written memories reach recall', () => {
  it('includes an add_memory entry in autoRecall and the injected block', async () => {
    getMemoryStore().add({
      content: 'The user prefers tabs over spaces.',
      type: 'preference',
      tags: ['style'],
    });

    const recall = await autoRecall({ cwd: PROJECT_DIR });

    expect(recall.facts.map((f) => f.text)).toContain('The user prefers tabs over spaces.');
    expect(recallContextBlock(recall)).toContain('The user prefers tabs over spaces.');
  });

  it('dedupes an identical memory against a fact from the extractor', async () => {
    const shared = 'The project uses an Express backend.';
    getMemoryStore().add({ content: shared, type: 'fact' });
    vi.spyOn(getFactStore(), 'retrieveFacts').mockResolvedValue([factRow(shared)]);

    const recall = await autoRecall({ cwd: PROJECT_DIR });

    expect(recall.facts.filter((f) => f.text === shared)).toHaveLength(1);
  });

  it('still reports facts when the memory store is empty', async () => {
    vi.spyOn(getFactStore(), 'retrieveFacts').mockResolvedValue([factRow('Deploys run on Fridays.')]);
    const recall = await autoRecall({ cwd: PROJECT_DIR });
    expect(recall.facts.map((f) => f.text)).toContain('Deploys run on Fridays.');
  });
});

describe('search_memory spans both stores', () => {
  it('finds a memory-store entry with NO embedding tier available', async () => {
    getMemoryStore().add({
      content: 'Never commit generated files.',
      type: 'lesson',
      tags: ['git'],
    });

    const hits = await searchMemories({ query: 'generated files', projectId: 'p1' });

    expect(hits.map((h) => h.content)).toContain('Never commit generated files.');
    expect(hits[0].source).toBe('memory');
  });

  it('finds a fact-store entry the memory tools never wrote', async () => {
    vi.spyOn(getFactStore(), 'retrieveFacts').mockResolvedValue([factRow('Deploys run on Fridays.')]);

    const hits = await searchMemories({ query: 'deploys', projectId: 'p1' });

    expect(hits.map((h) => h.content)).toContain('Deploys run on Fridays.');
    expect(hits[0].source).toBe('facts');
  });

  it('merges both stores and dedupes identical text', async () => {
    const shared = 'The API uses bearer tokens.';
    getMemoryStore().add({ content: shared, type: 'fact' });
    vi.spyOn(getFactStore(), 'retrieveFacts').mockResolvedValue([factRow(shared), factRow('Unrelated fact.')]);

    const hits = await searchMemories({ query: 'bearer tokens', projectId: 'p1' });

    expect(hits.filter((h) => h.content === shared)).toHaveLength(1);
    expect(hits.map((h) => h.content)).toContain('Unrelated fact.');
  });

  it('honours the limit across the merged set', async () => {
    for (let i = 0; i < 5; i += 1) {
      getMemoryStore().add({ content: `memory number ${i}`, type: 'fact' });
    }
    const hits = await searchMemories({ limit: 3 });
    expect(hits).toHaveLength(3);
  });

  it('does not query the fact store when no project scope is given', async () => {
    const spy = vi.spyOn(getFactStore(), 'retrieveFacts').mockResolvedValue([factRow('Should be excluded.')]);
    getMemoryStore().add({ content: 'Scoped-less memory.', type: 'fact' });

    const hits = await searchMemories({ query: 'scoped' });

    expect(spy).not.toHaveBeenCalled();
    expect(hits).toHaveLength(1);
  });

  it('does not query the fact store for a non-fact type filter', async () => {
    const spy = vi.spyOn(getFactStore(), 'retrieveFacts').mockResolvedValue([factRow('Should be excluded.')]);
    getMemoryStore().add({ content: 'A lesson about retries.', type: 'lesson' });

    const hits = await searchMemories({ type: 'lesson', projectId: 'p1' });

    expect(spy).not.toHaveBeenCalled();
    expect(hits.every((h) => h.type === 'lesson')).toBe(true);
  });
});

describe('memory store singleton', () => {
  it('re-reads persisted entries from disk after a reset', () => {
    getMemoryStore().add({ content: 'durable observation', type: 'observation' });

    resetMemoryStore();

    expect(getMemoryStore().list().map((e) => e.content)).toContain('durable observation');
  });
});
