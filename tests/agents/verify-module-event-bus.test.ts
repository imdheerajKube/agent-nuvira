/**
 * Additional EventBus emission tests for DefaultVerifyModule.
 * Appends a test block that verifies VERIFY_STARTING, VERIFY_CHECK, and VERIFY_COMPLETED events.
 * Run: vitest run tests/agents/verify-module-event-bus.test.ts
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { DefaultVerifyModule } from '../../src/agents/verify-module.js';
import { EventBus, EventNames } from '../../src/observability/event-bus.js';
import type { FileChange } from '../../src/agents/agent.js';

describe('DefaultVerifyModule — EventBus emissions', () => {
  let bus: EventBus;
  let module: DefaultVerifyModule;
  const emitSpy = vi.fn();

  function makeChange(
    path: string,
    status: FileChange['status'],
    content?: string,
  ): FileChange {
    return { path, status, newContent: content };
  }

  beforeEach(() => {
    bus = new EventBus();
    emitSpy.mockClear();
    bus.emit = emitSpy;
    module = new DefaultVerifyModule(bus);
  });

  it('should emit VERIFY_STARTING when verify begins', async () => {
    await module.verify({
      changes: [makeChange('src/index.ts', 'modified', 'console.log("hi");')],
      goal: 'Add logging',
    });

    expect(emitSpy).toHaveBeenCalledWith(
      EventNames.VERIFY_STARTING,
      expect.objectContaining({ changeCount: 1, strictness: 'medium' }),
      'verify-module',
    );
  });

  it('should emit VERIFY_CHECK for security check', async () => {
    await module.verify({
      changes: [makeChange('src/index.ts', 'modified', 'console.log("hi");')],
      goal: 'Add logging',
    });

    expect(emitSpy).toHaveBeenCalledWith(
      EventNames.VERIFY_CHECK,
      expect.objectContaining({ type: 'security', passed: true }),
      'verify-module',
    );
  });

  it('should emit VERIFY_CHECK for goal-alignment when callLLM provided', async () => {
    const callLLM = vi.fn().mockResolvedValue('ALIGNED');
    await module.verify({
      changes: [makeChange('src/index.ts', 'modified', 'console.log("hi");')],
      goal: 'Add logging',
      callLLM,
    });

    expect(emitSpy).toHaveBeenCalledWith(
      EventNames.VERIFY_CHECK,
      expect.objectContaining({ type: 'goal-alignment' }),
      'verify-module',
    );
  });

  it('should emit VERIFY_CHECK for test results when provided', async () => {
    await module.verify({
      changes: [makeChange('src/index.ts', 'modified', 'console.log("hi");')],
      goal: 'Add logging',
      testResults: { passed: 5, failed: 0, total: 5 },
    });

    expect(emitSpy).toHaveBeenCalledWith(
      EventNames.VERIFY_CHECK,
      expect.objectContaining({ type: 'tests' }),
      'verify-module',
    );
  });

  it('should emit VERIFY_CHECK for run output when provided', async () => {
    await module.verify({
      changes: [makeChange('src/index.ts', 'modified', 'console.log("hi");')],
      goal: 'Add logging',
      runOutput: 'Build succeeded',
    });

    expect(emitSpy).toHaveBeenCalledWith(
      EventNames.VERIFY_CHECK,
      expect.objectContaining({ type: 'code-quality' }),
      'verify-module',
    );
  });

  it('should emit VERIFY_COMPLETED when verification finishes', async () => {
    await module.verify({
      changes: [makeChange('src/index.ts', 'modified', 'console.log("hi");')],
      goal: 'Add logging',
    });

    expect(emitSpy).toHaveBeenCalledWith(
      EventNames.VERIFY_COMPLETED,
      expect.objectContaining({ passed: true }),
      'verify-module',
    );
  });

  it('should emit VERIFY_STARTING with strictness parameter', async () => {
    await module.verify({
      changes: [makeChange('src/index.ts', 'modified', 'console.log("hi");')],
      goal: 'Add logging',
      strictness: 'high',
    });

    expect(emitSpy).toHaveBeenCalledWith(
      EventNames.VERIFY_STARTING,
      expect.objectContaining({ strictness: 'high' }),
      'verify-module',
    );
  });

  it('should emit VERIFY_CHECK for failed security with blocking severity', async () => {
    await module.verify({
      changes: [makeChange('.env', 'modified', 'API_KEY=sk-123456789012345678901234567890')],
      goal: 'Add config',
    });

    const securityCalls = emitSpy.mock.calls.filter(
      ([event, data]: [any, any]) =>
        event === EventNames.VERIFY_CHECK && data.type === 'security',
    );
    expect(securityCalls.length).toBeGreaterThanOrEqual(1);
    const [, data] = securityCalls[0] as [any, any];
    expect(data.passed).toBe(false);
    expect(data.severity).toBe('blocking');
  });
});
