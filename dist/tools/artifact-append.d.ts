/**
 * I3 — Tool-to-artifact auto-append (`src/tools/artifact-append.ts`).
 *
 * A tool may return its deliverable as a JSON
 * payload and let the runtime do the bookkeeping —
 *
 *   {"artifact": {"kind": "file", "title": "deploy report", "path": "..."},
 *    "result": "text fed back to the model"}
 *
 * `appendToolArtifact` (called by the tool loop after every tool execution):
 * 1. parses the payload (prose before/after tolerated),
 * 2. pushes the artifact to the ToolContext sink (which persists it to the
 *    per-session ArtifactStore), and
 * 3. returns ONLY `result` — the JSON payload is for the runtime, never the
 *    model's context (the "return their deliverable artifact as a JSON
 *    payload" contract).
 *
 * A non-payload tool result passes through untouched, so existing tools are
 * unaffected — the convention is opt-in.
 */
import { type ArtifactSink, type ToolArtifact } from './artifact-types.js';
/**
 * Parse a tool result for the `{artifact, result}` payload. Returns null when
 * the result is not an artifact payload (normal tool output). The artifact is
 * normalized (id + createdAt filled) and shape-validated; an invalid payload
 * degrades to null so the raw text still reaches the model.
 *
 * SCANS FORWARD: prose before the payload may itself contain braces ("Use
 * {foo} syntax…"), so the first brace-delimited object is only a candidate —
 * each parseable object is tried until one validates as a payload.
 */
export declare function extractToolArtifact(text: string): {
    artifact: ToolArtifact;
    result: string;
} | null;
/**
 * Append an extracted artifact to the sink and return the CLEAN result text.
 * A non-payload result is returned unchanged. This is the tool-loop hook.
 */
export declare function appendToolArtifact(text: string, sink?: ArtifactSink): string;
/** Max chars for the auto-preview of a file/dir artifact. */
export declare const ARTIFACT_PREVIEW_MAX_CHARS = 500;
/**
 * Read the first `maxChars` of a file as a preview (
 * `read_preview_tool.py` parity). Reads ONLY the first N bytes via a bounded
 * read — never the whole file, so a multi-GB log previews in µs. Best-effort:
 * any read failure returns undefined (the artifact stays valid without one).
 */
export declare function readArtifactPreview(filePath: string, maxChars?: number): string | undefined;
//# sourceMappingURL=artifact-append.d.ts.map