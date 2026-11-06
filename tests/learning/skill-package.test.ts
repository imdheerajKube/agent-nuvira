/**
 * P1 — skill package transport.
 *
 * These tests exist because the install used to write ONE file: a multi-file
 * skill installed "successfully" and then failed on first use, when its body
 * told the model to read a sibling that was never copied. The properties that
 * matter are: the whole tree arrives, the fingerprint covers the tree (not just
 * SKILL.md), caps refuse an oversized package BEFORE touching the destination,
 * and a hostile symlink cannot smuggle a file from outside the skill.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SkillPackageError,
  copySkillPackage,
  listSkillFiles,
  rewriteSkillRootPlaceholders,
  skillPackageInfo,
  skillPackageSize,
  treeHashOf,
} from '../../src/learning/skill-package.js';

const dirs: string[] = [];

function tmp(prefix = 'nuvira-pkg-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A realistic multi-file skill: entry point + references + data + script. */
function makePackage(root: string, markdown = '# Demo\n\nRead `references/guide.md` first.\n'): string {
  const dir = join(root, 'demo-skill');
  mkdirSync(join(dir, 'references'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: demo-skill\ndescription: Use when testing packages.\n---\n\n${markdown}`, 'utf-8');
  writeFileSync(join(dir, 'references', 'guide.md'), '# Guide\nstep one\n', 'utf-8');
  writeFileSync(join(dir, 'data', 'rows.csv'), 'a,b\n1,2\n', 'utf-8');
  writeFileSync(join(dir, 'scripts', 'search.py'), 'print("hi")\n', 'utf-8');
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('listSkillFiles — the walk', () => {
  it('returns every file as a sorted relative POSIX path', () => {
    const root = tmp();
    const dir = makePackage(root);
    expect(listSkillFiles(dir)).toEqual([
      'SKILL.md',
      'data/rows.csv',
      'references/guide.md',
      'scripts/search.py',
    ]);
  });

  it('skips .git and node_modules — a skill is not a repository', () => {
    const root = tmp();
    const dir = makePackage(root);
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'config'), 'x', 'utf-8');
    mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'x', 'utf-8');
    const files = listSkillFiles(dir);
    expect(files).not.toContain('.git/config');
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
  });

  it('refuses a symlink that points outside the skill directory', () => {
    const root = tmp();
    const dir = makePackage(root);
    const outside = join(root, 'secret.txt');
    writeFileSync(outside, 'not part of the skill', 'utf-8');
    symlinkSync(outside, join(dir, 'leak.txt'));
    expect(listSkillFiles(dir)).not.toContain('leak.txt');
  });

  it('returns [] for a missing directory instead of throwing', () => {
    expect(listSkillFiles(join(tmp(), 'nope'))).toEqual([]);
  });
});

describe('treeHashOf — the fingerprint covers the whole package', () => {
  it('is deterministic across copies', () => {
    const root = tmp();
    const dir = makePackage(root);
    const copy = join(root, 'copy');
    copySkillPackage(dir, copy);
    expect(treeHashOf(copy)).toBe(treeHashOf(dir));
  });

  it('changes when a SIBLING changes (the bug a SKILL.md-only hash missed)', () => {
    const root = tmp();
    const dir = makePackage(root);
    const before = treeHashOf(dir);
    writeFileSync(join(dir, 'scripts', 'search.py'), 'print("changed")\n', 'utf-8');
    expect(treeHashOf(dir)).not.toBe(before);
  });

  it('is independent of file mtimes', () => {
    const root = tmp();
    const dir = makePackage(root);
    const first = treeHashOf(dir);
    // Re-write the same bytes: mtime moves, content does not.
    writeFileSync(join(dir, 'SKILL.md'), readFileSync(join(dir, 'SKILL.md')));
    expect(treeHashOf(dir)).toBe(first);
  });
});

describe('copySkillPackage — the install transport', () => {
  it('copies every file, so references/scripts/data survive the install', () => {
    const root = tmp();
    const dir = makePackage(root);
    const dest = join(root, 'installed');
    const result = copySkillPackage(dir, dest);
    expect(result.skillPath).toBe(join(dest, 'SKILL.md'));
    expect(result.files).toContain('references/guide.md');
    expect(result.files).toContain('scripts/search.py');
    expect(readFileSync(join(dest, 'references', 'guide.md'), 'utf-8')).toContain('step one');
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.treeHash).toBe(treeHashOf(dir));
  });

  it('replaces a previous install instead of merging into it', () => {
    const root = tmp();
    const dir = makePackage(root);
    const dest = join(root, 'installed');
    copySkillPackage(dir, dest);
    writeFileSync(join(dest, 'stale.txt'), 'old', 'utf-8');
    copySkillPackage(dir, dest);
    expect(listSkillFiles(dest)).not.toContain('stale.txt');
  });

  it('refuses a directory with no SKILL.md', () => {
    const root = tmp();
    const empty = join(root, 'empty');
    mkdirSync(empty, { recursive: true });
    expect(() => copySkillPackage(empty, join(root, 'dest'))).toThrow(SkillPackageError);
  });

  it('refuses an oversized package BEFORE touching the destination', () => {
    const root = tmp();
    const dir = makePackage(root);
    const dest = join(root, 'installed');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'SKILL.md'), 'existing install', 'utf-8');

    expect(() => copySkillPackage(dir, dest, { maxFiles: 2, maxBytes: 10_000_000 })).toThrow(/files/);
    // The old install is still there — a refused install is a no-op.
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf-8')).toBe('existing install');

    expect(() => copySkillPackage(dir, dest, { maxFiles: 100, maxBytes: 10 })).toThrow(/bytes/);
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf-8')).toBe('existing install');
  });
});

describe('skillPackageSize — the cheap probe', () => {
  it('counts files and bytes without hashing', () => {
    const root = tmp();
    const dir = makePackage(root);
    const size = skillPackageSize(dir);
    expect(size.fileCount).toBe(4);
    expect(size.bytes).toBeGreaterThan(0);
  });
});

describe('rewriteSkillRootPlaceholders', () => {
  it('substitutes both spellings of the skill root', () => {
    const out = rewriteSkillRootPlaceholders(
      'run ${CLAUDE_PLUGIN_ROOT}/scripts/search.py or ${SKILL_ROOT}/data/rows.csv',
      '/installed/demo-skill',
    );
    expect(out).toBe('run /installed/demo-skill/scripts/search.py or /installed/demo-skill/data/rows.csv');
  });

  it('expands nothing else — a body cannot smuggle another variable', () => {
    expect(rewriteSkillRootPlaceholders('${HOME} $HOME ${PATH}', '/x')).toBe('${HOME} $HOME ${PATH}');
  });
});
