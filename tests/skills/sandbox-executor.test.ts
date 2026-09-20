/**
 * Tests for the Sandbox Executor — Docker-based skill execution.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  executeInSandbox,
  checkDockerAvailable,
  checkImageExists,
  pullImageIfNeeded,
} from '../../src/skills/sandbox-executor.js';

/** The executor's default image (see src/skills/sandbox-executor.ts). */
const SANDBOX_IMAGE = 'node:20-slim';

describe('Sandbox Executor', () => {
  let dockerAvailable = false;
  /**
   * Docker being INSTALLED is not enough to run a container — the image has to
   * be present too.
   *
   * GitHub's runners ship Docker without `node:20-slim`, so the old
   * docker-only gate let 12 execution/security tests attempt a container and
   * fail on `expected false to be true` (executeInSandbox correctly reports
   * success:false when the image is missing). Gating on the image as well keeps
   * the suite honest: when the prerequisite is absent the tests SKIP with a
   * reason instead of failing.
   *
   * The image is only downloaded when explicitly requested
   * (NUVIRA_SANDBOX_TEST_PULL=1) so the suite stays offline and deterministic by
   * default — a ~80MB pull in every run is not a unit test's job.
   */
  let imageReady = false;
  const shouldPull = process.env.NUVIRA_SANDBOX_TEST_PULL === '1';

  beforeAll(async () => {
    const status = await checkDockerAvailable();
    dockerAvailable = status.available;
    if (!dockerAvailable) {
      console.warn('Docker not available, skipping sandbox tests');
      return;
    }

    imageReady = await checkImageExists(SANDBOX_IMAGE);
    if (!imageReady && shouldPull) {
      try {
        await pullImageIfNeeded(SANDBOX_IMAGE);
        imageReady = await checkImageExists(SANDBOX_IMAGE);
      } catch (err) {
        console.warn(`Failed to pull ${SANDBOX_IMAGE}: ${(err as Error).message}`);
      }
    }
    if (!imageReady) {
      console.warn(
        `Docker image ${SANDBOX_IMAGE} is not present locally, skipping sandbox execution tests ` +
          '(set NUVIRA_SANDBOX_TEST_PULL=1 to download it and run them).',
      );
    }
  });

  describe('Docker Availability', () => {
    it('checks if Docker is available', async () => {
      const status = await checkDockerAvailable();
      // We just check the function works, not that Docker is actually available
      expect(status).toHaveProperty('available');
      expect(typeof status.available).toBe('boolean');
    });

    it('checks if an image exists', async (ctx) => {
      if (!dockerAvailable || !imageReady) return ctx.skip();
      
      const exists = await checkImageExists('node:20-slim');
      expect(typeof exists).toBe('boolean');
    });
  });

  describe('Sandbox Execution', () => {
    it('executes a shell script in sandbox', async (ctx) => {
      if (!dockerAvailable || !imageReady) return ctx.skip();
      
      const script = 'echo "hello from sandbox"';
      const result = await executeInSandbox(script, 'test.sh');
      
      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe('hello from sandbox');
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it('executes a Python script in sandbox', async (ctx) => {
      if (!dockerAvailable || !imageReady) return ctx.skip();
      
      const script = 'print("hello from python")';
      const result = await executeInSandbox(script, 'test.py');
      
      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe('hello from python');
      expect(result.exitCode).toBe(0);
    });

    it('executes a Node.js script in sandbox', async (ctx) => {
      if (!dockerAvailable || !imageReady) return ctx.skip();
      
      const script = 'console.log("hello from node")';
      const result = await executeInSandbox(script, 'test.js');
      
      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe('hello from node');
      expect(result.exitCode).toBe(0);
    });

    it('injects environment variables', async (ctx) => {
      if (!dockerAvailable || !imageReady) return ctx.skip();
      
      const script = 'echo $MY_VAR';
      const result = await executeInSandbox(script, 'test.sh', { MY_VAR: 'injected' });
      
      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe('injected');
    });

    it('handles non-zero exit codes', async (ctx) => {
      if (!dockerAvailable || !imageReady) return ctx.skip();
      
      const script = 'exit 1';
      const result = await executeInSandbox(script, 'test.sh');
      
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('captures stderr', async (ctx) => {
      if (!dockerAvailable || !imageReady) return ctx.skip();
      
      const script = 'echo "error" >&2';
      const result = await executeInSandbox(script, 'test.sh');
      
      expect(result.stderr.trim()).toBe('error');
    });

    it('respects timeout', async (ctx) => {
      if (!dockerAvailable || !imageReady) return ctx.skip();
      
      const script = 'sleep 10';
      const result = await executeInSandbox(script, 'test.sh', undefined, undefined, { timeoutMs: 1000 });
      
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(124); // timeout exit code
    }, 10000);

    it('passes arguments to the script', async (ctx) => {
      if (!dockerAvailable || !imageReady) return ctx.skip();
      
      const script = 'echo "args: $@"';
      const result = await executeInSandbox(script, 'test.sh', undefined, ['arg1', 'arg2']);
      
      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe('args: arg1 arg2');
    });

    it('restricts network access', async (ctx) => {
      if (!dockerAvailable || !imageReady) return ctx.skip();
      
      // This should fail because network is disabled
      const script = 'curl -s http://example.com || echo "network blocked"';
      const result = await executeInSandbox(script, 'test.sh', undefined, undefined, { networkMode: 'none' });
      
      // Should either fail or show "network blocked"
      expect(result.stdout).toContain('network blocked');
    });
  });

  describe('Security', () => {
    it('drops all capabilities by default', async (ctx) => {
      if (!dockerAvailable || !imageReady) return ctx.skip();
      
      // This should work even with dropped capabilities
      const script = 'echo "secure execution"';
      const result = await executeInSandbox(script, 'test.sh');
      
      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe('secure execution');
    });

    it('uses read-only root filesystem', async (ctx) => {
      if (!dockerAvailable || !imageReady) return ctx.skip();
      
      // This should fail because root filesystem is read-only
      const script = 'touch /etc/test || echo "read-only"';
      const result = await executeInSandbox(script, 'test.sh');
      
      expect(result.stdout).toContain('read-only');
    });

    it('limits memory usage', async (ctx) => {
      if (!dockerAvailable || !imageReady) return ctx.skip();
      
      // This should work within memory limits
      const script = 'echo "memory limited"';
      const result = await executeInSandbox(script, 'test.sh', undefined, undefined, { memoryLimitMb: 256 });
      
      expect(result.success).toBe(true);
    });
  });
});
