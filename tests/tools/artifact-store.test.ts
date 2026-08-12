/**
 * I3 — Artifact store tests.
 *
 * Covers: append/read round-trip (newest first), auto preview for file
 * artifacts, session listing for the dashboard, session-id sanitization
 * (no traversal), and graceful reads on missing roots.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ArtifactStore, sanitizeSessionId } from '../../src/tools/artifact-store.js';
import type { ToolArtifact } from '../../src/tools/artifact-types.js';

function makeStore(): { store: ArtifactStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'buff-artifacts-'));
  return { store: new ArtifactStore(root), root };
}

function artifact(overrides: Partial<ToolArtifact> = {}): ToolArtifact {
  return {
    id: 'a-1',
    kind: 'file',
    title: 'report',
    path: '/tmp/report.md',
    source: 'tool',
    createdAt: 1000,
    ...overrides,
  };
}

describe('ArtifactStore — persistence', () => {
  it('appends and reads back artifacts (newest first), surviving a new instance', () => {
    const { store, root } = makeStore();
    try {
      store.append('s1', artifact({ id: 'first', createdAt: 1000 }));
      store.append('s1', artifact({ id: 'second', createdAt: 2000 }));

      const reloaded = new ArtifactStore(root);
      const entries = reloaded.read('s1');
      expect(entries.map((a) => a.id)).toEqual(['second', 'first']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('auto-fills a preview for file/log artifacts from the file on disk', () => {
    const { store, root } = makeStore();
    try {
      const file = join(root, 'payload.txt');
      writeFileSync(file, 'hello artifact');
      store.append('s1', artifact({ path: file, preview: undefined }));
      const [entry] = store.read('s1');
      expect(entry.preview).toBe('hello artifact');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('listSessions reports count + recency, newest session first', () => {
    const { store, root } = makeStore();
    try {
      store.append('older', artifact({ id: 'a', createdAt: 1000 }));
      store.append('newer', artifact({ id: 'b', createdAt: 5000 }));
      store.append('newer', artifact({ id: 'c', createdAt: 6000 }));

      const sessions = store.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].sessionId).toBe('newer');
      expect(sessions[0].count).toBe(2);
      expect(sessions[1].sessionId).toBe('older');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns [] for unknown sessions and empty roots (never throws)', () => {
    const { store, root } = makeStore();
    try {
      expect(store.read('missing')).toEqual([]);
      expect(store.listSessions()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('session id sanitization', () => {
  it('keeps safe ids and hashes unsafe ones (no traversal)', () => {
    expect(sanitizeSessionId('chat-123-abc')).toBe('chat-123-abc');
    expect(sanitizeSessionId('a.b_c-1')).toBe('a.b_c-1');
    const unsafe = sanitizeSessionId('../../etc');
    expect(unsafe).not.toContain('/');
    expect(unsafe).not.toContain('..');
    expect(sanitizeSessionId('../../etc')).toBe(unsafe); // deterministic
  });

  it('rejects bare "." and ".." (the character regex alone would pass them — traversal)', () => {
    expect(sanitizeSessionId('.')).toBe('unsafe');
    expect(sanitizeSessionId('..')).toBe('unsafe');
  });
});
