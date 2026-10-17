/**
 * The Motion page's data — what this workspace has RENDERED, and the bytes to
 * play it back.
 *
 * WHY THIS IS ITS OWN MODULE. The render history already exists (`motion.ts`
 * keeps a manifest per render, source and settings included) and the CLI reads
 * it. The dashboard needs the same facts in a JSON shape, and the one thing that
 * must not be duplicated is the RULE about what may be served: a request names a
 * render ID, the ID is resolved through OUR OWN manifest, and only then is a path
 * touched. A path from the query string would turn this endpoint into an
 * arbitrary-file read.
 *
 * Deliberately read-only: rendering from the dashboard is the agent's job (a
 * chat turn authors the animation). This page exists so a render is DISCOVERABLE
 * — playable, described, and re-openable — instead of being a file in a hidden
 * folder that the person who asked for the video never sees.
 */

import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import {
  listMotionManifests,
  loadMotionManifest,
  motionHomeDir,
  type MotionFormat,
  type MotionManifest,
} from '../tools/modality/motion.js';

/** One render, as the page shows it. */
export interface MotionRenderInfo {
  id: string;
  createdAt: number;
  /**
   * `preset` for a ready-made scene, `html` for an authored page, `frames` when
   * the caller's own renderer produced the frames and motion only encoded them.
   */
  source: 'preset' | 'html' | 'frames';
  preset: string | null;
  /** The title the render was given, when it had one. */
  title: string | null;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  format: MotionFormat;
  bytes: number;
  revisions: number;
  captions: boolean;
  /** Absolute path, shown for a user who wants the file itself. */
  path: string;
  /** Basename, for a compact row. */
  file: string;
}

export interface MotionData {
  ok: true;
  /** Where renders live — so "gone" is diagnosable, not a mystery. */
  home: string;
  renders: MotionRenderInfo[];
}

const MIME_BY_FORMAT: Record<MotionFormat, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  gif: 'image/gif',
};

function sizeOf(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

function titleOf(manifest: MotionManifest): string | null {
  const title = manifest.params?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}

function toInfo(manifest: MotionManifest): MotionRenderInfo {
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    source: manifest.preset ? 'preset' : manifest.framesDir ? 'frames' : 'html',
    preset: manifest.preset,
    title: titleOf(manifest),
    durationMs: manifest.durationMs,
    fps: manifest.fps,
    width: manifest.width,
    height: manifest.height,
    format: manifest.format,
    bytes: sizeOf(manifest.artifact),
    revisions: manifest.revisions,
    captions: Boolean(manifest.srt),
    path: manifest.artifact,
    file: basename(manifest.artifact || ''),
  };
}

/** Every render in the project the dashboard is serving, newest first. */
export function motionRenders(cwd?: string): MotionData {
  let renders: MotionRenderInfo[] = [];
  try {
    renders = listMotionManifests(cwd).map(toInfo);
  } catch {
    // An unreadable motion folder is an EMPTY list rather than a 500: the page's
    // empty state is the useful answer ("nothing here yet — here is how").
    renders = [];
  }
  return { ok: true, home: motionHomeDir(cwd), renders };
}

/**
 * The bytes for one render, resolved through the manifest store.
 *
 * `null` for an unknown id, a missing artifact, or a path that is not a file —
 * the caller answers 404 rather than reading something else.
 */
export function motionRenderFile(id: string, cwd?: string): { path: string; mime: string } | null {
  if (!id) return null;
  const manifest = loadMotionManifest(id, cwd);
  if (!manifest || !manifest.artifact) return null;
  try {
    if (!existsSync(manifest.artifact) || !statSync(manifest.artifact).isFile()) return null;
  } catch {
    return null;
  }
  return { path: manifest.artifact, mime: MIME_BY_FORMAT[manifest.format] ?? 'application/octet-stream' };
}
