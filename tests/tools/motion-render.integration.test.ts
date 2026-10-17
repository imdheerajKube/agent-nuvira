/**
 * Motion, rendered for real — chromium, ffmpeg, and the file that comes out.
 *
 * The unit tests drive fakes, which proves the contract but not the pipeline: a
 * frame plan that is right and a screenshot that silently crops still produces a
 * broken video. This file renders actual files and asks FFMPEG what it got —
 * resolution, frame count, duration — because that is what a player will do with
 * it. It also proves the one property the whole feature rests on: the frames come
 * from the TIMELINE, so (a) a rAF-driven animation is stepped rather than
 * recorded, and (b) the same source renders the same bytes twice.
 *
 * Gated on the two tools it needs (`it.skipIf`), the same way the suite gates on
 * python/`dist` elsewhere: a machine without chromium or ffmpeg cannot render,
 * and a skipped test that SAYS why is honest, where a failing one would be noise.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ffmpegWithSubtitles, renderMotion } from '../../src/tools/modality/motion.js';
import { isBrowserAvailable } from '../../src/tools/modality/browser.js';
import { binaryOnPath, resetProbeCache } from '../../src/tools/modality/shared.js';
import { presetHtml } from '../../src/tools/modality/motion-presets.js';

const hasFfmpeg = binaryOnPath('ffmpeg');
const hasFfprobe = binaryOnPath('ffprobe');
const ready = isBrowserAvailable() && hasFfmpeg && hasFfprobe;
const why = !isBrowserAvailable()
  ? 'chromium (playwright) is not installed'
  : !hasFfmpeg || !hasFfprobe
    ? 'ffmpeg/ffprobe is not installed'
    : '';

/**
 * Does THIS ffmpeg burn subtitles? The `subtitles`/`ass` filters come from
 * libass, which plenty of real installs (a lean Homebrew bottle among them) do
 * not carry — measured 2026-10-15: `ffmpeg` 9.0.2 linked no libass, so `-vf
 * subtitles=…` died with "No such filter". The narration + burn test below is
 * gated on this rather than failing on a machine that cannot do it.
 */
// Asked of the PRODUCT, not of PATH: `ffmpegWithSubtitles()` is what the burn itself
// uses, so this gate runs wherever a caption burn would actually succeed (a machine
// with only the `ffmpeg-full` keg, for instance, which PATH ffmpeg would miss).
const hasSubtitlesFilter = ffmpegWithSubtitles() !== null;

/** A local speech engine (`speak` uses edge-tts or Piper) — both free, both optional. */
const hasTts = binaryOnPath('edge-tts') || binaryOnPath('piper');

let workDir = '';
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'nuvira-motion-int-'));
  for (const key of ['NUVIRA_ARTIFACTS_DIR', 'NUVIRA_MOTION_HOME']) {
    savedEnv[key] = process.env[key];
    process.env[key] = join(workDir, key === 'NUVIRA_ARTIFACTS_DIR' ? 'artifacts' : 'motion');
  }
  resetProbeCache();
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(workDir, { recursive: true, force: true });
});

/** What ffprobe says the file is. */
function probe(file: string): { width: number; height: number; frames: number; duration: number; fps: number } {
  const raw = execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_frames,r_frame_rate,duration', '-of', 'json', file],
    { encoding: 'utf-8' },
  );
  const stream = (JSON.parse(raw) as { streams: Array<Record<string, string>> }).streams[0];
  const [num, den] = String(stream.r_frame_rate).split('/').map(Number);
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    frames: Number(stream.nb_frames),
    duration: Number(stream.duration),
    fps: den ? num / den : num,
  };
}

/** The decoded pixels of a video, so container metadata cannot hide a difference. */
function pixelsHash(file: string): string {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * The MEAN pixel value of one band of one frame. A caption burn cannot be seen in
 * container metadata, so the claim "the captions are in the pixels" is checked by
 * comparing this between two renders of the SAME source: the band the captions
 * occupy must move, and a band they never touch must not.
 */
function bandMean(file: string, index: number, crop: string): number {
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${index}),crop=${crop},format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (raw.length === 0) throw new Error(`no frame ${index} decoded from ${file}`);
  let sum = 0;
  for (const byte of raw) sum += byte;
  return sum / raw.length;
}

/** Does the file carry an audio track, and is it a real codec? */
function audioCodec(file: string): string | null {
  const raw = execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'json', file],
    { encoding: 'utf-8' },
  );
  const streams = (JSON.parse(raw) as { streams: Array<{ codec_name?: string }> }).streams;
  return streams[0]?.codec_name ?? null;
}

/** One decoded frame at `index`, for "did the picture actually change?" checks. */
function frameHash(file: string, index: number): string {
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${index})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (raw.length === 0) throw new Error(`no frame ${index} decoded from ${file}`);
  return createHash('sha256').update(raw).digest('hex');
}

describe.skipIf(!ready)('a real render', () => {
  it('writes an mp4 whose resolution, fps, length and frame count are what was asked for', async () => {
    const html = presetHtml(
      'title-card',
      { title: 'Quarterly revenue', subtitle: 'FY2026', kicker: 'Numbers' },
      { durationMs: 1_000, width: 320, height: 180 },
    );
    const result = await renderMotion({ html, fps: 12, duration_ms: 1_000, width: 320, height: 180 });
    expect(result.ok, !result.ok ? result.error : '').toBe(true);
    if (!result.ok) return;

    expect(existsSync(result.file)).toBe(true);
    expect(statSync(result.file).size).toBeGreaterThan(1_000);
    expect(result.seek).toBe('hook');

    const info = probe(result.file);
    expect(info.width).toBe(320);
    expect(info.height).toBe(180);
    expect(info.fps).toBeCloseTo(12, 3);
    expect(info.frames).toBe(12);
    expect(info.duration).toBeCloseTo(1, 1);
  }, 120_000);

  it('steps a requestAnimationFrame loop instead of recording it in real time', async () => {
    // The animation knows only rAF (no seek hook): the injected runner must drive
    // it. If it were merely "played", a 1s render at 12fps would capture ~12
    // frames of a nearly-identical bar and the first/last frames would match —
    // and the whole feature would be a screen recorder with extra steps.
    const html = `<html><body style="margin:0;background:#000">
      <div id="bar" style="height:40px;width:0px;background:#4f9cf9"></div>
      <script>
        function loop(t) { document.getElementById('bar').style.width = Math.min(300, (t / 1000) * 300) + 'px'; requestAnimationFrame(loop); }
        requestAnimationFrame(loop);
      </script></body></html>`;
    const result = await renderMotion({ html, fps: 12, duration_ms: 1_000, width: 320, height: 180 });
    expect(result.ok, !result.ok ? result.error : '').toBe(true);
    if (!result.ok) return;
    // A page with only rAF is seekable THROUGH the injected runner, and says so.
    expect(result.seek).toBe('raf');
    expect(frameHash(result.file, 11)).not.toBe(frameHash(result.file, 0));
  }, 120_000);

  it('renders the same source to the same bytes twice — a re-edit can be trusted', async () => {
    const html = presetHtml(
      'bar-race',
      { title: 'Revenue', data: [{ label: 'Alpha', value: 12 }, { label: 'Beta', value: 30 }, { label: 'Gamma', value: 21 }] },
      { durationMs: 800, width: 320, height: 180 },
    );
    const first = await renderMotion({ html, fps: 10, duration_ms: 800, width: 320, height: 180, out_name: 'det-a' });
    const second = await renderMotion({ html, fps: 10, duration_ms: 800, width: 320, height: 180, out_name: 'det-b' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(pixelsHash(second.file)).toBe(pixelsHash(first.file));
  }, 180_000);

  it('honours an aspect ratio as a shape', async () => {
    const html = presetHtml('title-card', { title: 'Vertical' }, { durationMs: 400, width: 180, height: 320 });
    const result = await renderMotion({ html, fps: 10, duration_ms: 400, aspect_ratio: '9:16', height: 320 });
    expect(result.ok, !result.ok ? result.error : '').toBe(true);
    if (!result.ok) return;
    const info = probe(result.file);
    expect(info.width).toBe(180);
    expect(info.height).toBe(320);
  }, 120_000);

  it.skipIf(!hasTts || !hasSubtitlesFilter || !ready)(
    'narrates AND burns captions: the audio survives and the words are in the pixels',
    async () => {
      // Two failures live in this combination, and neither shows up in a result
      // line: burning captions re-encodes from the frames, so a mux that ran
      // FIRST was silently discarded (a silent video that reported no warning),
      // and an ffmpeg without libass fails the burn while the file still looks
      // fine. So this asserts the artifact itself — an audio stream, the `.srt`,
      // and the pixels — against a CONTROL render of the same source.
      const html = presetHtml(
        'title-card',
        { title: 'Narrated', subtitle: 'and captioned' },
        { durationMs: 1_000, width: 640, height: 360 },
      );
      const caption = 'narrated and captioned';
      const burned = await renderMotion({
        html,
        fps: 12,
        duration_ms: 1_000,
        width: 640,
        height: 360,
        narration: 'This clip is narrated and captioned.',
        captions: [{ from_ms: 0, to_ms: 1_000, text: caption }],
        burn_captions: true,
        out_name: 'narrated-burned',
      });
      const control = await renderMotion({ html, fps: 12, duration_ms: 1_000, width: 640, height: 360, out_name: 'narrated-control' });
      expect(burned.ok, !burned.ok ? burned.error : '').toBe(true);
      expect(control.ok, !control.ok ? control.error : '').toBe(true);
      if (!burned.ok || !control.ok) return;

      // No warning at all: narration was not skipped and captions WERE burned in.
      expect(burned.warnings).toEqual([]);

      // The narration is really on the artifact (this is what the ordering bug ate).
      expect(audioCodec(burned.file)).toBe('aac');
      const srt = burned.srt;
      expect(srt).toBeTruthy();
      expect(readFileSync(srt!, 'utf-8')).toContain(caption);

      // The burn is in the PIXELS: the caption band differs from the control,
      // while the band the captions never reach is the same picture.
      const frameIndex = 6;
      const captionBand = 'iw:ih*0.18:0:ih*0.82';
      const untouchedBand = 'iw:ih*0.30:0:0';
      const withCaptions = bandMean(burned.file, frameIndex, captionBand);
      const without = bandMean(control.file, frameIndex, captionBand);
      expect(Math.abs(withCaptions - without)).toBeGreaterThan(1);
      expect(Math.abs(bandMean(burned.file, frameIndex, untouchedBand) - bandMean(control.file, frameIndex, untouchedBand))).toBeLessThan(0.25);
    },
    180_000,
  );
});

describe.skipIf(ready)('a machine without the toolchain', () => {
  it(`motion rendering is skipped and says why: ${why}`, () => {
    // Not a silent skip: the reason is in the test name, so a green run on a
    // machine that cannot render does not read as "rendering was verified here".
    expect(ready).toBe(false);
  });
});
