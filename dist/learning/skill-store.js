/**
 * SkillStore — Persists and manages compiled skills on disk.
 *
 * Skills are stored as individual JSON files in ~/.nuvira/skills/
 * Each skill gets its own file for easy inspection and manual editing.
 * An index.json file tracks the full list for fast enumeration.
 *
 * The store also provides:
 * - Decay-based quality scoring (skills lose relevance over time)
 * - Usage tracking (skills used more often are retained longer)
 * - Search by tags, goal pattern, or name
 * - Garbage collection for low-quality/expired skills
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveNuviraHome } from '../config/paths.js';
import { MAX_SKILLS } from './skill-types.js';
import { ALL_BUNDLED_SKILLS as BUNDLED_SKILLS } from '../skills/bundled-skills.js';
import { logger } from '../utils/logger.js';
// ─── Constants ──────────────────────────────────────────────────────────────
const SKILLS_DIR = join(resolveNuviraHome(), 'skills');
const INDEX_PATH = join(SKILLS_DIR, 'index.json');
// Skill decay: skills lose relevance over time
const SKILL_TTL_DAYS = 120; // Expire after 120 days without use
const DECAY_DAYS_FOR_HALF_SCORE = 45; // Score halves after 45 days of no use
const MIN_SKILL_SCORE = 0.15; // Prune skills below this score
// ─── Helpers ────────────────────────────────────────────────────────────────
function ensureDir() {
    if (!existsSync(SKILLS_DIR)) {
        mkdirSync(SKILLS_DIR, { recursive: true });
    }
}
function skillFilePath(id) {
    // Sanitize ID for filesystem
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(SKILLS_DIR, `${safeId}.json`);
}
function generateId(name) {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40);
    return `skill-${slug}-${Date.now().toString(36)}`;
}
// ─── SkillStore ─────────────────────────────────────────────────────────────
/**
 * Manages storage, retrieval, and lifecycle of compiled skills.
 *
 * Skills are stored as individual JSON files for transparency.
 * An index provides fast enumeration without reading all files.
 */
export class SkillStore {
    index;
    constructor() {
        ensureDir();
        this.index = this.loadIndex();
        // Seed first-party bundled skills so every install gets them (idempotent:
        // a same-version bundled skill already on disk is left untouched, so
        // user edits survive re-seeding). Best-effort — never break startup.
        try {
            this.seedBundledSkills();
        }
        catch {
            // Best-effort — a seeding failure must never break the store.
        }
    }
    /**
     * Install first-party bundled skills (src/skills/bundled-skills.ts) into the
     * user skill store. Idempotent — a bundled skill whose version matches the
     * on-disk version is NOT overwritten (preserves user edits and usage stats);
     * a newer bundled version replaces the older one.
     *
     * @returns The number of skills seeded/updated.
     */
    seedBundledSkills() {
        let seeded = 0;
        for (const skill of BUNDLED_SKILLS) {
            const existing = this.get(skill.id);
            if (existing && existing.version === skill.version) {
                // Same version already on disk — preserve it (user edits + usage
                // stats survive). But the INDEX may be out of sync (e.g. an
                // index.json clear/corruption while the skill file survived):
                // findMatch/getAll read the index, so an unindexed skill silently
                // disappears. Re-register it without touching the file.
                if (!this.index.skills.some((s) => s.id === skill.id)) {
                    this.index.skills.push({
                        id: skill.id,
                        name: skill.name,
                        description: skill.description,
                        tags: skill.tags,
                        qualityScore: skill.qualityScore,
                        usageCount: existing.usageCount,
                        createdAt: existing.createdAt,
                        lastUsedAt: existing.lastUsedAt,
                    });
                    this.saveIndex();
                }
                continue;
            }
            // Keep the user's usage count when upgrading a bundled skill. Spread
            // a copy so the module-level BUNDLED_SKILLS singletons are never
            // mutated (shared state across store instances). First-time seeds get a
            // FRESH timestamp so decay/quality reports treat them as new (a fixed
            // 2025 timestamp would make `nuvira skill gc` prune a freshly-seeded
            // first-party skill as 120+ days old).
            const now = Date.now();
            const toSave = {
                ...skill,
                usageCount: existing?.usageCount ?? 0,
                lastUsedAt: existing?.lastUsedAt ?? now,
                createdAt: existing?.createdAt ?? now,
            };
            this.save(toSave);
            seeded++;
        }
        return seeded;
    }
    // ── Public API ──────────────────────────────────────────────────────────
    /**
     * Save a skill to disk. Creates both the individual file and updates the index.
     * If a skill with the same ID already exists, it's overwritten.
     */
    save(skill) {
        ensureDir();
        // Write individual skill file
        const filePath = skillFilePath(skill.id);
        writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf-8');
        // Update index
        const existing = this.index.skills.findIndex((s) => s.id === skill.id);
        const indexEntry = {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            tags: skill.tags,
            qualityScore: skill.qualityScore,
            usageCount: skill.usageCount,
            createdAt: skill.createdAt,
            lastUsedAt: skill.lastUsedAt,
        };
        if (existing >= 0) {
            this.index.skills[existing] = indexEntry;
        }
        else {
            this.index.skills.push(indexEntry);
        }
        this.saveIndex();
    }
    /**
     * Load a skill by ID from its individual file.
     * Returns null if the file doesn't exist or is corrupt.
     */
    get(id) {
        const filePath = skillFilePath(id);
        try {
            if (!existsSync(filePath))
                return null;
            const raw = readFileSync(filePath, 'utf-8');
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    /**
     * Get all skills, optionally filtered by minimum quality score.
     * Loads full skill data for all indexed skills.
     */
    getAll(minQualityScore) {
        const skills = [];
        for (const entry of this.index.skills) {
            if (minQualityScore !== undefined && entry.qualityScore < minQualityScore) {
                continue;
            }
            const skill = this.get(entry.id);
            if (skill) {
                skills.push(skill);
            }
        }
        // Sort by quality score (descending)
        return skills.sort((a, b) => b.qualityScore - a.qualityScore);
    }
    /**
     * Find skills relevant to a given goal or tag query.
     * Matches against name, description, goalPattern, and tags.
     */
    search(query) {
        const q = query.toLowerCase();
        const all = this.getAll();
        return all.filter((skill) => {
            if (skill.name.toLowerCase().includes(q))
                return true;
            if (skill.description.toLowerCase().includes(q))
                return true;
            if (skill.goalPattern.toLowerCase().includes(q))
                return true;
            if (skill.tags.some((t) => t.toLowerCase().includes(q)))
                return true;
            return false;
        }).slice(0, 10); // Limit results
    }
    /**
     * Find the best skill match for a given goal.
     * Uses keyword matching against goalPattern and tags.
     */
    findMatch(goal) {
        const q = goal.toLowerCase();
        const all = this.getAll();
        // Score each skill by relevance to the goal
        const scored = all.map((skill) => {
            let score = 0;
            // Match goalPattern keywords
            const patternWords = skill.goalPattern.toLowerCase().split(/\s+/);
            for (const word of patternWords) {
                if (word.length > 3 && q.includes(word)) {
                    score += 2;
                }
            }
            // Match tags
            for (const tag of skill.tags) {
                if (q.includes(tag.toLowerCase())) {
                    score += 1.5;
                }
            }
            // Match name
            if (q.includes(skill.name.toLowerCase())) {
                score += 1;
            }
            // Quality bonus
            score += skill.qualityScore * 0.5;
            // Usage bonus (popular skills rank higher)
            score += Math.min(skill.usageCount * 0.1, 0.5);
            return { skill, score };
        });
        // Sort by score (descending), return best match if score > threshold
        scored.sort((a, b) => b.score - a.score);
        return scored[0]?.score >= 1 ? scored[0].skill : null;
    }
    /**
     * Mark a skill as used (updates usage count and timestamp).
     */
    markUsed(id) {
        const skill = this.get(id);
        if (!skill)
            return;
        skill.usageCount++;
        skill.lastUsedAt = Date.now();
        this.save(skill);
    }
    /**
     * Delete a skill by ID. Removes both the file and index entry.
     */
    delete(id) {
        const filePath = skillFilePath(id);
        let removed = false;
        // Remove file
        try {
            if (existsSync(filePath)) {
                unlinkSync(filePath);
                removed = true;
            }
        }
        catch {
            // Best-effort
        }
        // Remove from index
        const before = this.index.skills.length;
        this.index.skills = this.index.skills.filter((s) => s.id !== id);
        if (this.index.skills.length < before) {
            removed = true;
        }
        if (removed) {
            this.saveIndex();
        }
        return removed;
    }
    /**
     * Compute a decay score for a skill based on age and usage.
     * Returns a score from 0 (expired) to 1 (fresh).
     */
    computeDecayScore(skill) {
        const now = Date.now();
        const ageMs = now - skill.createdAt;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        // Hard expiry: skill too old
        if (ageDays > SKILL_TTL_DAYS)
            return 0;
        // Time-based decay: score halves after DECAY_DAYS_FOR_HALF_SCORE
        const timeScore = Math.pow(0.5, ageDays / DECAY_DAYS_FOR_HALF_SCORE);
        // Usage bonus: skills used more often are worth keeping
        const usageBonus = Math.min(skill.usageCount * 0.05, 0.3);
        // Last-used bonus: recently used skills get a boost
        const daysSinceLastUse = (now - skill.lastUsedAt) / (1000 * 60 * 60 * 24);
        const recencyBonus = Math.max(0, 0.2 - daysSinceLastUse * 0.01);
        return Math.min(1, timeScore + usageBonus + recencyBonus);
    }
    /**
     * Garbage-collect low-quality skills.
     * Returns the number of skills removed.
     */
    garbageCollect(verbose = false) {
        const before = this.index.skills.length;
        // Check each skill's decay score
        const toRemove = [];
        for (const entry of this.index.skills) {
            const skill = this.get(entry.id);
            if (!skill) {
                toRemove.push(entry.id);
                continue;
            }
            // First-party bundled skills are exempt from decay GC — they ship with
            // the product and re-seed on every install, so pruning them as "expired"
            // is always wrong (they would just reappear on the next store load).
            if (skill.sourceTrajectoryIds.includes('bundled'))
                continue;
            const score = this.computeDecayScore(skill);
            if (score < MIN_SKILL_SCORE) {
                toRemove.push(entry.id);
                if (verbose) {
                    logger.debug(`Pruning skill '${skill.name}' (decay score: ${(score * 100).toFixed(0)}%)`);
                }
            }
        }
        for (const id of toRemove) {
            this.delete(id);
        }
        // Also enforce max skills count (keep the best)
        if (this.index.skills.length > MAX_SKILLS) {
            const all = this.getAll();
            all.sort((a, b) => this.computeDecayScore(b) - this.computeDecayScore(a));
            const excess = all.slice(MAX_SKILLS);
            for (const skill of excess) {
                this.delete(skill.id);
                if (verbose) {
                    logger.debug(`Removing excess skill '${skill.name}' (beyond ${MAX_SKILLS} limit)`);
                }
            }
        }
        return before - this.index.skills.length;
    }
    /**
     * Get summary statistics about stored skills.
     */
    getSummary() {
        const all = this.getAll();
        const now = Date.now();
        if (all.length === 0) {
            return {
                total: 0,
                totalUsage: 0,
                avgQualityScore: 0,
                topTags: [],
                oldestSkill: '',
                newestSkill: '',
            };
        }
        // Tag frequency
        const tagCounts = new Map();
        for (const skill of all) {
            for (const tag of skill.tags) {
                tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
            }
        }
        const topTags = Array.from(tagCounts.entries())
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10)
            .map(([tag, count]) => ({ tag, count }));
        // Oldest/newest
        const sortedByAge = [...all].sort((a, b) => a.createdAt - b.createdAt);
        const totalUsage = all.reduce((sum, s) => sum + s.usageCount, 0);
        return {
            total: all.length,
            totalUsage,
            avgQualityScore: all.reduce((sum, s) => sum + s.qualityScore, 0) / all.length,
            topTags,
            oldestSkill: sortedByAge[0].name,
            newestSkill: sortedByAge[sortedByAge.length - 1].name,
        };
    }
    /**
     * Clear all skills.
     */
    clear() {
        // Remove all individual files
        for (const entry of [...this.index.skills]) {
            this.delete(entry.id);
        }
        // Reset index
        this.index = { skills: [], version: 1 };
        this.saveIndex();
    }
    /**
     * Get quality report for monitoring.
     */
    getQualityReport() {
        const all = this.getAll();
        const now = Date.now();
        return all
            .map((s) => ({
            id: s.id,
            name: s.name,
            decayScore: this.computeDecayScore(s),
            usageCount: s.usageCount,
            ageDays: Math.floor((now - s.createdAt) / (1000 * 60 * 60 * 24)),
        }))
            .sort((a, b) => a.decayScore - b.decayScore); // Worst first
    }
    /**
     * skill_view() — Progressive disclosure for skills.
     *
     * Hermes pattern: skills_list() returns name+description (lightweight),
     * skill_view(name) returns full methodology (heavyweight).
     *
     * This function returns the full skill content for a given skill name,
     * formatted as structured guidance that an agent can follow.
     *
     * @param name - Skill name or ID to view
     * @param filePath - Optional specific file within skill directory (e.g., 'references/api.md')
     * @returns Full skill content as structured text, or error message
     */
    skillView(name, filePath) {
        // Find the skill by name or ID
        const all = this.getAll();
        const skill = all.find((s) => s.name === name || s.id === name || s.name.toLowerCase() === name.toLowerCase());
        if (!skill) {
            // Try fuzzy match
            const fuzzyMatch = all.find((s) => s.name.toLowerCase().includes(name.toLowerCase()) ||
                name.toLowerCase().includes(s.name.toLowerCase()));
            if (!fuzzyMatch) {
                return JSON.stringify({
                    success: false,
                    error: `Skill '${name}' not found`,
                    hint: `Available skills: ${all.slice(0, 20).map((s) => s.name).join(', ')}`,
                });
            }
            return this.formatSkillView(fuzzyMatch, filePath);
        }
        // Mark as used
        this.markUsed(skill.id);
        return this.formatSkillView(skill, filePath);
    }
    /**
     * Find the reference docs directory for a skill.
     * Checks .agents/skills/<skill-name>/references/ directory.
     */
    findReferenceDocsDir(skillName) {
        // Check .agents/skills/<skill-name>/references/
        const agentsDir = join(process.cwd(), '.agents', 'skills', skillName, 'references');
        if (existsSync(agentsDir)) {
            return agentsDir;
        }
        return null;
    }
    /**
     * List available reference files for a skill.
     */
    listReferenceFiles(skillName) {
        const refDir = this.findReferenceDocsDir(skillName);
        if (!refDir)
            return [];
        try {
            const files = readdirSync(refDir, { withFileTypes: true });
            return files
                .filter((f) => f.isFile() && f.name.endsWith('.md'))
                .map((f) => f.name);
        }
        catch {
            return [];
        }
    }
    /**
     * Load a specific reference file for a skill.
     */
    loadReferenceFile(skillName, fileName) {
        const refDir = this.findReferenceDocsDir(skillName);
        if (!refDir)
            return null;
        const filePath = join(refDir, fileName);
        if (!existsSync(filePath))
            return null;
        try {
            const content = readFileSync(filePath, 'utf-8');
            // Truncate very large files
            const maxChars = 50_000;
            if (content.length > maxChars) {
                return content.slice(0, maxChars) + `\n\n... (${content.length - maxChars} more chars truncated)`;
            }
            return content;
        }
        catch {
            return null;
        }
    }
    /**
     * Format a skill into structured guidance text for an agent.
     * This is the Hermes-style progressive disclosure output.
     * Now includes actual reference docs loading from disk.
     */
    formatSkillView(skill, filePath) {
        // If a specific file is requested, load it from disk
        if (filePath) {
            const content = this.loadReferenceFile(skill.name, filePath);
            if (content) {
                return JSON.stringify({
                    success: true,
                    skill: skill.name,
                    file: filePath,
                    content,
                });
            }
            // File not found — list available files
            const available = this.listReferenceFiles(skill.name);
            return JSON.stringify({
                success: false,
                error: `Reference file '${filePath}' not found for skill '${skill.name}'`,
                available_files: available,
                hint: available.length > 0
                    ? `Available reference files: ${available.join(', ')}. Use skill_view('${skill.name}', '<filename>') to load one.`
                    : 'No reference files available for this skill.',
            });
        }
        // Format full skill methodology (Hermes-style)
        const sections = [];
        // Header
        sections.push(`# Skill: ${skill.name}`);
        sections.push(`\n${skill.description}`);
        // When to use (Hermes-style)
        if (skill.whenToUse && skill.whenToUse.length > 0) {
            sections.push('\n## When to Use');
            for (const condition of skill.whenToUse) {
                sections.push(`- ${condition}`);
            }
        }
        // When NOT to use (Hermes-style)
        if (skill.whenNotToUse && skill.whenNotToUse.length > 0) {
            sections.push('\n## When NOT to Use');
            for (const condition of skill.whenNotToUse) {
                sections.push(`- ${condition}`);
            }
        }
        // Goal pattern
        sections.push(`\n## Goal Pattern`);
        sections.push(skill.goalPattern);
        // Tags
        sections.push(`\n## Tags`);
        sections.push(skill.tags.join(', '));
        // Parameters
        if (skill.parameters.length > 0) {
            sections.push('\n## Parameters');
            for (const param of skill.parameters) {
                const required = param.required ? '(required)' : '(optional)';
                const defaultVal = param.defaultValue ? ` [default: ${param.defaultValue}]` : '';
                sections.push(`- **${param.name}** ${required}${defaultVal}: ${param.description}`);
            }
        }
        // Steps (the core methodology)
        sections.push('\n## Execution Steps');
        sections.push('\nFollow these steps in order:');
        for (let i = 0; i < skill.steps.length; i++) {
            const step = skill.steps[i];
            const deps = step.dependsOn.length > 0
                ? ` (depends on: ${step.dependsOn.join(', ')})`
                : '';
            sections.push(`\n### Step ${i + 1}: [${step.agentType}]${deps}`);
            sections.push(step.description);
            if (step.expectedOutput) {
                sections.push(`\n**Expected output:** ${step.expectedOutput}`);
            }
        }
        // Reference docs (if available)
        const refFiles = this.listReferenceFiles(skill.name);
        if (refFiles.length > 0) {
            sections.push('\n## Reference Documents');
            sections.push('Load deep-dive content with skill_view():');
            for (const file of refFiles) {
                const name = file.replace('.md', '').replace(/-/g, ' ');
                sections.push(`- skill_view('${skill.name}', '${file}') — ${name}`);
            }
        }
        // Quality metadata
        sections.push('\n---');
        sections.push(`Quality: ${(skill.qualityScore * 100).toFixed(0)}% | Used: ${skill.usageCount} times`);
        return sections.join('\n');
    }
    // ── Private ────────────────────────────────────────────────────────────
    loadIndex() {
        try {
            ensureDir();
            if (!existsSync(INDEX_PATH)) {
                return { skills: [], version: 1 };
            }
            const raw = readFileSync(INDEX_PATH, 'utf-8');
            return JSON.parse(raw);
        }
        catch {
            return { skills: [], version: 1 };
        }
    }
    saveIndex() {
        ensureDir();
        writeFileSync(INDEX_PATH, JSON.stringify(this.index, null, 2), 'utf-8');
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let storeInstance = null;
export function getSkillStore() {
    if (!storeInstance) {
        storeInstance = new SkillStore();
    }
    return storeInstance;
}
export function resetSkillStore() {
    storeInstance = null;
}
//# sourceMappingURL=skill-store.js.map