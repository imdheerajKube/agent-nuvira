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
  type MotionCaption,
  type MotionFormat,
  type MotionManifest,
  type MotionRenderResult,
  loadMotionManifest,
  listMotionManifests,
  motionAvailability,
  newMotionId,
  renderMotion,
  resolveFrameSize,
  saveMotionManifest,
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
  action?: 'render' | 'revise' | 'list' | 'presets';
  html?: string;
  html_path?: string;
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
        `- ${m.id} · ${m.preset ?? 'custom html'} · ${(m.durationMs / 1000).toFixed(1)}s ${m.width}x${m.height} ${m.format}` +
        `${m.revisions > 0 ? ` · ${m.revisions} revision${m.revisions === 1 ? '' : 's'}` : ''} · ${m.artifact}`,
    );
  return `motion_render: ${manifests.length} render(s), newest first:\n${rows.join('\n')}\nRevise one with action:'revise', source_id:'<id>'.`;
}

function reportSuccess(result: Extract<MotionRenderResult, { ok: true }>, preset: MotionPreset | null): string {
  const seek =
    result.seek === 'hook'
      ? 'seek hook'
      : result.seek === 'waapi'
        ? 'Web Animations'
        : result.seek === 'raf'
          ? 'requestAnimationFrame step'
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

  // ─── Settings: a revision inherits from the render it revises ─────────────
  let base: MotionManifest | null = null;
  if (action === 'revise') {
    if (!args.source_id) {
      return { text: `Error: motion_render: action:'revise' needs source_id. ${listRenders(cwd)}` };
    }
    base = loadMotionManifest(args.source_id, cwd);
    if (!base) {
      return { text: `Error: motion_render: no render with id '${args.source_id}' in this workspace. ${listRenders(cwd)}` };
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

  if (!source) {
    return {
      text:
        'Error: motion_render: nothing to render. Pass html (a self-contained animation), html_path (a file), ' +
        'or preset + data (see action:\'presets\'). ' +
        SEEK_CONTRACT,
    };
  }

  const availability = motionAvailability();
  if (!availability.ok) {
    return {
      text: `Error: motion_render: cannot render — missing ${availability.missing.join(', ')}. Install: ${availability.hint}`,
    };
  }

  const result = await renderMotion({
    html: source,
    fps: plan.fps,
    duration_ms: plan.durationMs,
    width: size.width,
    height: size.height,
    format,
    crf: args.crf,
    narration: args.narration,
    voice: args.voice,
    captions: args.captions,
    burn_captions: args.burn_captions,
    out_name: args.out_name ?? preset ?? 'motion',
    cwd,
  });

  if (!result.ok) {
    return { text: `Error: ${result.error}${result.hint ? ` Install: ${result.hint}` : ''}` };
  }

  const manifest: MotionManifest = {
    id: base?.id ?? newMotionId(),
    createdAt: Date.now(),
    source,
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
      `\nRender id: ${manifest.id} (revise it with action:'revise', source_id:'${manifest.id}').`,
    media: {
      path: result.file,
      mime: MIME_BY_FORMAT[result.format],
      title: `motion: ${preset ?? args.out_name ?? 'animation'} (${plan.frames} frames)`,
    },
    ...(result.srt ? { sidecar: { path: result.srt, mime: 'application/x-subrip', title: 'captions (.srt)' } } : {}),
  };
}
