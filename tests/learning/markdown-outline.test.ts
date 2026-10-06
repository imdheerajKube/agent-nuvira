/**
 * Markdown outline + heading-aware chunking (`src/learning/markdown-outline.ts`).
 *
 * Two things here are load-bearing for everything downstream: the heading path a
 * chunk carries (which is what makes a citation name a section, and what a
 * whole-document read is addressed by), and the GLOBAL, SEQUENTIAL chunk
 * numbering — those ids are the overwrite/delete keys for re-ingest, so a
 * per-section index would collide across sections and silently leave the retired
 * tail of a shortened document behind.
 */

import { describe, it, expect } from 'vitest';
import { parseMarkdownOutline, chunkMarkdown } from '../../src/learning/markdown-outline.js';

const DOC = [
  'Intro paragraph before any heading.',
  '',
  '# Auth Design',
  '',
  'Overview of auth.',
  '',
  '## Token refresh',
  '',
  'Tokens refresh five minutes before expiry.',
  '',
  '### Failure modes',
  '',
  'A replayed token revokes the family.',
  '',
  '## Revocation',
  '',
  'Operators can revoke a session.',
  '',
  '# Billing',
  '',
  'Invoices monthly.',
].join('\n');

describe('parseMarkdownOutline', () => {
  it('splits on headings and tracks the ancestor chain', () => {
    const sections = parseMarkdownOutline(DOC);
    expect(sections.map((s) => [s.level, s.headingPath, s.title])).toEqual([
      [0, '', '(preamble)'],
      [1, '', 'Auth Design'],
      [2, 'Auth Design', 'Token refresh'],
      [3, 'Auth Design > Token refresh', 'Failure modes'],
      [2, 'Auth Design', 'Revocation'],
      [1, '', 'Billing'],
    ]);
  });

  it('keeps each section’s heading line in its own text', () => {
    const sections = parseMarkdownOutline(DOC);
    const failureModes = sections.find((s) => s.title === 'Failure modes');
    expect(failureModes?.text).toContain('### Failure modes');
    expect(failureModes?.text).toContain('A replayed token revokes the family.');
    // A section never swallows the next section.
    expect(failureModes?.text).not.toContain('Revocation');
  });

  it('returns ONE section for a document with no headings (a non-Markdown file)', () => {
    const sections = parseMarkdownOutline('just prose\n\nand more prose');
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ level: 0, headingPath: '', title: '(document)' });
    expect(sections[0].text).toBe('just prose\n\nand more prose');
  });

  it('requires the space — `#hashtag` and `#!/bin/bash` are not headings', () => {
    const sections = parseMarkdownOutline('#hashtag line\n#!/bin/bash\n# Real heading\nbody');
    expect(sections.map((s) => s.title)).toEqual(['(preamble)', 'Real heading']);
  });

  it('drops an empty preamble but keeps a heading with no content', () => {
    const noPreamble = parseMarkdownOutline('# Title\nbody');
    expect(noPreamble[0].title).toBe('Title');

    const emptySection = parseMarkdownOutline('# A\n## B\n');
    expect(emptySection.map((s) => s.title)).toEqual(['A', 'B']);
  });

  it('tolerates trailing hashes and a deep chain', () => {
    const sections = parseMarkdownOutline('#### One\n##### Two\n###### Three\nbody');
    expect(sections.at(-1)?.headingPath).toBe('One > Two');
    expect(sections.at(-1)?.title).toBe('Three');
  });
});

describe('chunkMarkdown', () => {
  it('numbers chunks globally and never lets one straddle a heading', () => {
    const chunks = chunkMarkdown(DOC, 'auth.md');
    expect(chunks.length).toBeGreaterThan(1);
    // Sequential, document-wide ids — the re-ingest keys.
    expect(chunks.map((c) => c.id)).toEqual(chunks.map((_, i) => `auth.md#${i}`));
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    // No chunk contains two headings.
    for (const chunk of chunks) {
      expect(chunk.text.match(/^#{1,6}\s+/gm)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });

  it('attaches the heading path to the chunk, and to what gets EMBEDDED', () => {
    const chunks = chunkMarkdown(DOC, 'auth.md');
    const failureModes = chunks.find((c) => c.title === 'Failure modes');
    expect(failureModes?.headingPath).toBe('Auth Design > Token refresh > Failure modes');
    // Stored text is the document's own words…
    expect(failureModes?.text.startsWith('### Failure modes')).toBe(true);
    // …while the embedded text carries the breadcrumb, so a passage answers a
    // question phrased in the language of its section.
    expect(failureModes?.embedText.startsWith('Auth Design > Token refresh > Failure modes')).toBe(true);
  });

  it('leaves a document without headings exactly as paragraph chunking would', () => {
    const plain = 'paragraph one\n\nparagraph two';
    const chunks = chunkMarkdown(plain, 'notes.txt');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(plain);
    expect(chunks[0].embedText).toBe(plain);
    expect(chunks[0].headingPath).toBe('');
  });

  it('always yields one chunk, even for an empty document', () => {
    // A blanked file must still produce a chunk, or a re-ingest would have
    // nothing to overwrite and the old content would survive.
    const chunks = chunkMarkdown('', 'empty.md');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe('empty.md#0');
  });
});
