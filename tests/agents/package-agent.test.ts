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
