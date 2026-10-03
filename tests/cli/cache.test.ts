/**
 * `nuvira cache` — per-workspace visibility and clearing.
 *
 * Answers are scoped to the folder they are about, so this command has to make
 * the folder visible (otherwise a stale reply is unattributable) and clear ONE
 * folder on request. The clear is the dangerous half: `cache clear <workspace>`
 * must never take another project's answers with it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { CacheCommand } from '../../src/cli/cache.js';
import { getCache } from '../../src/context/cache.js';

/** Run `nuvira cache …` through the real commander tree. */
async function runCache(args: string[]): Promise<void> {
  const program = new Command();
  program.addCommand(new CacheCommand().create());
  await program.parseAsync(['node', 'test', 'cache', ...args]);
}

describe('nuvira cache', () => {
  const ORIG_MEMORY = process.env.NUVIRA_MEMORY_DIR;
  let dir: string;
  let out: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nuvira-cache-cli-'));
    process.env.NUVIRA_MEMORY_DIR = dir;
    out = [];
    // The command prints through console.log (structure) and logger (status).
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out.push(a.map((x) => String(x)).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      out.push(a.map((x) => String(x)).join(' '));
    });
    await getCache().clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIG_MEMORY === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = ORIG_MEMORY;
    rmSync(dir, { recursive: true, force: true });
  });

  it('stats names each workspace and its entry count', async () => {
    const cache = getCache();
    await cache.set('status of this project', 'a', 'm', 'gemini', undefined, '/repo/one');
    await cache.set('add a test', 'b', 'm', 'gemini', undefined, '/repo/one');
    await cache.set('what is 2 + 2', 'c', 'm', 'gemini');

    await runCache(['stats']);
    const printed = out.join('\n');
    expect(printed).toContain('By workspace:');
    expect(printed).toContain('/repo/one: 2 entries');
    // Answers with no workspace are their own bucket, labelled, not hidden.
    expect(printed).toContain('(no workspace attached): 1 entry');
  });

  it('clear <workspace> removes only that project and resolves the path', async () => {
    const cache = getCache();
    const target = resolve(dir, 'proj');
    await cache.set('q-one', 'keep', 'm', 'p', undefined, '/elsewhere');
    await cache.set('q-two', 'drop', 'm', 'p', undefined, target);

    await runCache(['clear', target]);

    expect(out.join('\n')).toContain(`Cleared 1 cached answer(s) for ${target}`);
    // The other project is untouched — and still served.
    expect(await cache.get('q-one', 'm', 'p', '/elsewhere')).toBe('keep');
    expect(await cache.get('q-two', 'm', 'p', target)).toBeNull();
  });

  it('clear --unscoped removes only the no-workspace answers', async () => {
    const cache = getCache();
    await cache.set('q-one', 'keep', 'm', 'p', undefined, '/repo');
    await cache.set('q-two', 'drop', 'm', 'p');

    await runCache(['clear', '--unscoped']);

    expect(out.join('\n')).toContain('Cleared 1 cached answer(s) with no workspace attached');
    expect(await cache.get('q-one', 'm', 'p', '/repo')).toBe('keep');
    expect(await cache.get('q-two', 'm', 'p')).toBeNull();
  });

  it('clear with no argument still clears everything (unchanged behaviour)', async () => {
    const cache = getCache();
    await cache.set('q-one', 'a', 'm', 'p', undefined, '/repo');
    await cache.set('q-two', 'b', 'm', 'p');

    await runCache(['clear']);

    expect(await cache.listByWorkspace()).toEqual([]);
  });
});
