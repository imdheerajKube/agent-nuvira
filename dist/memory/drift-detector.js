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
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
// ─── Drift Detector ─────────────────────────────────────────────────────────
export class DriftDetector {
    snapshots = new Map();
    driftLog = [];
    memoryDir;
    constructor(memoryDir) {
        this.memoryDir = memoryDir || path.join(process.env.HOME || '~', '.nuvira', 'memory');
    }
    /**
     * Record a snapshot of a file before writing.
     */
    snapshot(filePath) {
        try {
            if (!fs.existsSync(filePath)) {
                return null;
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            const checksum = this.computeChecksum(content);
            const snapshot = {
                path: filePath,
                checksum,
                content,
                timestamp: Date.now(),
            };
            this.snapshots.set(filePath, snapshot);
            return snapshot;
        }
        catch {
            return null;
        }
    }
    /**
     * Check for drift before writing.
     */
    checkDrift(filePath) {
        const snapshot = this.snapshots.get(filePath);
        if (!snapshot) {
            // No snapshot, can't detect drift
            return {
                hasDrift: false,
                currentChecksum: '',
                expectedChecksum: '',
            };
        }
        try {
            if (!fs.existsSync(filePath)) {
                // File was deleted
                return {
                    hasDrift: true,
                    currentChecksum: '',
                    expectedChecksum: snapshot.checksum,
                };
            }
            const currentContent = fs.readFileSync(filePath, 'utf-8');
            const currentChecksum = this.computeChecksum(currentContent);
            const hasDrift = currentChecksum !== snapshot.checksum;
            if (hasDrift) {
                this.driftLog.push({
                    path: filePath,
                    expectedChecksum: snapshot.checksum,
                    actualChecksum: currentChecksum,
                    timestamp: Date.now(),
                    action: 'detected',
                });
            }
            return {
                hasDrift,
                currentChecksum,
                expectedChecksum: snapshot.checksum,
                currentContent,
            };
        }
        catch {
            return {
                hasDrift: false,
                currentChecksum: '',
                expectedChecksum: snapshot.checksum,
            };
        }
    }
    /**
     * Create a backup before writing.
     */
    backup(filePath) {
        try {
            if (!fs.existsSync(filePath)) {
                return null;
            }
            const backupPath = `${filePath}.bak.${Date.now()}`;
            fs.copyFileSync(filePath, backupPath);
            return backupPath;
        }
        catch {
            return null;
        }
    }
    /**
     * Restore from backup.
     */
    restore(backupPath) {
        try {
            if (!fs.existsSync(backupPath)) {
                return false;
            }
            const originalPath = backupPath.replace(/\.bak\.\d+$/, '');
            fs.copyFileSync(backupPath, originalPath);
            // Update snapshot
            this.snapshot(originalPath);
            this.driftLog.push({
                path: originalPath,
                expectedChecksum: '',
                actualChecksum: '',
                timestamp: Date.now(),
                action: 'rolled_back',
            });
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Merge external changes with our changes.
     */
    merge(filePath, ourContent, theirContent) {
        // Simple merge strategy: prefer ours for conflicts
        // In production, use a proper merge algorithm
        const ourLines = ourContent.split('\n');
        const theirLines = theirContent.split('\n');
        // Simple line-based merge
        const merged = [];
        const maxLength = Math.max(ourLines.length, theirLines.length);
        for (let i = 0; i < maxLength; i++) {
            const ourLine = ourLines[i];
            const theirLine = theirLines[i];
            if (ourLine === theirLine) {
                merged.push(ourLine || '');
            }
            else if (ourLine !== undefined && theirLine !== undefined) {
                // Conflict - prefer ours
                merged.push(ourLine);
                merged.push(`<!-- DRIFT CONFLICT: ${theirLine} -->`);
            }
            else if (ourLine !== undefined) {
                merged.push(ourLine);
            }
            else {
                merged.push(theirLine);
            }
        }
        this.driftLog.push({
            path: filePath,
            expectedChecksum: '',
            actualChecksum: '',
            timestamp: Date.now(),
            action: 'merged',
        });
        return merged.join('\n');
    }
    /**
     * Compute checksum for content.
     */
    computeChecksum(content) {
        return crypto.createHash('sha256').update(content).digest('hex');
    }
    /**
     * Get drift log.
     */
    getDriftLog(limit = 50) {
        return this.driftLog.slice(-limit);
    }
    /**
     * Get snapshot for a file.
     */
    getSnapshot(filePath) {
        return this.snapshots.get(filePath) || null;
    }
    /**
     * Clear old snapshots.
     */
    clearOldSnapshots(maxAgeMs = 3600_000) {
        const cutoff = Date.now() - maxAgeMs;
        let cleared = 0;
        for (const [path, snapshot] of this.snapshots) {
            if (snapshot.timestamp < cutoff) {
                this.snapshots.delete(path);
                cleared++;
            }
        }
        return cleared;
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let _instance = null;
export function getDriftDetector() {
    if (!_instance)
        _instance = new DriftDetector();
    return _instance;
}
//# sourceMappingURL=drift-detector.js.map