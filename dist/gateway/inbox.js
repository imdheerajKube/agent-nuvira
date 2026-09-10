/**
 * P2 — Inbound inbox ledger (`src/gateway/inbox.ts`).
 *
 * Every message the gateway RECEIVES is recorded here — the inbound twin of
 * the delivery ledger (which tracks outbound). The dashboard's Channels tab
 * shows the inbox so users can see who messaged the bot, what it triggered
 * (pipeline / help / refused), and the outcome. File-backed at
 * `~/.nuvira/gateway/inbox.json` (NUVIRA_CONFIG_DIR aware), capped + pruned like
 * the delivery ledger.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveBuffConfigDir } from '../config/paths.js';
/** Cap — the newest N entries are retained. */
export const INBOX_MAX_ENTRIES = 500;
/** Entries older than this are pruned. */
export const INBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** The file-backed inbox ledger. */
export class InboxLedger {
    file;
    constructor(configDir) {
        this.file = join(resolveBuffConfigDir(configDir), 'gateway', 'inbox.json');
    }
    /** Absolute path of the ledger file. */
    get ledgerPath() {
        return this.file;
    }
    /** All inbox entries, newest first. Never throws. */
    read() {
        try {
            if (!existsSync(this.file))
                return [];
            const parsed = JSON.parse(readFileSync(this.file, 'utf-8'));
            return Array.isArray(parsed.entries) ? parsed.entries : [];
        }
        catch {
            return [];
        }
    }
    write(entries) {
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            writeFileSync(this.file, JSON.stringify({ version: 1, entries }, null, 2), 'utf-8');
        }
        catch {
            /* best-effort — a failed inbox write must never break a message */
        }
    }
    /** Record an inbound message + its disposition. Returns the stored entry. */
    record(input) {
        const entry = { ...input, id: randomUUID(), at: Date.now() };
        const entries = [entry, ...this.read()];
        // Prune: keep only entries within retention, then cap to the newest N.
        const kept = entries.filter((e) => Date.now() - e.at < INBOX_RETENTION_MS);
        this.write(kept.slice(0, INBOX_MAX_ENTRIES));
        return entry;
    }
}
//# sourceMappingURL=inbox.js.map