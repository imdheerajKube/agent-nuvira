/**
 * J3 — Skills hub + sync (`src/learning/skills-hub.ts`).
 *
 * A community-skill hub with
 * `.agents/skills` + `npx skills add` flow: discover, install, update, and
 * audit community skills from a configurable registry.
 *
 * Registry layout (same shape as the workflow registry):
 *   .agents/skills/index.json          — master index (HubSkillEntry[])
 *   .agents/skills/<name>/SKILL.md     — the skill (markdown w/ frontmatter)
 *   .agents/skills/<name>/manifest.json — optional extra metadata (author, tags)
 *
 * Security model (mirrors `skills_hub.py`):
 * - **Sandboxed install**: skill names are validated (`^[a-z0-9-]+$`) and the
 *   target path is always `<project>/.agents/skills/<name>/` — no traversal.
 * - **Provenance + checksum**: every install records `{source, version,
 *   installedAt, sha256, origin}` in `~/.nuvira/skills-hub/provenance.json`; the
 *   checksum is re-verified on update and a mismatch quarantines the skill
 *   (moved to `~/.nuvira/skills-hub/quarantine/`) instead of overwriting.
 * - **Availability-gated**: unset registry → the built-in default (GitHub raw);
 *   `BUFF_SKILLS_REGISTRY` overrides (can point at a local dir for offline use).
 * - Registry index cached with a 1h TTL (same as workflow registry).
 */
/** A skill entry in the registry index. */
export interface HubSkillEntry {
    /** Skill name — must match `^[a-z0-9-]+$` (the sandbox allowlist). */
    name: string;
    /** One-line description. */
    description: string;
    /** Semantic version (e.g. "1.0.0"). */
    version: string;
    /** Author name or GitHub handle. */
    author: string;
    /** Tags for search/filter. */
    tags: string[];
    /** Source identifier: "owner/repo" (or "local:<dir>" for a local registry). */
    source: string;
    /** When the skill was last updated (ISO string). */
    updatedAt: string;
}
/** Provenance record for an installed skill. */
export interface SkillProvenance {
    name: string;
    source: string;
    version: string;
    installedAt: number;
    /** SHA-256 of the installed SKILL.md (content-addressed trust). */
    sha256: string;
    origin: 'registry' | 'local';
}
/**
 * The packaged `.agents/skills/` registry dir (npm-installed or repo
 * checkout) — `file://` base when present, null when absent. Resolved from
 * the module location: dev (tsx) src/learning → ../../ = repo root;
 * compiled dist/learning → ../../ = package root. Both carry `.agents/skills`
 * (committed in the repo, shipped in the npm tarball via package.json files).
 */
export declare function packagedRegistryDir(): string | null;
/** Record provenance for one skill (replace any previous record of same name). */
export declare function recordSkillProvenance(record: SkillProvenance): void;
/**
 * Fetch a registry index (with TTL caching). `base` defaults to the legacy
 * registry resolution (BUFF_SKILLS_REGISTRY env → built-in default); the I7
 * P1 multi-source path passes an explicit base per source. Local-dir
 * registries read the index directly from disk; remote ones fetch over HTTP.
 */
export declare function fetchHubIndex(base?: string): Promise<HubSkillEntry[]>;
/** Search the registry index for skills matching a query. */
export declare function searchHubSkills(query: string): Promise<HubSkillEntry[]>;
/** Result of an install/update attempt. */
export interface SkillInstallResult {
    ok: boolean;
    name: string;
    version?: string;
    source?: string;
    quarantined?: boolean;
    reason?: string;
}
/**
 * Read a skill file (SKILL.md) from a registry base (local-dir or HTTP).
 * Exported so the I7 P1 multi-source registry can fetch per-source.
 */
export declare function fetchSkillFile(registry: string, path: string): Promise<string | null>;
/**
 * Install a skill into `<project>/.agents/skills/<name>/` (sandboxed: the name
 * must match `^[a-z0-9-]+$`). Records provenance + checksum; a checksum
 * mismatch on REINSTALL quarantines the incoming copy instead of overwriting.
 * Pass `force: true` (the explicit `nuvira skills update` path) to overwrite
 * instead of quarantine — an explicit update is the user saying "bring this
 * skill to the registry's latest".
 *
 * @param entry       The registry entry to install.
 * @param projectRoot Project root for the `.agents/skills/` target.
 * @param force       Overwrite an existing skill whose content changed.
 * @param overrides   I7 P1 multi-source: an explicit fetch + registry label
 *                    (the source adapter). Absent → legacy env/base path.
 */
export declare function installHubSkill(entry: HubSkillEntry, projectRoot?: string, force?: boolean, overrides?: {
    fetchSkill?: (name: string) => Promise<string | null>;
    registry?: string;
}): Promise<SkillInstallResult>;
/**
 * Remove an installed skill: deletes `<project>/.agents/skills/<name>/` AND
 * its provenance record (P6d — the dashboard marketplace's uninstall button
 * and `nuvira skills uninstall`). Sandboxed like install: the name must match
 * `^[a-z0-9-]+$` and the target is always inside the skills root.
 *
 * @returns { ok, reason? } — ok:false only when the skill is not installed
 *          (nothing to remove) or a removal failed.
 */
export declare function uninstallHubSkill(name: string, projectRoot?: string): {
    ok: boolean;
    name: string;
    reason?: string;
};
/**
 * Check installed skills against the registry and reinstall any with a newer
 * version. Returns a summary of what was updated / already current.
 */
export declare function updateHubSkills(projectRoot?: string): Promise<{
    updated: string[];
    current: string[];
    failed: string[];
}>;
/**
 * List installed skills with their provenance origin (registry vs local).
 * If `origin` is given, filter to that origin.
 */
export declare function listHubSkills(origin?: 'registry' | 'local', projectRoot?: string): Array<{
    name: string;
    source: string;
    version: string;
    installedAt: number;
    origin: 'registry' | 'local';
    installed: boolean;
}>;
/** Clear ALL per-source index caches (forces a re-fetch on the next search). */
export declare function clearSkillsIndexCache(): void;
/** Validate + normalize a registry entry's skill name (used by the CLI). */
export declare function isValidSkillName(name: string): boolean;
/** Resolve a HubSkillEntry from the index by name (used by the CLI). */
export declare function getHubSkillEntry(name: string): Promise<HubSkillEntry | null>;
//# sourceMappingURL=skills-hub.d.ts.map