/**
 * MemoryIntegration — Connects the persistent memory system to the Orchestrator.
 *
 * This module provides the glue between agent execution and memory:
 * - Before planning: retrieves similar past trajectories as few-shot examples
 * - After execution: stores the successful trajectory for future use
 *
 * The Orchestrator calls these hooks when the `useMemory` option is enabled.
 */
import { getTrajectoryStore } from './trajectory-store.js';
import { getPatternStore } from '../learning/pattern-extractor.js';
import { getFailureLessonStore } from '../learning/failure-lessons.js';
import { logger } from '../utils/logger.js';
/**
 * Retrieve relevant past trajectories to use as few-shot examples
 * for the PlannerAgent, plus coding patterns and failure lessons.
 *
 * @param goal     The current user goal
 * @param callLLM  LLM function for embedding generation
 * @param k        Maximum number of trajectories to retrieve
 * @returns        An object with:
 *   - trajectories: the raw trajectory objects
 *   - fewShotContext: formatted string for injection into planner prompts
 *   - patternContext: reusable patterns from successful runs (may be '')
 *   - failureLessonContext: lessons from past FAILED runs (may be '')
 */
export async function retrieveMemoryContext(goal, callLLM, k = 3) {
    const store = getTrajectoryStore();
    const trajectories = await store.searchByGoal(goal, callLLM, k);
    const fewShotContext = store.formatAsFewShot(trajectories);
    // Derive domain tags from the trajectory project fingerprint when available.
    const domainTags = trajectories.length > 0
        ? trajectories[0].projectFingerprint.split(',').map((s) => s.trim())
        : [];
    // Also retrieve relevant coding patterns (positive episodic memory)
    let patternContext = '';
    try {
        const patternStore = getPatternStore();
        patternContext = patternStore.formatAsPrompt(domainTags);
    }
    catch {
        // Non-critical — patterns are optional
    }
    // Also retrieve failure lessons (negative episodic memory — assessment P1).
    // Lessons match the same domain tags so the planner avoids past mistakes in
    // the same kind of project; when no tags are known (fresh project), the store
    // falls back to the most recent lessons. Never throws — corrupt store = ''.
    let failureLessonContext = '';
    try {
        const lessonStore = getFailureLessonStore();
        failureLessonContext = lessonStore.formatAsPrompt(domainTags);
    }
    catch {
        // Non-critical — failure lessons are optional
    }
    return {
        trajectories,
        fewShotContext,
        patternContext: patternContext || '',
        failureLessonContext: failureLessonContext || '',
    };
}
/**
 * Store a successful orchestration result as a trajectory for future use.
 * This is called at the end of the orchestration pipeline.
 *
 * @param result         The orchestration result
 * @param callLLM        LLM function for embedding generation
 * @param taskPlan       The task plan that was executed
 * @param contextFiles   The files that were gathered as context
 * @param verbose        Whether to log details
 * @returns              The trajectory ID, or empty string if not saved
 */
export async function storeExecutionTrajectory(result, callLLM, taskPlan, contextFiles, verbose = false) {
    try {
        const store = getTrajectoryStore();
        const id = await store.save(result, callLLM, taskPlan, contextFiles);
        if (id && verbose) {
            logger.success(`   Stored execution trajectory: ${id}`);
        }
        return id;
    }
    catch (err) {
        if (verbose) {
            logger.debug(`Failed to store trajectory: ${err}`);
        }
        return '';
    }
}
/**
 * Get memory storage statistics.
 */
export async function getMemoryStats() {
    const store = getTrajectoryStore();
    return store.stats();
}
/**
 * Clear all stored memory (trajectories, failure lessons, and vector index).
 * Also resets the embedding tier cache so native embeddings (Xenova/Python)
 * can be re-detected on the next embedding call.
 */
export async function clearMemory() {
    const store = getTrajectoryStore();
    await store.clear();
    // Also clear the failure-lesson episodic memory (assessment P1).
    try {
        getFailureLessonStore().clear();
    }
    catch {
        // Non-critical
    }
    // Reset embedding tier cache — allows re-detection of newly installed
    // @huggingface/transformers or sentence-transformers packages
    try {
        const { resetEmbeddingTierCache } = await import('./embedder.js');
        resetEmbeddingTierCache();
    }
    catch {
        // Non-critical
    }
}
//# sourceMappingURL=memory-integration.js.map