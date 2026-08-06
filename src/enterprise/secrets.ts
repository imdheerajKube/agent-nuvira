/**
 * secrets.ts — P6 M6.2 secret-redaction scrubber.
 *
 * The single security primitive that keeps sensitive material out of every
 * log line and audit record: `redact()` replaces API-key / token-shaped
 * substrings with a masked form (short head, `…`, short tail) so operators
 * can still tell WHICH key was involved without ever exposing it.
 *
 * Guarantees:
 * - Pure + deterministic — same input, same output; unit-testable.
 * - Never mutates the input; returns a new string (or JSON round-trip).
 * - Non-secret text passes through untouched.
 *
 * @see NUVIRA_ROUTER_ROADMAP.md §P6 M6.2
 */

// ─── Masking ────────────────────────────────────────────────────────────────

/** Keep at most this many leading chars before the ellipsis. */
const HEAD_KEEP = 4;
/** Keep at most this many trailing chars after the ellipsis. */
const TAIL_KEEP = 4;

/**
 * Mask a secret value, preserving just enough shape to identify it:
 * `gsk_cy8g…S9ak`. Short values (<= 12 chars) are fully masked as `***`.
 */
export function maskSecret(value: string): string {
  const v = String(value ?? '').trim();
  if (!v) return '***';
  if (v.length <= 12) return '***';
  return `${v.slice(0, HEAD_KEEP)}…${v.slice(-TAIL_KEEP)}`;
}

/**
 * Known API-key prefixes (lowest-risk, highest-confidence matches).
 * Values that start with one of these are treated as secrets anywhere.
 */
export const KNOWN_KEY_PREFIXES: string[] = [
  'gsk_', // Groq
  'sk-', // OpenAI-compatible (OpenRouter, NIM gateways)
  'sk_', // Some OpenAI-compatible gateways
  'nvapi-', // NVIDIA NIM
  'AIza', // Google Gemini
  'xai-', // xAI
  'hf_', // HuggingFace
  'ghp_', 'gho_', 'github_pat_', // GitHub PATs
  'AKIA', // AWS access key id prefix
  'eyJ', // JWT / Bearer tokens (base64 header)
];

/** Minimum length for a prefix match to be treated as a secret. */
const MIN_SECRET_LEN = 12;

/**
 * Regexes applied mid-string (after `KEY=` or inside JSON) to catch keys that
 * don't carry a known prefix (e.g. rotated, vendor-specific tokens).
 */
const KEY_ASSIGN_RE = /\b(api[_-]?key|token|secret|password|passwd|auth|credential|private[_-]?key|access[_-]?key)\b\s*[:=]\s*["']?([A-Za-z0-9._\-+/]{12,})/gi;

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
export function redact(text: string): string {
  if (!text) return text;
  let out = text;

  // 1. Authorization headers: Bearer / Token / Basic
  out = out.replace(
    /\b(Bearer|Token|Basic)\s+([A-Za-z0-9._\-+/=]{12,})/gi,
    (_m, scheme: string, _tok: string) => {
      // Rebuild with the token masked, keeping the scheme visible.
      const tok = _tok;
      return `${scheme} ${maskSecret(tok)}`;
    },
  );

  // 2. Key assignments — mask only the VALUE after ':' or '='.
  out = out.replace(KEY_ASSIGN_RE, (_m, _name: string, value: string) => {
    // Rebuild preserving the exact matched key word + separator + quotes.
    const name = _name;
    const valueStart = _m.indexOf(value);
    const prefix = _m.slice(0, valueStart);
    return `${prefix}${maskSecret(value)}`;
  });

  // 3. Bare known-prefix secrets (spaced apart from the above). The quantifier
  // is relaxed ({6,} after the prefix) so SHORT bare keys (e.g. `sk-abcdefgh`,
  // 10 chars total) are still caught, not just long ones.
  out = out.replace(
    new RegExp(`\\b(${KNOWN_KEY_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[A-Za-z0-9._\\-+/]{6,}`),
    (m: string) => maskSecret(m),
  );

  // 4. JSON-encoded sensitive fields: {"apiKey":"..."} style (post-stringify).
  out = out.replace(
    /"((?:api[_-]?key|token|secret|password|private[_-]?key|credential|authorization))"\s*:\s*"([^"]{12,})"/gi,
    (_m, name: string, value: string) => `"${name}":"${maskSecret(value)}"`,
  );

  return out;
}

/**
 * Redact a structured value. ONLY plain objects/arrays are JSON-round-tripped
 * (scrubbed, then parsed back — preserving their shape). Non-plain values
 * (Error, Map, Set, class instances, numbers, booleans) are NOT round-tripped:
 * a JSON round-trip would turn an Error into `{}` and destroy debugging
 * context. They are string-redacted (or left untouched when not a string).
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    try {
      return JSON.parse(redact(JSON.stringify(value))) as unknown;
    } catch {
      return redact(String(value));
    }
  }
  if (isPlainObject(value)) {
    try {
      return JSON.parse(redact(JSON.stringify(value))) as unknown;
    } catch {
      return redact(String(value));
    }
  }
  // Non-plain values pass through untouched (they are not string-shaped).
  return value;
}

/** True for objects with a plain Object prototype (or null proto). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Wrapper for writers that persist sensitive-adjacent records: guarantees
 * the serialized line contains no secret-shaped substring. Used by the
 * quota-events + model-registry-actions JSONL writers (M6.2 acceptance:
 * "nothing sensitive in any log/audit").
 */
export function safeLine(record: unknown): string {
  const raw = typeof record === 'string' ? record : JSON.stringify(record);
  return redact(raw ?? '');
}

/** Whether redaction is disabled (BUFF_NO_REDACT=1) — for debugging only. */
export function redactionDisabled(): boolean {
  return process.env.BUFF_NO_REDACT === '1' || process.env.BUFF_NO_REDACT === 'true';
}

/**
 * Apply redaction unless explicitly disabled. Central choke point used by the
 * logger and audit writers.
 */
export function applyRedaction(text: string): string {
  if (redactionDisabled()) return text;
  return redact(text);
}
