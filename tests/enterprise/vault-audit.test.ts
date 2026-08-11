/**
 * K3 — Vault access auditing: unit tests for src/enterprise/vault-audit.ts
 * and the Vault primitives hook.
 *
 * Covers:
 * 1. recordVaultAccess appends a hash-chained, scrubbed record; the log reads
 *    back the op/account/ok/tier/via fields (newest first).
 * 2. The VITEST guard skips recording (test suites never pollute the store).
 * 3. Vault get/set/delete primitives produce audit records (aes-file tier,
 *    temp BUFF_MEMORY_DIR).
 * 4. Rotation keeps the chain VERIFIABLE after trimming (tamper-evidence
 *    survives rotation — the surviving slice is re-chained from genesis).
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  recordVaultAccess,
  readVaultAccessLog,
  resetVaultAuditCounter,
  VAULT_AUDIT_FILENAME,
  VAULT_AUDIT_CHAIN_ID,
} from '../../src/enterprise/vault-audit.js';
import { verifyAuditFile } from '../../src/enterprise/audit-chain.js';
import { Vault } from '../../src/enterprise/vault.js';

let memoryDir: string;

beforeAll(() => {
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  memoryDir = mkdtempSync(join(base, 'buff-vault-audit-'));
  process.env.BUFF_MEMORY_DIR = memoryDir;
});

afterAll(() => {
  try { rmSync(memoryDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  delete process.env.BUFF_MEMORY_DIR;
});

beforeEach(() => {
  delete process.env.VITEST; // exercise the real write path
  resetVaultAuditCounter();
});

afterEach(() => {
  process.env.VITEST = 'true';
});

const logPath = () => join(memoryDir, VAULT_AUDIT_FILENAME);

describe('recordVaultAccess', () => {
  it('appends a chained record that reads back with all fields', () => {
    recordVaultAccess('get', 'openai.apiKey', true, 'keyring', 'sync');
    recordVaultAccess('set', 'groq.apiKey', true, 'aes-file', 'async');
    recordVaultAccess('delete', 'nim.apiKey', false, 'aes-file', 'async');

    const entries = readVaultAccessLog(10);
    expect(entries).toHaveLength(3);
    // Newest first.
    expect(entries[0]).toMatchObject({ op: 'delete', account: 'nim.apiKey', ok: false, tier: 'aes-file', via: 'async' });
    expect(entries[1]).toMatchObject({ op: 'set', account: 'groq.apiKey', ok: true, tier: 'aes-file', via: 'async' });
    expect(entries[2]).toMatchObject({ op: 'get', account: 'openai.apiKey', ok: true, tier: 'keyring', via: 'sync' });
    expect(entries[0].ts).toBeGreaterThan(0);

    // The store is hash-chained and verifies clean.
    const result = verifyAuditFile(logPath(), VAULT_AUDIT_CHAIN_ID);
    expect(result.verdict).toBe('ok');
    expect(result.totalLines).toBe(3);
  });

  it('respects the VITEST test-env guard', () => {
    process.env.VITEST = 'true';
    recordVaultAccess('get', 'openai.apiKey', true, 'keyring', 'async');
    // The store from the prior test already exists — verify NO new line landed.
    const before = existsSync(logPath()) ? readFileSync(logPath(), 'utf-8').split('\n').filter(Boolean).length : 0;
    recordVaultAccess('get', 'openai.apiKey', true, 'keyring', 'async');
    const after = existsSync(logPath()) ? readFileSync(logPath(), 'utf-8').split('\n').filter(Boolean).length : 0;
    expect(after).toBe(before);
  });

  it('skips empty accounts', () => {
    rmSync(logPath(), { force: true });
    recordVaultAccess('get', '', true, 'keyring', 'async');
    expect(existsSync(logPath())).toBe(false);
  });
});

describe('rotation', () => {
  it('keeps the chain verifiable after trimming past the cap', () => {
    for (let i = 0; i < 12; i++) {
      recordVaultAccess('get', `prov.${i}.apiKey`, true, 'aes-file', 'async', /* maxLines */ 5);
    }
    const entries = readVaultAccessLog(50);
    // Rotation triggers at 2×cap (10) → trims to 5 at append 11, then append 12
    // lands without another rotation → 6 held (between cap and 2×cap).
    expect(entries.length).toBe(6);
    expect(entries.length).toBeLessThanOrEqual(10);
    expect(entries[0].account).toBe('prov.11.apiKey');
    const result = verifyAuditFile(logPath(), VAULT_AUDIT_CHAIN_ID);
    expect(result.verdict).toBe('ok');
  });
});

describe('Vault primitives audit', () => {
  it('records get/set/delete when a real vault is used', async () => {
    const vault = Vault.open({ tier: 'aes-file', masterPassphrase: 'test-passphrase', configDir: memoryDir });
    const account = 'demo.provider.apiKey';

    const write = await vault.setPassword(account, 'super-secret-value');
    expect(write.ok).toBe(true);
    expect((await vault.getPassword(account))).toBe('super-secret-value');
    expect(vault.getPasswordSync(account)).toBe('super-secret-value');
    expect(await vault.deletePassword(account)).toBe(true);
    expect(await vault.getPassword(account)).toBeNull();

    const entries = readVaultAccessLog(50);
    // set ok, get ok (async), get ok (sync), delete ok, get miss — all recorded.
    expect(entries.filter((e) => e.account === account)).toHaveLength(5);
    const ops = entries.filter((e) => e.account === account);
    expect(ops[0]).toMatchObject({ op: 'get', ok: false, via: 'async' }); // final miss (newest)
    expect(ops[1]).toMatchObject({ op: 'delete', ok: true });
    expect(ops.some((e) => e.op === 'get' && e.via === 'sync' && e.ok)).toBe(true);
    expect(ops.every((e) => e.tier === 'aes-file')).toBe(true);

    // The chained store still verifies.
    expect(verifyAuditFile(logPath(), VAULT_AUDIT_CHAIN_ID).verdict).toBe('ok');
  });

  it('never records the secret VALUE, only the account name', async () => {
    const vault = Vault.open({ tier: 'aes-file', masterPassphrase: 'test-passphrase-2', configDir: memoryDir });
    await vault.setPassword('secretkey.apiKey', 'AKIA-SUPER-SECRET-VALUE-12345');
    const raw = readFileSync(logPath(), 'utf-8');
    expect(raw).not.toContain('AKIA-SUPER-SECRET-VALUE-12345');
    expect(raw).toContain('secretkey.apiKey');
  });
});
