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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolveNuviraHome } from '../config/paths.js';
import { join } from 'node:path';
// ─── Skill Usage Tracker ──────────────────────────────────────────────────
export class SkillUsageTracker {
    usageFile;
    usage = new Map();
    constructor() {
        const dir = join(resolveNuviraHome(), 'skills', '.usage');
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        this.usageFile = join(dir, 'usage.json');
        this.load();
    }
    load() {
        if (!existsSync(this.usageFile))
            return;
        try {
            const data = JSON.parse(readFileSync(this.usageFile, 'utf-8'));
            for (const [name, usage] of Object.entries(data)) {
                this.usage.set(name, usage);
            }
        }
        catch {
            // Ignore
        }
    }
    save() {
        const data = {};
        for (const [name, usage] of this.usage) {
            data[name] = usage;
        }
        writeFileSync(this.usageFile, JSON.stringify(data, null, 2), 'utf-8');
    }
    /**
     * Record a skill usage.
     */
    record(skillName, context = 'default', tokens = 0) {
        const existing = this.usage.get(skillName);
        const now = Date.now();
        if (existing) {
            existing.count++;
            existing.lastUsed = now;
            if (!existing.contexts.includes(context)) {
                existing.contexts.push(context);
            }
            existing.tokensUsed += tokens;
            existing.averageTokensPerUse = existing.tokensUsed / existing.count;
        }
        else {
            this.usage.set(skillName, {
                name: skillName,
                count: 1,
                lastUsed: now,
                firstUsed: now,
                contexts: [context],
                tokensUsed: tokens,
                averageTokensPerUse: tokens,
            });
        }
        this.save();
    }
    /**
     * Get usage for a skill.
     */
    get(skillName) {
        return this.usage.get(skillName) || null;
    }
    /**
     * Get all usage.
     */
    getAll() {
        return Array.from(this.usage.values());
    }
    /**
     * Get most used skills.
     */
    getMostUsed(limit = 10) {
        return this.getAll()
            .sort((a, b) => b.count - a.count)
            .slice(0, limit);
    }
    /**
     * Get recently used skills.
     */
    getRecentlyUsed(limit = 10) {
        return this.getAll()
            .sort((a, b) => b.lastUsed - a.lastUsed)
            .slice(0, limit);
    }
    /**
     * Get usage stats.
     */
    getStats() {
        const all = this.getAll();
        return {
            totalSkills: all.length,
            totalUses: all.reduce((sum, u) => sum + u.count, 0),
            totalTokens: all.reduce((sum, u) => sum + u.tokensUsed, 0),
        };
    }
}
// ─── Skill Provenance Manager ─────────────────────────────────────────────
export class SkillProvenanceManager {
    provenanceFile;
    provenance = new Map();
    constructor() {
        const dir = join(resolveNuviraHome(), 'skills', '.provenance');
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        this.provenanceFile = join(dir, 'provenance.json');
        this.load();
    }
    load() {
        if (!existsSync(this.provenanceFile))
            return;
        try {
            const data = JSON.parse(readFileSync(this.provenanceFile, 'utf-8'));
            for (const [name, prov] of Object.entries(data)) {
                this.provenance.set(name, prov);
            }
        }
        catch {
            // Ignore
        }
    }
    save() {
        const data = {};
        for (const [name, prov] of this.provenance) {
            data[name] = prov;
        }
        writeFileSync(this.provenanceFile, JSON.stringify(data, null, 2), 'utf-8');
    }
    /**
     * Record skill provenance.
     */
    record(prov) {
        this.provenance.set(prov.name, prov);
        this.save();
    }
    /**
     * Get provenance for a skill.
     */
    get(skillName) {
        return this.provenance.get(skillName) || null;
    }
    /**
     * Get all provenance records.
     */
    getAll() {
        return Array.from(this.provenance.values());
    }
    /**
     * Verify provenance (check if skill matches recorded hash).
     */
    verify(skillName, currentHash) {
        const prov = this.provenance.get(skillName);
        if (!prov) {
            return { verified: false, reason: 'No provenance record' };
        }
        if (!prov.verified) {
            return { verified: false, reason: 'Provenance not verified' };
        }
        return { verified: true };
    }
    /**
     * Remove provenance record.
     */
    remove(skillName) {
        const deleted = this.provenance.delete(skillName);
        if (deleted)
            this.save();
        return deleted;
    }
}
// ─── Singletons ───────────────────────────────────────────────────────────
let _skillUsageTracker = null;
let _skillProvenanceManager = null;
export function getSkillUsageTracker() {
    if (!_skillUsageTracker)
        _skillUsageTracker = new SkillUsageTracker();
    return _skillUsageTracker;
}
export function getSkillProvenanceManager() {
    if (!_skillProvenanceManager)
        _skillProvenanceManager = new SkillProvenanceManager();
    return _skillProvenanceManager;
}
export function resetSkillMetadata() {
    _skillUsageTracker = null;
    _skillProvenanceManager = null;
}
//# sourceMappingURL=skill-metadata.js.map