/**
 * Audit-chain tests — P6 M6.3.
 *
 * Hash-chained, tamper-evident audit records: chaining math, verification
 * (incl. tamper detection + legacy compatibility), file-append integration,
 * and CEF export.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalJson,
  sha256,
  nextChain,
  chainLine,
  stripChain,
  verifyChain,
  headOfLines,
  appendChainedRecord,
  verifyAuditFile,
  exportCefLines,
  cefEscape,
  readHeadState,
  type ChainedRecord,
} from '../../src/enterprise/audit-chain.js';

// ─── Pure chaining ──────────────────────────────────────────────────────────

describe('chain math (pure)', () => {
  it('nextChain hashes prevHead + canonical record', () => {
    const record = { provider: 'groq', type: 'parked' };
    const c = nextChain(null, record);
    expect(c.prevHash).toBe('genesis');
    expect(c.hash).toBe(sha256(`genesis‖${canonicalJson(record)}`));
    // Same record, different prevHead → different hash.
    const c2 = nextChain('abc123', record);
    expect(c2.hash).not.toBe(c.hash);
  });

  it('canonicalJson sorts keys so ordering never changes the hash', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('stripChain removes the wrapper for hashing', () => {
    const wrapped = { provider: 'groq', chain: { prevHash: 'p', hash: 'h' } };
    expect(stripChain(wrapped)).toEqual({ provider: 'groq' });
    expect((stripChain(wrapped) as Record<string, unknown>).chain).toBeUndefined();
  });

  it('chainLine produces a line whose chain verifies', () => {
    const l1 = chainLine(null, { provider: 'groq', type: 'parked' });
    const p1 = JSON.parse(l1) as ChainedRecord;
    expect(p1.chain?.hash).toBeDefined();
    const l2 = chainLine(p1.chain!.hash, { provider: 'gemini', type: 're-enabled' });
    const p2 = JSON.parse(l2) as ChainedRecord;
    const r = verifyChain([l1, l2], 'test');
    expect(r.tamperLine).toBe(0);
    expect(r.legacyLines).toBe(0);
    // No sidecar head → recomputed head is the last valid chain hash.
    expect(r.recomputedHead).toBe(p2.chain!.hash);
  });
});

// ─── Verification + tamper detection ───────────────────────────────────────

describe('verifyChain', () => {
  let lines: string[];
  beforeEach(() => {
    const l1 = chainLine(null, { provider: 'groq', type: 'parked' });
    const p1 = JSON.parse(l1) as ChainedRecord;
    const l2 = chainLine(p1.chain!.hash, { provider: 'gemini', type: 're-enabled' });
    lines = [l1, l2];
  });

  it('intact chain + matching stored head → ok', () => {
    const head = headOfLines(lines);
    const r = verifyChain(lines, 'test', head);
    expect(r.verdict).toBe('ok');
    expect(r.headMatches).toBe(true);
    expect(r.tamperLine).toBe(0);
  });

  it('detects tampering in the middle of the chain', () => {
    // Flip a single byte in line 2's provider.
    const tampered = lines.map((l, i) =>
      i === 1 ? l.replace('gemini', 'geminy') : l,
    );
    const r = verifyChain(tampered, 'test', headOfLines(lines));
    expect(r.verdict).toBe('tampered');
    expect(r.tamperLine).toBe(2);
  });

  it('detects tampering of the FIRST record (genesis break)', () => {
    const tampered = [lines[0].replace('groq', 'grqq'), lines[1]];
    const r = verifyChain(tampered, 'test', headOfLines(lines));
    expect(r.verdict).toBe('tampered');
    expect(r.tamperLine).toBe(1);
  });

  it('detects a mismatched stored head (append-outside-file rewrite)', () => {
    const r = verifyChain(lines, 'test', 'deadbeef'.repeat(8));
    expect(r.verdict).toBe('tampered');
    expect(r.headMatches).toBe(false);
  });

  it('counts legacy un-chained lines without breaking the chain', () => {
    const legacy = ['{"type":"parked","provider":"groq"}', ...lines];
    const r = verifyChain(legacy, 'test', headOfLines(lines));
    expect(r.legacyLines).toBe(1);
    expect(r.tamperLine).toBe(0);
  });

  it('flags corrupt (non-JSON) lines', () => {
    const r = verifyChain(['{"a":1}', '{corrupt', ...lines], 'test', headOfLines(lines));
    expect(r.corruptLines).toBe(1);
    expect(r.verdict).toBe('corrupt');
  });

  it('pure-append keeps head stable; verify is deterministic', () => {
    const head1 = headOfLines(lines);
    const r1 = verifyChain(lines, 'test', head1);
    const r2 = verifyChain(lines, 'test', head1);
    expect(r1).toEqual(r2);
  });
});

// ─── File append + sidecar state ───────────────────────────────────────────

describe('appendChainedRecord / verifyAuditFile (file I/O)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'buff-audit-chain-'));
    file = join(dir, 'quota-events.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends chained, scrubbed records and persists head state', () => {
    // Runtime-assembled fake key (no full literal in source — scanner-safe).
    const fakeKey = ['sk-', 'abcdefgh', 'ijklmnop', 'qrstuvwx', 'yz'].join('');
    const l1 = appendChainedRecord(file, 'quota-events', { type: 'parked', provider: 'groq', apiKey: fakeKey });
    expect(l1).toBeTruthy();
    // The key must be scrubbed from the stored line.
    expect(l1).not.toContain(fakeKey.slice(0, 10));
    const raw1 = readFileSync(file, 'utf-8');
    expect(raw1).toContain('chain');

    appendChainedRecord(file, 'quota-events', { type: 're-enabled', provider: 'gemini' });
    const state = readHeadState(file, 'quota-events');
    expect(state).not.toBeNull();
    expect(state?.head).toBe(headOfLines(readFileSync(file, 'utf-8').split('\n')));

    const v = verifyAuditFile(file, 'quota-events');
    expect(v.verdict).toBe('ok');
    expect(v.totalLines).toBe(2);
  });

  it('tampering with the file is caught by verifyAuditFile', () => {
    appendChainedRecord(file, 'quota-events', { type: 'parked', provider: 'groq' });
    appendChainedRecord(file, 'quota-events', { type: 're-enabled', provider: 'gemini' });
    // Rewrite line 2 with a flipped provider value.
    const raw = readFileSync(file, 'utf-8').split('\n');
    raw[1] = raw[1].replace('gemini', 'geminy');
    writeFileSync(file, raw.join('\n'), 'utf-8');
    const v = verifyAuditFile(file, 'quota-events');
    expect(v.verdict).toBe('tampered');
    expect(v.tamperLine).toBe(2);
  });

  it('rotation (cap) keeps the chain intact', () => {
    for (let i = 0; i < 5; i++) {
      appendChainedRecord(file, 'quota-events', { type: 'parked', provider: `p${i}`, seq: i }, 3);
    }
    const v = verifyAuditFile(file, 'quota-events');
    expect(v.verdict).toBe('ok');
    expect(v.totalLines).toBe(3);
  });

  it('missing file verifies as legacy/empty without throwing', () => {
    const v = verifyAuditFile(join(dir, 'does-not-exist.jsonl'), 'quota-events');
    expect(v.totalLines).toBe(0);
    expect(['legacy', 'corrupt']).toContain(v.verdict);
  });
});

// ─── Export ─────────────────────────────────────────────────────────────────

describe('exportCefLines / cefEscape', () => {
  it('produces CEF lines with escaped values', () => {
    const l1 = chainLine(null, { type: 'parked', provider: 'groq', detail: 'rate|limit=hit' });
    const out = exportCefLines([l1]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('cef:0|agent-nuvira|enterprise-audit|1.59.0|audit-record|');
    expect(out[0]).toContain('rate\\|limit\\=hit');
  });

  it('skips unparseable lines without throwing', () => {
    expect(exportCefLines(['{corrupt'])).toEqual([]);
  });

  it('cefEscape escapes backslash, pipe and equals', () => {
    expect(cefEscape('a\\b|c=d')).toBe('a\\\\b\\|c\\=d');
  });
});

describe('auditFilePath convenience', () => {
  it('resolves jsonl path honoring BUFF_MEMORY_DIR', async () => {
    const mod = await import('../../src/enterprise/audit-chain.js');
    process.env.BUFF_MEMORY_DIR = join(tmpdir(), 'buff-audit-mem');
    try {
      expect(mod.auditFilePath('quota-events')).toContain('quota-events.jsonl');
      expect(existsSync(mod.auditFilePath('x'))).toBe(false);
    } finally {
      delete process.env.BUFF_MEMORY_DIR;
    }
  });
});
