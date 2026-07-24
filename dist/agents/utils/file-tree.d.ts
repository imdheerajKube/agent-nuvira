/**
 * File Tree Utility — Builds a text representation of a project directory tree.
 *
 * Extracted from ContextGathererAgent so both the Planner and Gatherer
 * can share the same file-tree logic.
 *
 * Usage:
 *   const tree = await buildProjectFileTree(process.cwd());
 *   // Returns something like:
 *   // 📂 src/
 *   //   📂 agents/
 *   //     📄 agent.ts
 *   //     📄 orchestrator.ts
 *   // 📄 package.json
 */
/**
 * Recursively build a text representation of the project file tree.
 *
 * @param dir   Absolute path to the directory to scan
 * @param prefix  Indentation prefix (used internally for recursion)
 * @returns       A formatted string showing the directory structure
 */
export declare function buildProjectFileTree(dir: string, prefix?: string): Promise<string>;
/**
 * Truncate a file tree to a maximum number of lines to keep prompts manageable.
 */
export declare function truncateTree(tree: string, maxLines: number): string;
//# sourceMappingURL=file-tree.d.ts.map