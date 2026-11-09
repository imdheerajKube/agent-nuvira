/**
 * Stable identifiers for the steering control plane.
 *
 * A run id reaches a filesystem path, so it is sanitised and hash-suffixed: two
 * ids that sanitise to the same readable prefix can never share a run directory.
 * Guidance ids are readable (`G-…`) because they are shown to the user and used
 * in approval commands.
 */

import { createHash } from 'node:crypto';

/** A readable, collision-resistant guidance id. */
export function newChangeId(now: number = Date.now()): string {
  const stamp = now.toString(36).slice(-6);
  const rand = Math.random().toString(36).slice(2, 7);
  return `G-${stamp}-${rand}`;
}

/** A readable backlog id. */
export function newBacklogId(now: number = Date.now()): string {
  return `B-${now.toString(36).slice(-6)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** FNV-1a over the text — stable, dependency-free content identity. */
export function contentHash(text: string): string {
  let h = 2166136261;
  const value = String(text ?? '');
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${value.length}:${(h >>> 0).toString(16)}`;
}

/**
 * A run id safe for a directory name. The readable part is capped and the hash
 * is over the ORIGINAL id, so `a/b` and `a-b` never collide.
 */
export function runSlug(runId: string): string {
  const raw = String(runId ?? '').trim() || 'run';
  const readable = raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 10);
  return `${readable || 'run'}-${hash}`;
}

/** A short, human-facing plan label. */
export function planLabel(version: number): string {
  return `plan v${version}`;
}
