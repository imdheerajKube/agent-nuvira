"use strict";
/**
 * P2 — artifact extraction unit tests: the pure text→card parsing the chat
 * uses to render ```diff blocks, test/build output, and deploy URLs from an
 * agent answer (beyond the live plan/diff/tool events).
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const artifacts_1 = require("./artifacts");
(0, vitest_1.describe)('parseDiffSections', () => {
    (0, vitest_1.it)('splits a unified diff into per-file sections with b-side paths', () => {
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
        const sections = (0, artifacts_1.parseDiffSections)(diff);
        (0, vitest_1.expect)(sections).toHaveLength(2);
        (0, vitest_1.expect)(sections[0].path).toBe('src/a.ts');
        (0, vitest_1.expect)(sections[0].body).toContain('-old');
        (0, vitest_1.expect)(sections[1].path).toBe('src/b.ts');
        (0, vitest_1.expect)(sections[1].body).toContain('+only');
    });
    (0, vitest_1.it)('returns [] for empty or non-diff input', () => {
        (0, vitest_1.expect)((0, artifacts_1.parseDiffSections)('')).toEqual([]);
        (0, vitest_1.expect)((0, artifacts_1.parseDiffSections)('just some text')).toEqual([]);
    });
});
(0, vitest_1.describe)('extractArtifacts — diff blocks', () => {
    (0, vitest_1.it)('turns a ```diff fenced block into a DiffArtifact', () => {
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
        const { diffs } = (0, artifacts_1.extractArtifacts)(content);
        (0, vitest_1.expect)(diffs).toHaveLength(1);
        (0, vitest_1.expect)(diffs[0].files).toHaveLength(1);
        (0, vitest_1.expect)(diffs[0].files[0].path).toBe('package.json');
        (0, vitest_1.expect)(diffs[0].summary).toBe('1 file changed');
    });
    (0, vitest_1.it)('does not treat a plain code block as a diff', () => {
        const { diffs } = (0, artifacts_1.extractArtifacts)('```ts\nconst x = 1;\n```');
        (0, vitest_1.expect)(diffs).toHaveLength(0);
    });
});
(0, vitest_1.describe)('extractArtifacts — result blocks', () => {
    (0, vitest_1.it)('classifies a passing test run', () => {
        const content = ['Test run:', '```', 'PASS src/a.test.ts', 'PASS src/b.test.ts', '2 tests passed', '```'].join('\n');
        const { results } = (0, artifacts_1.extractArtifacts)(content);
        (0, vitest_1.expect)(results).toHaveLength(1);
        (0, vitest_1.expect)(results[0].verdict).toBe('pass');
        (0, vitest_1.expect)(results[0].title).toContain('PASS src/a.test.ts');
    });
    (0, vitest_1.it)('classifies a failing build as fail', () => {
        const content = ['```bash', 'FAIL src/a.test.ts', '1 test failed', 'exit code 1', '```'].join('\n');
        const { results } = (0, artifacts_1.extractArtifacts)(content);
        (0, vitest_1.expect)(results).toHaveLength(1);
        (0, vitest_1.expect)(results[0].verdict).toBe('fail');
    });
    (0, vitest_1.it)('ignores fenced blocks without result markers', () => {
        const content = ['```', 'some prose', '```'].join('\n');
        const { results } = (0, artifacts_1.extractArtifacts)(content);
        (0, vitest_1.expect)(results).toHaveLength(0);
    });
});
(0, vitest_1.describe)('extractArtifacts — deploy URLs', () => {
    (0, vitest_1.it)('extracts a URL on a deploy line', () => {
        const { deploys } = (0, artifacts_1.extractArtifacts)('🚀 Deployed to https://app.example.com/landing — enjoy!');
        (0, vitest_1.expect)(deploys).toHaveLength(1);
        (0, vitest_1.expect)(deploys[0].url).toBe('https://app.example.com/landing');
    });
    (0, vitest_1.it)('extracts a URL after a "Deployed:" line', () => {
        const { deploys } = (0, artifacts_1.extractArtifacts)('The build is live.\nDeployed:\nhttps://dash.example.com');
        (0, vitest_1.expect)(deploys.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(deploys[0].url).toBe('https://dash.example.com');
    });
    (0, vitest_1.it)('dedupes repeated URLs and ignores plain links', () => {
        const content = [
            'See https://example.com/docs for details.',
            '🚀 Live at https://app.example.com and also https://app.example.com.',
        ].join('\n');
        const { deploys } = (0, artifacts_1.extractArtifacts)(content);
        (0, vitest_1.expect)(deploys).toHaveLength(1);
        (0, vitest_1.expect)(deploys[0].url).toBe('https://app.example.com');
    });
});
(0, vitest_1.describe)('extractArtifacts — combined', () => {
    (0, vitest_1.it)('returns all artifact kinds from one answer, in order', () => {
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
        const { diffs, results, deploys } = (0, artifacts_1.extractArtifacts)(content);
        (0, vitest_1.expect)(diffs).toHaveLength(1);
        (0, vitest_1.expect)(results).toHaveLength(1);
        (0, vitest_1.expect)(results[0].verdict).toBe('pass');
        (0, vitest_1.expect)(deploys).toHaveLength(1);
        (0, vitest_1.expect)(deploys[0].url).toBe('https://preview.example.com');
    });
    (0, vitest_1.it)('returns empty artifacts for plain prose', () => {
        const { diffs, results, deploys } = (0, artifacts_1.extractArtifacts)('Everything is green. Nothing else to do.');
        (0, vitest_1.expect)(diffs).toHaveLength(0);
        (0, vitest_1.expect)(results).toHaveLength(0);
        (0, vitest_1.expect)(deploys).toHaveLength(0);
    });
});
(0, vitest_1.describe)('extractDeployUrls', () => {
    (0, vitest_1.it)('is safe on empty input', () => {
        (0, vitest_1.expect)((0, artifacts_1.extractDeployUrls)('')).toEqual([]);
    });
});
