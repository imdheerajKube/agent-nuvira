/**
 * Inference cache — grouped and cleared per WORKSPACE.
 *
 * An answer is a statement about a directory, so the cache is keyed by the
 * directory it was produced in. That makes staleness a PER-PROJECT fact: when a
 * project changes, only its answers are wrong, and the dashboard has to be able
 * to show where each answer came from and drop one project's answers without
 * paying to re-derive another's.
 *
 * These tests cover the listing and the per-workspace clear. The key/scoping
 * invariant itself (the replay-across-projects defect) is covered in
 * tests/cli/chat-cache-key.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getCache } from '../../src/context/cache.js';

describe('InferenceCache — per-workspace listing and clearing', () => {
  const ORIG_MEMORY = process.env.NUVIRA_MEMORY_DIR;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nuvira-cache-ws-'));
    process.env.NUVIRA_MEMORY_DIR = dir;
  });

  afterEach(() => {
    if (ORIG_MEMORY === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = ORIG_MEMORY;
    rmSync(dir, { recursive: true, force: true });
  });

  it('groups answers by the workspace they were produced in', async () => {
    const cache = getCache();
    await cache.set('what is the status of this project', 'answer A', 'gemini-flash', 'gemini', undefined, '/repo/a');
    await cache.set('what is the status of this project', 'answer B', 'gemini-flash', 'gemini', undefined, '/repo/b');
    await cache.set('add a test', 'answer B2', 'gpt-4o', 'openai', undefined, '/repo/b');
    await cache.set('what is 2 + 2', 'four', 'gemini-flash', 'gemini');

    const groups = await cache.listByWorkspace();
    expect(groups).toHaveLength(3);

    const b = groups.find((g) => g.scope === '/repo/b')!;
    expect(b.count).toBe(2);
    expect(b.models.sort()).toEqual(['gemini-flash', 'gpt-4o'].sort());
    expect(b.providers).toEqual(['gemini', 'openai']);

    const a = groups.find((g) => g.scope === '/repo/a')!;
    expect(a.count).toBe(1);

    // The unscoped bucket is a real bucket with a null scope — answers written
    // before scoping existed (and answers for a pure question) live here.
    const none = groups.find((g) => g.scope === null)!;
    expect(none.count).toBe(1);
    expect(none.samples[0].prompt).toContain('2 + 2');
  });

  it('orders workspaces largest first, so the busiest project reads first', async () => {
    const cache = getCache();
    await cache.set('q', 'a', 'm', 'p', undefined, '/small');
    await cache.set('q1', 'a', 'm', 'p', undefined, '/big');
    await cache.set('q2', 'a', 'm', 'p', undefined, '/big');
    await cache.set('q3', 'a', 'm', 'p', undefined, '/big');

    const groups = await cache.listByWorkspace();
    expect(groups[0].scope).toBe('/big');
    expect(groups[0].count).toBe(3);
  });

  it('carries a bounded prompt preview so an entry can be identified', async () => {
    const cache = getCache();
    const long = 'x'.repeat(500);
    await cache.set(long, 'a', 'm', 'p', undefined, '/repo');

    const group = (await cache.listByWorkspace()).find((g) => g.scope === '/repo')!;
    expect(group.samples[0].prompt.length).toBeLessThanOrEqual(80);
    expect(group.samples[0].prompt.length).toBeGreaterThan(0);
  });

  it('clears ONE workspace and leaves the others untouched', async () => {
    const cache = getCache();
    await cache.set('q-keep', 'keep me', 'm', 'p', undefined, '/keep');
    await cache.set('q-drop-1', 'drop me', 'm', 'p', undefined, '/drop');
    await cache.set('q-drop-2', 'also drop', 'm', 'p', undefined, '/drop');

    const removed = await cache.clearWorkspace('/drop');
    expect(removed).toBe(2);

    const groups = await cache.listByWorkspace();
    expect(groups.map((g) => g.scope)).toEqual(['/keep']);
    // The survivor is still SERVED — proving the clear did not gut the cache.
    expect(await cache.get('q-keep', 'm', 'p', '/keep')).toBe('keep me');
    expect(await cache.get('q-drop-1', 'm', 'p', '/drop')).toBeNull();
    expect(await cache.get('q-drop-2', 'm', 'p', '/drop')).toBeNull();
  });

  it('an exact match only — a subdirectory is a different workspace', async () => {
    const cache = getCache();
    await cache.set('q', 'parent', 'm', 'p', undefined, '/repo');
    await cache.set('q', 'child', 'm', 'p', undefined, '/repo/sub');

    expect(await cache.clearWorkspace('/repo')).toBe(1);
    expect(await cache.get('q', 'm', 'p', '/repo/sub')).toBe('child');
  });

  it('clears the no-workspace bucket with a null scope', async () => {
    const cache = getCache();
    await cache.set('q', 'no workspace', 'm', 'p');
    await cache.set('q', 'with workspace', 'm', 'p', undefined, '/repo');

    expect(await cache.clearWorkspace(null)).toBe(1);
    const groups = await cache.listByWorkspace();
    expect(groups.map((g) => g.scope)).toEqual(['/repo']);
  });

  it('reports an empty cache as no workspaces (not an error)', async () => {
    expect(await getCache().listByWorkspace()).toEqual([]);
    expect(existsSync(join(dir, 'cache.json'))).toBe(false);
  });

  it('clearing a workspace that has no answers removes nothing', async () => {
    await getCache().set('q', 'a', 'm', 'p', undefined, '/repo');
    expect(await getCache().clearWorkspace('/somewhere-else')).toBe(0);
  });
});
