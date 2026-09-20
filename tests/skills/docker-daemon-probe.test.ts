/**
 * Regression test for `checkDockerAvailable`.
 *
 * The probe used to run `docker --version` only. That succeeds with the CLI
 * installed but the DAEMON stopped, so callers (skill-executor) took the
 * sandbox path and every skill died with exit code 125 — and never fell back
 * to local execution. A real skill-execution outage on any machine with Docker
 * installed-but-not-running.
 *
 * These tests pin the distinction: CLI-only → NOT available; CLI + daemon →
 * available.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

type FakeResult = { stdout?: string; stderr?: string; exitCode: number; error?: Error };

// Declared before the mock factory so the hoisted factory can close over it.
const state = vi.hoisted(() => ({ results: {} as Record<string, FakeResult> }));

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: string[]) => {
    const key = args[0] ?? '';
    const result = state.results[key] ?? { exitCode: 1, stderr: `unexpected docker arg: ${key}` };

    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };

    process.nextTick(() => {
      if (result.error) {
        child.emit('error', result.error);
        return;
      }
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
      child.emit('close', result.exitCode);
    });

    return child;
  },
}));

import { checkDockerAvailable } from '../../src/skills/sandbox-executor.js';

describe('checkDockerAvailable — daemon-aware probe', () => {
  beforeEach(() => {
    state.results = {};
  });

  it('is NOT available when the CLI exists but the daemon is stopped', async () => {
    // The exact production shape: `--version` succeeds, the daemon is down.
    state.results['--version'] = { exitCode: 0, stdout: 'Docker version 27.0.3, build abc' };
    state.results['info'] = {
      exitCode: 1,
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
    };

    const status = await checkDockerAvailable();

    expect(status.available).toBe(false);
    expect(status.version).toContain('Docker version 27.0.3');
    expect(status.error).toContain('daemon');
  });

  it('is available when both the CLI and the daemon answer', async () => {
    state.results['--version'] = { exitCode: 0, stdout: 'Docker version 27.0.3, build abc' };
    state.results['info'] = { exitCode: 0, stdout: 'Server:\n Engine:\n  Version: 27.0.3' };

    const status = await checkDockerAvailable();

    expect(status.available).toBe(true);
    expect(status.version).toContain('Docker version 27.0.3');
  });

  it('is NOT available when the CLI itself is missing', async () => {
    state.results['--version'] = { exitCode: 127, stderr: 'docker: command not found' };

    const status = await checkDockerAvailable();

    expect(status.available).toBe(false);
    expect(status.error).toBeDefined();
  });
});
