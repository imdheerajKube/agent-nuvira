/**
 * P2 — Inbound inbox ledger (`src/gateway/inbox.ts`).
 *
 * Every message the gateway RECEIVES is recorded here — the inbound twin of
 * the delivery ledger (which tracks outbound). The dashboard's Channels tab
 * shows the inbox so users can see who messaged the bot, what it triggered
 * (pipeline / help / refused), and the outcome. File-backed at
 * `~/.buff/gateway/inbox.json` (BUFF_CONFIG_DIR aware), capped + pruned like
 * the delivery ledger.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveBuffConfigDir } from '../config/paths.js';

/** How an inbound message was handled by the registry. */
export type InboundDisposition = 'pipeline' | 'chat' | 'help' | 'refused' | 'error';

/** One inbound message recorded by the gateway. */
export interface InboxEntry {
  id: string;
  platform: string;
  channelId: string;
  text: string;
  /** Human sender label. */
  from?: string;
  /** Real sender id (per-user policies key off this). */
  senderId?: string;
  /** True when the message came from a group/channel. */
  isGroup?: boolean;
  /** What the gateway did with it. */
  handled: InboundDisposition;
  /** The reply text sent back (when any). */
  reply?: string;
  /** When the message was received (epoch ms). */
  at: number;
}

/** Cap — the newest N entries are retained. */
export const INBOX_MAX_ENTRIES = 500;
/** Entries older than this are pruned. */
export const INBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The file-backed inbox ledger. */
export class InboxLedger {
  private file: string;

  constructor(configDir?: string) {
    this.file = join(resolveBuffConfigDir(configDir), 'gateway', 'inbox.json');
  }

  /** Absolute path of the ledger file. */
  get ledgerPath(): string {
    return this.file;
  }

  /** All inbox entries, newest first. Never throws. */
  read(): InboxEntry[] {
    try {
      if (!existsSync(this.file)) return [];
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as { entries?: InboxEntry[] };
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  }

  private write(entries: InboxEntry[]): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ version: 1, entries }, null, 2), 'utf-8');
    } catch {
      /* best-effort — a failed inbox write must never break a message */
    }
  }

  /** Record an inbound message + its disposition. Returns the stored entry. */
  record(input: Omit<InboxEntry, 'id' | 'at'>): InboxEntry {
    const entry: InboxEntry = { ...input, id: randomUUID(), at: Date.now() };
    const entries = [entry, ...this.read()];
    // Prune: keep only entries within retention, then cap to the newest N.
    const kept = entries.filter((e) => Date.now() - e.at < INBOX_RETENTION_MS);
    this.write(kept.slice(0, INBOX_MAX_ENTRIES));
    return entry;
  }
}
