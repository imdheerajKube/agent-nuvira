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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  MOTION_INIT_SCRIPT,
  MOTION_READY_SCRIPT,
  MOTION_SEEK_SCRIPT,
  ffmpegWithSubtitles,
  injectRunner,
  seekScript,
  setSubtitlesProbeForTests,
  supportsSubtitles,
  buildFfmpegArgs,
  buildFramePlan,
  buildMuxArgs,
  buildSrt,
  captureRendererRecipe,
  collectFrameFiles,
  formatSrtTime,
  frameScanHint,
  frameScanWarnings,
  frameTimestampMs,
  gridFor,
  inspectMotion,
  listMotionManifests,
  loadMotionManifest,
  measureFrameSequence,
  motionAvailability,
  renderMotion,
  resolveFrameSize,
  sampleFrames,
  parseRendererCommand,
  runRendererRecipe,
  scanFrameDirectory,
  setFfmpegRunnerForTests,
  setFramesAvailabilityForTests,
  setMotionAvailabilityForTests,
  setMotionLauncherForTests,
  setRendererRunnerForTests,
  setSpeakForTests,
  verifyRendererRecipe,
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
  setFramesAvailabilityForTests(null);
  setRendererRunnerForTests(null);
  setSubtitlesProbeForTests(null);
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

/**
 * THE CALLER'S OWN RENDERER — and the reason the encoder was never the gap.
 *
 * A live run on this product produced a 600-frame paper-craft commercial by
 * writing Python and shelling out to ffmpeg: the frames and the encode were
 * never the hard part. Two things were missing, and they are what this block
 * pins: the frames could not enter the motion machinery at all (no render id, no
 * history, no captions, no narration, no reporting, and a failed encode left
 * whatever ffmpeg left behind), and the run could not LOOK at what it made — a
 * model cannot watch an MP4, so it delivered 600 frames it had never seen.
 */
describe("frames from the caller's own renderer", () => {
  /** A file with a real PNG header, so the size is read and not assumed. */
  function pngFrame(width: number, height: number): Buffer {
    const b = Buffer.alloc(32);
    b.write('\x89PNG\r\n\x1a\n', 0, 'binary');
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'ascii');
    b.writeUInt32BE(width, 16);
    b.writeUInt32BE(height, 20);
    return b;
  }

  function frameDir(names: string[], width = 640, height = 360): string {
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-motion-frames-'));
    for (const name of names) writeFileSync(join(dir, name), pngFrame(width, height));
    return dir;
  }

  beforeEach(() => {
    // The frames path must not touch a browser. A launcher that throws is how
    // that is PROVEN rather than assumed.
    setMotionLauncherForTests(async () => {
      throw new Error('chromium must not be launched for a frame sequence');
    });
    setFramesAvailabilityForTests({ ok: true, missing: [], hint: '' });
    setFfmpegRunnerForTests(async (args) => {
      writeFileSync(args[args.length - 1]!, Buffer.from('fake-video'));
      return { code: 0, stderr: '' };
    });
  });

  it('orders frames the way a person numbers them, not lexicographically', () => {
    const dir = frameDir(['f_10.png', 'f_2.png', 'f_1.png', 'notes.txt', '.DS_Store']);
    const files = collectFrameFiles(dir);
    expect(files.map((f) => basename(f))).toEqual(['f_1.png', 'f_2.png', 'f_10.png']);
  });

  it('takes a glob, so one directory can hold several sequences', () => {
    const dir = frameDir(['shot_a_0001.png', 'shot_a_0002.png', 'shot_b_0001.png']);
    expect(collectFrameFiles(dir, 'shot_a_*.png')).toHaveLength(2);
    expect(collectFrameFiles(dir, 'missing_*.png')).toHaveLength(0);
  });

  it('measures the real size and reports frames that disagree with it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-motion-mixed-'));
    writeFileSync(join(dir, 'f_0001.png'), pngFrame(640, 360));
    writeFileSync(join(dir, 'f_0002.png'), pngFrame(640, 360));
    writeFileSync(join(dir, 'f_0003.png'), pngFrame(128, 128));
    const sequence = measureFrameSequence(collectFrameFiles(dir))!;
    expect(sequence.width).toBe(640);
    expect(sequence.height).toBe(360);
    expect(sequence.mismatched).toBe(1);
    expect(sequence.files).toHaveLength(3);
  });

  it('encodes the sequence and states what it measured', async () => {
    const dir = frameDir(['f_0001.png', 'f_0002.png', 'f_0003.png']);
    const result = await renderMotion({ framesDir: dir, fps: 30, out_name: 'external' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.frameSource).toBe('frames');
    expect(result.seek).toBe('external');
    expect(result.frameCount).toBe(3);
    expect(result.width).toBe(640);
    expect(result.height).toBe(360);
    // The animation already happened in the caller's program, so the "not
    // seekable" warning — which is about a PAGE — must not appear.
    expect(result.warnings.join(' ')).not.toContain('not seekable');
    expect(result.warnings.join(' ')).toContain("caller's renderer");
    expect(existsSync(result.file)).toBe(true);
  });

  it('needs ffmpeg and NO chromium — a machine without playwright still renders', async () => {
    // The browser report says the page renderer is unavailable; the frames render
    // is not a page render, and refusing it would be a false blocker.
    setMotionAvailabilityForTests({ ok: false, missing: ['chromium (playwright)'], hint: 'npx playwright install chromium' });
    const dir = frameDir(['f_0001.png', 'f_0002.png']);
    const result = await renderMotion({ framesDir: dir, fps: 30 });
    expect(result.ok).toBe(true);
  });

  it('refuses when ffmpeg is missing, naming it', async () => {
    setFramesAvailabilityForTests({ ok: false, missing: ['ffmpeg'], hint: 'brew install ffmpeg' });
    const dir = frameDir(['f_0001.png']);
    const result = await renderMotion({ framesDir: dir, fps: 30 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('ffmpeg');
    expect(result.hint).toContain('brew install ffmpeg');
  });

  it('refuses an empty directory instead of encoding nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-motion-empty-'));
    const result = await renderMotion({ framesDir: dir, fps: 30 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('no image frames found');
    expect(result.error).toContain('.png');
  });

  it('muxes an audio bed, and says so when the file is not there', async () => {
    const dir = frameDir(['f_0001.png', 'f_0002.png']);
    const audio = join(dir, 'bed.m4a');
    writeFileSync(audio, Buffer.from('audio'));
    const argv: string[][] = [];
    setFfmpegRunnerForTests(async (args) => {
      argv.push(args);
      writeFileSync(args[args.length - 1]!, Buffer.from('fake-video'));
      return { code: 0, stderr: '' };
    });

    await renderMotion({ framesDir: dir, fps: 30, audioPath: audio });
    expect(argv[0]).toContain(audio);
    expect(argv[0]).toContain('aac');

    const missing = await renderMotion({ framesDir: dir, fps: 30, audioPath: join(dir, 'gone.mp3') });
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.warnings.join(' ')).toContain('does not exist');
  });
});

describe('the contact sheet — looking at what was made', () => {
  function frameDir(names: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-motion-sheet-'));
    for (const name of names) writeFileSync(join(dir, name), Buffer.from('png'));
    return dir;
  }

  it('lays the tiles out readably, whatever the count', () => {
    expect(gridFor(12)).toEqual({ cols: 4, rows: 3 });
    expect(gridFor(9)).toEqual({ cols: 3, rows: 3 });
    expect(gridFor(2)).toEqual({ cols: 2, rows: 1 });
    expect(gridFor(24)).toEqual({ cols: 4, rows: 6 });
  });

  it('samples evenly and always keeps both ends', () => {
    const picks = sampleFrames([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4);
    expect(picks[0]).toBe(1);
    expect(picks[picks.length - 1]).toBe(10);
    expect(picks).toHaveLength(4);
    expect(sampleFrames([1, 2], 12)).toEqual([1, 2]);
  });

  it('tiles a frame sequence into one PNG, and needs no browser to do it', async () => {
    setMotionLauncherForTests(async () => {
      throw new Error('chromium must not be launched to inspect frames');
    });
    setFramesAvailabilityForTests({ ok: true, missing: [], hint: '' });
    const argv: string[][] = [];
    setFfmpegRunnerForTests(async (args) => {
      argv.push(args);
      writeFileSync(args[args.length - 1]!, Buffer.from('png'));
      return { code: 0, stderr: '' };
    });

    const dir = frameDir(Array.from({ length: 60 }, (_, i) => `f_${String(i + 1).padStart(4, '0')}.png`));
    const result = await inspectMotion({ framesDir: dir, fps: 30, tiles: 12, tile_width: 480 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.cols).toBe(4);
    expect(result.rows).toBe(3);
    expect(result.tiles).toBe(12);
    expect(result.totalFrames).toBe(60);
    expect(result.frameSource).toBe('frames');
    // 2s of footage across 12 tiles.
    expect(result.secondsPerTile).toBeCloseTo(2 / 11, 4);
    const filter = argv[0]![argv[0]!.indexOf('-vf') + 1]!;
    expect(filter).toContain('tile=4x3');
    expect(filter).toContain('scale=480:-2');
    expect(result.file.endsWith('.png')).toBe(true);
  });

  it('refuses an empty source rather than writing a sheet of nothing', async () => {
    setFramesAvailabilityForTests({ ok: true, missing: [], hint: '' });
    setFfmpegRunnerForTests(async (args) => {
      writeFileSync(args[args.length - 1]!, Buffer.from('png'));
      return { code: 0, stderr: '' };
    });
    const result = await inspectMotion({ html: '   ' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('nothing to inspect');
  });
});

/**
 * BURNING CAPTIONS IS GATED ON LIBASS, NOT ON THE USER KNOWING THAT.
 *
 * Measured 2026-10-17: Homebrew's `ffmpeg` (9.0.2) has no libass, `ffmpeg-full`
 * next to it does. The tool used to run the burn through PATH ffmpeg and then warn
 * "this ffmpeg may lack libass" — advice the user cannot act on when the capable
 * build is already installed. These pin both halves: it FINDS the capable build, and
 * when there genuinely is none it names the install instead of guessing.
 */
describe('captions burn through an ffmpeg that can actually burn them', () => {
  function pngFrame(): Buffer {
    const b = Buffer.alloc(32);
    b.write('\x89PNG\r\n\x1a\n', 0, 'binary');
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'ascii');
    b.writeUInt32BE(320, 16);
    b.writeUInt32BE(180, 20);
    return b;
  }

  function frames(): string {
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-motion-burn-'));
    for (const name of ['f_0001.png', 'f_0002.png']) writeFileSync(join(dir, name), pngFrame());
    return dir;
  }

  const captions = [{ from_ms: 0, to_ms: 1000, text: 'hello' }];

  beforeEach(() => {
    setFramesAvailabilityForTests({ ok: true, missing: [], hint: '' });
  });

  it('finds and uses the libass-capable build instead of PATH ffmpeg', async () => {
    setSubtitlesProbeForTests((binary) => binary.includes('ffmpeg-full'));
    const chosen = ffmpegWithSubtitles();
    expect(chosen).toContain('ffmpeg-full');

    const binaries: (string | undefined)[] = [];
    setFfmpegRunnerForTests(async (args, binary) => {
      binaries.push(binary);
      writeFileSync(args[args.length - 1]!, Buffer.from('video'));
      return { code: 0, stderr: '' };
    });

    const result = await renderMotion({
      framesDir: frames(),
      fps: 10,
      captions,
      burn_captions: true,
      cwd: workDir,
    });
    expect(result.ok, !result.ok ? result.error : '').toBe(true);
    if (!result.ok) return;
    // The FIRST encode runs on the ordinary binary; the BURN is the one that must use
    // the build with libass.
    expect(binaries).toContain(chosen);
    expect(result.srt).toBeTruthy();
    expect(result.warnings.join(' ')).not.toContain('could NOT be burned');
  });

  it('names the install rather than guessing when no ffmpeg can burn', async () => {
    setSubtitlesProbeForTests(() => false);
    expect(ffmpegWithSubtitles()).toBeNull();

    setFfmpegRunnerForTests(async (args) => {
      writeFileSync(args[args.length - 1]!, Buffer.from('video'));
      return { code: 0, stderr: '' };
    });

    const result = await renderMotion({
      framesDir: frames(),
      fps: 10,
      captions,
      burn_captions: true,
      cwd: workDir,
    });
    // The render still SUCCEEDS — the .srt is written and the video is real. Only the
    // burn is missing, and it says why and what to install.
    expect(result.ok, !result.ok ? result.error : '').toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(' ')).toContain('brew install ffmpeg-full');
    expect(result.warnings.join(' ')).toContain('NUVIRA_FFMPEG');
    expect(existsSync(result.srt!)).toBe(true);
  });

  it('probes a real binary and reports what it supports', () => {
    setSubtitlesProbeForTests(null);
    // The keg this machine has, when it has it — and PATH ffmpeg is allowed either way,
    // so this asserts the PROBE works rather than what any build happens to carry.
    expect(typeof supportsSubtitles('ffmpeg')).toBe('boolean');
  });
});

describe('a frames render is honest about what it cannot revise', () => {
  it('names the missing renderer and both fixes, instead of properly re-encoding stale frames', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-motion-revise-'));
    writeFileSync(join(dir, 'f_0001.png'), Buffer.from('png'));
    setFramesAvailabilityForTests({ ok: true, missing: [], hint: '' });
    setFfmpegRunnerForTests(async (args) => {
      writeFileSync(args[args.length - 1]!, Buffer.from('fake-video'));
      return { code: 0, stderr: '' };
    });

    // One workspace for both calls: the render's manifest is what the revision
    // has to fail to find a renderer for.
    const workCwd = mkdtempSync(join(tmpdir(), 'nuvira-motion-ws-'));
    const ctxFor = { configManager: {} as never, cwd: workCwd };

    const rendered = await runMotionTool({ frames_dir: dir, fps: 30, out_name: 'external' }, ctxFor);
    expect(rendered.text).toContain('custom source');
    // A frames render with no recorded command says so AT RENDER TIME, so the
    // caller learns it before they need a revision rather than after.
    expect(rendered.text).toContain('no renderer_command was recorded');
    const id = /source_id:'([^']+)'/.exec(rendered.text)?.[1];
    expect(id).toBeTruthy();

    const revised = await runMotionTool({ action: 'revise', source_id: id }, ctxFor);
    // The refusal has to say WHY (re-encoding would fake a revision) and give both
    // ways out — a refusal that only says no is a dead end.
    expect(revised.text).toContain('NO renderer command was recorded');
    expect(revised.text).toContain('call it a revision');
    expect(revised.text).toContain('frames_dir');
    expect(revised.text).toContain("renderer_command:'python render.py'");
    expect(loadMotionManifest(id!, workCwd)!.revisions).toBe(0);
  });
});

/**
 * A FRAMES REVISION THAT IS ACTUALLY A REVISION.
 *
 * The old behaviour refused every frames revision, which was honest but made the
 * frames route a dead end for iteration. Running the recorded renderer is what a
 * revision MEANS for a program that produced the frames, and these tests pin the
 * three ways that can go: it re-runs, it refuses a changed renderer, and it fails
 * loudly when the renderer itself fails.
 */
describe('revising a frames render by re-running its renderer', () => {
  let workCwd = '';
  let dir = '';
  let script = '';

  function pngFrame(): Buffer {
    const b = Buffer.alloc(32);
    b.write('\x89PNG\r\n\x1a\n', 0, 'binary');
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'ascii');
    b.writeUInt32BE(640, 16);
    b.writeUInt32BE(360, 20);
    return b;
  }

  /** The caller's "renderer": a script whose only job is to rewrite the frames. */
  function writeRenderer(frames: number): void {
    writeFileSync(script, '#!/bin/sh\necho rendered $(date +%s)\n', 'utf-8');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= frames; i += 1) {
      writeFileSync(join(dir, `f_${String(i).padStart(4, '0')}.png`), pngFrame());
    }
  }

  beforeEach(() => {
    workCwd = mkdtempSync(join(tmpdir(), 'nuvira-motion-revws-'));
    dir = join(workCwd, 'frames');
    script = join(workCwd, 'render.py');
    mkdirSync(dir, { recursive: true });
    setFramesAvailabilityForTests({ ok: true, missing: [], hint: '' });
    setMotionLauncherForTests(async () => {
      throw new Error('chromium must not be launched to re-encode frames');
    });
    setFfmpegRunnerForTests(async (args) => {
      writeFileSync(args[args.length - 1]!, Buffer.from('fake-video'));
      return { code: 0, stderr: '' };
    });
  });

  afterEach(() => {
    setRendererRunnerForTests(null);
    setFfmpegRunnerForTests(null);
    setMotionLauncherForTests(null);
    setFramesAvailabilityForTests(null);
    rmSync(workCwd, { recursive: true, force: true });
  });

  const ctxFor = (): { configManager: never; cwd: string } =>
    ({ configManager: {} as never, cwd: workCwd });

  it('re-runs the recorded renderer, re-encodes the FRESH frames, and says what it ran', async () => {
    writeRenderer(3);
    let ran = 0;
    setRendererRunnerForTests(async (recipe) => {
      ran += 1;
      // The renderer is what produces the NEW frames — 5 this time, not 3.
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      for (let i = 1; i <= 5; i += 1) writeFileSync(join(dir, `f_${String(i).padStart(4, '0')}.png`), pngFrame());
      expect(recipe.command).toBe('python render.py');
      return { ok: true, code: 0, output: 'rendered', timedOut: false };
    });

    const first = await runMotionTool(
      { frames_dir: dir, fps: 30, renderer_command: 'python render.py' },
      ctxFor(),
    );
    expect(first.text).toContain('Renderer recorded: python render.py');
    expect(first.text).toContain('3 frames');
    const id = /source_id:'([^']+)'/.exec(first.text)![1]!;

    const second = await runMotionTool({ action: 'revise', source_id: id }, ctxFor());
    expect(ran).toBe(1);
    expect(second.text).toContain('Re-ran your renderer for fresh frames');
    expect(second.text).toContain('python render.py');
    // The re-encode used the frames the renderer just wrote, not the old three.
    expect(second.text).toContain('5 frames');
    expect(second.text).toContain('0.17s');
    const manifest = loadMotionManifest(id, workCwd)!;
    expect(manifest.revisions).toBe(1);
    expect(manifest.renderer?.command).toBe('python render.py');
  });

  it('makes an existing frames render revisable when the command is supplied on the revise', async () => {
    writeRenderer(2);
    setRendererRunnerForTests(async () => ({ ok: true, code: 0, output: '', timedOut: false }));

    const first = await runMotionTool({ frames_dir: dir, fps: 30 }, ctxFor());
    const id = /source_id:'([^']+)'/.exec(first.text)![1]!;
    expect(loadMotionManifest(id, workCwd)!.renderer).toBeUndefined();

    const revised = await runMotionTool(
      { action: 'revise', source_id: id, renderer_command: 'python render.py' },
      ctxFor(),
    );
    expect(revised.text).toContain('Re-ran your renderer');
    expect(loadMotionManifest(id, workCwd)!.renderer?.command).toBe('python render.py');
  });

  it('refuses when the renderer CHANGED, because its output is a different animation', async () => {
    writeRenderer(2);
    let ran = 0;
    setRendererRunnerForTests(async () => {
      ran += 1;
      return { ok: true, code: 0, output: '', timedOut: false };
    });

    const first = await runMotionTool(
      { frames_dir: dir, fps: 30, renderer_command: 'python render.py' },
      ctxFor(),
    );
    const id = /source_id:'([^']+)'/.exec(first.text)![1]!;

    // The script is edited after the render was made: identical command, different
    // program. A revision of the old animation is no longer what this produces.
    writeFileSync(script, '#!/bin/sh\necho TOTALLY DIFFERENT\n', 'utf-8');

    const refused = await runMotionTool({ action: 'revise', source_id: id }, ctxFor());
    expect(refused.text).toContain('the renderer changed since');
    expect(refused.text).toContain('allow_renderer_change:true');
    expect(ran).toBe(0);
    expect(loadMotionManifest(id, workCwd)!.revisions).toBe(0);

    const forced = await runMotionTool(

      { action: 'revise', source_id: id, allow_renderer_change: true },
      ctxFor(),
    );
    expect(ran).toBe(1);
    expect(forced.text).toContain('run despite the renderer having changed');
  });

  it('reports a FAILED renderer as a failure and leaves the previous render alone', async () => {
    writeRenderer(2);
    setRendererRunnerForTests(async () => ({
      ok: false,
      code: 1,
      output: 'Traceback: no module named PIL',
      timedOut: false,
    }));

    const first = await runMotionTool(
      { frames_dir: dir, fps: 30, renderer_command: 'python render.py' },
      ctxFor(),
    );
    const id = /source_id:'([^']+)'/.exec(first.text)![1]!;

    const manifest = loadMotionManifest(id, workCwd)!;
    const before = readFileSync(manifest.artifact, 'utf-8');

    const failed = await runMotionTool({ action: 'revise', source_id: id }, ctxFor());
    expect(failed.text).toContain('exited with code 1');
    expect(failed.text).toContain('no module named PIL');
    expect(failed.media).toBeUndefined();
    expect(loadMotionManifest(id, workCwd)!.revisions).toBe(0);
    // "Untouched" is the claim that matters, so it is the artifact's CONTENT that is
    // compared — not merely that a file exists, which the first render already left.
    expect(readFileSync(manifest.artifact, 'utf-8')).toBe(before);
  });

  it('refuses a renderer_command with no frames to render it from', async () => {
    const result = await runMotionTool({ html: '<html></html>', renderer_command: 'python render.py' }, ctxFor());
    expect(result.text).toContain('only applies to a frames render');
  });

  it('records the files the command names, and detects the script changing', () => {
    writeFileSync(script, 'print(1)\n', 'utf-8');
    const data = join(workCwd, 'data.csv');
    writeFileSync(data, 'a,b\n', 'utf-8');

    const recipe = captureRendererRecipe('python render.py --data data.csv --fps 30', workCwd);
    expect(recipe.files.map((f) => basename(f.path)).sort()).toEqual(['data.csv', 'render.py']);
    // Flags and bare numbers are skipped: only what the command POINTS AT is recorded.
    expect(recipe.files.some((f) => f.path.includes('--fps'))).toBe(false);
    expect(verifyRendererRecipe(recipe)).toEqual({ ok: true });

    writeFileSync(script, 'print(2)\n', 'utf-8');
    const check = verifyRendererRecipe(recipe);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.changed.join(' ')).toContain('render.py');
  });
});

/**
 * A REVISION RUNS A STORED COMMAND — so it must be inspectable, minimal, and
 * traceable.
 *
 * Three concrete risks, each closed here: the command used to be handed to a SHELL
 * (so a stored string could be re-interpreted as subshells/redirects/chains), the
 * only way to know what it would do was to let it run, and nothing recorded that it
 * had run at all.
 */
describe('running a stored renderer command safely', () => {
  it('treats a plain command as argv and needs no shell', () => {
    expect(parseRendererCommand('python3 render.py --frames 20')).toEqual({
      argv: ['python3', 'render.py', '--frames', '20'],
      viaShell: false,
    });
    // Quotes are honoured rather than passed through to a shell.
    expect(parseRendererCommand('python3 render.py --title "my video"')).toEqual({
      argv: ['python3', 'render.py', '--title', 'my video'],
      viaShell: false,
    });
    // A path with a space, quoted once, stays ONE argument.
    expect(parseRendererCommand(`node "/tmp/my script.js"`).argv).toEqual(['node', '/tmp/my script.js']);
  });

  it('marks a command that genuinely needs a shell, instead of guessing', () => {
    for (const command of [
      'python3 render.py > log.txt',
      'python3 render.py | tee log.txt',
      'python3 render.py && python3 encode.py',
      'python3 render.py --frames $(cat n.txt)',
      'python3 render.py --out `date`.mp4',
      'python3 render.py --out *.mp4',
    ]) {
      const parsed = parseRendererCommand(command);
      expect(parsed.viaShell, command).toBe(true);
      // Passed whole: a shell command cannot be split into argv without changing it.
      expect(parsed.argv).toEqual([command]);
    }
  });

  it('runs an argv command for real without a shell, and reports it', async () => {
    // A real subprocess, because "no shell" is a claim about spawn, not about a string.
    const script = join(workDir, 'renderer.js');
    writeFileSync(script, 'console.log("ran without a shell");\n', 'utf-8');

    const run = await runRendererRecipe({ command: `node ${script}`, cwd: workDir, files: [], capturedAt: Date.now() });
    expect(run.ok, run.output).toBe(true);
    expect(run.viaShell).toBe(false);
    expect(run.output).toContain('ran without a shell');
    expect(run.ms).toBeGreaterThanOrEqual(0);
  });

  it('hashes ANY size, and notices an edit that keeps the size identical', () => {
    // The old cap refused to hash over 8 MiB and compared sizes instead, so editing a
    // large input LEFT THE FINGERPRINT UNCHANGED — "the renderer did not change" about
    // a file that had.
    const big = join(workDir, 'big.csv');
    writeFileSync(big, Buffer.alloc(9 * 1024 * 1024, 'a'));
    const recipe = captureRendererRecipe('python3 render.py --data big.csv', workDir);
    const entry = recipe.files.find((f) => f.path === big)!;
    expect(entry.sha256).toBeTruthy();
    expect(entry.size).toBe(9 * 1024 * 1024);
    expect(verifyRendererRecipe(recipe)).toEqual({ ok: true });

    // One byte, same length: a size comparison cannot see this, a hash can.
    const edited = Buffer.alloc(9 * 1024 * 1024, 'a');
    edited[9 * 1024 * 1024 - 1] = 'b'.charCodeAt(0);
    writeFileSync(big, edited);
    expect(statSync(big).size).toBe(entry.size);
    const check = verifyRendererRecipe(recipe);
    expect(check.ok).toBe(false);
  });

  it('keeps an audit trail of every run, and tracks files the run CREATED', async () => {
    const dir = join(workDir, 'frames');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'f_0001.png'), Buffer.from('png'));
    const script = join(workDir, 'render.py');
    // A renderer that writes a file it was given that does not exist YET, which is the
    // case that used to go untracked.
    writeFileSync(script, 'console.log(1)\n', 'utf-8');
    const created = join(workDir, 'cache.json');

    const ctx = { configManager: {} as never, cwd: workDir };
    setFramesAvailabilityForTests({ ok: true, missing: [], hint: '' });
    setFfmpegRunnerForTests(async (args) => {
      writeFileSync(args[args.length - 1]!, Buffer.from('video'));
      return { code: 0, stderr: '' };
    });
    setRendererRunnerForTests(async () => {
      writeFileSync(created, 'cache\n', 'utf-8');
      return { ok: true, code: 0, output: '', timedOut: false, viaShell: false, ms: 12 };
    });

    const first = await runMotionTool(
      { frames_dir: dir, fps: 10, renderer_command: `node render.py ${created}` },
      ctx,
    );
    const id = /source_id:'([^']+)'/.exec(first.text)![1]!;
    // Not tracked yet: it did not exist when the command was recorded.
    expect(loadMotionManifest(id, workDir)!.renderer!.files.some((f) => f.path === created)).toBe(false);

    const second = await runMotionTool({ action: 'revise', source_id: id }, ctx);
    expect(second.text).toContain('Re-ran your renderer');
    const recipe = loadMotionManifest(id, workDir)!.renderer!;
    // NOW tracked — re-fingerprinted after the run — and the run is on the record.
    expect(recipe.files.some((f) => f.path === created && f.sha256)).toBe(true);
    expect(recipe.runs).toHaveLength(1);
    expect(recipe.runs![0]).toMatchObject({ code: 0, frames: 1, viaShell: false });
    // And a file THIS run created is tracked from here on, so editing it is detected.
    writeFileSync(created, 'changed\n', 'utf-8');
    expect(verifyRendererRecipe(recipe).ok).toBe(false);

    setRendererRunnerForTests(null);
    setFfmpegRunnerForTests(null);
  });

  it('says a no-op run re-encoded the same animation instead of presenting it as new', async () => {
    const dir = join(workDir, 'frames');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'f_0001.png'), Buffer.from('png'));
    writeFileSync(join(workDir, 'render.py'), 'console.log(1)\n', 'utf-8');

    const ctx = { configManager: {} as never, cwd: workDir };
    setFramesAvailabilityForTests({ ok: true, missing: [], hint: '' });
    setFfmpegRunnerForTests(async (args) => {
      writeFileSync(args[args.length - 1]!, Buffer.from('video'));
      return { code: 0, stderr: '' };
    });
    // A renderer that runs and changes nothing at all — the subtle failure: the frames
    // are the old ones, and the report has to say so.
    setRendererRunnerForTests(async () => ({ ok: true, code: 0, output: '', timedOut: false, viaShell: false, ms: 5 }));

    const first = await runMotionTool({ frames_dir: dir, fps: 10, renderer_command: 'node render.py' }, ctx);
    const id = /source_id:'([^']+)'/.exec(first.text)![1]!;
    const second = await runMotionTool({ action: 'revise', source_id: id }, ctx);
    expect(second.text).toContain('IDENTICAL to before this run');
    expect(second.text).toContain('re-encodes the same animation');

    setRendererRunnerForTests(null);
    setFfmpegRunnerForTests(null);
  });

  it('previews what a revision would run, and changes NOTHING', async () => {
    const dir = join(workDir, 'frames');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'f_0001.png'), Buffer.from('png'));
    const script = join(workDir, 'render.py');
    writeFileSync(script, 'console.log(1)\n', 'utf-8');

    const ctx = { configManager: {} as never, cwd: workDir };
    setFramesAvailabilityForTests({ ok: true, missing: [], hint: '' });
    setFfmpegRunnerForTests(async (args) => {
      writeFileSync(args[args.length - 1]!, Buffer.from('video'));
      return { code: 0, stderr: '' };
    });
    let ran = 0;
    setRendererRunnerForTests(async () => {
      ran += 1;
      return { ok: true, code: 0, output: '', timedOut: false, viaShell: false, ms: 1 };
    });

    const first = await runMotionTool({ frames_dir: dir, fps: 10, renderer_command: 'node render.py' }, ctx);
    const id = /source_id:'([^']+)'/.exec(first.text)![1]!;
    const before = loadMotionManifest(id, workDir)!;

    const preview = await runMotionTool({ action: 'revise', source_id: id, preview: true }, ctx);
    expect(preview.text).toContain('PREVIEW');
    expect(preview.text).toContain('would run: node render.py');
    expect(preview.text).toContain('no shell');
    expect(preview.text).toContain('tracks 1 file');
    expect(preview.text).toContain('unchanged');
    expect(preview.media).toBeUndefined();

    // Nothing ran, and nothing changed on disk.
    expect(ran).toBe(0);
    const after = loadMotionManifest(id, workDir)!;
    expect(after.revisions).toBe(before.revisions);
    expect(after.runs ?? after.renderer?.runs ?? []).toEqual(before.renderer?.runs ?? []);

    setRendererRunnerForTests(null);
    setFfmpegRunnerForTests(null);
  });

  it('previews the refusal when the render has no recorded renderer', async () => {
    const dir = join(workDir, 'frames');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'f_0001.png'), Buffer.from('png'));
    const ctx = { configManager: {} as never, cwd: workDir };
    setFramesAvailabilityForTests({ ok: true, missing: [], hint: '' });
    setFfmpegRunnerForTests(async (args) => {
      writeFileSync(args[args.length - 1]!, Buffer.from('video'));
      return { code: 0, stderr: '' };
    });

    const first = await runMotionTool({ frames_dir: dir, fps: 10 }, ctx);
    const id = /source_id:'([^']+)'/.exec(first.text)![1]!;
    const preview = await runMotionTool({ action: 'revise', source_id: id, preview: true }, ctx);
    expect(preview.text).toContain('no recorded renderer');
    expect(preview.text).toContain('renderer_command');
    setFfmpegRunnerForTests(null);
  });
});

/**
 * WHAT THE DIRECTORY IS, before what is in it.
 *
 * Every case here produces a video that PLAYS while being wrong — two sequences
 * spliced, a shorter timeline from a numbering gap, mixed formats, frames in a
 * subdirectory silently skipped. None of them can be caught downstream, so the
 * scan is the only place they can be caught at all.
 */
describe('telling the caller what their frame directory actually contains', () => {
  function dirWith(names: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-motion-scan-'));
    for (const name of names) writeFileSync(join(dir, name), Buffer.from('png'));
    return dir;
  }

  it('names several sequences that are about to be concatenated', () => {
    const dir = dirWith(['frame_0001.png', 'frame_0002.png', 'frame_0003.png', 'shot2_0001.png']);
    const scan = scanFrameDirectory(dir);
    expect(scan.prefixes).toEqual(['frame_', 'shot2_']);
    const warnings = frameScanWarnings(scan);
    expect(warnings.join(' ')).toContain('2 different frame sequences');
    expect(warnings.join(' ')).toContain('frames_pattern');
  });

  it('measures a numbering gap, and does not invent one for a sparse naming scheme', () => {
    const gapped = dirWith(['f_0001.png', 'f_0002.png', 'f_0005.png']);
    const scan = scanFrameDirectory(gapped);
    expect(scan.missing).toEqual([3, 4]);
    expect(scan.missingTotal).toBe(2);
    expect(frameScanWarnings(scan).join(' ')).toContain('missing');

    // 100, 200, 300 is how someone names three frames, not 197 dropped ones.
    const sparse = dirWith(['f_100.png', 'f_200.png', 'f_300.png']);
    expect(scanFrameDirectory(sparse).missingTotal).toBe(0);
  });

  it('flags mixed formats and unnumbered names', () => {
    const mixed = dirWith(['a_0001.png', 'a_0002.jpg']);
    expect(frameScanWarnings(scanFrameDirectory(mixed)).join(' ')).toContain('mix');

    const unnumbered = dirWith(['IMG_alpha.png', 'IMG_beta.png']);
    const scan = scanFrameDirectory(unnumbered);
    expect(scan.unnumbered).toBe(2);
    expect(frameScanWarnings(scan).join(' ')).toContain('ordered alphabetically');
  });

  it('says where the frames ARE when they are one level down', () => {
    const parent = mkdtempSync(join(tmpdir(), 'nuvira-motion-nested-'));
    mkdirSync(join(parent, 'scene1'));
    mkdirSync(join(parent, 'scene2'));
    writeFileSync(join(parent, 'scene1', 'f_0001.png'), Buffer.from('png'));
    writeFileSync(join(parent, 'scene2', 'f_0001.png'), Buffer.from('png'));

    const scan = scanFrameDirectory(parent);
    expect(scan.files).toHaveLength(0);
    expect(scan.nested.map((n) => n.dir).sort()).toEqual(['scene1', 'scene2']);
    const hint = frameScanHint(parent);
    expect(hint).toContain('one level down');
    expect(hint).toContain('scene1/');

    // And the recursive pattern is the escape hatch, in tree order.
    const recursive = scanFrameDirectory(parent, '**/*.png');
    expect(recursive.files.map((f) => f.slice(parent.length + 1))).toEqual([
      'scene1/f_0001.png',
      'scene2/f_0001.png',
    ]);
  });

  it('says frames in subdirectories were IGNORED when only some were used', () => {
    const parent = mkdtempSync(join(tmpdir(), 'nuvira-motion-partial-'));
    mkdirSync(join(parent, 'extra'));
    writeFileSync(join(parent, 'f_0001.png'), Buffer.from('png'));
    writeFileSync(join(parent, 'extra', 'f_0002.png'), Buffer.from('png'));
    const warnings = frameScanWarnings(scanFrameDirectory(parent)).join(' ');
    expect(warnings).toContain('IGNORED');
    expect(warnings).toContain('extra/');
  });
});
