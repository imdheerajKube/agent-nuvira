/**
 * P6b — Skill bundles (`src/learning/skill-bundles.ts`).
 *
 * Cross-skill composition (Hermes parity): a bundle groups N skills under one
 * id (`backend-dev` → code-review + tdd + pr-workflow) so the chat can load
 * several methodologies in ONE turn. The composition gap from the comparison:
 * agent-nuvira could only chain steps WITHIN a skill (dependsOn), never
 * compose whole skills.
 *
 * Storage: `~/.nuvira/skill-bundles/<slug>.yaml` — one small YAML file per
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
/**
 * Default bundles root: NUVIRA_MEMORY_DIR (when set) → ~/.nuvira/skill-bundles.
 * Resolved LAZILY so tests can set the env before the first read (the same
 * pattern cache.ts / skill-drafts use) — production is identical when unset.
 */
export declare function defaultBundlesRoot(): string;
/**
 * Serialize a bundle to the strict YAML subset this module reads back.
 * Values are escaped so a skill name containing YAML-significant characters
 * (a colon, a leading dash, a quote) can never corrupt the file.
 */
export declare function serializeBundle(b: Omit<SkillBundle, 'createdAt' | 'updatedAt'>): string;
/**
 * Parse a bundle file written by serializeBundle (or hand-edited to the same
 * grammar). Returns null for anything that does not match — a corrupt bundle
 * is skipped, never fatal.
 */
export declare function parseBundleYaml(slug: string, raw: string): Omit<SkillBundle, 'createdAt' | 'updatedAt'> | null;
/**
 * List every bundle on disk (sorted by name). Never throws — a missing or
 * unreadable dir contributes nothing.
 */
export declare function listBundles(root?: string): SkillBundle[];
/** Get one bundle by slug (null when missing or corrupt). */
export declare function getBundle(slug: string, root?: string): SkillBundle | null;
/**
 * Create (or overwrite) a bundle. Validates the slug allowlist and that at
 * least one member skill is named. Returns { ok: false, reason } instead of
 * throwing — the CLI and the skill tool both read this shape.
 */
export declare function writeBundle(input: {
    slug: string;
    name?: string;
    description?: string;
    skills: string[];
}, root?: string): BundleWriteResult;
/** Delete a bundle by slug. Returns true when something was removed. */
export declare function deleteBundle(slug: string, root?: string): boolean;
//# sourceMappingURL=skill-bundles.d.ts.map