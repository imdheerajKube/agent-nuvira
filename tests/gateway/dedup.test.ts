/**
 * Inbound dedup ledger — one message delivered twice must be handled ONCE.
 *
 * Live context: a messaging bridge replays its offline backfill on every
 * (re)connect. Before this ledger existed, one WhatsApp ask arrived 20+ times
 * and was answered 20+ times (and re-ran a 112s multi-agent pipeline each
 * time) because every delivery was treated as brand new. These tests pin the
 * two behaviours that matter: a REPLAY is dropped, and a message the ledger
 * cannot identify is NEVER swallowed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InboundDedupLedger,
  contentDedupKey,
  messageDedupKey,
  DEDUP_CONTENT_WINDOW_MS,
} from '../../src/gateway/dedup.js';

let cfgDir = '';

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'buff-dedup-'));
});

afterEach(() => {
  rmSync(cfgDir, { recursive: true, force: true });
});

const base = {
  platform: 'whatsapp',
  channelId: '15551234567@s.whatsapp.net',
  text: 'write a poem for my daughter',
  senderId: '15551234567@s.whatsapp.net',
};

describe('InboundDedupLedger — transport message id (the strong key)', () => {
  it('classifies the first delivery as new and a re-delivery as a duplicate', () => {
    const ledger = new InboundDedupLedger(cfgDir);
    const first = ledger.classify({ ...base, messageId: 'MSG-1' });
    expect(first.duplicate).toBe(false);
    expect(first.kind).toBe('message-id');
    expect(first.count).toBe(1);

    const replay = ledger.classify({ ...base, messageId: 'MSG-1' });
    expect(replay.duplicate).toBe(true);
    expect(replay.count).toBe(2);
    expect(replay.firstSeenAt).toBe(first.firstSeenAt);
  });

  it('regression: 20 replays of the SAME message collapse to 1 real handle', () => {
    const ledger = new InboundDedupLedger(cfgDir);
    const verdicts = Array.from({ length: 20 }, () => ledger.classify({ ...base, messageId: 'STORM' }));
    expect(verdicts.filter((v) => !v.duplicate)).toHaveLength(1);
    expect(verdicts.filter((v) => v.duplicate)).toHaveLength(19);
    expect(verdicts.at(-1)?.count).toBe(20);
  });

  it('treats a DIFFERENT message id as a new message even when the text matches', () => {
    const ledger = new InboundDedupLedger(cfgDir);
    expect(ledger.classify({ ...base, messageId: 'A' }).duplicate).toBe(false);
    // A sender deliberately repeating themselves is NOT a duplicate: distinct
    // transport ids mean distinct messages.
    expect(ledger.classify({ ...base, messageId: 'B' }).duplicate).toBe(false);
  });

  it('persists across instances (a gateway restart still recognises the replay)', () => {
    const first = new InboundDedupLedger(cfgDir).classify({ ...base, messageId: 'P-1' });
    expect(first.duplicate).toBe(false);
    // A NEW process (fresh instance, same config dir) — the bridge reconnects
    // and replays the same id.
    expect(new InboundDedupLedger(cfgDir).classify({ ...base, messageId: 'P-1' }).duplicate).toBe(true);
  });

  it('forgets an id after the retention window (a genuinely old message is new again)', () => {
    const ledger = new InboundDedupLedger(cfgDir, { retentionMs: 1000 });
    ledger.classify({ ...base, messageId: 'OLD' });
    expect(ledger.classify({ ...base, messageId: 'OLD' }, Date.now() + 2000).duplicate).toBe(false);
  });
});

describe('InboundDedupLedger — content fallback is OFF by default', () => {
  it('does NOT dedup on text alone: two identical asks are both handled', () => {
    const ledger = new InboundDedupLedger(cfgDir);
    // No transport id (an adapter that exposes none).
    expect(ledger.classify(base).duplicate).toBe(false);
    // Swallowing this would lose a real message — the worse error.
    expect(ledger.classify(base).duplicate).toBe(false);
    expect(DEDUP_CONTENT_WINDOW_MS).toBe(0);
  });

  it('does not write a ledger row when it cannot dedup (no false protection)', () => {
    const ledger = new InboundDedupLedger(cfgDir);
    ledger.classify(base);
    expect(ledger.read()).toEqual([]);
  });

  it('dedups on the content fingerprint WHEN an operator opts in', () => {
    const ledger = new InboundDedupLedger(cfgDir, { contentWindowMs: 60_000 });
    expect(ledger.classify(base).duplicate).toBe(false);
    const again = ledger.classify(base);
    expect(again.duplicate).toBe(true);
    expect(again.kind).toBe('content');
    // Whitespace/case differences are the same message.
    expect(ledger.classify({ ...base, text: '  WRITE   a poem for my daughter ' }).duplicate).toBe(true);
  });

  it('a content fingerprint is scoped per channel AND sender', () => {
    const ledger = new InboundDedupLedger(cfgDir, { contentWindowMs: 60_000 });
    ledger.classify(base);
    expect(ledger.classify({ ...base, channelId: 'other@s.whatsapp.net' }).duplicate).toBe(false);
    expect(ledger.classify({ ...base, senderId: 'someone-else' }).duplicate).toBe(false);
  });
});

describe('InboundDedupLedger — robustness', () => {
  it('a corrupt ledger degrades to "not a duplicate" (never swallows a message)', () => {
    const path = new InboundDedupLedger(cfgDir).ledgerPath;
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{ not json', 'utf-8');
    const verdict = new InboundDedupLedger(cfgDir).classify({ ...base, messageId: 'X' });
    expect(verdict.duplicate).toBe(false);
  });

  it('caps the ledger so it cannot grow forever', () => {
    const ledger = new InboundDedupLedger(cfgDir, { maxEntries: 5 });
    for (let i = 0; i < 20; i += 1) ledger.classify({ ...base, messageId: `M-${i}` });
    const stored = JSON.parse(readFileSync(ledger.ledgerPath, 'utf-8')) as { entries: unknown[] };
    expect(stored.entries.length).toBeLessThanOrEqual(5);
  });

  it('prune() drops expired identities', () => {
    const ledger = new InboundDedupLedger(cfgDir, { retentionMs: 1000 });
    ledger.classify({ ...base, messageId: 'OLD' });
    expect(ledger.prune(Date.now() + 5000)).toBe(1);
  });

  it('builds distinct keys per kind, channel and sender', () => {
    expect(messageDedupKey({ ...base, messageId: 'k' })).toBe('whatsapp:message-id:k');
    const key = contentDedupKey(base);
    expect(key.startsWith('whatsapp:content:15551234567@s.whatsapp.net:15551234567@s.whatsapp.net:')).toBe(true);
  });
});
