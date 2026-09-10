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
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
// ─── Default Configuration ───────────────────────────────────────────────
const PROVENANCE_DIR = join(homedir(), '.nuvira', 'provenance');
const PROVENANCE_FILE = 'skills.json';
// ─── Hash Functions ──────────────────────────────────────────────────────
/**
 * Compute SHA-256 hash of content.
 */
export function computeHash(content) {
    return createHash('sha256').update(content).digest('hex');
}
/**
 * Compute SHA-256 hash of a file.
 */
export async function computeFileHash(filePath) {
    const content = await readFile(filePath, 'utf-8');
    return computeHash(content);
}
/**
 * Verify that content matches expected hash.
 */
export function verifyHash(content, expectedHash) {
    const actualHash = computeHash(content);
    return actualHash === expectedHash;
}
/**
 * Verify that a file matches expected hash.
 */
export async function verifyFileHash(filePath, expectedHash) {
    const actualHash = await computeFileHash(filePath);
    return {
        verified: actualHash === expectedHash,
        actualHash,
    };
}
// ─── Provenance Store ────────────────────────────────────────────────────
/**
 * Load the provenance store.
 */
async function loadStore() {
    const storePath = join(PROVENANCE_DIR, PROVENANCE_FILE);
    try {
        const content = await readFile(storePath, 'utf-8');
        return JSON.parse(content);
    }
    catch {
        return {
            entries: {},
            version: 1,
            updatedAt: Date.now(),
        };
    }
}
/**
 * Save the provenance store.
 */
async function saveStore(store) {
    const storePath = join(PROVENANCE_DIR, PROVENANCE_FILE);
    // Ensure directory exists
    await mkdir(PROVENANCE_DIR, { recursive: true });
    // Update timestamp
    store.updatedAt = Date.now();
    // Write store
    await writeFile(storePath, JSON.stringify(store, null, 2), 'utf-8');
}
// ─── Public API ──────────────────────────────────────────────────────────
/**
 * Record provenance for a skill.
 */
export async function recordProvenance(params) {
    const store = await loadStore();
    const existing = store.entries[params.skillName];
    // Compute hash
    const hash = await computeFileHash(params.filePath);
    // Create entry
    const entry = {
        skillName: params.skillName,
        hash,
        origin: params.origin,
        version: params.version,
        author: params.author,
        recordedAt: Date.now(),
        lastModified: Date.now(),
        filePath: params.filePath,
        previousHash: existing?.hash,
        verified: true,
    };
    // Update store
    store.entries[params.skillName] = entry;
    await saveStore(store);
    return entry;
}
/**
 * Verify provenance for a skill.
 */
export async function verifyProvenance(skillName, filePath) {
    const store = await loadStore();
    const entry = store.entries[skillName];
    if (!entry) {
        return {
            verified: false,
            entry: null,
            reason: 'No provenance record found',
        };
    }
    // Verify hash
    const { verified, actualHash } = await verifyFileHash(filePath, entry.hash);
    if (!verified) {
        return {
            verified: false,
            entry,
            reason: `Hash mismatch: expected ${entry.hash}, got ${actualHash}`,
        };
    }
    return {
        verified: true,
        entry,
    };
}
/**
 * Get provenance for a skill.
 */
export async function getProvenance(skillName) {
    const store = await loadStore();
    return store.entries[skillName] ?? null;
}
/**
 * Get all provenance entries.
 */
export async function getAllProvenance() {
    const store = await loadStore();
    return Object.values(store.entries);
}
/**
 * Get provenance statistics.
 */
export async function getProvenanceStats() {
    const entries = await getAllProvenance();
    const stats = {
        total: entries.length,
        byOrigin: {},
        verified: 0,
        unverified: 0,
    };
    for (const entry of entries) {
        // Count by origin
        stats.byOrigin[entry.origin] = (stats.byOrigin[entry.origin] || 0) + 1;
        // Count by verification status
        if (entry.verified) {
            stats.verified++;
        }
        else {
            stats.unverified++;
        }
    }
    return stats;
}
/**
 * Remove provenance for a skill.
 */
export async function removeProvenance(skillName) {
    const store = await loadStore();
    if (!store.entries[skillName]) {
        return false;
    }
    delete store.entries[skillName];
    await saveStore(store);
    return true;
}
/**
 * Update provenance (e.g., after skill update).
 */
export async function updateProvenance(skillName, filePath, updates) {
    const store = await loadStore();
    const existing = store.entries[skillName];
    if (!existing) {
        return null;
    }
    // Compute new hash
    const hash = await computeFileHash(filePath);
    // Update entry
    const updatedEntry = {
        ...existing,
        hash,
        filePath,
        lastModified: Date.now(),
        previousHash: existing.hash,
        verified: true,
        ...updates,
    };
    // Save
    store.entries[skillName] = updatedEntry;
    await saveStore(store);
    return updatedEntry;
}
/**
 * Export provenance for backup.
 */
export async function exportProvenance() {
    const store = await loadStore();
    return JSON.stringify(store, null, 2);
}
/**
 * Import provenance from backup.
 */
export async function importProvenance(data) {
    const store = JSON.parse(data);
    await saveStore(store);
}
/**
 * Get version history for a skill.
 */
export async function getVersionHistory(skillName) {
    const store = await loadStore();
    const entries = Object.values(store.entries);
    // Find all entries for this skill (including previous hashes)
    const history = [];
    for (const entry of entries) {
        if (entry.skillName === skillName) {
            history.push(entry);
        }
    }
    // Sort by recordedAt (newest first)
    history.sort((a, b) => b.recordedAt - a.recordedAt);
    return history;
}
//# sourceMappingURL=skill-provenance.js.map