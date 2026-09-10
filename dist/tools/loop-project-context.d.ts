/**
 * Loop project context (`src/tools/loop-project-context.ts`) — AGENTIC_CAPABILITY_ASSESSMENT
 * Addendum v4 Phase 1.4: Freebuff-pattern AMBIENT CONTEXT for the tool loop.
 *
 * The assessment's core finding: a single-loop agent needs the project shape
 * in its context FROM TURN ZERO — a token-budgeted file tree, a git-state
 * digest, and a deterministic project assessment — instead of spending an
 * entire ReasonerAgent + ContextGathererAgent call to re-discover it.
 *
 * The dashboard already builds a snapshot (its project-context module) and
 * injects it via `ctxOverrides.projectContext`; the CLI never sent one. This
 * module is the CLI twin: bounded (~2K tokens), best-effort — a failure
 * yields an EMPTY string, never a broken turn.
 *
 * Consumers: chat.ts `runChatAnswer` — when no explicit projectContext was
 * provided and the cwd looks like a project, inject this as the
 * `[Project context]` message. The dashboard path is unchanged.
 *
 * Design notes:
 * - The tree walk is a bounded BFS (readdirSync, depth-capped, ignore-dir
 *   filtered) rather than the orchestrator's full recursive builder — the
 *   loop needs SHAPE, not a complete index, and must never take >50ms on a
 *   huge repo. Entries past the line budget are truncated with an explicit
 *   note (honest truncation, like Freebuff's `truncate-file-tree`).
 * - Git digests run read-only commands with a 3s cap each and are omitted
 *   entirely outside a git repo.
 */
/** True when the directory plausibly contains a project worth describing. */
export declare function looksLikeProject(dir: string): boolean;
/**
 * Bounded BFS tree walk. Returns lines like `├── src/` with directories
 * suffixed `/`, sorted dirs-first then files (deterministic ordering — the
 * model sees a stable tree across turns, which keeps the prompt cache warm).
 * Appends an ellipsis note when entries/depth were capped.
 */
export declare function walkBoundedTree(dir: string): string[];
/**
 * Build the bounded `[Project context]` block for the loop system context.
 * Returns '' when the directory is not a project (caller injects nothing).
 *
 * Layout (Freebuff system-prompt parity):
 *   ## Project   — cwd + deterministic assessment (language/framework/tests)
 *   ## File tree — bounded BFS walk, honestly truncated
 *   ## Git state — branch, dirty files, recent commits
 */
export declare function buildLoopProjectContext(dir: string): Promise<string>;
//# sourceMappingURL=loop-project-context.d.ts.map