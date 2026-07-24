/**
 * SkillStore — Persists and manages compiled skills on disk.
 *
 * Skills are stored as individual JSON files in ~/.buff/skills/
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
    private loadIndex;
    private saveIndex;
}
export declare function getSkillStore(): SkillStore;
export declare function resetSkillStore(): void;
//# sourceMappingURL=skill-store.d.ts.map