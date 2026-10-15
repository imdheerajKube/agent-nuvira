/**
 * The scratch workspace — the last rung of the folder ladder.
 *
 * Why it exists: a turn that must PRODUCE a file had nowhere to put it. The
 * dashboard refused and asked for a folder, and a messaging turn wrote into
 * whatever directory the gateway process was started from — a tree belonging to
 * nobody asking the question. These tests pin the three properties that make the
 * replacement safe: the path is DERIVED (so two contacts never share a folder),
 * it is REAL and writable (so a write cannot fail later with a confusing error),
 * and it is TEMPORARY (so it is pruned rather than accumulating forever).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureScratchWorkspace,
  pruneScratchWorkspaces,
  scratchKeyToDirName,
  scratchWorkspaceFor,
  scratchWorkspaceForTurn,
  scratchWorkspaceNotice,
  scratchWorkspaceRoot,
} from '../../src/config/scratch-workspace.js';

let home: string;
let previousConfigDir: string | undefined;
let previousScratchDir: string | undefined;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'buff-scratch-'));
  previousConfigDir = process.env.NUVIRA_CONFIG_DIR;
  previousScratchDir = process.env.NUVIRA_SCRATCH_DIR;
  // Isolate the root: `resolveNuviraDataPath` follows NUVIRA_CONFIG_DIR, so this
  // suite can never touch the developer's real ~/.nuvira.
  process.env.NUVIRA_CONFIG_DIR = home;
  delete process.env.NUVIRA_SCRATCH_DIR;
});

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = previousConfigDir;
  if (previousScratchDir === undefined) delete process.env.NUVIRA_SCRATCH_DIR;
  else process.env.NUVIRA_SCRATCH_DIR = previousScratchDir;
  rmSync(home, { recursive: true, force: true });
});

describe('scratchKeyToDirName', () => {
  it('keeps an already-safe key readable', () => {
    expect(scratchKeyToDirName('chat-12ab34cd')).toBe('chat-12ab34cd');
    expect(scratchKeyToDirName('session.one_two-3')).toBe('session.one_two-3');
  });

  it('sanitizes a WhatsApp jid and appends a hash, so two contacts never collide', () => {
    const a = scratchKeyToDirName('whatsapp:918800604222@s.whatsapp.net');
    const b = scratchKeyToDirName('whatsapp:918800604223@s.whatsapp.net');
    expect(a).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(a).not.toContain(':');
    expect(a).not.toContain('@');
    // Different contacts, different folders — the hash is what guarantees it.
    expect(a).not.toBe(b);
  });

  it('is deterministic, and never produces a traversal or an empty name', () => {
    expect(scratchKeyToDirName('whatsapp:1@x')).toBe(scratchKeyToDirName('whatsapp:1@x'));
    expect(scratchKeyToDirName('../../etc')).not.toContain('..');
    expect(scratchKeyToDirName('')).toBe('unnamed');
    expect(scratchKeyToDirName('   ')).toBe('unnamed');
  });
});

describe('scratchWorkspaceRoot / scratchWorkspaceFor', () => {
  it('defaults to <nuvira home>/workspace and honours NUVIRA_SCRATCH_DIR', () => {
    expect(scratchWorkspaceRoot()).toBe(join(home, 'workspace'));
    process.env.NUVIRA_SCRATCH_DIR = join(home, 'elsewhere');
    expect(scratchWorkspaceRoot()).toBe(join(home, 'elsewhere'));
    delete process.env.NUVIRA_SCRATCH_DIR;
  });

  it('names the folder per key, under the root', () => {
    expect(scratchWorkspaceFor('chat-1')).toBe(join(home, 'workspace', 'chat-1'));
  });
});

describe('ensureScratchWorkspace', () => {
  it('creates a REAL, writable directory and returns it', () => {
    const dir = ensureScratchWorkspace('chat-real');
    expect(dir).toBe(join(home, 'workspace', 'chat-real'));
    expect(dir && existsSync(dir)).toBe(true);
    expect(dir && statSync(dir).isDirectory()).toBe(true);
    // No probe file is left behind (only the folder).
    expect(dir && readdirSync(dir)).toEqual([]);
  });

  it('is idempotent', () => {
    const first = ensureScratchWorkspace('chat-real');
    const second = ensureScratchWorkspace('chat-real');
    expect(second).toBe(first);
  });

  it('falls back to os.tmpdir() when the app-home root cannot be created', () => {
    // A root that is a FILE cannot hold a directory — the fallback must catch it
    // rather than returning a path nothing can be written into.
    const blocked = join(home, 'blocked-root');
    mkdirSync(blocked, { recursive: true });
    process.env.NUVIRA_SCRATCH_DIR = join(blocked, 'not-a-dir');
    // Make the "root" itself a file.
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(process.env.NUVIRA_SCRATCH_DIR, 'x');
    try {
      const dir = ensureScratchWorkspace('chat-fallback');
      expect(dir).toBeTruthy();
      expect(dir).toContain('nuvira-scratch');
      expect(dir && existsSync(dir)).toBe(true);
      rmSync(dir as string, { recursive: true, force: true });
    } finally {
      rmSync(blocked, { recursive: true, force: true });
      delete process.env.NUVIRA_SCRATCH_DIR;
    }
  });
});

/**
 * G14 — `scratchWorkspaceForTurn`: WHEN a scratch folder may be used at all.
 *
 * The rung existed but the DECISION to take it was written twice (the dashboard
 * and the gateway each had their own copy), which is how the gateway ended up
 * handing a scratch folder to an ISOLATED turn: isolation's subject is a real
 * repository with a base commit to diff against, and a scratch folder is neither,
 * so the request the deployment made (`NUVIRA_ISOLATE=1`) collapsed into
 * `generation_failed` with no model call. These cases pin the rule itself, so the
 * next surface to offer a temporary folder inherits it instead of re-deciding.
 */
describe('scratchWorkspaceForTurn', () => {
  it('creates the folder for a PRODUCE ask', () => {
    const dir = scratchWorkspaceForTurn({ key: 'turn-produce', need: 'produce', isolationAsked: false });
    expect(dir).toBe(join(home, 'workspace', 'turn-produce'));
    expect(dir && existsSync(dir)).toBe(true);
  });

  it('refuses for a READ ask — an empty folder holds none of that work', () => {
    expect(scratchWorkspaceForTurn({ key: 'turn-read', need: 'read', isolationAsked: false })).toBeUndefined();
    expect(existsSync(join(home, 'workspace', 'turn-read'))).toBe(false);
  });

  it('refuses for plain chat — `projectPath` is not only a write target', () => {
    expect(scratchWorkspaceForTurn({ key: 'turn-chat', need: null, isolationAsked: false })).toBeUndefined();
  });

  it('refuses an ISOLATED turn, even for a produce ask', () => {
    // The regression: a scratch folder cannot be isolated, so handing one over
    // turned the isolation request into a refusal.
    expect(
      scratchWorkspaceForTurn({ key: 'turn-isolated', need: 'produce', isolationAsked: true }),
    ).toBeUndefined();
    expect(existsSync(join(home, 'workspace', 'turn-isolated'))).toBe(false);
  });
});

describe('pruneScratchWorkspaces', () => {
  it('removes only folders older than the retention, and says how many', () => {
    const root = scratchWorkspaceRoot();
    const stale = join(root, 'stale');
    const fresh = join(root, 'fresh');
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
    utimesSync(stale, new Date(old), new Date(old));

    const removed = pruneScratchWorkspaces();

    expect(removed).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('is a no-op when the root does not exist', () => {
    process.env.NUVIRA_SCRATCH_DIR = join(home, 'no-such-root');
    try {
      expect(pruneScratchWorkspaces()).toBe(0);
    } finally {
      delete process.env.NUVIRA_SCRATCH_DIR;
    }
  });
});

describe('scratchWorkspaceNotice', () => {
  it('names the path, says it is temporary, and gives both ways to keep the work', () => {
    const text = scratchWorkspaceNotice('/tmp/scratch/chat-1');
    expect(text).toContain('/tmp/scratch/chat-1');
    expect(text).toMatch(/TEMPORARY/);
    expect(text).toMatch(/not one of the user/);
    // The two offers, spelled out for the model to make.
    expect(text).toMatch(/folder path they want it moved to/);
    expect(text).toMatch(/attach a project folder/);
  });
});
