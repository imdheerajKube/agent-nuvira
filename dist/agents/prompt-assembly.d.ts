/**
 * PromptAssembly — Hermes-style layered prompt construction.
 *
 * Adopts the proven pattern from Hermes Agent's prompt_builder.py:
 *   Layer 1: STABLE  — identity, tool guidance, skills
 *   Layer 2: CONTEXT — project context files, knowledge files, framework detection
 *   Layer 3: VOLATILE — task-specific instructions, timestamp, session info
 *
 * Reference: https://github.com/NousResearch/hermes-agent/blob/main/agent/prompt_builder.py
 *
 * Key design decisions (from Hermes AGENTS.md):
 * - Per-conversation prompt caching is sacred. The stable layer must be
 *   byte-stable across turns so the LLM provider can cache the prefix.
 * - Context files (knowledge.md, AGENTS.md, CLAUDE.md) provide persistent
 *   project-specific instructions that survive across sessions.
 * - The volatile layer is task-specific and changes per call.
 */
export interface PromptLayer {
    /** Stable layer: identity, tool guidance (byte-stable for caching). */
    stable: string;
    /** Context layer: project files, knowledge, framework detection. */
    context: string;
    /** Volatile layer: task-specific instructions, timestamp. */
    volatile: string;
}
export interface ProjectAssessment {
    /** Detected framework (react, vue, python, express, etc.) */
    framework?: string;
    /** Detected language (typescript, python, go, rust, etc.) */
    language?: string;
    /** Detected package manager (npm, yarn, pnpm, pip, cargo, etc.) */
    packageManager?: string;
    /** Whether this is a greenfield (from-scratch) project */
    isGreenfield: boolean;
    /** Whether the project has existing tests */
    hasTests: boolean;
    /** Key project files found */
    keyFiles: string[];
    /** Knowledge file content if found */
    knowledgeContent?: string;
    /** AGENTS.md content if found */
    agentsMdContent?: string;
}
/**
 * Assess the project before executing tasks.
 * Adopts Codebuff's pattern: detect framework, language, and project state
 * before generating prompts. This replaces the generic context-gatherer
 * with a fast, deterministic assessment.
 */
export declare function assessProject(workingDirectory: string): ProjectAssessment;
/**
 * Assemble a layered prompt following Hermes's pattern.
 *
 * @param stablePrompt - Identity and tool guidance (byte-stable for caching)
 * @param projectAssessment - Detected project context
 * @param taskDescription - The specific task to execute
 * @param agentType - The agent type (writer, planner, etc.)
 */
export declare function assemblePrompt(stablePrompt: string, projectAssessment: ProjectAssessment, taskDescription: string, agentType: string): string;
//# sourceMappingURL=prompt-assembly.d.ts.map