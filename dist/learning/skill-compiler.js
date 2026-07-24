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
import { MIN_TRAJECTORIES_FOR_COMPILATION, MAX_TRAJECTORIES_FOR_COMPILATION, MIN_TRAJECTORY_SCORE_FOR_COMPILATION, } from './skill-types.js';
import { getSkillStore } from './skill-store.js';
import { logger } from '../utils/logger.js';
// ─── LLM Extraction Prompt ──────────────────────────────────────────────────
const COMPILATION_PROMPT = `You are a senior software architect specializing in creating reusable execution templates. Given a set of successful task execution trajectories, identify common patterns and compile them into a reusable "skill" — a parameterized, executable plan that can be invoked directly to accomplish similar tasks.

For each distinct skill you identify, provide a JSON object with the following structure:

{
  "name": "Short descriptive name (max 50 chars)",
  "description": "One-line description of what this skill does",
  "version": "1.0.0",
  "goalPattern": "A generic description of the type of goal this skill addresses (e.g., 'Add a new CLI command to a Node.js project')",
  "tags": ["tag1", "tag2"],  // 2-5 categorization tags
  "parameters": [
    {
      "name": "paramName",
      "description": "What this parameter is for",
      "type": "string|file-path|code-snippet|choice",
      "required": true,
      "defaultValue": "optional default",
      "options": ["only", "for", "choice", "type"]
    }
  ],
  "steps": [
    {
      "agentType": "context-gatherer|planner|writer|reviewer|runner|tester|security|debugger",
      "description": "What this step does in clear language",
      "promptTemplate": "The LLM prompt template with {{parameterName}} placeholders. Describe the task generically so it works for any similar goal.",
      "dependsOn": ["step-0", "step-1"],
      "expectedOutput": "What outcome this step should produce"
    }
  ]
}

Guidelines:
1. Make steps generic enough to apply to any similar task, but specific enough to be useful
2. Use {{parameterName}} placeholders in prompt templates for user-provided values
3. Include 2-5 steps max — keep skills focused and composable
4. Set dependsOn correctly based on the observed execution order
5. Choose tags that help users discover this skill (e.g., 'cli', 'api', 'typescript', 'python', 'refactor', 'test')
6. Extract 1-2 skills max from the provided trajectories
7. Focus on the common structure, not specific implementation details

Return ONLY a JSON array of skills. No markdown, no explanations.

Example:
[
  {
    "name": "Add CLI Command",
    "description": "Adds a new command to an existing CLI application",
    "version": "1.0.0",
    "goalPattern": "Add a new CLI command to a project using commander or similar framework",
    "tags": ["cli", "typescript", "node"],
    "parameters": [
      {
        "name": "commandName",
        "description": "The name of the command to add (e.g., 'deploy')",
        "type": "string",
        "required": true
      },
      {
        "name": "description",
        "description": "Short description shown in help text",
        "type": "string",
        "required": true,
        "defaultValue": "New command"
      }
    ],
    "steps": [
      {
        "agentType": "context-gatherer",
        "description": "Scan the codebase to understand the CLI framework and command registration pattern",
        "promptTemplate": "Find the CLI command registration file (likely using commander or similar) and understand the existing command pattern. Look for how existing commands are registered, what imports they use, and the file structure convention.",
        "dependsOn": [],
        "expectedOutput": "Context about the CLI structure and existing command patterns"
      },
      {
        "agentType": "writer",
        "description": "Create the new command file and register it",
        "promptTemplate": "Add a new '{{commandName}}' command to the CLI with description '{{description}}'. Follow the existing command pattern found in the codebase. Create the command handler file and register it in the router.",
        "dependsOn": ["step-0"],
        "expectedOutput": "New command file created and registered"
      },
      {
        "agentType": "reviewer",
        "description": "Review the new command for correctness and consistency",
        "dependsOn": ["step-1"],
        "expectedOutput": "Reviewed and verified the implementation"
      }
    ]
  }
]`;
// ─── SkillCompiler ──────────────────────────────────────────────────────────
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
export class SkillCompiler {
    /**
     * Compile one or more skills from a set of high-scoring trajectories.
     *
     * @param trajectories  High-scoring trajectories to learn from
     * @param callLLM       LLM function for analysis and generalization
     * @param verbose       Whether to log details
     * @returns             Compilation result with new/updated skills
     */
    async compile(trajectories, callLLM, verbose = false) {
        // Filter to only high-scoring trajectories
        const candidates = trajectories
            .filter((t) => t.score >= MIN_TRAJECTORY_SCORE_FOR_COMPILATION)
            .slice(0, MAX_TRAJECTORIES_FOR_COMPILATION);
        if (candidates.length < MIN_TRAJECTORIES_FOR_COMPILATION) {
            if (verbose) {
                logger.info(`   Skill compilation: need ${MIN_TRAJECTORIES_FOR_COMPILATION}+ trajectories ` +
                    `with score >= ${MIN_TRAJECTORY_SCORE_FOR_COMPILATION}, got ${candidates.length}`);
            }
            return { newSkills: [], updatedSkills: [], sourceTrajectoryCount: 0, avgSourceScore: 0 };
        }
        const avgScore = candidates.reduce((sum, t) => sum + t.score, 0) / candidates.length;
        // Build the extraction prompt
        const prompt = this.buildCompilationPrompt(candidates);
        let response;
        try {
            response = await callLLM(prompt, {
                temperature: 0.3,
                maxTokens: 4096,
            });
        }
        catch (err) {
            if (verbose) {
                logger.debug(`Skill compilation LLM call failed: ${err}`);
            }
            return { newSkills: [], updatedSkills: [], sourceTrajectoryCount: 0, avgSourceScore: 0 };
        }
        // Parse the LLM response into skills
        const parsedSkills = this.parseSkills(response);
        if (parsedSkills.length === 0) {
            if (verbose) {
                logger.info('   Skill compilation: LLM returned no parseable skills');
            }
            return { newSkills: [], updatedSkills: [], sourceTrajectoryCount: 0, avgSourceScore: 0 };
        }
        // Process and store each skill
        const store = getSkillStore();
        const newSkills = [];
        const updatedSkills = [];
        for (const rawSkill of parsedSkills) {
            const existing = store.search(rawSkill.name);
            const isUpdate = existing.length > 0 &&
                existing[0].name.toLowerCase() === rawSkill.name.toLowerCase();
            const skill = this.finalizeSkill(rawSkill, candidates, isUpdate ? existing[0] : undefined);
            if (isUpdate) {
                // Remove old version before saving new one
                store.delete(existing[0].id);
                store.save(skill);
                updatedSkills.push(skill);
                if (verbose) {
                    logger.info(`   Updated skill: ${skill.name} v${skill.version}`);
                }
            }
            else {
                store.save(skill);
                newSkills.push(skill);
                if (verbose) {
                    logger.info(`   Created skill: ${skill.name} v${skill.version}`);
                }
            }
        }
        return {
            newSkills,
            updatedSkills,
            sourceTrajectoryCount: candidates.length,
            avgSourceScore: avgScore,
        };
    }
    /**
     * Format a skill as a human-readable string for CLI display.
     */
    static formatSkill(skill, detailed = false) {
        const lines = [
            `🧠 ${skill.name}  v${skill.version}`,
            `   ${skill.description}`,
            `   Goal: ${skill.goalPattern}`,
            `   Quality: ${(skill.qualityScore * 100).toFixed(0)}% | Used: ${skill.usageCount}x`,
            `   Tags: ${skill.tags.join(', ')}`,
        ];
        if (detailed) {
            lines.push('');
            lines.push('   Parameters:');
            if (skill.parameters.length === 0) {
                lines.push('      (none)');
            }
            else {
                for (const param of skill.parameters) {
                    const required = param.required ? ' (required)' : '';
                    const def = param.defaultValue ? ` [default: ${param.defaultValue}]` : '';
                    lines.push(`      • ${param.name}: ${param.description}${required}${def}`);
                }
            }
            lines.push('');
            lines.push('   Steps:');
            for (let i = 0; i < skill.steps.length; i++) {
                const step = skill.steps[i];
                const deps = step.dependsOn.length > 0
                    ? ` (after: ${step.dependsOn.join(', ')})`
                    : '';
                lines.push(`     ${i}. [${step.agentType}] ${step.description}${deps}`);
            }
        }
        return lines.join('\n');
    }
    /**
     * Format multiple skills as a summary table.
     */
    static formatSkillList(skills) {
        if (skills.length === 0) {
            return 'No skills compiled yet. Run some tasks with --use-memory to generate trajectories first.';
        }
        const lines = [
            `🧠 ${skills.length} Skill(s) Compiled`,
            '',
            '   ┌──────────────────────────────────┬────────────┬────────┬───────┐',
            '   │ Skill                            │ Quality    │ Uses   │ Tags  │',
            '   ├──────────────────────────────────┼────────────┼────────┼───────┤',
        ];
        for (const skill of skills) {
            const name = skill.name.padEnd(30).slice(0, 30);
            const quality = `${(skill.qualityScore * 100).toFixed(0)}%`.padStart(9);
            const uses = String(skill.usageCount).padStart(7);
            const tags = skill.tags.slice(0, 2).join(', ').padEnd(7).slice(0, 7);
            lines.push(`   │ ${name} │ ${quality} │ ${uses} │ ${tags} │`);
        }
        lines.push('   └──────────────────────────────────┴────────────┴────────┴───────┘');
        lines.push('');
        lines.push('Run `buff skill show <name>` for details, or `buff skill run <name>` to execute.');
        return lines.join('\n');
    }
    // ── Private ────────────────────────────────────────────────────────────
    buildCompilationPrompt(trajectories) {
        const trajText = trajectories
            .map((t, i) => `Trajectory ${i + 1} (score: ${t.score.toFixed(2)}):\n` +
            `Goal: ${t.goal}\n` +
            `Project: ${t.projectFingerprint}\n` +
            `Steps: ${t.taskPlan.map((s) => `[${s.agentType}] ${s.description}`).join('\n')}\n` +
            `Files: ${t.fileChanges.map((fc) => fc.path).join(', ')}\n`)
            .join('\n---\n');
        return `${COMPILATION_PROMPT}\n\n## Execution Trajectories\n\n${trajText}`;
    }
    parseSkills(response) {
        // Try direct JSON parse first
        try {
            const trimmed = response.trim();
            const jsonStr = trimmed.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
            const parsed = JSON.parse(jsonStr);
            if (Array.isArray(parsed)) {
                return parsed.filter((s) => s.name && s.steps && Array.isArray(s.steps));
            }
        }
        catch {
            // Fall through
        }
        // Try extracting JSON array from the response
        const arrayMatch = response.match(/\[[\s\S]*?\]/);
        if (arrayMatch) {
            try {
                const parsed = JSON.parse(arrayMatch[0]);
                if (Array.isArray(parsed)) {
                    return parsed.filter((s) => s.name && s.steps && Array.isArray(s.steps));
                }
            }
            catch {
                // Fall through
            }
        }
        return [];
    }
    finalizeSkill(raw, sourceTrajectories, existing) {
        const now = Date.now();
        const avgScore = sourceTrajectories.reduce((sum, t) => sum + t.score, 0) / sourceTrajectories.length;
        return {
            id: existing?.id || `skill-${raw.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${now.toString(36)}`,
            name: raw.name,
            description: raw.description,
            version: existing ? this.bumpVersion(existing.version) : raw.version || '1.0.0',
            goalPattern: raw.goalPattern,
            steps: raw.steps.map((s, i) => ({
                ...s,
                dependsOn: s.dependsOn || (i > 0 ? [`step-${i - 1}`] : []),
            })),
            parameters: raw.parameters || [],
            tags: raw.tags || [],
            sourceTrajectoryIds: sourceTrajectories.map((t) => t.id),
            qualityScore: avgScore,
            usageCount: existing?.usageCount || 0,
            createdAt: existing?.createdAt || now,
            lastUsedAt: existing?.lastUsedAt || now,
        };
    }
    bumpVersion(currentVersion) {
        const parts = currentVersion.split('.').map(Number);
        if (parts.length === 3 && !isNaN(parts[2])) {
            parts[2]++;
            return parts.join('.');
        }
        return '1.0.0';
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let compilerInstance = null;
export function getSkillCompiler() {
    if (!compilerInstance) {
        compilerInstance = new SkillCompiler();
    }
    return compilerInstance;
}
export function resetSkillCompiler() {
    compilerInstance = null;
}
//# sourceMappingURL=skill-compiler.js.map