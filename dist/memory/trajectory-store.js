/**
 * TrajectoryStore — Stores and retrieves successful agent execution trajectories.
 *
 * A trajectory captures a full agent session: the goal, the plan,
 * what files were touched, what changes were made, and the outcome.
 * This data is stored in a JSON file and indexed via the VectorStore
 * for semantic similarity search.
 *
 * When a new goal arrives, the Orchestrator queries past trajectories
 * and injects similar ones as few-shot examples into agent prompts.
 *
 * File location: ~/.buff/memory/trajectories.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getVectorStore } from './vector-store.js';
import { embed, EMBEDDING_DIM } from './embedder.js';
import { logger } from '../utils/logger.js';
import { scoreTrajectory } from '../learning/scorer.js';
// ─── Constants ──────────────────────────────────────────────────────────────
const MEMORY_DIR = join(homedir(), '.buff', 'memory');
const TRAJECTORIES_PATH = join(MEMORY_DIR, 'trajectories.json');
const CURRENT_VERSION = 1;
const MAX_TRAJECTORIES = 500;
// ─── Helpers ────────────────────────────────────────────────────────────────
function ensureDir() {
    if (!existsSync(MEMORY_DIR)) {
        mkdirSync(MEMORY_DIR, { recursive: true });
    }
}
function readTrajectories() {
    try {
        ensureDir();
        if (!existsSync(TRAJECTORIES_PATH)) {
            return { trajectories: {}, version: CURRENT_VERSION };
        }
        const raw = readFileSync(TRAJECTORIES_PATH, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return { trajectories: {}, version: CURRENT_VERSION };
    }
}
function writeTrajectories(data) {
    ensureDir();
    writeFileSync(TRAJECTORIES_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
/** Generate a unique trajectory ID */
function generateId() {
    return `traj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
/** Simple heuristic to guess a project fingerprint from file changes */
function guessProjectFingerprint(fileChanges) {
    const paths = fileChanges.map((c) => c.path);
    const allExtensions = paths
        .map((p) => p.slice(p.lastIndexOf('.')))
        .filter(Boolean);
    const extSet = new Set(allExtensions);
    const tags = [];
    if (extSet.has('.ts') || extSet.has('.tsx'))
        tags.push('typescript');
    if (extSet.has('.js') || extSet.has('.jsx'))
        tags.push('javascript');
    if (extSet.has('.py'))
        tags.push('python');
    if (extSet.has('.go'))
        tags.push('go');
    if (extSet.has('.rs'))
        tags.push('rust');
    if (extSet.has('.json'))
        tags.push('json');
    if (paths.some((p) => p.includes('package.json')))
        tags.push('node');
    if (paths.some((p) => p.includes('Dockerfile')))
        tags.push('docker');
    return tags.length > 0 ? tags.join(', ') : 'unknown';
}
// ─── TrajectoryStore ────────────────────────────────────────────────────────
/**
 * Manages the storage and retrieval of agent execution trajectories.
 */
export class TrajectoryStore {
    /**
     * Save a successful orchestration result as a trajectory.
     * Also indexes it in the VectorStore for semantic search.
     *
     * @param result       The orchestration result to save
     * @param callLLM      LLM function for generating the embedding vector
     * @param taskPlan     The original task plan steps
     * @returns            The trajectory ID
     */
    async save(result, callLLM, taskPlan, contextFiles) {
        // Only save successful trajectories
        if (!result.success)
            return '';
        const data = readTrajectories();
        // Prune old trajectories if we're at the limit
        this.pruneIfNeeded(data);
        const id = generateId();
        const trajectory = {
            id,
            goal: result.goal,
            projectFingerprint: '', // Will be set below after parsing file changes
            taskPlan: taskPlan.map((s) => ({
                id: s.id,
                description: s.description,
                agentType: s.agentType,
            })),
            contextFiles,
            fileChanges: result.fileChanges
                .split('\n')
                .filter((l) => l.includes('📄') || l.includes('✏️') || l.includes('🗑️'))
                .map((l) => {
                const match = l.match(/[✏️📄🗑️]\s+(.+?)\s+\((.*?)\)/);
                return match
                    ? { path: match[1], status: match[2] }
                    : { path: l.trim(), status: 'modified' };
            }),
            tasksCompleted: result.tasksCompleted,
            tasksTotal: result.tasksTotal,
            // Use the heuristic scorer for a more nuanced quality score
            score: scoreTrajectory({
                tasksCompleted: result.tasksCompleted,
                tasksTotal: result.tasksTotal,
                reviewPassed: result.success && !result.error,
                totalSteps: taskPlan.length,
            }).total,
            timestamp: Date.now(),
        };
        // Compute the project fingerprint from real file changes
        trajectory.projectFingerprint = guessProjectFingerprint(trajectory.fileChanges.map((fc) => ({
            path: fc.path,
            status: fc.status,
        })));
        // Store the trajectory
        data.trajectories[id] = trajectory;
        writeTrajectories(data);
        // Generate embedding and index in VectorStore
        // Uses native embeddings (Tier 1/Xenova) if available, falls back to LLM
        try {
            const embeddingText = this.buildEmbeddingText(trajectory);
            const vector = await embed(embeddingText, callLLM);
            // Check if embedding succeeded (non-zero vector)
            if (vector.some((v) => v !== 0)) {
                const vs = getVectorStore();
                await vs.insert(id, vector, {
                    goal: trajectory.goal,
                    projectFingerprint: trajectory.projectFingerprint,
                    score: trajectory.score,
                    timestamp: trajectory.timestamp,
                });
                logger.debug(`Indexed trajectory ${id} in vector store (${EMBEDDING_DIM} dim)`);
            }
            else {
                logger.debug(`Skipping vector index for ${id}: zero vector (embedding failed)`);
            }
        }
        catch (err) {
            // Non-fatal: trajectory is stored but not indexed for search
            logger.debug(`Failed to index trajectory ${id}: ${err}`);
        }
        return id;
    }
    /**
     * Retrieve a single trajectory by ID.
     */
    async get(id) {
        const data = readTrajectories();
        return data.trajectories[id] || null;
    }
    /**
     * Search for trajectories similar to a goal.
     *
     * @param goal      The goal text to search by
     * @param callLLM   LLM function for generating the query embedding
     * @param k         Maximum number of results
     * @returns         Array of trajectories sorted by relevance
     */
    async searchByGoal(goal, callLLM, k = 3) {
        try {
            // Generate embedding for the query
            const queryPrompt = `Search query for past agent trajectories: ${goal}`;
            const queryVector = await embed(queryPrompt, callLLM);
            // Skip search if we got a zero vector (embedding failed)
            if (queryVector.every((v) => v === 0))
                return [];
            // Search the vector index
            const vs = getVectorStore();
            const results = await vs.search(queryVector, k, (entry) => {
                const score = entry.metadata.score || 0;
                return score >= 0.5; // Only retrieve quality trajectories
            });
            // Load full trajectories from the store
            const trajectories = [];
            const data = readTrajectories();
            for (const { entry, similarity } of results) {
                const traj = data.trajectories[entry.id];
                if (traj && similarity > 0.3) {
                    trajectories.push(traj);
                }
            }
            return trajectories;
        }
        catch (err) {
            logger.debug(`Trajectory search failed: ${err}`);
            return [];
        }
    }
    /**
     * Format trajectories as few-shot examples for agent prompts.
     * Truncates plans to the first 5 steps to save token budget.
     * Returns a string that can be injected into the PlannerAgent's prompt.
     */
    formatAsFewShot(trajectories) {
        if (trajectories.length === 0)
            return '';
        const MAX_STEPS_PER_TRAJECTORY = 5;
        const parts = trajectories.map((t, i) => {
            // Truncate long plans to save tokens in the prompt
            const truncatedPlan = t.taskPlan.slice(0, MAX_STEPS_PER_TRAJECTORY);
            const stepsJson = JSON.stringify(truncatedPlan, null, 2);
            const truncatedNote = t.taskPlan.length > MAX_STEPS_PER_TRAJECTORY
                ? `\n  (... and ${t.taskPlan.length - MAX_STEPS_PER_TRAJECTORY} more steps)`
                : '';
            return `## Similar Past Task ${i + 1}\nGoal: ${t.goal}\nProject: ${t.projectFingerprint}\nPlan:\n${stepsJson}${truncatedNote}\nFiles changed: ${t.fileChanges.map((fc) => fc.path).join(', ')}\n`;
        });
        return `\n---\nHere are examples of how similar goals were decomposed into execution plans in the past. Use them as reference for creating the plan for the current goal.\n\n${parts.join('\n')}\n---\n`;
    }
    /**
     * Get statistics about stored trajectories.
     */
    async stats() {
        const data = readTrajectories();
        const trajectories = Object.values(data.trajectories);
        const avgScore = trajectories.length > 0
            ? trajectories.reduce((sum, t) => sum + t.score, 0) / trajectories.length
            : 0;
        const byProjectFingerprint = {};
        for (const t of trajectories) {
            const fp = t.projectFingerprint || 'unknown';
            byProjectFingerprint[fp] = (byProjectFingerprint[fp] || 0) + 1;
        }
        return {
            total: trajectories.length,
            avgScore: Math.round(avgScore * 100) / 100,
            byProjectFingerprint,
        };
    }
    /**
     * Get all stored trajectories.
     */
    getAll() {
        const data = readTrajectories();
        return Object.values(data.trajectories);
    }
    /**
     * Clear all trajectories.
     */
    async clear() {
        writeTrajectories({ trajectories: {}, version: CURRENT_VERSION });
        const vs = getVectorStore();
        await vs.clear();
    }
    // ─── Private Helpers ────────────────────────────────────────────────────
    /**
     * Build text to generate an embedding for a trajectory.
     */
    buildEmbeddingText(trajectory) {
        return [
            `Goal: ${trajectory.goal}`,
            `Project: ${trajectory.projectFingerprint}`,
            `Steps: ${trajectory.taskPlan.map((s) => `${s.agentType}: ${s.description}`).join('; ')}`,
            `Files: ${trajectory.fileChanges.map((fc) => fc.path).join(', ')}`,
        ].join('\n');
    }
    /**
     * Remove oldest trajectories when the store exceeds MAX_TRAJECTORIES.
     */
    pruneIfNeeded(data) {
        const entries = Object.entries(data.trajectories);
        if (entries.length < MAX_TRAJECTORIES)
            return;
        // Sort by timestamp (oldest first), remove excess
        const sorted = entries.sort(([, a], [, b]) => a.timestamp - b.timestamp);
        const toRemove = sorted.slice(0, entries.length - MAX_TRAJECTORIES + 10);
        // Remove from trajectory store AND vector index to avoid orphaned entries
        for (const [id] of toRemove) {
            delete data.trajectories[id];
            // Async cleanup — fire and forget (non-critical)
            getVectorStore().delete(id).catch(() => { });
        }
    }
    // ────────────────────────────────────────────────────────────────────
    // Phase 2.6: Memory Compression & Pruning
    // ────────────────────────────────────────────────────────────────────
    /**
     * Summarize old trajectories by merging multiple low-scoring or old
     * trajectories into a single compact representation.
     *
     * Summarization replaces a group of similar old trajectories with a
     * single aggregated entry that retains the most important information
     * (goal, file patterns, common steps) while discarding individual details.
     *
     * @param retentionDays  Keep original trajectories newer than this (default: 7)
     * @param verbose        Log summarization details
     * @returns              Number of trajectories summarized/removed
     */
    async summarize(retentionDays = 7, verbose = false) {
        const data = readTrajectories();
        const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        // Get trajectories older than retention period, grouped by project fingerprint
        const oldTrajectories = Object.entries(data.trajectories)
            .filter(([, t]) => t.timestamp < cutoff)
            .sort(([, a], [, b]) => b.score - a.score); // Higher scores first
        if (oldTrajectories.length < 3) {
            if (verbose)
                logger.info(`Only ${oldTrajectories.length} old trajectories — skipping summarization (need 3+)`);
            return { summarized: 0, merged: 0 };
        }
        // Group by project fingerprint for merging
        const groups = new Map();
        for (const [id, traj] of oldTrajectories) {
            const key = traj.projectFingerprint || 'unknown';
            if (!groups.has(key))
                groups.set(key, []);
            groups.get(key).push([id, traj]);
        }
        let summarized = 0;
        let merged = 0;
        // For each group, keep the highest-scoring trajectory and summarize the rest
        for (const [fingerprint, group] of groups) {
            if (group.length < 2)
                continue;
            // Keep the highest-scoring trajectory as the representative
            const [bestId, bestTraj] = group[0];
            const rest = group.slice(1);
            // Update the best trajectory to encompass the group
            bestTraj.goal = `[Summarized] ${bestTraj.goal} (+${rest.length} similar tasks)`;
            bestTraj.taskPlan = bestTraj.taskPlan.slice(0, 3); // Keep only first 3 steps
            bestTraj.fileChanges = this.mergeFileChanges(bestTraj.fileChanges, rest.map(([, t]) => t.fileChanges).flat());
            bestTraj.contextFiles = [
                ...new Set([...bestTraj.contextFiles, ...rest.map(([, t]) => t.contextFiles).flat()]),
            ];
            bestTraj.score = Math.min(1.0, bestTraj.score + 0.05); // Small bonus for being representative
            bestTraj.tasksCompleted = bestTraj.tasksCompleted + rest.reduce((s, [, t]) => s + t.tasksCompleted, 0);
            bestTraj.tasksTotal = bestTraj.tasksTotal + rest.reduce((s, [, t]) => s + t.tasksTotal, 0);
            // Remove the rest
            for (const [id] of rest) {
                delete data.trajectories[id];
                getVectorStore().delete(id).catch(() => { });
                merged++;
            }
            summarized++;
            if (verbose) {
                logger.info(`Summarized ${rest.length + 1} '${fingerprint}' trajectories into 1 (kept: ${bestId.slice(0, 16)}...)`);
            }
        }
        writeTrajectories(data);
        return { summarized, merged };
    }
    /**
     * Merge file changes from multiple trajectories into a unique set,
     * preferring 'modified' status over 'read' etc.
     */
    mergeFileChanges(primary, secondary) {
        const seen = new Map();
        // Status priority: modified > created > deleted > read
        const statusPriority = {
            modified: 3,
            created: 2,
            deleted: 1,
            read: 0,
        };
        for (const fc of [...primary, ...secondary]) {
            const existing = seen.get(fc.path);
            const existingPrio = existing ? (statusPriority[existing] ?? 0) : -1;
            const newPrio = statusPriority[fc.status] ?? 0;
            if (newPrio > existingPrio) {
                seen.set(fc.path, fc.status);
            }
        }
        return Array.from(seen.entries()).map(([path, status]) => ({ path, status }));
    }
    /**
     * Prune trajectories based on configurable retention policy.
     *
     * @param maxAgeDays       Remove trajectories older than this (default: 90)
     * @param minScore         Remove trajectories with score below this (default: 0.1)
     * @param maxTrajectories  Maximum number to keep (default: 500)
     * @param verbose          Log pruning details
     * @returns                Number of trajectories removed
     */
    pruneByPolicy(maxAgeDays = 90, minScore = 0.1, maxTrajectories = 500, verbose = false) {
        const data = readTrajectories();
        const before = Object.keys(data.trajectories).length;
        const now = Date.now();
        const ageCutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
        let removed = 0;
        // Remove by age
        for (const [id, traj] of Object.entries(data.trajectories)) {
            if (traj.timestamp < ageCutoff) {
                delete data.trajectories[id];
                getVectorStore().delete(id).catch(() => { });
                removed++;
                if (verbose) {
                    logger.debug(`Removed old trajectory ${id.slice(0, 16)}... (age exceeds ${maxAgeDays}d)`);
                }
            }
        }
        // Remove by score
        for (const [id, traj] of Object.entries(data.trajectories)) {
            if (traj.score < minScore) {
                delete data.trajectories[id];
                getVectorStore().delete(id).catch(() => { });
                removed++;
                if (verbose) {
                    logger.debug(`Removed low-quality trajectory ${id.slice(0, 16)}... (score: ${traj.score.toFixed(2)})`);
                }
            }
        }
        // Enforce max count
        const entries = Object.entries(data.trajectories);
        if (entries.length > maxTrajectories) {
            const sorted = entries.sort(([, a], [, b]) => a.score - b.score);
            const toRemove = sorted.slice(0, entries.length - maxTrajectories);
            for (const [id] of toRemove) {
                delete data.trajectories[id];
                getVectorStore().delete(id).catch(() => { });
                removed++;
            }
        }
        if (removed > 0) {
            writeTrajectories(data);
        }
        return removed;
    }
    /**
     * Get compression statistics showing memory usage and optimization potential.
     */
    getCompressionStats() {
        const data = readTrajectories();
        const trajs = Object.values(data.trajectories);
        const now = Date.now();
        const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
        const oldTrajectories = trajs.filter((t) => t.timestamp < thirtyDaysAgo).length;
        const lowScoreTrajectories = trajs.filter((t) => t.score < 0.3).length;
        // Count mergeable groups (2+ trajectories with same fingerprint)
        const fingerprintCounts = new Map();
        for (const t of trajs) {
            const key = t.projectFingerprint || 'unknown';
            fingerprintCounts.set(key, (fingerprintCounts.get(key) || 0) + 1);
        }
        const mergeableGroups = Array.from(fingerprintCounts.values()).filter((c) => c >= 2).length;
        // Estimate size (rough: ~2KB per trajectory)
        const totalSizeBytes = trajs.length * 2048;
        const reductionEstimate = Math.min(100, Math.round(((oldTrajectories + lowScoreTrajectories * 0.5) / Math.max(1, trajs.length)) * 100));
        return {
            totalTrajectories: trajs.length,
            totalSizeBytes,
            oldTrajectories,
            lowScoreTrajectories,
            mergeableGroups,
            estimatedOptimization: `~${reductionEstimate}% reduction possible`,
        };
    }
}
// Singleton instance
let storeInstance = null;
export function getTrajectoryStore() {
    if (!storeInstance) {
        storeInstance = new TrajectoryStore();
    }
    return storeInstance;
}
//# sourceMappingURL=trajectory-store.js.map