/**
 * P2 — artifact extraction unit tests: the pure text→card parsing the chat
 * uses to render ```diff blocks, test/build output, and deploy URLs from an
 * agent answer (beyond the live plan/diff/tool events).
 */

import { describe, it, expect } from 'vitest';
import { extractArtifacts, extractDeployUrls, parseDiffSections } from './artifacts';

describe('parseDiffSections', () => {
  it('splits a unified diff into per-file sections with b-side paths', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '+only',
    ].join('\n');
    const sections = parseDiffSections(diff);
    expect(sections).toHaveLength(2);
    expect(sections[0].path).toBe('src/a.ts');
    expect(sections[0].body).toContain('-old');
    expect(sections[1].path).toBe('src/b.ts');
    expect(sections[1].body).toContain('+only');
  });

  it('returns [] for empty or non-diff input', () => {
    expect(parseDiffSections('')).toEqual([]);
    expect(parseDiffSections('just some text')).toEqual([]);
  });
});

describe('extractArtifacts — diff blocks', () => {
  it('turns a ```diff fenced block into a DiffArtifact', () => {
    const content = [
      'Here is the change I made:',
      '```diff',
      'diff --git a/package.json b/package.json',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -1 +1 @@',
      '-"version": "1.0.0",',
      '+"version": "1.1.0",',
      '```',
      'Now run the tests.',
    ].join('\n');
    const { diffs } = extractArtifacts(content);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].files).toHaveLength(1);
    expect(diffs[0].files[0].path).toBe('package.json');
    expect(diffs[0].summary).toBe('1 file changed');
  });

  it('does not treat a plain code block as a diff', () => {
    const { diffs } = extractArtifacts('```ts\nconst x = 1;\n```');
    expect(diffs).toHaveLength(0);
  });
});

describe('extractArtifacts — result blocks', () => {
  it('classifies a passing test run', () => {
    const content = ['Test run:', '```', 'PASS src/a.test.ts', 'PASS src/b.test.ts', '2 tests passed', '```'].join('\n');
    const { results } = extractArtifacts(content);
    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe('pass');
    expect(results[0].title).toContain('PASS src/a.test.ts');
  });

  it('classifies a failing build as fail', () => {
    const content = ['```bash', 'FAIL src/a.test.ts', '1 test failed', 'exit code 1', '```'].join('\n');
    const { results } = extractArtifacts(content);
    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe('fail');
  });

  it('ignores fenced blocks without result markers', () => {
    const content = ['```', 'some prose', '```'].join('\n');
    const { results } = extractArtifacts(content);
    expect(results).toHaveLength(0);
  });
});

describe('extractArtifacts — deploy URLs', () => {
  it('extracts a URL on a deploy line', () => {
    const { deploys } = extractArtifacts('🚀 Deployed to https://app.example.com/landing — enjoy!');
    expect(deploys).toHaveLength(1);
    expect(deploys[0].url).toBe('https://app.example.com/landing');
  });

  it('extracts a URL after a "Deployed:" line', () => {
    const { deploys } = extractArtifacts('The build is live.\nDeployed:\nhttps://dash.example.com');
    expect(deploys.length).toBeGreaterThan(0);
    expect(deploys[0].url).toBe('https://dash.example.com');
  });

  it('dedupes repeated URLs and ignores plain links', () => {
    const content = [
      'See https://example.com/docs for details.',
      '🚀 Live at https://app.example.com and also https://app.example.com.',
    ].join('\n');
    const { deploys } = extractArtifacts(content);
    expect(deploys).toHaveLength(1);
    expect(deploys[0].url).toBe('https://app.example.com');
  });
});

describe('extractArtifacts — combined', () => {
  it('returns all artifact kinds from one answer, in order', () => {
    const content = [
      'I fixed the bug:',
      '```diff',
      'diff --git a/src/fix.ts b/src/fix.ts',
      '--- a/src/fix.ts',
      '+++ b/src/fix.ts',
      '@@ -1 +1 @@',
      '-broken',
      '+fixed',
      '```',
      '```',
      'PASS src/fix.test.ts',
      '```',
      '🚀 Preview: https://preview.example.com',
    ].join('\n');
    const { diffs, results, deploys } = extractArtifacts(content);
    expect(diffs).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe('pass');
    expect(deploys).toHaveLength(1);
    expect(deploys[0].url).toBe('https://preview.example.com');
  });

  it('returns empty artifacts for plain prose', () => {
    const { diffs, results, deploys } = extractArtifacts('Everything is green. Nothing else to do.');
    expect(diffs).toHaveLength(0);
    expect(results).toHaveLength(0);
    expect(deploys).toHaveLength(0);
  });
});

describe('extractDeployUrls', () => {
  it('is safe on empty input', () => {
    expect(extractDeployUrls('')).toEqual([]);
  });
});
