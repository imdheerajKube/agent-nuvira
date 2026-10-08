/**
 * Project interpreter canonicalization + environment guard tests.
 *
 * Drawn from the live Aukat_check failure: a project virtualenv existed, but a
 * build ran against the system interpreter (missing PyQt6), produced a broken
 * app, and still reported success. These tests pin the two rules that prevent
 * it — canonical discovery/pinning, and the pre-run refusal of (a) installs
 * outside the project env and (b) builds against an interpreter lacking the
 * declared dependencies.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

import {
  findProjectVenv,
  getPinnedProjectVenv,
  clearPinnedProjectVenv,
  applyProjectEnvironment,
  ensureProjectVenv,
  projectRequirementNames,
  isPythonToolchainCommand,
  isPythonInstallCommand,
  targetsForeignInterpreter,
  guardCommandEnvironment,
  clearEnvironmentProbeCache,
} from '../../src/utils/project-env.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'project-env-'));
  dirs.push(d);
  return d;
}

/** Create a minimal (non-functional but structurally valid) venv at `dir`. */
function makeVenv(root: string, name = '.venv'): string {
  const venv = join(root, name);
  mkdirSync(join(venv, 'bin'), { recursive: true });
  writeFileSync(join(venv, 'pyvenv.cfg'), 'home = /usr/bin\nversion = 3.14.0\n');
  writeFileSync(join(venv, 'bin', 'python'), '');
  return venv;
}

beforeEach(() => {
  clearPinnedProjectVenv();
  clearEnvironmentProbeCache();
  delete process.env.NUVIRA_ENV_GUARD;
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('findProjectVenv — discovery', () => {
  it('finds a .venv and returns its interpreter + bin dir', () => {
    const root = tmp();
    const venv = makeVenv(root, '.venv');
    const found = findProjectVenv(root);
    expect(found?.dir).toBe(venv);
    expect(found?.python).toBe(join(venv, 'bin', 'python'));
    expect(found?.binDir).toBe(join(venv, 'bin'));
  });

  it('prefers .venv over a legacy venv when both exist', () => {
    const root = tmp();
    makeVenv(root, 'venv');
    const dot = makeVenv(root, '.venv');
    expect(findProjectVenv(root)?.dir).toBe(dot);
  });

  it('walks up to a parent project venv', () => {
    const root = tmp();
    const venv = makeVenv(root, '.venv');
    const nested = join(root, 'src', 'pkg');
    mkdirSync(nested, { recursive: true });
    expect(findProjectVenv(nested)?.dir).toBe(venv);
  });

  it('returns null when there is no venv', () => {
    expect(findProjectVenv(tmp())).toBeNull();
  });
});

describe('getPinnedProjectVenv — pin once for the run', () => {
  it('returns the same interpreter on repeated calls (pinned)', () => {
    const root = tmp();
    makeVenv(root, '.venv');
    const a = getPinnedProjectVenv(root);
    const b = getPinnedProjectVenv(root);
    expect(a).not.toBeNull();
    expect(b?.dir).toBe(a?.dir);
  });

  it('re-discovers after a clear (a venv created mid-run)', () => {
    const root = tmp();
    expect(getPinnedProjectVenv(root)).toBeNull();
    clearPinnedProjectVenv();
    makeVenv(root, '.venv');
    expect(getPinnedProjectVenv(root)?.dir).toBe(join(root, '.venv'));
  });
});

describe('applyProjectEnvironment — PATH + VIRTUAL_ENV', () => {
  it("prepends the venv bin dir and sets VIRTUAL_ENV", () => {
    const root = tmp();
    const venv = findProjectVenv((makeVenv(root, '.venv'), root));
    const env = applyProjectEnvironment({ PATH: '/usr/bin' }, venv);
    expect(env.PATH?.startsWith(join(venv!.dir, 'bin'))).toBe(true);
    expect(env.VIRTUAL_ENV).toBe(venv!.dir);
    expect(env.PYTHONHOME).toBeUndefined();
  });

  it('is a no-op when there is no venv', () => {
    const env = applyProjectEnvironment({ PATH: '/usr/bin' }, null);
    expect(env.PATH).toBe('/usr/bin');
  });
});

describe('projectRequirementNames — declared deps', () => {
  it('reads names, skipping specs, extras, comments and flags', () => {
    const root = tmp();
    writeFileSync(
      join(root, 'requirements.txt'),
      [
        '# comment',
        'pynput',
        'pyperclip',
        'requests>=2.0,<3',
        'PyQt6==6.11.0',
        'some-pkg[extra] ; python_version > "3.8"',
        '-r other.txt',
        '--index-url https://example.com',
        '',
      ].join('\n'),
    );
    expect(projectRequirementNames(root).sort()).toEqual(
      ['PyQt6', 'pyperclip', 'pynput', 'requests', 'some-pkg'].sort(),
    );
  });

  it('reads pyproject.toml dependencies as a fallback', () => {
    const root = tmp();
    writeFileSync(join(root, 'pyproject.toml'), '[project]\ndependencies = [\n  "fastapi>=0.1",\n  "uvicorn",\n]\n');
    expect(projectRequirementNames(root).sort()).toEqual(['fastapi', 'uvicorn']);
  });

  it('reads poetry [tool.poetry.dependencies] keys', () => {
    const root = tmp();
    writeFileSync(
      join(root, 'pyproject.toml'),
      [
        '[tool.poetry]',
        'name = "demo"',
        'version = "0.1.0"',
        '',
        '[tool.poetry.dependencies]',
        'python = "^3.11"',
        'requests = "^2.31"',
        'PyQt6 = { version = "^6.6", optional = true }',
        '',
        '[tool.poetry.group.dev.dependencies]',
        'pytest = "^8.0"',
        '',
        '[build-system]',
        'requires = ["poetry-core"]',
      ].join('\n'),
    );
    // `python` is the interpreter, not a distribution — it must be skipped.
    expect(projectRequirementNames(root).sort()).toEqual(['PyQt6', 'pytest', 'requests'].sort());
  });

  it('reads a Pipfile [packages] and [dev-packages]', () => {
    const root = tmp();
    writeFileSync(
      join(root, 'Pipfile'),
      [
        '[[source]]',
        'url = "https://pypi.org/simple"',
        '',
        '[packages]',
        'requests = "*"',
        'flask = ">=2"',
        'python_version = "3.11"',
        '',
        '[dev-packages]',
        'pytest = "*"',
        '',
        '[requires]',
        'python_version = "3.11"',
      ].join('\n'),
    );
    expect(projectRequirementNames(root).sort()).toEqual(['flask', 'pytest', 'requests'].sort());
  });

  it('falls back to Pipfile.lock when no Pipfile is present', () => {
    const root = tmp();
    writeFileSync(
      join(root, 'Pipfile.lock'),
      JSON.stringify({ default: { requests: { version: '==2.31.0' } }, develop: { pytest: { version: '==8.0.0' } } }),
    );
    expect(projectRequirementNames(root).sort()).toEqual(['requests', 'pytest'].sort());
  });

  it('returns [] when nothing is declared', () => {
    expect(projectRequirementNames(tmp())).toEqual([]);
  });
});

describe('ensureProjectVenv — C3 install sandbox', () => {
  function hasPython(): boolean {
    try {
      execSync('python3 --version', { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  it('returns the already-pinned venv without creating a second one', () => {
    const root = tmp();
    const venvDir = makeVenv(root, '.venv');
    clearPinnedProjectVenv();
    const venv = ensureProjectVenv(root);
    expect(venv?.dir).toBe(venvDir);
  });

  it.skipIf(!hasPython())('creates and pins a real .venv when none exists', () => {
    const root = tmp();
    clearPinnedProjectVenv();
    const venv = ensureProjectVenv(root);
    expect(venv).not.toBeNull();
    expect(venv?.dir).toBe(join(root, '.venv'));
    // The layout is platform-specific (`Scripts/python.exe` on Windows,
    // `bin/python` on POSIX) — assert on the interpreter the module discovered,
    // not a hardcoded POSIX path.
    expect(existsSync(venv!.python)).toBe(true);
    // Pinned for the rest of the run — a follow-up lookup is the same object.
    expect(getPinnedProjectVenv(root)?.dir).toBe(venv?.dir);
    // `python -m venv` shells out to the real interpreter and is genuinely slower
    // on Windows CI than the 15s default (observed timing out there); the work is
    // real, so give it room rather than weakening what is asserted.
  }, 60_000);
});

describe('command classification', () => {
  it('detects the Python toolchain', () => {
    for (const c of ['python3 main.py', 'python -m PyInstaller x.spec', 'pip install x', 'pyinstaller x.spec', 'pytest -q']) {
      expect(isPythonToolchainCommand(c), c).toBe(true);
    }
    expect(isPythonToolchainCommand('npm install')).toBe(false);
  });

  it('detects installs (and not plain runs)', () => {
    for (const c of ['pip install -r requirements.txt', 'pip3 install x', 'python3 -m pip install x', 'uv pip install x']) {
      expect(isPythonInstallCommand(c), c).toBe(true);
    }
    expect(isPythonInstallCommand('python3 main.py')).toBe(false);
  });

  it('flags absolute interpreters outside the venv, not bare ones', () => {
    const root = tmp();
    const venv = findProjectVenv((makeVenv(root, '.venv'), root));
    expect(targetsForeignInterpreter('/usr/local/bin/python3 -m pip install x', venv)).toBe(true);
    expect(targetsForeignInterpreter('pip install --user x', venv)).toBe(true);
    expect(targetsForeignInterpreter('python3 -m pip install x', venv)).toBe(false);
  });
});

describe('guardCommandEnvironment — the live failure, prevented', () => {
  it('is not applicable to non-Python commands', () => {
    expect(guardCommandEnvironment('npm install', tmp()).action).toBe('not-applicable');
  });

  it('refuses an install that names an interpreter outside the venv', () => {
    const root = tmp();
    makeVenv(root, '.venv');
    writeFileSync(join(root, 'requirements.txt'), 'PyQt6\n');
    const v = guardCommandEnvironment('/usr/local/bin/python3 -m pip install PyQt6', root);
    expect(v.action).toBe('refuse');
    expect(v.action === 'refuse' && v.hint).toMatch(/virtualenv|pip install/);
  });

  it('refuses a project install when no venv exists and provisioning fails', () => {
    const root = tmp();
    writeFileSync(join(root, 'requirements.txt'), 'PyQt6\n');
    // A provisioner that cannot create a venv (no base interpreter / failure).
    const v = guardCommandEnvironment('pip install -r requirements.txt', root, { provision: () => null });
    expect(v.action).toBe('refuse');
  });

  it('sandboxes an install by provisioning a project .venv when none exists (C3)', () => {
    const root = tmp();
    writeFileSync(join(root, 'requirements.txt'), 'PyQt6\n');
    const provision = (dir: string) => {
      const venvDir = makeVenv(dir, '.venv');
      return { dir: venvDir, python: join(venvDir, 'bin', 'python'), binDir: join(venvDir, 'bin') };
    };
    const v = guardCommandEnvironment('pip install -r requirements.txt', root, { provision });
    expect(v.action).toBe('proceed');
    // The install is redirected into the fresh project venv — never the
    // interpreter on PATH (the machine's global Python).
    expect(v.action === 'proceed' && v.venv?.dir).toBe(join(root, '.venv'));
    expect(v.action === 'proceed' && v.note).toContain('sandboxed');
  });

  it('does not provision a venv for a RUN command (only installs need a sandbox)', () => {
    const root = tmp();
    writeFileSync(join(root, 'requirements.txt'), 'PyQt6\n');
    let provisioned = false;
    const provision = () => { provisioned = true; return null; };
    // No deps installed in the PATH interpreter is not asserted here; the point
    // is simply that a bare run never creates a venv as a side effect.
    guardCommandEnvironment('python3 main.py', root, { probe: () => [], provision });
    expect(provisioned).toBe(false);
  });

  it('proceeds with a pinned venv on an ordinary install', () => {
    const root = tmp();
    makeVenv(root, '.venv');
    writeFileSync(join(root, 'requirements.txt'), 'PyQt6\n');
    const v = guardCommandEnvironment('pip install -r requirements.txt', root);
    expect(v.action).toBe('proceed');
    expect(v.action === 'proceed' && v.venv?.dir).toBe(join(root, '.venv'));
  });

  it('refuses a BUILD when the interpreter lacks a declared dependency', () => {
    const root = tmp();
    makeVenv(root, '.venv');
    writeFileSync(join(root, 'requirements.txt'), 'PyQt6\npynput\n');
    const probe = (): string[] => ['PyQt6'];
    const v = guardCommandEnvironment('pyinstaller AukatCheck.spec', root, { probe });
    expect(v.action).toBe('refuse');
    expect(v.action === 'refuse' && v.reason).toContain('PyQt6');
  });

  it('proceeds with a build when the interpreter has every dependency', () => {
    const root = tmp();
    makeVenv(root, '.venv');
    writeFileSync(join(root, 'requirements.txt'), 'PyQt6\n');
    const v = guardCommandEnvironment('python3 main.py', root, { probe: () => [] });
    expect(v.action).toBe('proceed');
  });

  it('honours NUVIRA_ENV_GUARD=off', () => {
    const root = tmp();
    writeFileSync(join(root, 'requirements.txt'), 'PyQt6\n');
    process.env.NUVIRA_ENV_GUARD = 'off';
    expect(guardCommandEnvironment('pip install -r requirements.txt', root).action).toBe('not-applicable');
  });
});
