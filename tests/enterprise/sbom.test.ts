/**
 * SBOM generator tests — P6 M6.6.
 *
 * Covers buildSbom (CycloneDX shape, purl, hashes, licenses, deterministic
 * ordering + reproducible pins), verifySbom (drift/tamper detection, license
 * flagging), and the lockfile parsing edge cases.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSbom,
  verifySbom,
  parseSbom,
  readLockfile,
  licenseToString,
  purlFor,
  spdxFirstId,
} from '../../src/enterprise/sbom.js';

/** Build a hermetic project dir with a synthetic package-lock.json. */
function makeProject(packages: Record<string, Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'buff-sbom-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'agent-nuvira', version: '1.59.3' }));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { name: 'agent-nuvira', version: '1.59.3' }, ...packages },
  }));
  return dir;
}


describe('buildSbom', () => {
  it('emits a valid CycloneDX 1.5 document with root + all locked packages', () => {
    const dir = makeProject({
      'node_modules/commander': { version: '12.1.0', license: 'MIT', integrity: 'sha512-abc123', resolved: 'https://registry.npmjs.org/commander/-/commander-12.1.0.tgz' },
      'node_modules/inquirer': { version: '9.2.0', license: 'MIT' },
    });
    try {
      const bom = buildSbom(dir);
      expect(bom.bomFormat).toBe('CycloneDX');
      expect(bom.specVersion).toBe('1.5');
      expect(bom.metadata.component).toMatchObject({ name: 'agent-nuvira', version: '1.59.3' });
      // 2 library components (commander + inquirer), no root self-entry.
      expect(bom.components).toHaveLength(2);
      const names = bom.components.map((c) => c.name).sort();
      expect(names).toEqual(['commander', 'inquirer']);
      const commander = bom.components.find((c) => c.name === 'commander')!;
      expect(commander.purl).toBe('pkg:npm/commander@12.1.0');
      expect(commander.hashes?.[0]).toEqual({ alg: 'SHA-512', content: 'abc123' });
      expect(commander.licenses?.[0]).toEqual({ expression: 'MIT' });
      expect(commander.supplier?.name).toBe('registry.npmjs.org');
      expect(commander.externalReferences?.[0].url).toContain('commander-12.1.0.tgz');
      // Root component is the dependency graph root.
      expect(bom.dependencies[0].ref).toBe('pkg:npm/agent-nuvira@1.59.3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sorts components deterministically (diffable BOMs)', () => {
    const dir = makeProject({
      'node_modules/zzz': { version: '1.0.0' },
      'node_modules/aaa': { version: '2.0.0' },
    });
    try {
      const names = buildSbom(dir).components.map((c) => c.name);
      expect(names).toEqual(['aaa', 'zzz']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reproducible pins produce identical serial + timestamp', () => {
    const dir = makeProject({ 'node_modules/commander': { version: '1.0.0' } });
    try {
      const a = buildSbom(dir, { pinSerial: true, pinTimestamp: '2026-01-01T00:00:00.000Z' });
      const b = buildSbom(dir, { pinSerial: true, pinTimestamp: '2026-01-01T00:00:00.000Z' });
      expect(a.serialNumber).toBe(b.serialNumber);
      expect(a.metadata.timestamp).toBe(b.metadata.timestamp);
      // Different lockfile content → different pinned serial (hash-of-lock).
      const dir2 = makeProject({ 'node_modules/commander': { version: '2.0.0' } });
      try {
        const c = buildSbom(dir2, { pinSerial: true, pinTimestamp: '2026-01-01T00:00:00.000Z' });
        expect(c.serialNumber).not.toBe(a.serialNumber);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unknown licenses are recorded as unknown (not dropped)', () => {
    const dir = makeProject({
      'node_modules/no-license': { version: '1.0.0' },
      'node_modules/array-license': { version: '2.0.0', license: ['MIT', 'Apache-2.0'] },
    });
    try {
      const bom = buildSbom(dir);
      const noLicense = bom.components.find((c) => c.name === 'no-license')!;
      // Missing license → no licenses array at all (nothing to claim).
      expect(noLicense.licenses).toBeUndefined();
      // verifySbom flags it for review.
      const lock = readLockfile(dir)!;
      const result = verifySbom(bom.components, lock);
      expect(result.flaggedLicenses.some((f) => f.name.startsWith('no-license@'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verifySbom', () => {
  it('a BOM built from the same lockfile verifies clean', () => {
    const dir = makeProject({
      'node_modules/commander': { version: '12.1.0', license: 'MIT', integrity: 'sha512-abc123' },
      'node_modules/inquirer': { version: '9.2.0', license: 'MIT' },
    });
    try {
      const lock = readLockfile(dir)!;
      const bom = buildSbom(dir);
      const result = verifySbom(bom.components, lock);
      expect(result.ok).toBe(true);
      expect(result.added).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.changed).toEqual([]);
      expect(result.totalComponents).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects a package ADDED to the lockfile after the BOM was written', () => {
    const dir = makeProject({
      'node_modules/commander': { version: '12.1.0', license: 'MIT' },
    });
    try {
      const bom = buildSbom(dir); // BOM: only commander
      const lock = readLockfile(dir)!;
      lock['node_modules/new-dep'] = { version: '1.0.0', integrity: 'sha512-newdep' };
      const result = verifySbom(bom.components, lock);
      expect(result.ok).toBe(false);
      expect(result.added).toContain('new-dep@1.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects a REMOVED package (BOM lists something no longer installed)', () => {
    const dir = makeProject({
      'node_modules/commander': { version: '12.1.0', license: 'MIT' },
    });
    try {
      const bom = buildSbom(dir);
      const lock = readLockfile(dir)!;
      delete lock['node_modules/commander'];
      const result = verifySbom(bom.components, lock);
      expect(result.ok).toBe(false);
      expect(result.removed).toContain('commander@12.1.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects a version/integrity CHANGE (tampered or upgraded dependency)', () => {
    const dir = makeProject({
      'node_modules/commander': { version: '12.1.0', license: 'MIT', integrity: 'sha512-oldhash' },
    });
    try {
      const bom = buildSbom(dir);
      const lock = readLockfile(dir)!;
      lock['node_modules/commander'] = { version: '12.2.0', license: 'MIT', integrity: 'sha512-newhash' };
      const result = verifySbom(bom.components, lock);
      expect(result.ok).toBe(false);
      // Same name, different version → deterministically reported as CHANGED
      // (the same-name-different-version path lands in `changed`, not `added`).
      expect(result.changed.some((c) => c.name === 'commander')).toBe(true);
      expect(result.added.some((a) => a.startsWith('commander@'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags copyleft and unknown licenses for compliance review', () => {
    const dir = makeProject({
      'node_modules/gpl-dep': { version: '1.0.0', license: 'GPL-3.0' },
      'node_modules/mit-dep': { version: '1.0.0', license: 'MIT' },
      'node_modules/agpl-dep': { version: '1.0.0', license: 'AGPL-3.0' },
      'node_modules/no-license': { version: '1.0.0' },
    });
    try {
      const lock = readLockfile(dir)!;
      const bom = buildSbom(dir);
      const result = verifySbom(bom.components, lock, { flagLicenses: true });
      const flagged = result.flaggedLicenses.map((f) => f.license);
      expect(flagged).toContain('GPL-3.0');
      expect(flagged).toContain('AGPL-3.0');
      expect(flagged).toContain('unknown');
      expect(flagged).not.toContain('MIT');
      expect(result.ok).toBe(true); // license flags ≠ drift
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseSbom / helpers', () => {
  it('parseSbom round-trips a serialized document and rejects non-SBOM JSON', () => {
    const dir = makeProject({ 'node_modules/commander': { version: '1.0.0' } });
    try {
      const bom = buildSbom(dir);
      const parsed = parseSbom(JSON.stringify(bom));
      expect(parsed.bomFormat).toBe('CycloneDX');
      expect(parsed.components).toHaveLength(1);
      expect(() => parseSbom('{"not":"a bom"}')).toThrow(/CycloneDX/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('purlFor percent-encodes scoped names', () => {
    expect(purlFor('@types/node', '22.0.0')).toBe('pkg:npm/%40types%2Fnode@22.0.0');
    expect(purlFor('commander', '1.0.0')).toBe('pkg:npm/commander@1.0.0');
  });

  it('licenseToString handles string + object forms', () => {
    expect(licenseToString('MIT')).toBe('MIT');
    expect(licenseToString({ type: 'Apache-2.0' })).toBe('Apache-2.0');
    expect(licenseToString(undefined)).toBe('unknown');
  });

  it('spdxFirstId extracts the first license id from an expression', () => {
    expect(spdxFirstId('MIT OR Apache-2.0')).toBe('MIT');
    // `-only` is part of the SPDX id — kept whole (not truncated).
    expect(spdxFirstId('GPL-3.0-only')).toBe('GPL-3.0-only');
    expect(spdxFirstId('(MIT AND ISC)')).toBe('MIT');
  });
});
