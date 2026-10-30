/**
 * Bench scoring — the repeatable half of "is the agent still ahead?".
 *
 * The head-to-head that produced the current plan was scored by hand. That is
 * fine once and impossible to repeat every release, so the parts that CAN be
 * counted deterministically live in `scripts/bench/score.mjs` and are pinned here.
 * Two reports are compared: a strong one (findings, tags, citations, sections,
 * verified recall) and a shallow one (short, no findings) that must NOT pass the
 * gate on metrics alone.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// @ts-expect-error — plain Node script, no type declarations (it runs via the
// native loader in production, exactly as the bench does).
import {
  countCitations,
  countTags,
  findingLines,
  matchGroundTruth,
  parseUsage,
  releaseGate,
  scoreRun,
  sectionsDelivered,
} from '../../scripts/bench/score.mjs';

const STRONG = `
# Audit

## 1. Executive summary
The project has two critical defects. [F] verified.

## 2. Scope and method
Read 41 of 47 files. [F]

## 3. Critical findings
### CRITICAL — a project named '..' resolves to the user-data root and Remove Project rmtrees it
Paths are joined without validating dots; \`remove_project\` calls \`shutil.rmtree\` (src/paths.py:41). [F]

### CRITICAL — multi-voice Piper installs are unusable: _organize_voice receives a list
Each archive extracts into the same folder; the per-voice folder is never created (src/downloader.py:212). [F]

## 4. High findings
- **HIGH** — two wx.App instances on first launch (src/main.py:88). [F]
- **HIGH** — addon gate compares min_app_version against a hardcoded 0.1.0 (src/addons/__init__.py:70). [I]
- **HIGH** — set_accessible_name raises NotImplementedError off Windows; control.GetAccessible() is unguarded (src/gui/a11y.py:83). [F]

## 5. Medium and low
- **MEDIUM** — EPUB hrefs are not URL-decoded, so valid EPUBs read as empty (src/parsers.py:104). [F]
- **LOW** — done_count returns the start index (src/worker.py:63). [S]

## 6. Architecture
...

## 7. Security
- **HIGH** — np.load(..., allow_pickle=True) on reference audio (src/voicelab/worker.py:704). [F]

## 8. Performance
...

## 9. Recommendations
...

## 10. Appendix — what could not be verified
Windows-only paths and live TTS were not exercised.
`;

const GROUND_TRUTH = {
  defects: [
    { id: 'GT-01', keywords: ['rmtree'] },
    { id: 'GT-02', keywords: ['_organize_voice'] },
    { id: 'GT-03', keywords: ['wx.app'] },
    { id: 'GT-04', keywords: ['min_app_version'] },
    { id: 'GT-05', keywords: ['getaccessible'] },
    { id: 'GT-06', keywords: ['allow_pickle'] },
    { id: 'GT-07', keywords: ['mark_segment_done'] },
  ],
};

describe('findingLines', () => {
  it('reads id-prefixed, heading and bolded severities', () => {
    const found = findingLines(
      [
        'BUG-01 - HIGH - the archive is extracted twice',
        '### CRITICAL — rmtree on the data root',
        '- **MEDIUM** — a charset is ignored',
        'BUG 7 (Low): done_count is off by one',
      ].join('\n'),
    );
    expect(found.map((f) => f.severity)).toEqual(['HIGH', 'CRITICAL', 'MEDIUM', 'LOW']);
  });

  it('does not count prose that merely mentions a severity', () => {
    // This is the inflation guard: a report that says "this is not critical" must
    // not gain a finding.
    expect(findingLines('The situation is not critical, and no bug was found here.')).toEqual([]);
  });
});

describe('tags, citations, sections', () => {
  it('counts the evidence tags the task demands', () => {
    expect(countTags(STRONG)).toEqual({ facts: 8, inferences: 1, speculation: 1 });
  });

  it('counts file:line citations only', () => {
    // 8 citations in STRONG; a bare `src/parsers.py` with no line is not one.
    expect(countCitations(STRONG)).toBe(8);
    expect(countCitations('see src/parsers.py and nothing else')).toBe(0);
  });

  it('matches required sections by heading, and names what is missing', () => {
    const result = sectionsDelivered(STRONG, ['executive', 'critical', 'security', 'holistic']);
    expect(result.delivered).toBe(3);
    expect(result.missing).toEqual(['holistic']);
  });
});

describe('ground-truth recall', () => {
  it('credits only findings whose LINE carries a specific keyword', () => {
    const result = matchGroundTruth(STRONG, GROUND_TRUTH);
    expect(result.matched).toEqual(['GT-01', 'GT-02', 'GT-03', 'GT-04', 'GT-05', 'GT-06']);
    expect(result.missed).toEqual(['GT-07']);
    expect(result.recall).toBeCloseTo(6 / 7, 5);
  });

  it('does not credit a keyword that only appears in prose', () => {
    const report = '## Method\nWe looked for mark_segment_done races but found nothing to report.';
    expect(matchGroundTruth(report, { defects: [{ id: 'GT-07', keywords: ['mark_segment_done'] }] }).matched).toEqual([]);
  });
});

describe('parseUsage', () => {
  it('sums DeepSeek-shaped usage with its cache hits', () => {
    const log = [
      '{"usage":{"prompt_tokens":1000,"completion_tokens":10,"prompt_cache_hit_tokens":960}}',
      'not json',
      '{"usage":{"prompt_tokens":2000,"completion_tokens":20,"prompt_cache_hit_tokens":1900}}',
    ].join('\n');
    expect(parseUsage(log)).toMatchObject({
      calls: 2,
      inputTokens: 3000,
      cachedInputTokens: 2860,
      outputTokens: 30,
    });
    expect(parseUsage(log).cacheShare).toBeCloseTo(2860 / 3000, 5);
  });

  it('reads OpenAI’s nested cached_tokens and Cline’s top-level shape', () => {
    const log = [
      '{"usage":{"prompt_tokens":1000,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":900}}}',
      '{"prompt_tokens":500,"completion_tokens":5,"cache_read_input_tokens":100}',
    ].join('\n');
    const usage = parseUsage(log);
    expect(usage.calls).toBe(2);
    expect(usage.cachedInputTokens).toBe(1000);
  });

  it('reports zero rather than NaN for a log with no usage', () => {
    expect(parseUsage('hello')).toMatchObject({ calls: 0, inputTokens: 0, cacheShare: 0 });
  });
});

describe('scoreRun + releaseGate', () => {
  const usage = { calls: 52, inputTokens: 4_000_000, cachedInputTokens: 3_800_000, outputTokens: 70_000, cacheShare: 0.95 };
  const metrics = scoreRun({
    report: STRONG,
    groundTruth: GROUND_TRUTH,
    requiredSections: ['executive', 'critical', 'security'],
    usage,
    wallClockMs: 300_000,
  });

  it('aggregates a run into one comparable object', () => {
    expect(metrics.findings).toBe(8);
    expect(metrics.bySeverity.CRITICAL).toBe(2);
    expect(metrics.bySeverity.HIGH).toBe(4);
    expect(metrics.sections).toMatchObject({ delivered: 3, required: 3 });
    expect(metrics.callsPerFinding).toBeCloseTo(6.5, 5);
    expect(metrics.cacheShare).toBeCloseTo(0.95, 5);
    expect(metrics.recall).toBeCloseTo(6 / 7, 5);
  });

  it('passes a run that is cheap, cached and broad', () => {
    expect(releaseGate({ ...metrics, callsPerFinding: 2 }, { minRecall: 0.8 })).toEqual({
      ok: true,
      failures: [],
    });
  });

  it('fails a run whose prefix was rewritten (cache share below the floor)', () => {
    const gate = releaseGate({ ...metrics, cacheShare: 0.65 });
    expect(gate.ok).toBe(false);
    expect(gate.failures[0]).toContain('cache share 65.0%');
    expect(gate.failures[0]).toContain('prefix');
  });

  it('fails a run that spends round-trips instead of reading', () => {
    const gate = releaseGate({ ...metrics, callsPerFinding: 4.2 });
    expect(gate.ok).toBe(false);
    expect(gate.failures.some((f) => f.includes('model calls per finding'))).toBe(true);
  });

  it('fails a run that forgot verified defects', () => {
    const gate = releaseGate({ ...metrics, recall: 0.5 }, { minRecall: 0.8 });
    expect(gate.ok).toBe(false);
    expect(gate.failures.some((f) => f.includes('verified recall'))).toBe(true);
  });

  it('fails a run that never completed, whatever its other numbers say', () => {
    // Measured 2026-10-25: a 1500 s timeout produced an empty deliverable, no
    // calls and no findings, and the gate reported PASS because no threshold was
    // breached. A bench cannot call "nothing was measured" a pass.
    const empty = scoreRun({ report: '', groundTruth: GROUND_TRUTH, requiredSections: ['executive'] });
    const timedOut = releaseGate(empty, { runCompleted: false });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.failures[0]).toContain('did not complete');

    const finished = releaseGate(empty, { runCompleted: true });
    expect(finished.ok).toBe(false);
    expect(finished.failures[0]).toContain('no deliverable');
  });

  it('fails a turn that spent model calls and reported nothing', () => {
    const gate = releaseGate({ ...metrics, findings: 0, callsPerFinding: null });
    expect(gate.ok).toBe(false);
    expect(gate.failures.some((f) => f.includes('reported no findings'))).toBe(true);
  });

  it('a shallow report cannot pass on token metrics alone when a recall floor is set', () => {
    const shallow = scoreRun({
      report: '## Summary\nNothing much found. Perhaps some risk.\n',
      groundTruth: GROUND_TRUTH,
      requiredSections: ['executive'],
      usage,
    });
    expect(shallow.findings).toBe(0);
    expect(shallow.callsPerFinding).toBeNull();
    expect(releaseGate(shallow, { minRecall: 0.8 }).ok).toBe(false);
  });
});

describe('the checked-in ground truth', () => {
  const fixture = JSON.parse(
    readFileSync(join(process.cwd(), 'scripts/bench/fixtures/audit-ground-truth.json'), 'utf8'),
  );

  it('has unique ids, a severity and at least one specific keyword per defect', () => {
    const ids = fixture.defects.map((d: { id: string }) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const defect of fixture.defects) {
      expect(defect.severity).toMatch(/^(CRITICAL|HIGH|MEDIUM|LOW)$/);
      expect(defect.keywords.length).toBeGreaterThan(0);
      // A one-character or generic keyword would match every report.
      for (const keyword of defect.keywords) expect(keyword.length).toBeGreaterThan(2);
    }
  });

  it('carries the 2026-10-25 verified set and the task’s required sections', () => {
    expect(fixture.defects.length).toBeGreaterThanOrEqual(20);
    expect(fixture.requiredSections.length).toBeGreaterThanOrEqual(10);
  });
});
