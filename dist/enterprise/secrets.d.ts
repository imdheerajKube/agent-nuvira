/**
 * Mask a secret value, preserving just enough shape to identify it:
 * `gsk_cy8g…S9ak`. Short values (<= 12 chars) are fully masked as `***`.
 */
export declare function maskSecret(value: string): string;
/**
 * Known API-key prefixes (lowest-risk, highest-confidence matches).
 * Values that start with one of these are treated as secrets anywhere.
 */
export declare const KNOWN_KEY_PREFIXES: string[];
/**
 * Redact every secret-shaped substring in a string.
 *
 * Strategy (ordered, first wins):
 * 1. `Bearer <token>` / `Token <token>` / `Basic <b64>` auth headers
 * 2. Key assignments (`apiKey=...`, `"apiKey": "..."`, `token=...`)
 * 3. Bare secrets starting with a KNOWN_KEY_PREFIX
 * 4. JSON-string-encoded values under sensitive key names
 *
 * @returns The input with all secret-shaped substrings masked. The input is
 *          never mutated.
 */
export declare function redact(text: string): string;
/**
 * Redact a structured value. ONLY plain objects/arrays are JSON-round-tripped
 * (scrubbed, then parsed back — preserving their shape). Non-plain values
 * (Error, Map, Set, class instances, numbers, booleans) are NOT round-tripped:
 * a JSON round-trip would turn an Error into `{}` and destroy debugging
 * context. They are string-redacted (or left untouched when not a string).
 */
export declare function redactValue(value: unknown): unknown;
/**
 * Wrapper for writers that persist sensitive-adjacent records: guarantees
 * the serialized line contains no secret-shaped substring. Used by the
 * quota-events + model-registry-actions JSONL writers (M6.2 acceptance:
 * "nothing sensitive in any log/audit").
 */
export declare function safeLine(record: unknown): string;
/** Whether redaction is disabled (BUFF_NO_REDACT=1) — for debugging only. */
export declare function redactionDisabled(): boolean;
/**
 * Apply redaction unless explicitly disabled. Central choke point used by the
 * logger and audit writers.
 */
export declare function applyRedaction(text: string): string;
//# sourceMappingURL=secrets.d.ts.map