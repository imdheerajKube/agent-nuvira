/**
 * I2 — Gateway delivery ledger (`src/gateway/delivery.ts`).
 *
 * A channel send is not
 * fire-and-forget. When `adapter.send()` fails (network blip, rate limit,
 * channel temporarily unreachable), the message is persisted to a delivery
 * ledger (`~/.nuvira/gateway/delivery.json`) and retried with exponential
 * backoff while the gateway runs — so a one-shot `nuvira gateway send` that
 * fails is NOT lost: the next `nuvira gateway start` drains it.
 *
 * Design:
 * - **Ledger survives processes** (file-backed, NUVIRA_CONFIG_DIR aware).
 * - **Backoff**: base 15s doubling, capped at 10 min; max 5 attempts, then
 *   the entry is marked `failed` (visible in `nuvira gateway delivery`).
 * - **Cap + prune**: keep the most recent 500 entries; `sent`/`failed` older
 *   than 24h are dropped so the file never grows unbounded.
 * - **Opportunistic flush**: a successful send drains any due pending entries
 *   for the same platform.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveBuffConfigDir } from '../config/paths.js';
import type { ChannelRef, Platform } from './channel-directory.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Base delay before the first retry (ms). */
export const DELIVERY_BASE_RETRY_MS = 15_000;
/** Retry delay cap (ms) — backoff doubles up to this ceiling. */
export const DELIVERY_MAX_RETRY_MS = 10 * 60_000;
/** Attempts before an entry is marked `failed` (1 immediate + retries). */
export const DELIVERY_MAX_ATTEMPTS = 5;
/** Ledger cap — oldest entries are pruned beyond this. */
export const DELIVERY_MAX_ENTRIES = 500;
/** Sent/failed entries older than this (ms) are pruned. */
export const DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1000;

// ─── Types ──────────────────────────────────────────────────────────────────

export type DeliveryStatus = 'pending' | 'sent' | 'failed';

/** One outbound message tracked by the ledger. */
export interface DeliveryEntry {
  id: string;
  /** The target string as the caller gave it (alias or platform:channelId). */
  target: string;
  platform: Platform;
  channelId: string;
  text: string;
  status: DeliveryStatus;
  /** Attempts so far (0 = never tried from the ledger). */
  attempts: number;
  /** Earliest epoch-ms at which this entry may be retried. */
  nextAttemptAt: number;
  createdAt: number;
  /** Human reason from the last failed attempt. */
  lastError?: string;
}

/** Compute the next backoff delay for a given attempt count. */
export function nextRetryDelayMs(attempts: number): number {
  const delay = DELIVERY_BASE_RETRY_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(delay, DELIVERY_MAX_RETRY_MS);
}

// ─── Ledger ─────────────────────────────────────────────────────────────────

export class DeliveryLedger {
  private file: string;

  constructor(configDir?: string) {
    this.file = join(resolveBuffConfigDir(configDir), 'gateway', 'delivery.json');
  }

  /** Absolute path of the ledger file (tests assert persistence location). */
  get ledgerPath(): string {
    return this.file;
  }

  /** All ledger entries, newest first. Never throws. */
  read(): DeliveryEntry[] {
    try {
      if (!existsSync(this.file)) return [];
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as { entries?: DeliveryEntry[] };
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  }

  private write(entries: DeliveryEntry[]): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ version: 1, entries }, null, 2), 'utf-8');
    } catch { /* best-effort — a failed ledger write must never break a send */ }
  }

  /** Persist a new pending entry. Returns the stored entry. */
  enqueue(input: { target: string; ref: ChannelRef; text: string }): DeliveryEntry {
    const entry: DeliveryEntry = {
      id: randomUUID(),
      target: input.target,
      platform: input.ref.platform,
      channelId: input.ref.channelId,
      text: input.text,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
    };
    this.write([entry, ...this.read()]);
    return entry;
  }

  /** Record the outcome of one attempt. Returns the updated entry. */
  recordAttempt(
    id: string,
    result: { ok: boolean; error?: string },
  ): DeliveryEntry | undefined {
    const entries = this.read();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return undefined;
    const entry = entries[idx];
    entry.attempts += 1;
    if (result.ok) {
      entry.status = 'sent';
      entry.lastError = undefined;
    } else {
      entry.lastError = result.error ?? 'send failed';
      if (entry.attempts >= DELIVERY_MAX_ATTEMPTS) {
        entry.status = 'failed';
      } else {
        entry.status = 'pending';
        entry.nextAttemptAt = Date.now() + nextRetryDelayMs(entry.attempts);
      }
    }
    entries[idx] = entry;
    this.write(entries);
    return entry;
  }

  /** Pending entries whose backoff window has elapsed, oldest-due first. */
  pendingDue(now = Date.now()): DeliveryEntry[] {
    return this.read()
      .filter((e) => e.status === 'pending' && e.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
  }

  /**
   * Attempt every due pending entry through the provided sender.
   * `sender(entry)` performs the platform send and returns {ok, error?}.
   * Returns { processed, sent, failed } counters.
   */
  processDue(
    sender: (entry: DeliveryEntry) => Promise<{ ok: boolean; error?: string }>,
  ): Promise<{ processed: number; sent: number; failed: number }> {
    return (async () => {
      const due = this.pendingDue();
      let sent = 0;
      let failed = 0;
      for (const entry of due) {
        const result = await sender(entry);
        const updated = this.recordAttempt(entry.id, result);
        if (updated?.status === 'sent') sent += 1;
        else if (updated?.status === 'failed') failed += 1;
      }
      this.prune();
      return { processed: due.length, sent, failed };
    })();
  }

  /** Drop entries beyond the cap and stale terminal entries. */
  prune(now = Date.now()): number {
    const entries = this.read();
    const kept = entries.filter((e) => e.status === 'pending' || now - e.createdAt < DELIVERY_RETENTION_MS);
    const capped = kept.slice(0, DELIVERY_MAX_ENTRIES);
    this.write(capped);
    return entries.length - capped.length;
  }
}
