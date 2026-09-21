/**
 * `nuvira execute` loop engine — tool-call ARTIFACTS never reach the user.
 *
 * Live defect (captured in a real run's log): the execute loop printed the
 * model's `**suggest_followups**` caption plus its raw JSON payload as if it
 * were the answer, while the gateway and the dashboard console both stripped
 * the same artifact. The keep-alive fix is that ONE helper
 * (`stripToolCallArtifacts`) backs every surface — these tests pin the CLI arm
 * of that contract, on both the human and the `--json-events` paths.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const runLoopExecutor = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/loop-executor.js', () => ({ runLoopExecutor }));

import { ExecuteCommand, printOrchestrationResult } from '../../src/cli/execute.js';
import { logger } from '../../src/utils/logger.js';
import type { OrchestrationResult } from '../../src/agents/orchestrator.js';

/** Verbatim from the live `nuvira execute` run. */
const LEAK = `Would you like to dive deeper into any of these phases, or need help choosing a stack?  

**suggest_followups**  
\`\`\`json
{
  "followups": [
    { "label": "Choose Stack", "prompt": "Compare Electron vs Qt." }
  ]
}
\`\`\`
`;

function loopResult(content: string) {
  return {
    content,
    generationFailed: false,
    bounded: false,
    toolCalls: [],
    erroredTools: [],
    durationMs: 5,
    provider: 'gemini',
    model: 'gemini-3.1-flash-lite',
    engineExplanation: 'strong model → loop',
  };
}

describe('ExecuteCommand — loop-engine artifact stripping', () => {
  let cmd: ExecuteCommand;
  let memDir: string;

  beforeEach(() => {
    runLoopExecutor.mockReset();
    memDir = mkdtempSync(join(tmpdir(), 'buff-exec-artifacts-'));
    process.env.NUVIRA_MEMORY_DIR = memDir;
    cmd = new ExecuteCommand();
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NUVIRA_MEMORY_DIR;
    try {
      rmSync(memDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('prints only the answer — the caption and the raw payload are stripped', async () => {
    runLoopExecutor.mockResolvedValue(loopResult(LEAK));
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      printed.push(args.map((a) => String(a)).join(' '));
    });

    await (cmd as any).runLoopEngineGoal('build me a calculator', 'gemini', 'gemini-3.1-flash-lite', {});

    const text = printed.join('\n');
    expect(text).toContain('Would you like to dive deeper into any of these phases');
    expect(text).not.toContain('suggest_followups');
    expect(text).not.toContain('"followups"');
    expect(text).not.toContain('"prompt"');
  });

  it('the --json-events summary is stripped too (scripts see the answer, not the plumbing)', async () => {
    runLoopExecutor.mockResolvedValue(loopResult(LEAK));
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    await (cmd as any).runLoopEngineGoal('build me a calculator', 'gemini', 'gemini-3.1-flash-lite', {
      jsonEvents: true,
    });

    const event = JSON.parse(chunks.join('').trim().split('\n').pop() as string) as { summary: string };
    expect(event.summary).toContain('Would you like to dive deeper');
    expect(event.summary).not.toContain('suggest_followups');
    expect(event.summary).not.toContain('"followups"');
  });

  it('a clean answer is passed through untouched', async () => {
    const clean = 'Here is your project plan.\n\n1. Requirements\n2. Build\n3. Ship';
    runLoopExecutor.mockResolvedValue(loopResult(clean));
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      printed.push(args.map((a) => String(a)).join(' '));
    });

    await (cmd as any).runLoopEngineGoal('build me a calculator', 'gemini', 'gemini-3.1-flash-lite', {});

    expect(printed.join('\n')).toContain(clean);
  });
});

/**
 * Verbatim from a live `nuvira execute` run: the model's own reasoning was the
 * printed answer. The loop engine now REJECTS this at generation time; these
 * tests pin the render site's last line of defence on the same surfaces the
 * artifact tests above cover.
 */
const REASONING_REPLY = [
  'The user wants a project plan for a "multiple screen calculator and unit converter" with a GUI and cross-platform support.',
  '',
  'I should use the `plan_todo` tool to create a structured plan.',
].join('\n');

/** Thinking PREFIXED onto a real (if rough) deliverable — must be salvaged. */
const REASONING_THEN_ANSWER = [
  'The user is asking for a calculator plan.',
  '',
  '**Calculator plan**',
  '1. Core engine — expression parser + conversion tables.',
  '2. GUI — one screen per mode.',
].join('\n');

describe('ExecuteCommand — a leaked reasoning trace never reaches the CLI', () => {
  let cmd: ExecuteCommand;
  let memDir: string;

  beforeEach(() => {
    runLoopExecutor.mockReset();
    memDir = mkdtempSync(join(tmpdir(), 'buff-exec-reasoning-'));
    process.env.NUVIRA_MEMORY_DIR = memDir;
    cmd = new ExecuteCommand();
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NUVIRA_MEMORY_DIR;
    try {
      rmSync(memDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('suppresses a reasoning-only answer and reports it as a FAILURE', async () => {
    runLoopExecutor.mockResolvedValue(loopResult(REASONING_REPLY));
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      printed.push(args.map((a) => String(a)).join(' '));
    });

    const outcome = await (cmd as any).runLoopEngineGoal(
      'Develop the calculator as per the plan created by agent-nuvira',
      'gemini',
      'gemini-3.1-flash-lite',
      {},
    );

    const text = printed.join('\n');
    expect(text).not.toContain('The user wants a project plan');
    expect(text).not.toContain('plan_todo');
    expect(text).toContain('switch models');
    // A suppressed reply is not a success — the old behaviour reported one and
    // cached the thinking for an hour.
    expect(outcome.success).toBe(false);
  });

  it('the --json-events verdict is a failure too (no consumer sees the trace)', async () => {
    runLoopExecutor.mockResolvedValue(loopResult(REASONING_REPLY));
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    await (cmd as any).runLoopEngineGoal('develop the calculator', 'gemini', undefined, {
      jsonEvents: true,
    });

    const event = JSON.parse(chunks.join('').trim().split('\n').pop() as string) as {
      success: boolean;
      summary: string;
    };
    expect(event.success).toBe(false);
    expect(event.summary).not.toContain('The user wants a project plan');
  });

  it('salvages the real deliverable sitting behind a trace', async () => {
    runLoopExecutor.mockResolvedValue(loopResult(REASONING_THEN_ANSWER));
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      printed.push(args.map((a) => String(a)).join(' '));
    });

    const outcome = await (cmd as any).runLoopEngineGoal('get me a calculator plan', 'gemini', undefined, {});

    const text = printed.join('\n');
    expect(text).toContain('**Calculator plan**');
    expect(text).toContain('Core engine');
    expect(text).not.toContain('The user is asking for a calculator plan');
    expect(outcome.success).toBe(true);
  });
});

describe('printOrchestrationResult — a traced agent summary is not relayed', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the honest line instead of the model\'s working notes', () => {
    const result = {
      goal: 'develop the calculator',
      success: false,
      summary: REASONING_REPLY,
      error: '',
      fileChanges: 'No files changed.',
      runOutput: '',
      agentResults: [
        { agent: 'Reasoner', success: true, summary: REASONING_REPLY },
        { agent: 'Planner', success: true, summary: 'Created 7 task steps' },
      ],
      tasksCompleted: 0,
      tasksTotal: 7,
      trajectoryId: '',
    } as unknown as OrchestrationResult;
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      printed.push(args.map((a) => String(a)).join(' '));
    });

    printOrchestrationResult(result);

    const text = printed.join('\n');
    expect(text).not.toContain('The user wants a project plan');
    expect(text).not.toContain('plan_todo');
    // Both the report summary and the Reasoner line are replaced by the honest
    // line — never silently dropped, so the reader can see something failed.
    expect(text).toContain('working notes');
    expect(text).toContain('Created 7 task steps');
  });
});

describe('printOrchestrationResult — the pipeline report is stripped too', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('strips the artifact from the summary and from each agent line', () => {
    const result = {
      goal: 'build me a calculator',
      success: true,
      summary: LEAK,
      error: '',
      fileChanges: 'No files changed.',
      runOutput: '',
      agentResults: [
        { agent: 'writer', success: true, summary: `Wrote the plan.\n\n**suggest_followups**\n\`\`\`json\n{"followups":[{"prompt":"Next?"}]}\n\`\`\`` },
      ],
      tasksCompleted: 1,
      tasksTotal: 1,
      trajectoryId: '',
    } as unknown as OrchestrationResult;
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      printed.push(args.map((a) => String(a)).join(' '));
    });

    printOrchestrationResult(result);

    const text = printed.join('\n');
    expect(text).toContain('Would you like to dive deeper');
    expect(text).toContain('Wrote the plan.');
    expect(text).not.toContain('suggest_followups');
    expect(text).not.toContain('"followups"');
  });
});
