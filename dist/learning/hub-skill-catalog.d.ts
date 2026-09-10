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
import { ConfigManager } from '../config/manager.js';
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
}
/** The skill-guidance payload handed to the planner (Level 1 on match). */
export interface HubSkillMatch {
    id: string;
    name: string;
    description: string;
    /** SKILL.md body — the methodology to adapt (never literal commands). */
    body: string;
}
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
/** Parse `---` frontmatter (P6c depth: platforms, toolsets, config, env vars). */
export declare function parseCatalogFrontmatter(markdown: string): CatalogFrontmatter;
/**
 * Read the full hub catalog: project root wins over the home root when the
 * same skill name exists in both (a project-level pin shadows a stale home
 * copy). Never throws.
 */
export declare function readHubCatalog(projectRoot?: string, home?: string): HubCatalogSkill[];
/** Read the `skills.disabled` exclusion list from buffconfig (never throws). */
export declare function readDisabledSkills(cm?: ConfigManager): string[];
/**
 * P3 — Persist a skill's enabled state (Agent Hub Skills tab toggle).
 *
 * Writes the SAME `skills.disabled[]` list the match gates read: the hub
 * catalog filters it in `listMatchableHubSkills` and the orchestrator gates
 * compiled `findMatch` results against it, so the toggle is NEVER cosmetic.
 * Throws for an unknown skill id (typo-safe, mirrors `setToolsetEnabled`).
 */
export declare function setSkillEnabled(id: string, enabled: boolean, cm?: ConfigManager, projectRoot?: string, home?: string): void;
/** P6c — normalize a process.platform value to the skill vocabulary. */
export declare function normalizePlatform(platform: string): string;
/**
 * P6c — platform gate: a skill declaring `platforms:` is hidden on an
 * incompatible OS. Undeclared = visible everywhere. The declared list and the
 * runtime platform are both normalized (`darwin`≡`macos`, `win32`≡`windows`).
 */
export declare function platformAllows(skill: HubCatalogSkill, platform?: NodeJS.Platform): boolean;
/**
 * P6c — toolset gate (conditional activation):
 *   - `requires_toolsets: [t]` → hidden unless EVERY named toolset is present.
 *   - `fallback_for_toolsets: [t]` → visible ONLY when the named toolset is
 *     ABSENT (the skill provides what that toolset would — e.g. a search
 *     fallback shows only when the web toolset is off).
 * `presentToolsets` defaults to every catalog toolset (the CLI/dashboard pass
 * the ENABLED set so a disabled toolset hides its dependents).
 */
export declare function toolsetAllows(skill: HubCatalogSkill, presentToolsets?: Set<string>): boolean;
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
export declare function listMatchableHubSkills(cm?: ConfigManager, projectRoot?: string, home?: string, platform?: NodeJS.Platform, presentToolsets?: Set<string>): HubCatalogSkill[];
/**
 * Find the best hub-skill match for a goal (keyword scoring over name +
 * description + body headings — the same "manual discovery" threshold the
 * compiled store uses; the orchestrator applies its tighter activation gate).
 * Returns null when no skill scores ≥ 1 (never a forced match).
 */
export declare function findHubSkillMatch(goal: string, cm?: ConfigManager, projectRoot?: string, home?: string): HubSkillMatch | null;
//# sourceMappingURL=hub-skill-catalog.d.ts.map