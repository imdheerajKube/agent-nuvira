/**
 * Motion — the renderer, the seek contract, and the render history.
 *
 * The property that matters here is DETERMINISM: the frames come from the
 * animation's own timeline (`seek(t)`), not from watching it play, so the same
 * source renders the same file twice — and a re-edit re-renders the stored
 * source instead of re-inventing it. Every test below pins one piece of that:
 * the frame plan, the timeline positions, the argv that turns frames into a
 * video, and the refusal paths (a missing toolchain, a preset with no data, a
 * render that failed) that must not leave a file that looks like a render.
 *
 * The pipeline is driven through its seams (`setMotionLauncherForTests`,
 * `setFfmpegRunnerForTests`, `setMotionAvailabilityForTests`, `setSpeakForTests`)
 * so the contract is tested on every platform without needing chromium or
 * ffmpeg; the real binaries are exercised in `motion-render.integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MOTION_INIT_SCRIPT,
  MOTION_READY_SCRIPT,
  MOTION_SEEK_SCRIPT,
  injectRunner,
  seekScript,
  buildFfmpegArgs,
  buildFramePlan,
  buildMuxArgs,
  buildSrt,
  formatSrtTime,
  frameTimestampMs,
  listMotionManifests,
  motionAvailability,
  renderMotion,
  resolveFrameSize,
  setFfmpegRunnerForTests,
  setMotionAvailabilityForTests,
  setMotionLauncherForTests,
  setSpeakForTests,
  type MotionPageLike,
} from '../../src/tools/modality/motion.js';
import { runMotionTool } from '../../src/tools/modality/motion-tool.js';

let workDir = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'nuvira-motion-test-'));
  // Both the render output and the render history live outside the repo: a test
  // that wrote into the project tree would be caught by the tree guard, and
  // rightly.
  for (const key of ['NUVIRA_ARTIFACTS_DIR', 'NUVIRA_MOTION_HOME']) {
    savedEnv[key] = process.env[key];
    process.env[key] = join(workDir, key === 'NUVIRA_ARTIFACTS_DIR' ? 'artifacts' : 'motion');
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setMotionLauncherForTests(null);
  setFfmpegRunnerForTests(null);
  setMotionAvailabilityForTests(null);
  setSpeakForTests(null);
  rmSync(workDir, { recursive: true, force: true });
});

// ─── Fakes ─────────────────────────────────────────────────────────────────

interface PageRecord {
  seeks: number[];
  scripts: string[];
  screenshots: Array<{ path: string; clip?: { width: number; height: number } }>;
  content: string[];
}

function fakePage(record: PageRecord, seekAnswer: () => string = () => 'hook'): MotionPageLike {
  return {
    async setContent(html: string) {
      record.content.push(html);
    },
    async evaluate(script: string | ((arg: unknown) => unknown)) {
      // The seek arrives as an expression with the timestamp inlined (see
      // `seekScript`): a real `page.evaluate` must not be handed a function to
      // call, so the fake must not expect one either.
      const text = typeof script === 'string' ? script : '';
      const match = /const t = (\d+);/.exec(text);
      if (match && text.includes('__motionRunner.step')) {
        record.seeks.push(Number(match[1]));
        return seekAnswer();
      }
      return true;
    },
    async screenshot(opts: { path: string; clip?: { width: number; height: number } }) {
      record.screenshots.push(opts);
      writeFileSync(opts.path, Buffer.from('png'));
      return Buffer.from('png');
    },
    async close() {},
  };
}

function installFakes(
  opts: { seekAnswer?: () => string; ffmpegCode?: number; onFfmpeg?: (args: string[]) => void } = {},
): { record: PageRecord; viewports: Array<{ width: number; height: number }>; ffmpegArgs: string[][] } {
  const record: PageRecord = { seeks: [], scripts: [], screenshots: [], content: [] };
  const viewports: Array<{ width: number; height: number }> = [];
  const ffmpegArgs: string[][] = [];
  setMotionAvailabilityForTests({ ok: true, missing: [], hint: '' });
  setMotionLauncherForTests(async (viewport) => {
    viewports.push(viewport);
    return {
      async newPage() {
        return fakePage(record, opts.seekAnswer ?? (() => 'hook'));
      },
      async close() {},
    };
  });
  setFfmpegRunnerForTests(async (args) => {
    ffmpegArgs.push(args);
    if (opts.ffmpegCode && opts.ffmpegCode !== 0) return { code: opts.ffmpegCode, stderr: 'boom' };
    const out = args[args.length - 1];
    writeFileSync(out, Buffer.from('fake-video'));
    opts.onFfmpeg?.(args);
    return { code: 0, stderr: '' };
  });
  return { record, viewports, ffmpegArgs };
}

const source = '<html><body><script>window.__motion={seek(t){}}</script></body></html>';

// ─── Frame plan ────────────────────────────────────────────────────────────

describe('the frame plan is the timeline, not the wall clock', () => {
  it('a 30fps 8s render is 240 frames covering exactly 8s', () => {
    const plan = buildFramePlan({ fps: 30, duration_ms: 8_000 });
    expect(plan.frames).toBe(240);
    expect(plan.durationMs).toBe(8_000);
  });

  it('asks for the frames the fps and length imply', () => {
    expect(buildFramePlan({ fps: 12, duration_ms: 1_000 }).frames).toBe(12);
    expect(buildFramePlan({ fps: 24, duration_ms: 2_500 }).frames).toBe(60);
  });

  it('clamps junk and clamps the extremes', () => {
    expect(buildFramePlan({ fps: 999, duration_ms: 1_000 }).fps).toBe(60);
    expect(buildFramePlan({ fps: 0, duration_ms: 1_000 }).fps).toBe(1);
    expect(buildFramePlan({ fps: 'nonsense', duration_ms: 'nonsense' }).fps).toBe(30);
    // A sub-200ms request is not a render, it is a mistake.
    expect(buildFramePlan({ fps: 30, duration_ms: 20 }).durationMs).toBe(200);
  });

  it('caps the frame count and TRIMS THE DURATION rather than the guard', () => {
    // 60fps for 10 minutes would be 36,000 frames — the cap is a disk guard, so
    // the length gives way (and the reported duration is the truth of what was
    // rendered, not what was asked for).
    const plan = buildFramePlan({ fps: 60, duration_ms: 600_000 });
    expect(plan.frames).toBe(6_000);
    expect(plan.durationMs).toBe(100_000);
  });

  it('places frame N at N/fps on the timeline', () => {
    expect(frameTimestampMs(0, 30)).toBe(0);
    expect(frameTimestampMs(1, 30)).toBe(33);
    expect(frameTimestampMs(29, 30)).toBe(967);
    expect(frameTimestampMs(6, 12)).toBe(500);
  });
});

describe('the frame size', () => {
  it('defaults to landscape 720p', () => {
    expect(resolveFrameSize({})).toEqual({ width: 1280, height: 720 });
  });

  it('takes the shape from the ratio and the scale from the pinned side', () => {
    expect(resolveFrameSize({ aspect_ratio: '9:16', height: 1920 })).toEqual({ width: 1080, height: 1920 });
    expect(resolveFrameSize({ aspect_ratio: '16:9', width: 1920 })).toEqual({ width: 1920, height: 1080 });
    expect(resolveFrameSize({ aspect_ratio: '1:1', width: 800 })).toEqual({ width: 800, height: 800 });
    expect(resolveFrameSize({ aspect_ratio: '4/3', width: 800 })).toEqual({ width: 800, height: 600 });
  });

  it('never emits an odd dimension — H.264 cannot encode one', () => {
    const { width, height } = resolveFrameSize({ width: 1001, height: 401 });
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
  });

  it('ignores a ratio it cannot read and keeps the explicit size', () => {
    expect(resolveFrameSize({ aspect_ratio: 'wide-ish', width: 640, height: 480 })).toEqual({ width: 640, height: 480 });
  });
});

// ─── The seek contract ─────────────────────────────────────────────────────

describe('the seek contract (the one property that makes rendering reproducible)', () => {
  it('the init script makes a rAF loop steppable instead of wall-clock', () => {
    expect(MOTION_INIT_SCRIPT).toContain('window.requestAnimationFrame');
    expect(MOTION_INIT_SCRIPT).toContain('__motionRunner');
    expect(MOTION_INIT_SCRIPT).toContain('step(');
  });

  it('the per-frame script prefers the page hook, steps rAF, then syncs Web Animations', () => {
    expect(MOTION_SEEK_SCRIPT).toContain('window.__motion');
    expect(MOTION_SEEK_SCRIPT).toContain('hook.seek');
    expect(MOTION_SEEK_SCRIPT).toContain('__motionRunner.step');
    expect(MOTION_SEEK_SCRIPT).toContain('getAnimations');
    expect(MOTION_SEEK_SCRIPT).toContain('currentTime = t');
  });

  it('seeks with an expression whose timestamp is INLINED, not a function to call', () => {
    // Measured against a real chromium: a `(t) => …` string comes back as a
    // function value and the page never moves, so the render claimed `seek:none`
    // on a page that had a working hook.
    const expr = seekScript(1_250);
    expect(expr.startsWith('(() =>')).toBe(true);
    expect(expr.endsWith(')()')).toBe(true);
    expect(expr).toContain('const t = 1250;');
    expect(expr).toContain('__motionRunner.step');
    expect(MOTION_READY_SCRIPT.startsWith('(() =>')).toBe(true);
  });

  it('waits for fonts before the first frame', () => {
    expect(MOTION_READY_SCRIPT).toContain('document.fonts');
  });

  it('injects the runner into the document, ahead of everything else', () => {
    // addInitScript does not run for `page.setContent` (it fires per new
    // document), so the runner has to be part of the markup — measured against a
    // real chromium, where the runner was simply absent.
    expect(injectRunner('<html><head><title>x</title></head><body><script>a()</script></body></html>')).toMatch(
      /<head>\s*<script>[\s\S]*__motionRunner[\s\S]*<\/script>[\s\S]*<script>a\(\)<\/script>/,
    );
    // A fragment with no html/head/body still gets it, still first.
    const fragment = injectRunner('<div>hi</div>');
    expect(fragment.indexOf('__motionRunner')).toBeLessThan(fragment.indexOf('<div>hi</div>'));
  });
});

// ─── Encoding ──────────────────────────────────────────────────────────────

describe('the ffmpeg argv', () => {
  const base = { fps: 30, pattern: '/tmp/f/frame-%05d.png', out: '/tmp/out.mp4', format: 'mp4' as const };

  it('encodes an mp4 that every player will play', () => {
    const args = buildFfmpegArgs(base);
    expect(args).toContain('-framerate');
    expect(args[args.indexOf('-framerate') + 1]).toBe('30');
    expect(args).toContain('-start_number');
    expect(args[args.indexOf('-start_number') + 1]).toBe('1');
    expect(args).toContain('libx264');
    expect(args).toContain('yuv420p');
    expect(args).toContain('+faststart');
    expect(args[args.length - 1]).toBe('/tmp/out.mp4');
  });

  it('honours the quality knob and clamps it', () => {
    expect(buildFfmpegArgs({ ...base, crf: 28 }).join(' ')).toContain('-crf 28');
    expect(buildFfmpegArgs({ ...base, crf: 999 }).join(' ')).toContain('-crf 51');
    expect(buildFfmpegArgs(base).join(' ')).toContain('-crf 20');
  });

  it('a gif gets a palette, and never an audio input it cannot hold', () => {
    const args = buildFfmpegArgs({ ...base, format: 'gif', out: '/tmp/out.gif', audioPath: '/tmp/voice.mp3' });
    expect(args.join(' ')).toContain('palettegen');
    expect(args.join(' ')).toContain('paletteuse');
    expect(args).not.toContain('/tmp/voice.mp3');
    expect(args).not.toContain('-c:a');
  });

  it('webm uses VP9', () => {
    expect(buildFfmpegArgs({ ...base, format: 'webm' }).join(' ')).toContain('libvpx-vp9');
  });

  it('muxes narration as a stream copy', () => {
    const args = buildFfmpegArgs({ ...base, audioPath: '/tmp/voice.mp3' });
    expect(args).toContain('/tmp/voice.mp3');
    expect(args.join(' ')).toContain('-c:a aac');
    expect(args).toContain('-shortest');
  });

  it('burns captions only when there is an srt to burn', () => {
    expect(buildFfmpegArgs({ ...base, burnCaptions: true, srtPath: '/tmp/a.srt' }).join(' ')).toContain('subtitles=/tmp/a.srt');
    expect(buildFfmpegArgs({ ...base, burnCaptions: true }).join(' ')).not.toContain('subtitles=');
  });

  it('the narration mux takes the video as-is', () => {
    const args = buildMuxArgs({ videoPath: '/tmp/v.mp4', audioPath: '/tmp/a.mp3', out: '/tmp/o.mp4' });
    expect(args.join(' ')).toContain('-c:v copy');
    expect(args[args.length - 1]).toBe('/tmp/o.mp4');
  });
});

describe('captions', () => {
  it('writes SRT timestamps', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000');
    expect(formatSrtTime(1_234)).toBe('00:00:01,234');
    expect(formatSrtTime(3_723_456)).toBe('01:02:03,456');
    expect(formatSrtTime(-5)).toBe('00:00:00,000');
  });

  it('numbers the cues and repairs an inverted or overlapping one', () => {
    const srt = buildSrt([
      { from_ms: 0, to_ms: 1_000, text: 'one' },
      { from_ms: 500, to_ms: 400, text: 'two' },
    ]);
    const lines = srt.split('\n');
    expect(lines[0]).toBe('1');
    expect(lines[1]).toBe('00:00:00,000 --> 00:00:01,000');
    // Cue 2 cannot start before cue 1 ended, and cannot end before it starts.
    expect(lines[4]).toBe('2');
    expect(lines[5]).toBe('00:00:01,000 --> 00:00:01,001');
  });
});

// ─── Availability ──────────────────────────────────────────────────────────

describe('availability names what is missing and how to install it', () => {
  it('reports the tools by name with the command that installs them', () => {
    setMotionAvailabilityForTests(null);
    const real = motionAvailability();
    // Whatever this machine has, the shape is the contract: a missing tool is
    // named, and the hint is an installation command.
    if (!real.ok) expect(real.hint.length).toBeGreaterThan(0);
    expect(Array.isArray(real.missing)).toBe(true);
  });

  it('a render without the toolchain fails with the install command, and writes nothing', async () => {
    setMotionAvailabilityForTests({ ok: false, missing: ['chromium (playwright)'], hint: 'npx playwright install chromium' });
    const result = await renderMotion({ html: source });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('playwright');
      expect(result.hint).toContain('npx playwright install chromium');
    }
    expect(existsSync(join(process.env.NUVIRA_ARTIFACTS_DIR!, 'motion'))).toBe(false);
  });

  it('an empty source is refused before anything is launched', async () => {
    const { viewports } = installFakes();
    const result = await renderMotion({ html: '   ' });
    expect(result.ok).toBe(false);
    expect(viewports).toHaveLength(0);
  });
});

// ─── The pipeline ──────────────────────────────────────────────────────────

describe('the render pipeline', () => {
  it('captures one frame per timeline step, at the requested size', async () => {
    const { record, viewports, ffmpegArgs } = installFakes();
    const result = await renderMotion({ html: source, fps: 12, duration_ms: 1_000, width: 320, height: 180 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frames).toBe(12);
    expect(result.fps).toBe(12);
    expect(result.durationMs).toBe(1_000);
    expect(record.seeks).toEqual([0, 83, 167, 250, 333, 417, 500, 583, 667, 750, 833, 917]);
    expect(record.screenshots).toHaveLength(12);
    expect(record.screenshots[0].clip).toEqual({ x: 0, y: 0, width: 320, height: 180 });
    expect(viewports[0]).toEqual({ width: 320, height: 180 });
    // The runner is injected FIRST in script order — ahead of the animation's own
    // script, which is the only thing that makes a rAF loop steppable.
    const served = record.content[0];
    expect(served).toContain('__motionRunner');
    expect(served.indexOf('__motionRunner')).toBeLessThan(served.indexOf('window.__motion={seek(t){}}'));
    // The artifact lands in the motion sandbox with the bytes ffmpeg wrote.
    expect(result.file.endsWith('.mp4')).toBe(true);
    expect(readFileSync(result.file, 'utf-8')).toBe('fake-video');
    expect(ffmpegArgs[0].join(' ')).toContain('frame-%05d.png');
    expect(result.seek).toBe('hook');
    expect(result.warnings).toEqual([]);
  });

  it('says so when the page was not seekable, instead of implying a render', async () => {
    installFakes({ seekAnswer: () => 'none' });
    const result = await renderMotion({ html: '<html><body>static</body></html>', duration_ms: 300 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seek).toBe('none');
    expect(result.warnings.join(' ')).toContain('not seekable');
  });

  it('a stepped rAF loop counts as seekable — only a page that answered nothing is warned about', async () => {
    installFakes({ seekAnswer: () => 'raf' });
    const result = await renderMotion({ html: '<html><body><div id="b"></div></body></html>', duration_ms: 300 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seek).toBe('raf');
    expect(result.warnings).toEqual([]);
  });

  it('an ffmpeg failure is an error, and leaves no file that looks like a render', async () => {
    installFakes({ ffmpegCode: 1 });
    const result = await renderMotion({ html: source, duration_ms: 300 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('ffmpeg');
    expect(existsSync(join(process.env.NUVIRA_ARTIFACTS_DIR!, 'motion', 'motion'))).toBe(false);
  });

  it('a crash mid-render does not leave a partial artifact', async () => {
    setMotionAvailabilityForTests({ ok: true, missing: [], hint: '' });
    setMotionLauncherForTests(async () => ({
      async newPage() {
        return {
          async setContent() {
            throw new Error('page blew up');
          },
          async evaluate() {
            return true;
          },
          async screenshot() {
            return null;
          },
          async close() {},
        };
      },
      async close() {},
    }));
    const result = await renderMotion({ html: source, duration_ms: 300 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('page blew up');
  });

  it('narration is muxed when the engine answers, and stated when it does not', async () => {
    const { ffmpegArgs } = installFakes();
    setSpeakForTests(async (text) => ({ ok: true, file: join(workDir, `voice-${text.length}.mp3`) }));
    writeFileSync(join(workDir, 'voice-11.mp3'), Buffer.from('audio'));
    const withVoice = await renderMotion({ html: source, duration_ms: 300, narration: 'hello world' });
    expect(withVoice.ok).toBe(true);
    if (withVoice.ok) expect(withVoice.warnings).toEqual([]);
    // A second ffmpeg pass, and it is a mux (video copied).
    expect(ffmpegArgs.some((args) => args.join(' ').includes('-c:v copy'))).toBe(true);

    setSpeakForTests(async () => ({ ok: false, error: 'no TTS backend' }));
    const spoken = await renderMotion({ html: source, duration_ms: 300, narration: 'hello' });
    expect(spoken.ok).toBe(true);
    if (spoken.ok) expect(spoken.warnings.join(' ')).toContain('narration was skipped: no TTS backend');
  });

  it('a narrate + burn render keeps the audio: the mux comes AFTER the burn', async () => {
    // Burning captions re-encodes the video from the PNG frames, so an audio
    // track muxed before it is discarded with the previous encode — the render
    // came back SILENT and reported no warning. The order is the fix, and this
    // is the assertion that holds it: the burn is an earlier ffmpeg pass than
    // the mux, and the mux reads the FINAL artifact file.
    const { ffmpegArgs } = installFakes();
    setSpeakForTests(async () => ({ ok: true, file: join(workDir, 'voice.mp3') }));
    writeFileSync(join(workDir, 'voice.mp3'), Buffer.from('audio'));
    const result = await renderMotion({
      html: source,
      duration_ms: 1_000,
      narration: 'hello',
      captions: [{ from_ms: 0, to_ms: 500, text: 'first' }],
      burn_captions: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);

    // Pass 1 encodes the frames, pass 2 burns the captions over them, and pass 3
    // muxes the narration onto THAT file. Nothing may sit between them.
    const burnIndex = ffmpegArgs.findIndex((args) => args.join(' ').includes('subtitles='));
    const muxIndex = ffmpegArgs.findIndex((args) => args.join(' ').includes('-c:v copy'));
    expect(burnIndex).toBeGreaterThan(0);
    expect(muxIndex).toBe(burnIndex + 1);
    // The mux takes the burned file as its video input, and its output is the
    // artifact the caller is handed — that is what makes the audio survive.
    expect(ffmpegArgs[muxIndex]).toContain(result.file);
    expect(ffmpegArgs[muxIndex][ffmpegArgs[muxIndex].length - 1].endsWith('narrated.mp4')).toBe(true);
    expect(existsSync(result.file)).toBe(true);
  });

  it('a gif refuses narration up front rather than producing a broken encode', async () => {
    const { ffmpegArgs } = installFakes();
    let spoke = false;
    setSpeakForTests(async () => {
      spoke = true;
      return { ok: true, file: '/tmp/never.mp3' };
    });
    const result = await renderMotion({ html: source, duration_ms: 300, format: 'gif', narration: 'hi' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings.join(' ')).toContain('GIF cannot carry an audio track');
    expect(spoke).toBe(false);
    expect(ffmpegArgs).toHaveLength(1);
  });

  it('a gif that burns captions keeps its palette chain in ONE -vf', async () => {
    // ffmpeg honours only the LAST `-vf` it is given, so a palette chain and a
    // caption burn written as two flags rendered the subtitles over an
    // un-palettised sequence with nothing reporting it.
    const args = buildFfmpegArgs({
      fps: 30,
      pattern: '/tmp/f/frame-%05d.png',
      out: '/tmp/out.gif',
      format: 'gif',
      srtPath: '/tmp/a.srt',
      burnCaptions: true,
    });
    expect(args.filter((a) => a === '-vf')).toHaveLength(1);
    const chain = args[args.indexOf('-vf') + 1];
    expect(chain).toContain('palettegen');
    expect(chain).toContain('subtitles=/tmp/a.srt');
  });

  it('writes captions as an srt beside the video', async () => {
    installFakes();
    const result = await renderMotion({
      html: source,
      duration_ms: 1_000,
      captions: [{ from_ms: 0, to_ms: 500, text: 'first' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.srt).toBeTruthy();
    expect(readFileSync(result.srt!, 'utf-8')).toContain('00:00:00,000 --> 00:00:00,500');
  });
});

// ─── The tool: source resolution + history ─────────────────────────────────

describe('motion_render — source resolution and the render history', () => {
  const ctx = () => ({ cwd: workDir }) as never;

  it('lists the presets with what each needs', async () => {
    const { text } = await runMotionTool({ action: 'presets' }, ctx());
    expect(text).toContain('bar-race');
    expect(text).toContain('needs data');
    expect(text).toContain('title-card (no data needed)');
  });

  it('renders a preset from CSV data, records it, and offers a render id', async () => {
    const { record } = installFakes();
    const result = await runMotionTool(
      { preset: 'bar-race', data: 'label,value\nAlpha,10\nBeta,25\n', duration_ms: 500, fps: 10, width: 320, height: 180 },
      ctx(),
    );
    expect(result.text).toContain('motion_render: mp4 written to');
    expect(result.text).toContain('320x180');
    expect(result.media?.mime).toBe('video/mp4');
    expect(result.media?.path.endsWith('.mp4')).toBe(true);
    // The data reached the page, ranked by value.
    expect(record.content[0]).toContain('Beta');
    const [manifest] = listMotionManifests(workDir);
    expect(manifest.preset).toBe('bar-race');
    expect(manifest.revisions).toBe(0);
    expect(result.text).toContain(manifest.id);
  });

  it('refuses a data preset with nothing parseable, and says which shapes work', async () => {
    installFakes();
    const result = await runMotionTool({ preset: 'line-reveal' }, ctx());
    expect(result.text).toContain('Error:');
    expect(result.text).toContain('[{label,value}]');
    expect(result.text).toContain('data_path');
  });

  it('names the presets when one is misspelled', async () => {
    installFakes();
    const { text } = await runMotionTool({ preset: 'bar-racee' }, ctx());
    expect(text).toContain("unknown preset 'bar-racee'");
    expect(text).toContain('title-card');
  });

  it('refuses a missing html file instead of rendering nothing', async () => {
    installFakes();
    const { text } = await runMotionTool({ html_path: 'nope.html' }, ctx());
    expect(text).toContain("no such html file 'nope.html'");
  });

  it('refuses an empty request and quotes the seek contract', async () => {
    const { text } = await runMotionTool({}, ctx());
    expect(text).toContain('nothing to render');
    expect(text).toContain('window.__motion');
  });

  it('renders inline html as raw source', async () => {
    const { record } = installFakes();
    const result = await runMotionTool({ html: '<html><body><h1>mine</h1></body></html>', duration_ms: 300 }, ctx());
    expect(result.media).toBeTruthy();
    expect(record.content[0]).toContain('mine');
  });

  it('revises a stored render deterministically: same settings, stored source, revision counted', async () => {
    const { record } = installFakes();
    const first = await runMotionTool(
      { preset: 'title-card', params: { title: 'Before' }, duration_ms: 600, fps: 10, width: 320, height: 180 },
      ctx(),
    );
    const id = listMotionManifests(workDir)[0].id;
    expect(first.text).toContain(id);

    // A revision with new params only: the preset is re-rendered with the new
    // numbers and every inherited setting kept.
    const revised = await runMotionTool({ action: 'revise', source_id: id, params: { title: 'After' } }, ctx());
    expect(revised.media).toBeTruthy();
    const last = record.content[record.content.length - 1];
    expect(last).toContain('After');
    expect(last).not.toContain('Before');
    const [manifest] = listMotionManifests(workDir);
    expect(manifest.id).toBe(id);
    expect(manifest.params?.title).toBe('After');
    expect(manifest.revisions).toBe(1);
    expect(manifest.durationMs).toBe(600);
    expect(manifest.fps).toBe(10);
    expect(manifest.width).toBe(320);
  });

  it('revises a hand-written render from its STORED source', async () => {
    const { record } = installFakes();
    await runMotionTool({ html: '<html><body><h1>v1</h1></body></html>', duration_ms: 300 }, ctx());
    const id = listMotionManifests(workDir)[0].id;
    await runMotionTool({ action: 'revise', source_id: id, duration_ms: 400 }, ctx());
    expect(record.content[record.content.length - 1]).toContain('v1');
    expect(listMotionManifests(workDir)[0].revisions).toBe(1);
  });

  it('asks for a source_id, and lists what it does know, when revising nothing', async () => {
    installFakes();
    await runMotionTool({ html: source, duration_ms: 300 }, ctx());
    const missing = await runMotionTool({ action: 'revise' }, ctx());
    expect(missing.text).toContain('needs source_id');
    const unknown = await runMotionTool({ action: 'revise', source_id: 'motion-19990101-nope' }, ctx());
    expect(unknown.text).toContain('no render with id');
    expect(unknown.text).toContain('motion-');
  });

  it('lists the renders in this workspace, newest first', async () => {
    installFakes();
    const empty = await runMotionTool({ action: 'list' }, ctx());
    expect(empty.text).toContain('no renders yet');
    await runMotionTool({ html: source, duration_ms: 300, out_name: 'first' }, ctx());
    const listed = await runMotionTool({ action: 'list' }, ctx());
    expect(listed.text).toContain('custom html');
    expect(listed.text).toContain('revise');
  });
});
