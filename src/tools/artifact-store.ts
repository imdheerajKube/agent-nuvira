/**
 * I3 — Artifact store (`src/tools/artifact-store.ts`).
 *
 * Persists tool artifacts per session under the memory dir so the dashboard
 * (I4) can browse them:
 *
 *   ~/.nuvira/memory/artifacts/<sessionId>/artifacts.json   — the session index
 *
 * Honors NUVIRA_MEMORY_DIR (same as the ledger/quota/bandit reads). Writes are
 * best-effort — a failed artifact write must never break the tool loop that
 * produced it. Session ids are sanitized (no path traversal); a sanitized id
 * collision is accepted (worst case: two sessions share a folder).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import {envBuff, resolveNuviraHome} from '../config/paths';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ARTIFACT_PREVIEW_MAX_CHARS, readArtifactPreview } from './artifact-append.js';
import type { ToolArtifact } from './artifact-types.js';

/** Session ids must be filesystem-safe (no traversal, no separators). */
const SESSION_ID_RE = /^[a-zA-Z0-9._-]+$/;
const UNSAFE_ID = 'unsafe';

/** The default artifacts root — `<memory>/artifacts`. */
export function defaultArtifactsRoot(): string {
  const memory = envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
  return join(memory, 'artifacts');
}

/** Sanitize a session id for use as a directory name. */
export function sanitizeSessionId(sessionId: string): string {
  // Explicitly reject '.' / '..' — they satisfy the character regex but would
  // traverse out of the artifacts root (same guard skills-hub uses).
  if (sessionId === '.' || sessionId === '..') return UNSAFE_ID;
  if (SESSION_ID_RE.test(sessionId)) return sessionId;
  // Fall back to a hash of the raw id — stable, filesystem-safe.
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) | 0;
  }
  return `${UNSAFE_ID}-${Math.abs(hash).toString(36)}`;
}

export class ArtifactStore {
  private root: string;

  /** @param rootDir Override the artifacts root (tests pass a temp dir). */
  constructor(rootDir?: string) {
    this.root = rootDir ?? defaultArtifactsRoot();
  }

  /** Absolute path of the artifacts root (tests assert the layout). */
  get rootPath(): string {
    return this.root;
  }

  private indexPath(sessionId: string): string {
    return join(this.root, sanitizeSessionId(sessionId), 'artifacts.json');
  }

  /**
   * Append an artifact to a session (read-merge-write, newest first).
   * Auto-fills a missing preview for file artifacts. Best-effort, never throws.
   */
  append(sessionId: string, artifact: ToolArtifact): void {
    try {
      const path = this.indexPath(sessionId);
      mkdirSync(join(path, '..'), { recursive: true });
      const entries = this.read(sessionId);
      const withPreview: ToolArtifact =
        artifact.preview !== undefined || (artifact.kind !== 'file' && artifact.kind !== 'log')
          ? artifact
          : { ...artifact, preview: readArtifactPreview(artifact.path, ARTIFACT_PREVIEW_MAX_CHARS) };
      writeFileSync(path, JSON.stringify({ version: 1, sessionId, artifacts: [withPreview, ...entries] }, null, 2), 'utf-8');
    } catch {
      /* best-effort — never break the producer over artifact persistence */
    }
  }

  /** All artifacts for a session, newest first. Never throws. */
  read(sessionId: string): ToolArtifact[] {
    try {
      const path = this.indexPath(sessionId);
      if (!existsSync(path)) return [];
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { artifacts?: ToolArtifact[] };
      return Array.isArray(parsed.artifacts) ? parsed.artifacts : [];
    } catch {
      return [];
    }
  }

  /** Session summaries (id, artifact count, most recent) for the dashboard. */
  listSessions(): Array<{ sessionId: string; count: number; latestAt: number }> {
    try {
      if (!existsSync(this.root)) return [];
      const sessions: Array<{ sessionId: string; count: number; latestAt: number }> = [];
      for (const dir of readdirSync(this.root)) {
        const entries = this.read(dir);
        if (entries.length === 0) continue;
        sessions.push({
          sessionId: dir,
          count: entries.length,
          latestAt: Math.max(...entries.map((a) => a.createdAt || 0)),
        });
      }
      return sessions.sort((a, b) => b.latestAt - a.latestAt);
    } catch {
      return [];
    }
  }
}
