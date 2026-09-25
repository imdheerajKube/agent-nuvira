/**
 * Artifact verification — the "is it actually there?" contract.
 *
 * Every case below is drawn from the live NVDA-addon failure, so these tests
 * double as the regression record for it:
 *   - `zip` exited 0 while matching none of its declared inputs
 *   - the declared package was a valid 22-byte zip holding ZERO entries
 *   - `fileChanges` claimed a file that was never written
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectNoOpCommand,
  isEmptyArchive,
  isArchivePath,
  resolveArtifact,
  verifyArtifacts,
} from '../../src/agents/artifact-verification.js';

/** The exact 22 bytes `zip` writes when it matches nothing. */
function emptyZipBytes(): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  // disk numbers (0,0), entries on disk (0), total entries (0), sizes 0, comment 0
  return eocd;
}

/** A structurally valid zip claiming ONE central-directory entry. */
function nonEmptyZipBytes(): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  return eocd;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'artifact-verify-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isEmptyArchive', () => {
  it('detects the empty archive that was reported as a finished package', () => {
    const file = join(dir, 'kuttaaddon.nvda-addon');
    writeFileSync(file, emptyZipBytes());
    expect(isEmptyArchive(file)).toBe(true);
  });

  it('does not flag an archive that holds entries', () => {
    const file = join(dir, 'real.zip');
    writeFileSync(file, nonEmptyZipBytes());
    expect(isEmptyArchive(file)).toBe(false);
  });

  it('returns false for a file too small to be a zip, rather than guessing', () => {
    const file = join(dir, 'tiny.zip');
    writeFileSync(file, Buffer.from('PK'));
    expect(isEmptyArchive(file)).toBe(false);
  });

  it('returns false for a missing file', () => {
    expect(isEmptyArchive(join(dir, 'nope.zip'))).toBe(false);
  });

  it('finds the entry count when a zip comment trails the record', () => {
    const file = join(dir, 'commented.zip');
    const body = Buffer.concat([emptyZipBytes(), Buffer.from('a comment')]);
    // comment length lives at offset 20 of the EOCD
    body.writeUInt16LE(9, 20);
    writeFileSync(file, body);
    expect(isEmptyArchive(file)).toBe(true);
  });
});

describe('isArchivePath / resolveArtifact', () => {
  it('treats container extensions as archives', () => {
    expect(isArchivePath('out/kuttaaddon.nvda-addon')).toBe(true);
    expect(isArchivePath('out/bundle.zip')).toBe(true);
    expect(isArchivePath('out/manifest.ini')).toBe(false);
  });

  it('passes absolute paths through and resolves relative ones against the root', () => {
    expect(resolveArtifact('/tmp/x/y.py', '/some/root')).toBe('/tmp/x/y.py');
    expect(resolveArtifact('addon/manifest.ini', '/some/root')).toBe('/some/root/addon/manifest.ini');
  });
});

describe('verifyArtifacts', () => {
  it('reports a declared file that was never written as missing', () => {
    // The live case: fileChanges said installTasks.py was "created".
    const check = verifyArtifacts(['installTasks.py'], dir);
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual(['installTasks.py']);
    expect(check.reason).toContain('not on disk');
  });

  it('reports a valid but EMPTY archive as empty, not as fine', () => {
    const name = 'kuttaaddon.nvda-addon';
    writeFileSync(join(dir, name), emptyZipBytes());
    const check = verifyArtifacts([name], dir);
    expect(check.ok).toBe(false);
    expect(check.empty).toEqual([name]);
    expect(check.reason).toContain('produced empty');
  });

  it('reports a zero-byte file as empty', () => {
    writeFileSync(join(dir, 'nothing.py'), '');
    const check = verifyArtifacts(['nothing.py'], dir);
    expect(check.ok).toBe(false);
    expect(check.empty).toEqual(['nothing.py']);
  });

  it('accepts a zero-byte file when the caller declared it empty on purpose', () => {
    // The add-on plan asks for "an empty installTasks.py" — that must pass.
    writeFileSync(join(dir, 'installTasks.py'), '');
    expect(verifyArtifacts(['installTasks.py'], dir, { allowEmpty: ['installTasks.py'] }).ok).toBe(true);
  });

  it('passes when every declared artifact exists with content', () => {
    mkdirSync(join(dir, 'globalPlugins'), { recursive: true });
    writeFileSync(join(dir, 'globalPlugins', 'kutta_addon.py'), 'class GlobalPlugin: pass\n');
    writeFileSync(join(dir, 'real.zip'), nonEmptyZipBytes());
    const check = verifyArtifacts(['globalPlugins/kutta_addon.py', 'real.zip'], dir);
    expect(check.ok).toBe(true);
    expect(check.reason).toBeUndefined();
  });

  it('ignores blank entries rather than failing on them', () => {
    expect(verifyArtifacts(['', '   '], dir).ok).toBe(true);
  });
});

describe('detectNoOpCommand', () => {
  it('catches the exact line the live run produced next to exit code 0', () => {
    const stdout = 'zip warning: name not matched: manifest.ini\nzip warning: name not matched: installTasks.py';
    const reason = detectNoOpCommand('zip -r kuttaaddon.nvda-addon manifest.ini installTasks.py globalPlugins/', stdout, '');
    expect(reason).toBeTruthy();
    expect(reason).toContain('matched none of its declared inputs');
  });

  it('does not judge a command that is not a producer', () => {
    // A grep that finds nothing prints nothing and exits 1 — never a no-op call.
    expect(detectNoOpCommand('grep -r foo src/', '', '')).toBeNull();
    // Nor should ordinary output be mistaken for one.
    expect(detectNoOpCommand('cat notes.txt', 'nothing to do', '')).toBeNull();
  });

  it('stays silent when the archive was genuinely built', () => {
    expect(detectNoOpCommand('zip -r out.zip src/', '  adding: src/a.ts (deflated 40%)', '')).toBeNull();
  });

  it('recognises a producer invoked after other shell segments', () => {
    const reason = detectNoOpCommand('cd /tmp && zip -r a.zip b/', '', 'zip error: Nothing to do! (a.zip)');
    expect(reason).toBeTruthy();
  });

  it('recognises git with nothing to commit', () => {
    const reason = detectNoOpCommand('git commit -m "x"', 'nothing to commit, working tree clean', '');
    expect(reason).toContain('nothing to commit');
  });

  it('returns null for an empty command', () => {
    expect(detectNoOpCommand('', '', '')).toBeNull();
  });
});
