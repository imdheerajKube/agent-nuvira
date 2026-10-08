/**
 * Bundle 31 — tier-3 behavioural labels.
 *
 * The inference must be conservative and auditable: a re-ask and a hand-edit are
 * negatives, an untouched-but-referenced artifact is a weak positive, and raw
 * silence — including an untouched artifact nobody mentioned — is NO label.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  askSimilarity,
  classifyBehaviouralLabel,
  deriveAndApplyBehaviouralLabel,
  normalizeAskTokens,
  referencesArtifact,
  wasModifiedAfter,
} from '../../src/learning/behavioural-labels.js';
import {
  clearDeliverableCandidates,
  readDeliverableCandidates,
  recordDeliverableCandidate,
} from '../../src/learning/deliverable-corpus.js';
import { beginTrace, getTrace } from '../../src/learning/reasoning-trace.js';

describe('behavioural labels — pure inference', () => {
  it('tokenizes asks and measures Jaccard similarity', () => {
    expect(normalizeAskTokens('Write a GUIDE.md now!').has('guide')).toBe(true);
    expect(askSimilarity('write the guide to guide.md', 'write the guide to guide.md')).toBe(1);
    // A different ask about a related subject shares only its common words.
    expect(askSimilarity('write a guide to key value stores', 'summarize this sales csv')).toBeLessThan(0.2);
  });

  it('recognizes a message that names the artifact', () => {
    expect(referencesArtifact('the guide.md looks right', 'guide.md')).toBe(true);
    expect(referencesArtifact('looks right, thanks', 'guide.md')).toBe(false);
  });

  it('classifies a near-identical re-ask as a rejection', () => {
    const label = classifyBehaviouralLabel({
      newAsk: 'write me a 3000 word guide to key value stores',
      previousAsk: 'write me a 3000 word guide to key value stores',
      reportsRegression: false,
      artifactPath: 'GUIDE.md',
      artifactModified: false,
      referencesArtifact: false,
    });
    expect(label).toEqual({ verdict: 'rejected', source: 'derived', reason: 'repeat-ask' });
  });

  it('classifies a hand-edited artifact as a rejection, even when mentioned', () => {
    const label = classifyBehaviouralLabel({
      newAsk: 'here is the guide.md for reference',
      previousAsk: 'write me a guide',
      reportsRegression: false,
      artifactPath: 'GUIDE.md',
      artifactModified: true,
      referencesArtifact: true,
    });
    expect(label).toEqual({ verdict: 'rejected', source: 'derived', reason: 'hand-edit' });
  });

  it('classifies an untouched, referenced artifact as a weak acceptance', () => {
    const label = classifyBehaviouralLabel({
      newAsk: 'great, now extend the guide.md with a security section',
      previousAsk: 'write me a guide to key value stores',
      reportsRegression: false,
      artifactPath: 'GUIDE.md',
      artifactModified: false,
      referencesArtifact: true,
    });
    expect(label).toEqual({ verdict: 'accepted', source: 'derived', reason: 'unchanged-referenced' });
  });

  it('leaves raw silence unlabelled — an untouched artifact nobody mentioned', () => {
    const label = classifyBehaviouralLabel({
      newAsk: 'what is the weather in delhi',
      previousAsk: 'write me a guide to key value stores',
      reportsRegression: false,
      artifactPath: 'GUIDE.md',
      artifactModified: false,
      referencesArtifact: false,
    });
    expect(label).toBeNull();
  });

  it('stands aside when a regression was reported (the correction path owns that label)', () => {
    const label = classifyBehaviouralLabel({
      newAsk: 'the guide is still broken',
      previousAsk: 'write me a guide',
      reportsRegression: true,
      artifactPath: 'GUIDE.md',
      artifactModified: false,
      referencesArtifact: true,
    });
    expect(label).toBeNull();
  });
});

describe('behavioural labels — against the corpus store', () => {
  let tempDir: string;
  let origMemory: string | undefined;
  let origConfig: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-behavioural-'));
    origMemory = process.env.NUVIRA_MEMORY_DIR;
    origConfig = process.env.NUVIRA_CONFIG_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    process.env.NUVIRA_CONFIG_DIR = join(tempDir, 'config');
    clearDeliverableCandidates();
  });

  afterEach(() => {
    if (origMemory === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = origMemory;
    if (origConfig === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = origConfig;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function seed(path: string, ask: string, traceId?: string): number {
    const now = Date.now();
    recordDeliverableCandidate({ ask, path, deliveredWords: 1200, excerpt: '# Doc\n\nProse.', ...(traceId ? { traceId } : {}) }, now);
    return now;
  }

  it('rejects a re-ask and labels the corpus row', () => {
    seed('does-not-matter.md', 'write me a guide to key value stores');
    const label = deriveAndApplyBehaviouralLabel({
      newAsk: 'write me a guide to key value stores',
      reportsRegression: false,
    });
    expect(label?.reason).toBe('repeat-ask');
    const rows = readDeliverableCandidates();
    expect(rows[rows.length - 1].verdict).toBe('rejected');
  });

  it('accepts an untouched artifact the user references', () => {
    const file = join(tempDir, 'GUIDE.md');
    writeFileSync(file, '# Guide\n\nReal prose.');
    const ts = seed(file, 'write me a guide to key value stores');
    // Ensure the file predates the delivery so it reads as untouched.
    utimesSync(file, new Date(ts - 10_000), new Date(ts - 10_000));

    const label = deriveAndApplyBehaviouralLabel({
      newAsk: 'nice — now extend the guide.md with a security section',
      reportsRegression: false,
    });
    expect(label).toEqual({ verdict: 'accepted', source: 'derived', reason: 'unchanged-referenced' });
    expect(readDeliverableCandidates()[0].verdict).toBe('accepted');
  });

  it('rejects a hand-edited artifact and writes the label onto the trace too', () => {
    const file = join(tempDir, 'GUIDE.md');
    writeFileSync(file, '# Guide\n\nReal prose.');
    const traceId = beginTrace({ goal: 'write me a guide', source: 'chat', provider: 'groq', model: 'mock' });
    const ts = seed(file, 'write me a guide to key value stores', traceId);
    // The user rewrote the file AFTER delivery.
    utimesSync(file, new Date(ts + 5000), new Date(ts + 5000));

    const label = deriveAndApplyBehaviouralLabel({ newAsk: 'continue', reportsRegression: false });
    expect(label?.reason).toBe('hand-edit');
    expect(readDeliverableCandidates()[0].verdict).toBe('rejected');
    expect(getTrace(traceId)?.userVerdict).toMatchObject({ verdict: 'rejected', source: 'derived' });
  });

  it('does nothing when a regression was reported (the correction path labels it)', () => {
    seed('GUIDE.md', 'write me a guide to key value stores');
    const label = deriveAndApplyBehaviouralLabel({ newAsk: 'still broken', reportsRegression: true });
    expect(label).toBeNull();
    expect(readDeliverableCandidates()[0].verdict).toBeNull();
  });

  it('does nothing with no delivery to judge', () => {
    clearDeliverableCandidates();
    expect(deriveAndApplyBehaviouralLabel({ newAsk: 'hello', reportsRegression: false })).toBeNull();
  });

  it('wasModifiedAfter is false for a path it cannot resolve', () => {
    expect(wasModifiedAfter(join(tempDir, 'missing.md'), Date.now())).toBe(false);
  });
});
