/**
 * Knowledge turn wiring (`src/learning/knowledge-turn.ts`).
 *
 * TWO THINGS ARE LOAD-BEARING HERE, and they are not the happy path:
 *
 *  1. The feature is INERT unless the message opens with a marker that resolves
 *     to a tag the user actually has — no embedder call, no injected message, no
 *     note. That is the capability guarantee: a turn that did not ask for a
 *     document must behave exactly as it did before this module existed.
 *  2. When a tag does resolve, the WRONG CORPUS is never substituted and an
 *     unrelated question never receives passages dressed up as evidence — an
 *     unknown tag only ever suggests, and a floor-miss says so.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ingestKnowledge, type KnowledgeTagEntry } from '../../src/learning/knowledge-base.js';
import {
  buildKnowledgeTurnContext,
  parseKnowledgeMarker,
  stripKnowledgeMarker,
  suggestKnowledgeTags,
  MAX_KNOWLEDGE_BLOCK_CHARS,
} from '../../src/learning/knowledge-turn.js';
import { resetVectorBackendSelection } from '../../src/memory/vector-store.js';
import { digestPrompt } from '../../src/learning/prompt-layers.js';

/** Deterministic 384-dim embedding — constant, so every chunk scores equally. */
const constantEmbed = async (): Promise<number[]> => new Array(384).fill(0.1);
/** One-hot vectors, so two different axes are exactly orthogonal (cosine 0). */
const oneHot = (axis: number) => async (): Promise<number[]> => {
  const v = new Array(384).fill(0);
  v[axis] = 1;
  return v;
};

let dir = '';
const realMemoryDir = process.env.NUVIRA_MEMORY_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuvira-knowledge-turn-'));
  process.env.NUVIRA_MEMORY_DIR = join(dir, 'memory');
  resetVectorBackendSelection();
});

afterEach(() => {
  if (realMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = realMemoryDir;
  rmSync(dir, { recursive: true, force: true });
});

/** Ingest one small document under a tag, with an injectable embedder. */
async function seedTag(tag: string, embedFn: () => Promise<number[]> = constantEmbed): Promise<void> {
  const docPath = join(dir, `${tag}.md`);
  writeFileSync(docPath, 'Clause 4.2: invoices are due within 30 days of receipt.', 'utf-8');
  await ingestKnowledge(tag, [docPath], { embedFn });
}

const entry = (tag: string): KnowledgeTagEntry => ({ tag, updatedAt: 0, chunkCount: 1, documents: [] });

describe('parseKnowledgeMarker', () => {
  it('reads a leading tag, normalized', () => {
    expect(parseKnowledgeMarker('#spec-v2 what does auth do?')).toBe('spec-v2');
    expect(parseKnowledgeMarker('  #Dheeraj_Health_report summarize this')).toBe('dheeraj-health-report');
    expect(parseKnowledgeMarker('#policy')).toBe('policy');
  });

  it('ignores anything that is not a leading tag', () => {
    expect(parseKnowledgeMarker('what does `#spec` say?')).toBeNull();
    expect(parseKnowledgeMarker('# Title')).toBeNull();
    expect(parseKnowledgeMarker('## Section')).toBeNull();
    expect(parseKnowledgeMarker('#!/bin/bash')).toBeNull();
    expect(parseKnowledgeMarker('C# is a language')).toBeNull();
    // Numbers cannot open a tag — "#1 priority" is a sentence, not a lookup.
    expect(parseKnowledgeMarker('#1 priority: fix the build')).toBeNull();
  });
});

describe('stripKnowledgeMarker', () => {
  it('removes the marker so it does not steer the query vector', () => {
    expect(stripKnowledgeMarker('#spec how does auth work?')).toBe('how does auth work?');
    expect(stripKnowledgeMarker('how does auth work?')).toBe('how does auth work?');
  });
});

describe('suggestKnowledgeTags', () => {
  it('names a near-miss and a prefix match, and nothing further', () => {
    const tags = [entry('sec'), entry('spec-v2'), entry('onboarding')];
    expect(suggestKnowledgeTags('sek', tags)).toContain('sec');
    expect(suggestKnowledgeTags('spec', tags)).toContain('spec-v2');
    expect(suggestKnowledgeTags('zzzzzzzz', tags)).toEqual([]);
  });
});

describe('buildKnowledgeTurnContext — inert unless asked', () => {
  it('does nothing at all for a message with no marker', async () => {
    await seedTag('spec');
    const result = await buildKnowledgeTurnContext('how does auth work?');
    expect(result).toEqual({ block: '', outcome: 'none' });
  });

  it('does nothing for a stray leading `#word` when the user has NO tags', async () => {
    // The realistic false positive: a pasted `#include` opening a message. With
    // no corpus there is nothing to say, so it must say nothing.
    const result = await buildKnowledgeTurnContext('#include <stdio.h>\nwhy does this not compile?');
    expect(result).toEqual({ block: '', outcome: 'none' });
  });
});

describe('buildKnowledgeTurnContext — serving', () => {
  it('injects the resolved tag’s passages, attributed', async () => {
    await seedTag('spec');
    const result = await buildKnowledgeTurnContext('#spec when are invoices due?', { embedFn: constantEmbed });
    expect(result.outcome).toBe('matched');
    expect(result.tag).toBe('spec');
    expect(result.block).toContain('Knowledge tag: spec');
    expect(result.block).toContain('from your data: spec.md');
    expect(result.block).toContain('USER DATA');
  });

  it('suggests instead of substituting when the tag is unknown', async () => {
    await seedTag('spec-v2');
    const result = await buildKnowledgeTurnContext('#spec tell me about it', { embedFn: constantEmbed });
    expect(result.outcome).toBe('unknown-tag');
    expect(result.block).toContain("No knowledge tag '#spec'");
    expect(result.block).toContain('#spec-v2');
    // The wrong corpus is never read: no passages, and the model is told to
    // answer from what it knows rather than from a tag it did not get.
    expect(result.block).not.toContain('USER DATA');
    expect(result.tag).toBeUndefined();
  });

  it('says the tagged documents did not cover the question when the floor drops everything', async () => {
    await seedTag('policy', oneHot(0));
    // Orthogonal query vector → below the floor → an honest empty answer, which
    // is exactly what a store without a floor could never produce.
    const result = await buildKnowledgeTurnContext('#policy write an essay about cows', { embedFn: oneHot(1) });
    expect(result.outcome).toBe('empty');
    expect(result.tag).toBe('policy');
    expect(result.block).toContain('did not cover it');
    expect(result.block).not.toContain('USER DATA');
  });

  it('never throws and never returns a block when retrieval fails', async () => {
    await seedTag('policy');
    const broken = async (): Promise<number[]> => {
      throw new Error('model unavailable');
    };
    const result = await buildKnowledgeTurnContext('#policy anything', { embedFn: broken });
    // queryKnowledge swallows the failure into an empty result, which reads as
    // "nothing matched" — the honest answer, and never an exception.
    expect(result.outcome).toBe('empty');
    expect(result.block).not.toContain('USER DATA');
  });

  it('hard-caps the injected block', async () => {
    const docPath = join(dir, 'big.md');
    const paragraph = `Paragraph: ${'lorem ipsum dolor sit amet '.repeat(20)}`;
    writeFileSync(docPath, Array.from({ length: 60 }, () => paragraph).join('\n\n'), 'utf-8');
    await ingestKnowledge('big', [docPath], { embedFn: constantEmbed });

    const result = await buildKnowledgeTurnContext('#big lorem ipsum', { embedFn: constantEmbed });
    expect(result.outcome).toBe('matched');
    expect(result.block.length).toBeLessThanOrEqual(MAX_KNOWLEDGE_BLOCK_CHARS + 200);
  });
});

/**
 * The capability guarantee, stated as the prompt layers the trace records.
 *
 * The block is a USER-TURN context message, so it lands in the CONTEXT layer:
 * the stable (system) layer stays byte-identical — persona, tool contract and
 * reasoning instructions untouched and still prompt-cacheable — and the block
 * never masquerades as the user's ask.
 */
describe('buildKnowledgeTurnContext — the layer it lands in', () => {
  const thread = (knowledge?: string): string =>
    [
      '[System]',
      'You are Nuvira.',
      '',
      '[User]',
      '[Project context]\nfiles: 2',
      ...(knowledge ? ['', '[User]', knowledge] : []),
      '',
      '[User]',
      'how does auth work?',
    ].join('\n');

  it('leaves the stable layer byte-identical and files the block as context', () => {
    const before = digestPrompt(thread());
    const after = digestPrompt(thread('[Knowledge] Knowledge tag: spec\npassage'));

    expect(after.digests.systemDigest).toBe(before.digests.systemDigest);
    expect(after.layers.context).toContain('[Knowledge]');
    expect(after.layers.volatile).toContain('how does auth work?');
    expect(after.layers.volatile).not.toContain('[Knowledge]');
  });
});
