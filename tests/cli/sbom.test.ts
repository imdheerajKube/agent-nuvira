/**
 * SbomCommand — unit tests for `buff sbom` (P6 M6.6).
 *
 * Runs the real Commander command against a hermetic temp project with a
 * synthetic package-lock.json, capturing stdout via console spies:
 * 1. `buff sbom` prints a valid CycloneDX document to stdout
 * 2. `buff sbom --out <path>` writes a file
 * 3. `buff sbom --out` then `--verify` passes for an unchanged lockfile
 * 4. `--verify` fails (exit 1) when a dependency is added after the SBOM
 * 5. `buff sbom --licenses` flags copyleft/unknown licenses
 * 6. `--verify` with a missing sbom.json errors with exit 1
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SbomCommand } from '../../src/cli/sbom.js';
import { parseSbom } from '../../src/enterprise/sbom.js';

let dir: string;
let origCwd: string;

function writeProject(lock: Record<string, unknown>): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'agent-nuvira', version: '1.59.3' }));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: lock }));
}

function runSbom(args: string[]): string {
  process.exitCode = 0;
  new SbomCommand().create().parse(args, { from: 'user' });
  return vi.mocked(console.log).mock.calls
    .map((c) => c.map((v) => String(v)).join(' '))
    .join('\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buff-sbom-cli-'));
  origCwd = process.cwd();
  process.chdir(dir);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(origCwd);
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('SbomCommand generate', () => {
  it('prints a valid CycloneDX SBOM to stdout', () => {
    writeProject({
      '': { name: 'agent-nuvira', version: '1.59.3' },
      'node_modules/commander': { version: '12.1.0', license: 'MIT', integrity: 'sha512-abc123' },
    });
    const out = runSbom(['sbom']);
    const parsed = parseSbom(out);
    expect(parsed.bomFormat).toBe('CycloneDX');
    expect(parsed.specVersion).toBe('1.5');
    expect(parsed.components).toHaveLength(1);
    expect(parsed.components[0].name).toBe('commander');
  });

  it('--out writes a file and reports the component count', () => {
    writeProject({
      '': { name: 'agent-nuvira', version: '1.59.3' },
      'node_modules/commander': { version: '12.1.0', license: 'MIT' },
      'node_modules/inquirer': { version: '9.2.0', license: 'MIT' },
    });
    const out = runSbom(['sbom', '--out', 'sbom.json']);
    expect(existsSync(join(dir, 'sbom.json'))).toBe(true);
    expect(out).toContain('2 components');
    const parsed = parseSbom(readFileSync(join(dir, 'sbom.json'), 'utf-8'));
    expect(parsed.components).toHaveLength(2);
  });

  it('errors (exit 1) when no package-lock.json exists', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    runSbom(['sbom']);
    expect(process.exitCode).toBe(1);
  });
});

describe('SbomCommand verify', () => {
  it('passes (exit 0) when the lockfile is unchanged since the SBOM was written', () => {
    writeProject({
      '': { name: 'agent-nuvira', version: '1.59.3' },
      'node_modules/commander': { version: '12.1.0', license: 'MIT' },
    });
    runSbom(['sbom', '--out', 'sbom.json']);
    process.exitCode = 0;
    const out = runSbom(['sbom', '--verify', '--sbom', 'sbom.json']);
    expect(process.exitCode).toBe(0);
    expect(out).toContain('matches package-lock.json');
  });

  it('fails (exit 1) when a dependency was added after the SBOM (drift)', () => {
    writeProject({
      '': { name: 'agent-nuvira', version: '1.59.3' },
      'node_modules/commander': { version: '12.1.0', license: 'MIT' },
    });
    runSbom(['sbom', '--out', 'sbom.json']);
    // Lockfile gains a dependency after the BOM was written.
    writeProject({
      '': { name: 'agent-nuvira', version: '1.59.3' },
      'node_modules/commander': { version: '12.1.0', license: 'MIT' },
      'node_modules/evil-dep': { version: '9.9.9', license: 'GPL-3.0' },
    });
    process.exitCode = 0;
    const out = runSbom(['sbom', '--verify', '--sbom', 'sbom.json']);
    expect(process.exitCode).toBe(1);
    expect(out).toContain('evil-dep@9.9.9');
  });

  it('fails (exit 1) when the SBOM file is missing', () => {
    writeProject({ '': { name: 'agent-nuvira', version: '1.59.3' } });
    runSbom(['sbom', '--verify', '--sbom', 'nope.json']);
    expect(process.exitCode).toBe(1);
  });

  it('fails (exit 1) when the SBOM file is not valid CycloneDX', () => {
    writeProject({ '': { name: 'agent-nuvira', version: '1.59.3' } });
    writeFileSync(join(dir, 'bad.json'), '{"not":"a bom"}');
    runSbom(['sbom', '--verify', '--sbom', 'bad.json']);
    expect(process.exitCode).toBe(1);
  });
});

describe('SbomCommand licenses', () => {
  it('flags copyleft and unknown licenses (exit 1 when any flagged)', () => {
    writeProject({
      '': { name: 'agent-nuvira', version: '1.59.3' },
      'node_modules/mit-dep': { version: '1.0.0', license: 'MIT' },
      'node_modules/gpl-dep': { version: '1.0.0', license: 'GPL-3.0' },
      'node_modules/no-license': { version: '1.0.0' },
    });
    const out = runSbom(['sbom', '--licenses']);
    expect(out).toContain('GPL-3.0');
    expect(out).toContain('unknown');
    expect(out).not.toContain('MIT');
    expect(process.exitCode).toBe(1);
  });

  it('clean licenses → exit 0', () => {
    writeProject({
      '': { name: 'agent-nuvira', version: '1.59.3' },
      'node_modules/mit-dep': { version: '1.0.0', license: 'MIT' },
      'node_modules/apache-dep': { version: '1.0.0', license: 'Apache-2.0' },
    });
    runSbom(['sbom', '--licenses']);
    expect(process.exitCode).toBe(0);
  });
});
