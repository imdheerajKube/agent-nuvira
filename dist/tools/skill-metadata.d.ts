/**
 * Skill Metadata — Usage tracking and provenance management.
 *
 * Hermes equivalents:
 * - skill_usage.py (1,340 lines) — Skill usage tracking
 * - skill_provenance.py (78 lines) — Skill origin tracking
 *
 * Provides:
 * - Track skill usage (count, last used, context)
 * - Provenance tracking (origin, author, version)
 * - Usage analytics (most used, recently used)
 * - Provenance verification
 */
export interface SkillUsage {
    name: string;
    count: number;
    lastUsed: number;
    firstUsed: number;
    contexts: string[];
    tokensUsed: number;
    averageTokensPerUse: number;
}
export interface SkillProvenance {
    name: string;
    source: 'bundled' | 'hub' | 'local' | 'git';
    sourceUrl?: string;
    author?: string;
    version?: string;
    installedAt: number;
    installedBy?: string;
    verified: boolean;
}
export declare class SkillUsageTracker {
    private usageFile;
    private usage;
    constructor();
    private load;
    private save;
    /**
     * Record a skill usage.
     */
    record(skillName: string, context?: string, tokens?: number): void;
    /**
     * Get usage for a skill.
     */
    get(skillName: string): SkillUsage | null;
    /**
     * Get all usage.
     */
    getAll(): SkillUsage[];
    /**
     * Get most used skills.
     */
    getMostUsed(limit?: number): SkillUsage[];
    /**
     * Get recently used skills.
     */
    getRecentlyUsed(limit?: number): SkillUsage[];
    /**
     * Get usage stats.
     */
    getStats(): {
        totalSkills: number;
        totalUses: number;
        totalTokens: number;
    };
}
export declare class SkillProvenanceManager {
    private provenanceFile;
    private provenance;
    constructor();
    private load;
    private save;
    /**
     * Record skill provenance.
     */
    record(prov: SkillProvenance): void;
    /**
     * Get provenance for a skill.
     */
    get(skillName: string): SkillProvenance | null;
    /**
     * Get all provenance records.
     */
    getAll(): SkillProvenance[];
    /**
     * Verify provenance (check if skill matches recorded hash).
     */
    verify(skillName: string, currentHash: string): {
        verified: boolean;
        reason?: string;
    };
    /**
     * Remove provenance record.
     */
    remove(skillName: string): boolean;
}
export declare function getSkillUsageTracker(): SkillUsageTracker;
export declare function getSkillProvenanceManager(): SkillProvenanceManager;
export declare function resetSkillMetadata(): void;
//# sourceMappingURL=skill-metadata.d.ts.map