/**
 * P6b — Skill bundles (`src/learning/skill-bundles.ts`).
 *
 * Cross-skill composition (Hermes parity): a bundle groups N skills under one
 * id (`backend-dev` → code-review + tdd + pr-workflow) so the chat can load
 * several methodologies in ONE turn. The composition gap from the comparison:
 * agent-nuvira could only chain steps WITHIN a skill (dependsOn), never
 * compose whole skills.
 *
 * Storage: `~/.buff/skill-bundles/<slug>.yaml` — one small YAML file per
 * bundle (the `~/.hermes/skill-bundles/` convention). The grammar is a
 * STRICT subset (name, description, skills list) that this module both
 * writes and parses, so round-trips are deterministic:
 *
 *   name: backend-dev
 *   description: Full backend dev workflow
 *   skills:
 *     - code-review
 *     - tdd
 *
 * Design rules:
 * - Sandboxed slug (`^[a-z0-9-]+$`) — no traversal, no spaces (the same
 *   allowlist as skill installs).
 * - Missing member skills are SKIPPED, never fatal (Hermes parity): a bundle
 *   referencing a skill the user hasn't compiled/installed still loads the
 *   skills that DO exist.
 * - Best-effort by construction: corrupt files contribute nothing; a broken
 *   store can never throw out of a read.
 * - The store is pure file I/O — skill RESOLUTION (turning member names into
 *   methodology) lives in the skill tool (skill-tool.ts bundle action), so
 *   this module has no import cycle.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A skill bundle (group of skills loadable under one id). */
export interface SkillBundle {
  /** File slug (`^[a-z0-9-]+$`) — also the id used by `bundle:load`. */
  slug: string;
  /** Display name (defaults to the slug). */
  name: string;
  /** One-line description. */
  description: string;
  /** Member skill names/ids (compiled SkillStore or hub SKILL.md). */
  skills: string[];
  /** When the bundle was created (epoch ms). */
  createdAt: number;
  /** When the bundle was last written (epoch ms). */
  updatedAt: number;
}

/** Result of a create/update attempt (never throws — the CLI + tool read it). */
export interface BundleWriteResult {
  ok: boolean;
  slug: string;
  reason?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9-]+$/;
const BUNDLES_DIR_NAME = 'skill-bundles';

/**
 * Default bundles root: BUFF_MEMORY_DIR (when set) → ~/.buff/skill-bundles.
 * Resolved LAZILY so tests can set the env before the first read (the same
 * pattern cache.ts / skill-drafts use) — production is identical when unset.
 */
export function defaultBundlesRoot(): string {
  return process.env.BUFF_MEMORY_DIR
    ? join(process.env.BUFF_MEMORY_DIR, BUNDLES_DIR_NAME)
    : join(homedir(), '.buff', BUNDLES_DIR_NAME);
}

// ─── Path helpers (dir injectable for hermetic tests) ───────────────────────

function bundlesDir(root: string): string {
  return root;
}

function bundlePath(root: string, slug: string): string {
  return join(root, `${slug}.yaml`);
}

// ─── Strict YAML-subset writer ──────────────────────────────────────────────

/**
 * Serialize a bundle to the strict YAML subset this module reads back.
 * Values are escaped so a skill name containing YAML-significant characters
 * (a colon, a leading dash, a quote) can never corrupt the file.
 */
export function serializeBundle(b: Omit<SkillBundle, 'createdAt' | 'updatedAt'>): string {
  const esc = (s: string): string => {
    const str = String(s);
    // Quote anything that is not plain word/space/dot/dash/plus, AND anything
    // starting with '-' (a leading dash would read as a list item on re-parse).
    if (/^[\w .\-+]+$/.test(str) && !str.startsWith('-')) return str;
    return JSON.stringify(str);
  };
  const lines = [
    `name: ${esc(b.name)}`,
    `description: ${esc(b.description)}`,
    'skills:',
    ...b.skills.map((s) => `  - ${esc(s)}`),
    '',
  ];
  return lines.join('\n');
}

// ─── Strict YAML-subset parser ──────────────────────────────────────────────

/**
 * Parse a bundle file written by serializeBundle (or hand-edited to the same
 * grammar). Returns null for anything that does not match — a corrupt bundle
 * is skipped, never fatal.
 */
export function parseBundleYaml(slug: string, raw: string): Omit<SkillBundle, 'createdAt' | 'updatedAt'> | null {
  const unesc = (s: string): string => {
    const t = s.trim();
    if (
      (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
      (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
    ) {
      try {
        return JSON.parse(t);
      } catch {
        return t.slice(1, -1);
      }
    }
    return t;
  };

  let name = '';
  let description = '';
  const skills: string[] = [];
  let sawSkillsHeader = false;
  let inSkills = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (inSkills) {
      const item = /^- (.+)$/.exec(trimmed);
      if (item) {
        const skill = unesc(item[1]);
        if (skill && !skills.includes(skill)) skills.push(skill);
        continue;
      }
      inSkills = false; // a non-list line ends the list (same grammar we write)
    }
    const kv = /^([a-zA-Z0-9_.-]+):\s*(.*)$/.exec(trimmed);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'name') name = unesc(value);
    else if (key === 'description') description = unesc(value);
    else if (key === 'skills') {
      sawSkillsHeader = true;
      inSkills = true;
    }
  }

  // Minimum validity: a name (or slug fallback) and at least one member.
  if ((!name && !slug) || !sawSkillsHeader || skills.length === 0) return null;
  return { slug, name: name || slug, description, skills };
}

// ─── Store API ──────────────────────────────────────────────────────────────

/**
 * List every bundle on disk (sorted by name). Never throws — a missing or
 * unreadable dir contributes nothing.
 */
export function listBundles(root = defaultBundlesRoot()): SkillBundle[] {
  try {
    if (!existsSync(root)) return [];
    const out: SkillBundle[] = [];
    for (const file of readdirSync(root)) {
      if (!file.endsWith('.yaml')) continue;
      const slug = file.slice(0, -'.yaml'.length);
      if (!SLUG_RE.test(slug)) continue;
      const b = getBundle(slug, root);
      if (b) out.push(b);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Get one bundle by slug (null when missing or corrupt). */
export function getBundle(slug: string, root = defaultBundlesRoot()): SkillBundle | null {
  if (!SLUG_RE.test(slug)) return null;
  try {
    const path = bundlePath(root, slug);
    if (!existsSync(path)) return null;
    const parsed = parseBundleYaml(slug, readFileSync(path, 'utf-8'));
    if (!parsed) return null;
    return {
      ...parsed,
      createdAt: statMtimeMs(path),
      updatedAt: statMtimeMs(path),
    };
  } catch {
    return null;
  }
}

function statMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}

/**
 * Create (or overwrite) a bundle. Validates the slug allowlist and that at
 * least one member skill is named. Returns { ok: false, reason } instead of
 * throwing — the CLI and the skill tool both read this shape.
 */
export function writeBundle(
  input: { slug: string; name?: string; description?: string; skills: string[] },
  root = defaultBundlesRoot(),
): BundleWriteResult {
  const slug = input.slug.trim();
  if (!SLUG_RE.test(slug)) {
    return { ok: false, slug, reason: `Bundle id '${slug}' is not in [a-z0-9-]` };
  }
  const skills = [...new Set(input.skills.map((s) => s.trim()).filter(Boolean))];
  if (skills.length === 0) {
    return { ok: false, slug, reason: 'A bundle needs at least one member skill.' };
  }
  try {
    mkdirSync(root, { recursive: true });
    const bundle: Omit<SkillBundle, 'createdAt' | 'updatedAt'> = {
      slug,
      name: (input.name ?? slug).trim() || slug,
      description: (input.description ?? '').trim(),
      skills,
    };
    writeFileSync(bundlePath(root, slug), serializeBundle(bundle), 'utf-8');
    return { ok: true, slug };
  } catch (err) {
    return { ok: false, slug, reason: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Delete a bundle by slug. Returns true when something was removed. */
export function deleteBundle(slug: string, root = defaultBundlesRoot()): boolean {
  if (!SLUG_RE.test(slug)) return false;
  try {
    const path = bundlePath(root, slug);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
