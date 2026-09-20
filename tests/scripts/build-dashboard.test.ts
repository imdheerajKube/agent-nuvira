/**
 * Tests for scripts/build-dashboard.mjs — the self-provisioning dashboard build.
 *
 * The bug this guards: the root build ended with `cd src/web-dashboard && npx
 * vite build`, which passed locally only because a leftover node_modules tree
 * existed, and failed on every clean CI checkout with
 * `Could not resolve '@vitejs/plugin-react'`. The detection + guard logic is
 * what makes a clean checkout behave like a dev machine, so it is what we pin.
 *
 * These tests exercise the pure helpers only — no installs, no network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  missingDashboardDeps,
  buildDashboardBundle,
} from '../../scripts/build-dashboard.mjs';

const REQUIRED = ['vite', '@vitejs/plugin-react', 'react'];

/** Create a fake dashboard tree with the given deps present in node_modules. */
function makeDashboard(deps: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'nuvira-dash-build-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', private: true }));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  for (const dep of deps) {
    const target = join(dir, 'node_modules', dep);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: dep }));
  }
  return dir;
}

describe('build-dashboard: missingDashboardDeps', () => {
  const created: string[] = [];

  beforeEach(() => {
    created.length = 0;
  });

  afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  });

  const track = (dir: string) => {
    created.push(dir);
    return dir;
  };

  it('reports every dep when the tree was never installed (the CI failure)', () => {
    const dir = track(mkdtempSync(join(tmpdir(), 'nuvira-dash-build-')));
    writeFileSync(join(dir, 'package.json'), '{}');
    expect(missingDashboardDeps(dir)).toEqual(REQUIRED);
  });

  it('reports nothing when the tree is fully installed', () => {
    expect(missingDashboardDeps(track(makeDashboard(REQUIRED)))).toEqual([]);
  });

  it('reports only the actually-missing dep (partial tree)', () => {
    const dir = track(makeDashboard(['vite', 'react']));
    expect(missingDashboardDeps(dir)).toEqual(['@vitejs/plugin-react']);
  });

  it('treats a hoisted root vite as NOT sufficient — only the dashboard tree counts', () => {
    // The second half of the original bug: the root tree carried a vite of a
    // different major, so `npx vite build` "worked" and produced a subtly wrong
    // bundle. An empty dashboard tree must still be reported as incomplete.
    const dir = track(makeDashboard([]));
    expect(missingDashboardDeps(dir)).toEqual(REQUIRED);
  });
});

describe('build-dashboard: failure modes', () => {
  it('fails loudly when the dashboard package is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-dash-missing-'));
    try {
      expect(() => buildDashboardBundle(dir)).toThrow(/Dashboard package not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('respects NUVIRA_SKIP_DASHBOARD_INSTALL=1 with an actionable message (air-gapped builds)', () => {
    const dir = makeDashboard(['react']); // vite + plugin-react missing
    const previous = process.env.NUVIRA_SKIP_DASHBOARD_INSTALL;
    process.env.NUVIRA_SKIP_DASHBOARD_INSTALL = '1';
    try {
      expect(() => buildDashboardBundle(dir)).toThrow(/NUVIRA_SKIP_DASHBOARD_INSTALL=1/);
      // The message must tell the user exactly how to fix it.
      expect(() => buildDashboardBundle(dir)).toThrow(/npm ci/);
    } finally {
      if (previous === undefined) delete process.env.NUVIRA_SKIP_DASHBOARD_INSTALL;
      else process.env.NUVIRA_SKIP_DASHBOARD_INSTALL = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
