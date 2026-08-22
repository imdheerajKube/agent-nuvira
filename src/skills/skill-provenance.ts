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

// ─── Types ───────────────────────────────────────────────────────────────

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

// ─── Default Configuration ───────────────────────────────────────────────

const PROVENANCE_DIR = join(homedir(), '.nuvira', 'provenance');
const PROVENANCE_FILE = 'skills.json';

// ─── Hash Functions ──────────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of content.
 */
export function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Compute SHA-256 hash of a file.
 */
export async function computeFileHash(filePath: string): Promise<string> {
  const content = await readFile(filePath, 'utf-8');
  return computeHash(content);
}

/**
 * Verify that content matches expected hash.
 */
export function verifyHash(content: string, expectedHash: string): boolean {
  const actualHash = computeHash(content);
  return actualHash === expectedHash;
}

/**
 * Verify that a file matches expected hash.
 */
export async function verifyFileHash(
  filePath: string,
  expectedHash: string
): Promise<{ verified: boolean; actualHash: string }> {
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
async function loadStore(): Promise<ProvenanceStore> {
  const storePath = join(PROVENANCE_DIR, PROVENANCE_FILE);

  try {
    const content = await readFile(storePath, 'utf-8');
    return JSON.parse(content) as ProvenanceStore;
  } catch {
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
async function saveStore(store: ProvenanceStore): Promise<void> {
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
export async function recordProvenance(params: {
  skillName: string;
  filePath: string;
  origin: 'bundled' | 'marketplace' | 'local';
  version?: string;
  author?: string;
}): Promise<ProvenanceEntry> {
  const store = await loadStore();
  const existing = store.entries[params.skillName];

  // Compute hash
  const hash = await computeFileHash(params.filePath);

  // Create entry
  const entry: ProvenanceEntry = {
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
export async function verifyProvenance(
  skillName: string,
  filePath: string
): Promise<{
  verified: boolean;
  entry: ProvenanceEntry | null;
  reason?: string;
}> {
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
export async function getProvenance(
  skillName: string
): Promise<ProvenanceEntry | null> {
  const store = await loadStore();
  return store.entries[skillName] ?? null;
}

/**
 * Get all provenance entries.
 */
export async function getAllProvenance(): Promise<ProvenanceEntry[]> {
  const store = await loadStore();
  return Object.values(store.entries);
}

/**
 * Get provenance statistics.
 */
export async function getProvenanceStats(): Promise<{
  total: number;
  byOrigin: Record<string, number>;
  verified: number;
  unverified: number;
}> {
  const entries = await getAllProvenance();

  const stats = {
    total: entries.length,
    byOrigin: {} as Record<string, number>,
    verified: 0,
    unverified: 0,
  };

  for (const entry of entries) {
    // Count by origin
    stats.byOrigin[entry.origin] = (stats.byOrigin[entry.origin] || 0) + 1;

    // Count by verification status
    if (entry.verified) {
      stats.verified++;
    } else {
      stats.unverified++;
    }
  }

  return stats;
}

/**
 * Remove provenance for a skill.
 */
export async function removeProvenance(skillName: string): Promise<boolean> {
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
export async function updateProvenance(
  skillName: string,
  filePath: string,
  updates: Partial<Pick<ProvenanceEntry, 'version' | 'author'>>
): Promise<ProvenanceEntry | null> {
  const store = await loadStore();
  const existing = store.entries[skillName];

  if (!existing) {
    return null;
  }

  // Compute new hash
  const hash = await computeFileHash(filePath);

  // Update entry
  const updatedEntry: ProvenanceEntry = {
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
export async function exportProvenance(): Promise<string> {
  const store = await loadStore();
  return JSON.stringify(store, null, 2);
}

/**
 * Import provenance from backup.
 */
export async function importProvenance(data: string): Promise<void> {
  const store = JSON.parse(data) as ProvenanceStore;
  await saveStore(store);
}

/**
 * Get version history for a skill.
 */
export async function getVersionHistory(
  skillName: string
): Promise<ProvenanceEntry[]> {
  const store = await loadStore();
  const entries = Object.values(store.entries);

  // Find all entries for this skill (including previous hashes)
  const history: ProvenanceEntry[] = [];

  for (const entry of entries) {
    if (entry.skillName === skillName) {
      history.push(entry);
    }
  }

  // Sort by recordedAt (newest first)
  history.sort((a, b) => b.recordedAt - a.recordedAt);

  return history;
}
