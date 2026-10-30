/**
 * WIRE SANITISER — make every outbound request JSON-safe, and repair a thread
 * the provider has already rejected.
 *
 * WHY THIS EXISTS (measured, 2026-10-25, audit head-to-head).
 *
 * The first run of the audit spent 49 tool calls and then died on:
 *
 *     Tool-calling API error (400): Failed to parse the request body as JSON:
 *     messages[36].content: unexpected end of hex escape at line 1 column 62914
 *
 * The provider could not parse the REQUEST BODY. The cause is a string that is
 * not representable in JSON: an unpaired UTF-16 surrogate — half of an emoji or
 * of an astral character that a tool result carried (a terminal that emitted a
 * partial sequence, a truncated file slice, a surrogate pair split by a byte or
 * code-unit cut). `JSON.stringify` happily emits `\ud83d` alone, providers
 * reject it, and because the poisoned message STAYS in the thread, every retry
 * sends the same bytes: the turn is unrecoverable, ends with no deliverable, and
 * exits 0.
 *
 * Two defences, both cheap:
 *
 * 1. `sanitizeForWire` is applied to every string on the way out, so a lone
 *    surrogate can never be serialised in the first place.
 * 2. `repairPoisonedMessage` handles the case where a provider still refuses a
 *    specific message: the loop replaces THAT message's content with a sanitised
 *    / stubbed version and retries once. A wrong byte costs one message, not the
 *    turn.
 */

/** The replacement character a lone surrogate becomes (U+FFFD). */
const REPLACEMENT = '\uFFFD';

/**
 * Make `text` JSON-safe for a provider request.
 *
 * - an unpaired high or low surrogate becomes U+FFFD (the pair is preserved);
 * - NUL and the C0 control characters that are not whitespace are dropped
 *   (they survive `JSON.stringify` as `\u0000` and some gateways reject them);
 * - everything else is returned unchanged, so a clean string is byte-identical
 *   (important: the prompt prefix is cached by the provider, and an unnecessary
 *   rewrite would invalidate it).
 */
export function sanitizeForWire(text: string): string {
  if (!text) return text;
  let out = text;
  // Fast path — the common case: no surrogates and no C0 controls beyond \t\n\r.
  // eslint-disable-next-line no-control-regex
  if (!/[\uD800-\uDFFF\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(out)) return out;

  if (/[\uD800-\uDFFF]/.test(out)) {
    let built = '';
    for (let i = 0; i < out.length; i += 1) {
      const code = out.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = out.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          built += out[i] + out[i + 1];
          i += 1;
        } else {
          built += REPLACEMENT; // unpaired HIGH surrogate
        }
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        built += REPLACEMENT; // unpaired LOW surrogate
        continue;
      }
      built += out[i];
    }
    out = built;
  }
  // Drop the remaining C0 controls except tab / newline / carriage return.
  // eslint-disable-next-line no-control-regex
  return out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/**
 * Deep-sanitise every string inside a request payload (messages, tool calls,
 * arguments). Returns a NEW value; the input is not mutated, so a caller can
 * keep the original for a diff or a replay.
 *
 * Generic on purpose: the wire shapes differ per provider (OpenAI-compatible,
 * Anthropic, Gemini), and a per-shape sanitiser is a place to forget the next
 * field. Non-string primitives pass through untouched.
 */
export function sanitizeWireValue<T>(value: T): T {
  if (typeof value === 'string') return sanitizeForWire(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeWireValue(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeWireValue(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * The message index a provider named when it refused a request, or `null`.
 *
 * Recognises the shapes providers actually emit (`messages[36].content`,
 * `messages.36.content`, `message 36`) and nothing else — a 400 that does not
 * name a message is not repairable this way, so it must not be guessed at.
 */
export function poisonedMessageIndex(errorText: string): number | null {
  if (!errorText) return null;
  const patterns = [
    /messages?\[(\d+)\]/i,
    /messages?\.(\d+)/i,
    /messages?\s+(\d+)\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(errorText);
    if (m) {
      const index = Number(m[1]);
      if (Number.isInteger(index) && index >= 0) return index;
    }
  }
  return null;
}

/** A message the loop can hand to a provider in place of an unparsable one. */
export const POISONED_MESSAGE_STUB =
  '[this message was removed — the provider rejected it as unparsable (an invalid character sequence). ' +
  'Re-read the file or re-run the command if its content is needed.]';

export interface WireRepairResult {
  /** True when the thread was changed and a retry can be attempted. */
  repaired: boolean;
  /** True when the content changed by sanitising (not by stubbing). */
  sanitised: boolean;
}

/**
 * Repair the message at `index` so the same request can be retried.
 *
 * Sanitising first (the common case: one bad code unit in an otherwise valuable
 * tool result), then stubbing (the content is unrecoverable). Only `content` is
 * touched — the message keeps its role and tool-call pairing, so the repaired
 * thread is still wire-valid.
 */
export function repairPoisonedMessage(
  thread: ReadonlyArray<{ role?: string; content?: unknown }>,
  index: number,
): WireRepairResult {
  const message = thread[index];
  if (!message || typeof message.content !== 'string') return { repaired: false, sanitised: false };
  const sanitised = sanitizeForWire(message.content);
  if (sanitised !== message.content) {
    (message as { content: string }).content = sanitised;
    return { repaired: true, sanitised: true };
  }
  // Nothing to sanitise — the provider's objection is something else in the
  // payload. Drop the content but keep the message (and its pairing) in place.
  (message as { content: string }).content = POISONED_MESSAGE_STUB;
  return { repaired: true, sanitised: false };
}
