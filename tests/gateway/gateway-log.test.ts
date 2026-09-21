/**
 * Structured gateway log — the durable answer to "why did that message never
 * arrive?".
 *
 * Live incident (2026-09-21): a WhatsApp send was answered "I have sent…", the
 * recipient received nothing, and there was NO artifact to explain why — the
 * delivery ledger is pruned and the console line was gone. Every send failure,
 * refused sender and failed chat turn is now persisted with its reason.
 *
 * Hermetic: NUVIRA_CONFIG_DIR points at a temp dir for the whole file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  logGatewayEvent,
  readGatewayLog,
  gatewayLogFile,
  gatewayLogDir,
  previewText,
  scrubSecrets,
  GATEWAY_LOG_MAX_BYTES,
  GATEWAY_LOG_PREVIEW_CHARS,
} from '../../src/gateway/gateway-log.js';

let configDir = '';
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'buff-gwlog-'));
  envBackup.NUVIRA_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;
  envBackup.BUFF_CONFIG_DIR = process.env.BUFF_CONFIG_DIR;
  process.env.NUVIRA_CONFIG_DIR = configDir;
  delete process.env.BUFF_CONFIG_DIR;
});

afterEach(() => {
  if (envBackup.NUVIRA_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = envBackup.NUVIRA_CONFIG_DIR;
  if (envBackup.BUFF_CONFIG_DIR === undefined) delete process.env.BUFF_CONFIG_DIR;
  else process.env.BUFF_CONFIG_DIR = envBackup.BUFF_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
});

describe('logGatewayEvent', () => {
  it('appends one JSONL record with an ISO timestamp, level, event and fields', () => {
    logGatewayEvent('send.failed', { platform: 'whatsapp', channelId: '+918800663237', reason: 'not a WhatsApp account' }, 'warn');

    const raw = readFileSync(gatewayLogFile(), 'utf-8').trim().split('\n');
    expect(raw).toHaveLength(1);
    const record = JSON.parse(raw[0]);
    expect(record).toMatchObject({
      level: 'warn',
      event: 'send.failed',
      platform: 'whatsapp',
      channelId: '+918800663237',
      reason: 'not a WhatsApp account',
    });
    expect(new Date(record.at).toISOString()).toBe(record.at);
  });

  it('never throws and creates the gateway directory on demand', () => {
    expect(() => logGatewayEvent('send.ok', { platform: 'mock' })).not.toThrow();
    expect(() => logGatewayEvent('send.ok', { big: 'x'.repeat(50) })).not.toThrow();
    expect(readGatewayLog()).toHaveLength(2);
  });

  it('drops undefined/null fields instead of persisting them', () => {
    logGatewayEvent('send.failed', { platform: 'whatsapp', missing: undefined, nul: null, reason: 'boom' });
    const [record] = readGatewayLog();
    expect(record).toBeDefined();
    expect(record as Record<string, unknown>).not.toHaveProperty('missing');
    expect(record as Record<string, unknown>).not.toHaveProperty('nul');
  });

  it('returns records newest-first, skipping malformed lines', () => {
    logGatewayEvent('send.ok', { n: 1 });
    logGatewayEvent('send.failed', { n: 2 });
    // A truncated/partial line (crash mid-append) must not break the reader.
    const file = gatewayLogFile();
    writeFileSync(file, `${readFileSync(file, 'utf-8')}{not json\n`);

    const records = readGatewayLog(10);
    expect(records[0]).toMatchObject({ event: 'send.failed', n: 2 });
    expect(records[1]).toMatchObject({ event: 'send.ok', n: 1 });
    expect(records).toHaveLength(2);
  });

  it('rotates once the active file passes the cap, keeping the log bounded', () => {
    logGatewayEvent('send.ok', { n: 'before-rotation' });
    const file = gatewayLogFile();
    // Push the active file past the cap, then append a fresh record.
    writeFileSync(file, 'x'.repeat(GATEWAY_LOG_MAX_BYTES + 1));
    logGatewayEvent('send.ok', { n: 'after-rotation' });

    // The active file was reset + holds only the new record.
    expect(statSync(file).size).toBeLessThan(GATEWAY_LOG_MAX_BYTES);
    expect(readGatewayLog(5)[0]).toMatchObject({ n: 'after-rotation' });
    // The previous generation survived as logs.1.jsonl.
    expect(statSync(join(gatewayLogDir(), 'logs.1.jsonl')).size).toBeGreaterThanOrEqual(GATEWAY_LOG_MAX_BYTES);
  });

  it('reads across the rotated generation so a just-rotated failure is still found', () => {
    mkdirSync(gatewayLogDir(), { recursive: true });
    writeFileSync(
      join(gatewayLogDir(), 'logs.1.jsonl'),
      `${JSON.stringify({ at: '2026-09-21T05:00:00.000Z', level: 'warn', event: 'send.failed', n: 'rotated' })}\n`,
    );
    writeFileSync(
      gatewayLogFile(),
      `${JSON.stringify({ at: '2026-09-21T05:05:00.000Z', level: 'info', event: 'send.ok', n: 'active' })}\n`,
    );
    const records = readGatewayLog(10);
    expect(records.map((r) => r.n)).toEqual(['active', 'rotated']);
  });
});

describe('secret scrubbing', () => {
  it('masks credential-shaped values', () => {
    expect(scrubSecrets('key sk-abcdefghijklmnop')).toBe('key sk-***');
    expect(scrubSecrets('gsk_abcdefghijklmnop')).toBe('gsk_***');
    expect(scrubSecrets('token AIzaSyABCDEFGHIJKLMNOPQRSTUVWX')).toBe('token AIza***');
    expect(scrubSecrets('xoxb-1234567890-abc')).toBe('xox***');
    expect(scrubSecrets('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer ***');
    expect(scrubSecrets('https://x/y?access_token=supersecret&z=1')).toBe('https://x/y?access_token=***&z=1');
  });

  it('scrubs nested string fields before writing', () => {
    logGatewayEvent('send.failed', {
      reason: 'auth failed with sk-abcdefghijklmnop',
      nested: { token: 'gsk_abcdefghijklmnop' },
    });
    const [record] = readGatewayLog();
    expect(JSON.stringify(record)).not.toContain('sk-abcdefghijklmnop');
    expect(JSON.stringify(record)).not.toContain('gsk_abcdefghijklmnop');
    expect(JSON.stringify(record)).toContain('sk-***');
  });
});

describe('previewText', () => {
  it('flattens whitespace and truncates to the preview cap', () => {
    expect(previewText('hello\n\n   world')).toBe('hello world');
    const long = previewText('a'.repeat(GATEWAY_LOG_PREVIEW_CHARS + 50));
    expect(long).toHaveLength(GATEWAY_LOG_PREVIEW_CHARS + 1); // + the ellipsis
    expect(long?.endsWith('…')).toBe(true);
  });

  it('returns undefined for empty/non-string input', () => {
    expect(previewText('')).toBeUndefined();
    expect(previewText('   ')).toBeUndefined();
    expect(previewText(undefined)).toBeUndefined();
    expect(previewText(42)).toBeUndefined();
  });

  it('never leaks a credential pasted into a message body', () => {
    expect(previewText('my key is sk-abcdefghijklmnop ok')).toBe('my key is sk-*** ok');
  });
});

describe('gateway log path', () => {
  it('lives next to the other gateway stores (config dir, not memory)', () => {
    expect(gatewayLogFile()).toBe(join(configDir, 'gateway', 'logs.jsonl'));
  });
});
