/**
 * P1 — Skill packages (`src/learning/skill-package.ts`).
 *
 * A skill is not one file. `SKILL.md` is the entry point; the value of a real
 * skill (ui-ux-pro-max, superpowers/brainstorming) lives in the siblings it
 * references — `references/*.md`, `scripts/*.py`, `data/*.csv`.
 *
 * The hub install used to write SKILL.md and stop, so a multi-file skill
 * installed "successfully" and then failed the moment the model was told to
 * read `visual-companion.md` in its own directory. This module is the
 * transport that fixes that: copy a skill DIRECTORY, cap what we copy, and
 * fingerprint the whole tree so provenance covers the scripts too — not just
 * the prose.
 *
 * Everything here is pure filesystem work with no config/network access, so it
 * is fixture-testable and safe to call from the installer, the CLI and the
 * dashboard server alike.
 *
 * Security posture:
 *   - The caller validates the skill NAME before calling (the install sandbox,
 *     `^[a-z0-9-]+$`); this module never derives a path from untrusted text.
 *   - Symlinks are followed ONLY when their real target stays inside the source
 *     directory; anything else is skipped (a hostile repo cannot symlink
 *     `/etc/passwd` into a skill).
 *   - `.git/`, `node_modules/`, `__pycache__/` and OS junk are never copied.
 *   - Hard caps on file count and total bytes keep an install bounded.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Hard caps for one skill package. Exceeding them fails the install loudly. */
export interface SkillPackageLimits {
  maxFiles: number;
  maxBytes: number;
}

export const DEFAULT_SKILL_PACKAGE_LIMITS: SkillPackageLimits = {
  maxFiles: 400,
  maxBytes: 12 * 1024 * 1024, // 12 MB
};

/** What a skill directory contains (relative POSIX paths, sorted). */
export interface SkillPackageInfo {
  /** Relative paths, `/`-separated, sorted. Never absolute. */
  files: string[];
  /** Sum of file sizes in bytes. */
  bytes: number;
  /**
   * sha256 over sorted `"<relpath>\n<sha256(content)>\n"` lines. Covers every
   * file, so a modified script changes the hash (a SKILL.md-only hash misses it).
   */
  treeHash: string;
}

export interface CopiedSkillPackage extends SkillPackageInfo {
  /** Absolute destination directory. */
  destDir: string;
  /** Absolute path to the copied SKILL.md. */
  skillPath: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Directories that are never part of a skill package. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.mypy_cache']);

/** OS/tool junk files that are never part of a skill package. */
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

const ENTRY = 'SKILL.md';

// ─── Walk ───────────────────────────────────────────────────────────────────

/**
 * Walk a skill directory and return its files as sorted relative POSIX paths.
 * Symlinks are included only when they resolve inside `root`. Never throws for
 * an unreadable entry — the entry is skipped (an install must not fail because
 * one file is chmod 000).
 */
export function listSkillFiles(root: string): string[] {
  const absRoot = resolve(root);
  let realRoot: string;
  try {
    realRoot = realpathSync(absRoot);
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        // Follow only symlinks that stay inside the skill directory.
        try {
          const real = realpathSync(abs);
          if (!isInside(real, realRoot)) continue;
          const st = statSync(real);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // dangling link
        }
      }
      if (isDir) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!isFile) continue;
      if (SKIP_FILES.has(entry.name)) continue;
      out.push(relative(absRoot, abs).split(sep).join('/'));
    }
  };
  walk(absRoot);
  return out.sort();
}

/** True when `child` is `parent` or lives inside it (path-boundary safe). */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..');
}

// ─── Fingerprint ────────────────────────────────────────────────────────────

/**
 * sha256 over the whole tree: `"<relpath>\n<sha256(content)>\n"` for every file
 * in sorted order. Deterministic across machines and independent of mtimes.
 * Returns '' for a missing/empty directory.
 */
export function treeHashOf(root: string): string {
  const files = listSkillFiles(root);
  if (files.length === 0) return '';
  const hash = createHash('sha256');
  for (const rel of files) {
    let content: Buffer;
    try {
      content = readFileSync(join(root, rel));
    } catch {
      content = Buffer.from(''); // unreadable file still contributes a line
    }
    hash.update(`${rel}\n${createHash('sha256').update(content).digest('hex')}\n`);
  }
  return hash.digest('hex');
}

/**
 * Cheap size probe: file count + total bytes, WITHOUT reading file contents.
 * The dashboard polls this per skill, so it must not hash the tree.
 */
export function skillPackageSize(root: string): { fileCount: number; bytes: number } {
  const files = listSkillFiles(root);
  let bytes = 0;
  for (const rel of files) {
    try {
      bytes += statSync(join(root, rel)).size;
    } catch {
      /* unreadable — contributes 0 */
    }
  }
  return { fileCount: files.length, bytes };
}

/** Files + bytes + tree hash for one skill directory. */
export function skillPackageInfo(root: string): SkillPackageInfo {
  const files = listSkillFiles(root);
  let bytes = 0;
  for (const rel of files) {
    try {
      bytes += statSync(join(root, rel)).size;
    } catch {
      /* unreadable — contributes 0 */
    }
  }
  return { files, bytes, treeHash: treeHashOf(root) };
}

/** True when a directory looks like a skill (has a SKILL.md entry point). */
export function isSkillPackageDir(dir: string): boolean {
  try {
    return existsSync(join(dir, ENTRY));
  } catch {
    return false;
  }
}

// ─── Copy ───────────────────────────────────────────────────────────────────

export class SkillPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillPackageError';
  }
}

/**
 * Copy a skill DIRECTORY into `destDir` (replacing whatever is there), then
 * fingerprint it.
 *
 * The copy is bounded: more than `maxFiles` files or `maxBytes` bytes throws a
 * {@link SkillPackageError} BEFORE the destination is touched, so a refused
 * install cannot leave a half-written skill behind.
 *
 * @throws SkillPackageError when the source has no SKILL.md or exceeds a cap.
 */
export function copySkillPackage(
  srcDir: string,
  destDir: string,
  limits: SkillPackageLimits = DEFAULT_SKILL_PACKAGE_LIMITS,
): CopiedSkillPackage {
  if (!existsSync(join(srcDir, ENTRY))) {
    throw new SkillPackageError(`not a skill package: ${srcDir} has no ${ENTRY}`);
  }
  const files = listSkillFiles(srcDir);
  const sizes = new Map<string, number>();
  let bytes = 0;
  for (const rel of files) {
    const size = (() => {
      try {
        return statSync(join(srcDir, rel)).size;
      } catch {
        return 0;
      }
    })();
    sizes.set(rel, size);
    bytes += size;
  }
  if (files.length > limits.maxFiles) {
    throw new SkillPackageError(
      `skill package has ${files.length} files (limit ${limits.maxFiles})`,
    );
  }
  if (bytes > limits.maxBytes) {
    throw new SkillPackageError(
      `skill package is ${bytes} bytes (limit ${limits.maxBytes})`,
    );
  }

  // Only now touch the filesystem.
  try {
    if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
    for (const rel of files) {
      const target = join(destDir, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(srcDir, rel)));
    }
  } catch (err) {
    throw new SkillPackageError(
      `copy failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    destDir,
    skillPath: join(destDir, ENTRY),
    files,
    bytes,
    treeHash: treeHashOf(destDir),
  };
}

// ─── Root indirection ───────────────────────────────────────────────────────

/**
 * Rewrite the root placeholders a Claude-style skill body may use into the
 * installed skill's real directory. `${CLAUDE_PLUGIN_ROOT}` is the convention
 * the community repos use; `${SKILL_ROOT}` is the portable spelling we document.
 *
 * This only ever substitutes a path the installer just chose — no expansion of
 * any other variable, so a body cannot smuggle `${HOME}` or a command into the
 * text.
 */
export function rewriteSkillRootPlaceholders(markdown: string, skillDir: string): string {
  return markdown
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, skillDir)
    .replace(/\$\{SKILL_ROOT\}/g, skillDir);
}
