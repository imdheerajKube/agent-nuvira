/**
 * Release preflight — the checks that must run BEFORE anything irreversible.
 *
 * The failure this closes: a live release bumped, committed, tagged and pushed
 * `v3.3.2`, and only then discovered it could not publish. A release has exactly
 * one cheap moment — before phase 1 — and these tests pin what is checked, what
 * blocks, and (just as important) what is reported as UNANSWERED rather than
 * quietly counted as passing.
 *
 * `execSync` is stubbed per-command, so these are hermetic: no npm registry, no
 * network, no git repository required.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CommandRunner,
  checkGitState,
  checkReleaseCredentials,
  checkVersionPublished,
  formatPreflight,
  readReleaseTarget,
  runReleasePreflight,
} from '../../src/agents/release-preflight.js';
import type { PublishVerification } from '../../src/agents/credential-store.js';

/** Both tokens confirmed live. */
const VERIFIED: PublishVerification = {
  npm: { checked: true, ok: true, detail: 'authenticated as acme' },
  git: { checked: true, ok: true, detail: 'authenticated as acme' },
};

/**
 * The credential probe these tests inject. A preflight test must never reach the
 * network (the real default asks npm and GitHub about whatever token the machine
 * happens to hold).
 */
const verified = async (): Promise<PublishVerification> => VERIFIED;

interface Stub {
  ok: boolean;
  out: string;
}

/** Commands the tests configure, keyed by the exact command string. */
let stubs: Record<string, Stub>;

/**
 * The injected runner. Any command the test did not configure FAILS with a
 * pointed message instead of silently reaching the real machine — an
 * unconfigured command in a preflight test means the check under test does
 * something the test did not expect, which must not be mistaken for "it ran".
 */
const runner: CommandRunner = (command) => {
  const entry = stubs[command];
  if (!entry) return { ok: false, output: `stub: unconfigured command: ${command}` };
  return { ok: entry.ok, output: entry.out };
};

beforeEach(() => {
  stubs = {};
});

describe('release preflight — is this version already published?', () => {
  it('blocks definitively when the version already exists — the run would be pointless', () => {
    stubs['npm view "agent-nuvira@3.3.2" version'] = { ok: true, out: '3.3.2' };
    const check = checkVersionPublished('agent-nuvira', '3.3.2', runner);
    expect(check.status).toBe('block');
    expect(check.definitive).toBe(true);
    expect(check.detail).toContain('ALREADY published');
  });

  it('passes definitively when the registry says it does not exist', () => {
    stubs['npm view "agent-nuvira@3.3.2" version'] = { ok: false, out: 'npm error code E404' };
    const check = checkVersionPublished('agent-nuvira', '3.3.2', runner);
    expect(check.status).toBe('ok');
    expect(check.definitive).toBe(true);
  });

  it('reports an UNANSWERED question as a warning, never as a pass', () => {
    stubs['npm view "agent-nuvira@3.3.2" version'] = { ok: false, out: 'fetch failed: ENOTFOUND' };
    const check = checkVersionPublished('agent-nuvira', '3.3.2', runner);
    expect(check.status).toBe('warn');
    expect(check.definitive).toBe(false);
    expect(check.detail).toContain('could not check');
  });
});

describe('release preflight — git state', () => {
  const configureCleanRepo = (): void => {
    stubs['git rev-parse --is-inside-work-tree'] = { ok: true, out: 'true' };
    stubs['git remote'] = { ok: true, out: 'origin' };
    stubs['git tag -l "v3.3.2"'] = { ok: true, out: '' };
    stubs['git ls-remote --tags origin "refs/tags/v3.3.2"'] = { ok: true, out: '' };
    stubs['git status --porcelain'] = { ok: true, out: '' };
  };

  it('passes when the remote is there and the tag is free', () => {
    configureCleanRepo();
    const checks = checkGitState('3.3.2', process.cwd(), runner);
    expect(checks.every((c) => c.status === 'ok')).toBe(true);
  });

  it('blocks when the release tag already exists on the remote', () => {
    configureCleanRepo();
    stubs['git ls-remote --tags origin "refs/tags/v3.3.2"'] = {
      ok: true,
      out: 'abc123\trefs/tags/v3.3.2',
    };
    const checks = checkGitState('3.3.2', process.cwd(), runner);
    const tag = checks.find((c) => c.name === 'release tag')!;
    expect(tag.status).toBe('block');
    expect(tag.definitive).toBe(true);
    expect(tag.detail).toContain('on the remote');
  });

  it('does not claim the tag is free when the remote could not be asked', () => {
    configureCleanRepo();
    stubs['git ls-remote --tags origin "refs/tags/v3.3.2"'] = { ok: false, out: 'Could not resolve host' };
    const tag = checkGitState('3.3.2', process.cwd(), runner).find((c) => c.name === 'release tag')!;
    expect(tag.status).toBe('warn');
    expect(tag.definitive).toBe(false);
  });

  it('blocks outside a git repository, and with no remote', () => {
    stubs['git rev-parse --is-inside-work-tree'] = { ok: false, out: 'fatal: not a git repository' };
    expect(checkGitState('3.3.2', process.cwd(), runner)[0].status).toBe('block');

    configureCleanRepo();
    stubs['git remote'] = { ok: true, out: '' };
    expect(checkGitState('3.3.2', process.cwd(), runner).find((c) => c.name === 'git remote')!.status).toBe('block');
  });
});

describe('release preflight — is the token still live?', () => {
  it('BLOCKS on a token the service rejected — presence was never the question', () => {
    const checks = checkReleaseCredentials({
      npm: { checked: true, ok: false, detail: 'token rejected (401)' },
      git: { checked: true, ok: true, detail: 'authenticated as acme' },
    });
    const npm = checks.find((c) => c.name === 'npm credential')!;
    expect(npm.status).toBe('block');
    expect(npm.definitive).toBe(true);
    expect(npm.detail).toContain('token rejected (401)');
    expect(npm.detail).toContain('npm publish');
    expect(npm.detail).toContain('Refresh it');
    // The git token is reported SEPARATELY, as its own measured pass — one
    // verdict per credential, never a single merged "credentials ok".
    expect(checks.find((c) => c.name === 'git credential')!.status).toBe('ok');
  });

  it('never puts the secret in the check — only the service wording', () => {
    const [check] = checkReleaseCredentials({
      npm: { checked: true, ok: false, detail: 'token rejected (401)' },
      git: { checked: false, ok: false, detail: 'no git credentials' },
    });
    expect(check!.detail).not.toMatch(/npm_[A-Za-z0-9]{4,}/);
    expect(check!.detail.length).toBeLessThan(300);
  });

  it('WARNS, never blocks, when the service could not be asked — unknown is not a verdict', () => {
    const checks = checkReleaseCredentials({
      npm: { checked: false, ok: false, detail: 'could not reach https://registry.npmjs.org: fetch failed' },
      git: { checked: true, ok: true, detail: 'authenticated as acme' },
    });
    expect(checks[0]!.status).toBe('warn');
    expect(checks[0]!.definitive).toBe(false);
    expect(checks[0]!.detail).toContain('could not verify');
  });

  it('emits no check when nothing is configured — no phase, no risk to report', () => {
    expect(
      checkReleaseCredentials({
        npm: { checked: false, ok: false, detail: 'no npm token' },
        git: { checked: false, ok: false, detail: 'no git credentials' },
      }),
    ).toEqual([]);
  });

  it('reports a confirmed token as a measured pass', () => {
    const checks = checkReleaseCredentials(VERIFIED);
    expect(checks.map((c) => c.status)).toEqual(['ok', 'ok']);
    expect(checks.every((c) => c.definitive)).toBe(true);
  });
});

describe('release preflight — the whole run', () => {
  let dir: string;
  const writePkg = (pkg: Record<string, unknown>): void => {
    dir = mkdtempSync(join(tmpdir(), 'nuvira-preflight-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf-8');
  };

  const configureCleanRepo = (): void => {
    stubs['git rev-parse --is-inside-work-tree'] = { ok: true, out: 'true' };
    stubs['git remote'] = { ok: true, out: 'origin' };
    stubs['git tag -l "v1.0.1"'] = { ok: true, out: '' };
    stubs['git ls-remote --tags origin "refs/tags/v1.0.1"'] = { ok: true, out: '' };
    stubs['git status --porcelain'] = { ok: true, out: '' };
    stubs['npm view "demo@1.0.1" version'] = { ok: false, out: 'npm error code E404' };
  };

  it('reads the release target from package.json', () => {
    writePkg({ name: 'demo', version: '1.0.0' });
    expect(readReleaseTarget(dir)).toMatchObject({ name: 'demo', version: '1.0.0' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('blocks a private package — npm refuses to publish it', async () => {
    writePkg({ name: 'demo', version: '1.0.0', private: true });
    const result = await runReleasePreflight({ cwd: dir, targetVersion: '1.0.1', runner, probeCredentials: verified });
    expect(result.blocked).toBe(true);
    expect(result.summary).toContain('private');
    rmSync(dir, { recursive: true, force: true });
  });

  it('blocks a missing manifest instead of guessing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'nuvira-preflight-empty-'));
    const result = await runReleasePreflight({ cwd: empty, targetVersion: '1.0.1', runner, probeCredentials: verified });
    expect(result.blocked).toBe(true);
    rmSync(empty, { recursive: true, force: true });
  });

  it('passes a clean, unpublished, tag-free release', async () => {
    writePkg({ name: 'demo', version: '1.0.0' });
    configureCleanRepo();
    const result = await runReleasePreflight({ cwd: dir, targetVersion: '1.0.1', runner, probeCredentials: verified });
    expect(result.blocked).toBe(false);
    expect(result.summary).toContain('not published yet');
    expect(result.summary).toContain('npm credential');
    rmSync(dir, { recursive: true, force: true });
  });

  it('checks the route ONLY when a phase will call a model', async () => {
    writePkg({ name: 'demo', version: '1.0.0' });
    configureCleanRepo();

    // No model phases: no route check at all — a decorative check is still a lie.
    const withoutModel = await runReleasePreflight({ cwd: dir, targetVersion: '1.0.1', runner, probeCredentials: verified });
    expect(withoutModel.checks.some((c) => c.name === 'provider×model')).toBe(false);

    // A model phase: the probe result is reported as measured.
    const blockedByRoute = await runReleasePreflight({
      cwd: dir,
      targetVersion: '1.0.1',
      runner,
      probeCredentials: verified,
      needsModel: true,
      probeModel: async () => ({ ok: false, checked: true, detail: 'groq/ghost-model does not exist on groq' }),
    });
    expect(blockedByRoute.blocked).toBe(true);
    expect(blockedByRoute.summary).toContain('ghost-model');

    // A probe that could NOT answer warns and does not block the release.
    const unverified = await runReleasePreflight({
      cwd: dir,
      targetVersion: '1.0.1',
      runner,
      probeCredentials: verified,
      needsModel: true,
      probeModel: async () => ({ ok: false, checked: false, detail: 'offline' }),
    });
    expect(unverified.blocked).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * REGRESSION — the 3.5.8 release. A revoked npm token was present in three
   * places, so "is a credential set?" said yes; the whole suite and build ran
   * (about five minutes) and only `npm publish` itself returned `E401`. The
   * store could already tell a DEAD token from a missing one — nothing on the
   * release path ever asked it. This is that ask.
   */
  it('verifies the credential BEFORE phase 1, and stops on a rejected token', async () => {
    writePkg({ name: 'demo', version: '1.0.0' });
    configureCleanRepo();

    let probes = 0;
    const result = await runReleasePreflight({
      cwd: dir,
      targetVersion: '1.0.1',
      runner,
      probeCredentials: async () => {
        probes++;
        return {
          npm: { checked: true, ok: false, detail: 'token rejected (401)' },
          git: { checked: true, ok: true, detail: 'authenticated as acme' },
        };
      },
    });

    // Asked exactly once, and the answer decided the run.
    expect(probes).toBe(1);
    expect(result.blocked).toBe(true);
    expect(result.summary).toContain('npm credential');
    expect(result.summary).toContain('token rejected (401)');
    expect(result.summary).toContain('stopped before anything irreversible');
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns, and does not block, when the credential could not be checked', async () => {
    writePkg({ name: 'demo', version: '1.0.0' });
    configureCleanRepo();
    const result = await runReleasePreflight({
      cwd: dir,
      targetVersion: '1.0.1',
      runner,
      probeCredentials: async () => ({
        npm: { checked: false, ok: false, detail: 'could not reach the registry: fetch failed' },
        git: { checked: false, ok: false, detail: 'no git credentials' },
      }),
    });
    expect(result.blocked).toBe(false);
    expect(result.summary).toContain('could not verify the token');
    expect(result.summary).toContain('not claims that it passed');
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats a probe that THROWS as unanswerable, never as a rejection', async () => {
    writePkg({ name: 'demo', version: '1.0.0' });
    configureCleanRepo();
    const result = await runReleasePreflight({
      cwd: dir,
      targetVersion: '1.0.1',
      runner,
      probeCredentials: async () => {
        throw new Error('boom');
      },
    });
    expect(result.blocked).toBe(false);
    const credentials = result.checks.find((c) => c.name === 'release credentials')!;
    expect(credentials.status).toBe('warn');
    expect(credentials.detail).toContain('boom');
    rmSync(dir, { recursive: true, force: true });
  });

  it('says in the summary that warnings were NOT verified', async () => {
    writePkg({ name: 'demo', version: '1.0.0' });
    configureCleanRepo();
    stubs['npm view "demo@1.0.1" version'] = { ok: false, out: 'fetch failed' };
    const result = await runReleasePreflight({ cwd: dir, targetVersion: '1.0.1', runner, probeCredentials: verified });
    expect(result.blocked).toBe(false);
    expect(result.summary).toContain('not claims that it passed');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('formatPreflight', () => {
  it('marks each check and states the blocker consequence', () => {
    const out = formatPreflight({
      blocked: true,
      checks: [
        { name: 'git remote', status: 'ok', detail: 'origin', definitive: true },
        { name: 'release tag', status: 'block', detail: 'v1.0.1 taken', definitive: true },
      ],
    });
    expect(out).toContain('✅ git remote: origin');
    expect(out).toContain('❌ release tag: v1.0.1 taken');
    expect(out).toContain('stopped before anything irreversible');
  });
});
