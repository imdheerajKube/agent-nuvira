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
 * 3. Skills are persisted as JSON in ~/.nuvira/skills/
 * 4. Users can list, inspect, and run skills via `nuvira skill`
 * 5. The SkillRunnerAgent executes skill steps as a pre-filled task plan
 */

// ─── Skill Parameter ────────────────────────────────────────────────────────

/** The type of a skill parameter value */
export type SkillParameterType = 'string' | 'file-path' | 'code-snippet' | 'choice';

/** A parameter that a skill accepts from the user */
export interface SkillParameter {
  /** Parameter name (used in prompt templates as {{name}}) */
  name: string;
  /** Human-readable description of what this parameter is for */
  description: string;
  /** The type of value expected */
  type: SkillParameterType;
  /** Whether this parameter is required */
  required: boolean;
  /** Default value if not provided */
  defaultValue?: string;
  /** For 'choice' type, the list of valid options */
  options?: string[];
}

// ─── Skill Step ─────────────────────────────────────────────────────────────

/** A single step in a skill's execution plan */
export interface SkillStep {
  /** Agent type to execute this step (e.g., 'writer', 'runner', 'reviewer') */
  agentType: string;
  /** Description of what this step does (shown to user during execution) */
  description: string;
  /**
   * LLM prompt template with {{parameterName}} placeholders.
   * These are resolved at invocation time with user-provided values.
   * Steps without prompt templates (e.g., runner steps) may omit this.
   */
  promptTemplate?: string;
  /** IDs of steps this step depends on (index-based: ['step-0', 'step-1']) */
  dependsOn: string[];
  /** Description of what output/outcome is expected from this step */
  expectedOutput?: string;
}

// ─── Skill Definition ───────────────────────────────────────────────────────

/** A compiled skill — a reusable, executable task plan derived from trajectories */
export interface Skill {
  /** Unique identifier (e.g., 'skill-add-cli-command-v1') */
  id: string;
  /** Short descriptive name (e.g., 'Add CLI Command') */
  name: string;
  /** One-line description of what this skill does */
  description: string;
  /** Semantic version for tracking evolution */
  version: string;
  /** The type of goal this skill addresses (used for matching) */
  goalPattern: string;
  /** Hermes-style: detailed trigger conditions for when to use this skill */
  whenToUse?: string[];
  /** Hermes-style: detailed conditions for when NOT to use this skill */
  whenNotToUse?: string[];
  /** Ordered list of execution steps */
  steps: SkillStep[];
  /** Parameters the skill accepts from the user */
  parameters: SkillParameter[];
  /** Tags for categorization and search (e.g., ['cli', 'typescript', 'scaffold']) */
  tags: string[];
  /** IDs of source trajectories this skill was distilled from */
  sourceTrajectoryIds: string[];
  /** Quality score (0–1) — average of source trajectory scores */
  qualityScore: number;
  /** How many times this skill has been invoked */
  usageCount: number;
  /** When this skill was created */
  createdAt: number;
  /** When this skill was last used */
  lastUsedAt: number;
}

// ─── Compilation Result ─────────────────────────────────────────────────────

/** Result of a single compilation run */
export interface CompilationResult {
  /** Skills that were newly created */
  newSkills: Skill[];
  /** Skills that were updated (merged with new data) */
  updatedSkills: Skill[];
  /** Number of trajectories used as source */
  sourceTrajectoryCount: number;
  /** Average score of source trajectories */
  avgSourceScore: number;
}

// ─── Skill Status ───────────────────────────────────────────────────────────

/** Summary statistics about stored skills */
export interface SkillSummary {
  total: number;
  totalUsage: number;
  avgQualityScore: number;
  topTags: Array<{ tag: string; count: number }>;
  oldestSkill: string;
  newestSkill: string;
}

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

/**
 * The precedence rule attached to every skill whose steps are handed to the
 * model as instructions (the `skill` tool and the store's skill view).
 *
 * WHY THIS EXISTS. A skill's methodology was arriving with the same authority
 * as the user's request, and on 2026-09-23 that lost: asked to assess a project
 * with the explicit constraint "do NOT modify any files yet — just report", the
 * agent loaded `code-assessment`, hit the step that says produce the artifact,
 * and wrote `CODE_ASSESSMENT.md` anyway. A skill is reusable METHODOLOGY; it
 * is never an authorisation to override what the person in this conversation
 * just told you. Keeping the text in one place means every surface that
 * injects steps states the same rule.
 */
export const SKILL_PRECEDENCE_NOTE =
  'PRECEDENCE — explicit constraints in the user\u2019s CURRENT request outrank these steps. A skill is ' +
  'a methodology, not an authorization: if the request says "do not modify files", "report only", ' +
  '"change nothing yet", or names a scope, honour it even when a step below tells you to write an ' +
  'artifact or edit code. When the two conflict, the user wins \u2014 carry out the part that is still ' +
  'compatible and say in one line what you skipped and why, instead of quietly doing the thing they ' +
  'forbade.';
