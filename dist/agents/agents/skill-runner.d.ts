/**
 * SkillRunnerAgent — Executes a compiled skill as a pre-filled task plan.
 *
 * When the Orchestrator encounters a task with agentType 'skill-runner',
 * this agent:
 * 1. Receives the skill ID from the task description or context metadata
 * 2. Loads the skill definition from the SkillStore
 * 3. Resolves parameter values from user input or context
 * 4. Substitutes {{parameter}} placeholders in prompt templates
 * 5. Injects the resolved steps into the task plan for sequential execution
 *
 * Usage in task plans:
 * ```
 * {
 *   agentType: 'skill-runner',
 *   description: 'Run skill: Add CLI Command --commandName=deploy',
 * }
 * ```
 *
 * The skill ID and parameters can be specified in the task description
 * using the format: "Run skill: <skill-name> --param1=value1 --param2=value2"
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
export declare class SkillRunnerAgent extends Agent {
    readonly name = "SkillRunner";
    readonly description = "Executes a compiled skill as a pre-filled task plan";
    execute(context: AgentContext, _callLLM: LLMCallFn): Promise<AgentResult>;
    /**
     * Parse a skill reference from a task description.
     * Format: "Run skill: <skill-name> --param1=value1 --param2=value2"
     */
    private parseSkillReference;
    /**
     * Resolve parameter values combining defaults, existing values, and overrides.
     */
    private resolveParameters;
}
//# sourceMappingURL=skill-runner.d.ts.map