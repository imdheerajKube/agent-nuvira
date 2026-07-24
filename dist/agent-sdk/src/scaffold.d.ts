/**
 * @agent-nuvira/sdk/scaffold — Scaffolding command for creating custom agent projects.
 *
 * Generates a complete, ready-to-extend agent package with:
 * - TypeScript configuration
 * - A custom agent class extending {@link Agent}
 * - Unit tests using the {@link testing} utilities
 * - Package.json with build/test scripts
 *
 * @module @agent-nuvira/sdk/scaffold
 */
/** Template type to scaffold */
export type ScaffoldTemplate = 'basic-agent' | 'full-agent' | 'agent-pack';
/** Options for scaffolding */
export interface ScaffoldOptions {
    /** Output directory for the new agent project */
    outDir: string;
    /** Name of the agent class (PascalCase, e.g. "CodeFormatter") */
    agentName: string;
    /** Description of what the agent does */
    description: string;
    /** Template type (default: 'full-agent') */
    template?: ScaffoldTemplate;
    /** Agent type identifier for task plans (default: kebab-case of agentName) */
    agentType?: string;
}
/**
 * Scaffold a new custom agent project.
 *
 * @returns An array of file paths that were created.
 *
 * @example
 * ```ts
 * const files = scaffold({
 *   outDir: './my-custom-agent',
 *   agentName: 'CodeFormatter',
 *   description: 'Formats source code according to project conventions',
 * });
 * console.log(\`Created \${files.length} files\`);
 * ```
 */
export declare function scaffold(options: ScaffoldOptions): string[];
/**
 * List available scaffold templates with descriptions.
 */
export declare function listTemplates(): Array<{
    name: string;
    description: string;
}>;
//# sourceMappingURL=scaffold.d.ts.map