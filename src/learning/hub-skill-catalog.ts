/**
 * I7 P0 — Hub skill catalog (`src/learning/hub-skill-catalog.ts`).
 *
 * Makes installed `SKILL.md` skills FIRST-CLASS runtime capabilities: the
 * orchestrator's skill-matching (which previously only consulted the compiled
 * SkillStore) now also consults this catalog, so a `nuvira skills install`
 * result is immediately matchable + injectable — no recompilation needed
 * (skills-hub bridge parity).
 *
 * Sources (all scanned, deduped by name in PRECEDENCE order — see
 * `skillRoots()`, first wins):
 *   - `<project>/.agents/skills/<name>/SKILL.md`   (hub install target)
 *   - `<project>/.claude/skills/<name>/SKILL.md`   (P3 — external, read-only)
 *   - `~/.nuvira/skills/<name>/SKILL.md`             (user-level skills)
 *   - `~/.claude/skills/<name>/SKILL.md`             (P3 — external, read-only)
 *
 * Reading the `.claude` roots is the parity win: a skill already installed for
 * Claude Code is the same open SKILL.md format, so it works here with no import
 * step — and nuvira never writes to those directories.
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
import { findProjectConfig } from '../team/config.js';
import { getSkillStore } from './skill-store.js';
import { logger } from '../utils/logger.js';
import {
  hasObligations,
  parseObligations,
  type SkillObligations,
} from './skill-obligations.js';

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
  /** Scope the skill was found in: 'project' | 'home'. */
  root: 'project' | 'home';
  /**
   * P3 — who owns the root: nuvira's own (`.agents/skills`, `~/.nuvira/skills`)
   * or an EXTERNAL tool's (`.claude/skills`). External skills are read-only
   * input: nuvira never writes there, and the dashboard badges them.
   */
  origin: SkillOrigin;
  /** Absolute directory of the skill (for read_file on its siblings). */
  dir: string;
  /** P6c — `platforms:` — skill hidden on incompatible OS (e.g. [macos, linux]). */
  platforms?: string[];
  /** P6c — `requires_toolsets:` — skill visible only when ALL named toolsets exist. */
  requiresToolsets?: string[];
  /** P6c — `fallback_for_toolsets:` — skill visible only when the named toolset is ABSENT. */
  fallbackForToolsets?: string[];
  /** P6c — `config:` — declared buffconfig settings the skill expects. */
  config?: Record<string, string>;
  /** P6c — `required_environment_variables:` — env var NAMES (values never read/printed). */
  requiredEnvVars?: string[];
  /**
   * P6 — `obligations:` — what "used" means for this skill. A LOADED skill with
   * obligations is binding: the finish gate refuses an unqualified completion
   * claim while one is unmet. Absent = advisory (the old behaviour).
   */
  obligations?: SkillObligations;
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

/** Who owns a skills root. `external` roots are read-only for nuvira. */
export type SkillOrigin = 'nuvira' | 'external';

/** One skills root in precedence order. */
export interface SkillRootSpec {
  /** 'project' (the workspace) or 'home' (the user). */
  scope: 'project' | 'home';
  origin: SkillOrigin;
  /** Absolute directory. */
  dir: string;
}

/**
 * P3 — the read-only roots, in PRECEDENCE order (first wins on a name clash).
 *
 *   1. <project>/.agents/skills   nuvira    the install target
 *   2. <project>/.claude/skills   external  read-only: skills Claude already has
 *   3. ~/.nuvira/skills           nuvira    user-level
 *   4. ~/.claude/skills           external  read-only
 *
 * The order is deliberate: a project pin beats a user-wide copy, and nuvira's
 * own root beats an external one at the SAME scope (so a skill the user
 * installed for nuvira is not silently shadowed by a `.claude` copy). Without a
 * pinned order, which copy of `design-system` wins would depend on directory
 * read order — i.e. on nothing.
 *
 * Reading `.claude/skills` is what makes "the skills I already installed for
 * Claude just work": the format is the same open SKILL.md standard, so there is
 * nothing to import. Nothing is ever WRITTEN to those roots.
 */
export function skillRoots(projectRoot = process.cwd(), home = homedir()): SkillRootSpec[] {
  return [
    { scope: 'project', origin: 'nuvira', dir: join(projectRoot, '.agents', 'skills') },
    { scope: 'project', origin: 'external', dir: join(projectRoot, '.claude', 'skills') },
    { scope: 'home', origin: 'nuvira', dir: join(home, '.nuvira', 'skills') },
    { scope: 'home', origin: 'external', dir: join(home, '.claude', 'skills') },
  ];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parsed frontmatter of a SKILL.md. The grammar is YAML-lite (same as the
 * hub): `key: value` lines, plus P6c list/map values:
 *   - inline arrays:  `platforms: [macos, linux]`
 *   - block lists:    `requires_toolsets:` then indented `- item` lines
 *   - config map:     `config:` then indented `key: value` lines
 * Every read is best-effort: a malformed value simply contributes nothing.
 */
export interface CatalogFrontmatter {
  name?: string;
  description?: string;
  platforms?: string[];
  requiresToolsets?: string[];
  fallbackForToolsets?: string[];
  config?: Record<string, string>;
  requiredEnvVars?: string[];
}

function unquote(v: string): string {
  return v.trim().replace(/^["']|["']$/g, '');
}

/** Parse an inline array value: `[a, b, c]` → ['a', 'b', 'c'] (or []). */
function parseInlineArray(value: string): string[] {
  const inner = value.trim().replace(/^\[|\]$/g, '');
  if (!inner.trim()) return [];
  return inner.split(',').map((s) => unquote(s)).filter(Boolean);
}

/** Parse `---` frontmatter (P6c depth: platforms, toolsets, config, env vars). */
export function parseCatalogFrontmatter(markdown: string): CatalogFrontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!m) return {};
  const out: Record<string, string | string[] | Record<string, string>> = {};
  const lines = m[1].split(/\r?\n/);
  let listKey: string | null = null; // active block-list key
  let configKey: string | null = null; // active config-map key
  for (const line of lines) {
    // Block-list continuation: indented `- item` lines belong to listKey.
    if (listKey && /^\s+-\s+/.test(line)) {
      const item = unquote(line.replace(/^\s+-\s+/, ''));
      const arr = out[listKey] as string[];
      if (item && !arr.includes(item)) arr.push(item);
      continue;
    }
    listKey = null;
    // Config-map continuation: indented `key: value` lines belong to configKey.
    if (configKey && /^\s+[a-zA-Z0-9_.-]+:/.test(line)) {
      const kv = /^\s*([a-zA-Z0-9_.-]+):\s*(.*)$/.exec(line);
      if (kv) {
        (out[configKey] as Record<string, string>)[kv[1]] = unquote(kv[2]);
        continue;
      }
    }
    configKey = null;
    const kv = /^([a-zA-Z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    if (key === 'config') {
      out[key] = {};
      configKey = key;
      continue;
    }
    if (!value) {
      // Header with no value → block list follows.
      out[key] = [];
      listKey = key;
      continue;
    }
    if (value.startsWith('[')) {
      out[key] = parseInlineArray(value);
      continue;
    }
    out[key] = unquote(value);
  }
  const pick = (k: string): string | undefined => {
    const v = out[k];
    return typeof v === 'string' ? v : undefined;
  };
  const pickList = (k: string): string[] | undefined => {
    const v = out[k];
    return Array.isArray(v) ? v : undefined;
  };
  return {
    name: pick('name'),
    description: pick('description'),
    platforms: pickList('platforms'),
    requiresToolsets: pickList('requires_toolsets'),
    fallbackForToolsets: pickList('fallback_for_toolsets'),
    config: (() => {
      const v = out['config'];
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : undefined;
    })(),
    requiredEnvVars: pickList('required_environment_variables'),
  };
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
function scanRoot(spec: SkillRootSpec): HubCatalogSkill[] {
  const { dir } = spec;
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
        const skill: HubCatalogSkill = {
          id: entry.name,
          name: fm.name || entry.name,
          description: fm.description || 'No description in SKILL.md frontmatter.',
          body: stripFrontmatter(markdown),
          root: spec.scope,
          origin: spec.origin,
          dir: join(dir, entry.name),
        };
        // P6c — carry the depth fields when declared (undefined = no gate).
        if (fm.platforms && fm.platforms.length > 0) skill.platforms = fm.platforms;
        if (fm.requiresToolsets && fm.requiresToolsets.length > 0) skill.requiresToolsets = fm.requiresToolsets;
        if (fm.fallbackForToolsets && fm.fallbackForToolsets.length > 0) skill.fallbackForToolsets = fm.fallbackForToolsets;
        if (fm.config && Object.keys(fm.config).length > 0) skill.config = fm.config;
        if (fm.requiredEnvVars && fm.requiredEnvVars.length > 0) skill.requiredEnvVars = fm.requiredEnvVars;
        // P6 — obligations (parsed separately: it is a nested map, which the
        // YAML-lite frontmatter reader above deliberately does not model).
        const obligations = parseObligations(markdown);
        if (hasObligations(obligations)) skill.obligations = obligations;
        out.push(skill);
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
  const seen = new Set<string>();
  const merged: HubCatalogSkill[] = [];
  for (const spec of skillRoots(projectRoot, home)) {
    for (const skill of scanRoot(spec)) {
      if (seen.has(skill.id)) continue;
      seen.add(skill.id);
      merged.push(skill);
    }
  }
  return merged;
}

/** Read the `skills.disabled` exclusion list from buffconfig (never throws). */
export function readDisabledSkills(cm?: ConfigManager, cwd = process.cwd()): string[] {
  return readSkillPolicy(cm, cwd).disabled;
}

/**
 * The GLOBAL `skills.disabled[]` only (no project merge).
 *
 * The Agent Hub toggle WRITES this list, so it must read the same list: reading
 * the merged policy would fold a project's own exclusions into the machine-wide
 * config the next time any toggle was pressed.
 */
export function readGlobalDisabledSkills(cm?: ConfigManager): string[] {
  try {
    const cfg = cm?.getAll?.();
    const disabled = cfg?.skills?.disabled;
    return Array.isArray(disabled)
      ? disabled.filter((d): d is string => typeof d === 'string').map((d) => d.toLowerCase())
      : [];
  } catch {
    return [];
  }
}

/**
 * The effective skill policy for a directory.
 *
 * Global (`skills.disabled[]` in buffconfig) is the operator's machine-wide
 * decision. A PROJECT can narrow it in its own `.nuviraconfig.json` /
 * `buffconfig.json` / `.nuvira/config.json`:
 *
 *   - `skills.disabled[]` — adds to the global list (a repo that must not use a
 *     skill the machine allows);
 *   - `skills.enabled[]`  — an ALLOWLIST: when non-empty, every skill it does
 *     not name is excluded FOR THIS PROJECT. This is the "project A uses the
 *     api-design skill, project B must not" case, which previously could only
 *     be expressed by where the skill was installed — and `disabled[]` is
 *     machine-wide, so editing it for one repo silently changed the others.
 *
 * Project `enabled` wins over global `enabled` (the narrower scope speaks last);
 * disabled lists UNION, so neither scope can re-enable what the other excluded.
 * Best-effort: an unreadable/broken config contributes nothing rather than
 * throwing into a turn.
 */
export interface SkillPolicy {
  disabled: string[];
  enabled: string[];
}

export function readSkillPolicy(cm?: ConfigManager, cwd = process.cwd()): SkillPolicy {
  let disabled: string[] = [];
  let enabled: string[] = [];
  try {
    const cfg = cm?.getAll?.();
    const list = cfg?.skills?.disabled;
    if (Array.isArray(list)) {
      disabled = list.filter((d): d is string => typeof d === 'string').map((d) => d.toLowerCase());
    }
    const allow = (cfg?.skills as { enabled?: unknown } | undefined)?.enabled;
    if (Array.isArray(allow)) {
      enabled = allow.filter((d): d is string => typeof d === 'string').map((d) => d.toLowerCase());
    }
  } catch {
    /* a broken user config must not gate anything */
  }
  try {
    const project = findProjectConfig(cwd) as { skills?: { disabled?: unknown; enabled?: unknown } } | null;
    const projectDisabled = project?.skills?.disabled;
    if (Array.isArray(projectDisabled)) {
      for (const id of projectDisabled) {
        if (typeof id !== 'string') continue;
        const name = id.toLowerCase();
        if (!disabled.includes(name)) disabled.push(name);
      }
    }
    const projectEnabled = project?.skills?.enabled;
    if (Array.isArray(projectEnabled)) {
      enabled = projectEnabled.filter((d): d is string => typeof d === 'string').map((d) => d.toLowerCase());
    }
  } catch {
    /* a broken project config must not gate anything */
  }
  return { disabled, enabled };
}

/**
 * Is this skill id usable under the policy? Both spellings are checked, because
 * a compiled skill's store id is `skill-<name>` while its hub id is `<name>` and
 * an operator (or a repo) writes whichever they saw in the Agent Hub.
 */
export function skillPolicyAllows(id: string, policy: SkillPolicy): boolean {
  const name = id.toLowerCase();
  const aliases = [name, name.replace(/^skill-/, ''), name.startsWith('skill-') ? name : `skill-${name}`];
  if (aliases.some((a) => policy.disabled.includes(a))) return false;
  if (policy.enabled.length === 0) return true;
  return aliases.some((a) => policy.enabled.includes(a));
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
    throw new Error(`Unknown skill '${id}' — run \`nuvira skills list\` to see known skills.`);
  }
  // Whole-list semantics (empty is meaningful): enable removes the id,
  // disable appends it — other entries are never clobbered. GLOBAL list only:
  // a project's own exclusions are not this command's to rewrite.
  const current = readGlobalDisabledSkills(cm);
  const next = enabled
    ? current.filter((d) => d !== id)
    : current.includes(id) ? current : [...current, id];
  const save = cm?.save ? cm.save.bind(cm) : (config: { skills: { disabled: string[] } }) => new ConfigManager().save(config);
  save({ skills: { disabled: next } });
}

/** P6c — normalize a process.platform value to the skill vocabulary. */
export function normalizePlatform(platform: string): string {
  switch (platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return platform; // linux, freebsd, …
  }
}

/**
 * P6c — platform gate: a skill declaring `platforms:` is hidden on an
 * incompatible OS. Undeclared = visible everywhere. The declared list and the
 * runtime platform are both normalized (`darwin`≡`macos`, `win32`≡`windows`).
 */
export function platformAllows(skill: HubCatalogSkill, platform = process.platform): boolean {
  if (!skill.platforms || skill.platforms.length === 0) return true;
  const norm = normalizePlatform(platform);
  return skill.platforms.map(normalizePlatform).includes(norm);
}

/**
 * P6c — toolset gate (conditional activation):
 *   - `requires_toolsets: [t]` → hidden unless EVERY named toolset is present.
 *   - `fallback_for_toolsets: [t]` → visible ONLY when the named toolset is
 *     ABSENT (the skill provides what that toolset would — e.g. a search
 *     fallback shows only when the web toolset is off).
 * `presentToolsets` defaults to every catalog toolset (the CLI/dashboard pass
 * the ENABLED set so a disabled toolset hides its dependents).
 */
export function toolsetAllows(skill: HubCatalogSkill, presentToolsets?: Set<string>): boolean {
  if ((!skill.requiresToolsets || skill.requiresToolsets.length === 0) &&
      (!skill.fallbackForToolsets || skill.fallbackForToolsets.length === 0)) {
    return true;
  }
  const present = presentToolsets ?? new Set(TOOLSET_NAMES);
  if (skill.requiresToolsets && skill.requiresToolsets.length > 0) {
    if (!skill.requiresToolsets.every((t) => present.has(t))) return false;
  }
  if (skill.fallbackForToolsets && skill.fallbackForToolsets.length > 0) {
    // A fallback is only for when the real toolset is GONE — if any named
    // toolset is present, the fallback is redundant and hidden.
    if (skill.fallbackForToolsets.some((t) => present.has(t))) return false;
  }
  return true;
}

/** All catalog toolset names (the default "present" set when no config). */
const TOOLSET_NAMES = [
  'core', 'publish', 'experience', 'code', 'coding', 'web', 'channels', 'system', 'browser', 'media', 'mcp',
];

/**
 * The matchable catalog (disabled + platform + toolset gates applied). Reads
 * the disabled list fresh so a config toggle is honored on the very next
 * match; the platform/toolset gates keep incompatible skills out of the
 * model's sight (P6c — the same "never silently inject" rule as disabled).
 *
 * @param cm                ConfigManager (disabled list + enabled toolsets).
 * @param projectRoot       Hub project root (default cwd).
 * @param home              Hub home root (default homedir()).
 * @param platform          Runtime platform for the platform gate (default process.platform).
 * @param presentToolsets   Toolset names present; defaults to ALL catalog
 *                          toolsets when omitted (never hides by accident).
 */
export function listMatchableHubSkills(
  cm?: ConfigManager,
  projectRoot = process.cwd(),
  home = homedir(),
  platform = process.platform,
  presentToolsets?: Set<string>,
): HubCatalogSkill[] {
  const policy = readSkillPolicy(cm, projectRoot);
  const present = presentToolsets ?? enabledToolsetNames(cm);
  return readHubCatalog(projectRoot, home).filter(
    (s) => skillPolicyAllows(s.id, policy) && platformAllows(s, platform) && toolsetAllows(s, present),
  );
}

/** Enabled toolset names (absent entry = enabled — the toolsets module rule). */
function enabledToolsetNames(cm?: ConfigManager): Set<string> {
  try {
    const cfg = cm?.getAll?.();
    const state = cfg?.tools?.toolsets;
    if (!state || typeof state !== 'object') return new Set(TOOLSET_NAMES);
    return new Set(TOOLSET_NAMES.filter((t) => state[t]?.enabled !== false));
  } catch {
    return new Set(TOOLSET_NAMES);
  }
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

  // WHOLE-WORD matching, never substring: `q.includes('kill')` matched inside
  // "s**kill**", which ranked `feature-flags` top for "no skill covers alpaca
  // husbandry whatsoever". The same class makes `mac` match "machine" and
  // `arch` match "search". Tokenizing once also keeps this ranking consistent
  // with whole-word matching elsewhere in the skill layer. NOTE: the auto-
  const tokens = new Set(q.split(/[^a-z0-9]+/).filter((w) => w.length > 0));

  const scored = skills.map((skill) => {
    let score = 0;
    // Name words (>3 chars) present in the goal.
    for (const word of skill.name.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length > 3 && tokens.has(word)) score += 2;
    }
    // Description keywords.
    for (const word of skill.description.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length > 3 && tokens.has(word)) score += 1.5;
    }
    // Skill id (directory name).
    if (tokens.has(skill.id.toLowerCase())) score += 1;
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
