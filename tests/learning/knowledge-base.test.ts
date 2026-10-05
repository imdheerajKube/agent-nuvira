/**
 * Knowledge base tests (`src/learning/knowledge-base.ts`).
 *
 * Hermetic: the memory dir is a temp dir (vectors + manifest live there) and the
 * vector backend is pinned to `json`. Embeddings are injectable, so these tests
 * never download the ~130 MB model — a constant vector is enough to prove the
 * pipeline (extract → chunk → embed → store → tag-scoped retrieve → forget).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  normalizeKnowledgeTag,
  isValidKnowledgeTag,
  namespaceForTag,
  ingestKnowledge,
  queryKnowledge,
  listKnowledgeTags,
  getKnowledgeTag,
  forgetKnowledgeTag,
  formatKnowledgeContext,
  collectKnowledgeFiles,
} from '../../src/learning/knowledge-base.js';
import { resetVectorBackendSelection } from '../../src/memory/vector-store.js';

/** Deterministic 384-dim embedding — constant, so every chunk scores equally. */
const constantEmbed = async (): Promise<number[]> => new Array(384).fill(0.1);

let dir = '';
const realMemoryDir = process.env.NUVIRA_MEMORY_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuvira-knowledge-'));
  process.env.NUVIRA_MEMORY_DIR = join(dir, 'memory');
  resetVectorBackendSelection();
});

afterEach(() => {
  if (realMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = realMemoryDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('tag normalization', () => {
  it('normalizes a human tag into a sandboxed namespace segment', () => {
    expect(normalizeKnowledgeTag('Dheeraj_Health_report')).toBe('dheeraj-health-report');
    expect(normalizeKnowledgeTag('  My Report  ')).toBe('my-report');
    expect(normalizeKnowledgeTag('a b  c')).toBe('a-b-c');
  });

  it('validates the normalized form', () => {
    expect(isValidKnowledgeTag('dheeraj-health-report')).toBe(true);
    expect(isValidKnowledgeTag('has_underscore')).toBe(false);
    expect(isValidKnowledgeTag('---')).toBe(false);
  });

  it('namespaces per tag', () => {
    expect(namespaceForTag('dheeraj-health-report')).toBe('knowledge-dheeraj-health-report');
  });
});

describe('collectKnowledgeFiles', () => {
  it('walks a directory and skips vendor dirs', () => {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'skip.txt'), 'x');
    writeFileSync(join(dir, 'a.txt'), 'a');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'b.txt'), 'b');
    const files = collectKnowledgeFiles(dir);
    expect(files.some((f) => f.endsWith('a.txt'))).toBe(true);
    expect(files.some((f) => f.endsWith('b.txt'))).toBe(true);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
  });
});

describe('ingest → query → forget', () => {
  it('answers a question from a tagged document without re-reading it per query', async () => {
    const docPath = join(dir, 'health.txt');
    writeFileSync(docPath, 'LDL cholesterol: 142 mg/dL\nHDL: 55 mg/dL\nTriglycerides: 120 mg/dL\n', 'utf-8');

    const result = await ingestKnowledge('Dheeraj_Health_report', [docPath], { embedFn: constantEmbed });
    expect(result.tag).toBe('dheeraj-health-report');
    expect(result.files).toBe(1);
    expect(result.chunks).toBeGreaterThan(0);

    const hits = await queryKnowledge('dheeraj-health-report', 'what is my LDL', { embedFn: constantEmbed });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.tag === 'dheeraj-health-report')).toBe(true);
    expect(hits.some((h) => h.text.includes('LDL'))).toBe(true);

    const context = formatKnowledgeContext('dheeraj-health-report', hits);
    expect(context).toContain("from your data: health.txt");
    expect(context).toContain('USER DATA');

    const tags = listKnowledgeTags();
    expect(tags.map((t) => t.tag)).toContain('dheeraj-health-report');
    expect(getKnowledgeTag('Dheeraj Health Report')?.documents.length).toBe(1);

    const removed = await forgetKnowledgeTag('dheeraj-health-report');
    expect(removed).toBe(true);
    expect(getKnowledgeTag('dheeraj-health-report')).toBeNull();
    expect(await queryKnowledge('dheeraj-health-report', 'ldl', { embedFn: constantEmbed })).toEqual([]);
  });

  it('re-ingesting a changed document overwrites its chunks instead of duplicating', async () => {
    const docPath = join(dir, 'note.md');
    writeFileSync(docPath, 'version one', 'utf-8');
    await ingestKnowledge('notes', [docPath], { embedFn: constantEmbed });
    const first = getKnowledgeTag('notes')?.chunkCount ?? 0;

    writeFileSync(docPath, 'version two', 'utf-8');
    await ingestKnowledge('notes', [docPath], { embedFn: constantEmbed });
    const entry = getKnowledgeTag('notes');
    // One document recorded, not two.
    expect(entry?.documents.length).toBe(1);
    expect(entry?.chunkCount).toBe(first);
  });

  it('skips unreadable paths and reports why', async () => {
    const result = await ingestKnowledge('misc', [join(dir, 'does-not-exist.txt')], { embedFn: constantEmbed });
    expect(result.files).toBe(0);
    expect(result.skipped[0].reason).toBe('not found');
  });

  it('rejects a tag with no letters or digits', async () => {
    await expect(ingestKnowledge('---', [join(dir, 'x.txt')], { embedFn: constantEmbed })).rejects.toThrow();
  });
});
