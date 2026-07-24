/**
 * SelfImprover — The self-improvement loop that ties together scoring,
 * agent performance tracking, pattern extraction, skill compilation,
 * and model optimization.
 *
 * After each orchestration run (when `useMemory: true`), the SelfImprover:
 * 1. Scores the trajectory (how well did we do?)
 * 2. Records per-agent stats (which agents/models succeed/fail?)
 * 3. Periodically extracts patterns from high-scoring trajectories
 * 4. Periodically compiles high-scoring trajectories into executable skills
 * 5. Provides optimization recommendations (best models per agent)
 *
 * The SelfImprover is called by the Orchestrator post-execution hook.
 * Users can also interact with it via the `buff learn` and `buff skill` CLI commands.
 */
import { getTrajectoryStore } from '../memory/trajectory-store.js';
import { getPatternStore } from './pattern-extractor.js';
import { getAgentStats } from './agent-stats.js';
import { scoreOrchestrationResult } from './scorer.js';
import { getSkillCompiler } from './skill-compiler.js';
import { getSkillStore } from './skill-store.js';
import { logger } from '../utils/logger.js';
// ─── Constants ──────────────────────────────────────────────────────────────
/** How many successful runs before auto-extracting patterns */
const PATTERN_EXTRACTION_INTERVAL = 5;
/** How many successful runs before auto-compiling skills */
const SKILL_COMPILATION_INTERVAL = 8;
/** How many trajectories to pass for pattern extraction */
const TRAJECTORIES_FOR_EXTRACTION = 3;
/** Minimum score to consider a trajectory as "good" */
const GOOD_SCORE_THRESHOLD = 0.6;
// ─── SelfImprover ───────────────────────────────────────────────────────────
export class SelfImprover {
    runCountSinceLastExtraction = 0;
    runCountSinceLastSkillCompilation = 0;
    /**
     * Process a completed orchestration run through the self-improvement loop.
     * Scores the result, tracks agent stats, and conditionally extracts patterns
     * and compiles skills.
     *
     * @param result       The completed orchestration result
     * @param callLLM      LLM function for pattern extraction
     * @param agentModels  The model map used for this run (for tracking model perf)
     * @param verbose      Whether to log details
     */
    async processRun(result, callLLM, agentModels, verbose = false) {
        // Step 1: Score the trajectory
        const score = scoreOrchestrationResult(result);
        if (verbose) {
            logger.info(`   Self-improvement: trajectory score = ${(score * 100).toFixed(0)}%`);
        }
        // Step 2: Record per-agent stats
        const stats = getAgentStats();
        stats.recordRuns(result.agentResults, agentModels);
        // Step 3: Conditionally extract patterns from good trajectories
        if (score >= GOOD_SCORE_THRESHOLD) {
            this.runCountSinceLastExtraction++;
            this.runCountSinceLastSkillCompilation++;
            // Pattern extraction (every PATTERN_EXTRACTION_INTERVAL runs)
            if (this.runCountSinceLastExtraction >= PATTERN_EXTRACTION_INTERVAL) {
                this.runCountSinceLastExtraction = 0;
                if (verbose) {
                    logger.info('   Extracting coding patterns from successful trajectories...');
                }
                await this.extractPatterns(callLLM, verbose);
            }
            // Skill compilation (every SKILL_COMPILATION_INTERVAL runs)
            if (this.runCountSinceLastSkillCompilation >= SKILL_COMPILATION_INTERVAL) {
                this.runCountSinceLastSkillCompilation = 0;
                if (verbose) {
                    logger.info('   Compiling reusable skills from successful trajectories...');
                }
                await this.compileSkills(callLLM, verbose);
            }
        }
    }
    /**
     * Force pattern extraction from the best trajectories in the store.
     */
    async extractPatterns(callLLM, verbose = false) {
        try {
            const store = getTrajectoryStore();
            const allTrajectories = store.getAll();
            // Get the highest-scoring trajectories
            const best = allTrajectories
                .filter((t) => t.score !== undefined)
                .sort((a, b) => (b.score || 0) - (a.score || 0))
                .slice(0, TRAJECTORIES_FOR_EXTRACTION);
            if (best.length < 2) {
                if (verbose) {
                    logger.info('   Not enough scored trajectories for pattern extraction');
                }
                return 0;
            }
            const patternStore = getPatternStore();
            const count = await patternStore.extractFromTrajectories(best, callLLM);
            if (verbose && count > 0) {
                logger.success(`   Extracted ${count} new pattern(s) from ${best.length} trajectories`);
            }
            return count;
        }
        catch (err) {
            if (verbose) {
                logger.debug(`Pattern extraction failed: ${err}`);
            }
            return 0;
        }
    }
    /**
     * Get optimization recommendations based on collected stats.
     * Returns a recommended model map for the Orchestrator.
     */
    getOptimizedModelMap() {
        const stats = getAgentStats();
        const allAgents = stats.getAllAgents();
        const modelMap = {};
        for (const agentType of Object.keys(allAgents)) {
            const bestModel = stats.getBestModel(agentType);
            if (bestModel) {
                modelMap[agentType] = bestModel;
            }
        }
        return modelMap;
    }
    /**
     * Get a human-readable summary of the self-improvement status.
     */
    getStatus() {
        const stats = getAgentStats();
        const patternStore = getPatternStore();
        const patterns = patternStore.getAll();
        const store = getTrajectoryStore();
        const allTrajectories = store.getAll();
        const lines = [
            '🔄 Self-Improvement Status',
            '',
            '── Trajectories ──',
            `   Total stored: ${allTrajectories.length}`,
            `   Scored: ${allTrajectories.filter((t) => t.score !== undefined).length}`,
            `   Avg score: ${this.averageScore(allTrajectories)}`,
            '',
            '── Patterns ──',
            `   Total patterns: ${patterns.length}`,
            `   Domains covered: ${[...new Set(patterns.flatMap((p) => p.applicableDomains))].join(', ') || 'none'}`,
            '',
            `── Performance ──`,
            `   Total runs tracked: ${stats.getRaw().totalRuns}`,
            `   Agents tracked: ${Object.keys(stats.getAllAgents()).length}`,
        ];
        // Also show skill stats
        const skillStore = getSkillStore();
        const skillSummary = skillStore.getSummary();
        if (skillSummary.total > 0) {
            lines.push('');
            lines.push('── Skills ──');
            lines.push(`   Total skills: ${skillSummary.total}`);
            lines.push(`   Total invocations: ${skillSummary.totalUsage}`);
            lines.push(`   Avg quality: ${(skillSummary.avgQualityScore * 100).toFixed(0)}%`);
            if (skillSummary.topTags.length > 0) {
                lines.push(`   Top tags: ${skillSummary.topTags.map((t) => `${t.tag} (${t.count})`).join(', ')}`);
            }
        }
        lines.push('');
        lines.push(stats.formatStats());
        lines.push('');
        lines.push(stats.formatModelRecommendations());
        return lines.join('\n');
    }
    /**
     * Force skill compilation from the best trajectories in the store.
     */
    async compileSkills(callLLM, verbose = false) {
        try {
            const store = getTrajectoryStore();
            const allTrajectories = store.getAll();
            // Get the highest-scoring trajectories
            const best = allTrajectories
                .filter((t) => t.score !== undefined)
                .sort((a, b) => (b.score || 0) - (a.score || 0))
                .slice(0, 5);
            if (best.length < 2) {
                if (verbose) {
                    logger.info('   Not enough scored trajectories for skill compilation');
                }
                return 0;
            }
            const compiler = getSkillCompiler();
            const result = await compiler.compile(best, callLLM, verbose);
            const totalNew = result.newSkills.length + result.updatedSkills.length;
            if (verbose && totalNew > 0) {
                logger.success(`   Compiled ${totalNew} skill(s) from ${result.sourceTrajectoryCount} trajectories`);
            }
            return totalNew;
        }
        catch (err) {
            if (verbose) {
                logger.debug(`Skill compilation failed: ${err}`);
            }
            return 0;
        }
    }
    /**
     * Reset extraction counter (called when user manually extracts patterns).
     */
    resetExtractionCounter() {
        this.runCountSinceLastExtraction = 0;
    }
    /**
     * Reset skill compilation counter (called when user manually compiles skills).
     */
    resetSkillCompilationCounter() {
        this.runCountSinceLastSkillCompilation = 0;
    }
    // ── Private ────────────────────────────────────────────────────────────
    averageScore(trajectories) {
        const scored = trajectories.filter((t) => t.score !== undefined);
        if (scored.length === 0)
            return 'N/A';
        const avg = scored.reduce((sum, t) => sum + (t.score || 0), 0) / scored.length;
        return `${(avg * 100).toFixed(0)}%`;
    }
}
// Singleton
let improverInstance = null;
export function getSelfImprover() {
    if (!improverInstance) {
        improverInstance = new SelfImprover();
    }
    return improverInstance;
}
//# sourceMappingURL=self-improver.js.map