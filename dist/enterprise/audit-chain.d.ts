/**
 * audit-chain.ts — P6 M6.3 tamper-evident, hash-chained audit records.
 *
 * Extends the existing append-only JSONL audit stores (quota-events.jsonl,
 * model-registry-actions.jsonl) with a SHA-256 hash chain so any tampering —
 * even a single flipped byte — is detectable on verification.
 *
 * Design:
 * - Each record is serialized to a canonical JSON line, then wrapped:
 *   `{ ..., "chain": { "prevHash": "<sha256>", "hash": "<sha256>" } }`
 *   where `hash = sha256(prevHash ‖ canon)` and `canon` is the record's
 *   canonical JSON (stable key order) WITHOUT the chain wrapper.
 * - The chain head (the last hash) is persisted in a sidecar `.chain.json`
 *   file, so a tamperer who rewrites a line must also know the true head to
 *   hide the break (append-only external-of-record state).
 * - Verification walks the file lines, recomputes the chain, and reports:
 *   the tamper line index (first mismatch), the number of legacy un-chained
 *   lines (pre-M6.3 files remain readable), and whether the stored head
 *   matches the recomputed head.
 *
 * Purity: all functions are pure over (content, sidecar state) — no global
 * state, no filesystem access inside the core logic. Callers own I/O.
 *
 * @see NUVIRA_ROUTER_ROADMAP.md §P6 M6.3
 */
/** Chain metadata persisted per audit store. */
export interface ChainHeadState {
    /** Namespaced chain id (e.g. 'quota-events' | 'model-registry-actions'). */
    chainId: string;
    /** The hash of the LAST chained record written (or null before any). */
    head: string | null;
    /** Record count at the time the head was persisted. */
    records: number;
    /** Schema version for forward compatibility. */
    version: 1;
}
/** Result of verifying one audit file's chain. */
export interface ChainVerifyResult {
    chainId: string;
    /** Total non-empty lines in the file. */
    totalLines: number;
    /** Lines that are legacy (pre-chain) — valid JSON but no chain wrapper. */
    legacyLines: number;
    /** Lines that are corrupt (not valid JSON at all). */
    corruptLines: number;
    /** Index (1-based) of the first line where the chain breaks; 0 = intact. */
    tamperLine: number;
    /** Recomputed head hash for the whole file. */
    recomputedHead: string | null;
    /** Head hash from the sidecar state (null if no sidecar / legacy-only). */
    storedHead: string | null;
    /** Whether the recomputed head matches the stored head. */
    headMatches: boolean;
    /** Human-readable verdict. */
    verdict: 'ok' | 'tampered' | 'legacy' | 'corrupt';
}
/** One hash-chained record (the on-disk line shape). */
export interface ChainedRecord {
    [key: string]: unknown;
    chain?: {
        prevHash: string;
        hash: string;
    };
}
/**
 * Canonical JSON: stable key order (sorted), no whitespace. Ensures the same
 * record always hashes identically regardless of object key insertion order.
 */
export declare function canonicalJson(value: unknown): string;
/** sha256 hex digest of a string. */
export declare function sha256(input: string): string;
/**
 * Compute the chain wrapper for the NEXT record given the previous head.
 * `record` must be the record WITHOUT any chain wrapper (it will be stripped
 * defensively if present).
 */
export declare function nextChain(prevHead: string | null, record: unknown): {
    prevHash: string;
    hash: string;
};
/** Serialize a record + chain wrapper to the on-disk line. */
export declare function chainLine(prevHead: string | null, record: unknown): string;
/** Remove an existing `chain` field from a record (deep-copy safe). */
export declare function stripChain(record: unknown): unknown;
/**
 * Parse the raw file lines and recompute the chain.
 *
 * @param lines Non-empty file lines (each a JSON string).
 * @param chainId Namespace for the verify result.
 * @param storedHead Optional head from the sidecar state (null = none).
 * @returns A ChainVerifyResult with the first tamper line (1-based) or 0.
 */
export declare function verifyChain(lines: string[], chainId: string, storedHead?: string | null): ChainVerifyResult;
/**
 * The current head (last hash) of an already-serialized chain of lines.
 * Uses `verifyChain` internally so the returned head is LINKAGE-checked
 * (a tampered-but-internally-consistent line cannot poison the next append).
 */
export declare function headOfLines(lines: string[]): string | null;
/** Serialize head state for the sidecar file. */
export declare function serializeHeadState(state: ChainHeadState): string;
/** Parse sidecar head state (lenient: malformed → null head). */
export declare function parseHeadState(json: string): ChainHeadState | null;
/**
 * SIEM-friendly flat export: one key=value "CEF-like" line per record.
 * Key values are CEF-escaped (`|`, `\`, `=` in values are escaped); the chain
 * hash is included so SIEMs can correlate back to the tamper-evident store.
 */
export declare function exportCefLines(lines: string[]): string[];
/** CEF-escape a value: backslashes, pipes, and equals are backslash-escaped. */
export declare function cefEscape(value: string): string;
/**
 * Append ONE hash-chained, scrubbed record to a JSONL audit store.
 *
 * - Reads the existing lines, derives the previous chain head (legacy lines
 *   are preserved as-is), appends `chainLine(prevHead, record)`.
 * - Optionally caps the file at `maxLines` (newest kept — rotation keeps the
 *   chain INTACT because the trimmed slice is re-chained below).
 * - Persists the sidecar head state (`<path>.chain.json`) so verification has
 *   an append-only external-of-record reference.
 * - Best-effort + safeLine-scrubbed (P6 M6.2): never throws.
 *
 * @returns the appended line, or null on failure.
 */
/**
 * FAST append for hot paths (model-registry action telemetry): reads only the
 * sidecar head state + appends with `appendFileSync` — O(1) per record instead
 * of a full read-rewrite. Rotation is handled by the caller (the model-
 * registry already rotates at 2× the cap, and the trimmed slice is re-chained
 * there).
 */
export declare function appendChainedRecordFast(filePath: string, chainId: string, record: unknown): string | null;
export declare function appendChainedRecord(filePath: string, chainId: string, record: unknown, maxLines?: number): string | null;
/**
 * Strip the chain wrappers from parsed lines and rebuild a continuous chain
 * from `genesis`. Used after rotation so a trimmed slice never references a
 * trimmed-away record.
 */
export declare function rechainRecords(lines: string[]): string[];
/** Sidecar path for an audit file: `<file>.chain.json`. */
export declare function headStatePath(filePath: string): string;
/** Read + parse the sidecar head state (null when absent/malformed). */
export declare function readHeadState(filePath: string, chainId: string): ChainHeadState | null;
/** Persist the sidecar head state (best-effort). */
export declare function writeHeadState(filePath: string, chainId: string, head: string | null, records: number): void;
/**
 * Verify a JSONL audit store's chain: pure core over the file's lines plus
 * the sidecar head state.
 */
export declare function verifyAuditFile(filePath: string, chainId: string): ChainVerifyResult;
/** Convenience: default memory dir join (honors NUVIRA_MEMORY_DIR like the rest). */
export declare function auditFilePath(chainId: string): string;
//# sourceMappingURL=audit-chain.d.ts.map