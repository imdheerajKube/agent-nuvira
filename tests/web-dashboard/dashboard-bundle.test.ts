/**
 * The committed dashboard bundle must be the one the source builds.
 *
 * WHY THIS EXISTS. `src/web-dashboard/public/` is a committed build artifact
 * because the dashboard server serves it directly from the repo (server.ts
 * resolves PUBLIC_DIR to `<repo>/src/web-dashboard/public`). Generated output
 * that is committed by hand drifts, and it drifted silently: the Subagents tab
 * was written, tested and committed while the shipped bundle had
 * `grep -c Subagents` = 0. Nothing could see it — the component suite runs the
 * SOURCE through vitest, so it passes either way.
 *
 * Three layers here, deliberately:
 *   1. the pure freshness comparison (ordering rules, no git);
 *   2. the input set — that test files are excluded and that the bundle's real
 *      reach into the root tree is found (and only that reach);
 *   3. an end-to-end pass through the real script against a throwaway git repo,
 *      which is the only way to prove the git plumbing blames the right commit.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUNDLE_OUTPUT_DIR,
  bundleInputPaths,
  bundleOutputPaths,
  compareFreshness,
  isTestFile,
  normaliseOutput,
  readBundledRepoSources,
} from '../../scripts/check-dashboard-bundle.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-dashboard-bundle.mjs');
const DASHBOARD_TREE_INSTALLED = existsSync(join(REPO_ROOT, 'src', 'web-dashboard', 'node_modules'));

// ─── 1. The comparison itself ───────────────────────────────────────────────

describe('dashboard bundle freshness — ordering rules', () => {
  it('cannot judge when either side has no commit in the available history', () => {
    // A shallow clone is the real case: actions/checkout defaults to depth 1, so
    // a path that HEAD did not touch has no reachable commit. That must be
    // "unknown", never a stale verdict the operator cannot act on.
    expect(compareFreshness('', 'abc').verdict).toBe('unknown');
    expect(compareFreshness('abc', '').verdict).toBe('unknown');
    expect(compareFreshness('', '').verdict).toBe('unknown');
  });

  it('reports a shared commit apart from freshness', () => {
    // History cannot order two changes made in one commit, so a source+rebuild
    // commit is not evidence the bundle is current. Saying "same" is honest;
    // folding it into "fresh" would claim an ordering that was never observed.
    expect(compareFreshness('abc', 'abc').verdict).toBe('same');
  });

  it('defers to the caller to order two different commits', () => {
    const verdict = compareFreshness('aaa', 'bbb');
    expect(verdict.verdict).toBe('compare');
    expect(verdict).toMatchObject({ inputCommit: 'aaa', outputCommit: 'bbb' });
  });
});

// ─── 2. What counts as an input ─────────────────────────────────────────────

describe('dashboard bundle freshness — the input set', () => {
  it('recognises test files, which are never bundle inputs', () => {
    // 28 of the 73 files in the dashboard source tree are tests. Treating them
    // as inputs makes every assertion edit look like a stale bundle.
    expect(isTestFile('src/web-dashboard/src/components/ModelsPanel.test.tsx')).toBe(true);
    expect(isTestFile('src/web-dashboard/src/components/ChatPage.spec.ts')).toBe(true);
    expect(isTestFile('src/web-dashboard/src/__tests__/helpers.ts')).toBe(true);
    expect(isTestFile('src/web-dashboard/src/components/AgentHub.tsx')).toBe(false);
  });

  it('includes the dashboard source and the config that shapes the build', () => {
    const inputs = bundleInputPaths(REPO_ROOT);
    expect(inputs).toContain('src/web-dashboard/src/components/AgentHub.tsx');
    expect(inputs).toContain('src/web-dashboard/src/main.tsx');
    expect(inputs).toContain('src/web-dashboard/vite.config.ts');
    expect(inputs).toContain('src/web-dashboard/package.json');
    // Test files must not be in the set the git query is built from.
    expect(inputs.some(isTestFile)).toBe(false);
  });

  it('takes its inputs from the bundle itself, not from a walk of the tree', () => {
    // A directory walk cannot tell a bundled module from one vite dropped, and
    // the difference is not academic: `src/web-dashboard/src/types.ts` is
    // type-only, so vite never emits it, and a comment-only edit there would
    // leave the history check permanently red — no rebuild can clear it,
    // because a rebuild would change no bytes and there would be nothing to
    // commit. The sourcemap knows which modules were really bundled, so the
    // check reads the input list out of it instead.
    const bundled = readBundledRepoSources(REPO_ROOT);
    expect(bundled.size).toBeGreaterThan(0);
    expect(bundled.has('src/web-dashboard/src/components/AgentHub.tsx')).toBe(true);
    expect(bundled.has('src/web-dashboard/src/types.ts')).toBe(false);
    expect([...bundled].some(isTestFile)).toBe(false);
    // …and every bundled module is in the set the git query runs against.
    const inputs = new Set(bundleInputPaths(REPO_ROOT));
    for (const file of bundled) expect(inputs.has(file)).toBe(true);
  });

  it('finds the root-tree files the bundle really contains, and only those', () => {
    // The dashboard re-exports through shims; those root files are inputs. Both
    // are read out of the committed sourcemap, because the alternative (scanning
    // relative imports) also picks up `admin-auth.ts`'s imports of
    // `config/paths.ts` and `enterprise/rbac.ts` — and `admin-auth.ts` is NOT
    // bundled, so flagging its dependencies would report a stale bundle every
    // time a root RBAC or paths file changed.
    const escaping = [...readBundledRepoSources(REPO_ROOT)].filter((f) => !f.startsWith('src/web-dashboard/'));
    expect(escaping.sort()).toEqual(['src/utils/format.ts', 'src/utils/mask.ts']);

    const inputs = bundleInputPaths(REPO_ROOT);
    expect(inputs).toContain('src/utils/format.ts');
    expect(inputs).toContain('src/utils/mask.ts');
    expect(inputs).not.toContain('src/enterprise/rbac.ts');
    expect(inputs).not.toContain('src/config/paths.ts');
  });

  it('treats the served bundle as the output side', () => {
    const outputs = bundleOutputPaths(REPO_ROOT);
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs.every((f) => f.startsWith(`${BUNDLE_OUTPUT_DIR}/`))).toBe(true);
    expect(outputs.some((f) => f.endsWith('.js'))).toBe(true);
    expect(outputs.some((f) => f.endsWith('.css'))).toBe(true);
  });
});

// ─── 3. How the output side is compared ────────────────────────────────────

describe('dashboard bundle freshness — comparing the build', () => {
  it('compares a sourcemap on its contents, not on where the packages sat', () => {
    // MEASURED against a real second checkout: with node_modules as a symlink
    // (pnpm, npm link) vite writes every dependency as an escape to the store —
    // `../../../../../../../Users/…/node_modules/react/index.js` — where a real
    // directory gives `../../node_modules/react/index.js`. Same source, same
    // bytes of JS, different map. A check that compared those paths would fail a
    // current bundle for a package manager this repo never forbids.
    const map = (sources: string[], content: string) =>
      Buffer.from(JSON.stringify({ version: 3, sources, sourcesContent: [content], mappings: 'AAAA' }));

    const committed = map(['../../node_modules/react/index.js', '../src/main.tsx'], 'CODE');
    const symlinked = map(['../../../../../home/dev/store/react/index.js', '../src/main.tsx'], 'CODE');
    const normalise = (contents: Buffer) => normaliseOutput('assets/app.js.map', contents);
    expect(normalise(committed).equals(normalise(symlinked))).toBe(true);

    // The content and the mapping are NOT excused: a changed module, or a module
    // that went missing, still fails.
    expect(normalise(committed).equals(normalise(map(['../../node_modules/react/index.js', '../src/main.tsx'], 'OTHER CODE')))).toBe(false);
    expect(normalise(committed).equals(normalise(map(['../src/main.tsx'], 'CODE')))).toBe(false);

    // Only sourcemaps are normalised — a JS bundle is compared as bytes.
    const js = Buffer.from('bundle');
    expect(normaliseOutput('assets/app.js', js).equals(js)).toBe(true);
    expect(normaliseOutput('assets/app.js', js).equals(Buffer.from('BUNDLE'))).toBe(false);
  });
});

// ─── 4. The guard end to end, against a throwaway repo ──────────────────────

/** Build a minimal checkout with a dashboard tree, and run the real script. */
function fixtureRepo() {
  const dir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'nuvira-bundle-fixture-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'src', 'web-dashboard', 'src'), { recursive: true });
  mkdirSync(join(dir, 'src', 'web-dashboard', 'public', 'assets'), { recursive: true });
  // The bundle side needs a sourcemap for readBundledRepoSources; an empty
  // sources list is enough here (the fixture has no root-tree shims).
  writeFileSync(join(dir, 'src', 'web-dashboard', 'public', 'assets', 'app.js.map'), '{"sources":[]}');
  writeFileSync(join(dir, 'src', 'web-dashboard', 'public', 'index.html'), '<html></html>');
  return { dir, git };
}

function commit(dir: string, message: string) {
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', message], {
    cwd: dir,
    stdio: 'ignore',
  });
}

function runCheck(dir: string): { code: number; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, '--root', dir], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('dashboard bundle freshness — the guard itself', () => {
  it('fails when the bundle is older than its source, and names the commit', () => {
    const { dir } = fixtureRepo();
    try {
      writeFileSync(join(dir, 'src', 'web-dashboard', 'public', 'assets', 'app.js'), 'BUNDLE-V1');
      writeFileSync(join(dir, 'src', 'web-dashboard', 'src', 'main.tsx'), 'SOURCE-V1');
      commit(dir, 'ship the bundle and the source together');
      expect(runCheck(dir).code).toBe(0);

      // The drift this guard exists for: source moves on, the bundle does not.
      writeFileSync(join(dir, 'src', 'web-dashboard', 'src', 'main.tsx'), 'SOURCE-V2');
      commit(dir, 'add a tab the bundle does not contain');

      const stale = runCheck(dir);
      expect(stale.code).toBe(1);
      expect(stale.stderr).toContain('OLDER than its source');
      // The report has to name the source commit, or the operator cannot tell
      // which change went unbuilt.
      expect(stale.stderr).toContain('add a tab the bundle does not contain');

      // Rebuilding clears it.
      writeFileSync(join(dir, 'src', 'web-dashboard', 'public', 'assets', 'app.js'), 'BUNDLE-V2');
      commit(dir, 'rebuild the bundle');
      expect(runCheck(dir).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the bundle is missing entirely', () => {
    const { dir } = fixtureRepo();
    try {
      rmSync(join(dir, 'src', 'web-dashboard', 'public'), { recursive: true, force: true });
      const result = runCheck(dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('missing entirely');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cannot judge outside a git repository rather than guessing', () => {
    // The verdict must be "unknown" (exit 2), never a stale failure: a tarball
    // download or an exported source tree has no history to order.
    const dir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'nuvira-bundle-nogit-'));
    try {
      mkdirSync(join(dir, 'src', 'web-dashboard', 'public', 'assets'), { recursive: true });
      writeFileSync(join(dir, 'src', 'web-dashboard', 'public', 'assets', 'app.js'), 'X');
      const result = runCheck(dir);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('cannot order');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── 5. The byte comparison against the real artifact ───────────────────────

describe('dashboard bundle freshness — committed bytes', () => {
  // Needs the dashboard tree installed, which the root suite does not require
  // (it is a separate package with its own lockfile, installed by the CI step
  // that runs the dashboard tests). Skipping keeps the root suite runnable
  // everywhere; CI runs the real thing.
  it.skipIf(!DASHBOARD_TREE_INSTALLED)('matches a fresh build of the current source', () => {
    let stdout = '';
    let stderr = '';
    let status = 0;
    try {
      stdout = execFileSync(process.execPath, [SCRIPT, '--rebuild', '--json'], {
        encoding: 'utf-8',
        cwd: REPO_ROOT,
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      status = e.status ?? 1;
      stdout = e.stdout ?? '';
      stderr = e.stderr ?? '';
    }
    // Parse first so a non-zero exit still reports WHY, instead of surfacing as
    // a bare "Command failed".
    expect(stdout, `check exited ${status}: ${stderr}`).toContain('"mode": "rebuild"');
    const parsed = JSON.parse(stdout) as { ok: boolean; mode: string; message: string };
    expect(parsed.mode).toBe('rebuild');
    expect(parsed.ok, parsed.message).toBe(true);
  }, 180_000);
});
