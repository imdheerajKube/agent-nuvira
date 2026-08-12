/**
 * I3 — Artifact types (`src/tools/artifact-types.ts`).
 *
 * Hermes artifact parity (`gateway/run.py` — "tools return their deliverable
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

// ─── Types ──────────────────────────────────────────────────────────────────

/** What kind of deliverable an artifact is (drives UI badges + previews). */
export type ArtifactKind = 'file' | 'doc' | 'log' | 'media' | 'data' | 'link';

/** A typed deliverable produced by a tool (or recorded manually). */
export interface ToolArtifact {
  /** Unique id (auto-assigned when the tool omits it). */
  id: string;
  kind: ArtifactKind;
  /** Human title (e.g. "deploy report", "schema dump"). */
  title: string;
  /** File path or URL (for kind 'link'). */
  path: string;
  /** MIME type when known. */
  mime?: string;
  /** File size in bytes when known. */
  sizeBytes?: number;
  /** Truncated text preview (computed by the store when absent). */
  preview?: string;
  /** Who produced it. */
  source: 'tool' | 'agent' | 'manual';
  /** Epoch ms. */
  createdAt: number;
}

/** How tools hand artifacts to the runtime (ToolContext.artifacts). */
export interface ArtifactSink {
  push(artifact: ToolArtifact): void;
}

/** The artifact kinds a tool result payload may declare (validation set). */
export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'file',
  'doc',
  'log',
  'media',
  'data',
  'link',
];

/** True when a value is a valid ArtifactKind. */
export function isArtifactKind(kind: unknown): kind is ArtifactKind {
  return typeof kind === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(kind);
}
