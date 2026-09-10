/**
 * UserProfile — Bounded user model (inspired by Hermes USER.md).
 *
 * Tracks user preferences, decision patterns, and domain expertise.
 * Uses forced consolidation (2000 char limit) to prevent context bloat.
 *
 * Integration with existing memory system:
 * - LocalMemoryProvider.prefetch() injects user profile context
 * - LocalMemoryProvider.syncTurn() updates profile after each turn
 * - Orchestrator includes profile in vault metadata
 *
 * Storage: ~/.nuvira/USER.md (bounded, auto-consolidated)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveNuviraHome } from '../config/paths.js';
import { logger } from '../utils/logger.js';
// ─── Constants ──────────────────────────────────────────────────────────────
/** Max characters for the profile (forces consolidation) */
const MAX_PROFILE_CHARS = 2000;
/** Max decision history entries to keep */
const MAX_DECISIONS = 10;
/** Max preferences to keep */
const MAX_PREFERENCES = 15;
// ─── Goal Classification ────────────────────────────────────────────────────
/**
 * Classify a user goal into a category.
 */
function classifyGoal(text) {
    const lower = text.toLowerCase();
    if (lower.includes('create') || lower.includes('write') || lower.includes('build') || lower.includes('implement')) {
        return 'coding';
    }
    if (lower.includes('explain') || lower.includes('what is') || lower.includes('how does')) {
        return 'learning';
    }
    if (lower.includes('fix') || lower.includes('debug') || lower.includes('error')) {
        return 'debugging';
    }
    if (lower.includes('test') || lower.includes('verify') || lower.includes('check')) {
        return 'testing';
    }
    if (lower.includes('deploy') || lower.includes('publish') || lower.includes('ship')) {
        return 'deployment';
    }
    if (lower.includes('essay') || lower.includes('write') || lower.includes('document')) {
        return 'writing';
    }
    if (lower.includes('analyze') || lower.includes('review') || lower.includes('assess')) {
        return 'analysis';
    }
    return 'general';
}
/**
 * Detect domain expertise from user message.
 * Uses heuristics (technical vocabulary, complexity of requests).
 */
function detectExpertise(text) {
    const lower = text.toLowerCase();
    const domains = [];
    // Technical vocabulary indicators
    const expertTerms = ['refactor', 'architect', 'microservice', 'kubernetes', 'terraform', 'ci/cd', 'pipeline'];
    const intermediateTerms = ['api', 'database', 'server', 'component', 'module', 'integration'];
    const beginnerTerms = ['help', 'explain', 'what is', 'how to', 'tutorial'];
    const hasExpert = expertTerms.some((t) => lower.includes(t));
    const hasIntermediate = intermediateTerms.some((t) => lower.includes(t));
    const hasBeginner = beginnerTerms.some((t) => lower.includes(t));
    // Domain detection
    if (lower.includes('python') || lower.includes('django') || lower.includes('flask'))
        domains.push('python');
    if (lower.includes('javascript') || lower.includes('typescript') || lower.includes('react') || lower.includes('node'))
        domains.push('javascript');
    if (lower.includes('rust') || lower.includes('cargo'))
        domains.push('rust');
    if (lower.includes('go') || lower.includes('golang'))
        domains.push('go');
    if (lower.includes('docker') || lower.includes('container'))
        domains.push('devops');
    if (lower.includes('sql') || lower.includes('database') || lower.includes('postgres'))
        domains.push('database');
    // Determine level
    let level = 'unknown';
    let confidence = 0;
    if (hasExpert && !hasBeginner) {
        level = 'expert';
        confidence = 0.8;
    }
    else if (hasIntermediate && !hasBeginner) {
        level = 'intermediate';
        confidence = 0.7;
    }
    else if (hasBeginner) {
        level = 'beginner';
        confidence = 0.6;
    }
    else {
        level = 'intermediate'; // Default
        confidence = 0.3;
    }
    return { level, confidence, domains };
}
// ─── UserProfileManager ─────────────────────────────────────────────────────
export class UserProfileManager {
    profile;
    filePath;
    constructor() {
        this.filePath = join(resolveNuviraHome(), 'USER.md');
        this.profile = this.load();
    }
    /**
     * Update profile based on user interaction.
     * Called by LocalMemoryProvider.syncTurn() after each turn.
     */
    updateUserProfile(userMessage, _assistantText, accepted = true) {
        try {
            // Extract formatting preferences (heuristic)
            this.extractFormattingPreferences(userMessage);
            // Update expertise
            const newExpertise = detectExpertise(userMessage);
            if (newExpertise.confidence > this.profile.expertise.confidence) {
                this.profile.expertise = newExpertise;
            }
            // Record decision
            this.profile.decisions.push({
                goalType: classifyGoal(userMessage),
                accepted,
                timestamp: Date.now(),
            });
            // Trim decisions
            if (this.profile.decisions.length > MAX_DECISIONS) {
                this.profile.decisions = this.profile.decisions.slice(-MAX_DECISIONS);
            }
            // Update timestamp
            this.profile.lastUpdated = Date.now();
            // Consolidate if over limit
            this.consolidateIfNeeded();
            // Persist
            this.save();
        }
        catch (err) {
            // Profile update must never break execution
            logger.debug(`User profile update failed (non-critical): ${err}`);
        }
    }
    /**
     * Build user context block for prompt injection.
     * Called by LocalMemoryProvider.prefetch() to include in memory block.
     */
    buildUserContextBlock() {
        const lines = [];
        // Preferences
        if (this.profile.preferences.size > 0) {
            lines.push('## User Preferences');
            for (const [key, value] of this.profile.preferences) {
                lines.push(`- ${key}: ${value}`);
            }
        }
        // Expertise
        if (this.profile.expertise.level !== 'unknown') {
            lines.push(`## User Expertise: ${this.profile.expertise.level}`);
            if (this.profile.expertise.domains.length > 0) {
                lines.push(`- Domains: ${this.profile.expertise.domains.join(', ')}`);
            }
        }
        // Recent decisions (only last 5)
        const recent = this.profile.decisions.slice(-5);
        if (recent.length > 0) {
            lines.push('## Recent Task Patterns');
            for (const d of recent) {
                lines.push(`- ${d.goalType}: ${d.accepted ? 'accepted' : 'needs improvement'}`);
            }
        }
        return lines.length > 0 ? lines.join('\n') : '';
    }
    /**
     * Get profile summary (for dashboard/CLI).
     */
    getSummary() {
        return {
            preferenceCount: this.profile.preferences.size,
            expertise: this.profile.expertise.level,
            domains: this.profile.expertise.domains,
            recentDecisions: this.profile.decisions.length,
            lastUpdated: new Date(this.profile.lastUpdated).toISOString(),
        };
    }
    /**
     * Extract formatting preferences from user message.
     */
    extractFormattingPreferences(text) {
        const lower = text.toLowerCase();
        // Detail level detection
        if (lower.includes('brief') || lower.includes('short') || lower.includes('concise')) {
            this.profile.preferences.set('detailLevel', 'concise');
        }
        else if (lower.includes('detailed') || lower.includes('thorough') || lower.includes('comprehensive')) {
            this.profile.preferences.set('detailLevel', 'detailed');
        }
        // Code style detection
        if (lower.includes('comment') || lower.includes('document')) {
            this.profile.preferences.set('codeStyle', 'well-documented');
        }
        // Output format detection
        if (lower.includes('markdown') || lower.includes('.md')) {
            this.profile.preferences.set('outputFormat', 'markdown');
        }
        // Trim preferences
        if (this.profile.preferences.size > MAX_PREFERENCES) {
            const entries = Array.from(this.profile.preferences.entries());
            this.profile.preferences = new Map(entries.slice(-MAX_PREFERENCES));
        }
    }
    /**
     * Consolidate profile when over limit.
     * Forces prioritization (like Hermes USER.md).
     */
    consolidateIfNeeded() {
        const content = this.buildUserContextBlock();
        if (content.length <= MAX_PROFILE_CHARS)
            return;
        // Priority: expertise > preferences > recent decisions
        // Drop oldest decisions first
        while (this.buildUserContextBlock().length > MAX_PROFILE_CHARS &&
            this.profile.decisions.length > 3) {
            this.profile.decisions.shift();
        }
        // If still over limit, compress preferences
        if (this.buildUserContextBlock().length > MAX_PROFILE_CHARS) {
            const entries = Array.from(this.profile.preferences.entries());
            this.profile.preferences = new Map(entries.slice(-5)); // Keep only 5 most recent
        }
    }
    /**
     * Load profile from disk.
     */
    load() {
        try {
            if (!existsSync(this.filePath)) {
                return this.createDefault();
            }
            const content = readFileSync(this.filePath, 'utf-8');
            const parsed = JSON.parse(content);
            return {
                preferences: new Map(parsed.preferences || []),
                decisions: parsed.decisions || [],
                expertise: parsed.expertise || { level: 'unknown', confidence: 0, domains: [] },
                lastUpdated: parsed.lastUpdated || 0,
            };
        }
        catch {
            return this.createDefault();
        }
    }
    /**
     * Save profile to disk.
     */
    save() {
        try {
            const dir = join(resolveNuviraHome());
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            const data = {
                preferences: Array.from(this.profile.preferences.entries()),
                decisions: this.profile.decisions,
                expertise: this.profile.expertise,
                lastUpdated: this.profile.lastUpdated,
            };
            writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
        }
        catch (err) {
            logger.debug(`User profile save failed (non-critical): ${err}`);
        }
    }
    /**
     * Create default empty profile.
     */
    createDefault() {
        return {
            preferences: new Map(),
            decisions: [],
            expertise: { level: 'unknown', confidence: 0, domains: [] },
            lastUpdated: Date.now(),
        };
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let profileInstance = null;
export function getUserProfile() {
    if (!profileInstance) {
        profileInstance = new UserProfileManager();
    }
    return profileInstance;
}
export function resetUserProfile() {
    profileInstance = null;
}
//# sourceMappingURL=user-profile.js.map