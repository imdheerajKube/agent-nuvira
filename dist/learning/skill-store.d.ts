/**
 * SkillStore — Persists and manages compiled skills on disk.
 *
 * Skills are stored as individual JSON files in ~/.nuvira/skills/
 * Each skill gets its own file for easy inspection and manual editing.
 * An index.json file tracks the full list for fast enumeration.
 *
 * The store also provides:
 * - Decay-based quality scoring (skills lose relevance over time)
 * - Usage tracking (skills used more often are retained longer)
 * - Search by tags, goal pattern, or name
 * - Garbage collection for low-quality/expired skills
 */
import type { Skill, SkillSummary } from './skill-types.js';
/**
 * Manages storage, retrieval, and lifecycle of compiled skills.
 *
 * Skills are stored as individual JSON files for transparency.
 * An index provides fast enumeration without reading all files.
 */
export declare class SkillStore {
    private index;
    constructor();
    /**
     * Install first-party bundled skills (src/skills/bundled-skills.ts) into the
     * user skill store. Idempotent — a bundled skill whose version matches the
     * on-disk version is NOT overwritten (preserves user edits and usage stats);
     * a newer bundled version replaces the older one.
     *
     * @returns The number of skills seeded/updated.
     */
    seedBundledSkills(): number;
    /**
     * Save a skill to disk. Creates both the individual file and updates the index.
     * If a skill with the same ID already exists, it's overwritten.
     */
    save(skill: Skill): void;
    /**
     * Load a skill by ID from its individual file.
     * Returns null if the file doesn't exist or is corrupt.
     */
    get(id: string): Skill | null;
    /**
     * Get all skills, optionally filtered by minimum quality score.
     * Loads full skill data for all indexed skills.
     */
    getAll(minQualityScore?: number): Skill[];
    /**
     * Find skills relevant to a given goal or tag query.
     * Matches against name, description, goalPattern, and tags.
     */
    search(query: string): Skill[];
    /**
     * Find the best skill match for a given goal.
     * Uses keyword matching against goalPattern and tags.
     */
    findMatch(goal: string): Skill | null;
    /**
     * Mark a skill as used (updates usage count and timestamp).
     */
    markUsed(id: string): void;
    /**
     * Delete a skill by ID. Removes both the file and index entry.
     */
    delete(id: string): boolean;
    /**
     * Compute a decay score for a skill based on age and usage.
     * Returns a score from 0 (expired) to 1 (fresh).
     */
    computeDecayScore(skill: Skill): number;
    /**
     * Garbage-collect low-quality skills.
     * Returns the number of skills removed.
     */
    garbageCollect(verbose?: boolean): number;
    /**
     * Get summary statistics about stored skills.
     */
    getSummary(): SkillSummary;
    /**
     * Clear all skills.
     */
    clear(): void;
    /**
     * Get quality report for monitoring.
     */
    getQualityReport(): Array<{
        id: string;
        name: string;
        decayScore: number;
        usageCount: number;
        ageDays: number;
    }>;
    /**
     * skill_view() — Progressive disclosure for skills.
     *
     * Hermes pattern: skills_list() returns name+description (lightweight),
     * skill_view(name) returns full methodology (heavyweight).
     *
     * This function returns the full skill content for a given skill name,
     * formatted as structured guidance that an agent can follow.
     *
     * @param name - Skill name or ID to view
     * @param filePath - Optional specific file within skill directory (e.g., 'references/api.md')
     * @returns Full skill content as structured text, or error message
     */
    skillView(name: string, filePath?: string): string;
    /**
     * Find the reference docs directory for a skill.
     * Checks .agents/skills/<skill-name>/references/ directory.
     */
    private findReferenceDocsDir;
    /**
     * List available reference files for a skill.
     */
    private listReferenceFiles;
    /**
     * Load a specific reference file for a skill.
     */
    private loadReferenceFile;
    /**
     * Format a skill into structured guidance text for an agent.
     * This is the Hermes-style progressive disclosure output.
     * Now includes actual reference docs loading from disk.
     */
    private formatSkillView;
    private loadIndex;
    private saveIndex;
}
export declare function getSkillStore(): SkillStore;
export declare function resetSkillStore(): void;
//# sourceMappingURL=skill-store.d.ts.map