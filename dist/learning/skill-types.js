/**
 * Skill Types — Core type definitions for the Skill Compiler system.
 *
 * A "Skill" is a reusable, executable plan derived from successful agent
 * trajectories. Unlike "Patterns" (which are descriptive text injected into
 * planner prompts), Skills are structured definitions that can be directly
 * invoked via CLI or used as pre-built task plans.
 *
 * Flow:
 * 1. Agent trajectories are stored → high-scoring ones are selected
 * 2. SkillCompiler analyzes them via LLM → extracts generalized skill definitions
 * 3. Skills are persisted as JSON in ~/.buff/skills/
 * 4. Users can list, inspect, and run skills via `buff skill`
 * 5. The SkillRunnerAgent executes skill steps as a pre-filled task plan
 */
// ─── Constants ──────────────────────────────────────────────────────────────
/** Max skills to keep in the store */
export const MAX_SKILLS = 50;
/** Min trajectories needed for compilation */
export const MIN_TRAJECTORIES_FOR_COMPILATION = 2;
/** Max trajectories to use for a single compilation pass */
export const MAX_TRAJECTORIES_FOR_COMPILATION = 5;
/** Min score for a trajectory to be considered for compilation */
export const MIN_TRAJECTORY_SCORE_FOR_COMPILATION = 0.65;
/** How many successful runs between auto-compilation checks */
export const SKILL_COMPILATION_INTERVAL = 5;
/** Skills storage directory version */
export const SKILL_STORE_VERSION = 1;
//# sourceMappingURL=skill-types.js.map