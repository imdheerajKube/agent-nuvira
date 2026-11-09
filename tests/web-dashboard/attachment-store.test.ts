/**
 * Attachment store — durable upload, full ingestion, bounded retrieval.
 *
 * These tests are deliberately end-to-end at the store boundary: a real stream,
 * a real file on disk, the real `read_extract` readers, and the real chunk
 * search. They pin the behaviour that fixes the large-input failure:
 *
 *   - upload bytes are not a JSON/base64 body;
 *   - ingestion stores the WHOLE text, not a 40K first page;
 *   - the model-facing context is bounded;
 *   - a later turn can search/read the same attachment by ID.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AttachmentUploadError,
  chunkAttachmentText,
  fuseRerankedHits,
  getAttachmentStore,
  type AttachmentHit,
} from '../../src/web-dashboard/attachment-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuvira-attachments-'));
  process.env.NUVIRA_ATTACHMENT_DIR = dir;
  process.env.NUVIRA_ATTACHMENT_INGEST_MAX_CHARS = '1000000';
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.NUVIRA_ATTACHMENT_DIR;
  delete process.env.NUVIRA_ATTACHMENT_INGEST_MAX_CHARS;
  delete process.env.NUVIRA_ATTACHMENT_RERANK;
});

async function upload(name: string, body: string | Buffer, sessionId = 'session-1') {
  const store = getAttachmentStore();
  const receipt = await store.receiveUpload(Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]));
  const record = await store.finalizeUpload({
    sessionId,
    name,
    mime: 'text/plain',
    receipt,
  });
  const ready = await store.waitFor(record.id, 5000);
  if (!ready) throw new Error('attachment did not become ready');
  return { store, record: ready };
}

describe('attachment ingestion', () => {
  it('stores the full text and returns a ready manifest with an ID', async () => {
    const text = 'first line\n'.repeat(20_000) + 'THE-LAST-LINE\n';
    const { store, record } = await upload('large.txt', text);

    expect(record.status).toBe('ready');
    expect(record.chars).toBe(text.length);
    expect(record.chunkCount).toBeGreaterThan(1);
    expect(store.read(record.id, { offset: text.length - 30, limit: 100 })).toContain('THE-LAST-LINE');
  });

  it('uses finer chunks for long documents but keeps short sections together', () => {
    const longChunks = chunkAttachmentText('alpha '.repeat(10_000));
    expect(longChunks.every((chunk) => chunk.text.length <= 2_500)).toBe(true);

    const shortChunks = chunkAttachmentText('alpha '.repeat(1_000));
    expect(shortChunks).toHaveLength(1);
    expect(shortChunks[0].text.length).toBeGreaterThan(2_500);
  });

  it('chunks PDF-style page markers into page locators', () => {
    const chunks = chunkAttachmentText('[Page 1]\nAlpha\n\n[Page 2]\nBeta needle\n');
    expect(chunks.some((chunk) => chunk.page === 1)).toBe(true);
    expect(chunks.some((chunk) => chunk.page === 2 && chunk.text.includes('needle'))).toBe(true);
    expect(chunks.find((chunk) => chunk.page === 2)?.locator).toContain('page 2');
  });

  it('returns no hits when a question has no content terms', async () => {
    const { store, record } = await upload('prose.txt', 'alpha is here and of the thing\nwho is it\n');
    const found = store.search(record.id, 'What is the capital of France?', 3);
    expect('error' in found).toBe(false);
    if ('error' in found) return;
    expect(found.hits).toEqual([]);

    const noContent = store.search(record.id, 'who is it', 3);
    expect('error' in noContent).toBe(false);
    if ('error' in noContent) return;
    expect(noContent.hits).toEqual([]);
  });

  it('matches from word boundaries and does not treat a generic content word as evidence', async () => {
    // `nation` appears inside `explanation`; a mid-word substring match leaked
    // the World Cup question. `current` occurs as a real word but is not topic
    // evidence for a Bitcoin question. A specific term next to it still ranks.
    const { store, record } = await upload(
      'prose.txt',
      'The explanation for every rejection is required. The current plan version is 7.\n',
    );

    const worldCup = store.search(record.id, 'Which nation lifted the World Cup trophy in 2022?', 3);
    expect('error' in worldCup).toBe(false);
    if ('error' in worldCup) return;
    expect(worldCup.hits).toEqual([]);

    const bitcoin = store.search(record.id, 'What is the current price of Bitcoin?', 3);
    expect('error' in bitcoin).toBe(false);
    if ('error' in bitcoin) return;
    expect(bitcoin.hits).toEqual([]);

    const version = store.search(record.id, 'What is the current version?', 3);
    expect('error' in version).toBe(false);
    if ('error' in version) return;
    expect(version.hits.length).toBeGreaterThan(0);
  });

  it('matches applied/apply inflections without treating an unrelated question as evidence', async () => {
    const { store, record } = await upload(
      'guidance.txt',
      'Applies accepted changes only at safe points. Never apply during a tool call.\n',
    );

    const found = store.search(record.id, 'When may a change be applied?', 3);
    expect('error' in found).toBe(false);
    if ('error' in found) return;
    expect(found.hits[0]?.text).toContain('Applies accepted changes only at safe points.');

    const unrelated = store.search(record.id, 'What is the capital of France?', 3);
    expect('error' in unrelated).toBe(false);
    if ('error' in unrelated) return;
    expect(unrelated.hits).toEqual([]);
  });

  it('fuses lexical and reranker ranks instead of letting either overwrite the other', () => {
    const hit = (index: number): AttachmentHit => ({
      index,
      locator: `chars ${index}`,
      start: index,
      end: index + 1,
      text: `passage ${index}`,
      score: 1,
      snippet: `passage ${index}`,
    });
    const lexical = [hit(0), hit(1), hit(2)];
    const reranked = [
      { index: 2, score: 9 },
      { index: 0, score: 5 },
      { index: 1, score: 1 },
    ];

    const fused = fuseRerankedHits(lexical, reranked, 3);
    expect(fused.map((item) => item.index)).toEqual([0, 2, 1]);
    expect(fused.find((item) => item.index === 2)?.rerankScore).toBe(9);
  });

  it('falls back to lexical order when the optional reranker is disabled', async () => {
    process.env.NUVIRA_ATTACHMENT_RERANK = '0';
    const { store, record } = await upload(
      'notes.txt',
      'alpha is unrelated context\nthe needle is here\nomega filler\n',
    );

    const found = await store.searchRanked(record.id, 'needle', 2);
    expect('error' in found).toBe(false);
    if ('error' in found) return;
    expect(found.hits.length).toBeGreaterThan(0);
    expect(found.hits[0].snippet).toContain('needle');
    expect(found.hits[0].rerankScore).toBeUndefined();
  });

  it('searches stored chunks and reads a bounded window with the next offset', async () => {
    const { store, record } = await upload('notes.txt', 'alpha\n'.repeat(1000) + 'the needle is here\n' + 'omega\n'.repeat(1000));
    const found = store.search(record.id, 'needle', 3);
    expect('error' in found).toBe(false);
    if ('error' in found) return;

    expect(found.hits.length).toBeGreaterThan(0);
    expect(found.hits[0].snippet).toContain('needle');
    const window = store.read(record.id, { offset: 0, limit: 100 });
    expect(window).toContain('chars 1-100');
    expect(window).toContain('offset=100');
  });

  it('keeps the turn context bounded even when the document is much larger', async () => {
    const { store, record } = await upload(
      'huge.txt',
      'filler '.repeat(30_000) + '\nUNIQUE-MARKER\n' + 'tail '.repeat(30_000),
    );
    process.env.NUVIRA_ATTACHMENT_RERANK = '0';
    const built = await store.buildContext([record.id], 'UNIQUE-MARKER', { maxChars: 3_000 });
    expect(built.context.length).toBeLessThan(4_000);
    expect(built.context).toContain('UNIQUE-MARKER');
    expect(built.context).toContain(`id="${record.id}"`);
  });

  it('records an explicit refusal for an unreadable file, not an empty success', async () => {
    const { record } = await upload('binary.bin', Buffer.from([0, 1, 2, 3, 4]));
    expect(record.status).toBe('failed');
    expect(record.error).toBeTruthy();
  });

  it('stops a stream at the configured upload cap', async () => {
    const store = getAttachmentStore();
    await expect(
      store.receiveUpload(Readable.from([Buffer.alloc(64)]), { maxBytes: 8 }),
    ).rejects.toBeInstanceOf(AttachmentUploadError);
  });

  it('lists by session and deletes the artifact', async () => {
    const { store, record } = await upload('one.txt', 'one', 'session-a');
    await upload('two.txt', 'two', 'session-b');
    expect(store.list('session-a').map((item) => item.name)).toEqual(['one.txt']);
    expect(store.delete(record.id)).toBe(true);
    expect(store.get(record.id)).toBeNull();
  });
});

describe('attachment retention and quota', () => {
  it('reports disk usage globally and per conversation', async () => {
    const { store, record } = await upload('one.txt', 'one'.repeat(2_000), 'session-a');
    await upload('two.txt', 'two'.repeat(2_000), 'session-b');

    const all = store.usage();
    const one = store.usage('session-a');
    expect(all.count).toBe(2);
    expect(all.bytes).toBeGreaterThan(4_000);
    expect(one.count).toBe(1);
    expect(one.sessions).toEqual([expect.objectContaining({ sessionId: 'session-a', count: 1 })]);
    expect(one.bytes).toBeGreaterThanOrEqual(record.size);
  });

  it('removes expired artifacts but keeps protected IDs', async () => {
    const { store, record: keep } = await upload('keep.txt', 'keep', 'session-a');
    const { record: old } = await upload('old.txt', 'old', 'session-b');
    const result = store.prune({
      now: Date.now() + 31 * 86_400_000,
      maxAgeMs: 30 * 86_400_000,
      minAgeMs: 0,
      protectedIds: [keep.id],
    });

    expect(result.removed).toBe(1);
    expect(store.get(keep.id)).not.toBeNull();
    expect(store.get(old.id)).toBeNull();
  });

  it('removes the oldest unprotected artifacts until the store fits its cap', async () => {
    const { store, record: oldest } = await upload('oldest.txt', 'a'.repeat(2_000), 'session-a');
    const { record: newest } = await upload('newest.txt', 'b'.repeat(2_000), 'session-b');
    const before = store.usage().bytes;
    const result = store.prune({
      maxAgeMs: 365 * 86_400_000,
      maxBytes: Math.floor(before / 2),
      minAgeMs: 0,
    });

    expect(result.removed).toBeGreaterThan(0);
    expect(store.usage().bytes).toBeLessThanOrEqual(Math.floor(before / 2));
    expect(store.get(oldest.id)).toBeNull();
    expect(store.get(newest.id)).not.toBeNull();
  });

  it('respects protected IDs when the cap is exceeded', async () => {
    const { store, record: keep } = await upload('keep.txt', 'a'.repeat(2_000), 'session-a');
    await upload('other.txt', 'b'.repeat(2_000), 'session-b');
    const result = store.prune({
      maxAgeMs: 365 * 86_400_000,
      maxBytes: 1,
      minAgeMs: 0,
      protectedIds: [keep.id],
    });

    expect(result.removed).toBeGreaterThan(0);
    expect(store.get(keep.id)).not.toBeNull();
    expect(store.usage().bytes).toBeGreaterThan(1);
  });
});
