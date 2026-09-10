/**
 * Skill Provenance — Tracks skill origin, integrity, and version history.
 *
 * This provides:
 * - SHA-256 hash verification for skill files
 * - Version history tracking
 * - Origin tracking (bundled, marketplace, local)
 * - Tamper detection
 * - Audit trail for skill changes
 *
 * Flow:
 * 1. When a skill is installed, compute its SHA-256 hash
 * 2. Store the hash in provenance metadata
 * 3. On each load, verify the hash matches
 * 4. If hash mismatch, flag as potentially tampered
 * 5. Log all changes for audit trail
 */
export interface ProvenanceEntry {
    /** Skill name */
    skillName: string;
    /** SHA-256 hash of the skill file */
    hash: string;
    /** Skill origin */
    origin: 'bundled' | 'marketplace' | 'local';
    /** Version (if known) */
    version?: string;
    /** Author (if known) */
    author?: string;
    /** Timestamp when provenance was recorded */
    recordedAt: number;
    /** Timestamp when skill was last modified */
    lastModified: number;
    /** File path */
    filePath: string;
    /** Previous hash (for version history) */
    previousHash?: string;
    /** Verification status */
    verified: boolean;
}
export interface ProvenanceStore {
    /** Map of skill name to provenance entries */
    entries: Record<string, ProvenanceEntry>;
    /** Store version */
    version: number;
    /** Last updated timestamp */
    updatedAt: number;
}
/**
 * Compute SHA-256 hash of content.
 */
export declare function computeHash(content: string): string;
/**
 * Compute SHA-256 hash of a file.
 */
export declare function computeFileHash(filePath: string): Promise<string>;
/**
 * Verify that content matches expected hash.
 */
export declare function verifyHash(content: string, expectedHash: string): boolean;
/**
 * Verify that a file matches expected hash.
 */
export declare function verifyFileHash(filePath: string, expectedHash: string): Promise<{
    verified: boolean;
    actualHash: string;
}>;
/**
 * Record provenance for a skill.
 */
export declare function recordProvenance(params: {
    skillName: string;
    filePath: string;
    origin: 'bundled' | 'marketplace' | 'local';
    version?: string;
    author?: string;
}): Promise<ProvenanceEntry>;
/**
 * Verify provenance for a skill.
 */
export declare function verifyProvenance(skillName: string, filePath: string): Promise<{
    verified: boolean;
    entry: ProvenanceEntry | null;
    reason?: string;
}>;
/**
 * Get provenance for a skill.
 */
export declare function getProvenance(skillName: string): Promise<ProvenanceEntry | null>;
/**
 * Get all provenance entries.
 */
export declare function getAllProvenance(): Promise<ProvenanceEntry[]>;
/**
 * Get provenance statistics.
 */
export declare function getProvenanceStats(): Promise<{
    total: number;
    byOrigin: Record<string, number>;
    verified: number;
    unverified: number;
}>;
/**
 * Remove provenance for a skill.
 */
export declare function removeProvenance(skillName: string): Promise<boolean>;
/**
 * Update provenance (e.g., after skill update).
 */
export declare function updateProvenance(skillName: string, filePath: string, updates: Partial<Pick<ProvenanceEntry, 'version' | 'author'>>): Promise<ProvenanceEntry | null>;
/**
 * Export provenance for backup.
 */
export declare function exportProvenance(): Promise<string>;
/**
 * Import provenance from backup.
 */
export declare function importProvenance(data: string): Promise<void>;
/**
 * Get version history for a skill.
 */
export declare function getVersionHistory(skillName: string): Promise<ProvenanceEntry[]>;
//# sourceMappingURL=skill-provenance.d.ts.map