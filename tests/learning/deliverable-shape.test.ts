/**
 * The report's SHAPE, checked as a fact.
 *
 * Measured 2026-11-05 (head-to-head audit): the ask enumerated five sections, a
 * `Limitations` heading and `path:line` everywhere. The nuvira arm wrote the file
 * with 2/5 sections, zero citations and no Limitations heading, and `finish` was
 * accepted because every enumerated item had been classified as a `behaviour` row
 * the ledger can never enforce. These tests pin the deterministic replacement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkDeliverableShape,
  describeShapeGaps,
  requiredSectionsFromAsk,
} from '../../src/learning/deliverable-shape.js';
import { judgeCompletion } from '../../src/learning/completion-contract.js';

const ASK = [
  '# ASK — assess this repository',
  '',
  '## What to produce',
  '',
  'One report, `docs/ASSESSMENT_anuj.md`, plus any minimal code changes you can defend. It must cover:',
  '',
  '1. **Architecture.** How the app works end to end: entry point to synthesis.',
  '2. **Documentation drift.** Where the docs contradict the code.',
  '3. **Defects.** Real defects you can defend.',
  '4. **Test assessment.** What the suite covers well.',
  '5. **Evidence.** Every claim carries `path:line`.',
  '',
  'If something cannot be verified, say so explicitly under a "Limitations" heading.',
].join('\n');

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deliverable-shape-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const put = (path: string, content: string): void => {
  const abs = join(root, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
};

describe('requiredSectionsFromAsk', () => {
  it('reads wrapped items — the real ask breaks every section across two lines', () => {
    const wrapped = [
      'It must cover:',
      '',
      '1. **Architecture.** How the app works end to end: entry point to synthesis. Name the real modules',
      '   and functions in order.',
      '2. **Documentation drift.** Where the docs contradict the code. Each finding: the doc location',
      '   and quote.',
      '3. **Defects.** Real defects you can defend.',
      '4. **Test assessment.** What the suite covers well.',
      '5. **Evidence.** Every claim carries `path:line`.',
    ].join('\n');
    expect(requiredSectionsFromAsk(wrapped).sections).toHaveLength(5);
  });

  it('reads the labels of an enumerated report, not the sentences', () => {
    const { sections, limitations } = requiredSectionsFromAsk(ASK);
    expect(sections).toEqual([
      'architecture',
      'documentation drift',
      'defects',
      'test assessment',
      'evidence',
    ]);
    expect(limitations).toBe(true);
  });

  it('does not invent sections for prose or a two-item ask', () => {
    expect(requiredSectionsFromAsk('Write a short note about the build.').sections).toHaveLength(0);
    const two = 'Write docs/R.md. It must cover:\n1. Architecture.\n2. Defects.';
    expect(requiredSectionsFromAsk(two).sections).toHaveLength(2);
  });
});

describe('checkDeliverableShape', () => {
  it('names the sections, citations and heading a written report is missing', () => {
    put(
      'docs/ASSESSMENT_anuj.md',
      [
        '# Report',
        '## 1. Architecture',
        'Entry point is `main.py:158`.',
        '## 3. Defects',
        'A defect at `paths.py:116`.',
      ].join('\n'),
    );
    const shape = checkDeliverableShape({ ask: ASK, cwd: root, paths: ['docs/ASSESSMENT_anuj.md'] })!;
    expect(shape).toBeDefined();
    expect(shape.missingSections).toEqual(['documentation drift', 'test assessment', 'evidence']);
    expect(shape.citations).toBe(2);
    expect(shape.missingLimitations).toBe(true);
    expect(shape.uncitedFindings).toEqual([]);
    expect(describeShapeGaps(shape).join('\n')).toContain('documentation drift');
  });

  it('is silent on a report that has every enumerated part', () => {
    put(
      'docs/ASSESSMENT_anuj.md',
      [
        '# Report',
        '## 1. Architecture',
        '`main.py:158` calls the frame.',
        '## 2. Documentation drift',
        '`ARCHITECTURE.md:6` is wrong.',
        '## 3. Defects',
        '`paths.py:116` escapes the root.',
        '## 4. Test assessment',
        '`tests/test_paths.py:40` covers it.',
        '## 5. Evidence',
        'Every claim above cites a line.',
        '## Limitations',
        'The GUI was not driven.',
      ].join('\n'),
    );
    const shape = checkDeliverableShape({ ask: ASK, cwd: root, paths: ['docs/ASSESSMENT_anuj.md'] })!;
    expect(shape.missingSections).toEqual([]);
    expect(shape.missingLimitations).toBe(false);
    expect(describeShapeGaps(shape)).toEqual([]);
  });

  it('names a defect finding that carries no citation of its own', () => {
    put(
      'docs/ASSESSMENT_anuj.md',
      [
        '## 1. Architecture',
        '`main.py:158`.',
        '## 2. Documentation drift',
        '`README.md:4`.',
        '## 3. Defects',
        '### D1 — traversal',
        'The name escapes the folder (`paths.py:116`).',
        '### D2 — resume',
        'The resume path loses entries, which is clearly wrong.',
        '## 4. Test assessment',
        '`tests/test_paths.py:40`.',
        '## 5. Evidence',
        '`paths.py:116`.',
        '## Limitations',
        'GUI not driven.',
      ].join('\n'),
    );
    const shape = checkDeliverableShape({ ask: ASK, cwd: root, paths: ['docs/ASSESSMENT_anuj.md'] })!;
    expect(shape.uncitedFindings).toEqual(['D2 — resume']);
    expect(describeShapeGaps(shape).join('\n')).toContain('D2 — resume');
  });

  it('returns undefined when the file does not exist — the named-deliverable gate owns that', () => {
    expect(checkDeliverableShape({ ask: ASK, cwd: root, paths: ['docs/ASSESSMENT_anuj.md'] })).toBeUndefined();
  });
});

describe('judgeCompletion — the shape is part of the claim', () => {
  const shape = {
    path: 'docs/ASSESSMENT_anuj.md',
    requiredSections: ['architecture', 'documentation drift', 'defects', 'test assessment', 'evidence'],
    missingSections: ['documentation drift'],
    citations: 0,
    missingLimitations: true,
    uncitedFindings: [],
  };
  const base = { unmet: [], redChecks: [], wroteFiles: true, checksRan: 1 };

  it('refuses verified:true while an enumerated section is absent', () => {
    const verdict = judgeCompletion({ summary: 'done', verified: true }, { ...base, deliverableShape: shape });
    expect(verdict.accepted).toBe(false);
    expect(verdict.problems.join(' ')).toContain('documentation drift');
  });

  it('refuses verified:false that neither fixes nor names the gap', () => {
    const verdict = judgeCompletion(
      { summary: 'done', verified: false, unmet: ['could not run the GUI'] },
      { ...base, deliverableShape: shape },
    );
    expect(verdict.accepted).toBe(false);
  });

  it('accepts verified:false that states the missing sections', () => {
    const verdict = judgeCompletion(
      { summary: 'done', verified: false, unmet: ['sections "documentation drift" and citations are missing'] },
      { ...base, deliverableShape: shape },
    );
    expect(verdict.accepted).toBe(true);
  });
});
