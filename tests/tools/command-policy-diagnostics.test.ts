/**
 * Diagnostics for the user command policy.
 *
 * These are the failure modes that are invisible at classification time: a
 * valid entry that still asks (allow on a floor command), an entry outranked by
 * another, an ignored entry, and a broad grant that covers more than the user
 * pictured. Doctor must name each one with a fix.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetCommandPolicyCache, writeCommandPolicy } from '../../src/tools/command-policy.js';
import { diagnoseCommandPolicy } from '../../src/tools/command-policy-diagnostics.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buff-policy-diag-'));
  file = join(dir, 'command-policy.json');
  process.env.NUVIRA_COMMAND_POLICY = file;
  resetCommandPolicyCache();
});

afterEach(() => {
  delete process.env.NUVIRA_COMMAND_POLICY;
  resetCommandPolicyCache();
  rmSync(dir, { recursive: true, force: true });
});

const messages = () => diagnoseCommandPolicy().findings.map((f) => f.message).join('\n');

describe('diagnoseCommandPolicy', () => {
  it('treats no file as a healthy state, not a failure', () => {
    const d = diagnoseCommandPolicy();
    expect(d.level).toBe('pass');
    expect(d.exists).toBe(false);
    expect(d.summary).toMatch(/built-in floor/i);
  });

  it('fails on a malformed file and says how to recover', () => {
    writeFileSync(file, '{ not json');
    const d = diagnoseCommandPolicy();
    expect(d.level).toBe('fail');
    expect(d.summary).toMatch(/unreadable/i);
    expect(d.findings[0].fix).toContain('config policy clear');
  });

  it('warns that allow on a floor command still asks once', () => {
    writeCommandPolicy({ allow: ['git push'] });
    const d = diagnoseCommandPolicy();
    expect(d.level).toBe('warn');
    expect(messages()).toMatch(/still ASKS once/i);
    expect(messages()).toMatch(/git push/);
  });

  it('warns when a permission is shadowed by a broader deny', () => {
    writeCommandPolicy({ approve: ['git push'], deny: ['git'] });
    expect(messages()).toMatch(/shadowed by deny "git"/i);
  });

  it('warns when a prefix sits in two lists (hand-edited file)', () => {
    writeFileSync(
      file,
      JSON.stringify({ allow: ['kill'], approve: ['kill'], deny: [] }),
    );
    resetCommandPolicyCache();
    expect(messages()).toMatch(/appears in approve and allow/i);
  });

  it('warns about an ignored entry', () => {
    writeFileSync(file, JSON.stringify({ allow: ['kill', '  ', 42], approve: [], deny: [] }));
    resetCommandPolicyCache();
    expect(messages()).toMatch(/is ignored/i);
  });

  it('warns that a one-token allow entry is a wide grant', () => {
    writeCommandPolicy({ allow: ['npm'] });
    const d = diagnoseCommandPolicy();
    expect(d.level).toBe('warn');
    expect(messages()).toMatch(/npm publish/);
  });

  it('passes a clean, narrow policy and reports the counts', () => {
    writeCommandPolicy({
      allow: ['npm run build'],
      approve: ['git push'],
      deny: ['rm -rf build'],
    });
    const d = diagnoseCommandPolicy();
    expect(d.level).toBe('pass');
    expect(d.summary).toMatch(/1 allow/);
    expect(d.findings.some((f) => f.message.includes('Valid policy'))).toBe(true);
  });
});
