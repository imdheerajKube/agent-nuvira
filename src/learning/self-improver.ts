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

import type { OrchestrationResult } from '../agents/orchestrator.js';
import type { Trajectory } from '../memory/trajectory-store.js';
import type { LLMCallFn } from '../agents/agent.js';
import { getTrajectoryStore } from '../memory/trajectory-store.js';
import { getPatternStore } from './pattern-extractor.js';
import { getFailureLessonStore } from './failure-lessons.js';
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

/** How many failed runs before auto-extracting failure lessons */
const FAILURE_LESSON_EXTRACTION_INTERVAL = 5;

/** How many trajectories to pass for pattern extraction */
const TRAJECTORIES_FOR_EXTRACTION = 3;

/** Minimum score to consider a trajectory as "good" */
const GOOD_SCORE_THRESHOLD = 0.6;

// ─── SelfImprover ───────────────────────────────────────────────────────────

export class SelfImprover {
  private runCountSinceLastExtraction: number = 0;
  private runCountSinceLastSkillCompilation: number = 0;
  private runCountSinceLastFailureExtraction: number = 0;

  /**
   * Process a completed orchestration run through the self-improvement loop.
   * Scores the result, tracks agent stats, records failures into episodic
   * memory, and conditionally extracts patterns, compiles skills, and
   * distills failure lessons.
   *
   * @param result       The completed orchestration result
   * @param callLLM      LLM function for pattern/lesson extraction
   * @param agentModels  The model map used for this run (for tracking model perf)
   * @param verbose      Whether to log details
   */
  async processRun(
    result: OrchestrationResult,
    callLLM: LLMCallFn,
    agentModels?: Record<string, string>,
    verbose: boolean = false,
  ): Promise<void> {
    // Step 1: Score the trajectory
    const score = scoreOrchestrationResult(result);
    if (verbose) {
      logger.info(`   Self-improvement: trajectory score = ${(score * 100).toFixed(0)}%`);
    }

    // Step 2: Record per-agent stats
    const stats = getAgentStats();
    stats.recordRuns(result.agentResults, agentModels);

    // Step 3: Capture FAILED runs into episodic memory (assessment P1 — the
    // trajectory store only persists successes, so the system never learned
    // from its own misses). Record the failure, then periodically distill the
    // accumulated failures into reusable lessons.
    const hasFailedAgents = (result.agentResults || []).some((a) => !a.success);
    if (!result.success || hasFailedAgents) {
      const lessonStore = getFailureLessonStore();
      const failureId = lessonStore.recordFailure({
        goal: result.goal,
        error: result.error,
        agentResults: result.agentResults || [],
        taskPlan: result.taskPlan || [],
        fileChanges: result.fileChanges || '',
        tasksCompleted: result.tasksCompleted,
        tasksTotal: result.tasksTotal,
      });

      if (failureId) {
        if (verbose) {
          logger.info(`   📉 Recorded failed run into episodic memory (${failureId.slice(0, 16)}...)`);
        }

        // Failure-lesson distillation (every FAILURE_LESSON_EXTRACTION_INTERVAL failures)
        this.runCountSinceLastFailureExtraction++;
        if (this.runCountSinceLastFailureExtraction >= FAILURE_LESSON_EXTRACTION_INTERVAL) {
          this.runCountSinceLastFailureExtraction = 0;
          if (verbose) {
            logger.info('   Extracting failure lessons from failed runs...');
          }
          await this.extractFailureLessons(callLLM, verbose);
        }
      }
    }

    // Step 4: Conditionally extract patterns from good trajectories
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
   * Force failure-lesson extraction from the most recent failed runs.
   *
   * @param callLLM  LLM function for lesson extraction
   * @param verbose  Whether to log details
   * @returns        Number of NEW lessons extracted
   */
  async extractFailureLessons(
    callLLM: LLMCallFn,
    verbose: boolean = false,
  ): Promise<number> {
    try {
      const lessonStore = getFailureLessonStore();
      const count = await lessonStore.extractLessons(callLLM);
      if (verbose && count > 0) {
        logger.success(`   Extracted ${count} new failure lesson(s) from recent failed runs`);
      } else if (verbose) {
        logger.info('   No new failure lessons extracted (no failed runs recorded, or no new insights)');
      }
      return count;
    } catch (err) {
      if (verbose) {
        logger.debug(`Failure-lesson extraction failed: ${err}`);
      }
      return 0;
    }
  }

  /**
   * Force pattern extraction from the best trajectories in the store.
   */
  async extractPatterns(
    callLLM: LLMCallFn,
    verbose: boolean = false,
  ): Promise<number> {
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
    } catch (err) {
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
  getOptimizedModelMap(): Record<string, string> {
    const stats = getAgentStats();
    const allAgents = stats.getAllAgents();
    const modelMap: Record<string, string> = {};

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
  getStatus(): string {
    const stats = getAgentStats();
    const patternStore = getPatternStore();
    const patterns = patternStore.getAll();
    const store = getTrajectoryStore();
    const allTrajectories = store.getAll();

    const lines: string[] = [
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

    // Also show failure-lesson stats (episodic memory of what didn't work)
    const lessonStore = getFailureLessonStore();
    const lessonStats = lessonStore.getStats();
    if (lessonStats.totalFailures > 0 || lessonStats.totalLessons > 0) {
      lines.push('');
      lines.push('── Failure Lessons (what didn\'t work) ──');
      lines.push(`   Failed runs captured: ${lessonStats.totalFailures}`);
      lines.push(`   Distilled lessons: ${lessonStats.totalLessons}`);
      if (lessonStats.domainsCovered.length > 0) {
        lines.push(`   Domains covered: ${lessonStats.domainsCovered.join(', ')}`);
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
  async compileSkills(
    callLLM: LLMCallFn,
    verbose: boolean = false,
  ): Promise<number> {
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
    } catch (err) {
      if (verbose) {
        logger.debug(`Skill compilation failed: ${err}`);
      }
      return 0;
    }
  }

  /**
   * Reset extraction counter (called when user manually extracts patterns).
   */
  resetExtractionCounter(): void {
    this.runCountSinceLastExtraction = 0;
  }

  /**
   * Reset skill compilation counter (called when user manually compiles skills).
   */
  resetSkillCompilationCounter(): void {
    this.runCountSinceLastSkillCompilation = 0;
  }

  /**
   * Reset failure-lesson extraction counter (called when user manually
   * extracts lessons so the auto-interval restarts).
   */
  resetFailureLessonCounter(): void {
    this.runCountSinceLastFailureExtraction = 0;
  }

  // ── Private ────────────────────────────────────────────────────────────

  private averageScore(trajectories: Trajectory[]): string {
    const scored = trajectories.filter((t) => t.score !== undefined);
    if (scored.length === 0) return 'N/A';
    const avg = scored.reduce((sum, t) => sum + (t.score || 0), 0) / scored.length;
    return `${(avg * 100).toFixed(0)}%`;
  }
}

// Singleton
let improverInstance: SelfImprover | null = null;

export function getSelfImprover(): SelfImprover {
  if (!improverInstance) {
    improverInstance = new SelfImprover();
  }
  return improverInstance;
}
