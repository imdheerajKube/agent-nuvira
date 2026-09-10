/**
 * DriftDetector — Detect external modifications to memory files.
 *
 * Prevents data corruption by detecting when memory files have been
 * modified outside of the memory tools (e.g., by patch tool, shell append,
 * manual edit, or concurrent session).
 *
 * Features:
 * - Checksum-based drift detection
 * - Snapshot backup before writes
 * - Automatic rollback on drift
 * - Audit logging
 */
interface FileSnapshot {
    path: string;
    checksum: string;
    content: string;
    timestamp: number;
}
interface DriftEvent {
    path: string;
    expectedChecksum: string;
    actualChecksum: string;
    timestamp: number;
    action: 'detected' | 'rolled_back' | 'merged';
}
export declare class DriftDetector {
    private snapshots;
    private driftLog;
    private memoryDir;
    constructor(memoryDir?: string);
    /**
     * Record a snapshot of a file before writing.
     */
    snapshot(filePath: string): FileSnapshot | null;
    /**
     * Check for drift before writing.
     */
    checkDrift(filePath: string): {
        hasDrift: boolean;
        currentChecksum: string;
        expectedChecksum: string;
        currentContent?: string;
    };
    /**
     * Create a backup before writing.
     */
    backup(filePath: string): string | null;
    /**
     * Restore from backup.
     */
    restore(backupPath: string): boolean;
    /**
     * Merge external changes with our changes.
     */
    merge(filePath: string, ourContent: string, theirContent: string): string;
    /**
     * Compute checksum for content.
     */
    private computeChecksum;
    /**
     * Get drift log.
     */
    getDriftLog(limit?: number): DriftEvent[];
    /**
     * Get snapshot for a file.
     */
    getSnapshot(filePath: string): FileSnapshot | null;
    /**
     * Clear old snapshots.
     */
    clearOldSnapshots(maxAgeMs?: number): number;
}
export declare function getDriftDetector(): DriftDetector;
export {};
//# sourceMappingURL=drift-detector.d.ts.map