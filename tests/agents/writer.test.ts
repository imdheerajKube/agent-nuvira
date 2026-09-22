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
    goal: 'Implement the core logic in addon_handler.py: register the NVDA shortcut and speak "Hello Ria Mote"',
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

/**
 * G7/G8 — prose (long-form) mode.
 *
 * The code contract could never author a document: success required
 * ``` ``filepath: …`` ``` code blocks, and the output cap was 2,048 tokens
 * (~4 pages). These tests pin the separate contract prose units use, and pin
 * that a short/empty response is a FAILURE rather than a green step — the
 * original run recorded `success: true` with `responseLength: 0`.
 */
describe('WriterAgent — long-form prose mode', () => {
  const proseUnit = (cwd: string) => ({
    docPath: join(cwd, 'story.md'),
    path: 'chapters/01-chapter-1.md',
    absolutePath: join(cwd, 'chapters/01-chapter-1.md'),
    title: 'Chapter 1',
    index: 1,
    total: 3,
    targetWords: 900,
    previousTail: '',
    deliverableClass: 'creative' as const,
    goal: 'write a 100 page story about magic and suspense',
  });

  const proseContext = (cwd: string): AgentContext => ({
    ...makeContext(cwd),
    metadata: { proseUnit: proseUnit(cwd) },
  });

  it('accepts RAW prose — no filepath: code blocks required', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'buff-writer-prose-'));
    try {
      const agent = new WriterAgent();
      const context = proseContext(cwd);
      const chapter = 'The lamp guttered. '.repeat(40); // ~160 words, no code fences
      const callLLM = vi.fn().mockResolvedValue(chapter);

      const result = await agent.execute(context, callLLM);

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Chapter 1');
      expect(context.fileChanges).toHaveLength(1);
      expect(context.fileChanges[0].path).toBe('chapters/01-chapter-1.md');
      expect(context.fileChanges[0].newContent).toContain('The lamp guttered.');
      // The author persona — NOT "expert software engineer".
      const prompt = callLLM.mock.calls[0][0] as string;
      expect(prompt).toContain('You are an author');
      expect(prompt).not.toContain('expert software engineer');
      // A raised cap, so a ~900-word unit can actually finish.
      expect(callLLM.mock.calls[0][1]?.maxTokens).toBeGreaterThan(2048);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('strips a wrapping code fence some models add anyway', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'buff-writer-prose2-'));
    try {
      const context = proseContext(cwd);
      const callLLM = vi.fn().mockResolvedValue('```markdown\n' + 'Silence, then thunder. '.repeat(60) + '\n```');
      const result = await new WriterAgent().execute(context, callLLM);
      expect(result.success).toBe(true);
      expect(context.fileChanges[0].newContent!.startsWith('Silence, then thunder.')).toBe(true);
      expect(context.fileChanges[0].newContent).not.toContain('```');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('FAILS on an empty response instead of stamping a green step', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'buff-writer-prose3-'));
    try {
      const context = proseContext(cwd);
      // The live failure: local/gpt-oss:120b-cloud returned '' in 1.6s and the
      // step was recorded as success with 0 output tokens.
      const callLLM = vi.fn().mockResolvedValue('');
      const result = await new WriterAgent().execute(context, callLLM);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/too little prose|truncated or empty/);
      expect(context.fileChanges).toHaveLength(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('FAILS on a truncated fragment (a few words is not a chapter)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'buff-writer-prose4-'));
    try {
      const context = proseContext(cwd);
      const callLLM = vi.fn().mockResolvedValue('I will write the chapter next.');
      const result = await new WriterAgent().execute(context, callLLM);
      expect(result.success).toBe(false);
      expect(context.fileChanges).toHaveLength(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('hands a CONTINUING unit the previous unit tail and forbids "The End"', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'buff-writer-prose5-'));
    try {
      const context = proseContext(cwd);
      (context.metadata.proseUnit as Record<string, unknown>).previousTail = '…and the door closed behind her.';
      (context.metadata.proseUnit as Record<string, unknown>).index = 2;
      const callLLM = vi.fn().mockResolvedValue('Rain fell for three days. '.repeat(30));

      await new WriterAgent().execute(context, callLLM);
      const prompt = callLLM.mock.calls[0][0] as string;
      expect(prompt).toContain('the door closed behind her');
      expect(prompt).toMatch(/Do NOT write "The End"/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
