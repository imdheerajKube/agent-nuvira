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
import { Agent } from '../agent.js';
import { getSkillStore } from '../../learning/skill-store.js';
// ─── Skill Runner Agent ─────────────────────────────────────────────────────
export class SkillRunnerAgent extends Agent {
    name = 'SkillRunner';
    description = 'Executes a compiled skill as a pre-filled task plan';
    async execute(context, _callLLM) {
        // Parse the skill reference from the task description
        // Format: "Run skill: <skill-name> --param1=value1 --param2=value2"
        const description = context.goal;
        const skillRef = this.parseSkillReference(description);
        if (!skillRef) {
            return {
                success: false,
                summary: 'No skill reference found in task description',
                error: 'Format: "Run skill: <skill-name> --param1=value1"',
            };
        }
        // Load the skill from the store
        const store = getSkillStore();
        let skill = null;
        // Try direct ID match first
        skill = store.get(skillRef.skillName);
        // Try name search
        if (!skill) {
            const results = store.search(skillRef.skillName);
            if (results.length > 0) {
                skill = results[0];
            }
        }
        if (!skill) {
            return {
                success: false,
                summary: `Skill not found: '${skillRef.skillName}'`,
                error: `No compiled skill matches '${skillRef.skillName}'. Run 'buff skill list' to see available skills.`,
            };
        }
        // Mark the skill as used
        store.markUsed(skill.id);
        // Resolve parameter values
        const resolvedParameters = this.resolveParameters(skill, skillRef.params);
        // Check for missing required parameters
        const missing = skill.parameters
            .filter((p) => p.required && !resolvedParameters[p.name]);
        if (missing.length > 0) {
            return {
                success: false,
                summary: `Missing required parameters: ${missing.map((p) => p.name).join(', ')}`,
                error: `Skill '${skill.name}' requires: ${missing.map((p) => `${p.name} (${p.description})`).join(', ')}`,
            };
        }
        // Build the task plan from skill steps
        const steps = skill.steps.map((step, i) => {
            // Resolve prompt template with parameter values
            let resolvedPrompt = step.promptTemplate || step.description;
            for (const [key, value] of Object.entries(resolvedParameters)) {
                resolvedPrompt = resolvedPrompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
            }
            return {
                id: `skill-step-${i}`,
                description: resolvedPrompt,
                agentType: step.agentType,
                dependsOn: step.dependsOn.map((dep) => {
                    // Convert "step-N" references to "skill-step-N"
                    const match = dep.match(/^step-(\d+)$/);
                    if (match)
                        return `skill-step-${match[1]}`;
                    return dep;
                }),
                status: 'pending',
            };
        });
        // Inject steps into the task plan
        // We add them at the beginning so they execute before any remaining tasks
        context.taskPlan.unshift(...steps);
        return {
            success: true,
            summary: `Loaded skill '${skill.name}' (${steps.length} steps)`,
            details: [
                `Skill: ${skill.name} v${skill.version}`,
                `Steps: ${steps.length}`,
                `Parameters: ${Object.entries(resolvedParameters).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
            ].join('\n'),
        };
    }
    // ── Private Helpers ────────────────────────────────────────────────────
    /**
     * Parse a skill reference from a task description.
     * Format: "Run skill: <skill-name> --param1=value1 --param2=value2"
     */
    parseSkillReference(description) {
        const match = description.match(/run\s+skill:\s+(\S+)(.*)/i);
        if (!match)
            return null;
        const skillName = match[1];
        const rest = match[2];
        // Parse --key=value and --key="value with spaces"
        const params = {};
        const paramRegex = /--(\w+)(?:=("(?:\\.|[^"\\])*"|[^\s"]+))?/g;
        let paramMatch;
        while ((paramMatch = paramRegex.exec(rest)) !== null) {
            let value = paramMatch[2] || 'true';
            // Strip surrounding quotes if present
            if (value.startsWith('"') && value.endsWith('"')) {
                value = value.slice(1, -1);
            }
            params[paramMatch[1]] = value;
        }
        return { skillName, params };
    }
    /**
     * Resolve parameter values combining defaults, existing values, and overrides.
     */
    resolveParameters(skill, overrides) {
        const resolved = {};
        for (const param of skill.parameters) {
            // Use override value first, then default, then empty string
            if (overrides[param.name] !== undefined) {
                resolved[param.name] = overrides[param.name];
            }
            else if (param.defaultValue !== undefined) {
                resolved[param.name] = param.defaultValue;
            }
            else {
                // Required params without a value are left as-is for validation
                resolved[param.name] = '';
            }
        }
        return resolved;
    }
}
//# sourceMappingURL=skill-runner.js.map