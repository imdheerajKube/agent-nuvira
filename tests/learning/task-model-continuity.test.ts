/**
 * fix_model_routing P3 — task-level model CONTINUITY (RC7).
 *
 * The failure: routing is decided per turn, and a continuation ("resume") is
 * signal-free, so the router re-decided from scratch and handed a task that was
 * being served by a working model to one that answered with nothing. These tests
 * pin the memory itself: matching is by TASK (intent+complexity, which both the
 * original ask and its continuation resolve to), a re-serve replaces rather than
 * stacks, and a stale memory is dropped instead of being offered forever.
 */

import { describe, it, expect } from 'vitest';
import {
  TaskModelContinuity,
  TASK_CONTINUITY_TTL_MS,
  taskSignature,
} from '../../src/learning/task-model-continuity.js';

describe('taskSignature', () => {
  it('is stable across the original ask and its continuation', () => {
    // Both turns resolve the same ask to the same intent+complexity.
    expect(taskSignature('coding', 'moderate')).toBe(taskSignature('coding', 'moderate'));
  });

  it('separates different work, and normalizes case/whitespace', () => {
    expect(taskSignature('coding', 'moderate')).not.toBe(taskSignature('research', 'complex'));
    expect(taskSignature(' Coding ', ' Moderate ')).toBe(taskSignature('coding', 'moderate'));
  });

  it('names the unknown parts instead of forming an empty key', () => {
    // Two unclassified turns must still MATCH each other rather than collapse to
    // '' (which would make every unclassified task share one memory).
    expect(taskSignature(undefined, undefined)).toBe('general|unknown');
    expect(taskSignature(undefined, undefined)).toBe(taskSignature('', ''));
  });
});

describe('TaskModelContinuity', () => {
  it('recalls the pair that served the task', () => {
    const memory = new TaskModelContinuity();
    const sig = taskSignature('coding', 'moderate');
    memory.remember(sig, 'gemini', 'gemini-3.1-flash-lite');
    const recalled = memory.recall(sig);
    expect(recalled).toMatchObject({ provider: 'gemini', model: 'gemini-3.1-flash-lite', signature: sig });
  });

  it('does not leak one task into another', () => {
    const memory = new TaskModelContinuity();
    memory.remember(taskSignature('coding', 'moderate'), 'gemini', 'gemini-3.1-flash-lite');
    expect(memory.recall(taskSignature('research', 'complex'))).toBeNull();
  });

  it('replaces rather than stacks when the task is re-served by another model', () => {
    const memory = new TaskModelContinuity();
    const sig = taskSignature('coding', 'moderate');
    memory.remember(sig, 'gemini', 'gemini-3.1-flash-lite');
    memory.remember(sig, 'groq', 'openai/gpt-oss-120b');
    expect(memory.size()).toBe(1);
    expect(memory.recall(sig)?.model).toBe('openai/gpt-oss-120b');
  });

  it('drops a stale memory instead of offering a model from hours ago', () => {
    const memory = new TaskModelContinuity();
    const sig = taskSignature('coding', 'moderate');
    const t0 = Date.now();
    memory.remember(sig, 'gemini', 'gemini-3.1-flash-lite', t0);
    // Still good just inside the window...
    expect(memory.recall(sig, t0 + TASK_CONTINUITY_TTL_MS - 1)).not.toBeNull();
    // ...and gone past it (and forgotten, not merely hidden).
    expect(memory.recall(sig, t0 + TASK_CONTINUITY_TTL_MS + 1)).toBeNull();
    expect(memory.size()).toBe(0);
  });

  it('refuses to remember an unusable pair (no model, or the `default` placeholder)', () => {
    const memory = new TaskModelContinuity();
    const sig = taskSignature('coding', 'moderate');
    memory.remember(sig, 'gemini', 'default');
    memory.remember(sig, '', 'gemini-3.1-flash-lite');
    memory.remember('', 'gemini', 'gemini-3.1-flash-lite');
    expect(memory.size()).toBe(0);
    expect(memory.recall(sig)).toBeNull();
  });

  it('forgets a task on demand — used when the remembered pair proves unusable', () => {
    const memory = new TaskModelContinuity();
    const sig = taskSignature('coding', 'moderate');
    memory.remember(sig, 'gemini', 'gemini-3.1-flash-lite');
    memory.forget(sig);
    expect(memory.recall(sig)).toBeNull();
  });
});
