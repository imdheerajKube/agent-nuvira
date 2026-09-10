/**
 * I7 P1 — Multi-source skill registry (`src/learning/skills-registry.ts`).
 *
 * Browse-hub equivalent: skills can be discovered from MORE than one registry.
 * Source adapters normalize every registry shape into the HubSkillEntry
 * contract so search + install behave identically regardless of origin.
 *
 * Source kinds:
 *   - github-raw — the legacy layout (`{base}/index.json` + `{base}/<n>/SKILL.md`).
 *   - local-dir  — a plain folder with the same layout (offline / team shares).
 *   - browse-sh  — the browse.sh API (external browse-hub; mapped to the
 *     HubSkillEntry shape).
 *   - git-repo   — a git repository (any layout) cloned shallowly into
 *     `~/.nuvira/skills-hub/repos/<hash>/`; the skills root is auto-detected
 *     (repo root / `skills/` / `.claude/skills/` / `.agents/skills/`).
 *
 * Configuration (buffconfig `skills.registries[]`, ordered = priority):
 *   ["https://raw.githubusercontent.com/OWNER/REPO/main/.agents/skills",
 *    "https://browse.sh/api/skills",
 *    "git+https://github.com/OWNER/skills-repo",
 *    "file:///path/to/team-skills"]
 * The legacy `BUFF_SKILLS_REGISTRY` env override remains the single-value
 * fallback when `registries[]` is absent.
 */
import { ConfigManager } from '../config/manager.js';
import type { HubSkillEntry } from './skills-hub.js';
/** A normalized registry source. */
export interface RegistrySource {
    /** Canonical source id: 'github-raw' | 'local-dir' | 'browse-sh' | 'git-repo'. */
    kind: 'github-raw' | 'local-dir' | 'browse-sh' | 'git-repo';
    /** The configured base (URL, path, or git+ URL). */
    base: string;
}
/** Where a result came from (surfaced in search + install provenance). */
export interface RegistryResult<T> {
    source: RegistrySource;
    value: T;
}
/**
 * P5c #3 — per-source registry reachability. The configured default used to
 * silently 404 ("No skills found") — the probe surfaces WHERE each source
 * failed and with what HTTP status, so the CLI can say so instead of
 * pretending the registry is empty.
 */
export interface RegistryProbe {
    source: RegistrySource;
    /** True when the source's index could be fetched/read and parsed. */
    reachable: boolean;
    /** HTTP status when a remote index fetch answered (404 = the default 404). */
    status?: number;
    /** 'http-error' | 'network' | 'missing-index' | 'invalid-index' | 'clone-failed' | 'no-skills-root'. */
    reason?: string;
    /** Number of skills the source's index exposes. */
    entryCount: number;
}
/** Detect a source's kind from its configured base string. */
export declare function detectSourceKind(base: string): RegistrySource['kind'];
/**
 * The configured registry list: buffconfig `skills.registries[]` wins; else
 * the legacy BUFF_SKILLS_REGISTRY env override; else the PACKAGED
 * `.agents/skills/` dir (ships in the npm package + repo checkout — the
 * default resolves from the install itself, private-repo-independent); else
 * the GitHub raw URL as last-resort fallback.
 */
export declare function configuredRegistries(cm?: ConfigManager): string[];
/** Build a ConfigManager against a custom config dir (hermetic tests). */
export declare function configManagerAt(configDir: string): ConfigManager;
/** All sources with their detected kinds. */
export declare function allSources(cm?: ConfigManager): RegistrySource[];
/** Fetch the index from ONE source (normalized to HubSkillEntry[]). */
export declare function fetchSourceIndex(source: RegistrySource): Promise<HubSkillEntry[]>;
/** Fetch one SKILL.md from a specific source (null = not found there). */
export declare function fetchSourceSkill(source: RegistrySource, name: string): Promise<string | null>;
/**
 * Probe every configured registry's reachability (status-aware).
 *
 * - local-dir  → index.json present + parseable?
 * - github-raw / browse-sh → HTTP fetch of index.json, recording res.status
 * - git-repo   → clone succeeds AND a skills root is found?
 *
 * Used by the CLI's empty-result paths: when a source is unreachable the user
 * is told WHICH source failed and how to fix it (configure skills.registries[]
 * or BUFF_SKILLS_REGISTRY) — never a silent "no skills found".
 */
export declare function probeRegistries(cm?: ConfigManager): Promise<RegistryProbe[]>;
/**
 * Human-readable fix hint for unreachable registries — the CLI appends this
 * to empty-result messages so a 404 is EXPLICIT, never silent.
 */
export declare function unreachableRegistryHint(probes: RegistryProbe[]): string;
/**
 * Search ALL configured registries, deduped by name (first registry wins).
 * Optionally restrict to one source kind (e.g. --source browse-sh).
 */
export declare function searchAllRegistries(query: string, opts?: {
    sourceKind?: string;
    cm?: ConfigManager;
}): Promise<Array<HubSkillEntry & {
    sourceKind: string;
}>>;
/** Find ONE entry by name across all registries (priority order). */
export declare function findEntryAcrossRegistries(name: string, opts?: {
    sourceKind?: string;
    cm?: ConfigManager;
}): Promise<RegistryResult<HubSkillEntry> | null>;
/**
 * Install a skill from a SPECIFIC source. Reuses the sandboxed install path
 * (name validation, frontmatter checks, checksum + provenance) from
 * skills-hub.ts; the source's fetch is injected so provenance records where
 * the skill actually came from.
 */
export declare function installFromSource(entry: HubSkillEntry, source: RegistrySource, projectRoot?: string, force?: boolean): Promise<{
    ok: boolean;
    name: string;
    version?: string;
    source?: string;
    quarantined?: boolean;
    reason?: string;
}>;
//# sourceMappingURL=skills-registry.d.ts.map