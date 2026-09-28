/**
 * Structured gateway log (`src/gateway/gateway-log.ts`).
 *
 * The gateway had NO durable record of what it did: a send that failed printed
 * one `logger.warn` line to a terminal nobody was watching, so a message that
 * never arrived could not be diagnosed after the fact. Live incident
 * (2026-09-21): a WhatsApp send was answered "I have sent…", the recipient
 * received nothing, and there was no artifact to explain why — the delivery
 * ledger is pruned, and the console output was gone.
 *
 * This is a deliberately small, append-only JSONL log for the events that
 * matter when delivery goes wrong:
 *
 *   {"at":"2026-09-21T05:09:42.366Z","level":"warn","event":"send.failed",
 *    "platform":"whatsapp","channelId":"+918800663237","target":"whatsapp:+918800663237",
 *    "reason":"918800663237@s.whatsapp.net is not a WhatsApp account — the message was NOT sent.",
 *    "textChars":1660,"textPreview":"…"}
 *
 * Design rules (same as every other persisted store here):
 * - Best-effort — a log write must NEVER break a send or a conversation.
 * - Bounded — one rotation generation (`logs.1.jsonl`), so the directory cannot
 *   grow without limit.
 * - Local only, `NUVIRA_CONFIG_DIR` aware (hermetic tests), sibling of
 *   `aliases.json` / `inbox.json` / `delivery.json`.
 * - Never logs secrets: message BODIES are truncated to a short preview (the
 *   delivery ledger already stores the full text), and any value that looks
 *   like a credential is replaced before the record is written.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBuffConfigDir } from '../config/paths.js';

/** Log levels, ordered by severity. */
export type GatewayLogLevel = 'info' | 'warn' | 'error';

/**
 * The event names the gateway records. A closed union keeps the log queryable
 * (and greppable) instead of a free-for-all of ad-hoc strings.
 */
export type GatewayLogEvent =
  | 'send.ok'
  | 'send.failed'
  | 'delivery.enqueued'
  | 'delivery.dispatched'
  | 'inbound.refused'
  | 'inbound.failed'
  // An inbound message that was ANSWERED — recorded with the provider/model/
  // transport that produced the reply. A messaging surface's run is the one no
  // operator can inspect after the fact (there is no terminal to scroll), so
  // the log is where its attribution has to live.
  | 'inbound.chat'
  | 'chat.failed'
  | 'pipeline.completed'
  | 'adapter.error'
  // Deferred retries — the lifecycle of the "Reply *yes* and I will keep
  // trying" offer. Without these, a retry that fired (or failed to fire) hours
  // after the original turn left no evidence anywhere: the sender's reply and
  // the queued task were both invisible to the log.
  | 'retry.accepted'
  | 'retry.cancelled'
  | 'retry.started'
  | 'retry.succeeded'
  | 'retry.abandoned'
  // The intent audit — what the model said this ask really was, when a turn
  // kept failing. This is the agent's own learning made visible: a correction
  // here changes how the SAME ask routes from now on.
  | 'intent.confirmed'
  | 'intent.corrected';

/** One structured log record. `at` is ISO-8601 UTC. */
export interface GatewayLogRecord {
  at: string;
  level: GatewayLogLevel;
  event: GatewayLogEvent;
  [field: string]: unknown;
}

/** Rotate once the active file passes this size (bytes). */
export const GATEWAY_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Message-body preview cap (chars) — never the whole body. */
export const GATEWAY_LOG_PREVIEW_CHARS = 120;

/** Directory holding the log (sibling of the other gateway stores). */
export function gatewayLogDir(): string {
  return join(resolveBuffConfigDir(), 'gateway');
}

/** The active log file path. */
export function gatewayLogFile(): string {
  return join(gatewayLogDir(), 'logs.jsonl');
}

/** The single rotation generation path. */
export function gatewayLogRotatedFile(): string {
  return join(gatewayLogDir(), 'logs.1.jsonl');
}

/**
 * Scrub anything that looks like a credential. Defence in depth: callers are
 * expected not to pass secrets, but a token pasted into a target string (or a
 * provider error echoing an API key) must never be persisted.
 */
export function scrubSecrets(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, 'sk-***')
    .replace(/\b(gsk_[A-Za-z0-9_-]{8,})/g, 'gsk_***')
    .replace(/\b(AIza[0-9A-Za-z_-]{20,})/g, 'AIza***')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{8,})/g, 'xox***')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***')
    .replace(/([?&](?:access_token|api_?key|token|key|password)=)[^\s&"']+/gi, '$1***');
}

/** Truncate a message body to a short, scrub-safe preview. */
export function previewText(text: unknown): string | undefined {
  if (typeof text !== 'string' || !text) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  const cut = flat.length > GATEWAY_LOG_PREVIEW_CHARS ? `${flat.slice(0, GATEWAY_LOG_PREVIEW_CHARS)}…` : flat;
  return scrubSecrets(cut);
}

/** Recursively scrub string values in a field map (bounded depth). */
function scrubFields(fields: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 3) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') out[k] = scrubSecrets(v);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => (typeof x === 'string' ? scrubSecrets(x) : x));
    else if (typeof v === 'object') out[k] = scrubFields(v as Record<string, unknown>, depth + 1);
  }
  return out;
}

/** Rotate the active log to `logs.1.jsonl` when it exceeds the size cap. */
function rotateIfNeeded(): void {
  try {
    const file = gatewayLogFile();
    if (!existsSync(file)) return;
    if (statSync(file).size < GATEWAY_LOG_MAX_BYTES) return;
    // Single-generation rotation: the previous file is replaced. Deliberate —
    // the log exists to explain RECENT failures, not to be an archive.
    renameSync(file, gatewayLogRotatedFile());
  } catch {
    /* best-effort */
  }
}

/**
 * Append one structured record. Never throws, never blocks — a logging failure
 * must not affect delivery.
 */
export function logGatewayEvent(
  event: GatewayLogEvent,
  fields: Record<string, unknown> = {},
  level: GatewayLogLevel = 'info',
): void {
  try {
    const dir = gatewayLogDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    rotateIfNeeded();
    const record: GatewayLogRecord = {
      at: new Date().toISOString(),
      level,
      event,
      ...scrubFields(fields),
    };
    appendFileSync(gatewayLogFile(), `${JSON.stringify(record)}\n`, 'utf-8');
  } catch {
    /* best-effort — never break a send because the log is unwritable */
  }
}

/**
 * Read the most recent records, newest first. Reads the active file (and the
 * rotation generation when the active file has fewer than `limit` records), so
 * a just-rotated log still answers "what happened?".
 */
export function readGatewayLog(limit = 100): GatewayLogRecord[] {
  const out: GatewayLogRecord[] = [];
  const readOne = (file: string): GatewayLogRecord[] => {
    try {
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf-8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => {
          try {
            return JSON.parse(l) as GatewayLogRecord;
          } catch {
            return null;
          }
        })
        .filter((r): r is GatewayLogRecord => r !== null);
    } catch {
      return [];
    }
  };
  // Newest generation first: previous log, then the active file.
  const records = [...readOne(gatewayLogRotatedFile()), ...readOne(gatewayLogFile())];
  for (let i = records.length - 1; i >= 0 && out.length < limit; i -= 1) out.push(records[i]!);
  return out;
}

/** Absolute path help text for CLI/dashboard surfaces. */
export function gatewayLogPath(): string {
  return gatewayLogFile();
}
