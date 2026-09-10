/**
 * Skills Sync — Manifest-based seeding and updating of bundled skills.
 *
 * Hermes equivalent: skills_sync.py (1,410 lines)
 *
 * Provides:
 * - Manifest-based skill syncing
 * - Content hash tracking
 * - Safe update logic (skip user-customized)
 * - Auto-migration from v1 manifests
 * - External skill directory awareness
 */
export interface SyncManifest {
    [skillName: string]: string;
}
export interface SyncResult {
    synced: string[];
    skipped: string[];
    deleted: string[];
    errors: Array<{
        skill: string;
        error: string;
    }>;
}
export declare class SkillsSyncManager {
    private manifestFile;
    private bundledDir;
    private targetDir;
    constructor(options?: {
        bundledDir?: string;
        targetDir?: string;
    });
    /**
     * Load manifest from disk.
     */
    private loadManifest;
    /**
     * Save manifest to disk.
     */
    private saveManifest;
    /**
     * Calculate content hash of a skill directory.
     */
    private calculateHash;
    /**
     * Sync skills from bundled to target.
     */
    sync(externalDirs?: string[]): Promise<SyncResult>;
    /**
     * Get sync status.
     */
    getStatus(): {
        total: number;
        synced: number;
        manifestFile: string;
    };
    /**
     * Force re-sync a specific skill.
     */
    forceSync(skillName: string): Promise<boolean>;
}
export declare function getSkillsSyncManager(options?: {
    bundledDir?: string;
    targetDir?: string;
}): SkillsSyncManager;
export declare function resetSkillsSyncManager(): void;
//# sourceMappingURL=skills-sync.d.ts.map