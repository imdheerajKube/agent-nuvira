/**
 * I3 — Tool-to-artifact auto-append (`src/tools/artifact-append.ts`).
 *
 * Hermes `gateway/run.py` parity: a tool may return its deliverable as a JSON
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
 *    model's context (Hermes' "return their deliverable artifact as a JSON
 *    payload" contract).
 *
 * A non-payload tool result passes through untouched, so existing tools are
 * unaffected — the convention is opt-in.
 */

import { randomUUID } from 'node:crypto';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { isArtifactKind, type ArtifactKind, type ArtifactSink, type ToolArtifact } from './artifact-types.js';

// ─── Payload parsing ────────────────────────────────────────────────────────

/** Find the index of the brace matching the one at `start` (string-aware). */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

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
export function extractToolArtifact(text: string): { artifact: ToolArtifact; result: string } | null {
  if (!text) return null;
  let searchFrom = 0;
  for (;;) {
    const start = text.indexOf('{', searchFrom);
    if (start === -1) return null;
    const end = matchingBrace(text, start);
    if (end === -1) return null;
    searchFrom = start + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue; // not this object — scan for the next one
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (!obj.artifact || typeof obj.artifact !== 'object') continue;
    if (obj.result === undefined) continue;

    const a = obj.artifact as Record<string, unknown>;
    const kind = a.kind;
    const title = a.title;
    const path = a.path;
    if (!isArtifactKind(kind) || typeof title !== 'string' || typeof path !== 'string') {
      continue;
    }

    const artifact: ToolArtifact = {
      id: typeof a.id === 'string' ? a.id : randomUUID(),
      kind,
      title,
      path,
      mime: typeof a.mime === 'string' ? a.mime : undefined,
      sizeBytes: typeof a.sizeBytes === 'number' ? a.sizeBytes : undefined,
      preview: typeof a.preview === 'string' ? a.preview : undefined,
      source: a.source === 'agent' || a.source === 'manual' ? a.source : 'tool',
      createdAt: typeof a.createdAt === 'number' ? a.createdAt : Date.now(),
    };
    const result = obj.result;
    const resultText =
      typeof result === 'string'
        ? result
        : typeof result === 'object'
          ? JSON.stringify(result)
          : String(result);
    return { artifact, result: resultText };
  }
}

/**
 * Append an extracted artifact to the sink and return the CLEAN result text.
 * A non-payload result is returned unchanged. This is the tool-loop hook.
 */
export function appendToolArtifact(text: string, sink?: ArtifactSink): string {
  const parsed = extractToolArtifact(text);
  if (!parsed) return text;
  sink?.push(parsed.artifact);
  return parsed.result;
}

// ─── Preview helper ─────────────────────────────────────────────────────────

/** Max chars for the auto-preview of a file/dir artifact. */
export const ARTIFACT_PREVIEW_MAX_CHARS = 500;

/**
 * Read the first `maxChars` of a file as a preview (Hermes
 * `read_preview_tool.py` parity). Reads ONLY the first N bytes via a bounded
 * read — never the whole file, so a multi-GB log previews in µs. Best-effort:
 * any read failure returns undefined (the artifact stays valid without one).
 */
export function readArtifactPreview(filePath: string, maxChars = ARTIFACT_PREVIEW_MAX_CHARS): string | undefined {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return undefined;
    // maxChars * 4 + slack covers multi-byte UTF-8 at the boundary.
    const wanted = Math.min(st.size, (maxChars + 1) * 4 + 32);
    const buf = Buffer.allocUnsafe(wanted);
    const fd = openSync(filePath, 'r');
    try {
      const bytes = readSync(fd, buf, 0, wanted, 0);
      const text = buf.subarray(0, bytes).toString('utf-8');
      const preview = text.slice(0, maxChars);
      const truncated = bytes < st.size || text.length > maxChars;
      return truncated ? `${preview}…` : preview;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
