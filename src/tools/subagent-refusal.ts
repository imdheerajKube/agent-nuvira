/**
 * The refusal a subagent raises when it cannot do real work.
 *
 * A subagent that cannot run must say so with a machine-readable reason — the
 * same contract every tool follows (`tool-refusal.ts`). It exists as its own
 * module because it crosses a process boundary: the child throws it, serialises
 * its `code` + message over IPC, and the parent records it as the task's error
 * instead of reporting a task that never ran as completed.
 */

import type { ToolRefusalCode } from './tool-refusal.js';

export class SubagentRefusalError extends Error {
  readonly code: ToolRefusalCode;

  constructor(code: ToolRefusalCode, message: string) {
    super(message);
    this.name = 'SubagentRefusalError';
    this.code = code;
  }
}
