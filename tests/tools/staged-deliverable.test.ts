/**
 * Staging discipline — the deliverable belongs where the ASK put it.
 *
 * Measured (2026-10-25 audit): `write_file({path: "REPORT.md"})` three times INSIDE
 * the audited tree, then a move to `../REPORT.md`. Only the last move kept the
 * tree clean; a failure between them would have left the deliverable in a
 * repository the task said not to modify. The tool still allows a draft (it is
 * recoverable), but the result names the final path and the cleanup in the same
 * step, so the correction costs nothing extra.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import { stagedDeliverableNote } from '../../src/tools/tool-loop.js';

const CWD = '/work/audited-repo';

describe('stagedDeliverableNote', () => {
  it('warns when an outside deliverable is written inside the workspace', () => {
    const note = stagedDeliverableNote('REPORT.md', CWD, ['../REPORT.md']);
    expect(note).toBeTruthy();
    expect(note).toContain('⚠️ STAGING');
    expect(note).toContain('INSIDE the workspace');
    // The exact final path and the cleanup, not "put it somewhere else".
    expect(note).toContain('../REPORT.md');
    expect(note).toContain('delete');
    expect(note).toContain('Do not leave a copy inside the tree');
  });

  it('matches a nested staging copy against a basename elsewhere outside', () => {
    const note = stagedDeliverableNote(join('docs', 'REPORT.md'), CWD, ['../REPORT.md']);
    expect(note).toContain('../REPORT.md');
  });

  it('stays silent once the write IS the named path', () => {
    expect(stagedDeliverableNote('../REPORT.md', CWD, ['../REPORT.md'])).toBeNull();
  });

  it('stays silent for a deliverable that belongs inside the workspace', () => {
    expect(stagedDeliverableNote('REPORT.md', CWD, ['REPORT.md'])).toBeNull();
    expect(stagedDeliverableNote('docs/REPORT.md', CWD, ['docs/REPORT.md'])).toBeNull();
  });

  it('stays silent when the basename differs (an ordinary source edit)', () => {
    expect(stagedDeliverableNote('src/parser.ts', CWD, ['../REPORT.md'])).toBeNull();
  });

  it('stays silent when the ask names nothing at all', () => {
    expect(stagedDeliverableNote('REPORT.md', CWD, [])).toBeNull();
  });

  it('does not treat a sibling-directory write as staging', () => {
    // `../other-repo/x.md` is outside this workspace; writing there is already
    // the final location, so no staging note applies.
    expect(stagedDeliverableNote('../other-repo/REPORT.md', CWD, ['../REPORT.md'])).toBeNull();
  });
});
