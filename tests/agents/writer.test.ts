/**
 * WriterAgent — parse-failure surfacing (Session 46).
 *
 * Before Session 46, an LLM response with NO `filepath:` code blocks was
 * stamped `success: true, "No files needed changes"` after one retry — so a
 * task whose real work was silently skipped still showed ✅, and the
 * downstream reviewer correctly blocked the unchanged code until the repair
 * budget died. These tests lock in the new behavior:
 *  - unparseable output twice → `success: false` (repair engine escalates)
 *  - a GENUINE "no changes needed" decline → still a successful no-op
 *  - a failed first attempt followed by a parseable retry → recovered changes
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WriterAgent } from '../../src/agents/agents/writer.js';
import type { AgentContext } from '../../src/agents/agent.js';

function makeContext(cwd: string): AgentContext {
  return {
    goal: 'Implement the core logic in addon_handler.py: register the NVDA shortcut and speak "Hello Anuj Mote"',
    workingDirectory: cwd,
    taskPlan: [
      {
        id: 'step-1',
        agentType: 'writer',
        description: 'Implement the core logic in addon_handler.py',
        dependsOn: [],
        status: 'running' as const,
      },
    ],
    artifacts: [],
    conversations: [],
    fileChanges: [],
    metadata: {},
  };
}

describe('WriterAgent — parse-failure surfacing (Session 46)', () => {
  it('marks the task FAILED when the LLM returns unparseable prose twice (no false success)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'buff-writer-test-'));
    try {
      const agent = new WriterAgent();
      const context = makeContext(cwd);
      const callLLM = vi.fn().mockResolvedValue(
        'I will now implement the handler. First, let me think about the NVDA API imports and how gestures are registered...',
      );

      const result = await agent.execute(context, callLLM);

      expect(result.success).toBe(false);
      expect(result.summary).toContain('parseable');
      // initial attempt + one strict-format retry, then the failure surfaces
      expect(callLLM).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('treats a genuine "no changes needed" judgment as a successful no-op', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'buff-writer-test-'));
    try {
      const agent = new WriterAgent();
      const context = makeContext(cwd);
      const callLLM = vi.fn().mockResolvedValue(
        'No changes needed — the file already implements the required functionality.',
      );

      const result = await agent.execute(context, callLLM);

      expect(result.success).toBe(true);
      expect(result.summary).toBe('No files needed changes');
      // A genuine decline is accepted IMMEDIATELY — no misleading
      // strict-format retry, no wasted LLM round-trip.
      expect(callLLM).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('recovers when the strict-format retry produces parseable changes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'buff-writer-test-'));
    try {
      const agent = new WriterAgent();
      const context = makeContext(cwd);
      const callLLM = vi
        .fn()
        .mockResolvedValueOnce('Here is some rambling about the approach with no code blocks.')
        .mockResolvedValueOnce(
          '```filepath:addon/addon_handler.py\nimport globalVars\n\ndef onInit():\n    pass\n```',
        );

      const result = await agent.execute(context, callLLM);

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Proposed changes to 1 file');
      expect(context.fileChanges).toHaveLength(1);
      expect(context.fileChanges[0].path).toBe('addon/addon_handler.py');
      expect(context.fileChanges[0].status).toBe('created');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('accepts past-tense/variant declines ("already satisfied") without a retry', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'buff-writer-test-'));
    try {
      const agent = new WriterAgent();
      const context = makeContext(cwd);
      const callLLM = vi.fn().mockResolvedValue(
        'Nothing to change. The current implementation already satisfies the requirement.',
      );

      const result = await agent.execute(context, callLLM);

      expect(result.success).toBe(true);
      expect(result.summary).toBe('No files needed changes');
      expect(callLLM).toHaveBeenCalledTimes(1);

      // Past-tense variant a weak model is likely to produce:
      const pastTense = vi.fn().mockResolvedValue(
        'The code already satisfied the contract — no work is needed.',
      );
      const result2 = await agent.execute(makeContext(cwd), pastTense);
      expect(result2.success).toBe(true);
      expect(result2.summary).toBe('No files needed changes');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
