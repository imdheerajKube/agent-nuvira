/**
 * SkillCompiler — Converts successful agent execution trajectories into
 * reusable, executable skill definitions.
 *
 * This is the core of the "closed learning loop". After the SelfImprover
 * has scored and stored trajectories, the SkillCompiler:
 *
 * 1. Selects high-scoring, diverse trajectories
 * 2. Sends them to the LLM for analysis and generalization
 * 3. Receives structured skill definitions with parameterized prompt templates
 * 4. Stores the compiled skills in the SkillStore
 * 5. Integrates with the Orchestrator so skills can be used as pre-filled plans
 *
 * Skill vs. Pattern distinction:
 * - Patterns → descriptive text injected into planner prompts (soft guidance)
 * - Skills → structured executable definitions with prompt templates (hard guidance)
 * Both complement each other in the self-improvement pipeline.
 */
import type { Trajectory } from '../memory/trajectory-store.js';
import type { LLMCallFn } from '../agents/agent.js';
import type { Skill, CompilationResult } from './skill-types.js';
/**
 * The SkillCompiler transforms successful trajectories into reusable skills.
 *
 * Usage:
 * ```ts
 * const compiler = new SkillCompiler();
 * const result = await compiler.compile(bestTrajectories, callLLM);
 * console.log(`Created ${result.newSkills.length} new skills`);
 * ```
 */
export declare class SkillCompiler {
    /**
     * Compile one or more skills from a set of high-scoring trajectories.
     *
     * @param trajectories  High-scoring trajectories to learn from
     * @param callLLM       LLM function for analysis and generalization
     * @param verbose       Whether to log details
     * @returns             Compilation result with new/updated skills
     */
    compile(trajectories: Trajectory[], callLLM: LLMCallFn, verbose?: boolean): Promise<CompilationResult>;
    /**
     * Format a skill as a human-readable string for CLI display.
     */
    static formatSkill(skill: Skill, detailed?: boolean): string;
    /**
     * Format multiple skills as a summary table.
     */
    static formatSkillList(skills: Skill[]): string;
    private buildCompilationPrompt;
    private parseSkills;
    private finalizeSkill;
    private bumpVersion;
}
export declare function getSkillCompiler(): SkillCompiler;
export declare function resetSkillCompiler(): void;
//# sourceMappingURL=skill-compiler.d.ts.map