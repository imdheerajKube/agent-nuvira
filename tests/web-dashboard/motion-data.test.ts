/**
 * The Motion page's read model.
 *
 * Two properties matter more than the row shape:
 *
 *   1. an unreadable or absent render history is an EMPTY LIST, never a 500 —
 *      the page's empty state is the useful answer, and a broken page helps
 *      nobody;
 *   2. a file is served by RENDER ID resolved through our own manifest, so a
 *      caller cannot turn `/api/motion-file` into an arbitrary-file read.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { motionRenders, motionRenderFile } from '../../src/web-dashboard/motion-data.js';
import { saveMotionManifest, type MotionManifest } from '../../src/tools/modality/motion.js';

let workDir = '';
const savedEnv: Record<string, string | undefined> = {};

function manifest(over: Partial<MotionManifest> = {}): MotionManifest {
  const id = over.id ?? 'motion-20261017-abc123';
  return {
    id,
    createdAt: Date.UTC(2026, 9, 17, 9, 30),
    source: '<html></html>',
    preset: 'title-card',
    params: { title: 'Quarterly numbers' },
    fps: 30,
    durationMs: 2500,
    width: 640,
    height: 360,
    format: 'mp4',
    artifact: join(workDir, 'artifacts', `${id}.mp4`),
    srt: null,
    narration: null,
    captions: null,
    revisions: 0,
    ...over,
  };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'nuvira-motion-data-'));
  mkdirSync(join(workDir, 'artifacts'), { recursive: true });
  for (const key of ['NUVIRA_MOTION_HOME', 'NUVIRA_ARTIFACTS_DIR']) {
    savedEnv[key] = process.env[key];
    process.env[key] = join(workDir, key === 'NUVIRA_MOTION_HOME' ? 'motion' : 'artifacts');
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe('motionRenders — what exists is listed, and nothing more is claimed', () => {
  it('is an empty list (not an error) before anything is rendered', () => {
    expect(motionRenders(workDir)).toMatchObject({ ok: true, renders: [] });
  });

  it('reports the facts a reviewer needs, newest first', () => {
    const older = manifest({
      id: 'motion-20261016-old001',
      preset: 'bar-race',
      params: null,
      createdAt: Date.UTC(2026, 9, 16, 9, 0),
    });
    const newer = manifest({ id: 'motion-20261017-abc123', revisions: 2, srt: '/tmp/x.srt' });
    writeFileSync(older.artifact, 'aaaa');
    writeFileSync(newer.artifact, 'bbbbbbbb');
    saveMotionManifest(older, workDir);
    saveMotionManifest(newer, workDir);

    const data = motionRenders(workDir);
    expect(data.renders.map((r) => r.id)).toEqual(['motion-20261017-abc123', 'motion-20261016-old001']);
    expect(data.renders[0]).toMatchObject({
      title: 'Quarterly numbers',
      source: 'preset',
      preset: 'title-card',
      bytes: 8,
      revisions: 2,
      captions: true,
      file: 'motion-20261017-abc123.mp4',
    });
    // No title given: the scene name is the truth, not an invented caption.
    expect(data.renders[1]!.title).toBeNull();
    expect(data.renders[1]!.preset).toBe('bar-race');
  });

  it('marks an authored animation as such rather than as a preset', () => {
    const html = manifest({ id: 'motion-20261017-html01', preset: null, params: null });
    writeFileSync(html.artifact, 'x');
    saveMotionManifest(html, workDir);
    expect(motionRenders(workDir).renders[0]!.source).toBe('html');
  });
});

describe('motionRenderFile — an id is resolved, a path is never accepted', () => {
  it('returns the artifact and its mime for a known render', () => {
    const entry = manifest();
    writeFileSync(entry.artifact, 'video-bytes');
    saveMotionManifest(entry, workDir);

    expect(motionRenderFile(entry.id, workDir)).toEqual({
      path: entry.artifact,
      mime: 'video/mp4',
    });
  });

  it('refuses an unknown id, an empty id and an absolute path — all null, so the caller 404s', () => {
    const entry = manifest();
    writeFileSync(entry.artifact, 'video-bytes');
    saveMotionManifest(entry, workDir);

    expect(motionRenderFile('motion-20990101-nope00', workDir)).toBeNull();
    expect(motionRenderFile('', workDir)).toBeNull();
    // A path is not an id: the lookup is by manifest, never by string.
    expect(motionRenderFile(entry.artifact, workDir)).toBeNull();
  });

  it('refuses a manifest whose artifact has been deleted', () => {
    const entry = manifest();
    saveMotionManifest(entry, workDir); // manifest written, no video file
    expect(motionRenderFile(entry.id, workDir)).toBeNull();
  });
});
