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
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
// ─── Skills Sync Manager ──────────────────────────────────────────────────
export class SkillsSyncManager {
    manifestFile;
    bundledDir;
    targetDir;
    constructor(options = {}) {
        this.bundledDir = options.bundledDir || join(process.cwd(), 'skills');
        this.targetDir = options.targetDir || join(process.env.HOME || '~', '.nuvira', 'skills');
        this.manifestFile = join(this.targetDir, '.bundled_manifest');
    }
    /**
     * Load manifest from disk.
     */
    loadManifest() {
        if (!existsSync(this.manifestFile))
            return {};
        const content = readFileSync(this.manifestFile, 'utf-8');
        const manifest = {};
        for (const line of content.split('\n')) {
            if (!line.trim())
                continue;
            // Support both v1 (plain name) and v2 (name:hash)
            const colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
                const name = line.substring(0, colonIndex);
                const hash = line.substring(colonIndex + 1);
                manifest[name] = hash;
            }
            else {
                // v1 format — just name, no hash
                manifest[line.trim()] = '';
            }
        }
        return manifest;
    }
    /**
     * Save manifest to disk.
     */
    saveManifest(manifest) {
        const lines = Object.entries(manifest)
            .map(([name, hash]) => `${name}:${hash}`)
            .join('\n');
        writeFileSync(this.manifestFile, lines, 'utf-8');
    }
    /**
     * Calculate content hash of a skill directory.
     */
    calculateHash(skillDir) {
        const skillMd = join(skillDir, 'SKILL.md');
        if (!existsSync(skillMd))
            return '';
        const content = readFileSync(skillMd, 'utf-8');
        return createHash('md5').update(content).digest('hex');
    }
    /**
     * Sync skills from bundled to target.
     */
    async sync(externalDirs = []) {
        const result = { synced: [], skipped: [], deleted: [], errors: [] };
        // Ensure target dir exists
        if (!existsSync(this.targetDir)) {
            mkdirSync(this.targetDir, { recursive: true });
        }
        // Load existing manifest
        const manifest = this.loadManifest();
        // Get bundled skills
        if (!existsSync(this.bundledDir)) {
            logger.warn(`[sync] Bundled dir not found: ${this.bundledDir}`);
            return result;
        }
        const bundledEntries = readdirSync(this.bundledDir, { withFileTypes: true });
        const bundledSkills = bundledEntries.filter((e) => e.isDirectory()).map((e) => e.name);
        // Get external skill names (to avoid shadowing)
        const externalNames = new Set();
        for (const extDir of externalDirs) {
            if (!existsSync(extDir))
                continue;
            const entries = readdirSync(extDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    externalNames.add(entry.name);
                }
            }
        }
        // Sync each bundled skill
        for (const skillName of bundledSkills) {
            // Skip if externally provided
            if (externalNames.has(skillName)) {
                result.skipped.push(skillName);
                continue;
            }
            const bundledDir = join(this.bundledDir, skillName);
            const targetDir = join(this.targetDir, skillName);
            const bundledHash = this.calculateHash(bundledDir);
            const existingHash = manifest[skillName] || '';
            // NEW skill (not in manifest)
            if (!manifest.hasOwnProperty(skillName)) {
                try {
                    cpSync(bundledDir, targetDir, { recursive: true });
                    manifest[skillName] = bundledHash;
                    result.synced.push(skillName);
                    logger.info(`[sync] Synced new skill: ${skillName}`);
                }
                catch (err) {
                    result.errors.push({ skill: skillName, error: String(err) });
                }
                continue;
            }
            // EXISTING skill
            if (!existsSync(targetDir)) {
                // User deleted it — respect that
                result.deleted.push(skillName);
                delete manifest[skillName];
                continue;
            }
            const targetHash = this.calculateHash(targetDir);
            // Bundled unchanged
            if (bundledHash === existingHash) {
                result.skipped.push(skillName);
                continue;
            }
            // Bundled changed, user copy matches origin — safe to update
            if (targetHash === existingHash) {
                try {
                    cpSync(bundledDir, targetDir, { recursive: true });
                    manifest[skillName] = bundledHash;
                    result.synced.push(skillName);
                    logger.info(`[sync] Updated skill: ${skillName}`);
                }
                catch (err) {
                    result.errors.push({ skill: skillName, error: String(err) });
                }
                continue;
            }
            // User customized it — skip
            result.skipped.push(skillName);
        }
        // Save manifest
        this.saveManifest(manifest);
        return result;
    }
    /**
     * Get sync status.
     */
    getStatus() {
        const manifest = this.loadManifest();
        return {
            total: Object.keys(manifest).length,
            synced: Object.keys(manifest).filter((k) => manifest[k]).length,
            manifestFile: this.manifestFile,
        };
    }
    /**
     * Force re-sync a specific skill.
     */
    async forceSync(skillName) {
        const bundledDir = join(this.bundledDir, skillName);
        const targetDir = join(this.targetDir, skillName);
        if (!existsSync(bundledDir))
            return false;
        try {
            cpSync(bundledDir, targetDir, { recursive: true });
            const hash = this.calculateHash(bundledDir);
            const manifest = this.loadManifest();
            manifest[skillName] = hash;
            this.saveManifest(manifest);
            return true;
        }
        catch {
            return false;
        }
    }
}
// ─── Singleton ─────────────────────────────────────────────────────────────
let _skillsSyncManager = null;
export function getSkillsSyncManager(options) {
    if (!_skillsSyncManager || options)
        _skillsSyncManager = new SkillsSyncManager(options);
    return _skillsSyncManager;
}
export function resetSkillsSyncManager() {
    _skillsSyncManager = null;
}
//# sourceMappingURL=skills-sync.js.map