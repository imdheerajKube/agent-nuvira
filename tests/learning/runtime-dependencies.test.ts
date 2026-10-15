/**
 * Runtime-dependency table tests.
 *
 * The table is the ONE source for four surfaces — the doctor rows, the `--fix`
 * installer, the prompt line the model reads, and the docs — so the invariants
 * that matter are structural: every entry can be installed on every OS it
 * supports, a present tool is never offered for install, and a missing tool that
 * has no recipe HERE is still reported rather than silently skipped.
 *
 * Every probe is injected, so nothing here spawns `which` or touches the real
 * machine; the one filesystem case uses a temp directory it creates itself.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  RUNTIME_DEPENDENCIES,
  buildRuntimeDependenciesBlock,
  dependencyInstallLines,
  dependencyPresent,
  dependencySummary,
  installCommandFor,
  installNeedsHumanInput,
  installPlan,
  linuxInstallCommand,
  missingDependencies,
  playwrightBrowserDirs,
  playwrightBrowserPresent,
  probeRuntimeDependencies,
  type DependencyProbe,
} from '../../src/learning/runtime-dependencies.js';

/** A probe with nothing installed — the fresh machine. */
const none: DependencyProbe = { binary: () => false, playwrightBrowser: () => false };

/** A probe with everything installed. */
const all: DependencyProbe = { binary: () => true, playwrightBrowser: () => true };

/** The OSes a dependency should be installable on, with its documented gaps. */
const NO_WINDOWS_RECIPE: Record<string, string> = {
  poppler: 'Poppler ships on Windows as a zip of binaries, not a package anyone can name reliably',
};

describe('the table itself', () => {
  it('has unique ids and one non-empty sentence per entry', () => {
    const ids = RUNTIME_DEPENDENCIES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of RUNTIME_DEPENDENCIES) {
      expect(d.label.length, d.id).toBeGreaterThan(1);
      expect(d.enables.length, d.id).toBeGreaterThan(40);
      expect(d.neededBy.length, d.id).toBeGreaterThan(0);
      expect(d.anyOf.length, d.id).toBeGreaterThan(0);
    }
  });

  it('can be installed on macOS and Linux — and on Windows, or says why not', () => {
    for (const d of RUNTIME_DEPENDENCIES) {
      expect(installCommandFor(d, 'darwin', () => false), d.id).toBeTruthy();
      expect(installCommandFor(d, 'linux', () => false), d.id).toBeTruthy();
      const win = installCommandFor(d, 'win32', () => false);
      if (NO_WINDOWS_RECIPE[d.id]) {
        expect(win, `${d.id} now HAS a Windows recipe — remove it from the exception list`).toBeNull();
      } else {
        expect(win, d.id).toBeTruthy();
      }
    }
  });

  it('names the tools a user would recognise as the reason', () => {
    const byId = Object.fromEntries(RUNTIME_DEPENDENCIES.map((d) => [d.id, d]));
    expect(byId.ffmpeg.neededBy).toContain('motion_render');
    expect(byId.chromium.neededBy.join(' ')).toContain('browser_');
  });

  it('sends macOS to ffmpeg-full, because the lean formula has no libass', () => {
    const ffmpeg = RUNTIME_DEPENDENCIES.find((d) => d.id === 'ffmpeg')!;
    expect(installCommandFor(ffmpeg, 'darwin')).toBe('brew install ffmpeg-full');
    expect(ffmpeg.note).toMatch(/libass/);
    expect(ffmpeg.note).toMatch(/PATH/);
  });
});

describe('presence', () => {
  it('is decided by any of the declared binaries', () => {
    const dep = RUNTIME_DEPENDENCIES.find((d) => d.id === 'edge-tts')!;
    expect(dependencyPresent(dep, none)).toBe(false);
    expect(dependencyPresent(dep, { binary: (n) => n === 'piper', playwrightBrowser: () => false })).toBe(true);
  });

  it('uses the non-PATH probe for the chromium bundle (a folder, not a binary)', () => {
    const dep = RUNTIME_DEPENDENCIES.find((d) => d.id === 'chromium')!;
    expect(dependencyPresent(dep, none)).toBe(false);
    expect(dependencyPresent(dep, { binary: () => false, playwrightBrowser: () => true })).toBe(true);
  });

  it('treats a throwing probe as not present, never as an error', () => {
    const dep = RUNTIME_DEPENDENCIES.find((d) => d.id === 'ffmpeg')!;
    const throwing: DependencyProbe = {
      binary: () => {
        throw new Error('boom');
      },
      playwrightBrowser: () => {
        throw new Error('boom');
      },
    };
    expect(dependencyPresent(dep, throwing)).toBe(false);
  });

  it('finds a playwright chromium bundle in the cache it is told to look at', () => {
    const base = mkdtempSync(join(tmpdir(), 'pw-browsers-'));
    try {
      const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: base };
      expect(playwrightBrowserPresent(env)).toBe(false); // empty dir
      mkdirSync(join(base, 'chromium-1234'));
      expect(playwrightBrowserPresent(env)).toBe(true);
      expect(playwrightBrowserDirs(env)).toEqual([base]);
      // Browsers inside node_modules are deliberately not crawled.
      expect(playwrightBrowserPresent({ ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' })).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('install commands', () => {
  it('assembles a Linux package install with the manager the machine actually has', () => {
    expect(linuxInstallCommand('ffmpeg', (n) => n === 'dnf')).toBe('sudo dnf install -y ffmpeg');
    // apk takes `add`, not `install -y` — a shared template used to produce
    // "sudo apk add install -y ffmpeg", which apk rejects.
    expect(linuxInstallCommand('ffmpeg', (n) => n === 'apk')).toBe('sudo apk add --no-cache ffmpeg');
    // No known manager → apt-get, so the user still gets a command.
    expect(linuxInstallCommand('ffmpeg', () => false)).toContain('apt-get install -y ffmpeg');
    expect(linuxInstallCommand('ffmpeg', (n) => n === 'apt-get')).toContain('apt-get update');
  });

  it('uses one command on every OS for the playwright bundle', () => {
    const dep = RUNTIME_DEPENDENCIES.find((d) => d.id === 'chromium')!;
    for (const os of ['darwin', 'linux', 'win32'] as const) {
      expect(installCommandFor(dep, os)).toBe('npx playwright install chromium');
    }
  });

  it('knows which installs cannot be driven unattended', () => {
    expect(installNeedsHumanInput('sudo apt-get update && sudo apt-get install -y ffmpeg')).toBe(true);
    expect(installNeedsHumanInput('brew install ffmpeg-full')).toBe(false);
    expect(installNeedsHumanInput('xcode-select --install')).toBe(true);
  });
});

describe('the plan a user is shown, and the plan `--fix` runs', () => {
  it('offers only what is missing', () => {
    const statuses = probeRuntimeDependencies(none, 'darwin', () => true);
    const plan = installPlan(statuses);
    expect(plan.map((s) => s.dependency.id)).toEqual(
      RUNTIME_DEPENDENCIES.map((d) => d.id).filter((id) => installCommandFor(
        RUNTIME_DEPENDENCIES.find((d) => d.id === id)!, 'darwin', () => true,
      ) !== null),
    );
    // Nothing installed → nothing to skip.
    expect(installPlan(probeRuntimeDependencies(all, 'darwin', () => true))).toEqual([]);
  });

  it('can be narrowed to the recommended tools', () => {
    const statuses = probeRuntimeDependencies(none, 'darwin', () => true);
    const recommended = installPlan(statuses, { includeOptional: false });
    expect(recommended.length).toBeGreaterThan(0);
    expect(recommended.every((s) => s.dependency.need === 'recommended')).toBe(true);
    expect(recommended.length).toBeLessThan(installPlan(statuses).length);
  });

  it('marks a sudo install as needing a human, before anyone tries to run it', () => {
    const statuses = probeRuntimeDependencies(none, 'linux', (n) => n === 'apt-get');
    const ffmpeg = installPlan(statuses).find((s) => s.dependency.id === 'ffmpeg')!;
    expect(ffmpeg.command).toContain('sudo apt-get');
    expect(ffmpeg.needsHumanInput).toBe(true);
  });

  it('still REPORTS a missing tool that has no recipe on this platform', () => {
    const statuses = probeRuntimeDependencies(none, 'win32', () => true);
    const poppler = statuses.find((s) => s.dependency.id === 'poppler')!;
    expect(poppler.present).toBe(false);
    expect(poppler.installCommand).toBeNull();
    // Not runnable, so not in the plan…
    expect(installPlan(statuses).some((s) => s.dependency.id === 'poppler')).toBe(false);
    // …but never silently dropped: the line says where to look instead.
    const line = dependencyInstallLines(statuses).find((l) => l.includes('Poppler'))!;
    expect(line).toContain('docs/DEPENDENCIES.md');
  });

  it('summarises the machine in one countable line', () => {
    const mixed: DependencyProbe = {
      binary: (n) => n === 'ffmpeg',
      playwrightBrowser: () => false,
    };
    const statuses = probeRuntimeDependencies(mixed, 'darwin', () => true);
    expect(missingDependencies(statuses).length).toBe(RUNTIME_DEPENDENCIES.length - 1);
    expect(dependencySummary(statuses)).toBe(`1 of ${RUNTIME_DEPENDENCIES.length} optional tools installed`);
  });
});

/**
 * docs/DEPENDENCIES.md is the page a user is pointed at, and the source cites it
 * by name. It must therefore say what the TABLE says: every tool, and for each
 * one the exact command for macOS and Linux. A doc that drifts from the
 * declaration is the failure this feature exists to remove — one list, not two.
 */
describe('docs/DEPENDENCIES.md — the page matches the declaration', () => {
  const page = readFileSync(resolve(__dirname, '..', '..', 'docs', 'DEPENDENCIES.md'), 'utf-8');

  it('names every dependency and its macOS + Linux install command', () => {
    for (const dep of RUNTIME_DEPENDENCIES) {
      expect(page, `${dep.id} is missing from the docs`).toContain(dep.id === 'chromium' ? 'Chromium' : dep.label.split(' (')[0]);
      for (const os of ['darwin', 'linux'] as const) {
        const cmd = installCommandFor(dep, os, (n) => n === 'apt-get');
        if (!cmd) continue;
        // The page may wrap a long Windows/macOS command in a table cell, so a
        // command containing " | " (the ollama install script) is matched by its
        // escaped form.
        expect(page, `${dep.id} (${os}): ${cmd} is not on the page`).toContain(cmd.replace(/\|/g, '\\|'));
      }
    }
  });

  it('tells the reader how to check and how to install', () => {
    expect(page).toContain('nuvira doctor');
    expect(page).toContain('nuvira doctor --fix');
    // The caveat that bit for real: the lean ffmpeg formula has no libass.
    expect(page).toMatch(/ffmpeg-full/);
    expect(page).toMatch(/libass/);
  });
});

describe('the prompt line the model reads', () => {
  it('is EMPTY when everything is installed (no tokens spent on a non-issue)', () => {
    expect(buildRuntimeDependenciesBlock(probeRuntimeDependencies(all, 'darwin', () => true))).toBe('');
  });

  it('names what is missing and forbids reporting a skipped feature as done', () => {
    const block = buildRuntimeDependenciesBlock(probeRuntimeDependencies(none, 'darwin', () => true));
    expect(block).toContain('## Optional tools NOT installed on this machine');
    expect(block).toContain('ffmpeg');
    expect(block).toMatch(/SKIPPED/);
    expect(block).toContain('nuvira doctor --fix');
  });

  it('stays bounded on a machine with nothing installed', () => {
    const block = buildRuntimeDependenciesBlock(probeRuntimeDependencies(none, 'darwin', () => true), 3);
    expect(block).toContain('+');
    expect(block.split('\n').length).toBeLessThan(8);
  });
});
