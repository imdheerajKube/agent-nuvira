/**
 * I3 — Artifact types (`src/tools/artifact-types.ts`).
 *
 * Artifact contract ("tools return their deliverable
 * artifact as a JSON payload"): a tool that produces a deliverable (a file, a
 * doc, a log, media, structured data, or a link) returns it as a typed
 * artifact, and the runtime records it on the session automatically.
 *
 * These types are the tool-facing contract. They deliberately sit NEXT TO the
 * agent's internal `Artifact` (src/agents/agent.ts) rather than replacing it:
 * - `Artifact` (agents) = a file discovered/produced during a pipeline run,
 *   carried inside ContextVault for agent-to-agent handoff.
 * - `ToolArtifact` (tools) = a deliverable a tool reports to the runtime,
 *   auto-appended via the `ArtifactSink` on ToolContext and persisted to the
 *   per-session ArtifactStore for the dashboard.
 */
/** The artifact kinds a tool result payload may declare (validation set). */
export const ARTIFACT_KINDS = [
    'file',
    'doc',
    'log',
    'media',
    'data',
    'link',
];
/** True when a value is a valid ArtifactKind. */
export function isArtifactKind(kind) {
    return typeof kind === 'string' && ARTIFACT_KINDS.includes(kind);
}
//# sourceMappingURL=artifact-types.js.map