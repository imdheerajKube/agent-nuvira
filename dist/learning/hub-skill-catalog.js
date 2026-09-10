/**
 * I7 P0 — Hub skill catalog (`src/learning/hub-skill-catalog.ts`).
 *
 * Makes installed `SKILL.md` skills FIRST-CLASS runtime capabilities: the
 * orchestrator's skill-matching (which previously only consulted the compiled
 * SkillStore) now also consults this catalog, so a `nuvira skills install`
 * result is immediately matchable + injectable — no recompilation needed
 * (skills-hub bridge parity).
 *
 * Sources (both scanned, deduped by name — the project root wins):
 *   - `<project>/.agents/skills/<name>/SKILL.md`   (hub install target)
 *   - `~/.nuvira/skills/<name>/SKILL.md`             (user-level skills)
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
// ─── Constants ──────────────────────────────────────────────────────────────
const SKILL_NAME_RE = /^[a-z0-9-]+$/;
function unquote(v) {
    return v.trim().replace(/^["']|["']$/g, '');
}
/** Parse an inline array value: `[a, b, c]` → ['a', 'b', 'c'] (or []). */
function parseInlineArray(value) {
    const inner = value.trim().replace(/^\[|\]$/g, '');
    if (!inner.trim())
        return [];
    return inner.split(',').map((s) => unquote(s)).filter(Boolean);
}
/** Parse `---` frontmatter (P6c depth: platforms, toolsets, config, env vars). */
export function parseCatalogFrontmatter(markdown) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
    if (!m)
        return {};
    const out = {};
    const lines = m[1].split(/\r?\n/);
    let listKey = null; // active block-list key
    let configKey = null; // active config-map key
    for (const line of lines) {
        // Block-list continuation: indented `- item` lines belong to listKey.
        if (listKey && /^\s+-\s+/.test(line)) {
            const item = unquote(line.replace(/^\s+-\s+/, ''));
            const arr = out[listKey];
            if (item && !arr.includes(item))
                arr.push(item);
            continue;
        }
        listKey = null;
        // Config-map continuation: indented `key: value` lines belong to configKey.
        if (configKey && /^\s+[a-zA-Z0-9_.-]+:/.test(line)) {
            const kv = /^\s*([a-zA-Z0-9_.-]+):\s*(.*)$/.exec(line);
            if (kv) {
                out[configKey][kv[1]] = unquote(kv[2]);
                continue;
            }
        }
        configKey = null;
        const kv = /^([a-zA-Z0-9_.-]+):\s*(.*)$/.exec(line);
        if (!kv)
            continue;
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
    const pick = (k) => {
        const v = out[k];
        return typeof v === 'string' ? v : undefined;
    };
    const pickList = (k) => {
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
            return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
        })(),
        requiredEnvVars: pickList('required_environment_variables'),
    };
}
/** Strip the frontmatter block, returning just the markdown body. */
function stripFrontmatter(markdown) {
    return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}
// ─── Catalog read ───────────────────────────────────────────────────────────
/**
 * Scan a single root for `<name>/SKILL.md` directories. Never throws — a
 * missing root or a corrupt file simply contributes nothing.
 */
function scanRoot(root, dir) {
    try {
        if (!existsSync(dir))
            return [];
        const out = [];
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory() || !SKILL_NAME_RE.test(entry.name))
                continue;
            const skillPath = join(dir, entry.name, 'SKILL.md');
            if (!existsSync(skillPath))
                continue;
            try {
                // mtime freshness is irrelevant per-read (reads are cheap + cached by
                // the OS); the catalog is rebuilt on demand and never long-lived.
                statSync(skillPath);
                const markdown = readFileSync(skillPath, 'utf-8');
                const fm = parseCatalogFrontmatter(markdown);
                const skill = {
                    id: entry.name,
                    name: fm.name || entry.name,
                    description: fm.description || 'No description in SKILL.md frontmatter.',
                    body: stripFrontmatter(markdown),
                    root,
                };
                // P6c — carry the depth fields when declared (undefined = no gate).
                if (fm.platforms && fm.platforms.length > 0)
                    skill.platforms = fm.platforms;
                if (fm.requiresToolsets && fm.requiresToolsets.length > 0)
                    skill.requiresToolsets = fm.requiresToolsets;
                if (fm.fallbackForToolsets && fm.fallbackForToolsets.length > 0)
                    skill.fallbackForToolsets = fm.fallbackForToolsets;
                if (fm.config && Object.keys(fm.config).length > 0)
                    skill.config = fm.config;
                if (fm.requiredEnvVars && fm.requiredEnvVars.length > 0)
                    skill.requiredEnvVars = fm.requiredEnvVars;
                out.push(skill);
            }
            catch {
                // A corrupt SKILL.md is skipped — never breaks the catalog.
            }
        }
        return out;
    }
    catch {
        return [];
    }
}
/**
 * Read the full hub catalog: project root wins over the home root when the
 * same skill name exists in both (a project-level pin shadows a stale home
 * copy). Never throws.
 */
export function readHubCatalog(projectRoot = process.cwd(), home = homedir()) {
    const roots = [
        { root: 'project', dir: join(projectRoot, '.agents', 'skills') },
        { root: 'home', dir: join(home, '.nuvira', 'skills') },
    ];
    const seen = new Set();
    const merged = [];
    for (const { root, dir } of roots) {
        for (const skill of scanRoot(root, dir)) {
            if (seen.has(skill.id))
                continue;
            seen.add(skill.id);
            merged.push(skill);
        }
    }
    return merged;
}
/** Read the `skills.disabled` exclusion list from buffconfig (never throws). */
export function readDisabledSkills(cm) {
    try {
        const cfg = cm?.getAll?.();
        const disabled = cfg?.skills?.disabled;
        return Array.isArray(disabled) ? disabled.filter((d) => typeof d === 'string') : [];
    }
    catch {
        return [];
    }
}
/**
 * Union of every known skill id: compiled SkillStore ids + installed hub
 * (SKILL.md) ids. Best-effort — a broken store can never throw out of the
 * writer (the typo-safety check then just falls back to the hub catalog).
 */
function knownSkillIds(projectRoot = process.cwd(), home = homedir()) {
    const ids = new Set();
    try {
        for (const s of readHubCatalog(projectRoot, home))
            ids.add(s.id);
    }
    catch {
        /* best-effort */
    }
    try {
        for (const s of getSkillStore().getAll())
            ids.add(s.id);
    }
    catch {
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
export function setSkillEnabled(id, enabled, cm, projectRoot = process.cwd(), home = homedir()) {
    if (!knownSkillIds(projectRoot, home).has(id)) {
        throw new Error(`Unknown skill '${id}' — run \`nuvira skills list\` to see known skills.`);
    }
    // Whole-list semantics (empty is meaningful): enable removes the id,
    // disable appends it — other entries are never clobbered.
    const current = readDisabledSkills(cm);
    const next = enabled
        ? current.filter((d) => d !== id)
        : current.includes(id) ? current : [...current, id];
    const save = cm?.save ? cm.save.bind(cm) : (config) => new ConfigManager().save(config);
    save({ skills: { disabled: next } });
}
/** P6c — normalize a process.platform value to the skill vocabulary. */
export function normalizePlatform(platform) {
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
export function platformAllows(skill, platform = process.platform) {
    if (!skill.platforms || skill.platforms.length === 0)
        return true;
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
export function toolsetAllows(skill, presentToolsets) {
    if ((!skill.requiresToolsets || skill.requiresToolsets.length === 0) &&
        (!skill.fallbackForToolsets || skill.fallbackForToolsets.length === 0)) {
        return true;
    }
    const present = presentToolsets ?? new Set(TOOLSET_NAMES);
    if (skill.requiresToolsets && skill.requiresToolsets.length > 0) {
        if (!skill.requiresToolsets.every((t) => present.has(t)))
            return false;
    }
    if (skill.fallbackForToolsets && skill.fallbackForToolsets.length > 0) {
        // A fallback is only for when the real toolset is GONE — if any named
        // toolset is present, the fallback is redundant and hidden.
        if (skill.fallbackForToolsets.some((t) => present.has(t)))
            return false;
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
export function listMatchableHubSkills(cm, projectRoot = process.cwd(), home = homedir(), platform = process.platform, presentToolsets) {
    const disabled = new Set(readDisabledSkills(cm));
    const present = presentToolsets ?? enabledToolsetNames(cm);
    return readHubCatalog(projectRoot, home).filter((s) => !disabled.has(s.id) && platformAllows(s, platform) && toolsetAllows(s, present));
}
/** Enabled toolset names (absent entry = enabled — the toolsets module rule). */
function enabledToolsetNames(cm) {
    try {
        const cfg = cm?.getAll?.();
        const state = cfg?.tools?.toolsets;
        if (!state || typeof state !== 'object')
            return new Set(TOOLSET_NAMES);
        return new Set(TOOLSET_NAMES.filter((t) => state[t]?.enabled !== false));
    }
    catch {
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
export function findHubSkillMatch(goal, cm, projectRoot = process.cwd(), home = homedir()) {
    const q = goal.toLowerCase();
    const skills = listMatchableHubSkills(cm, projectRoot, home);
    if (skills.length === 0)
        return null;
    const scored = skills.map((skill) => {
        let score = 0;
        // Name words (>3 chars) present in the goal.
        for (const word of skill.name.toLowerCase().split(/[^a-z0-9]+/)) {
            if (word.length > 3 && q.includes(word))
                score += 2;
        }
        // Description keywords.
        for (const word of skill.description.toLowerCase().split(/[^a-z0-9]+/)) {
            if (word.length > 3 && q.includes(word))
                score += 1.5;
        }
        // Skill id (directory name).
        if (q.includes(skill.id.toLowerCase()))
            score += 1;
        return { skill, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < 1)
        return null;
    logger.debug(`Hub catalog matched skill '${best.skill.name}' (score ${best.score})`);
    return {
        id: best.skill.id,
        name: best.skill.name,
        description: best.skill.description,
        body: best.skill.body,
    };
}
//# sourceMappingURL=hub-skill-catalog.js.map