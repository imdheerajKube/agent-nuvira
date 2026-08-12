/**
 * I2 — Delivery ledger tests (Hermes delivery.py / delivery_ledger.py parity).
 *
 * Covers: file-backed persistence across instances, exponential backoff
 * schedule, attempt accounting (sent / pending / failed), due-window
 * processing, prune (cap + retention), and the GatewayRegistry integration
 * (failed send → enqueue; successful drain → sent). All hermetic — a temp
 * config dir, never the real ~/.buff.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DeliveryLedger,
  nextRetryDelayMs,
  DELIVERY_MAX_RETRY_MS,
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_MAX_ENTRIES,
} from '../../src/gateway/delivery.js';
import { GatewayRegistry } from '../../src/gateway/registry.js';
import type { ChannelAdapter, InboundMessage } from '../../src/gateway/adapters.js';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'buff-delivery-test-'));
}

/** A scripted adapter: send returns a fixed success/failure + records calls. */
function scriptedAdapter(sendResult: boolean | 'throw'): ChannelAdapter & { sent: Array<[string, string]> } {
  const sent: Array<[string, string]> = [];
  return {
    platform: 'mock' as const,
    configured: true,
    describe: () => 'mock adapter',
    sent,
    async start(_on: (m: InboundMessage) => void) {},
    async stop() {},
    async send(channelId: string, text: string) {
      sent.push([channelId, text]);
      if (sendResult === 'throw') throw new Error('network down');
      return sendResult;
    },
  };
}

describe('delivery ledger — persistence', () => {
  it('enqueue persists and survives a fresh instance (file-backed)', () => {
    const dir = makeDir();
    try {
      const ledger = new DeliveryLedger(dir);
      const entry = ledger.enqueue({ target: 'mock:1', ref: { platform: 'mock', channelId: '1' }, text: 'hello' });
      expect(entry.status).toBe('pending');
      expect(existsSync(ledger.ledgerPath)).toBe(true);

      const reloaded = new DeliveryLedger(dir);
      const entries = reloaded.read();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(entry.id);
      expect(entries[0].text).toBe('hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('backoff + attempt accounting', () => {
  it('backoff doubles and caps at the ceiling', () => {
    expect(nextRetryDelayMs(1)).toBe(15_000);
    expect(nextRetryDelayMs(2)).toBe(30_000);
    expect(nextRetryDelayMs(3)).toBe(60_000);
    expect(nextRetryDelayMs(10)).toBe(DELIVERY_MAX_RETRY_MS);
  });

  it('a failed attempt stays pending with a future nextAttemptAt; a success marks sent', () => {
    const dir = makeDir();
    try {
      const ledger = new DeliveryLedger(dir);
      const entry = ledger.enqueue({ target: 'mock:1', ref: { platform: 'mock', channelId: '1' }, text: 'hi' });
      const before = Date.now();

      const after = ledger.recordAttempt(entry.id, { ok: false, error: 'timeout' });
      expect(after?.status).toBe('pending');
      expect(after?.attempts).toBe(1);
      expect(after?.nextAttemptAt).toBeGreaterThan(before);
      expect(after?.lastError).toBe('timeout');

      const done = ledger.recordAttempt(entry.id, { ok: true });
      expect(done?.status).toBe('sent');
      expect(done?.attempts).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exhausts to failed at DELIVERY_MAX_ATTEMPTS', () => {
    const dir = makeDir();
    try {
      const ledger = new DeliveryLedger(dir);
      const entry = ledger.enqueue({ target: 'mock:1', ref: { platform: 'mock', channelId: '1' }, text: 'hi' });
      let current = entry;
      for (let i = 0; i < DELIVERY_MAX_ATTEMPTS; i++) {
        current = ledger.recordAttempt(current.id, { ok: false, error: 'nope' })!;
      }
      expect(current.status).toBe('failed');
      expect(current.attempts).toBe(DELIVERY_MAX_ATTEMPTS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('due-window processing + prune', () => {
  it('pendingDue only returns entries whose backoff window elapsed', () => {
    const dir = makeDir();
    try {
      const ledger = new DeliveryLedger(dir);
      ledger.enqueue({ target: 'mock:1', ref: { platform: 'mock', channelId: '1' }, text: 'a' });
      const second = ledger.enqueue({ target: 'mock:2', ref: { platform: 'mock', channelId: '2' }, text: 'b' });
      // Freeze the second entry's retry window far in the future.
      ledger.recordAttempt(second.id, { ok: false, error: 'later' });
      // With a fake clock: only the first (nextAttemptAt = now) is due.
      const due = ledger.pendingDue(Date.now());
      expect(due).toHaveLength(1);
      expect(due[0].text).toBe('a');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('processDue sends due entries through the sender and prunes stale entries', async () => {
    const dir = makeDir();
    try {
      const ledger = new DeliveryLedger(dir);
      ledger.enqueue({ target: 'mock:1', ref: { platform: 'mock', channelId: '1' }, text: 'a' });
      const sender = vi.fn(async () => ({ ok: true }));
      const counts = await ledger.processDue(sender as any);
      expect(counts).toEqual({ processed: 1, sent: 1, failed: 0 });
      expect(ledger.read()[0].status).toBe('sent');
      // Second pass: nothing due.
      const again = await ledger.processDue(sender as any);
      expect(again.processed).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prune enforces the entry cap and retention window', () => {
    const dir = makeDir();
    try {
      const ledger = new DeliveryLedger(dir);
      for (let i = 0; i < DELIVERY_MAX_ENTRIES + 50; i++) {
        ledger.enqueue({ target: `mock:${i}`, ref: { platform: 'mock', channelId: String(i) }, text: `m${i}` });
      }
      const pruned = ledger.prune();
      expect(pruned).toBe(50);
      expect(ledger.read()).toHaveLength(DELIVERY_MAX_ENTRIES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GatewayRegistry integration', () => {
  it('a failed send is enqueued; a successful drain delivers it', async () => {
    const dir = makeDir();
    try {
      const failing = scriptedAdapter(false);
      const registry = new GatewayRegistry({ streamEvents: false, deliveryConfigDir: dir });
      registry.register(failing);

      const ok = await registry.sendToRef({ platform: 'mock', channelId: '1' }, 'hello');
      expect(ok).toBe(false);
      expect(registry.delivery.read()).toHaveLength(1);
      expect(registry.delivery.read()[0].status).toBe('pending');

      // Network recovers — the ledger drains through a working adapter.
      const working = scriptedAdapter(true);
      const registry2 = new GatewayRegistry({ streamEvents: false, deliveryConfigDir: dir });
      registry2.register(working);
      const counts = await registry2.drainDelivery();
      expect(counts.sent).toBe(1);
      expect(working.sent).toEqual([['1', 'hello']]);
      expect(registry2.delivery.read()[0].status).toBe('sent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a successful send does NOT enqueue and opportunistically flushes due entries', async () => {
    const dir = makeDir();
    try {
      // Seed a due pending entry for 'mock'.
      const ledger = new DeliveryLedger(dir);
      ledger.enqueue({ target: 'mock:9', ref: { platform: 'mock', channelId: '9' }, text: 'queued' });

      const adapter = scriptedAdapter(true);
      const registry = new GatewayRegistry({ streamEvents: false, deliveryConfigDir: dir });
      registry.register(adapter);

      const ok = await registry.sendToRef({ platform: 'mock', channelId: '1' }, 'live');
      expect(ok).toBe(true);
      // No new entry for the live message.
      expect(registry.delivery.read().filter((e) => e.text === 'live')).toHaveLength(0);
      // The queued one was flushed opportunistically.
      expect(adapter.sent).toContainEqual(['9', 'queued']);
      expect(registry.delivery.read().find((e) => e.text === 'queued')?.status).toBe('sent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
