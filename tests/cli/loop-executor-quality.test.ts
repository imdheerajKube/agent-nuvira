/**
 * LOOP-ENGINE answer quality — `nuvira execute` and every pipeline run must not
 * ship the model's own reasoning (or its narration of the tool contract) as the
 * answer.
 *
 * Live evidence (2026-09-21, a real `nuvira execute` run whose tool calls
 * SUCCEEDED — `plan_todo` + `suggest_followups` both fired):
 *
 *   The user wants a project plan for a "multiple screen calculator and unit
 *   converter" with a GUI and cross-platform support.
 *
 *   I should use the `plan_todo` tool to create a structured plan.
 *   The plan should include: 1. Requirements Analysis & Design …
 *
 * That text WAS the printed answer. The chat engine has rejected this class
 * since `confuseCheck` was added, but the loop executor — the engine behind
 * `execute` and the pipeline — had no quality check at all, and a quality
 * failure never throws on its own, so the failover walk accepted it AND the
 * turn was reported as a success.
 *
 * These tests pin the gate on the executor itself: the DEV ask below is exactly
 * the shape a user sends when they want software built ("Get me a plan for a
 * calculator" → then "Develop the calculator as per the plan"), and it must not
 * be answered with thinking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../../src/config/manager.js';
import { logger } from '../../src/utils/logger.js';
import type {
  InferenceProvider,
  ToolCallResponse,
  ToolMessage,
  ToolSchema,
} from '../../src/inference/interface.js';

/** Verbatim opening of the answer a live `nuvira execute` run printed. */
const REASONING_REPLY = [
  'The user wants a project plan for a "multiple screen calculator and unit converter" with a GUI and cross-platform support (Windows and Linux).',
  '',
  'I should use the `plan_todo` tool to create a structured plan.',
  'The plan should include:',
  '1. Requirements Analysis & Design (GUI framework choice, features).',
  '2. Project Setup (Environment, version control).',
].join('\n');

/** Verbatim shape from the live inbox ledger — contract meta-talk. */
const CONFUSION_REPLY =
  "I'm sorry, but the provided example call to suggest_followups is incomplete. Could you please provide more context?";

/**
 * A scripted provider that answers EVERY attempt with the same reply — the
 * point is that no candidate in the walk produces something deliverable, so the
 * turn must end as an honest failure regardless of how many providers the host
 * machine happens to have configured.
 */
function scriptedProvider(opts: {
  native?: boolean;
  responses?: ToolCallResponse[];
  fallbackText?: string[];
}): InferenceProvider {
  let nativeIdx = 0;
  let fallbackIdx = 0;
  return {
    name: 'Scripted',
    async generate(): Promise<string> {
      throw new Error('generate() should not be reached when generateStream exists');
    },
    async generateStream(_prompt: string, _options: unknown, onToken?: (t: string) => void): Promise<string> {
      const text = opts.fallbackText?.[fallbackIdx++] ?? opts.fallbackText?.[0] ?? 'no more output';
      onToken?.(text);
      return text;
    },
    // Only present for the native transport — its ABSENCE is what makes the
    // executor take the JSON-fallback path (which has its own gate to check).
    ...(opts.native
      ? {
          async generateTools(_messages: ToolMessage[], _tools: ToolSchema[]): Promise<ToolCallResponse> {
            const scripted = opts.responses?.[nativeIdx++] ?? opts.responses?.[0];
            return scripted ?? { content: 'no more output', toolCalls: [] };
          },
        }
      : {}),
  } as InferenceProvider;
}

describe('loop engine — a DEV ask is never answered with the model\'s thinking', () => {
  let memDir: string;

  beforeEach(() => {
    vi.resetModules();
    memDir = mkdtempSync(join(tmpdir(), 'buff-loop-quality-'));
    process.env.NUVIRA_MEMORY_DIR = memDir;
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'success').mockImplementation(() => {});
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

  async function run(goal: string, provider: InferenceProvider, quiet = true) {
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    // The module graph was reset, so the executor's logger is this fresh copy
    // — spying on the statically imported one would capture nothing.
    const { logger: loopLogger } = await import('../../src/utils/logger.js');
    const warnSpy = vi.spyOn(loopLogger, 'warn').mockImplementation(() => {});
    const result = await runLoopExecutor(goal, new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      quiet,
    });
    return { result, warned: warnSpy.mock.calls.map((c) => String(c[0])).join('\n') };
  }

  it('rejects a reasoning reply and reports an honest failure (never the trace)', async () => {
    const provider = scriptedProvider({
      native: true,
      responses: [{ content: REASONING_REPLY, toolCalls: [] }],
    });
    const { result } = await run(
      'Develop the calculator as per the plan created by agent-nuvira',
      provider,
    );

    // The thinking is not the answer…
    expect(result.content).not.toContain('The user wants a project plan');
    expect(result.content).not.toContain('I should use the `plan_todo` tool');
    // …the turn is a FAILURE (never cached, never reported as done)…
    expect(result.generationFailed).toBe(true);
    // …and the user is told the real cause, not "the model was unavailable".
    expect(result.content).not.toContain('language model was unavailable');
    expect(result.content).toContain('switch models');
  });

  it('drives the failover walk — the rejected candidate is not the end of the turn', async () => {
    const provider = scriptedProvider({
      native: true,
      responses: [{ content: REASONING_REPLY, toolCalls: [] }],
    });
    const { warned } = await run(
      'Develop the calculator as per the plan created by agent-nuvira',
      provider,
      false,
    );

    expect(warned).toMatch(/its own reasoning instead of the task/);
    expect(warned).toMatch(/trying the next loop candidate/);
  });

  it('rejects contract meta-talk on this surface too', async () => {
    const provider = scriptedProvider({
      native: true,
      responses: [{ content: CONFUSION_REPLY, toolCalls: [] }],
    });
    const { result, warned } = await run('Build the calculator app', provider, false);

    expect(result.content).not.toContain('example call to suggest_followups');
    expect(result.generationFailed).toBe(true);
    expect(warned).toMatch(/tool-contract confusion/);
  });

  it('rejects a reasoning reply over the JSON fallback transport as well', async () => {
    const provider = scriptedProvider({ fallbackText: [REASONING_REPLY] });
    const { result } = await run('Build the calculator app', provider);

    expect(result.content).not.toContain('The user wants a project plan');
    expect(result.generationFailed).toBe(true);
  });

  it('does not burn a TOOL CALL for a legitimate action narration', async () => {
    // The two-tier rule: a step that is ACTING may open by narrating the action
    // ("I will check the project files.") before its tool call. Rejecting it
    // would throw that call away — measured on the JSON-fallback transport,
    // whose real lead-in `I will check.` was flagged as deliberation and the
    // step's `list_dir` call was lost.
    const provider = scriptedProvider({
      native: true,
      responses: [
        {
          content: 'I will check the project files.',
          toolCalls: [{ id: 'c1', name: 'list_dir', arguments: { path: '.' } }],
        },
        { content: 'The project has src/ and tests/.', toolCalls: [] },
      ],
    });
    const { result } = await run('list the project files', provider);

    expect(result.generationFailed).toBe(false);
    expect(result.toolCalls).toEqual(['list_dir']);
    expect(result.content).toBe('The project has src/ and tests/.');
  });

  it('accepts a genuine development answer (the guard must not burn real work)', async () => {
    const plan = [
      '**Calculator + Unit Converter — implementation plan**',
      '',
      '1. **Core engine** — expression parser, RPN evaluator, conversion tables (length, mass, temperature).',
      '2. **GUI** — Python + Flet, one screen per mode, shared result panel.',
      '3. **Packaging** — PyInstaller for Windows, AppImage for Linux.',
      '',
      'Shall I start with the expression parser?',
    ].join('\n');
    const provider = scriptedProvider({
      native: true,
      responses: [{ content: plan, toolCalls: [] }],
    });
    const { result } = await run(
      'Create a project plan to develop a multiple screen calculator',
      provider,
    );

    expect(result.content).toBe(plan);
    expect(result.generationFailed).toBe(false);
  });
});
