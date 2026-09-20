/**
 * Inbound dedup ledger (`src/gateway/dedup.ts`).
 *
 * The gateway is at-least-once by construction: a messaging bridge reconnects,
 * replays its offline backlog, or a webhook retries — and every delivery used
 * to become a NEW inbound message. Observed live: one WhatsApp ask produced 20+
 * inbox entries with byte-identical replies, each one a full model turn (and,
 * for a pipeline-routed ask, a 112s multi-agent run) — the sender's phone
 * getting spammed with the same answer over and over.
 *
 * This ledger makes handling IDEMPOTENT on the strongest identity available:
 *
 * 1. **Message id** (`platform:message-id:<id>`) — the transport's own id, the
 *    default and the correct primary key. The same id means the same message,
 *    always: replayed on every reconnect it still counts once. Retained for
 *    `retentionMs` (7 days).
 * 2. **Content fingerprint** (`platform:content:<channel>:<sender>:<sha1>`) —
 *    OFF by default (`contentWindowMs: 0`). A sender may legitimately repeat
 *    themselves ("hi", "try again", the same ask after a failure), and an
 *    id-less transport cannot tell a retry from a deliberate repeat. Guessing
 *    wrong in the swallow-a-real-message direction is far worse than answering
 *    twice, so this is opt-in for an operator who knows their transport
 *    replays (set `contentWindowMs`); adapters that CAN expose an id should.
 *
 * Design mirrors the other gateway ledgers (delivery.ts / inbox.ts): file-backed
 * at `~/.nuvira/gateway/inbound-seen.json`, NUVIRA_CONFIG_DIR aware, capped, and
 * every write is best-effort — a failure to record MUST never break a message
 * (that is the one direction where losing the ledger is strictly worse than a
 * duplicate answer).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveBuffConfigDir } from '../config/paths.js';

/** How a duplicate was recognised. */
export type DedupKind = 'message-id' | 'content';

/** Cap — the newest N seen-keys are retained. */
export const DEDUP_MAX_ENTRIES = 4000;
/** Message-id keys are remembered this long (ms). */
export const DEDUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Content-fingerprint window (ms). 0 (the default) DISABLES content dedup:
 * without a transport id a re-delivery and a deliberate repeat are
 * indistinguishable, and swallowing a real message is the worse error.
 */
export const DEDUP_CONTENT_WINDOW_MS = 0;

/** One remembered inbound identity. */
export interface DedupEntry {
  key: string;
  kind: DedupKind;
  /** How many times this identity has been delivered (1 = first). */
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** The classification of one inbound message against the ledger. */
export interface DedupVerdict {
  /** True → this delivery was already handled; do NOT process it again. */
  duplicate: boolean;
  key: string;
  kind: DedupKind;
  /** Delivery number (1 on the first sighting). */
  count: number;
  firstSeenAt: number;
}

/** The identity inputs — everything that can distinguish two deliveries. */
export interface DedupInput {
  platform: string;
  channelId: string;
  text: string;
  senderId?: string;
  isGroup?: boolean;
  /** The transport's own message id, when the adapter exposes one. */
  messageId?: string;
}

/**
 * Normalize text for fingerprinting: trim, collapse whitespace, lowercase.
 * Deliberately NOT aggressive (no punctuation stripping) — the goal is to match
 * a re-delivery of the same message, not to merge distinct asks.
 */
function fingerprint(text: string): string {
  const norm = String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

/** The content key for a message without a transport id. */
export function contentDedupKey(input: DedupInput): string {
  const sender = input.senderId ?? '';
  return `${input.platform}:content:${input.channelId}:${sender}:${fingerprint(input.text)}`;
}

/** The strong key for a message that carries a transport id. */
export function messageDedupKey(input: DedupInput): string {
  return `${input.platform}:message-id:${input.messageId}`;
}

/** The ledger. */
export class InboundDedupLedger {
  private file: string;
  private retentionMs: number;
  private contentWindowMs: number;
  private maxEntries: number;

  constructor(
    configDir?: string,
    opts?: { retentionMs?: number; contentWindowMs?: number; maxEntries?: number },
  ) {
    this.file = join(resolveBuffConfigDir(configDir), 'gateway', 'inbound-seen.json');
    this.retentionMs = opts?.retentionMs ?? DEDUP_RETENTION_MS;
    this.contentWindowMs = opts?.contentWindowMs ?? DEDUP_CONTENT_WINDOW_MS;
    this.maxEntries = opts?.maxEntries ?? DEDUP_MAX_ENTRIES;
  }

  /** Absolute path of the ledger file (tests assert persistence location). */
  get ledgerPath(): string {
    return this.file;
  }

  /** All remembered identities, newest-first. Never throws. */
  read(): DedupEntry[] {
    try {
      if (!existsSync(this.file)) return [];
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as { entries?: DedupEntry[] };
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  }

  private write(entries: DedupEntry[]): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ version: 1, entries }, null, 2), 'utf-8');
    } catch {
      /* best-effort — a failed dedup write must never break a message */
    }
  }

  /** Per-kind expiry: message ids are remembered long, content only briefly. */
  private windowFor(kind: DedupKind): number {
    return kind === 'message-id' ? this.retentionMs : this.contentWindowMs;
  }

  /**
   * Classify one inbound delivery and REMEMBER it when new. Returns the verdict
   * (duplicate + count). Never throws: an unreadable ledger degrades to
   * "not a duplicate" so no message is ever silently swallowed by a bookkeeping
   * failure — the one failure mode we must not accept.
   */
  classify(input: DedupInput, now = Date.now()): DedupVerdict {
    const useId = typeof input.messageId === 'string' && input.messageId.trim().length > 0;
    const kind: DedupKind = useId ? 'message-id' : 'content';
    const key = useId ? messageDedupKey(input) : contentDedupKey(input);

    // No transport id and content dedup disabled (the default): treat every
    // delivery as new WITHOUT writing a ledger row. An id-less transport can
    // never be deduped safely, and recording a row we would never match on is
    // pure overhead + a false sense of protection.
    if (!useId && this.contentWindowMs <= 0) {
      return { duplicate: false, key, kind, count: 1, firstSeenAt: now };
    }

    let entries: DedupEntry[];
    try {
      entries = this.read();
    } catch {
      return { duplicate: false, key, kind, count: 1, firstSeenAt: now };
    }

    const idx = entries.findIndex((e) => e.key === key);
    const existing = idx === -1 ? undefined : entries[idx];
    if (existing) {
      const fresh = now - existing.lastSeenAt < this.windowFor(existing.kind);
      if (fresh) {
        existing.count += 1;
        existing.lastSeenAt = now;
        entries[idx] = existing;
        this.pruneAndWrite(entries, now);
        return { duplicate: true, key, kind, count: existing.count, firstSeenAt: existing.firstSeenAt };
      }
      // Expired identity — treat as new (a genuine repost after the window).
      entries.splice(idx, 1);
    }

    entries.unshift({ key, kind, count: 1, firstSeenAt: now, lastSeenAt: now });
    this.pruneAndWrite(entries, now);
    return { duplicate: false, key, kind, count: 1, firstSeenAt: now };
  }

  private pruneAndWrite(entries: DedupEntry[], now: number): void {
    const kept = entries
      .filter((e) => now - e.lastSeenAt < this.windowFor(e.kind))
      .slice(0, this.maxEntries);
    this.write(kept);
  }

  /** Drop expired identities. Returns how many were removed. */
  prune(now = Date.now()): number {
    const entries = this.read();
    const kept = entries.filter((e) => now - e.lastSeenAt < this.windowFor(e.kind));
    this.write(kept.slice(0, this.maxEntries));
    return entries.length - kept.length;
  }
}
