/**
 * E3c — publish tool tests (hermetic: CredentialStore + Orchestrator mocked).
 *
 * The `publish` tool is the credentialed, irreversible E3c task tool: it must
 * NEVER prompt interactively (creds from env/detected config only), report
 * missing credentials back so the model can ask_user for tokens, and run the
 * SAME phase list as `buff publish` (buildPublishPhases — one source).
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
    get canPush(): boolean { return mockStore.canPush; }
    get canPublish(): boolean { return mockStore.canPublish; }
    setupGitCredentials(): void {}
    setupNpmAuth(): void {}
    cleanup(): void {}
  },
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
});
