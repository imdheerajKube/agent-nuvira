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

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { envBuff } from '../../config/paths.js';
import { isBrowserAvailable } from './browser.js';
import { artifactsDir, binaryOnPath, safeArtifactName } from './shared.js';

// ─── Limits ────────────────────────────────────────────────────────────────

/** What ffmpeg container/codec the render targets. */
export type MotionFormat = 'mp4' | 'gif' | 'webm';

/**
 * Which half of the renderer produced the frames.
 *
 * `html` is this module's own headless-Chromium path (a seekable page).
 * `frames` is THE CALLER'S renderer — any program that emitted an image
 * sequence: Python/PIL, Manim, Blender, a headless Three.js scene, Remotion, a
 * Rust binary, a video-editing export. See {@link collectFrameFiles}.
 */
export type MotionFrameSource = 'html' | 'frames';

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

// ─── Frame-sequence input (ANY renderer, not only a browser page) ───────────
//
// WHY THIS EXISTS. "The animation is code" was true of this module only for the
// code a BROWSER can run: a seekable HTML page. But the same technique is how
// people render motion with Manim, Blender, a headless Three.js scene, Remotion,
// matplotlib — and with a plain Python + PIL renderer, which is exactly how a
// live run on this product produced a 600-frame paper-craft commercial: the
// model wrote render.py, ran it, and then had to shell out to ffmpeg ITSELF.
// Everything the motion layer owns was bypassed: no render id, no history, no
// captions, no narration, no revision, no frame/duration reporting, and a failed
// encode left whatever ffmpeg left behind.
//
// So a frame sequence is now a first-class SOURCE. The caller's program renders
// frames; this module encodes them, reports their real count/size/duration, and
// keeps them in the same history as a browser render. It needs only ffmpeg —
// chromium is not involved, because nothing here has to be seeked.

/** The image types a frame sequence may use (ffmpeg's image2 decodes all four). */
const FRAME_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'] as const;

/** A frame sequence, measured rather than assumed. */
export interface MotionFrameSequence {
  /** Absolute frame paths, in play order. */
  files: string[];
  /** The extension every linked frame gets (ffmpeg picks its decoder by it). */
  ext: string;
  width: number;
  height: number;
  /** How many frames differ in size from the first — reported, never hidden. */
  mismatched: number;
}

/**
 * Order frames the way a person numbers them: `f_2.png` before `f_10.png`.
 *
 * A plain lexicographic sort puts `f_10` before `f_2`, which reverses the video
 * silently — the file still plays, so nothing downstream can catch it.
 */
export function naturalFrameOrder(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

/**
 * A tiny glob: `*` and `?` only, matched against the basename.
 *
 * Deliberately not a dependency. A caller that needs more than this is naming
 * frames in a way they can name for ffmpeg directly.
 */
function matchesGlob(name: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(name);
}

/** True for a path that names an image in a format ffmpeg can decode here. */
function isFrameName(name: string): boolean {
  return FRAME_EXTENSIONS.includes(extname(name).toLowerCase() as (typeof FRAME_EXTENSIONS)[number]);
}

/**
 * A glob over a RELATIVE path, for a pattern that selects across subdirectories.
 *
 * `*` stays inside one path segment and `**` crosses segments, which is what both
 * a glob and a person mean by them. Only used when the pattern actually contains a
 * separator — otherwise the cheaper basename match applies.
 */
function matchesFramePath(rel: string, glob: string): boolean {
  // Built in ONE pass. Chained `.replace()` calls corrupt this: replacing `?`
  // afterwards rewrites the `?` inside the `(?:.*/)?` an earlier call inserted, and
  // replacing `*` rewrites the `*` inside a `.*` — which turned `**/*.png` into a
  // pattern that matched nothing at all.
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` crosses segments and may match none of them, so `**/*.png` still
        // finds frames at the top level as well as in subdirectories.
        if (glob[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'i').test(rel);
}

/** How a frame directory is actually laid out — measured so a render can warn. */
export interface MotionFrameScan {
  /** Frames in play order, after the pattern filter. */
  files: string[];
  /**
   * Distinct numbered basename prefixes (`frame_`, `shot2_`).
   *
   * More than one means the directory holds SEVERAL sequences, and they are about
   * to be concatenated into one video: the render still happens (the caller may
   * have meant it), but it is never silent.
   */
  prefixes: string[];
  /** Distinct lowercase extensions — more than one means mixed formats. */
  extensions: string[];
  /** Frames whose name carries no number, so their order is string order. */
  unnumbered: number;
  /** Numbers absent between the first and last of the dominant prefix. */
  missing: number[];
  /** How many numbers are missing in total (the list above is capped). */
  missingTotal: number;
  /** The prefix those gaps were measured on. */
  dominantPrefix: string | null;
  /** Subdirectories holding frames — the flat scan does not descend into them. */
  nested: { dir: string; frames: number }[];
  /** Files the pattern excluded, when a pattern was given. */
  excludedByPattern: number;
}

/** How deep a recursive frame scan descends (a render tree, not a filesystem walk). */
const FRAME_SCAN_DEPTH = 4;
const MISSING_NUMBERS_LISTED = 8;

/** `frame_0001` → `{ prefix: 'frame_', number: 1 }`; null when there is no number. */
function frameNumber(name: string): { prefix: string; number: number } | null {
  const stem = basename(name, extname(name));
  const match = /^(.*?)(\d+)(\D*)$/.exec(stem);
  if (!match) return null;
  return { prefix: `${match[1]}${match[3]}`, number: Number.parseInt(match[2]!, 10) };
}

/** One directory's entries, dotfiles excluded. Empty on any error (never throws). */
function listDir(dir: string): { name: string; isDir: boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }
}

/**
 * Measure a frame directory BEFORE encoding it.
 *
 * The render path used to take the file list on trust, which is fine for a clean
 * `f_0001.png … f_0600.png` and wrong for everything else: two interleaved
 * sequences concatenate into one video, a numbering gap shortens it, and a nested
 * layout finds nothing at all. Every one of those produces a file that plays, so
 * nothing downstream can catch it — the scan is what turns them into a warning or
 * a refusal at the moment the facts are still available.
 */
export function scanFrameDirectory(dir: string, pattern?: string): MotionFrameScan {
  const wanted = typeof pattern === 'string' && pattern.trim() ? pattern.trim() : undefined;
  const recursing = Boolean(wanted && /[/\\]/.test(wanted));

  /** Absolute path + the path RELATIVE to `dir`, which is what play order sorts on. */
  const found: { abs: string; rel: string }[] = [];
  let excludedByPattern = 0;

  const walk = (base: string, relBase: string, depth: number): void => {
    for (const entry of listDir(base)) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDir) {
        if (recursing && depth < FRAME_SCAN_DEPTH) walk(join(base, entry.name), rel, depth + 1);
        continue;
      }
      if (!isFrameName(entry.name)) continue;
      const matches = recursing
        ? matchesFramePath(rel, wanted!)
        : !wanted || matchesGlob(entry.name, wanted);
      if (matches) found.push({ abs: join(base, entry.name), rel });
      else excludedByPattern += 1;
    }
  };
  walk(dir, '', 0);

  // Sorted on the RELATIVE path, so a recursive scan plays in tree order rather
  // than in whatever order readdir happened to return.
  const sorted = [...found].sort((a, b) => naturalFrameOrder(a.rel, b.rel));
  const files = sorted.map((f) => f.abs);

  // Subdirectories holding frames, for the common case where someone points at a
  // parent directory: without this the only report is "no frames found", which
  // sends them looking in the wrong place.
  const nested: { dir: string; frames: number }[] = [];
  if (!recursing) {
    for (const entry of listDir(dir)) {
      if (!entry.isDir) continue;
      const count = collectFrameFiles(join(dir, entry.name), undefined, true).length;
      if (count > 0) nested.push({ dir: entry.name, frames: count });
    }
  }

  const byPrefix = new Map<string, number[]>();
  let unnumbered = 0;
  const extensions = new Set<string>();
  for (const file of files) {
    extensions.add(extname(file).toLowerCase());
    const parsed = frameNumber(file);
    if (!parsed) {
      unnumbered += 1;
      continue;
    }
    const numbers = byPrefix.get(parsed.prefix) ?? [];
    numbers.push(parsed.number);
    byPrefix.set(parsed.prefix, numbers);
  }

  let dominantPrefix: string | null = null;
  let dominantCount = 0;
  for (const [prefix, numbers] of byPrefix) {
    if (numbers.length > dominantCount) {
      dominantPrefix = prefix;
      dominantCount = numbers.length;
    }
  }

  const missing: number[] = [];
  let missingTotal = 0;
  if (dominantPrefix) {
    const numbers = byPrefix.get(dominantPrefix)!;
    const present = new Set(numbers);
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    // Only a sequence that CLAIMS a dense range is measured: 600 frames numbered
    // 1..600 with one absent is a dropped frame, whereas five frames numbered
    // 100,200,300,400,500 is a naming scheme, not five gaps.
    if (max - min + 1 <= numbers.length * 2) {
      for (let n = min; n <= max; n += 1) {
        if (present.has(n)) continue;
        missingTotal += 1;
        if (missing.length < MISSING_NUMBERS_LISTED) missing.push(n);
      }
    }
  }

  return {
    files,
    prefixes: [...byPrefix.keys()].sort((a, b) => (byPrefix.get(b)!.length - byPrefix.get(a)!.length) || a.localeCompare(b)),
    extensions: [...extensions].sort(),
    unnumbered,
    missing,
    missingTotal,
    dominantPrefix,
    nested: nested.sort((a, b) => b.frames - a.frames),
    excludedByPattern,
  };
}

/**
 * Every image frame in `dir`, in play order.
 *
 * `pattern` is an optional glob — over the basename (`f_*.png`) for a directory
 * that holds more than one sequence, or over a relative path (`**\/f_*.png`) when
 * the frames sit in subdirectories. An empty result is a REFUSAL, not a render of
 * nothing: use {@link frameScanHint} to say where the frames actually are.
 */
export function collectFrameFiles(dir: string, pattern?: string, bypassScan = false): string[] {
  if (bypassScan) {
    // Used by the scan's own nested probe, which needs a plain listing of a
    // subdirectory without re-entering the scan that calls it.
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    return entries
      .filter((name) => !name.startsWith('.'))
      .filter((name) => isFrameName(name))
      .filter((name) => !pattern || matchesGlob(name, pattern))
      .sort(naturalFrameOrder)
      .map((name) => join(dir, name));
  }
  return scanFrameDirectory(dir, pattern).files;
}

/**
 * What the render says when a frame directory came back EMPTY.
 *
 * Names the extensions that were looked for and any subdirectory that holds
 * frames, because "no image frames found" without those two facts is a dead end.
 */
export function frameScanHint(dir: string, pattern?: string): string {
  const scan = scanFrameDirectory(dir, pattern);
  const parts = [
    `no image frames found in ${dir}${pattern ? ` matching '${pattern}'` : ''}.`,
    `Looked for ${FRAME_EXTENSIONS.join(', ')}.`,
  ];
  if (scan.nested.length > 0) {
    const where = scan.nested.slice(0, 4).map((n) => `${n.dir}/ (${n.frames} frames)`).join(', ');
    parts.push(`The frames are one level down: ${where} — point frames_dir there, or pass frames_pattern '**/*.png'.`);
  }
  if (scan.excludedByPattern > 0) {
    parts.push(`${scan.excludedByPattern} image file(s) in it did not match the pattern.`);
  }
  return parts.join(' ');
}

/**
 * What the render must SAY about a scanned directory, before it encodes.
 *
 * Each warning is a specific way the video is about to be wrong while still
 * playing: several sequences concatenated, a numbering gap that shortens it, mixed
 * formats decoded as one, frames in subdirectories silently skipped.
 */
export function frameScanWarnings(scan: MotionFrameScan): string[] {
  const warnings: string[] = [];

  if (scan.prefixes.length > 1) {
    const named = scan.prefixes.slice(0, 4).map((p) => `'${p}'`).join(', ');
    warnings.push(
      `${scan.prefixes.length} different frame sequences are in this directory (${named}) and they were concatenated in that order — ` +
        'if that is not what you meant, pass frames_pattern to pick one',
    );
  }

  if (scan.extensions.length > 1) {
    warnings.push(
      `the frames mix ${scan.extensions.join(' and ')} — every frame is decoded as the first one's format, so a mixed set can fail to decode`, 
    );
  }

  if (scan.missingTotal > 0) {
    const shown = scan.missing.slice(0, MISSING_NUMBERS_LISTED).join(', ');
    warnings.push(
      `${scan.missingTotal} frame number(s) are missing from the '${scan.dominantPrefix}' sequence (${shown}${scan.missingTotal > scan.missing.length ? ', …' : ''}) — ` +
        'the video is shorter than the timeline that produced it',
    );
  }

  if (scan.unnumbered > 0) {
    warnings.push(
      `${scan.unnumbered} frame(s) carry no number in their name, so they are ordered alphabetically rather than by a timeline`,
    );
  }

  if (scan.nested.length > 0) {
    const where = scan.nested.slice(0, 4).map((n) => `${n.dir}/ (${n.frames})`).join(', ');
    warnings.push(
      `frames in subdirectories were IGNORED by this scan: ${where} — pass frames_pattern '**/*.png' to include them`,
    );
  }

  return warnings;
}

/**
 * Pixel size straight from the file header — no image library, no decode.
 *
 * Read because the size is a FACT the render must report and the ffmpeg encode
 * needs consistent dimensions: a sequence that changes size mid-flight produces
 * a file with a broken middle, and the only honest thing to do is say so.
 * Returns null for a format this does not parse (a caller's exotic frame type),
 * and the caller then reports the size as unknown rather than inventing one.
 */
export function imageDimensions(file: string): { width: number; height: number } | null {
  let head: Buffer;
  try {
    head = readFileSync(file).subarray(0, 65_536);
  } catch {
    return null;
  }
  // PNG: 8-byte signature, then IHDR with width/height as big-endian uint32s.
  if (head.length > 24 && head.toString('ascii', 1, 4) === 'PNG') {
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  }
  // GIF: logical screen descriptor, little-endian uint16s.
  if (head.length > 10 && head.toString('ascii', 0, 3) === 'GIF') {
    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
  }
  // JPEG: walk the marker segments to a Start-Of-Frame, which carries the size.
  if (head.length > 4 && head[0] === 0xff && head[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < head.length) {
      if (head[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = head[offset + 1]!;
      // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15 hold the frame size.
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) {
        return { width: head.readUInt16BE(offset + 7), height: head.readUInt16BE(offset + 5) };
      }
      const length = head.readUInt16BE(offset + 2);
      if (length < 2) return null;
      offset += 2 + length;
    }
  }
  return null;
}

/**
 * Measure a frame directory: order, count, size, and how many frames disagree.
 *
 * `null` means there were no frames to measure (the caller refuses).
 */
export function measureFrameSequence(files: string[]): MotionFrameSequence | null {
  if (files.length === 0) return null;
  const first = files[0]!;
  const ext = extname(first).toLowerCase();
  const size = imageDimensions(first);
  let mismatched = 0;
  if (size) {
    for (const file of files.slice(1)) {
      const other = imageDimensions(file);
      if (other && (other.width !== size.width || other.height !== size.height)) mismatched += 1;
    }
  }
  return {
    files,
    ext,
    width: size?.width ?? 0,
    height: size?.height ?? 0,
    mismatched,
  };
}

/**
 * Give the caller's frames ffmpeg's expected names, inside the work dir.
 *
 * A LINK rather than a copy where the filesystem allows it: a 600-frame 720p
 * sequence is hundreds of megabytes, and copying every frame to re-encode it
 * would make this path slower than the browser one for no reason. Symlink, then
 * hard link, then a real copy — the third only on a filesystem (or a Windows
 * setup without the privilege) that refuses the first two.
 */
export function linkFramesInto(files: string[], workDir: string): string {
  const ext = extname(files[0] ?? 'f.png').toLowerCase();
  files.forEach((file, index) => {
    const target = join(workDir, `frame-${String(index + 1).padStart(5, '0')}${ext}`);
    try {
      symlinkSync(file, target);
      return;
    } catch {
      /* fall through: not every filesystem allows a symlink */
    }
    try {
      linkSync(file, target);
      return;
    } catch {
      /* fall through: a different device, or no permission */
    }
    copyFileSync(file, target);
  });
  return join(workDir, `frame-%05d${ext}`);
}

// ─── The caller's renderer, recorded (what makes a frames revision a revision) ──
//
// A frames render cannot be revised from the manifest alone: this module never
// held the animation, only the images. So the caller may RECORD the command that
// produced them, and a later `revise` runs that command again to get FRESH frames
// before encoding. The alternative — re-encoding whatever is in the directory — is
// worse than useless: it returns a byte-identical file and calls it a revision.

/** How many existing files named by the command are recorded. */
const RECIPE_FILE_LIMIT = 24;
/** How many runs of a renderer are kept in the manifest as an audit trail. */
const RECIPE_RUN_LIMIT = 20;

/** One file the renderer command names, with what it looked like when recorded. */
export interface MotionRendererFile {
  path: string;
  /**
   * sha256 of the contents.
   *
   * `null` only ever comes from an older manifest written before every size was
   * hashed; a fresh capture always hashes, because "the dataset changed" is exactly
   * the change worth noticing and a size comparison misses an edit that preserves it.
   */
  sha256: string | null;
  size: number;
}

/** One execution of a recorded renderer, kept as an audit trail. */
export interface MotionRendererRunRecord {
  at: number;
  code: number;
  ms: number;
  /** Whether the command needed a shell (it used pipes/redirects/globs). */
  viaShell: boolean;
  /** Frames in the output directory after the run — proof it wrote something. */
  frames: number;
}

/**
 * How the caller produced a frames render — recorded so a revision can re-run it,
 * and so a revision can REFUSE when re-running it would not be a revision.
 */
export interface MotionRendererRecipe {
  /** The exact command, as the caller gave it. */
  command: string;
  /** The directory it runs in. */
  cwd: string;
  /** Files the command names, fingerprinted. */
  files: MotionRendererFile[];
  capturedAt: number;
  /** Every execution, newest last — so "what has run here" is answerable. */
  runs?: MotionRendererRunRecord[];
  /**
   * What the last run left in the frames directory.
   *
   * Recorded so a run that produced an IDENTICAL frame set cannot pass as a new
   * revision: a revision that changes nothing is the same lie as re-encoding stale
   * frames, just harder to spot.
   */
  output?: { frames: number; bytes: number; newestMtime: number };
}

/**
 * sha256 of a file's contents, streamed in 1 MiB chunks.
 *
 * Chunked rather than `readFileSync` because the old code REFUSED to hash anything
 * over 8 MiB and compared sizes instead — so editing a large CSV (the renderer's
 * actual input) left the fingerprint unchanged, and the tool reported "the renderer
 * did not change" about a file that had.
 */
export function hashFile(file: string): string | null {
  let fd: number;
  try {
    if (!statSync(file).isFile()) return null;
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1 << 20);
    let position = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Record a renderer command: verbatim, plus a fingerprint of every file it names
 * that exists right now.
 *
 * The token scan is deliberately literal — it records what the command POINTS AT,
 * not an interpretation of it. A token that is not a file (a flag, a number, a
 * subcommand) is skipped, so the fingerprint covers the script and its inputs and
 * nothing invented.
 */
export function captureRendererRecipe(command: string, cwd: string): MotionRendererRecipe {
  const files: MotionRendererFile[] = [];
  const seen = new Set<string>();
  const tokens = command
    .split(/\s+/)
    .map((t) => t.replace(/^['"]|['"]$/g, ''))
    .filter((t) => t && !t.startsWith('-'));

  for (const token of tokens) {
    if (files.length >= RECIPE_FILE_LIMIT) break;
    if (/^[\d.=]+$/.test(token)) continue;
    const path = isAbsolute(token) ? token : resolve(cwd, token);
    if (seen.has(path) || !existsSync(path)) continue;
    let size = 0;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue;
    }
    seen.add(path);
    files.push({ path, sha256: hashFile(path), size });
  }

  return { command, cwd, files, capturedAt: Date.now() };
}

/**
 * Split a command into argv — respecting quotes, as a shell would.
 *
 * Only used when the command needs no shell (see {@link parseRendererCommand}), so
 * this is what lets a plain `python render.py --frames 20` run WITHOUT one.
 */
function splitArgv(command: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quote: string | null = null;
  let started = false;
  const push = (): void => {
    if (started) argv.push(current);
    current = '';
    started = false;
  };
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
    started = true;
  }
  push();
  return argv;
}

/** Characters that only MEAN something to a shell: pipes, redirects, chaining, subshells, globs. */
const SHELL_SYNTAX = /[|&;<>()`$\\*?[\]{}~!\n]/;

/**
 * Decide how to run a recorded command, preferring NOT to involve a shell at all.
 *
 * A recorded renderer is code the user already chose to run, but `shell: true` made
 * every stored command a shell program: `$(...)`, backticks, `;` and redirects all
 * became available to a string that only ever needed to be an argv. Splitting first
 * means the common case (`python render.py --frames 20`) cannot be re-interpreted,
 * and a command that genuinely needs a shell is marked so it can be reported.
 */
export function parseRendererCommand(command: string): { argv: string[]; viaShell: boolean } {
  if (SHELL_SYNTAX.test(command)) return { argv: [command], viaShell: true };
  const argv = splitArgv(command);
  if (argv.length === 0) return { argv: [command], viaShell: true };
  return { argv, viaShell: false };
}

/** What a frame directory currently holds — cheap, and enough to spot a no-op run. */
export function frameSetFingerprint(
  dir: string,
  pattern?: string,
): { frames: number; bytes: number; newestMtime: number } {
  const files = collectFrameFiles(dir, pattern);
  let bytes = 0;
  let newestMtime = 0;
  for (const file of files) {
    try {
      const stat = statSync(file);
      bytes += stat.size;
      newestMtime = Math.max(newestMtime, stat.mtimeMs);
    } catch {
      /* a frame that vanished between listing and stat is not fatal here */
    }
  }
  return { frames: files.length, bytes, newestMtime };
}

/**
 * Whether the renderer still is what it was when the render was made.
 *
 * A changed script means the new frames are a DIFFERENT animation, and calling
 * that a revision of the old one is the same lie as re-encoding stale frames — so
 * the difference is reported by name and the caller decides.
 */
export function verifyRendererRecipe(
  recipe: MotionRendererRecipe,
): { ok: true } | { ok: false; changed: string[] } {
  const changed: string[] = [];
  for (const entry of recipe.files) {
    let size: number;
    try {
      const stat = statSync(entry.path);
      if (!stat.isFile()) {
        changed.push(`${entry.path} is no longer a file`);
        continue;
      }
      size = stat.size;
    } catch {
      changed.push(`${entry.path} is gone`);
      continue;
    }
    if (entry.sha256) {
      if (hashFile(entry.path) !== entry.sha256) changed.push(`${entry.path} changed`);
    } else if (size !== entry.size) {
      changed.push(`${entry.path} changed size`);
    }
  }
  return changed.length === 0 ? { ok: true } : { ok: false, changed };
}

/** How long a recorded renderer may run before it is killed. */
export const RENDERER_TIMEOUT = { defaultMs: 600_000, maxMs: 1_800_000 } as const;

export interface MotionRendererRun {
  ok: boolean;
  code: number;
  /** The tail of stdout+stderr — enough to explain a failure, bounded. */
  output: string;
  timedOut: boolean;
  /** Whether a shell was needed for this command. */
  viaShell: boolean;
  ms: number;
}

type RendererRunner = (recipe: MotionRendererRecipe, timeoutMs: number) => Promise<MotionRendererRun>;

let _renderer: RendererRunner | null = null;

/** Test seam: replace the renderer execution (so no test spawns python). */
export function setRendererRunnerForTests(runner: RendererRunner | null): void {
  _renderer = runner;
}

/**
 * Run the recorded command in the directory it was recorded in.
 *
 * This executes the caller's own program, which is the point of a frames
 * revision — and it is why the recipe is only ever RECORDED from an explicit
 * argument, never inferred from a directory listing: the only command that can run
 * later is one a caller deliberately handed over.
 */
export async function runRendererRecipe(
  recipe: MotionRendererRecipe,
  timeoutMs: number = RENDERER_TIMEOUT.defaultMs,
): Promise<MotionRendererRun> {
  if (_renderer) return _renderer(recipe, timeoutMs);
  const budget = Math.min(Math.max(1_000, Math.round(timeoutMs)), RENDERER_TIMEOUT.maxMs);
  const { argv, viaShell } = parseRendererCommand(recipe.command);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: recipe.cwd,
      // No shell for a command that is just an argv: nothing in it can then be
      // re-interpreted as a subshell, a redirect or a chain.
      shell: viaShell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (chunk: Buffer): void => {
      if (output.length < 4_000) output += chunk.toString('utf-8');
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, budget);
    const finish = (code: number, extra?: string): void => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        output: extra ? `${output}${extra}` : output,
        timedOut,
        viaShell,
        ms: Date.now() - startedAt,
      });
    };
    child.on('error', (err) => finish(-1, String(err)));
    child.on('close', (code) => finish(code ?? -1));
  });
}

/** Append a run to the audit trail, newest last and bounded. */
export function recordRendererRun(
  recipe: MotionRendererRecipe,
  run: MotionRendererRun,
  output: { frames: number; bytes: number; newestMtime: number },
): MotionRendererRecipe {
  const record: MotionRendererRunRecord = {
    at: Date.now(),
    code: run.code,
    ms: run.ms,
    viaShell: run.viaShell,
    frames: output.frames,
  };
  return { ...recipe, runs: [...(recipe.runs ?? []), record].slice(-RECIPE_RUN_LIMIT), output };
}

/**
 * What a revision WOULD do, without doing any of it.
 *
 * The single most useful safety affordance here: a frames revision runs a stored
 * command, and the caller deserves to see that command, where it runs, whether it
 * needs a shell and which files it is about to touch — BEFORE it runs.
 */
export function previewRendererRevision(
  recipe: MotionRendererRecipe,
  framesDir: string,
  pattern?: string,
): string[] {
  const { argv, viaShell } = parseRendererCommand(recipe.command);
  const lines = [
    `would run: ${recipe.command}`,
    `in: ${recipe.cwd}`,
    viaShell
      ? 'through a SHELL (the command uses pipes/redirects/globs, so it is interpreted, not just executed)'
      : `as argv: ${argv.map((a) => (a.includes(' ') ? `'${a}'` : a)).join(' ')} (no shell)`,
    `frames: ${framesDir}${pattern ? ` matching '${pattern}'` : ''}`,
  ];
  if (recipe.files.length > 0) {
    lines.push(`tracks ${recipe.files.length} file(s): ${recipe.files.map((f) => f.path).join(', ')}`);
  } else {
    lines.push('tracks no files — the command names none that exist, so a change to its inputs cannot be detected');
  }
  const verify = verifyRendererRecipe(recipe);
  lines.push(verify.ok ? 'its tracked files are unchanged' : `its tracked files CHANGED: ${verify.changed.join('; ')}`);
  if (recipe.runs && recipe.runs.length > 0) {
    const last = recipe.runs[recipe.runs.length - 1]!;
    lines.push(`last ran ${new Date(last.at).toISOString()} (exit ${last.code}, ${last.ms}ms, ${last.frames} frames)`);
  }
  return lines;
}

/** One line naming a recorded renderer, for the history and for a refusal. */
export function describeRendererRecipe(recipe: MotionRendererRecipe): string {
  return `${recipe.command} (in ${recipe.cwd})`;
}

/**
 * What a FRAMES render needs: ffmpeg, and nothing else.
 *
 * Kept separate from {@link motionAvailability} on purpose. The browser report
 * answers "can this machine render a page?", which is the wrong question when
 * the caller brings its own frames — telling someone with 600 PNGs on disk that
 * playwright is missing would refuse a render that is ready to run.
 */
export function framesAvailability(): MotionAvailability {
  if (_framesAvailabilityOverride) return _framesAvailabilityOverride;
  if (ffmpegAvailable()) return { ok: true, missing: [], hint: '' };
  return {
    ok: false,
    missing: ['ffmpeg'],
    hint: FFMPEG_INSTALL[process.platform] ?? FFMPEG_INSTALL.linux,
  };
}

let _framesAvailabilityOverride: MotionAvailability | null = null;

/** Test seam: pin the frames-path availability (no ffmpeg needed to test). */
export function setFramesAvailabilityForTests(availability: MotionAvailability | null): void {
  _framesAvailabilityOverride = availability;
}

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
 * `-start_number 1` because both frame sources number from 1 (`frame-00001.png`
 * from the browser capture, and the links made by {@link linkFramesInto}),
 * `yuv420p` and even dimensions because that is what players actually play, and
 * `+faststart` so an mp4 can be streamed/previewed without a full download.
 *
 * `audioPath` is how a MUSIC or SFX bed is attached: an audio file the caller
already has is muxed at encode time, which is the same argv slot narration uses
 * once it has been synthesized to a file.
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
  if (!ffmpegAvailable()) {
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

/** `binary` is the second argument so a test can prove WHICH ffmpeg a burn used. */
type FfmpegRunner = (args: string[], binary?: string) => Promise<{ code: number; stderr: string }>;

let _ffmpeg: FfmpegRunner | null = null;

/** Test seam: replace the real ffmpeg invocation (recording argv, faking files). */
export function setFfmpegRunnerForTests(runner: FfmpegRunner | null): void {
  _ffmpeg = runner;
}

/**
 * Whether an ffmpeg is reachable at all — PATH, or one of the full kegs.
 *
 * A machine with only `ffmpeg-full` installed has a working renderer, so reporting
 * "missing ffmpeg" there would refuse a render that is ready to run.
 */
function ffmpegAvailable(): boolean {
  return Boolean(envBuff('FFMPEG')) || binaryOnPath('ffmpeg') || FFMPEG_KEGS.some((keg) => existsSync(keg));
}

/**
 * The `ffmpeg-full` kegs, checked before PATH for one capability only: burning
 * captions.
 *
 * MEASURED 2026-10-17 on this machine: Homebrew's `ffmpeg` formula (9.0.2) is
 * built WITHOUT libass, so `subtitles=…` fails with "No such filter", while
 * `ffmpeg-full` (same version, already installed at /opt/homebrew/opt/ffmpeg-full)
 * has it. Telling the user to install ffmpeg-full is the correct advice — and
 * useless to someone who has it and does not know their PATH points elsewhere. So
 * the burn looks for itself.
 */
const FFMPEG_KEGS = ['/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/usr/local/opt/ffmpeg-full/bin/ffmpeg'];

const _subtitlesSupport = new Map<string, boolean>();

let _subtitlesProbe: ((binary: string) => boolean) | null = null;

/** Test seam: decide subtitle support without probing real binaries. */
export function setSubtitlesProbeForTests(probe: ((binary: string) => boolean) | null): void {
  _subtitlesProbe = probe;
  _subtitlesSupport.clear();
}

/** Whether a binary can burn subtitles (it lists the `subtitles` filter). Memoized. */
export function supportsSubtitles(binary: string): boolean {
  if (_subtitlesProbe) return _subtitlesProbe(binary);
  const cached = _subtitlesSupport.get(binary);
  if (cached !== undefined) return cached;
  if (binary !== 'ffmpeg' && !existsSync(binary)) {
    _subtitlesSupport.set(binary, false);
    return false;
  }
  let ok = false;
  try {
    const res = spawnSync(binary, ['-hide_banner', '-filters'], { encoding: 'utf-8' });
    ok = /^ .. (subtitles|ass) +V->V/m.test(`${res.stdout ?? ''}${res.stderr ?? ''}`);
  } catch {
    ok = false;
  }
  _subtitlesSupport.set(binary, ok);
  return ok;
}

/**
 * The ffmpeg to run: the explicit override, then PATH, then a full keg.
 *
 * PATH wins over the kegs so an installed ffmpeg keeps being the one used — a
 * machine with only `ffmpeg-full` still renders instead of reporting ffmpeg missing.
 */
export function ffmpegBinary(): string {
  const override = envBuff('FFMPEG');
  if (override) return override;
  if (binaryOnPath('ffmpeg')) return 'ffmpeg';
  for (const keg of FFMPEG_KEGS) if (existsSync(keg)) return keg;
  return 'ffmpeg';
}

/**
 * An ffmpeg that can burn captions, or null when this machine has none.
 *
 * Null is worth returning rather than falling back: a burn through a build without
 * libass fails after the encode, and the `.srt` is the part that still works.
 */
export function ffmpegWithSubtitles(): string | null {
  const override = envBuff('FFMPEG');
  const candidates = override ? [override] : [...FFMPEG_KEGS, 'ffmpeg'];
  for (const binary of candidates) if (supportsSubtitles(binary)) return binary;
  return null;
}

function runFfmpeg(args: string[], binary?: string): Promise<{ code: number; stderr: string }> {
  if (_ffmpeg) return _ffmpeg(args, binary);
  return new Promise((resolve) => {
    const child = spawn(binary ?? ffmpegBinary(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
  /**
   * A seekable HTML animation. Absent when the caller brings its own frames
   * (`framesDir`) — then this module is the ENCODER, not the renderer.
   */
  html?: string;
  /**
   * A directory of frames rendered by the CALLER's own program (Python/PIL,
   * Manim, Blender, Three.js, Remotion, a video-editing export…). Takes the
   * place of `html`; needs ffmpeg and no browser.
   */
  framesDir?: string;
  /** Glob over the frame basenames (`f_*.png`), when the directory holds more. */
  framesPattern?: string;
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
  /**
   * An existing audio file (music, SFX, a recorded voice-over) muxed onto the
   * video. Combined with `narration` rather than replacing it: a piece can have
   * a bed AND a voice.
   */
  audioPath?: string;
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
      /** Which renderer produced the frames — `external` frames have no seek hook. */
      frameSource: MotionFrameSource;
      /** The caller's renderer actually produced this many frames. */
      frameCount: number;
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
  const framesDir = typeof req.framesDir === 'string' && req.framesDir.trim() ? req.framesDir.trim() : undefined;
  const scan = framesDir ? scanFrameDirectory(framesDir, req.framesPattern) : null;
  const sequence = scan ? measureFrameSequence(scan.files) : null;

  // The FRAMES path needs ffmpeg and nothing else — the caller already rendered.
  const availability = framesDir ? framesAvailability() : motionAvailability();
  if (!availability.ok) {
    return { ok: false, error: `motion: cannot render — missing ${availability.missing.join(', ')}.`, hint: availability.hint };
  }
  if (framesDir && !sequence) {
    return { ok: false, error: `motion: ${frameScanHint(framesDir, req.framesPattern)}` };
  }
  const html = String(req.html ?? '');
  if (!framesDir && !html.trim()) return { ok: false, error: 'motion: nothing to render (empty source).' };

  // A frame sequence states its own length; fps is the caller's, because a
  // directory of PNGs cannot know the rate it was authored for.
  const plan = sequence
    ? (() => {
        const { fps } = buildFramePlan({ fps: req.fps });
        return { fps, frames: sequence.files.length, durationMs: Math.round((sequence.files.length / fps) * 1000) };
      })()
    : buildFramePlan({ fps: req.fps, duration_ms: req.duration_ms });
  const sized = sequence && sequence.width > 0
    ? { width: sequence.width, height: sequence.height }
    : resolveFrameSize({ width: req.width, height: req.height, aspect_ratio: req.aspect_ratio });
  const { width, height } = sized;
  const format: MotionFormat = req.format === 'gif' || req.format === 'webm' ? req.format : 'mp4';

  const workDir = mkdtempSync(join(tmpdir(), 'nuvira-motion-'));
  const outDir = artifactsDir('motion', req.cwd);
  const base = req.out_name ? safeArtifactName(req.out_name, '') : safeArtifactName('motion', '');
  const finalName = `${base}.${format}`;
  const outPath = join(outDir, finalName);
  const warnings: string[] = [];
  // Kept separately from `warnings` because they are the ones that EXPLAIN a failed
  // encode: mixed formats and mismatched sizes are the reasons ffmpeg dies, and an
  // error that hides them sends the caller to debug ffmpeg instead of their frames.
  const scanWarnings: string[] = [];
  let seekMode = 'none';
  let pattern: string;

  // An existing audio file (music, SFX, a voice-over) rides the FIRST encode, and
  // the caption-burn re-encode too — the burn rebuilds the video from the frames,
  // so audio attached only to the first pass would be discarded by it.
  const bed = typeof req.audioPath === 'string' && req.audioPath.trim() ? req.audioPath.trim() : undefined;
  if (bed && !existsSync(bed)) {
    warnings.push(`the audio bed ${bed} does not exist — the render is silent`);
  }
  const audioBed = bed && existsSync(bed) ? bed : undefined;

  try {
    if (sequence) {
      // THE CALLER'S OWN RENDERER. The frames are measured, size-checked and
      // linked under ffmpeg's expected names; nothing is captured and nothing is
      // seeked, because the animation already happened in the caller's program.
      if (sequence.width === 0) {
        warnings.push(`the frame size could not be read from ${basename(sequence.files[0]!)} — report it from the source instead of trusting a default`);
      } else if (sequence.width % 2 !== 0 || sequence.height % 2 !== 0) {
        warnings.push(`${sequence.width}×${sequence.height} has an odd dimension, which H.264's chroma subsampling rejects — the encode may fail`);
      }
      if (sequence.mismatched > 0) {
        warnings.push(`${sequence.mismatched} of ${sequence.files.length} frames differ in size from the first one, and the encoded video will show that`);
      }
      warnings.push(`the frames came from the caller's renderer, so there is no seek hook here to verify — reproducibility is the renderer's contract, not this module's`);
      // What the DIRECTORY is, before what is in it: several interleaved sequences,
      // a numbering gap, mixed formats and skipped subdirectories all encode into a
      // file that plays, so nothing downstream can catch them but this.
      if (scan) {
        scanWarnings.push(...frameScanWarnings(scan));
        warnings.push(...scanWarnings);
      }
      seekMode = 'external';
      pattern = linkFramesInto(sequence.files, workDir);
    } else {
      const times = Array.from({ length: plan.frames }, (_, i) => frameTimestampMs(i, plan.fps));
      seekMode = await captureFramesInto({ html, width, height, times, dir: workDir });
      if (seekMode === 'none') {
        warnings.push(
          'the animation is not seekable (no window.__motion.seek, no requestAnimationFrame loop and no Web Animations), ' +
            'so this render is a still sequence — see the motion skill for the seek contract',
        );
      }
      pattern = join(workDir, 'frame-%05d.png');
    }

    const encoded = await runFfmpeg(
      buildFfmpegArgs({ fps: plan.fps, pattern, out: outPath, format, crf: req.crf, ...(audioBed ? { audioPath: audioBed } : {}) }),
    );
    if (encoded.code !== 0 || !existsSync(outPath)) {
      return {
        ok: false,
        error:
          `motion: ffmpeg failed to encode the frames — ${encoded.stderr.trim().split('\n').slice(-3).join(' ')}` +
          // The likely CAUSE, before the ffmpeg noise the caller cannot act on.
          (scanWarnings.length > 0 ? ` Your frame directory is the likely reason: ${scanWarnings.join(' ')}` : ''),
      };
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
        const burner = ffmpegWithSubtitles();
        if (!burner) {
          // Names the two real fixes. "This ffmpeg may lack libass" left the user to
          // work out which ffmpeg, which build, and what to install.
          warnings.push(
            `captions were written to ${basename(srtPath)} but could NOT be burned in: no ffmpeg on this machine has the libass ` +
              `subtitles filter (macOS: 'brew install ffmpeg-full' — this then uses it automatically; or point NUVIRA_FFMPEG at a build with libass)`, 
          );
        } else {
          const burned = join(workDir, `burned.${format}`);
          const res = await runFfmpeg(
            buildFfmpegArgs({
              fps: plan.fps,
              pattern,
              out: burned,
              format,
              crf: req.crf,
              srtPath,
              burnCaptions: true,
              ...(audioBed ? { audioPath: audioBed } : {}),
            }),
            burner,
          );
          if (res.code === 0 && existsSync(burned)) copyFileSync(burned, outPath);
          else {
            warnings.push(
              `captions were written to ${basename(srtPath)} but the burn failed with ${basename(burner)} — ` +
                `${res.stderr.trim().split('\n').slice(-2).join(' ')}`,
            );
          }
        }
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
      frameSource: sequence ? 'frames' : 'html',
      frameCount: plan.frames,
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

/**
 * Capture the page at each timestamp, numbered from 1, and report its seek mode.
 *
 * One implementation for both callers: a full render asks for every frame, and
 * the contact sheet asks for a dozen — the difference is the TIMES, not the
 * mechanism, so the two can never disagree about what "seekable" means.
 */
async function captureFramesInto(o: {
  html: string;
  width: number;
  height: number;
  times: number[];
  dir: string;
}): Promise<string> {
  const browser = await (_launcher ?? launchChromium)({ width: o.width, height: o.height });
  let seek = 'none';
  let page: MotionPageLike | null = null;
  try {
    page = await browser.newPage({ viewport: { width: o.width, height: o.height }, deviceScaleFactor: 1 });
    // The runner goes in the markup, ahead of the animation's own script: it has
    // to exist before the page tries to schedule its first frame.
    await page.setContent(injectRunner(o.html), { waitUntil: 'load' });
    await page.evaluate(MOTION_READY_SCRIPT);
    const clip = { x: 0, y: 0, width: o.width, height: o.height };
    for (let i = 0; i < o.times.length; i += 1) {
      const how = await page.evaluate(seekScript(o.times[i]!));
      if (typeof how === 'string' && how !== 'none') seek = how;
      await page.screenshot({ path: join(o.dir, `frame-${String(i + 1).padStart(5, '0')}.png`), clip });
    }
  } finally {
    await page?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
  return seek;
}

// ─── Visual self-review — the contact sheet ────────────────────────────────
//
// WHY THIS EXISTS, and why it is the capability and not the encoder.
//
// Writing frames and calling ffmpeg is something any competent agent already
// does — a live run on this product rendered a 600-frame paper-craft bicycle
// commercial from a one-line prompt by writing Python and shelling out to
// ffmpeg. The encoder was never the missing capability.
//
// What that run could NOT do is LOOK at its own output. It produced 600 frames
// and a file, and the only way anyone found out whether the bicycle was upside
// down, the type was clipped or the palette was off was a human opening the MP4.
// The published motion workflow (and the reason it works) is
// render → INSPECT representative frames → critique → revise → render, and the
// inspect step needs eyes.
//
// A model cannot watch an MP4. It CAN look at one image. So the sheet is the
// bridge: N keyframes, evenly spaced across the timeline, tiled into a single
// PNG, returned as an artifact the model can hand to `describe_image` and
// critique before it delivers anything. Twelve frames of a 20-second piece is
// one vision call, and it catches the defects that a frame-count report cannot.

export interface MotionInspectRequest {
  html?: string;
  framesDir?: string;
  framesPattern?: string;
  fps?: unknown;
  duration_ms?: unknown;
  width?: unknown;
  height?: unknown;
  /** Keyframes on the sheet (default 12, max 24). */
  tiles?: unknown;
  /** Pixels per tile (default 480). */
  tile_width?: unknown;
  out_name?: string;
  cwd?: string;
}

export type MotionInspectResult =
  | {
      ok: true;
      file: string;
      /** Frames on the sheet (the bottom-right cell may be empty when the grid is not full). */
      tiles: number;
      cols: number;
      rows: number;
      /** Seconds between neighbouring tiles — how to read the sheet. */
      secondsPerTile: number;
      frameSource: MotionFrameSource;
      seek: string;
      width: number;
      height: number;
      totalFrames: number;
      warnings: string[];
    }
  | { ok: false; error: string; hint?: string };

/**
 * The most readable tiling: at most four columns, and as few empty cells as the
 * count allows (9 tiles are 3×3, not 4×3 with three blanks, because a blank cell
 * reads as a frame that failed to render).
 */
export function gridFor(tiles: number): { cols: number; rows: number } {
  const count = Math.max(1, Math.round(tiles));
  let best = { cols: 1, rows: count, waste: 0 };
  for (let cols = 1; cols <= Math.min(4, count); cols += 1) {
    const rows = Math.ceil(count / cols);
    const waste = cols * rows - count;
    if (waste < best.waste || (waste === best.waste && cols > best.cols)) best = { cols, rows, waste };
  }
  return { cols: best.cols, rows: best.rows };
}

/** Evenly spaced picks, first and last included — the ends matter most. */
export function sampleFrames<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items.slice();
  if (count <= 1) return [items[0]!];
  const picked: T[] = [];
  for (let i = 0; i < count; i += 1) picked.push(items[Math.round((i * (items.length - 1)) / (count - 1))]!);
  return picked;
}

/** The ffmpeg argv for a tiled contact sheet: one PNG, `cols`×`rows` frames. */
export function buildTileArgs(o: {
  pattern: string;
  tileWidth: number;
  cols: number;
  rows: number;
  out: string;
}): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-start_number',
    '1',
    '-i',
    o.pattern,
    // `-2` keeps the aspect and forces an even height, which the PNG encoder and
    // the viewer both prefer to a half-pixel row.
    '-vf',
    `scale=${o.tileWidth}:-2,tile=${o.cols}x${o.rows}`,
    '-frames:v',
    '1',
    o.out,
  ];
}

/**
 * Render a contact sheet of keyframes so the model can SEE what it made.
 *
 * Works for both sources: a seekable HTML page (a dozen seeks instead of the
 * whole timeline, so reviewing is seconds rather than minutes) and a caller's
 * frame sequence (evenly sampled from what is already on disk).
 */
export async function inspectMotion(req: MotionInspectRequest): Promise<MotionInspectResult> {
  const tiles = clampInt(req.tiles, 2, 24, 12);
  const tileWidth = clampInt(req.tile_width, 120, 960, 480);
  const framesDir = typeof req.framesDir === 'string' && req.framesDir.trim() ? req.framesDir.trim() : undefined;
  const scan = framesDir ? scanFrameDirectory(framesDir, req.framesPattern) : null;
  const sequence = scan ? measureFrameSequence(scan.files) : null;

  const availability = framesDir ? framesAvailability() : motionAvailability();
  if (!availability.ok) {
    return { ok: false, error: `motion: cannot inspect — missing ${availability.missing.join(', ')}.`, hint: availability.hint };
  }
  if (framesDir && !sequence) {
    return { ok: false, error: `motion: ${frameScanHint(framesDir, req.framesPattern)}` };
  }
  const html = String(req.html ?? '');
  if (!framesDir && !html.trim()) {
    return { ok: false, error: 'motion: nothing to inspect — pass html (or html_path) or frames_dir.' };
  }

  const workDir = mkdtempSync(join(tmpdir(), 'nuvira-motion-inspect-'));
  const warnings: string[] = [];
  try {
    let pattern: string;
    let seek = 'none';
    let frameSource: MotionFrameSource;
    let tiles0: number;
    let secondsPerTile: number;
    let { width, height } = resolveFrameSize({});

    if (sequence) {
      const picked = sampleFrames(sequence.files, tiles);
      const { fps } = buildFramePlan({ fps: req.fps });
      tiles0 = picked.length;
      frameSource = 'frames';
      seek = 'external';
      width = sequence.width;
      height = sequence.height;
      secondsPerTile = tiles0 > 1 ? sequence.files.length / fps / (tiles0 - 1) : 0;
      pattern = linkFramesInto(picked, workDir);
      warnings.push(`sampled ${picked.length} of ${sequence.files.length} frames from the caller's renderer`);
      // The sheet is the review step, so the directory's problems belong on it too:
      // a contact sheet of a wrongly-ordered sequence should not look fine.
      if (scan) warnings.push(...frameScanWarnings(scan));
    } else {
      const plan = buildFramePlan({ fps: req.fps, duration_ms: req.duration_ms });
      const size = resolveFrameSize({ width: req.width, height: req.height, aspect_ratio: undefined });
      width = size.width;
      height = size.height;
      tiles0 = Math.min(tiles, plan.frames);
      secondsPerTile = tiles0 > 1 ? plan.durationMs / 1000 / (tiles0 - 1) : 0;
      // Sample the TIMELINE, not every frame: reviewing a 20s piece costs a dozen
      // seeks instead of six hundred captures.
      const times = Array.from({ length: tiles0 }, (_, i) => (plan.durationMs * i) / Math.max(1, tiles0 - 1));
      seek = await captureFramesInto({ html, width, height, times, dir: workDir });
      frameSource = 'html';
      pattern = join(workDir, 'frame-%05d.png');
      if (seek === 'none') warnings.push('the animation is not seekable, so these keyframes are of a still sequence');
    }

    const outDir = artifactsDir('motion', req.cwd);
    const base = req.out_name ? safeArtifactName(`${req.out_name}-sheet`, '') : safeArtifactName('motion-sheet', '');
    const out = join(outDir, `${base}.png`);
    const { cols, rows } = gridFor(tiles0);
    const res = await runFfmpeg(buildTileArgs({ pattern, tileWidth, cols, rows, out }));
    if (res.code !== 0 || !existsSync(out)) {
      return {
        ok: false,
        error: `motion: ffmpeg could not build the contact sheet — ${res.stderr.trim().split('\n').slice(-3).join(' ')}`,
      };
    }
    return {
      ok: true,
      file: out,
      tiles: tiles0,
      cols,
      rows,
      secondsPerTile,
      frameSource,
      seek,
      width,
      height,
      totalFrames: sequence ? sequence.files.length : buildFramePlan({ fps: req.fps, duration_ms: req.duration_ms }).frames,
      warnings,
    };
  } catch (err) {
    return { ok: false, error: `motion: inspect failed — ${err instanceof Error ? err.message : String(err)}` };
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
  /** The seekable HTML source — empty for a render encoded from a frame sequence. */
  source: string;
  /**
   * The directory a caller's own renderer wrote its frames to, when it did.
   *
   * Recorded so the history can say where a render CAME FROM, and so a revision
   * has something honest to do: re-run the renderer for fresh frames when one was
   * recorded ({@link MotionManifest.renderer}), and refuse when it was not.
   */
  framesDir?: string;
  /**
   * The command that produced those frames, when the caller recorded one.
   *
   * This is what makes a frames render revisable at all: without it a revision can
   * only re-encode the frames already on disk and call it a new version.
   */
  renderer?: MotionRendererRecipe;
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
  // Only when there IS an html source: a frames render would otherwise leave an
  // empty `source.html` behind, which reads as "the source was empty" rather
  // than "the source was never here".
  if (manifest.source && manifest.source.trim()) writeFileSync(join(dir, 'source.html'), manifest.source, 'utf-8');
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
