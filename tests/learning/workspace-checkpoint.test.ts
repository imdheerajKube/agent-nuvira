/**
 * Workspace checkpoints — snapshot a tree, roll it back.
 *
 * The properties pinned here are the ones a rollback is judged by: the content is
 * the content that was there (not a git ref that may have moved), a file created
 * after the checkpoint is only removed when that is asked for, an ignored
 * directory is never copied, a file too large to copy is REPORTED rather than
 * silently missing at restore time, and two checkpoints of an unchanged tree do
 * not cost two trees.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createWorkspaceCheckpoint,
  deleteCheckpoint,
  formatBytes,
  listCheckpoints,
  pruneAutoCheckpoints,
  pruneCheckpoints,
  readCheckpoint,
  resolveCheckpoint,
  restoreWorkspaceCheckpoint,
} from '../../src/learning/workspace-checkpoint.js';

let storeDir: string;
let project: string;

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), 'ckpt-store-'));
  project = mkdtempSync(join(tmpdir(), 'ckpt-proj-'));
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'app.ts'), 'export const a = 1;\n');
  writeFileSync(join(project, 'README.md'), '# project\n');
});

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const blobsOnDisk = (store: string): string[] => {
  const root = join(store, 'blobs');
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const shard of readdirSync(root)) {
    for (const name of readdirSync(join(root, shard))) out.push(join(shard, name));
  }
  return out;
};

describe('createWorkspaceCheckpoint', () => {
  it('records the tree and restores it after edits, deletions and additions', () => {
    const checkpoint = createWorkspaceCheckpoint(project, { storeDir, label: 'before refactor' });
    expect(checkpoint.totals.files).toBe(2);
    expect(checkpoint.label).toBe('before refactor');

    writeFileSync(join(project, 'src', 'app.ts'), 'export const a = 2; // broken\n');
    unlinkSync(join(project, 'README.md'));
    writeFileSync(join(project, 'src', 'new.ts'), 'export const b = 3;\n');

    const result = restoreWorkspaceCheckpoint(checkpoint.id, { storeDir });
    expect(result.restored).toBe(2);
    expect(readFileSync(join(project, 'src', 'app.ts'), 'utf-8')).toBe('export const a = 1;\n');
    expect(readFileSync(join(project, 'README.md'), 'utf-8')).toBe('# project\n');
    // A file the checkpoint never saw is left alone unless `clean` says otherwise.
    expect(existsSync(join(project, 'src', 'new.ts'))).toBe(true);
    expect(result.leftBehind).toEqual(['src/new.ts']);
  });

  it('removes files created after the checkpoint only with clean', () => {
    const checkpoint = createWorkspaceCheckpoint(project, { storeDir });
    writeFileSync(join(project, 'src', 'new.ts'), 'junk\n');

    const result = restoreWorkspaceCheckpoint(checkpoint.id, { storeDir, clean: true });
    expect(result.removed).toEqual(['src/new.ts']);
    expect(existsSync(join(project, 'src', 'new.ts'))).toBe(false);
    // And the recorded files are still there: clean is not a wipe.
    expect(readFileSync(join(project, 'README.md'), 'utf-8')).toBe('# project\n');
  });

  it('never copies VCS or dependency directories', () => {
    mkdirSync(join(project, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(project, 'node_modules', 'pkg', 'index.js'), 'noise\n');
    mkdirSync(join(project, '.git'), { recursive: true });
    writeFileSync(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    const checkpoint = createWorkspaceCheckpoint(project, { storeDir });
    const paths = checkpoint.entries.map((e) => e.path);
    expect(paths).toContain('src/app.ts');
    expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.git'))).toBe(false);
  });

  it('reports a file over the size cap instead of dropping it silently', () => {
    writeFileSync(join(project, 'big.bin'), Buffer.alloc(4096, 7));
    const checkpoint = createWorkspaceCheckpoint(project, { storeDir, maxFileBytes: 1024 });

    expect(checkpoint.entries.map((e) => e.path)).not.toContain('big.bin');
    expect(checkpoint.skipped).toEqual([
      expect.objectContaining({ path: 'big.bin', reason: expect.stringContaining('per-file cap') }),
    ]);
    // The file is untouched by a restore, which is the honest outcome.
    restoreWorkspaceCheckpoint(checkpoint.id, { storeDir });
    expect(readFileSync(join(project, 'big.bin')).length).toBe(4096);
  });

  it('records a symlink as a link and never follows it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ckpt-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'outside the tree\n');
    symlinkSync(outside, join(project, 'link-out'));

    const checkpoint = createWorkspaceCheckpoint(project, { storeDir });
    const link = checkpoint.entries.find((e) => e.path === 'link-out');
    expect(link?.kind).toBe('symlink');
    expect(link?.linkTarget).toBe(outside);
    expect(checkpoint.entries.some((e) => e.path.startsWith('link-out/'))).toBe(false);

    rmSync(join(project, 'link-out'));
    restoreWorkspaceCheckpoint(checkpoint.id, { storeDir });
    expect(lstatSync(join(project, 'link-out')).isSymbolicLink()).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });

  it('stores an unchanged file once across two checkpoints', () => {
    createWorkspaceCheckpoint(project, { storeDir });
    writeFileSync(join(project, 'src', 'app.ts'), 'export const a = 99;\n');
    createWorkspaceCheckpoint(project, { storeDir });

    // Three distinct contents: README, app v1, app v2 — not four.
    expect(blobsOnDisk(storeDir)).toHaveLength(3);
  });

  it('reuses the hash of a file nothing has changed, instead of re-reading it', () => {
    // A pre-write checkpoint used to read and sha256 every byte of the tree on each
    // turn's first write (measured 1.4s for this repo's 13,944 files / 268 MB), and
    // almost none of those files had changed. `(size, mtime)` is what `make` trusts
    // to answer the same question.
    const first = createWorkspaceCheckpoint(project, { storeDir });
    const before = readCheckpoint(first.id, { storeDir })!;
    expect(before.entries.every((e) => e.kind === 'symlink' || e.mtimeMs !== undefined)).toBe(true);

    // Rewrite the file with the SAME byte count and restore its mtime: the stat is
    // unchanged, so the recorded hash is reused and the new checkpoint describes the
    // content it can see. This is the documented limit of the reuse, pinned rather
    // than left implicit.
    const file = join(project, 'src', 'app.ts');
    const original = before.entries.find((e) => e.path === 'src/app.ts')!;
    writeFileSync(file, 'export const a = 9;\n');
    utimesSync(file, original.mtimeMs! / 1000, original.mtimeMs! / 1000);
    const sameStat = createWorkspaceCheckpoint(project, { storeDir });
    expect(sameStat.entries.find((e) => e.path === 'src/app.ts')?.sha).toBe(original.sha);

    // A changed mtime is a change: the bytes are read and the new content recorded.
    utimesSync(file, Date.now() / 1000 + 5, Date.now() / 1000 + 5);
    const reread = createWorkspaceCheckpoint(project, { storeDir });
    expect(reread.entries.find((e) => e.path === 'src/app.ts')?.sha).not.toBe(original.sha);
    expect(restoreWorkspaceCheckpoint(reread.id, { storeDir }).restored).toBeGreaterThan(0);
    expect(readFileSync(file, 'utf-8')).toBe('export const a = 9;\n');
  });

  it('can be told to re-read everything (reuseUnchanged: false)', () => {
    const first = createWorkspaceCheckpoint(project, { storeDir });
    const original = readCheckpoint(first.id, { storeDir })!.entries.find((e) => e.path === 'src/app.ts')!;
    // Same trick as above, but this time the caller refuses the shortcut, so the
    // snapshot is proven against the bytes rather than against the stat.
    writeFileSync(join(project, 'src', 'app.ts'), 'export const a = 7;\n');
    utimesSync(join(project, 'src', 'app.ts'), original.mtimeMs! / 1000, original.mtimeMs! / 1000);
    const forced = createWorkspaceCheckpoint(project, { storeDir, reuseUnchanged: false });
    expect(forced.entries.find((e) => e.path === 'src/app.ts')?.sha).not.toBe(original.sha);
  });

  it('re-reads when the blob a reused hash names is gone', () => {
    const first = createWorkspaceCheckpoint(project, { storeDir });
    const entry = readCheckpoint(first.id, { storeDir })!.entries.find((e) => e.path === 'src/app.ts')!;
    // A pruned/hand-deleted store must cost a re-hash, never a dangling reference.
    rmSync(join(storeDir, 'blobs', entry.sha!.slice(0, 2), entry.sha!), { force: true });
    const second = createWorkspaceCheckpoint(project, { storeDir });
    expect(second.entries.find((e) => e.path === 'src/app.ts')?.sha).toBe(entry.sha);
    expect(existsSync(join(storeDir, 'blobs', entry.sha!.slice(0, 2), entry.sha!))).toBe(true);
    expect(() => restoreWorkspaceCheckpoint(second.id, { storeDir })).not.toThrow();
  });

  it('preserves the permission bits it recorded', () => {
    const script = join(project, 'run.sh');
    writeFileSync(script, '#!/bin/sh\necho hi\n');
    chmodSync(script, 0o755);

    const checkpoint = createWorkspaceCheckpoint(project, { storeDir });
    chmodSync(script, 0o644);
    restoreWorkspaceCheckpoint(checkpoint.id, { storeDir });
    expect(lstatSync(script).mode & 0o777).toBe(0o755);
    expect(checkpoint.entries.find((e) => e.path === 'run.sh')?.mode).toBeTruthy();
  });
});

describe('restoreWorkspaceCheckpoint safety', () => {
  it('dry-run changes nothing', () => {
    const checkpoint = createWorkspaceCheckpoint(project, { storeDir });
    writeFileSync(join(project, 'src', 'app.ts'), 'changed\n');

    const result = restoreWorkspaceCheckpoint(checkpoint.id, { storeDir, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.restored).toBe(2);
    expect(readFileSync(join(project, 'src', 'app.ts'), 'utf-8')).toBe('changed\n');
  });

  it('refuses a different directory unless forced', () => {
    const checkpoint = createWorkspaceCheckpoint(project, { storeDir });
    const other = mkdtempSync(join(tmpdir(), 'ckpt-other-'));
    try {
      expect(() => restoreWorkspaceCheckpoint(checkpoint.id, { storeDir, cwd: other })).toThrow(/--force/);
      const forced = restoreWorkspaceCheckpoint(checkpoint.id, { storeDir, cwd: other, force: true });
      expect(forced.restored).toBe(2);
      expect(readFileSync(join(other, 'README.md'), 'utf-8')).toBe('# project\n');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses an incomplete store instead of half-restoring', () => {
    const checkpoint = createWorkspaceCheckpoint(project, { storeDir });
    writeFileSync(join(project, 'README.md'), 'changed\n');
    // Simulate a pruned/corrupted blob.
    for (const blob of blobsOnDisk(storeDir)) rmSync(join(storeDir, 'blobs', blob), { force: true });

    expect(() => restoreWorkspaceCheckpoint(checkpoint.id, { storeDir })).toThrow(/incomplete/);
    // Nothing was written: the refusal happens before the tree is touched.
    expect(readFileSync(join(project, 'README.md'), 'utf-8')).toBe('changed\n');
  });
});

describe('the checkpoint store', () => {
  it('lists newest first and narrows to one project', () => {
    const first = createWorkspaceCheckpoint(project, { storeDir });
    const other = mkdtempSync(join(tmpdir(), 'ckpt-other-'));
    try {
      writeFileSync(join(other, 'x.txt'), 'x\n');
      createWorkspaceCheckpoint(other, { storeDir });
      const forProject = listCheckpoints({ storeDir, cwd: project });
      expect(forProject.map((c) => c.id)).toEqual([first.id]);
      expect(listCheckpoints({ storeDir })).toHaveLength(2);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('takes its ordering slot from the store directory, not by reading every manifest', () => {
    // The id is `${createdAt.toString(36)}-${uuid}`, so "later than everything here"
    // is in the NAME. It used to be answered by `listCheckpoints()`, which parses
    // every manifest in the store — each one a checkpoint's whole file list.
    // MEASURED on this repo (2026-10-30): 1,120 checkpoints, 4,582,545 entries,
    // ~966 MB of JSON, **2.8 s per create** — and growing with every run, which is
    // what made the suite time out in a different test each time.
    createWorkspaceCheckpoint(project, { storeDir });

    // An existing checkpoint whose manifest cannot be parsed still occupies its
    // slot: its timestamp is in its name, so nothing has to read the file.
    const futureTs = Date.now() + 60_000;
    const futureId = `${futureTs.toString(36)}-abcdef`;
    mkdirSync(join(storeDir, futureId), { recursive: true });
    writeFileSync(join(storeDir, futureId, 'manifest.json'), '{ not json');

    const next = createWorkspaceCheckpoint(project, { storeDir });
    expect(next.createdAt).toBeGreaterThan(futureTs);
  });

  it('ignores a directory that is not a checkpoint (an interrupted create)', () => {
    // No manifest ⇒ the name reserves nothing, so the timestamp stays the clock's.
    mkdirSync(join(storeDir, `${(Date.now() + 60_000).toString(36)}-orphan`), { recursive: true });
    const now = Date.now();
    const checkpoint = createWorkspaceCheckpoint(project, { storeDir });
    expect(checkpoint.createdAt).toBeLessThanOrEqual(Date.now() + 1);
    expect(checkpoint.createdAt).toBeGreaterThanOrEqual(now);
  });

  it('resolves latest and unique prefixes, and nothing else', () => {
    const first = createWorkspaceCheckpoint(project, { storeDir });
    const latest = resolveCheckpoint('latest', { storeDir });
    expect(latest?.id).toBe(first.id);
    expect(resolveCheckpoint(first.id.slice(0, 6), { storeDir })?.id).toBe(first.id);
    expect(resolveCheckpoint('nope-not-a-prefix', { storeDir })).toBeNull();
  });

  it('keeps blobs another checkpoint still needs when one is deleted', () => {
    const first = createWorkspaceCheckpoint(project, { storeDir });
    writeFileSync(join(project, 'src', 'app.ts'), 'export const a = 2;\n');
    const second = createWorkspaceCheckpoint(project, { storeDir });
    expect(blobsOnDisk(storeDir)).toHaveLength(3);

    deleteCheckpoint(first.id, { storeDir });
    // README and app v2 survive; app v1 (only the deleted checkpoint named it) goes.
    expect(blobsOnDisk(storeDir)).toHaveLength(2);
    expect(() => restoreWorkspaceCheckpoint(second.id, { storeDir })).not.toThrow();
    expect(readFileSync(join(project, 'src', 'app.ts'), 'utf-8')).toBe('export const a = 2;\n');
  });

  it('bounds its OWN automatic checkpoints and never touches a user one', () => {
    // The loop takes one of these per turn that writes and nothing removed them:
    // measured 1,120 of them / ~966 MB of manifests after a few weeks of use. A
    // user's `checkpoint create` is a different promise — they named it, so it is
    // never a pruning candidate.
    const auto: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      auto.push(createWorkspaceCheckpoint(project, { storeDir, origin: 'loop' }).id);
    }
    const user = createWorkspaceCheckpoint(project, { storeDir, label: 'before release' }).id;

    const removed = pruneAutoCheckpoints({ storeDir, keep: 2 });
    expect(removed.sort()).toEqual([auto[0], auto[1], auto[2]].sort());
    expect(listCheckpoints({ storeDir }).map((c) => c.id)).toEqual([user, auto[4], auto[3]]);
    expect(readCheckpoint(user, { storeDir })?.label).toBe('before release');
    // The kept ones are still restorable, so the bound removed only old points.
    expect(() => restoreWorkspaceCheckpoint(auto[4], { storeDir })).not.toThrow();
  });

  it('leaves an unmarked store alone (nothing written before the marker)', () => {
    createWorkspaceCheckpoint(project, { storeDir });
    expect(pruneAutoCheckpoints({ storeDir, keep: 0 })).toEqual([]);
    expect(listCheckpoints({ storeDir })).toHaveLength(1);
  });

  it('records who asked for it — the pre-write net is not a user checkpoint', () => {
    const loop = createWorkspaceCheckpoint(project, { storeDir, origin: 'loop' });
    const explicit = createWorkspaceCheckpoint(project, { storeDir, origin: 'cli' });
    expect(readCheckpoint(loop.id, { storeDir })?.origin).toBe('loop');
    expect(readCheckpoint(explicit.id, { storeDir })?.origin).toBe('cli');
  });

  it('prunes to the newest N and deletes the manifests', () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      writeFileSync(join(project, 'README.md'), `# project ${i}\n`);
      ids.push(createWorkspaceCheckpoint(project, { storeDir }).id);
    }
    const deleted = pruneCheckpoints({ storeDir, keep: 2 });
    expect(deleted).toHaveLength(2);
    expect(listCheckpoints({ storeDir }).map((c) => c.id)).toEqual([ids[3], ids[2]]);
    expect(readCheckpoint(ids[0], { storeDir })).toBeNull();
  });
});

describe('formatBytes', () => {
  it('is a size a person can read at a glance', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
