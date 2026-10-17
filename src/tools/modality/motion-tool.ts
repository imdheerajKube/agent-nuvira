/**
 * The `motion_render` tool's behaviour, kept out of the registry so it can be
 * called (and tested) directly — the same split `browser.ts` uses.
 *
 * Three things this layer owns, none of which belong in the renderer:
 *
 *   - SOURCE RESOLUTION: raw HTML, an HTML file, or a preset plus the caller's
 *     data. A data-driven preset with no usable data is refused with the shapes
 *     that WOULD work, rather than rendered as an empty chart.
 *   - HISTORY: every render keeps its source and settings, so `revise` re-renders
 *     the stored source instead of re-inventing it (that is the difference
 *     between a re-edit and a second opinion).
 *   - HONEST REPORTING: frames, duration, size, the seek mechanism that was found
 *     and every warning — a render that could not be seeked or could not take its
 *     narration says so instead of returning a path and nothing else.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { ToolContext } from '../registry.js';
import {
  MOTION_LIMITS,
  RENDERER_TIMEOUT,
  type MotionCaption,
  type MotionFormat,
  type MotionManifest,
  type MotionRenderResult,
  type MotionRendererRecipe,
  captureRendererRecipe,
  frameSetFingerprint,
  framesAvailability,
  inspectMotion,
  loadMotionManifest,
  listMotionManifests,
  motionAvailability,
  newMotionId,
  previewRendererRevision,
  recordRendererRun,
  renderMotion,
  resolveFrameSize,
  runRendererRecipe,
  saveMotionManifest,
  scanFrameDirectory,
  verifyRendererRecipe,
  buildFramePlan,
} from './motion.js';
import {
  MOTION_PRESETS,
  isMotionPreset,
  parseMotionData,
  presetHtml,
  presetNeedsData,
  type MotionPreset,
} from './motion-presets.js';

export interface MotionToolArgs {
  action?: 'render' | 'revise' | 'list' | 'presets' | 'inspect';
  html?: string;
  html_path?: string;
  /** Frames rendered by the CALLER's own program — see motion.ts. */
  frames_dir?: string;
  frames_pattern?: string;
  /** An existing audio file (music, SFX, voice-over) muxed onto the video. */
  audio_path?: string;
  /**
   * The command that produced `frames_dir` (e.g. `python render.py`).
   *
   * Recorded with the render, and re-run by a later `revise` so a revision gets
   * FRESH frames instead of re-encoding the ones already on disk.
   */
  renderer_command?: string;
  /** Directory the renderer command runs in (defaults to the turn's cwd). */
  renderer_cwd?: string;
  /** How long the renderer may run before it is killed. */
  renderer_timeout_ms?: number;
  /** Revise even though the recorded renderer changed since the render was made. */
  allow_renderer_change?: boolean;
  /**
   * action:'revise' on a frames render — show what WOULD run and change nothing.
   *
   * A revision executes a stored command, so "tell me first" has to be an option.
   */
  preview?: boolean;
  /** `inspect` options. */
  tiles?: number;
  tile_width?: number;
  preset?: string;
  params?: Record<string, unknown>;
  data?: unknown;
  data_path?: string;
  source_id?: string;
  fps?: number;
  duration_ms?: number;
  width?: number;
  height?: number;
  aspect_ratio?: string;
  format?: MotionFormat;
  crf?: number;
  narration?: string;
  voice?: string;
  captions?: MotionCaption[];
  burn_captions?: boolean;
  out_name?: string;
  title?: string;
}

export interface MotionToolResult {
  text: string;
  /** The rendered video, for the caller to register as an artifact + deliver. */
  media?: { path: string; mime: string; title: string };
  /** Generated captions, when there were any. */
  sidecar?: { path: string; mime: string; title: string };
}

const MIME_BY_FORMAT: Record<MotionFormat, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  gif: 'image/gif',
};

const formatBytes = (bytes: number): string =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;

/** Resolve a caller-supplied path against the turn's working directory. */
function resolvePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(join(cwd, path));
}

const SEEK_CONTRACT = `The animation must be SEEKABLE: define window.__motion = { seek(tMs) } (or animate with CSS/Web Animations, or a requestAnimationFrame loop — both are stepped for you). Never drive motion from Date.now() or a counter: only a pure function of t renders reproducibly.`;

function presetsListing(): string {
  const lines = MOTION_PRESETS.map((name) => {
    const need = presetNeedsData(name) ? 'needs data' : 'no data needed';
    return `- ${name} (${need})`;
  });
  return (
    `motion_render: ${MOTION_PRESETS.length} presets — ready-made scenes with a verify-ready seek implementation:\n` +
    `${lines.join('\n')}\n` +
    'Pass preset + params {title, subtitle, kicker, accent, background, unit, decimals} and, for the data-driven ' +
    'ones, data (JSON array of numbers, [{label,value}], {series:[…]}) or CSV — inline or via data_path.'
  );
}

function listRenders(cwd: string): string {
  const manifests = listMotionManifests(cwd);
  if (manifests.length === 0) return 'motion_render: no renders yet in this workspace.';
  const rows = manifests
    .slice(0, 20)
    .map(
      (m) =>
        `- ${m.id} · ${sourceOf(m)} · ${(m.durationMs / 1000).toFixed(1)}s ${m.width}x${m.height} ${m.format}` +
        `${m.revisions > 0 ? ` · ${m.revisions} revision${m.revisions === 1 ? '' : 's'}` : ''}` +
        // Whether a revision can actually re-run anything is the one fact a caller
        // needs before deciding to revise, so it is in the list rather than only in
        // the refusal they hit afterwards.
        `${m.framesDir ? (m.renderer ? ` · renderer recorded: ${m.renderer.command}` : ' · NO renderer recorded (revise cannot refresh it)') : ''}` +
        ` · ${m.artifact}`,
    );
  return `motion_render: ${manifests.length} render(s), newest first:\n${rows.join('\n')}\nRevise one with action:'revise', source_id:'<id>'.`;
}

/** Where a render's animation came from, in the caller's terms. */
function sourceOf(m: MotionManifest): string {
  if (m.preset) return m.preset;
  return m.framesDir ? 'your renderer (frames)' : 'custom html';
}

/**
 * Prepare a revision of a render that came from the caller's own renderer.
 *
 * There are three honest outcomes here and no fourth:
 *
 *   - a recorded renderer runs again and yields FRESH frames (a real revision);
 *   - no renderer was recorded, so the refusal says exactly how to record one
 *     rather than quietly re-encoding the frames already on disk — which would
 *     return the same video under a new id and call it a new version;
 *   - the renderer CHANGED since the render was made, in which case its output is a
 *     different animation and the caller has to say that is what they want.
 */
async function prepareFramesRevision(
  base: MotionManifest,
  args: MotionToolArgs,
  cwd: string,
): Promise<
  | { ok: true; framesDir: string; recipe: MotionRendererRecipe; note: string }
  | { ok: false; text: string }
> {
  const framesDir = base.framesDir!;
  const rendererCwd = args.renderer_cwd ? resolvePath(args.renderer_cwd, cwd) : base.renderer?.cwd ?? cwd;

  // PREVIEW changes nothing: no command runs, no file is read beyond the checks the
  // report needs. This is the answer to "a revision executes a stored command".
  if (args.preview) {
    const recipe = base.renderer ?? (args.renderer_command ? captureRendererRecipe(args.renderer_command.trim(), rendererCwd) : null);
    if (!recipe) {
      return {
        ok: false,
        text:
          `Error: motion_render: '${base.id}' has no recorded renderer, so a revision of it would refuse (re-encoding ${framesDir} would return the same video under a new id). ` +
          `Pass renderer_command to record one, with preview:true to see it first.`,
      };
    }
    return {
      ok: false,
      text:
        `motion_render: PREVIEW — nothing was run and nothing changed.\n` +
        previewRendererRevision(recipe, framesDir, args.frames_pattern).map((l) => `  ${l}`).join('\n') +
        `\nDrop preview to run it (or pass allow_renderer_change:true if a tracked file is expected to differ).`,
    };
  }

  // A command supplied NOW is captured and used: refreshing a render whose command
  // was never recorded is the common first case, and requiring the caller to go back
  // and re-render before they can revise would make the fix they need unreachable.
  const supplied = typeof args.renderer_command === 'string' && args.renderer_command.trim();
  const recipe = supplied ? captureRendererRecipe(args.renderer_command!.trim(), rendererCwd) : base.renderer;

  if (!recipe) {
    const framesNow = scanFrameDirectory(framesDir, args.frames_pattern).files.length;
    const state = framesNow > 0 ? `${framesNow} frames are in ${framesDir}` : `${framesDir} has no frames in it now`;
    return {
      ok: false,
      text:
        `Error: motion_render: '${base.id}' was encoded from a frame sequence, and NO renderer command was recorded for it, ` +
        `so there is nothing here to run again. (${state}.) Re-encoding them would return the same video under a new id ` +
        `and call it a revision, which is the exact thing this refuses to fake. Do one of: ` +
        `(1) refresh it — re-run your renderer and call motion_render with frames_dir; ` +
        `(2) make it revisable — motion_render action:'revise', source_id:'${base.id}', renderer_command:'python render.py'`,
    };
  }

  if (base.renderer) {
    const check = verifyRendererRecipe(base.renderer);
    if (!check.ok && !args.allow_renderer_change) {
      return {
        ok: false,
        text:
          `Error: motion_render: the renderer changed since '${base.id}' was made (${check.changed.slice(0, 4).join('; ')}) — ` +
          'running it now would produce a DIFFERENT animation, not a revision of this one. ' +
          'Pass allow_renderer_change:true to accept that, or render fresh with frames_dir.',
      };
    }
  }

  const before = frameSetFingerprint(framesDir, args.frames_pattern);
  const run = await runRendererRecipe(recipe, args.renderer_timeout_ms ?? RENDERER_TIMEOUT.defaultMs);
  if (run.timedOut) {
    return {
      ok: false,
      text: `Error: motion_render: the renderer did not finish within ${args.renderer_timeout_ms ?? RENDERER_TIMEOUT.defaultMs}ms and was killed: ${recipe.command}. Nothing was encoded and the previous render is untouched.`,
    };
  }
  if (!run.ok) {
    const tail = run.output.trim().split('\n').slice(-4).join(' ');
    return {
      ok: false,
      text:
        `Error: motion_render: your renderer exited with code ${run.code}: ${recipe.command}. ` +
        `Nothing was encoded and the previous render is untouched.${tail ? ` Output: ${tail}` : ''}`,
    };
  }

  const refreshed = scanFrameDirectory(framesDir, args.frames_pattern);
  if (refreshed.files.length === 0) {
    return {
      ok: false,
      text:
        `Error: motion_render: ${recipe.command} finished, but there are still no frames in ${framesDir} — ` +
        'check the directory your renderer writes to.',
    };
  }

  const after = frameSetFingerprint(framesDir, args.frames_pattern);
  // Re-fingerprint AFTER the run: a file the command creates (an output, a cache, a
  // manifest) is then tracked from this run on, which is how "a file the command
  // creates later isn't tracked" stops being true.
  const historical = recipe.runs ?? [];
  const refreshedRecipe = recordRendererRun(
    { ...recipe, ...captureRendererRecipe(recipe.command, recipe.cwd), runs: historical, capturedAt: recipe.capturedAt },
    run,
    after,
  );

  const unchanged =
    before.frames === after.frames && before.bytes === after.bytes && before.newestMtime === after.newestMtime;
  const replaced = supplied && base.renderer && base.renderer.command !== recipe.command;
  return {
    ok: true,
    framesDir,
    recipe: refreshedRecipe,
    note:
      `Re-ran your renderer for fresh frames: ${recipe.command} (${after.frames} frames now in ${framesDir})` +
      (replaced ? ` — this REPLACES the recorded renderer '${base.renderer!.command}'` : '') +
      (base.renderer && !supplied && args.allow_renderer_change ? ' — run despite the renderer having changed' : '') +
      (run.viaShell ? ' — run through a SHELL (the command uses pipes/redirects/globs)' : ' — run as argv, with no shell') +
      // Honesty about a no-op: the command ran, but produced the same bytes, so this
      // revision is a re-encode and should be described as one.
      (unchanged
        ? `\nNote: the frame set is IDENTICAL to before this run (${after.frames} frames, ${after.bytes} bytes), so this revision re-encodes the same animation — your renderer did not change its output.`
        : ''),
  };
}

/**
 * `action: 'inspect'` — render a contact sheet of keyframes so the model can SEE
 * the animation it is about to deliver.
 *
 * This is the step a competent agent cannot fake by writing code: an MP4 is
 * opaque to a text model, and frame counts prove nothing about whether the type
 * is clipped, the palette is off or the subject is upside down. One tiled PNG is
 * something a vision model can actually look at, and the skill asks for it BEFORE
 * the render that gets delivered.
 */
async function runInspect(args: MotionToolArgs, cwd: string): Promise<MotionToolResult> {
  const framesDirArg =
    typeof args.frames_dir === 'string' && args.frames_dir.trim() ? args.frames_dir.trim() : undefined;
  if (framesDirArg && (args.html || args.html_path)) {
    return { text: 'Error: motion_render: pass either frames_dir or html/html_path to inspect — not both.' };
  }

  let html: string | undefined;
  if (args.html && args.html.trim()) {
    html = args.html;
  } else if (args.html_path) {
    const path = resolvePath(args.html_path, cwd);
    if (!existsSync(path)) return { text: `Error: motion_render: no such html file '${args.html_path}'.` };
    html = readFileSync(path, 'utf-8');
  } else if (args.preset) {
    return {
      text:
        'Error: motion_render: action:\'inspect\' reviews an ANIMATION source (html/html_path or frames_dir). ' +
        'A preset is already a known-good scene — render it, then inspect the render if you want its frames.',
    };
  }

  const framesDir = framesDirArg ? resolvePath(framesDirArg, cwd) : undefined;
  if (framesDir && !existsSync(framesDir)) {
    return { text: `Error: motion_render: no such frames directory '${framesDirArg}'.` };
  }

  const result = await inspectMotion({
    ...(framesDir ? { framesDir, ...(args.frames_pattern ? { framesPattern: args.frames_pattern } : {}) } : { html: html ?? '' }),
    fps: args.fps,
    duration_ms: args.duration_ms,
    width: args.width,
    height: args.height,
    tiles: args.tiles,
    tile_width: args.tile_width,
    out_name: args.out_name ?? 'motion',
    cwd,
  });

  if (!result.ok) return { text: `Error: ${result.error}${result.hint ? ` Install: ${result.hint}` : ''}` };

  // Never instruct a step this machine cannot take: with no vision backend the
  // sheet is for the person, and saying so beats a failed describe_image call.
  let howToLook: string;
  try {
    const { isVisionAvailable } = await import('./vision.js');
    howToLook = (await isVisionAvailable())
      ? 'LOOK at it before delivering: describe_image on this file, and fix what it shows (clipped type, off-brand colour, weak hierarchy, a subject that is missing or upside down). A frame count is not a review.'
      : 'No vision backend is available on this machine (Ollama with llava, or NUVIRA_GEMINI_API_KEY), so YOU cannot read this sheet — say that plainly and show the path to the user instead of claiming to have reviewed it.';
  } catch {
    howToLook = 'Open this sheet and review it before delivering: a frame count is not a review.';
  }

  const gap = result.secondsPerTile >= 1 ? `${result.secondsPerTile.toFixed(1)}s apart` : `${(result.secondsPerTile * 1000).toFixed(0)}ms apart`;
  return {
    text:
      `motion_render: contact sheet written to ${result.file}\n` +
      `— ${result.tiles} keyframes in a ${result.cols}×${result.rows} grid, ${gap}, reading left to right then top to bottom, ` +
      `from a ${result.width}x${result.height} ${result.frameSource === 'frames' ? "frame sequence rendered by your own program" : 'animation'} (${result.totalFrames} frames total).\n` +
      howToLook +
      (result.warnings.length > 0 ? `\nNote: ${result.warnings.join(' ')}` : ''),
    media: { path: result.file, mime: 'image/png', title: `motion: ${result.tiles} keyframes` },
  };
}

function reportSuccess(result: Extract<MotionRenderResult, { ok: true }>, preset: MotionPreset | null): string {
  const seek =
    result.seek === 'hook'
      ? 'seek hook'
      : result.seek === 'waapi'
        ? 'Web Animations'
        : result.seek === 'raf'
          ? 'requestAnimationFrame step'
          : result.seek === 'external'
            ? "the caller's own renderer"
            : 'STATIC (not seekable)';
  return (
    `motion_render: ${result.format} written to ${result.file}` +
    ` — ${result.frames} frames @ ${result.fps}fps, ${(result.durationMs / 1000).toFixed(2)}s, ${result.width}x${result.height}, ${formatBytes(result.bytes)}` +
    ` · ${preset ?? 'custom source'} · ${seek}` +
    (result.srt ? `\nCaptions: ${result.srt}` : '') +
    (result.warnings.length > 0 ? `\nWarning: ${result.warnings.join(' ')}` : '')
  );
}

/**
 * Run one `motion_render` call. Returns text plus, on a successful render, the
 * media the registry should register and deliver.
 */
export async function runMotionTool(args: MotionToolArgs, ctx?: ToolContext): Promise<MotionToolResult> {
  const cwd = ctx?.cwd ?? process.cwd();
  const action = args.action ?? 'render';

  if (action === 'presets') return { text: presetsListing() };
  if (action === 'list') return { text: listRenders(cwd) };
  if (action === 'inspect') return runInspect(args, cwd);

  // ─── Settings: a revision inherits from the render it revises ─────────────
  let base: MotionManifest | null = null;
  let revisedFrames: { framesDir: string; recipe: MotionRendererRecipe; note: string } | null = null;
  if (action === 'revise') {
    if (!args.source_id) {
      return { text: `Error: motion_render: action:'revise' needs source_id. ${listRenders(cwd)}` };
    }
    base = loadMotionManifest(args.source_id, cwd);
    if (!base) {
      return { text: `Error: motion_render: no render with id '${args.source_id}' in this workspace. ${listRenders(cwd)}` };
    }
    // A frames render is revised by RUNNING THE RENDERER THAT MADE IT, when one was
    // recorded — re-encoding the frames already on disk would return the same video
    // under a new id, which is not a revision and must never be reported as one.
    if (base.framesDir) {
      const prepared = await prepareFramesRevision(base, args, cwd);
      if (!prepared.ok) return { text: prepared.text };
      revisedFrames = prepared;
    }
  }

  const format: MotionFormat = args.format === 'gif' || args.format === 'webm' ? args.format : base?.format === 'webm' || base?.format === 'gif' ? base.format : 'mp4';
  const plan = buildFramePlan({
    fps: args.fps ?? base?.fps ?? MOTION_LIMITS.defaultFps,
    duration_ms: args.duration_ms ?? base?.durationMs ?? MOTION_LIMITS.defaultDurationMs,
  });
  const size = resolveFrameSize({
    width: args.width ?? base?.width,
    height: args.height ?? base?.height,
    aspect_ratio: args.aspect_ratio,
  });

  // ─── Source ──────────────────────────────────────────────────────────────
  let source: string | null = null;
  let preset: MotionPreset | null = null;
  let params: Record<string, unknown> | null = null;

  // A FRAME SEQUENCE is a source of its own: the caller's own program already
  // rendered it, and this call is the encoder. Combining it with html/preset
  // would be two animations in one call — refused rather than silently choosing.
  const framesDirArg =
    typeof args.frames_dir === 'string' && args.frames_dir.trim() ? args.frames_dir.trim() : undefined;
  if (framesDirArg && (args.html || args.html_path || args.preset)) {
    return {
      text:
        'Error: motion_render: pass EITHER frames_dir (your renderer produced the frames) OR html/html_path/preset — not both.',
    };
  }
  if (args.renderer_command && !framesDirArg && !base?.framesDir) {
    return {
      text:
        'Error: motion_render: renderer_command records the program that produced frames_dir, so it only applies to a frames render. ' +
        'Pass frames_dir alongside it (or revise a frames render).',
    };
  }
  // A revision of a frames render encodes the SAME directory — the renderer just
  // refreshed its contents.
  const framesDir = revisedFrames
    ? revisedFrames.framesDir
    : framesDirArg
      ? resolvePath(framesDirArg, cwd)
      : undefined;
  if (framesDir && !existsSync(framesDir)) {
    return { text: `Error: motion_render: no such frames directory '${framesDirArg}'.` };
  }

  if (args.html && args.html.trim()) {
    source = args.html;
  } else if (args.html_path) {
    const path = resolvePath(args.html_path, cwd);
    if (!existsSync(path)) return { text: `Error: motion_render: no such html file '${args.html_path}'.` };
    source = readFileSync(path, 'utf-8');
  } else if (args.preset) {
    if (!isMotionPreset(args.preset)) {
      return { text: `Error: motion_render: unknown preset '${args.preset}'. Use one of: ${MOTION_PRESETS.join(', ')}.` };
    }
    preset = args.preset;
    let data = args.data;
    if (data === undefined && args.data_path) {
      const path = resolvePath(args.data_path, cwd);
      if (!existsSync(path)) return { text: `Error: motion_render: no such data file '${args.data_path}'.` };
      data = readFileSync(path, 'utf-8');
    }
    params = {
      title: args.title ?? (args.params?.title as string | undefined),
      ...(args.params ?? {}),
      ...(data !== undefined ? { data } : {}),
    };
    if (presetNeedsData(preset)) {
      const points = parseMotionData(params.data);
      if (points.length === 0) {
        return {
          text:
            `Error: motion_render: preset '${preset}' animates YOUR data, and nothing parseable was passed. ` +
            `Give data as JSON (array of numbers, [{label,value}], {series:[…]}) or CSV with one label/value per row — ` +
            `inline as 'data' or as a file with 'data_path'.`,
        };
      }
    }
    source = presetHtml(preset, params as never, { durationMs: plan.durationMs, width: size.width, height: size.height });
  } else if (base?.preset && isMotionPreset(base.preset)) {
    // A revision of a preset render may come back with only new data/params.
    preset = base.preset;
    let data = args.data;
    if (data === undefined && args.data_path) {
      const path = resolvePath(args.data_path, cwd);
      if (!existsSync(path)) return { text: `Error: motion_render: no such data file '${args.data_path}'.` };
      data = readFileSync(path, 'utf-8');
    }
    params = { ...(base.params ?? {}), ...(args.params ?? {}), ...(data !== undefined ? { data } : {}), ...(args.title ? { title: args.title } : {}) };
    if (presetNeedsData(preset) && parseMotionData(params.data).length === 0) {
      return { text: `Error: motion_render: preset '${preset}' needs data (JSON or CSV) — pass data or data_path.` };
    }
    source = presetHtml(preset, params as never, { durationMs: plan.durationMs, width: size.width, height: size.height });
  } else if (base) {
    source = base.source;
    params = base.params;
  }

  if (!source && !framesDir) {
    return {
      text:
        'Error: motion_render: nothing to render. Pass html (a self-contained animation), html_path (a file), ' +
        'preset + data (see action:\'presets\'), or frames_dir (frames YOUR renderer already wrote — python/PIL, Manim, ' +
        'Blender, Three.js, Remotion…). ' +
        SEEK_CONTRACT,
    };
  }

  // A frames render needs ffmpeg and no browser: the caller already rendered.
  const availability = framesDir ? framesAvailability() : motionAvailability();
  if (!availability.ok) {
    return {
      text: `Error: motion_render: cannot render — missing ${availability.missing.join(', ')}. Install: ${availability.hint}`,
    };
  }

  const result = await renderMotion({
    ...(framesDir
      ? { framesDir, ...(args.frames_pattern ? { framesPattern: args.frames_pattern } : {}) }
      : { html: source ?? '' }),
    fps: plan.fps,
    duration_ms: plan.durationMs,
    width: size.width,
    height: size.height,
    format,
    crf: args.crf,
    narration: args.narration,
    voice: args.voice,
    ...(args.audio_path ? { audioPath: resolvePath(args.audio_path, cwd) } : {}),
    captions: args.captions,
    burn_captions: args.burn_captions,
    out_name: args.out_name ?? preset ?? 'motion',
    cwd,
  });

  if (!result.ok) {
    return { text: `Error: ${result.error}${result.hint ? ` Install: ${result.hint}` : ''}` };
  }

  // Recorded so a later revise can re-run it: supplied now, carried over from the
  // render being revised, or absent (in which case revise says so instead of
  // re-encoding stale frames).
  // The revision's refreshed recipe wins: it carries the refreshed file fingerprints
  // and the new audit entry, and saving the stale one would lose both.
  const recipe =
    revisedFrames?.recipe ??
    (args.renderer_command
      ? captureRendererRecipe(args.renderer_command.trim(), args.renderer_cwd ? resolvePath(args.renderer_cwd, cwd) : cwd)
      : base?.renderer);

  const manifest: MotionManifest = {
    id: base?.id ?? newMotionId(),
    createdAt: Date.now(),
    source: source ?? '',
    ...(framesDir ? { framesDir } : {}),
    ...(framesDir && recipe ? { renderer: recipe } : {}),
    preset,
    params,
    fps: result.fps,
    durationMs: result.durationMs,
    width: result.width,
    height: result.height,
    format: result.format,
    artifact: result.file,
    srt: result.srt,
    narration: args.narration ?? base?.narration ?? null,
    captions: args.captions ?? base?.captions ?? null,
    revisions: base ? base.revisions + 1 : 0,
  };
  saveMotionManifest(manifest, cwd);

  return {
    text:
      reportSuccess(result, preset ?? (base?.preset && isMotionPreset(base.preset) ? base.preset : null)) +
      // What a revision actually DID belongs in the report: a caller who revises a
      // frames render has to know their program was re-run, and with which command.
      (revisedFrames ? `\n${revisedFrames.note}` : '') +
      (framesDir && recipe && !revisedFrames ? `\nRenderer recorded: ${recipe.command} (revise will re-run it for fresh frames).` : '') +
      (framesDir && !recipe && !revisedFrames
        ? '\nNote: no renderer_command was recorded, so a later revise of this render cannot refresh the frames — it will refuse rather than re-encode these.'
        : '') +
      `\nRender id: ${manifest.id} (revise it with action:'revise', source_id:'${manifest.id}').`,
    media: {
      path: result.file,
      mime: MIME_BY_FORMAT[result.format],
      title: `motion: ${preset ?? args.out_name ?? 'animation'} (${result.frameCount} frames)`,
    },
    ...(result.srt ? { sidecar: { path: result.srt, mime: 'application/x-subrip', title: 'captions (.srt)' } } : {}),
  };
}
