/**
 * Unit tests for CredentialStore — Git/npm credential collection and setup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('CredentialStore', () => {
  // We import dynamically to allow env var manipulation before import
  let CredentialStore: any;
  let testDir: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'creds-test-'));
    // Delete env vars to ensure clean state (setting to '' still makes them truthy-ish)
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.NPM_TOKEN;
    delete process.env.GIT_USERNAME;

    // Dynamic import after env is clean
    const mod = await import('../../src/agents/credential-store.js');
    CredentialStore = mod.CredentialStore;
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.NPM_TOKEN;
    delete process.env.GIT_USERNAME;
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ── Constructor / Auto-detection ──────────────────────────────────────

  describe('constructor / auto-detection', () => {
    it('should create a store with empty credentials by default', () => {
      const store = new CredentialStore();
      expect(store.git).toBeDefined();
      expect(store.npm).toBeDefined();
      expect(store.collected).toBe(false);
    });

    it('should detect GITHUB_TOKEN from environment', async () => {
      process.env.GITHUB_TOKEN = 'ghp_test123';
      // Need to import after env set
      const mod = await import('../../src/agents/credential-store.js');
      const Store = mod.CredentialStore;
      const store = new Store();
      expect(store.git.token).toBe('ghp_test123');
    });

    it('should detect GH_TOKEN from environment', async () => {
      process.env.GH_TOKEN = 'gho_xyz789';
      const mod = await import('../../src/agents/credential-store.js');
      const Store = mod.CredentialStore;
      const store = new Store();
      expect(store.git.token).toBe('gho_xyz789');
    });

    it('should prefer GITHUB_TOKEN over GH_TOKEN', async () => {
      process.env.GITHUB_TOKEN = 'ghp_primary';
      process.env.GH_TOKEN = 'gho_secondary';
      const mod = await import('../../src/agents/credential-store.js');
      const Store = mod.CredentialStore;
      const store = new Store();
      expect(store.git.token).toBe('ghp_primary');
    });

    it('should detect NPM_TOKEN from environment', async () => {
      process.env.NPM_TOKEN = 'npm_test123';
      const mod = await import('../../src/agents/credential-store.js');
      const Store = mod.CredentialStore;
      const store = new Store();
      expect(store.npm.token).toBe('npm_test123');
    });

    it('should detect GIT_USERNAME from environment', async () => {
      process.env.GIT_USERNAME = 'testuser';
      await vi.waitFor(async () => {
        const mod = await import('../../src/agents/credential-store.js');
        const Store = mod.CredentialStore;
        const store = new Store();
        expect(store.git.username).toBe('testuser');
      });
    });
  });

  // ── canPush / canPublish getters ──────────────────────────────────────

  describe('canPush / canPublish', () => {
    it('should return false for canPush when no credentials set', () => {
      const store = new CredentialStore();
      (store as any)._git.token = undefined;
      expect(store.canPush).toBe(false);
    });

    it('should return true for canPush when token is set', () => {
      const store = new CredentialStore();
      (store as any)._git.token = 'ghp_test';
      expect(store.canPush).toBe(true);
    });

    it('should return false for canPublish when no npm token', () => {
      const store = new CredentialStore();
      (store as any)._npm.token = undefined;
      expect(store.canPublish).toBe(false);
    });

    it('should return true for canPublish when npm token is set', () => {
      const store = new CredentialStore();
      (store as any)._npm.token = 'npm_test';
      expect(store.canPublish).toBe(true);
    });
  });

  // ── collectAll() flow ─────────────────────────────────────────────────

  describe('collectAll()', () => {
    it('should set collected to true after collection', async () => {
      const store = new CredentialStore();
      // Set credentials so it doesn't prompt
      (store as any)._npm.token = 'npm_prefilled';
      (store as any)._git.token = 'ghp_prefilled';

      await store.collectAll();
      expect(store.collected).toBe(true);
    });

    it('should return collected credentials', async () => {
      const store = new CredentialStore();
      (store as any)._npm.token = 'npm_test';
      (store as any)._git.token = 'ghp_test';

      const result = await store.collectAll();
      expect(result.git.token).toBe('ghp_test');
      expect(result.npm.token).toBe('npm_test');
    });

    it('should skip interactive prompts when npm token is already set', async () => {
      const store = new CredentialStore();
      (store as any)._npm.token = 'npm_prefilled';
      (store as any)._git.token = 'ghp_prefilled';

      // Should not throw — would throw only if inquirer prompts fail
      const result = await store.collectAll();
      expect(result.git.token).toBe('ghp_prefilled');
    });

    it('should not collect twice when already collected', async () => {
      const store = new CredentialStore();
      (store as any)._npm.token = 'npm_t';
      (store as any)._git.token = 'ghp_t';
      (store as any)._collected = true;

      const result = await store.collectAll();
      expect(result.git.token).toBe('ghp_t');
    });
  });

  // ── setupGitCredentials() ─────────────────────────────────────────────

  describe('setupGitCredentials()', () => {
    it('should throw if collectAll was not called first', () => {
      const store = new CredentialStore();
      expect(() => store.setupGitCredentials()).toThrow('collectAll');
    });

    it('should set GIT_TERMINAL_PROMPT to 0 when token is available', async () => {
      const store = new CredentialStore();
      (store as any)._git.token = 'ghp_test';
      (store as any)._collected = true;

      store.setupGitCredentials();
      expect(process.env.GIT_TERMINAL_PROMPT).toBe('0');
    });

    it('should set GIT_ASKPASS env var when token is available', async () => {
      const store = new CredentialStore();
      (store as any)._git.token = 'ghp_askpass_test';
      (store as any)._collected = true;

      store.setupGitCredentials();
      expect(process.env.GIT_ASKPASS).toBeTruthy();
      // Verify the askpass script exists
      const askPassPath = process.env.GIT_ASKPASS!;
      expect(existsSync(askPassPath)).toBe(true);
      // Clean up
      try { rmSync(askPassPath, { force: true }); } catch { /* best-effort */ }
    });

    it('should write the correct token to the askpass script', async () => {
      const store = new CredentialStore();
      (store as any)._git.token = 'super_secret_token_123';
      (store as any)._collected = true;

      store.setupGitCredentials();
      const askPassPath = process.env.GIT_ASKPASS!;
      const scriptContent = readFileSync(askPassPath, 'utf-8');
      expect(scriptContent).toContain('super_secret_token_123');
      try { rmSync(askPassPath, { force: true }); } catch { /* best-effort */ }
    });
  });

  // ── setupNpmAuth() ────────────────────────────────────────────────────

  describe('setupNpmAuth()', () => {
    it('should throw if collectAll was not called first', () => {
      const store = new CredentialStore();
      expect(() => store.setupNpmAuth()).toThrow('collectAll');
    });

    it('should set NPM_TOKEN env var', async () => {
      const store = new CredentialStore();
      (store as any)._npm.token = 'npm_auth_123';
      (store as any)._collected = true;

      store.setupNpmAuth();
      expect(process.env.NPM_TOKEN).toBe('npm_auth_123');
    });

    it('should write project-level .npmrc with auth token', async () => {
      const store = new CredentialStore();
      (store as any)._npm.token = 'npm_npmrc_test';
      (store as any)._collected = true;

      // Change cwd to test dir to write .npmrc there
      const originalCwd = process.cwd;
      const mockCwd = vi.fn(() => testDir);
      process.cwd = mockCwd as any;

      try {
        store.setupNpmAuth();
        const npmrcPath = join(testDir, '.npmrc');
        expect(existsSync(npmrcPath)).toBe(true);
        const content = readFileSync(npmrcPath, 'utf-8');
        expect(content).toContain('_authToken');
        expect(content).toContain('${NPM_TOKEN}');
      } finally {
        process.cwd = originalCwd;
      }
    });

    it('should not duplicate auth token in existing .npmrc', async () => {
      const store = new CredentialStore();
      (store as any)._npm.token = 'npm_no_dupe';
      (store as any)._collected = true;

      const originalCwd = process.cwd;
      const mockCwd = vi.fn(() => testDir);
      process.cwd = mockCwd as any;

      try {
        // First call writes the token
        store.setupNpmAuth();
        // Save content length
        const npmrcPath = join(testDir, '.npmrc');
        const content1 = readFileSync(npmrcPath, 'utf-8');

        // Second call should not duplicate
        store.setupNpmAuth();
        const content2 = readFileSync(npmrcPath, 'utf-8');
        expect(content1).toBe(content2);
      } finally {
        process.cwd = originalCwd;
      }
    });
  });

  // ── cleanup() ─────────────────────────────────────────────────────────

  describe('cleanup()', () => {
    it('should unset GIT_ASKPASS and GIT_TERMINAL_PROMPT', () => {
      const store = new CredentialStore();
      (store as any)._git.token = 'ghp_test';
      (store as any)._collected = true;

      store.setupGitCredentials();
      store.cleanup();

      expect(process.env.GIT_ASKPASS).toBeUndefined();
      expect(process.env.GIT_TERMINAL_PROMPT).toBeUndefined();
    });

    it('should set collected to false after cleanup', () => {
      const store = new CredentialStore();
      (store as any)._collected = true;
      store.cleanup();
      expect(store.collected).toBe(false);
    });

    it('should not throw when no askpass was set', () => {
      const store = new CredentialStore();
      expect(() => store.cleanup()).not.toThrow();
    });

    it('should remove the askpass script file if it exists', () => {
      const store = new CredentialStore();
      (store as any)._git.token = 'ghp_cleanup';
      (store as any)._collected = true;

      store.setupGitCredentials();
      const askPassPath = process.env.GIT_ASKPASS!;
      expect(existsSync(askPassPath)).toBe(true);

      store.cleanup();
      expect(existsSync(askPassPath)).toBe(false);
    });
  });

  // ── Module-level functions ────────────────────────────────────────────

  describe('module-level helper functions', () => {
    it('checkGitCredentials should detect env vars', async () => {
      process.env.GITHUB_TOKEN = 'ghp_check';
      const { checkGitCredentials } = await import('../../src/agents/credential-store.js');
      expect(checkGitCredentials()).toBe(true);
    });

    it('checkGitCredentials should return false without env vars', async () => {
      const { checkGitCredentials } = await import('../../src/agents/credential-store.js');
      expect(checkGitCredentials()).toBe(false);
    });

    it('checkNpmCredentials should detect NPM_TOKEN', async () => {
      process.env.NPM_TOKEN = 'npm_check';
      const { checkNpmCredentials } = await import('../../src/agents/credential-store.js');
      expect(checkNpmCredentials()).toBe(true);
    });

    it('checkNpmCredentials should return false without env vars', async () => {
      const { checkNpmCredentials } = await import('../../src/agents/credential-store.js');
      expect(checkNpmCredentials()).toBe(false);
    });

    it('getCredentialStatus should return a string summary', async () => {
      const { getCredentialStatus } = await import('../../src/agents/credential-store.js');
      const status = getCredentialStatus();
      expect(typeof status).toBe('string');
      expect(status.length).toBeGreaterThan(10);
      expect(status).toContain('Remote');
    });
  });

  // ─── Types ─────────────────────────────────────────────────────────────

  describe('type exports', () => {
    it('should export GitCredentials, NpmCredentials, PublishCredentials interfaces', async () => {
      const mod = await import('../../src/agents/credential-store.js');
      // Check the types are at least present as module exports
      expect(mod.CredentialStore).toBeDefined();
    });
  });
});
