/**
 * I7 P0 — Hub skill catalog (`src/learning/hub-skill-catalog.ts`).
 *
 * Makes installed `SKILL.md` skills FIRST-CLASS runtime capabilities: the
 * orchestrator's skill-matching (which previously only consulted the compiled
 * SkillStore) now also consults this catalog, so a `buff skills install`
 * result is immediately matchable + injectable — no recompilation needed
 * (Hermes `skills_hub.py` bridge parity).
 *
 * Sources (both scanned, deduped by name — the project root wins):
 *   - `<project>/.agents/skills/<name>/SKILL.md`   (hub install target)
 *   - `~/.buff/skills/<name>/SKILL.md`             (user-level skills)
 *
 * Security/gating:
 *   - Skill names are validated with `^[a-z0-9-]+$` before any read (the same
 *     sandbox rule as installs — a hostile dir name can never be read).
 *   - `skills.disabled[]` from buffconfig excludes skills at the MATCH GATE
 *     (same enforcement rule as the toolsets gate: a disabled skill is never
 *     silently injected).
 *   - Best-effort: a missing/unreadable dir, corrupt frontmatter, or broken
 *     config can never throw out of the catalog (the orchestrator's skill
 *     guidance block is itself best-effort).
 *
 * Progressive disclosure (industry pattern, matches SkillStore guidance):
 *   - Level 0: the catalog carries only name + description.
 *   - Level 1: on match, the SKILL.md body is handed to the planner as the
 *     methodology to adapt (steps are never emitted as literal commands).
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { ConfigManager } from '../config/manager.js';
import { getSkillStore } from './skill-store.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A hub (SKILL.md) skill surfaced for runtime matching. */
export interface HubCatalogSkill {
  /** Directory name (sandboxed id). */
  id: string;
  /** Frontmatter `name:` (falls back to the directory name). */
  name: string;
  /** Frontmatter `description:` (falls back to a placeholder). */
  description: string;
  /** The full SKILL.md body (frontmatter stripped) — injected on match. */
  body: string;
  /** Root the skill was found in: 'project' | 'home'. */
  root: 'project' | 'home';
}

/** The skill-guidance payload handed to the planner (Level 1 on match). */
export interface HubSkillMatch {
  id: string;
  name: string;
  description: string;
  /** SKILL.md body — the methodology to adapt (never literal commands). */
  body: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SKILL_NAME_RE = /^[a-z0-9-]+$/;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Parse `---` frontmatter: name + description (same grammar as the hub). */
export function parseCatalogFrontmatter(markdown: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z0-9_.-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { name: out.name, description: out.description };
}

/** Strip the frontmatter block, returning just the markdown body. */
function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

// ─── Catalog read ───────────────────────────────────────────────────────────

/**
 * Scan a single root for `<name>/SKILL.md` directories. Never throws — a
 * missing root or a corrupt file simply contributes nothing.
 */
function scanRoot(root: 'project' | 'home', dir: string): HubCatalogSkill[] {
  try {
    if (!existsSync(dir)) return [];
    const out: HubCatalogSkill[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SKILL_NAME_RE.test(entry.name)) continue;
      const skillPath = join(dir, entry.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      try {
        // mtime freshness is irrelevant per-read (reads are cheap + cached by
        // the OS); the catalog is rebuilt on demand and never long-lived.
        statSync(skillPath);
        const markdown = readFileSync(skillPath, 'utf-8');
        const fm = parseCatalogFrontmatter(markdown);
        out.push({
          id: entry.name,
          name: fm.name || entry.name,
          description: fm.description || 'No description in SKILL.md frontmatter.',
          body: stripFrontmatter(markdown),
          root,
        });
      } catch {
        // A corrupt SKILL.md is skipped — never breaks the catalog.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Read the full hub catalog: project root wins over the home root when the
 * same skill name exists in both (a project-level pin shadows a stale home
 * copy). Never throws.
 */
export function readHubCatalog(projectRoot = process.cwd(), home = homedir()): HubCatalogSkill[] {
  const roots = [
    { root: 'project' as const, dir: join(projectRoot, '.agents', 'skills') },
    { root: 'home' as const, dir: join(home, '.buff', 'skills') },
  ];
  const seen = new Set<string>();
  const merged: HubCatalogSkill[] = [];
  for (const { root, dir } of roots) {
    for (const skill of scanRoot(root, dir)) {
      if (seen.has(skill.id)) continue;
      seen.add(skill.id);
      merged.push(skill);
    }
  }
  return merged;
}

/** Read the `skills.disabled` exclusion list from buffconfig (never throws). */
export function readDisabledSkills(cm?: ConfigManager): string[] {
  try {
    const cfg = cm?.getAll?.();
    const disabled = cfg?.skills?.disabled;
    return Array.isArray(disabled) ? disabled.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Union of every known skill id: compiled SkillStore ids + installed hub
 * (SKILL.md) ids. Best-effort — a broken store can never throw out of the
 * writer (the typo-safety check then just falls back to the hub catalog).
 */
function knownSkillIds(projectRoot = process.cwd(), home = homedir()): Set<string> {
  const ids = new Set<string>();
  try {
    for (const s of readHubCatalog(projectRoot, home)) ids.add(s.id);
  } catch {
    /* best-effort */
  }
  try {
    for (const s of getSkillStore().getAll()) ids.add(s.id);
  } catch {
    /* best-effort */
  }
  return ids;
}

/**
 * P3 — Persist a skill's enabled state (Agent Hub Skills tab toggle).
 *
 * Writes the SAME `skills.disabled[]` list the match gates read: the hub
 * catalog filters it in `listMatchableHubSkills` and the orchestrator gates
 * compiled `findMatch` results against it, so the toggle is NEVER cosmetic.
 * Throws for an unknown skill id (typo-safe, mirrors `setToolsetEnabled`).
 */
export function setSkillEnabled(
  id: string,
  enabled: boolean,
  cm?: ConfigManager,
  projectRoot = process.cwd(),
  home = homedir(),
): void {
  if (!knownSkillIds(projectRoot, home).has(id)) {
    throw new Error(`Unknown skill '${id}' — run \`buff skills list\` to see known skills.`);
  }
  // Whole-list semantics (empty is meaningful): enable removes the id,
  // disable appends it — other entries are never clobbered.
  const current = readDisabledSkills(cm);
  const next = enabled
    ? current.filter((d) => d !== id)
    : current.includes(id) ? current : [...current, id];
  const save = cm?.save ? cm.save.bind(cm) : (config: { skills: { disabled: string[] } }) => new ConfigManager().save(config);
  save({ skills: { disabled: next } });
}

/**
 * The matchable catalog (disabled skills excluded). Reads the disabled list
 * fresh so a config toggle is honored on the very next match.
 */
export function listMatchableHubSkills(cm?: ConfigManager, projectRoot = process.cwd(), home = homedir()): HubCatalogSkill[] {
  const disabled = new Set(readDisabledSkills(cm));
  return readHubCatalog(projectRoot, home).filter((s) => !disabled.has(s.id));
}

// ─── Matching ───────────────────────────────────────────────────────────────

/**
 * Find the best hub-skill match for a goal (keyword scoring over name +
 * description + body headings — the same "manual discovery" threshold the
 * compiled store uses; the orchestrator applies its tighter activation gate).
 * Returns null when no skill scores ≥ 1 (never a forced match).
 */
export function findHubSkillMatch(goal: string, cm?: ConfigManager, projectRoot = process.cwd(), home = homedir()): HubSkillMatch | null {
  const q = goal.toLowerCase();
  const skills = listMatchableHubSkills(cm, projectRoot, home);
  if (skills.length === 0) return null;

  const scored = skills.map((skill) => {
    let score = 0;
    // Name words (>3 chars) present in the goal.
    for (const word of skill.name.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length > 3 && q.includes(word)) score += 2;
    }
    // Description keywords.
    for (const word of skill.description.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length > 3 && q.includes(word)) score += 1.5;
    }
    // Skill id (directory name).
    if (q.includes(skill.id.toLowerCase())) score += 1;
    return { skill, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 1) return null;

  logger.debug(`Hub catalog matched skill '${best.skill.name}' (score ${best.score})`);
  return {
    id: best.skill.id,
    name: best.skill.name,
    description: best.skill.description,
    body: best.skill.body,
  };
}
