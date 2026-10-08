/**
 * Learned-command store tests.
 *
 * The store is isolated via `$NUVIRA_CONFIG_DIR`, which `resolveNuviraDataPath`
 * honours at call time — so these never touch the developer's real store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listLearnedCommands,
  learnedCommandFor,
  recordLearnedCommand,
  forgetLearnedCommand,
} from '../../src/learning/learned-commands.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buff-learned-'));
  process.env.NUVIRA_CONFIG_DIR = dir;
});

afterEach(() => {
  delete process.env.NUVIRA_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('learned-commands store', () => {
  it('records a command and reads it back, keyed by verb + OS', () => {
    const entry = recordLearnedCommand({ verb: 'Install Java', command: 'brew install openjdk', os: 'macos' });
    expect(entry?.verb).toBe('install java'); // normalized
    expect(entry?.source).toBe('model');
    expect(learnedCommandFor('install java', 'macos')?.command).toBe('brew install openjdk');
    // A different OS is a different fact.
    expect(learnedCommandFor('install java', 'linux')).toBeNull();
  });

  it('replaces the same (verb, os) instead of duplicating', () => {
    recordLearnedCommand({ verb: 'install java', command: 'apt-get install -y openjdk-17-jdk', os: 'linux' });
    recordLearnedCommand({ verb: 'install java', command: 'dnf install -y java-17-openjdk', os: 'linux' });
    expect(listLearnedCommands().filter((c) => c.verb === 'install java' && c.os === 'linux')).toHaveLength(1);
    expect(learnedCommandFor('install java', 'linux')?.command).toContain('dnf');
  });

  it('forgets one (verb, os) and reports whether anything was removed', () => {
    recordLearnedCommand({ verb: 'install java', command: 'brew install openjdk', os: 'macos' });
    expect(forgetLearnedCommand('install java', 'macos')).toBe(true);
    expect(forgetLearnedCommand('install java', 'macos')).toBe(false);
    expect(learnedCommandFor('install java', 'macos')).toBeNull();
  });

  it('ignores unusable input (no verb or no command)', () => {
    expect(recordLearnedCommand({ verb: '', command: 'npm install' })).toBeNull();
    expect(recordLearnedCommand({ verb: 'install', command: '   ' })).toBeNull();
    expect(listLearnedCommands()).toEqual([]);
  });

  it('a corrupt store reads as empty, never a throw', () => {
    writeFileSync(join(dir, 'learned-commands.json'), 'not json at all', 'utf-8');
    expect(listLearnedCommands()).toEqual([]);
    expect(learnedCommandFor('install java', 'macos')).toBeNull();
  });

  it('carries the optional binary and note', () => {
    const entry = recordLearnedCommand({
      verb: 'install java',
      command: 'brew install openjdk',
      binary: 'brew',
      note: 'needs a JDK 17+',
      os: 'macos',
    });
    expect(entry?.binary).toBe('brew');
    expect(entry?.note).toBe('needs a JDK 17+');
  });
});
