/**
 * Bundle 37b — the harness directive channel.
 *
 * The loop's own nudges are delivered once, marked, and as `system`-role
 * directives — never as `user` turns the model would answer.
 */

import { describe, it, expect } from 'vitest';
import {
  harnessDirective,
  createHarnessDirectiveSink,
  HARNESS_MARKER,
} from '../../src/tools/harness-directive.js';
import type { ToolMessage } from '../../src/inference/interface.js';

describe('harness-directive', () => {
  it('marks the directive and uses the system role', () => {
    const msg = harnessDirective('run the check now');
    expect(msg.role).toBe('system');
    expect(msg.content).toBe(`${HARNESS_MARKER} run the check now`);
  });

  it('pushes a gate once, and refuses a repeat of the same gate', () => {
    const sink = createHarnessDirectiveSink();
    const thread: ToolMessage[] = [];

    expect(sink.push(thread, 'verification', 'check it')).toBe(true);
    expect(sink.push(thread, 'verification', 'check it again')).toBe(false);

    expect(thread).toHaveLength(1);
    expect(thread[0]!.content).toContain('check it');
    expect(sink.has('verification')).toBe(true);
    expect(sink.deliveredGates()).toEqual(['verification']);
  });

  it('lets a DIFFERENT gate speak', () => {
    const sink = createHarnessDirectiveSink();
    const thread: ToolMessage[] = [];
    sink.push(thread, 'plan', 'declare a plan');
    sink.push(thread, 'verification', 'verify the change');
    expect(thread).toHaveLength(2);
    expect(thread.every((m) => m.role === 'system')).toBe(true);
  });
});
