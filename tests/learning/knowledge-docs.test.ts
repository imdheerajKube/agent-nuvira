/**
 * The document half of the knowledge base: reads, TOC, content hashing, removal,
 * sync.
 *
 * `query` answers "where is it mentioned"; these answer "what does it say", in
 * the document's own order and wording. The distinction is the whole point of
 * the feature for a spec-driven build, so the tests here are about FIDELITY
 * (verbatim text, correct section) and about the folder being kept in step
 * (nothing re-embedded when nothing changed, nothing served after it vanished).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ingestKnowledge,
  syncKnowledgeTag,
  readKnowledgeDocument,
  listKnowledgeSections,
  removeKnowledgeDocument,
  forgetKnowledgeTag,
  getKnowledgeTag,
  listKnowledgeTags,
  namespaceForTag,
  MAX_READ_CHARS,
} from '../../src/learning/knowledge-base.js';
import { getVectorStore, resetVectorBackendSelection } from '../../src/memory/vector-store.js';

const embed = async (): Promise<number[]> => new Array(384).fill(0.1);

const SPEC = [
  '# Payments Spec',
  '',
  'Overview of the payments module.',
  '',
  '## Idempotency',
  '',
  'Every write takes a client-supplied idempotency key. A repeated key returns the',
  'original response rather than charging twice.',
  '',
  '## Retries',
  '',
  'The gateway retries a failed charge three times with exponential backoff.',
].join('\n');

let dir = '';
const realMemoryDir = process.env.NUVIRA_MEMORY_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuvira-knowledge-docs-'));
  process.env.NUVIRA_MEMORY_DIR = join(dir, 'memory');
  resetVectorBackendSelection();
});

afterEach(() => {
  if (realMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = realMemoryDir;
  rmSync(dir, { recursive: true, force: true });
});

function writeDoc(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

describe('reads', () => {
  it('returns a document verbatim, not a retrieval summary of it', async () => {
    const doc = writeDoc('payments.md', SPEC);
    await ingestKnowledge('spec', [doc], { embedFn: embed });

    const read = readKnowledgeDocument('spec', 'payments.md');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.text).toBe(SPEC);
    expect(read.text).toContain('## Retries');
    expect(read.truncated).toBe(false);
  });

  it('returns ONE section by its heading, matched case-insensitively and by suffix', async () => {
    await ingestKnowledge('spec', [writeDoc('payments.md', SPEC)], { embedFn: embed });

    for (const ref of ['Retries', 'retries', 'Payments Spec > Retries']) {
      const read = readKnowledgeDocument('spec', 'payments.md', ref);
      expect(read.ok, `section ref '${ref}'`).toBe(true);
      if (!read.ok) continue;
      expect(read.text).toContain('## Retries');
      expect(read.text).toContain('three times with exponential backoff');
      // A section read must not leak the rest of the document.
      expect(read.text).not.toContain('idempotency key');
      expect(read.headingPath).toBe('Payments Spec > Retries');
    }
  });

  it('lists the available sections instead of answering with the whole document', async () => {
    await ingestKnowledge('spec', [writeDoc('payments.md', SPEC)], { embedFn: embed });
    const read = readKnowledgeDocument('spec', 'payments.md', 'Nonexistent Heading');
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toContain('No section');
    expect(read.reason).toContain('Idempotency');
    expect(read.reason).not.toContain('idempotency key');
  });

  it('refuses an ambiguous basename rather than picking one silently', async () => {
    mkdirSync(join(dir, 'a'), { recursive: true });
    mkdirSync(join(dir, 'b'), { recursive: true });
    writeDoc('a/notes.md', '# A notes\n\nalpha');
    writeDoc('b/notes.md', '# B notes\n\nbeta');
    await ingestKnowledge('spec', [join(dir, 'a'), join(dir, 'b')], { embedFn: embed });

    const ambiguous = readKnowledgeDocument('spec', 'notes.md');
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.reason).toContain('matches 2 documents');

    // …but an exact path still resolves.
    const exact = readKnowledgeDocument('spec', join(dir, 'b', 'notes.md'));
    expect(exact.ok).toBe(true);
    if (exact.ok) expect(exact.text).toContain('beta');
  });

  it('truncates honestly at the cap rather than pretending to be complete', async () => {
    const long = `# Big\n\n${'x'.repeat(MAX_READ_CHARS + 5_000)}`;
    await ingestKnowledge('spec', [writeDoc('big.md', long)], { embedFn: embed });
    const read = readKnowledgeDocument('spec', 'big.md');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.truncated).toBe(true);
    expect(read.text.length).toBe(MAX_READ_CHARS);
  });

  it('reports a missing document with what IS available', async () => {
    await ingestKnowledge('spec', [writeDoc('payments.md', SPEC)], { embedFn: embed });
    const read = readKnowledgeDocument('spec', 'nope.md');
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.reason).toContain("No document 'nope.md'");
      expect(read.reason).toContain('payments.md');
    }
  });
});

describe('table of contents', () => {
  it('lists documents and their headings, without the preamble', async () => {
    await ingestKnowledge('spec', [writeDoc('payments.md', SPEC)], { embedFn: embed });
    const toc = listKnowledgeSections('spec');
    expect(toc).toHaveLength(1);
    expect(toc[0].title).toBe('Payments Spec');
    expect(toc[0].sections.map((s) => [s.headingPath, s.title])).toEqual([
      ['', 'Payments Spec'],
      ['Payments Spec', 'Idempotency'],
      ['Payments Spec', 'Retries'],
    ]);
    // Empty for an unknown tag rather than throwing.
    expect(listKnowledgeSections('nope')).toEqual([]);
  });
});

describe('content hashing and sync', () => {
  it('does not re-embed an unchanged document, and says so', async () => {
    const doc = writeDoc('payments.md', SPEC);
    const first = await ingestKnowledge('spec', [doc], { embedFn: embed });
    expect(first.unchanged).toBe(0);
    expect(first.chunks).toBeGreaterThan(0);

    const second = await ingestKnowledge('spec', [doc], { embedFn: embed });
    expect(second.unchanged).toBe(1);
    expect(second.chunks).toBe(0);
    // And the document is still fully readable — skipping the embed did not
    // skip the stored text.
    expect(readKnowledgeDocument('spec', 'payments.md').ok).toBe(true);
  });

  it('reports added / changed / unchanged and prunes what vanished', async () => {
    const root = join(dir, 'specs');
    mkdirSync(root, { recursive: true });
    const payments = writeDoc('specs/payments.md', SPEC);
    writeDoc('specs/other.md', '# Other\n\nunchanged body');

    const first = await syncKnowledgeTag('spec', [root], { embedFn: embed });
    expect(first.added).toBe(2);
    expect(first.changed).toBe(0);
    expect(first.removed).toEqual([]);

    // Change one, delete the other, add a third.
    writeFileSync(payments, `${SPEC}\n\n## New section\n\nadded`, 'utf-8');
    rmSync(join(root, 'other.md'));
    writeDoc('specs/third.md', '# Third\n\nbrand new');

    const second = await syncKnowledgeTag('spec', [root], { embedFn: embed });
    expect(second.changed).toBe(1);
    expect(second.added).toBe(1);
    expect(second.unchanged).toBe(0);
    expect(second.removed.map((p) => p.split(/[\\/]/).pop())).toEqual(['other.md']);

    // The deleted document stops being served AND stops being retrievable.
    expect(readKnowledgeDocument('spec', 'other.md').ok).toBe(false);
    expect(getKnowledgeTag('spec')?.documents.map((d) => d.path.split(/[\\/]/).pop())).toEqual([
      'payments.md',
      'third.md',
    ]);

    const third = await syncKnowledgeTag('spec', [root], { embedFn: embed });
    expect(third.unchanged).toBe(2);
    expect(third.chunks).toBe(0);
  });

  it('prunes ONLY under the roots it was given, so a partial sync cannot empty a tag', async () => {
    const root = join(dir, 'specs');
    mkdirSync(root, { recursive: true });
    writeDoc('specs/payments.md', SPEC);
    const elsewhere = writeDoc('elsewhere.md', '# Elsewhere\n\nkept');

    await syncKnowledgeTag('spec', [root, elsewhere], { embedFn: embed });
    expect(getKnowledgeTag('spec')?.documents).toHaveLength(2);

    // Syncing only the folder must not treat the sibling file as vanished.
    const partial = await syncKnowledgeTag('spec', [root], { embedFn: embed });
    expect(partial.removed).toEqual([]);
    expect(readKnowledgeDocument('spec', 'elsewhere.md').ok).toBe(true);
  });

  it('does not let remove or forget leave the stored text behind', async () => {
    const doc = writeDoc('payments.md', SPEC);
    await ingestKnowledge('spec', [doc], { embedFn: embed });
    const storeDir = join(process.env.NUVIRA_MEMORY_DIR as string, 'knowledge-docs', 'spec');
    expect(existsSync(storeDir)).toBe(true);

    expect(await removeKnowledgeDocument('spec', 'payments.md')).toBe(true);
    expect(getKnowledgeTag('spec')).toBeNull();
    // Its chunks are gone from the namespace too.
    expect(await getVectorStore(namespaceForTag('spec')).count()).toBe(0);
    expect(readKnowledgeDocument('spec', 'payments.md').ok).toBe(false);

    await ingestKnowledge('spec', [doc], { embedFn: embed });
    expect(await forgetKnowledgeTag('spec')).toBe(true);
    expect(existsSync(storeDir)).toBe(false);
    expect(listKnowledgeTags().map((t) => t.tag)).not.toContain('spec');
  });
});
