/**
 * THE ASSESSMENT SECTION REACHES EVERY ENTRY, not just the chat one.
 *
 * Measured before this work: the block was assembled inline in `chat.ts`, so it
 * reached exactly one of the four entries that can run an assessment ask — and
 * `nuvira execute` (the surface a scripted/batch audit actually uses) got an
 * unadorned ask. `src/parity/surfaces.ts` describes this exact failure mode: "a
 * capability lands on one surface and quietly misses three".
 *
 * `assessment-turn-context.test.ts` proves every entry CALLS the seam. This file
 * proves the call reaches the WIRE — the two are not the same thing, and the
 * difference is the whole bug class: a block built and then dropped looks identical
 * to a block that was never built, from the outside.
 *
 * Both directions are asserted on each entry: an assessment ask carries the rules,
 * and an ordinary change request carries nothing (so the fix is additive).
 *
 * The ask names no path on purpose: what the discovery reads is the DIRECTORY the
 * entry is scoped to (the turn's cwd), not a path inside the goal — so these cases
 * exercise the real discovery against this repository without depending on one.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConfigManager } from '../../src/config/manager.js';
import type { InferenceProvider, ToolCallResponse, ToolMessage, ToolSchema } from '../../src/inference/interface.js';

const AUDIT_GOAL =
  'Assess the project in the current directory and identify the bugs in it. For every bug you find, ' +
  'report the file and line and a severity. Do not modify any files — this is an assessment only.';
const CHANGE_GOAL = 'fix the sorting bug in utils.ts';

/** A provider that records the messages the entry actually sent. */
function capturing(): { provider: InferenceProvider; seen: () => readonly ToolMessage[] } {
  let seen: readonly ToolMessage[] = [];
  const provider = {
    name: 'Scripted',
    async generate(): Promise<string> {
      return 'ok';
    },
    async generateTools(messages: ToolMessage[], _tools: ToolSchema[]): Promise<ToolCallResponse> {
      seen = messages;
      return { content: 'ok', toolCalls: [] };
    },
  } as unknown as InferenceProvider;
  return { provider, seen: () => seen };
}

const PROTOCOL_HEADER = 'TASK PROTOCOL: PROJECT ASSESSMENT';

afterEach(() => {
  vi.doUnmock('../../src/cli/router.js');
  vi.doUnmock('../../src/agents/orchestrator.js');
  vi.resetModules();
});

describe('the loop entry (`nuvira execute`) carries the assessment section', () => {
  const runLoop = async (goal: string): Promise<readonly ToolMessage[]> => {
    vi.resetModules();
    const { provider, seen } = capturing();
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor(goal, new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      skipSkillHint: true,
      quiet: true,
    });
    expect(result.generationFailed).toBe(false);
    return seen();
  };

  it('hands an audit ask the rules — including the project\'s own checks', async () => {
    const messages = await runLoop(AUDIT_GOAL);
    const protocol = messages.find((m) => m.content.includes(PROTOCOL_HEADER));
    expect(protocol, 'the loop entry sent no protocol block').toBeDefined();
    expect(protocol!.role).toBe('user');
    expect(protocol!.content).toContain('CHECK THE SEAMS, NOT ONLY THE MODULES');
    expect(protocol!.content).toContain('RUN WHAT THE PROJECT ALREADY SHIPS');
    // This repository declares its own checks, so the discovered section rides along.
    expect(protocol!.content).toMatch(/This project's own checks/);
  });

  it('sends nothing extra for an ordinary change request', async () => {
    const messages = await runLoop(CHANGE_GOAL);
    expect(messages.some((m) => m.content.includes(PROTOCOL_HEADER))).toBe(false);
    // The ask itself still arrives untouched.
    expect(messages.some((m) => m.content.includes(CHANGE_GOAL))).toBe(true);
  });
});

describe('the pipeline entry (the gateway`s engine) carries it too', () => {
  it('appends the rules to the goal the orchestrator runs', async () => {
    vi.resetModules();
    const executeMock = vi.fn().mockResolvedValue({
      success: true,
      summary: 'done',
      tasksCompleted: 1,
      tasksTotal: 1,
      agentResults: [],
      fileChanges: 'none',
    });
    vi.doMock('../../src/agents/orchestrator.js', () => ({
      Orchestrator: class {
        execute = executeMock;
      },
    }));
    const { runPipelineTool } = await import('../../src/tools/pipeline-tool.js');

    await runPipelineTool(AUDIT_GOAL, {} as never, { board: false, mode: 'dev' });
    expect(executeMock).toHaveBeenCalledTimes(1);
    const [goalArg] = executeMock.mock.calls[0] as [string];
    expect(goalArg).toContain(AUDIT_GOAL);
    expect(goalArg).toContain(PROTOCOL_HEADER);
  });

  it('does not touch an ordinary goal', async () => {
    vi.resetModules();
    const executeMock = vi.fn().mockResolvedValue({
      success: true,
      summary: 'done',
      tasksCompleted: 1,
      tasksTotal: 1,
      agentResults: [],
      fileChanges: 'none',
    });
    vi.doMock('../../src/agents/orchestrator.js', () => ({
      Orchestrator: class {
        execute = executeMock;
      },
    }));
    const { runPipelineTool } = await import('../../src/tools/pipeline-tool.js');

    const configManager = { getWorkspaceStore: () => ({}) } as never;
    await runPipelineTool(CHANGE_GOAL, configManager, { board: false, mode: 'dev' });
    const [goalArg] = executeMock.mock.calls[0] as [string];
    expect(goalArg).toBe(CHANGE_GOAL);
  });
});
