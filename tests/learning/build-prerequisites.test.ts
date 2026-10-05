/**
 * Workstream D2 — build prerequisite manifest.
 *
 * The manifest is DATA: error-output signatures → the exact fix, plus Tauri
 * pre-flight checks. These tests pin the four real blockers from the macOS
 * build and one row per ecosystem family.
 */

import { describe, it, expect } from 'vitest';

import {
  checkProjectPrerequisites,
  formatPreflightFindings,
  matchPrerequisiteSignatures,
  prerequisiteTakeoverInstruction,
  PREREQUISITE_RULES,
  type PrereqFs,
} from '../../src/learning/build-prerequisites.js';

/** Build a fake project fs from a path → content map (dirs implied by exists). */
function fakeFs(files: Record<string, string>): PrereqFs {
  const exists = (rel: string): boolean =>
    files[rel] !== undefined || Object.keys(files).some((k) => k.startsWith(`${rel}/`));
  return {
    exists,
    readFile: (rel) => files[rel],
  };
}

describe('matchPrerequisiteSignatures — the real error strings', () => {
  it('matches the four macOS-build blockers', () => {
    expect(matchPrerequisiteSignatures('error: The OUT_DIR environment variable is not set')[0]?.id).toBe(
      'rust-build-script-missing',
    );
    expect(
      matchPrerequisiteSignatures('the package `app` does not contain this feature: custom-protocol')[0]?.id,
    ).toBe('cargo-feature-missing-custom-protocol');
    expect(matchPrerequisiteSignatures('failed to read icon src-tauri/icons/icon.png')[0]?.id).toBe(
      'icon-file-missing',
    );
    expect(
      matchPrerequisiteSignatures('failed to select a version for the requirement `tauri-build`')[0]?.id,
    ).toBe('tauri-build-version-mismatch');
  });

  it('matches one row per ecosystem (broad manifest, not Tauri-only)', () => {
    expect(matchPrerequisiteSignatures('missing go.sum entry for module')[0]?.ecosystem).toBe('go');
    expect(matchPrerequisiteSignatures('error NETSDK1004: Assets file not found')[0]?.ecosystem).toBe(
      'dotnet',
    );
    expect(
      matchPrerequisiteSignatures("ENOENT: no such file or directory, open './vite.config.ts'")[0]?.ecosystem,
    ).toBe('node');
    expect(
      matchPrerequisiteSignatures('error: metadata-generation-failed')[0]?.ecosystem,
    ).toBe('python');
    expect(matchPrerequisiteSignatures('No CMAKE_CXX_COMPILER could be found')[0]?.ecosystem).toBe(
      'cmake',
    );
  });

  it('returns nothing for an unrelated failure', () => {
    expect(matchPrerequisiteSignatures('tests failed: expected 1 to be 2')).toEqual([]);
    expect(matchPrerequisiteSignatures('')).toEqual([]);
  });

  it('every rule has at least one signature (data stays well-formed)', () => {
    for (const r of PREREQUISITE_RULES) {
      expect(r.signature.length).toBeGreaterThan(0);
      expect(r.fix.length).toBeGreaterThan(0);
    }
  });
});

describe('prerequisiteTakeoverInstruction', () => {
  it('names the prerequisite and the fix, and forbids the "cannot" answer', () => {
    const rules = matchPrerequisiteSignatures('the package does not contain this feature: custom-protocol');
    const text = prerequisiteTakeoverInstruction(rules);
    expect(text).toContain('custom-protocol');
    expect(text).toContain('Do NOT retry the same command unchanged');
    expect(text).toContain('[features]');
  });

  it('is empty for no rules', () => {
    expect(prerequisiteTakeoverInstruction([])).toBe('');
  });
});

describe('checkProjectPrerequisites — Tauri pre-flight', () => {
  const cleanCargo = [
    '[dependencies]',
    'tauri = { version = "1.5.0" }',
    '',
    '[build-dependencies]',
    'tauri-build = { version = "1.5.0" }',
    '',
    '[features]',
    'custom-protocol = []',
    'default = ["custom-protocol"]',
  ].join('\n');

  it('passes a clean Tauri tree', () => {
    const fs = fakeFs({
      'src-tauri/Cargo.toml': cleanCargo,
      'src-tauri/build.rs': 'fn main() { tauri_build::build() }',
      'src-tauri/tauri.conf.json': JSON.stringify({ bundle: { icon: ['src-tauri/icons/icon.png'] } }),
      'src-tauri/icons/icon.png': 'PNG',
    });
    expect(checkProjectPrerequisites(fs)).toEqual([]);
  });

  it('flags a missing build.rs with the exact fix', () => {
    const fs = fakeFs({
      'src-tauri/Cargo.toml': cleanCargo,
      'src-tauri/tauri.conf.json': JSON.stringify({ bundle: { icon: [] } }),
    });
    const findings = checkProjectPrerequisites(fs);
    expect(findings.map((f) => f.id)).toContain('rust-build-script-missing');
    expect(findings.find((f) => f.id === 'rust-build-script-missing')?.fix).toContain('tauri_build::build()');
  });

  it('flags a tauri-build / tauri major-version mismatch', () => {
    const fs = fakeFs({
      'src-tauri/Cargo.toml': cleanCargo.replace('tauri-build = { version = "1.5.0" }', 'tauri-build = { version = "2" }'),
      'src-tauri/build.rs': '',
      'src-tauri/tauri.conf.json': JSON.stringify({ bundle: { icon: [] } }),
    });
    expect(checkProjectPrerequisites(fs).map((f) => f.id)).toContain('tauri-build-version-mismatch');
  });

  it('flags the missing custom-protocol feature', () => {
    const fs = fakeFs({
      'src-tauri/Cargo.toml': [
        '[dependencies]',
        'tauri = { version = "1.5.0" }',
        '[build-dependencies]',
        'tauri-build = { version = "1.5.0" }',
      ].join('\n'),
      'src-tauri/build.rs': '',
      'src-tauri/tauri.conf.json': JSON.stringify({ bundle: { icon: [] } }),
    });
    expect(checkProjectPrerequisites(fs).map((f) => f.id)).toContain(
      'cargo-feature-missing-custom-protocol',
    );
  });

  it('flags a bundle.icon that points at a missing file', () => {
    const fs = fakeFs({
      'src-tauri/Cargo.toml': cleanCargo,
      'src-tauri/build.rs': '',
      'src-tauri/tauri.conf.json': JSON.stringify({ bundle: { icon: ['src-tauri/icons/icon.png'] } }),
    });
    expect(checkProjectPrerequisites(fs).map((f) => f.id)).toContain('icon-file-missing');
  });

  it('is a no-op for a non-Tauri project', () => {
    const fs = fakeFs({ 'package.json': '{}', 'tsconfig.json': '{}' });
    expect(checkProjectPrerequisites(fs)).toEqual([]);
  });
});

describe('formatPreflightFindings', () => {
  it('is empty when clean and lists fixes otherwise', () => {
    expect(formatPreflightFindings([])).toBe('');
    const text = formatPreflightFindings([
      { id: 'x', ecosystem: 'rust', description: 'build.rs missing', fix: 'create it' },
    ]);
    expect(text).toContain('build.rs missing');
    expect(text).toContain('create it');
  });
});
