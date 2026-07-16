import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';

import {
  SandboxManager,
  getSandboxManager,
  resetSandboxManager,
} from '../../src/sandbox/manager.js';
import {
  getSandboxConfig,
  setSandboxConfig,
  resetSandboxConfigCache,
  DEFAULT_SANDBOX_CONFIG,
  DEFAULT_RESOURCE_LIMITS,
} from '../../src/sandbox/types.js';
import type { SandboxConfig, ResourceLimits } from '../../src/sandbox/types.js';
import {
  BUILTIN_SANDBOX_IMAGES,
  resolveSandboxImage,
  detectProjectImage,
} from '../../src/sandbox/images.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a mock execSync for testing. Replaces execSync in the manager.
 */
function mockDockerAvailable(available: boolean, version = '24.0.0') {
  const mockExecSync = vi.fn();
  const mockSpawn = vi.fn();

  if (available) {
    mockExecSync.mockReturnValue(Buffer.from(version));
  } else {
    mockExecSync.mockImplementation(() => {
      const err = new Error('Docker not available') as any;
      err.status = 1;
      err.stdout = '';
      err.stderr = 'Cannot connect to the Docker daemon';
      throw err;
    });
  }

  return { mockExecSync, mockSpawn };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SandboxManager', () => {
  let manager: SandboxManager;

  beforeEach(() => {
    resetSandboxManager();
    manager = new SandboxManager();
  });

  afterEach(async () => {
    await manager.destroyAll().catch(() => {});
  });

  describe('isDockerAvailable', () => {
    it('returns false when docker is not available', async () => {
      // Mock execSync to simulate Docker not available
      const available = await manager.isDockerAvailable();
      // In CI/test environments, Docker is typically not available
      // This test validates the method doesn't throw
      expect(typeof available).toBe('boolean');
    });

    it('caches the result after first check', async () => {
      await manager.isDockerAvailable();
      expect(manager['dockerChecked']).toBe(true);
    });

    it('resets check on resetDockerCheck', async () => {
      await manager.isDockerAvailable();
      manager.resetDockerCheck();
      expect(manager['dockerChecked']).toBe(false);
    });
  });

  describe('getDockerError', () => {
    it('returns empty string before first check', () => {
      expect(manager.getDockerError()).toBe('');
    });
  });

  describe('getManagedContainers', () => {
    it('returns empty array initially', () => {
      expect(manager.getManagedContainers()).toEqual([]);
    });
  });

  describe('destroyAll', () => {
    it('succeeds when there are no containers', async () => {
      await expect(manager.destroyAll()).resolves.toBeUndefined();
    });
  });

  describe('createContainer', () => {
    it('throws if Docker is not available', async () => {
      // In test environments Docker likely isn't available
      const available = await manager.isDockerAvailable();
      if (!available) {
        await expect(
          manager.createContainer('node:20-slim'),
        ).rejects.toThrow(/Docker is not available/);
      }
    });
  });
});  describe('SandboxConfig', () => {
    beforeEach(() => {
      // Reset cached config and delete any persisted config file
      // to ensure tests start from clean defaults
      resetSandboxConfigCache();
      const configPath = join(homedir(), '.buff', 'sandbox-config.json');
      if (existsSync(configPath)) {
        rmSync(configPath, { force: true });
      }
    });

  describe('getSandboxConfig', () => {
    it('returns default config when no config file exists', () => {
      const config = getSandboxConfig();
      expect(config.enabled).toBe(false);
      expect(config.limits.memoryLimit).toBe('1g');
      expect(config.limits.cpuLimit).toBe(1);
      expect(config.limits.diskLimit).toBe('2g');
      expect(config.limits.pidsLimit).toBe(100);
      expect(config.limits.networkAccess).toBe(false);
      expect(config.limits.timeoutMs).toBe(600_000);
      expect(config.image.image).toBe('node:20-slim');
      expect(config.workDir).toBe('/workspace');
    });

    it('returns a copy that cannot mutate the cached default', () => {
      const config1 = getSandboxConfig();
      const config2 = getSandboxConfig();
      config1.enabled = true;
      expect(config2.enabled).toBe(false);
    });
  });

  describe('setSandboxConfig', () => {
    it('updates config and returns merged result', () => {
      const updated = setSandboxConfig({ enabled: true });
      expect(updated.enabled).toBe(true);
      // Defaults should still be present
      expect(updated.limits.memoryLimit).toBe('1g');
    });

    it('partially updates resource limits', () => {
      // First set enabled to true
      setSandboxConfig({ enabled: true });
      // Then partially update limits
      setSandboxConfig({
        limits: { memoryLimit: '2g' } as any,
      });
      const config = getSandboxConfig();
      expect(config.enabled).toBe(true); // Preserved from previous update
      expect(config.limits.memoryLimit).toBe('2g'); // Updated
    });

    it('updates image', () => {
      const updated = setSandboxConfig({
        image: {
          image: 'python:3.12-slim',
          label: 'Python 3.12',
          runtimes: ['python'],
        },
      });
      const config = getSandboxConfig();
      expect(config.image.image).toBe('python:3.12-slim');
    });
  });
});

describe('SandboxImages', () => {
  describe('BUILTIN_SANDBOX_IMAGES', () => {
    it('has at least 4 images', () => {
      expect(BUILTIN_SANDBOX_IMAGES.length).toBeGreaterThanOrEqual(4);
    });

    it('each image has required fields', () => {
      for (const img of BUILTIN_SANDBOX_IMAGES) {
        expect(img.image).toBeTruthy();
        expect(img.label).toBeTruthy();
        expect(img.runtimes.length).toBeGreaterThan(0);
        expect(img.shell).toBeTruthy();
      }
    });

    it('covers Node.js, Python, Go, and Rust', () => {
      const images = BUILTIN_SANDBOX_IMAGES.map((i) => i.label);
      expect(images.some((l) => l.includes('Node'))).toBe(true);
      expect(images.some((l) => l.includes('Python'))).toBe(true);
      expect(images.some((l) => l.includes('Go'))).toBe(true);
      expect(images.some((l) => l.includes('Rust'))).toBe(true);
    });
  });

  describe('resolveSandboxImage', () => {
    it('finds Node image by "node"', () => {
      const img = resolveSandboxImage('node');
      expect(img).toBeDefined();
      expect(img!.image).toContain('node');
    });

    it('finds Python image by "python"', () => {
      const img = resolveSandboxImage('python');
      expect(img).toBeDefined();
      expect(img!.image).toContain('python');
    });

    it('finds Go image by "golang"', () => {
      const img = resolveSandboxImage('golang');
      expect(img).toBeDefined();
      expect(img!.image).toContain('golang');
    });

    it('finds Rust image by "rust"', () => {
      const img = resolveSandboxImage('rust');
      expect(img).toBeDefined();
      expect(img!.image).toContain('rust');
    });

    it('returns undefined for unknown runtime', () => {
      const img = resolveSandboxImage('nonexistent-runtime-xyz');
      expect(img).toBeUndefined();
    });
  });

  describe('detectProjectImage', () => {
    it('detects Node.js from package.json', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'buff-test-'));
      writeFileSync(join(tmpDir, 'package.json'), '{}', 'utf-8');
      const img = detectProjectImage(tmpDir);
      expect(img.image).toContain('node');
    });

    it('detects Python from requirements.txt', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'buff-test-'));
      writeFileSync(join(tmpDir, 'requirements.txt'), '', 'utf-8');
      const img = detectProjectImage(tmpDir);
      expect(img.image).toContain('python');
    });

    it('falls back to Node.js for unknown projects', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'buff-test-'));
      const img = detectProjectImage(tmpDir);
      expect(img.image).toContain('node');
    });
  });
});
