/**
 * E3c — publish tool tests (hermetic: CredentialStore + Orchestrator mocked).
 *
 * The `publish` tool is the credentialed, irreversible E3c task tool: it must
 * NEVER prompt interactively (creds from env/detected config only), report
 * missing credentials back so the model can ask_user for tokens, and run the
 * SAME phase list as `nuvira publish` (buildPublishPhases — one source).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable fixture the mocked CredentialStore class reads — vitest allows
// hoisted factories to reference top-level names starting with `mock`.
let mockStore: {
  git: { token?: string; sshKeyPath?: string; remoteUrl?: string };
  npm: { token?: string; configured?: boolean };
  canPush: boolean;
  canPublish: boolean;
} = {
  git: { remoteUrl: 'git@github.com:acme/proj.git' },
  npm: { token: undefined, configured: false },
  canPush: false,
  canPublish: false,
};

// Mock the credential store so tests are machine-independent (no real
// .npmrc / SSH keys / git remotes influence the result).
vi.mock('../../src/agents/credential-store.js', () => ({
  CredentialStore: class {
    git = mockStore.git;
    npm = mockStore.npm;
    /** Recorded so a test can prove the non-interactive init ran FIRST. */
    initCalls = 0;
    get canPush(): boolean { return mockStore.canPush; }
    get canPublish(): boolean { return mockStore.canPublish; }
    initialize(): void { (globalThis as { __initCalls?: number }).__initCalls = ((globalThis as { __initCalls?: number }).__initCalls ?? 0) + 1; }
    setupGitCredentials(): void {}
    setupNpmAuth(): void {}
    cleanup(): void {}
  },
}));

// Mock the release runners — these are the REAL implementations (bump the
// manifest, commit, tag, push, `npm publish`), and the phases now carry them.
// An unmocked run here would try to publish this very package from a unit test.
// Emptying the table sends the phases back to the mocked orchestrator, which is
// what these tests are about.
// Partial on purpose: the version helpers stay REAL (the tool computes the
// target version from them), while the runner table — the part that would bump,
// commit, tag, push and publish — is emptied.
vi.mock('../../src/agents/release-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agents/release-runner.js')>();
  return { ...actual, createReleaseRunners: () => ({}) };
});

// Mock the preflight — the real one asks npm and git about this repository
// (`npm view agent-nuvira@x.y.z`, `git ls-remote`), which would make these tests
// depend on the network and on whatever version happens to be published. The
// preflight has its own suite; here the subject is credential gating.
vi.mock('../../src/agents/release-preflight.js', () => ({
  runReleasePreflight: async () => ({ checks: [], blocked: false, summary: '📋 Release preflight (mocked)' }),
  formatPreflight: () => '📋 Release preflight (mocked)',
}));

// Mock the orchestrator so a successful publish never runs a real pipeline.
vi.mock('../../src/agents/orchestrator.js', () => ({
  Orchestrator: class {
    execute() {
      return Promise.resolve({
        success: true,
        summary: 'done',
        agentResults: [],
        tasksCompleted: 1,
        tasksTotal: 1,
      });
    }
  },
}));

import { runPublishTool } from '../../src/tools/publish-tool.js';

describe('publish tool — credential gating (never prompts)', () => {
  beforeEach(() => {
    mockStore = {
      git: { remoteUrl: 'git@github.com:acme/proj.git' },
      npm: { token: undefined, configured: false },
      canPush: false,
      canPublish: false,
    };
  });

  it('reports missing credentials so the model can ask_user for tokens', async () => {
    const out = await runPublishTool({}, { configManager: {} });
    expect(out.toLowerCase()).toContain('no publishing credentials');
    expect(out).toContain('ask_user');
  });

  it('runs the publish phases when git credentials are detected', async () => {
    mockStore.canPush = true;
    mockStore.git.token = 'ghp_123';
    const out = await runPublishTool({ bump: 'patch' }, { configManager: {} });
    expect(out).toContain('Publish');
    expect(out).toContain('Git Commit, Tag & Push');
  });

  it('dry-run previews phases without requiring credentials', async () => {
    const out = await runPublishTool({ dry_run: true }, { configManager: {} });
    expect(out).toContain('DRY RUN');
    expect(out).toContain('Version Bump (patch)');
  });

  it('initialises the store non-interactively before setting up credentials', async () => {
    (globalThis as { __initCalls?: number }).__initCalls = 0;
    mockStore.canPush = true;
    mockStore.git.token = 'ghp_secrettoken1234';
    await runPublishTool({ bump: 'patch' }, { configManager: {} });
    expect((globalThis as { __initCalls?: number }).__initCalls).toBe(1);
  });

  it('names the credentials in use, masked, so a no-credential release is visible', async () => {
    mockStore.canPush = true;
    mockStore.canPublish = true;
    mockStore.git.token = 'ghp_secrettoken1234';
    mockStore.npm.token = 'npm_secrettoken1234';
    const out = await runPublishTool({ bump: 'patch' }, { configManager: {} });
    expect(out).toContain('Credentials:');
    expect(out).toContain('git ✓');
    expect(out).toContain('npm ✓');
    // The raw tokens must never reach the transcript.
    expect(out).not.toContain('secrettoken1234');
  });
});
