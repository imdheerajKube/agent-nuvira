/**
 * Motion — animation authored as CODE, rendered to a real video file.
 *
 * WHY IT EXISTS. "Make me a short animated explainer" is not a video-model
 * request: a diffusion video model cannot label a chart with the user's own
 * numbers, cannot spell a product name correctly, and gives a different take
 * every run. The thing that can is an animation written as code — HTML/CSS/SVG
 * plus a timeline — and the only missing half was a way to turn that code into a
 * file. This module is that half: it drives a headless Chromium over the
 * animation's TIMELINE (not over wall-clock time) and hands the frames to
 * ffmpeg.
 *
 * THE CONTRACT, and it is the whole trick. An animation that only knows how to
 * play in real time cannot be rendered reproducibly: a slow frame, a dropped
 * rAF or a GC pause changes the output, and two runs of the same storyboard
 * disagree. So the page is asked to be SEEKABLE:
 *
 *   - `window.__motion = { seek(tMs) }` — set that state for time `t`. The
 *     preferred hook, and the only one that is exact.
 *   - a `requestAnimationFrame` loop is stepped by the injected runner at the
 *     same `tMs` (see `MOTION_INIT_SCRIPT`), so rAF-driven animation is
 *     deterministic even without the hook.
 *   - Web Animations (CSS animations/transitions, `element.animate`) are
 *     paused and moved to `currentTime = tMs`.
 *
 * Frames are captured at `t = i * 1000/fps`, so the same input produces the same
 * frames, the same duration and the same file — which is what makes a re-edit
 * ("scene 3, again, with the new number") meaningful.
 *
 * Everything expensive is gated on tools the user may not have: chromium
 * (playwright, opt-in exactly as `browser.ts` treats it) and `ffmpeg`. A missing
 * one is reported by name WITH the command that installs it, and never as a
 * half-written video file.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { envBuff } from '../../config/paths.js';
import { isBrowserAvailable } from './browser.js';
import { artifactsDir, binaryOnPath, safeArtifactName } from './shared.js';

// ─── Limits ────────────────────────────────────────────────────────────────

/** What ffmpeg container/codec the render targets. */
export type MotionFormat = 'mp4' | 'gif' | 'webm';

export const MOTION_LIMITS = {
  minFps: 1,
  maxFps: 60,
  defaultFps: 30,
  minDurationMs: 200,
  maxDurationMs: 10 * 60_000,
  defaultDurationMs: 8_000,
  maxFrames: 6_000,
  maxWidth: 3_840,
  maxHeight: 2_160,
  defaultWidth: 1_280,
  defaultHeight: 720,
} as const;

const clampInt = (raw: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** Even, because H.264's chroma subsampling rejects odd dimensions. */
const evenDimension = (n: number, max: number): number => Math.min(max, Math.max(64, Math.round(n / 2) * 2));

/**
 * The frame size: an aspect ratio names the SHAPE, a width/height names the
 * size, and both may be given (`16:9` at `width: 1920`). Whichever side the
 * caller pinned sets the scale and the ratio sets the other; nothing pinned
 * means a landscape default.
 */
export function resolveFrameSize(raw: { width?: unknown; height?: unknown; aspect_ratio?: unknown }): {
  width: number;
  height: number;
} {
  const width = clampInt(raw.width, 64, MOTION_LIMITS.maxWidth, MOTION_LIMITS.defaultWidth);
  const height = clampInt(raw.height, 64, MOTION_LIMITS.maxHeight, MOTION_LIMITS.defaultHeight);
  const ratio = typeof raw.aspect_ratio === 'string' ? raw.aspect_ratio.trim() : '';
  const parsed = /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/.exec(ratio);
  if (!parsed) return { width: evenDimension(width, MOTION_LIMITS.maxWidth), height: evenDimension(height, MOTION_LIMITS.maxHeight) };
  const rw = Number(parsed[1]);
  const rh = Number(parsed[2]);
  if (!(rw > 0) || !(rh > 0)) return { width: evenDimension(width, MOTION_LIMITS.maxWidth), height: evenDimension(height, MOTION_LIMITS.maxHeight) };
  if (raw.width !== undefined) return { width: evenDimension(width, MOTION_LIMITS.maxWidth), height: evenDimension((width * rh) / rw, MOTION_LIMITS.maxHeight) };
  if (raw.height !== undefined) return { width: evenDimension((height * rw) / rh, MOTION_LIMITS.maxWidth), height: evenDimension(height, MOTION_LIMITS.maxHeight) };
  const base = MOTION_LIMITS.defaultWidth;
  return { width: evenDimension(base, MOTION_LIMITS.maxWidth), height: evenDimension((base * rh) / rw, MOTION_LIMITS.maxHeight) };
}

// ─── The frame plan ────────────────────────────────────────────────────────

export interface MotionFramePlan {
  fps: number;
  durationMs: number;
  frames: number;
}

/**
 * How many frames a render is made of, and the fps it is played at.
 *
 * Frame `i` shows the animation at `t = i * 1000/fps`, so a 30fps 8s clip is 240
 * frames covering 0 → 7.967s: the last frame is the START of the last frame's
 * interval, which is what a video player expects (the duration comes from the
 * frame count, not from the timeline's last timestamp).
 */
export function buildFramePlan(opts: { fps?: unknown; duration_ms?: unknown }): MotionFramePlan {
  const fps = clampInt(opts.fps, MOTION_LIMITS.minFps, MOTION_LIMITS.maxFps, MOTION_LIMITS.defaultFps);
  const requested = clampInt(
    opts.duration_ms,
    MOTION_LIMITS.minDurationMs,
    MOTION_LIMITS.maxDurationMs,
    MOTION_LIMITS.defaultDurationMs,
  );
  // The frame cap is a resource guard (6,000 PNGs at 1080p is a lot of disk):
  // the duration is trimmed rather than rendered out of memory.
  const frames = Math.max(1, Math.min(MOTION_LIMITS.maxFrames, Math.round((requested / 1000) * fps)));
  return { fps, durationMs: Math.round((frames / fps) * 1000), frames };
}

/** The timeline position a frame is captured at (ms). */
export function frameTimestampMs(index: number, fps: number): number {
  return Math.round((index * 1000) / fps);
}

// ─── The page side of the contract ─────────────────────────────────────────

/**
 * Runs BEFORE the page's own scripts.
 *
 * Two jobs. (1) `window.__motionRunner` steps any `requestAnimationFrame` loop
 * at a caller-chosen time instead of at the wall clock, so a rAF-driven
 * animation is as reproducible as one using the seek hook. (2) It is the ONLY
 * thing here that touches the page: a page that defines
 * `window.__motion.seek(tMs)` keeps full control of its own determinism.
 *
 * rAF callbacks are queued rather than run immediately — that is what makes them
 * steppable — and each is handed the same `tMs` a browser would have handed it.
 */
export const MOTION_INIT_SCRIPT = `
(() => {
  const queued = [];
  window.requestAnimationFrame = (cb) => { queued.push(cb); return queued.length; };
  window.cancelAnimationFrame = () => {};
  window.__motionRunner = {
    step(t) {
      const due = queued.splice(0, queued.length);
      for (const cb of due) { try { cb(t); } catch (e) { /* one bad frame must not stop the render */ } }
    },
    pending() { return queued.length; },
  };
})();
`;

/**
 * Put the runner in the DOCUMENT, first in script order.
 *
 * Not `page.addInitScript`: that runs per new DOCUMENT, and `page.setContent`
 * (which this renderer uses, so an animation need not be a file on disk) writes
 * into the existing one — MEASURED against a real chromium, the runner was simply
 * absent and a rAF animation reported `seek: none`. Injecting the script into the
 * markup is also browser-agnostic, which is why it is done here rather than
 * through a page-API seam.
 */
export function injectRunner(html: string): string {
  const tag = `<script>${MOTION_INIT_SCRIPT}</script>`;
  for (const pattern of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<body(\s[^>]*)?>/i]) {
    if (pattern.test(html)) return html.replace(pattern, (match) => `${match}\n${tag}`);
  }
  // A fragment with no html/head/body: the script still has to come first.
  return `${tag}\n${html}`;
}

/**
 * Move the page to `tMs` — the hook the skill documents, then the rAF runner,
 * then Web Animations. Returns which mechanism answered (`hook` / `raf` /
 * `waapi` / `none`), so the render can tell
 * the caller when a page is NOT seekable (the one condition under which the
 * output would be a wall-clock recording rather than a render).
 *
 * The timestamp is INLINED and the whole thing is an immediately-invoked
 * expression, because `page.evaluate` treats a string as an expression rather
 * than as a function to call with an argument: a `(t) => …` string is evaluated,
 * its function VALUE comes back, and the page never moves. Reproduced against a
 * real chromium — the render reported `seek: none` on a page that had a working
 * hook — which is why this is a builder rather than a constant and a parameter.
 */
export const MOTION_SEEK_SCRIPT = `  let how = 'none';
  const hook = window.__motion;
  if (hook && typeof hook.seek === 'function') { hook.seek(t); how = 'hook'; }
  if (window.__motionRunner) {
    window.__motionRunner.step(t);
    // A stepped rAF loop IS a seek mechanism, so a page that animates only that
    // way is not reported as unseekable.
    if (how === 'none') how = 'raf';
  }
  if (document.getAnimations) {
    const anims = document.getAnimations();
    for (const a of anims) { try { a.pause(); a.currentTime = t; } catch (e) {} }
    if (anims.length > 0 && how === 'none') how = 'waapi';
  }
  return how;
`;

/** The expression that seeks the page to `tMs`, ready for `page.evaluate`. */
export function seekScript(tMs: number): string {
  return `(() => {\n  const t = ${Math.round(tMs)};\n${MOTION_SEEK_SCRIPT}})()`;
}

/**
 * Wait for fonts before the first frame is taken — the same IIFE rule as
 * `seekScript`: an expression, not a function value.
 */
export const MOTION_READY_SCRIPT = `(() =>
  new Promise((resolve) => {
    const done = () => resolve(true);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(done, done);
    else done();
  }))()`;

// ─── ffmpeg ────────────────────────────────────────────────────────────────

export interface MotionEncodeOptions {
  fps: number;
  /** printf-style frame pattern, absolute. */
  pattern: string;
  out: string;
  format: MotionFormat;
  /** Quality knob (lower = better for x264/VP9). */
  crf?: number;
  audioPath?: string;
  srtPath?: string;
  burnCaptions?: boolean;
}

/**
 * The ffmpeg argv for a frame sequence → video.
 *
 * `-start_number 1` because the capture numbers frames from 1 (`frame-00001.png`),
 * `yuv420p` and even dimensions because that is what players actually play, and
 * `+faststart` so an mp4 can be streamed/previewed without a full download.
 */
export function buildFfmpegArgs(o: MotionEncodeOptions): string[] {
  const crf = clampInt(o.crf, 0, 51, o.format === 'gif' ? 0 : 20);
  // A GIF has no audio track to mux into — the input would make ffmpeg fail with
  // a stream mapping error, so it is dropped here rather than guarded by every
  // caller.
  const audioPath = o.format === 'gif' ? undefined : o.audioPath;
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(o.fps), '-start_number', '1', '-i', o.pattern];
  if (audioPath) args.push('-i', audioPath);
  const burn = o.burnCaptions && o.srtPath ? o.srtPath : undefined;

  // ONE `-vf` for the whole chain: ffmpeg keeps only the LAST `-vf` it is given,
  // so a GIF's palette chain and a caption burn written as two flags would drop
  // the palette (the subtitles would render, over the wrong colors, and nothing
  // would say so).
  const filters: string[] = [];
  if (o.format === 'gif') {
    filters.push('split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer');
  }
  // Subtitles are burned with libass; the flag is opt-in because a build without
  // libass fails here rather than producing a wrong file (the error is returned
  // verbatim, so the reason is the user's to read).
  if (burn) filters.push(`subtitles=${burn}`);
  if (filters.length > 0) args.push('-vf', filters.join(','));

  if (o.format === 'gif') {
    args.push('-loop', '0');
  } else if (o.format === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(crf), '-pix_fmt', 'yuv420p');
  } else {
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(crf), '-movflags', '+faststart');
  }
  if (audioPath) {
    args.push('-c:a', 'aac', '-shortest');
  }
  args.push(o.out);
  return args;
}

/** The argv that attaches narration to an already-rendered video (stream copy). */
export function buildMuxArgs(o: { videoPath: string; audioPath: string; out: string }): string[] {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', o.videoPath, '-i', o.audioPath, '-c:v', 'copy', '-c:a', 'aac', '-shortest', o.out];
}

// ─── Captions ──────────────────────────────────────────────────────────────

export interface MotionCaption {
  from_ms: number;
  to_ms: number;
  text: string;
}

/** `HH:MM:SS,mmm` — the only timestamp shape SRT accepts. */
export function formatSrtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const milli = total % 1000;
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

/**
 * A caption track. `from`/`to` are what the caller asked for, and overlapping or
 * inverted cues are repaired rather than emitted (a file a player rejects is
 * worse than no captions at all).
 */
export function buildSrt(captions: MotionCaption[]): string {
  let previousEnd = 0;
  const lines: string[] = [];
  captions.forEach((cue, index) => {
    const from = Math.max(previousEnd, Math.max(0, Math.round(cue.from_ms)));
    const to = Math.max(from + 1, Math.round(cue.to_ms));
    previousEnd = to;
    lines.push(String(index + 1), `${formatSrtTime(from)} --> ${formatSrtTime(to)}`, cue.text.trim(), '');
  });
  return lines.join('\n');
}

// ─── Availability ──────────────────────────────────────────────────────────

export interface MotionAvailability {
  ok: boolean;
  missing: string[];
  /** The install commands, ready to hand to a user. */
  hint: string;
}

const FFMPEG_INSTALL: Record<string, string> = {
  darwin: 'brew install ffmpeg',
  linux: 'sudo apt-get install -y ffmpeg',
  win32: 'winget install Gyan.FFmpeg --silent --accept-package-agreements --accept-source-agreements',
};

/**
 * Is this machine able to render? Answering with NAMES and the fix, because
 * "motion render failed" leaves a user with nothing to do, and the two missing
 * pieces have different installations.
 */
let _availabilityOverride: MotionAvailability | null = null;

/** Test seam: answer availability without depending on what this machine has. */
export function setMotionAvailabilityForTests(availability: MotionAvailability | null): void {
  _availabilityOverride = availability;
}

export function motionAvailability(): MotionAvailability {
  if (_availabilityOverride) return _availabilityOverride;
  const missing: string[] = [];
  const hints: string[] = [];
  if (!isBrowserAvailable()) {
    missing.push('chromium (playwright)');
    hints.push('npm install -D playwright && npx playwright install chromium');
  }
  if (!binaryOnPath('ffmpeg')) {
    missing.push('ffmpeg');
    hints.push(FFMPEG_INSTALL[process.platform] ?? FFMPEG_INSTALL.linux);
  }
  return { ok: missing.length === 0, missing, hint: hints.join(' ; ') };
}

// ─── The page session (seam-able so the pipeline is testable without chromium) ─

/** The slice of a playwright page this renderer uses. */
export interface MotionPageLike {
  setContent(html: string, opts?: { waitUntil?: string }): Promise<void>;
  evaluate(script: string | ((arg: unknown) => unknown), arg?: unknown): Promise<unknown>;
  screenshot(opts: { path: string; clip?: { x: number; y: number; width: number; height: number } }): Promise<unknown>;
  close(): Promise<void>;
}

export interface MotionBrowserLike {
  newPage(opts?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number }): Promise<MotionPageLike>;
  close(): Promise<void>;
}

type MotionLauncher = (viewport: { width: number; height: number }) => Promise<MotionBrowserLike>;

let _launcher: MotionLauncher | null = null;

/** Test seam: replace `chromium.launch()` so the pipeline runs without a browser. */
export function setMotionLauncherForTests(launcher: MotionLauncher | null): void {
  _launcher = launcher;
}

async function launchChromium(viewport: { width: number; height: number }): Promise<MotionBrowserLike> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  return browser as unknown as MotionBrowserLike;
}

type FfmpegRunner = (args: string[]) => Promise<{ code: number; stderr: string }>;

let _ffmpeg: FfmpegRunner | null = null;

/** Test seam: replace the real ffmpeg invocation (recording argv, faking files). */
export function setFfmpegRunnerForTests(runner: FfmpegRunner | null): void {
  _ffmpeg = runner;
}

function runFfmpeg(args: string[]): Promise<{ code: number; stderr: string }> {
  if (_ffmpeg) return _ffmpeg(args);
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 4_000) stderr += d.toString('utf-8');
    });
    child.on('error', (err) => resolve({ code: -1, stderr: String(err) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

// ─── The render ────────────────────────────────────────────────────────────

export interface MotionRenderRequest {
  html: string;
  fps?: unknown;
  duration_ms?: unknown;
  width?: unknown;
  height?: unknown;
  aspect_ratio?: unknown;
  format?: MotionFormat;
  crf?: number;
  /** Narration text; synthesized with `speak` (edge-tts/piper) and muxed in. */
  narration?: string;
  voice?: string;
  captions?: MotionCaption[];
  burn_captions?: boolean;
  /** Artifact filename prefix (slugs to a safe name). */
  out_name?: string;
  cwd?: string;
}

export type MotionRenderResult =
  | {
      ok: true;
      file: string;
      srt: string | null;
      frames: number;
      fps: number;
      durationMs: number;
      width: number;
      height: number;
      format: MotionFormat;
      bytes: number;
      seek: string;
      warnings: string[];
    }
  | { ok: false; error: string; hint?: string };

/**
 * Render a seekable HTML animation to a video file.
 *
 * Order matters: the frames are captured first (so a page that cannot be seeked
 * is reported before anything is encoded), the encode lands in the artifact dir
 * only once it succeeded (a failed render leaves no file behind), and narration
 * is muxed onto the finished video by stream copy.
 */
export async function renderMotion(req: MotionRenderRequest): Promise<MotionRenderResult> {
  const availability = motionAvailability();
  if (!availability.ok) {
    return { ok: false, error: `motion: cannot render — missing ${availability.missing.join(', ')}.`, hint: availability.hint };
  }
  const html = String(req.html ?? '');
  if (!html.trim()) return { ok: false, error: 'motion: nothing to render (empty source).' };

  const plan = buildFramePlan({ fps: req.fps, duration_ms: req.duration_ms });
  const { width, height } = resolveFrameSize({ width: req.width, height: req.height, aspect_ratio: req.aspect_ratio });
  const format: MotionFormat = req.format === 'gif' || req.format === 'webm' ? req.format : 'mp4';

  const workDir = mkdtempSync(join(tmpdir(), 'nuvira-motion-'));
  const outDir = artifactsDir('motion', req.cwd);
  const base = req.out_name ? safeArtifactName(req.out_name, '') : safeArtifactName('motion', '');
  const finalName = `${base}.${format}`;
  const outPath = join(outDir, finalName);
  const warnings: string[] = [];
  let seekMode = 'none';

  try {
    const browser = await (_launcher ?? launchChromium)({ width, height });
    let page: MotionPageLike | null = null;
    try {
      page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      // The runner goes in the markup, ahead of the animation's own script: it has
      // to exist before the page tries to schedule its first frame.
      await page.setContent(injectRunner(html), { waitUntil: 'load' });
      await page.evaluate(MOTION_READY_SCRIPT);

      const clip = { x: 0, y: 0, width, height };
      for (let i = 0; i < plan.frames; i += 1) {
        const t = frameTimestampMs(i, plan.fps);
        const how = await page.evaluate(seekScript(t));
        if (typeof how === 'string' && how !== 'none') seekMode = how;
        await page.screenshot({ path: join(workDir, `frame-${String(i + 1).padStart(5, '0')}.png`), clip });
      }
      if (seekMode === 'none') {
        warnings.push(
          'the animation is not seekable (no window.__motion.seek, no requestAnimationFrame loop and no Web Animations), ' +
            'so this render is a still sequence — see the motion skill for the seek contract',
        );
      }
    } finally {
      await page?.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }

    const pattern = join(workDir, 'frame-%05d.png');
    const encoded = await runFfmpeg(buildFfmpegArgs({ fps: plan.fps, pattern, out: outPath, format, crf: req.crf }));
    if (encoded.code !== 0 || !existsSync(outPath)) {
      return { ok: false, error: `motion: ffmpeg failed to encode the frames — ${encoded.stderr.trim().split('\n').slice(-3).join(' ')}` };
    }

    // Captions BEFORE narration, and the order is the whole point: burning them
    // in re-encodes the video from the PNG frames, so an audio track muxed onto
    // the earlier encode would be silently discarded — a narrate-and-burn render
    // came back as a silent video that reported no warning at all. With the burn
    // first, the narration is muxed onto the FINAL file and survives.
    let srtPath: string | null = null;
    if (req.captions && req.captions.length > 0) {
      srtPath = join(outDir, `${base}.srt`);
      writeFileSync(srtPath, buildSrt(req.captions), 'utf-8');
      if (req.burn_captions) {
        const burned = join(workDir, `burned.${format}`);
        const res = await runFfmpeg(buildFfmpegArgs({ fps: plan.fps, pattern, out: burned, format, crf: req.crf, srtPath, burnCaptions: true }));
        if (res.code === 0 && existsSync(burned)) copyFileSync(burned, outPath);
        else warnings.push(`captions were written to ${basename(srtPath)} but could not be burned in (this ffmpeg may lack libass)`);
      }
    }

    // Narration: synthesized with the SAME local engine the `speak` tool uses, and
    // skipped with a stated reason rather than silently dropping the audio.
    if (req.narration && req.narration.trim()) {
      const voiced = await attachNarration({ videoPath: outPath, text: req.narration, voice: req.voice, format, workDir });
      if (!voiced.ok) warnings.push(voiced.reason);
    }

    const bytes = existsSync(outPath) ? statSync(outPath).size : 0;
    return {
      ok: true,
      file: outPath,
      srt: srtPath,
      frames: plan.frames,
      fps: plan.fps,
      durationMs: plan.durationMs,
      width,
      height,
      format,
      bytes,
      seek: seekMode,
      warnings,
    };
  } catch (err) {
    // A crash mid-encode must not leave a file that looks like a render.
    if (existsSync(outPath)) rmSync(outPath, { force: true });
    return { ok: false, error: `motion: render failed — ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** The slice of `speak` this module needs (see `modality/voice.ts`). */
type SpeakFn = (text: string, opts?: { voice?: string }) => Promise<{ ok: boolean; file?: string; error?: string }>;

let _speak: SpeakFn | null = null;

/** Test seam: replace speech synthesis (so the mux path is testable offline). */
export function setSpeakForTests(speak: SpeakFn | null): void {
  _speak = speak;
}

/** Synthesize narration and attach it by stream copy. Never throws. */
async function attachNarration(o: {
  videoPath: string;
  text: string;
  voice?: string;
  format: MotionFormat;
  workDir: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (o.format === 'gif') return { ok: false, reason: 'narration was skipped: a GIF cannot carry an audio track' };
  try {
    const speak: SpeakFn = _speak ?? (await import('./voice.js')).speak;
    const spoken = await speak(o.text, o.voice ? { voice: o.voice } : undefined);
    if (!spoken?.ok || !spoken.file) return { ok: false, reason: `narration was skipped: ${spoken?.error ?? 'speech synthesis unavailable'}` };
    const muxed = join(o.workDir, `narrated.${o.format}`);
    const res = await runFfmpeg(buildMuxArgs({ videoPath: o.videoPath, audioPath: spoken.file, out: muxed }));
    if (res.code !== 0 || !existsSync(muxed)) {
      return { ok: false, reason: `narration was generated (${spoken.file}) but could not be muxed in — ${res.stderr.trim().split('\n').slice(-2).join(' ')}` };
    }
    copyFileSync(muxed, o.videoPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `narration was skipped: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── Render history (what makes a re-edit a re-edit) ───────────────────────

export interface MotionManifest {
  id: string;
  createdAt: number;
  source: string;
  preset: string | null;
  params: Record<string, unknown> | null;
  fps: number;
  durationMs: number;
  width: number;
  height: number;
  format: MotionFormat;
  artifact: string;
  srt: string | null;
  narration: string | null;
  captions: MotionCaption[] | null;
  revisions: number;
}

/** Where a render's source and settings are kept so it can be revised or replayed. */
export function motionHomeDir(cwd?: string): string {
  const override = envBuff('MOTION_HOME');
  const base = override ? override : join(cwd ?? process.cwd(), '.nuvira', 'motion');
  mkdirSync(base, { recursive: true });
  return base;
}

export function motionManifestPath(id: string, cwd?: string): string {
  return join(motionHomeDir(cwd), id, 'manifest.json');
}

export function saveMotionManifest(manifest: MotionManifest, cwd?: string): string {
  const dir = join(motionHomeDir(cwd), manifest.id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'manifest.json');
  writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf-8');
  writeFileSync(join(dir, 'source.html'), manifest.source, 'utf-8');
  return file;
}

export function loadMotionManifest(id: string, cwd?: string): MotionManifest | null {
  const file = motionManifestPath(id, cwd);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as MotionManifest;
  } catch {
    return null;
  }
}

/** Newest first, so `list` reads like the history it is. */
export function listMotionManifests(cwd?: string): MotionManifest[] {
  const home = motionHomeDir(cwd);
  const dirs = readdirSync(home, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const manifests: MotionManifest[] = [];
  for (const id of dirs) {
    const manifest = loadMotionManifest(id, cwd);
    if (manifest) manifests.push(manifest);
  }
  return manifests.sort((a, b) => b.createdAt - a.createdAt);
}

/** A short, filesystem-safe render id (`motion-20261015-ab12cd`). */
export function newMotionId(now = Date.now()): string {
  const stamp = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `motion-${stamp}-${rand}`;
}
