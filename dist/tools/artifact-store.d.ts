/**
 * I3 — Artifact store (`src/tools/artifact-store.ts`).
 *
 * Persists tool artifacts per session under the memory dir so the dashboard
 * (I4) can browse them:
 *
 *   ~/.nuvira/memory/artifacts/<sessionId>/artifacts.json   — the session index
 *
 * Honors NUVIRA_MEMORY_DIR (same as the ledger/quota/bandit reads). Writes are
 * best-effort — a failed artifact write must never break the tool loop that
 * produced it. Session ids are sanitized (no path traversal); a sanitized id
 * collision is accepted (worst case: two sessions share a folder).
 */
import type { ToolArtifact } from './artifact-types.js';
/** The default artifacts root — `<memory>/artifacts`. */
export declare function defaultArtifactsRoot(): string;
/** Sanitize a session id for use as a directory name. */
export declare function sanitizeSessionId(sessionId: string): string;
export declare class ArtifactStore {
    private root;
    /** @param rootDir Override the artifacts root (tests pass a temp dir). */
    constructor(rootDir?: string);
    /** Absolute path of the artifacts root (tests assert the layout). */
    get rootPath(): string;
    private indexPath;
    /**
     * Append an artifact to a session (read-merge-write, newest first).
     * Auto-fills a missing preview for file artifacts. Best-effort, never throws.
     */
    append(sessionId: string, artifact: ToolArtifact): void;
    /** All artifacts for a session, newest first. Never throws. */
    read(sessionId: string): ToolArtifact[];
    /** Session summaries (id, artifact count, most recent) for the dashboard. */
    listSessions(): Array<{
        sessionId: string;
        count: number;
        latestAt: number;
    }>;
}
//# sourceMappingURL=artifact-store.d.ts.map