/**
 * Unit tests for PackageAgent — npm version/build/publish pipeline.
 *
 * Coverage focus (cross-platform):
 * - generateChangelog must NOT use bash-only `$(...)` command substitution
 *   (fails on Windows cmd.exe) — the base ref is resolved with two separate
 *   execSync calls: latest tag, falling back to the root commit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PackageAgent } from '../../src/agents/agents/package-agent.js';
import type { AgentContext } from '../../src/agents/agent.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// The credential store is mocked so the publish gate's verdict is the test's to
// choose — no real .npmrc, no registry, no network.
let mockVerify: () => Promise<{
  npm: { checked: boolean; ok: boolean; detail: string };
  git: { checked: boolean; ok: boolean; detail: string };
}>;
vi.mock('../../src/agents/credential-store.js', () => ({
  CredentialStore: class {
    initialize(): void {}
    async verify() {
      return mockVerify();
    }
  },
}));

import { execSync } from 'node:child_process';
const mockExecSync = vi.mocked(execSync);

function createContext(goal: string): AgentContext {
  return {
    goal,
    taskPlan: [],
    metadata: {},
    contextFiles: [],
    artifacts: [],
    workingDirectory: '/tmp/proj',
  } as AgentContext;
}

describe('PackageAgent generateChangelog (cross-platform)', () => {
  let agent: PackageAgent;

  beforeEach(() => {
    agent = new PackageAgent();
    mockExecSync.mockReset();
  });

  afterEach(() => {
    mockExecSync.mockReset();
  });

  it('resolves the base ref with two separate execSync calls, never `$()` substitution', async () => {
    // git describe fails (no tags) -> git rev-list succeeds (root commit).
    mockExecSync
      .mockImplementationOnce(() => {
        throw new Error('Command failed: git describe --tags --abbrev=0\nfatal: No names found');
      })
      .mockReturnValueOnce('abc1234\n'); // rev-list --max-parents=0 HEAD
    mockExecSync.mockReturnValueOnce('* fix: login\n'); // git log between base..HEAD

    const callLLM = vi.fn().mockResolvedValue('## [Unreleased]\n- fix login');

    const result = await agent.execute(
      createContext('Generate changelog'),
      callLLM,
    );

    // All three executed commands must be plain git invocations — no `$(`.
    for (const call of mockExecSync.mock.calls) {
      const cmd = String(call[0]);
      expect(cmd).not.toContain('$(');
      expect(cmd).not.toContain('2>/dev/null');
    }

    // The log range uses the root-commit fallback.
    expect(mockExecSync.mock.calls[2][0]).toContain('abc1234..HEAD');
    expect(result.success).toBe(true);
  });

  it('uses the latest tag when git describe succeeds', async () => {
    mockExecSync.mockReturnValueOnce('v1.60.0\n'); // describe --tags
    mockExecSync.mockReturnValueOnce('* feat: x\n'); // git log

    const callLLM = vi.fn().mockResolvedValue('## [Unreleased]\n- feat x');

    const result = await agent.execute(
      createContext('changelog'),
      callLLM,
    );

    expect(mockExecSync.mock.calls[1][0]).toContain('v1.60.0..HEAD');
    expect(result.success).toBe(true);
  });

  it('does not call execSync when the goal is not a changelog request', async () => {
    const callLLM = vi.fn();
    const result = await agent.execute(createContext('bump patch version'), callLLM);
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });
});

/**
 * The second publish path. `release-preflight` guards `nuvira publish` and the
 * `publish` tool; this agent reaches `npm publish` on its own, and it used to
 * gate on the token being PRESENT — which is how v3.5.8 built for five minutes
 * on top of a revoked token.
 */
describe('PackageAgent publish gate — the token must be LIVE, not merely present', () => {
  const originalToken = process.env.NPM_TOKEN;

  beforeEach(() => {
    // `checkNpmAuth()` must pass so these tests exercise the VERDICT, not the
    // presence check that already existed.
    process.env.NPM_TOKEN = 'npm_presentbutdead0001';
    mockExecSync.mockReset();
    mockExecSync.mockReturnValue('');
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = originalToken;
  });

  const rejected = async () => ({
    npm: { checked: true, ok: false, detail: 'token rejected (401)' },
    git: { checked: false, ok: false, detail: 'no git credentials' },
  });
  const accepted = async () => ({
    npm: { checked: true, ok: true, detail: 'authenticated as acme' },
    git: { checked: false, ok: false, detail: 'no git credentials' },
  });

  it('refuses to run `npm publish` when the registry rejected the token', async () => {
    mockVerify = rejected;
    const result = await new PackageAgent().execute(createContext('Publish to npm'), vi.fn());

    expect(result.success).toBe(false);
    expect(result.summary).toContain('token was rejected');
    expect(result.error).toContain('token rejected (401)');
    expect(result.error).toContain('Refresh it');
    // The point of gating: nothing was attempted, so nothing failed halfway.
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('publishes when the registry confirms the token', async () => {
    mockVerify = accepted;
    const result = await new PackageAgent().execute(createContext('Publish to npm'), vi.fn());
    expect(result.success).toBe(true);
    expect(mockExecSync.mock.calls.map((c) => String(c[0])).join(' | ')).toContain('npm publish');
  });

  it('proceeds when the token could NOT be verified — unanswerable is not a rejection', async () => {
    mockVerify = async () => ({
      npm: { checked: false, ok: false, detail: 'could not reach the registry: fetch failed' },
      git: { checked: false, ok: false, detail: 'no git credentials' },
    });
    const result = await new PackageAgent().execute(createContext('Publish to npm'), vi.fn());
    expect(result.success).toBe(true);
    expect(mockExecSync.mock.calls.map((c) => String(c[0])).join(' | ')).toContain('npm publish');
  });

  it('fails a full release BEFORE the version bump when the token is dead', async () => {
    mockVerify = rejected;
    const result = await new PackageAgent().execute(createContext('full release pipeline'), vi.fn());
    expect(result.success).toBe(false);
    // No bump, no build: the whole pipeline stops at the cheap moment.
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});
