/**
 * Audit command CLI tests — P6 M6.3.
 *
 * Exercises `buff audit verify` exit codes (0 ok / 1 tampered|corrupt /
 * 2 legacy) and `buff audit export` output through the production command
 * wiring (commander parse, real temp files).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { AuditCommand } from '../../src/cli/audit.js';
import {
  appendChainedRecord,
  appendChainedRecordFast,
  chainLine,
  rechainRecords,
  headOfLines,
} from '../../src/enterprise/audit-chain.js';

let dir: string;
let file: string;
const chainId = 'test-audit';

function makeCli(): Command {
  const cli = new Command();
  cli.addCommand(new AuditCommand().create());
  cli.exitOverride();
  return cli;
}

function runVerify(cli: Command, fileArg?: string): { stdout: string; code: number } {
  const args = ['node', 'buff', 'audit', 'verify', '--file', fileArg || file];
  let stdout = '';
  // The CLI + logger write via console.log — spy the console methods.
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...chunks: unknown[]) => {
    stdout += chunks.map((c) => String(c)).join(' ') + '\n';
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    cli.parse(args);
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
  return { stdout, code: process.exitCode ?? 0 };
}

beforeEach(() => {
  process.exitCode = 0;
  dir = mkdtempSync(join(tmpdir(), 'buff-audit-cli-'));
  // Filename must match the chainId (the CLI derives the sidecar chainId from
  // the basename) — keep them identical so readHeadState's match succeeds.
  file = join(dir, `${chainId}.jsonl`);
});

afterEach(() => {
  process.exitCode = 0;
  rmSync(dir, { recursive: true, force: true });
});

describe('buff audit verify', () => {
  it('intact chained store → exit 0 with intact message', () => {
    appendChainedRecord(file, chainId, { type: 'parked', provider: 'groq' });
    appendChainedRecord(file, chainId, { type: 're-enabled', provider: 'gemini' });
    const { stdout, code } = runVerify(makeCli());
    expect(code).toBe(0);
    expect(stdout).toContain('Chain intact');
  });

  it('tampered store → exit 1 with tamper line', () => {
    appendChainedRecord(file, chainId, { type: 'parked', provider: 'groq' });
    appendChainedRecord(file, chainId, { type: 're-enabled', provider: 'gemini' });
    // Flip a byte in line 2.
    const raw = require('node:fs').readFileSync(file, 'utf-8').split('\n');
    raw[1] = raw[1].replace('gemini', 'geminy');
    require('node:fs').writeFileSync(file, raw.join('\n'), 'utf-8');
    const { stdout, code } = runVerify(makeCli());
    expect(code).toBe(1);
    expect(stdout).toContain('TAMPER DETECTED');
    expect(stdout).toContain('line 2');
  });

  it('legacy un-chained store → exit 2 (readable, chain starts next write)', () => {
    writeFileSync(file, '{"type":"parked","provider":"groq"}\n', 'utf-8');
    const { stdout, code } = runVerify(makeCli());
    expect(code).toBe(2);
    expect(stdout).toContain('legacy');
  });

  it('missing store → exit 2 with not-found note', () => {
    const { stdout, code } = runVerify(makeCli(), join(dir, 'missing.jsonl'));
    expect(code).toBe(2);
    expect(stdout).toContain('not found');
  });

  it('--json emits a machine-readable array with verdicts', () => {
    appendChainedRecord(file, chainId, { type: 'parked', provider: 'groq' });
    const cli = makeCli();
    let stdout = '';
    const spy = vi.spyOn(console, 'log').mockImplementation((...chunks: unknown[]) => {
      stdout += chunks.map((c) => String(c)).join(' ') + '\n';
    });
    try {
      cli.parse(['node', 'buff', 'audit', 'verify', '--file', file, '--json']);
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(stdout) as Array<{ verdict: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].verdict).toBe('ok');
  });
});

describe('buff audit export', () => {
  it('exports chained records as CEF lines', () => {
    appendChainedRecord(file, chainId, { type: 'parked', provider: 'groq' });
    const cli = makeCli();
    let stdout = '';
    const spy = vi.spyOn(console, 'log').mockImplementation((...chunks: unknown[]) => {
      stdout += chunks.map((c) => String(c)).join(' ') + '\n';
    });
    try {
      cli.parse(['node', 'buff', 'audit', 'export', '--file', file]);
    } finally {
      spy.mockRestore();
    }
    expect(stdout).toContain('cef:0|agent-nuvira|enterprise-audit|1.59.0|audit-record|');
  });
});

// Guard against the hot-path append regressing the chain (fast path parity).
describe('appendChainedRecordFast chain parity', () => {
  it('fast appends produce a verifiable chain identical in head to full append', () => {
    const fastFile = join(dir, 'fast.jsonl');
    const fullFile = join(dir, 'full.jsonl');
    for (let i = 0; i < 4; i++) {
      appendChainedRecordFast(fastFile, chainId, { type: 'parked', provider: `p${i}`, seq: i });
      appendChainedRecord(fullFile, chainId, { type: 'parked', provider: `p${i}`, seq: i });
    }
    const fastHead = headOfLines(require('node:fs').readFileSync(fastFile, 'utf-8').split('\n'));
    const fullHead = headOfLines(require('node:fs').readFileSync(fullFile, 'utf-8').split('\n'));
    expect(fastHead).toBe(fullHead);
    expect(fastHead).toBeTruthy();
  });

  it('rechainRecords restores a verifiable chain after a slice', () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push(chainLine(headOfLines(lines), { type: 'parked', provider: `p${i}`, seq: i }));
    }
    const sliced = lines.slice(-3);
    const rechained = rechainRecords(sliced);
    expect(rechained).toHaveLength(3);
    // The first surviving record must restart from genesis (no dangling ref).
    expect(JSON.parse(rechained[0]).chain.prevHash).toBe('genesis');
    expect(headOfLines(rechained)).toBeTruthy();
  });
});
