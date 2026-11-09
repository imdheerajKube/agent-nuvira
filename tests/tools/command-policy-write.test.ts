/**
 * Writing the user command policy — the half `nuvira config policy` and the
 * dashboard's Command Policy page share.
 *
 * The reader is covered in `command-policy.test.ts`; these pin the writer's
 * safety properties: an invalid entry is refused rather than dropped, a
 * malformed file is never overwritten, a prefix lives in exactly one list, and
 * the result actually changes `classifyCommand` — the behaviour the user asked
 * for, not just the bytes on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addCommandPolicyEntry,
  clearCommandPolicy,
  commandPolicyStatus,
  removeCommandPolicyEntry,
  resetCommandPolicyCache,
  writeCommandPolicy,
} from '../../src/tools/command-policy.js';
import { classifyCommand } from '../../src/tools/run-terminal.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buff-policy-write-'));
  file = join(dir, 'command-policy.json');
  process.env.NUVIRA_COMMAND_POLICY = file;
  resetCommandPolicyCache();
});

afterEach(() => {
  delete process.env.NUVIRA_COMMAND_POLICY;
  resetCommandPolicyCache();
  rmSync(dir, { recursive: true, force: true });
});

describe('writeCommandPolicy', () => {
  it('writes normalized, deduplicated lists with 0600 and the policy takes effect', () => {
    const r = writeCommandPolicy({
      allow: ['  Kill  ', 'KILL'],
      approve: ['git push'],
      deny: ['rm -rf build'],
    });
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();

    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string[]>;
    expect(raw.allow).toEqual(['kill']);
    expect(raw.approve).toEqual(['git push']);
    expect(raw.deny).toEqual(['rm -rf build']);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // The point of the file: the classes actually change.
    expect(classifyCommand('kill 1234')).toBe('verify');
    expect(classifyCommand('git push origin main')).toBe('confirm');
    expect(classifyCommand('rm -rf build')).toBe('deny');
  });

  it('refuses an empty or multi-line entry instead of silently dropping it', () => {
    const empty = writeCommandPolicy({ allow: ['   '] });
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain('empty');
    expect(existsSync(file)).toBe(false);

    const multi = writeCommandPolicy({ deny: ['rm -rf build\nrm -rf /'] });
    expect(multi.ok).toBe(false);
    expect(multi.error).toContain('single line');
    expect(existsSync(file)).toBe(false);
  });

  it('rejects a non-array list', () => {
    const r = writeCommandPolicy({ allow: 'git push' as unknown as string[] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('array');
  });

  it('a prefix lives in exactly one list, highest precedence first', () => {
    writeCommandPolicy({ allow: ['npm publish'] });
    expect(commandPolicyStatus().policy.allow).toEqual(['npm publish']);

    const denied = addCommandPolicyEntry('deny', 'npm publish');
    expect(denied.ok).toBe(true);
    expect(denied.policy?.deny).toEqual(['npm publish']);
    expect(denied.policy?.allow).toEqual([]);
  });
});

describe('addCommandPolicyEntry', () => {
  it('moves a prefix between lists rather than duplicating it', () => {
    expect(addCommandPolicyEntry('allow', 'git push').ok).toBe(true);
    const approved = addCommandPolicyEntry('approve', 'git push');
    expect(approved.ok).toBe(true);
    expect(approved.policy?.allow).toEqual([]);
    expect(approved.policy?.approve).toEqual(['git push']);
    expect(classifyCommand('git push origin main')).toBe('confirm');
  });

  it('refuses to overwrite a malformed file, and leaves it byte-identical', () => {
    const broken = '{ not json';
    writeFileSync(file, broken);
    const r = addCommandPolicyEntry('allow', 'kill');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not be read/i);
    expect(readFileSync(file, 'utf8')).toBe(broken);
  });
});

describe('remove and clear', () => {
  it('removes a prefix from whichever list holds it', () => {
    writeCommandPolicy({ allow: ['kill'], approve: ['git push'], deny: ['rm -rf build'] });
    const r = removeCommandPolicyEntry('KILL');
    expect(r.ok).toBe(true);
    expect(r.removed).toEqual(['allow']);
    expect(commandPolicyStatus().policy).toEqual({
      allow: [],
      approve: ['git push'],
      deny: ['rm -rf build'],
    });
  });

  it('reports a no-op honestly', () => {
    writeCommandPolicy({ allow: ['kill'] });
    const r = removeCommandPolicyEntry('npx cap sync');
    expect(r.ok).toBe(true);
    expect(r.removed).toEqual([]);
  });

  it('clears one list and keeps the file; clearing all deletes it', () => {
    writeCommandPolicy({ allow: ['kill'], deny: ['rm -rf build'] });

    const one = clearCommandPolicy('allow');
    expect(one.ok).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(commandPolicyStatus().policy).toEqual({ allow: [], approve: [], deny: ['rm -rf build'] });

    const all = clearCommandPolicy();
    expect(all.ok).toBe(true);
    expect(existsSync(file)).toBe(false);
    // Back to the built-in floor.
    expect(classifyCommand('git push origin main')).toBe('deny');
  });
});

describe('commandPolicyStatus', () => {
  it('reports a missing file as absent, not as an error', () => {
    const s = commandPolicyStatus();
    expect(s.exists).toBe(false);
    expect(s.error).toBeUndefined();
    expect(s.policy).toEqual({ allow: [], approve: [], deny: [] });
  });

  it('surfaces a parse error so the UI can refuse to save over it', () => {
    writeFileSync(file, '{');
    const s = commandPolicyStatus();
    expect(s.exists).toBe(true);
    expect(s.error).toBeTruthy();
    expect(s.policy).toEqual({ allow: [], approve: [], deny: [] });
  });
});
