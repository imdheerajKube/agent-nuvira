/**
 * @agent-nuvira/sdk/register — Register a custom agent with the orchestrator.
 *
 * Modifies `src/agents/orchestrator.ts` to:
 * 1. Add an import statement for the custom agent class
 * 2. Add a `case` to the `createAgent()` switch statement
 * 3. Add an icon to the `AGENT_ICONS` map
 *
 * ## Usage
 *
 * ```ts
 * import { registerAgent } from '@agent-nuvira/sdk/register';
 *
 * const changes = registerAgent({
 *   sourceModule: './agents/my-agent.js',
 *   className: 'MyAgent',
 *   agentType: 'my-agent',
 * });
 * ```
 *
 * @module @agent-nuvira/sdk/register
 */
/** Options for registering a custom agent */
export interface RegisterOptions {
    /** Absolute or relative path to the orchestrator source file (default: auto-detected) */
    orchestratorPath?: string;
    /** The import module path for the agent class, relative to orchestrator.ts dir. Example: './agents/my-agent.js' */
    sourceModule: string;
    /** The exported class name to import. Example: 'MyAgent' */
    className: string;
    /** The agent type string used in task plans and the switch case. Example: 'my-agent' */
    agentType: string;
    /** Optional emoji icon for the AGENT_ICONS map (default: 🧩) */
    icon?: string;
    /** Optional human-readable name (defaults to className) */
    name?: string;
}
/** Result of a register/unregister operation */
export interface RegisterResult {
    /** Whether the operation succeeded */
    success: boolean;
    /** Human-readable message describing what happened */
    message: string;
    /** Files that were modified */
    modifiedFiles: string[];
    /** The agent type that was operated on */
    agentType: string;
}
/**
 * Register a custom agent with the orchestrator.
 *
 * Reads the orchestrator source file, adds the import and switch case,
 * and writes the file back.
 */
export declare function registerAgent(options: RegisterOptions): RegisterResult;
/**
 * Unregister a custom agent from the orchestrator.
 *
 * Removes the switch case and icon entry. If `className` is provided,
 * also removes the matching import statement using an exact pattern
 * (`import { className } from '...';`) to avoid accidentally removing
 * built-in imports.
 */
export declare function unregisterAgent(options: {
    orchestratorPath?: string;
    agentType: string;
    /** The exact exported class name. When provided, enables safe import removal. */
    className?: string;
}): RegisterResult;
//# sourceMappingURL=register.d.ts.map