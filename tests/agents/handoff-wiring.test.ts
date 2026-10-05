/**
 * Hand-off wiring — the three places the durable record has to actually land.
 *
 * A store nobody writes to, and a store nobody reads, both look identical from
 * the outside: the next attempt starts from zero. These tests pin the wiring
 * end to end, on the live shapes rather than convenient ones:
 *
 *   1. a REFUSED mutation in the tool loop leaves a hand-off (the NVDA-addon
 *      root cause: `write_file` was denied for a path outside the workspace, and
 *      every following attempt rediscovered that from scratch)
 *   2. the loop engine's project context CARRIES it into the next turn
 *   3. `assessProject` carries it into every pipeline agent's prompt
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runToolLoop,
  type StepResponse,
  type ToolLoopDeps,
} from '../../src/tools/tool-loop.js';
import type { ToolContext } from '../../src/tools/registry.js';
import { loadOpenHandoffs, recordStepHandoff } from '../../src/agents/step-handoff.js';
import { assessProject, assemblePrompt } from '../../src/agents/prompt-assembly.js';
import { buildLoopProjectContext } from '../../src/tools/loop-project-context.js';

/**
 * The live ask: it names a destination DIRECTORY and never names the package.
 * The destination is a temp path that does not exist, because on the machine
 * where this failure happened the real folder DID exist — and a hand-off that
 * reports nothing outstanding for an existing destination is correct.
 */
const TARGET_DIR = `${join(tmpdir(), `nuvira-addon-target-${process.pid}`, 'kuttaaddon')}/`;
const NVDA_GOAL =
  'can you develop an NVDA add on compatible to 2026.2 , when user presses NVDA key+alt+9 than it says ' +
  '"Mote butter, dekh ye addon whatsapp se bana hai" , Need a deplorable package for nvda deployment ' +
  `Save this in folder ${TARGET_DIR}`;

/** The destination the ask named — deliberately outside the workspace. */
const OUTSIDE = `${TARGET_DIR}manifest.ini`;

/** The workspace guard's own refusal text (src/tools/coding-tools.ts). */
const REFUSAL = `path '${OUTSIDE}' escapes the workspace (${'/some/other/workspace'}) — denied`;

let memDir: string;
let workspace: string;
let prevMemDir: string | undefined;

beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), 'nuvira-wiring-mem-'));
  workspace = mkdtempSync(join(tmpdir(), 'nuvira-wiring-ws-'));
  // `looksLikeProject` needs one project marker.
  writeFileSync(join(workspace, 'package.json'), '{"name":"probe"}\n');
  prevMemDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = memDir;
});

afterEach(() => {
  if (prevMemDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = prevMemDir;
  rmSync(memDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe('the tool loop records a refused mutation as a durable hand-off', () => {
  it('writes the refusal down, naming the path and the reason', async () => {
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'write_file', arguments: { path: OUTSIDE, content: '[addon]\n' } }],
      },
      { content: 'Done.', toolCalls: [] },
    ];
    let i = 0;
    const deps: ToolLoopDeps = {
      callModel: vi.fn(async () => script[Math.min(i++, script.length - 1)]),
      executeTool: vi.fn(async () => REFUSAL),
      onEvent: vi.fn(),
    };
    const context: ToolContext = {
      configManager: {},
      cwd: workspace,
      authorizationRequest: NVDA_GOAL,
    };

    await runToolLoop({
      messages: [{ role: 'user', content: NVDA_GOAL }],
      context,
      deps,
      maxSteps: 2,
      // The refusal is the subject here; the verification/deliverable gates only
      // add steps around it, and the plan gate would refuse the first write for a
      // different reason (no plan) before the workspace guard ever sees it.
      requireVerification: false,
      requireDeliverable: false,
      requirePlan: false,
    });

    const open = loadOpenHandoffs(workspace);
    expect(open).toHaveLength(1);
    expect(open[0]!.attempts[0]!.kind).toBe('refused');
    expect(open[0]!.attempts[0]!.reason).toContain('outside the workspace');
    // Keyed on the destination the ASK named, so the same work asked for in
    // different words finds it again.
    expect(open[0]!.declared).toContain(TARGET_DIR);
    expect(open[0]!.remaining).toContain(TARGET_DIR);
  });

  it('does NOT record an ordinary error as a refused mutation', async () => {
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'package.json' } }] },
      { content: 'Done.', toolCalls: [] },
    ];
    let i = 0;
    const deps: ToolLoopDeps = {
      callModel: vi.fn(async () => script[Math.min(i++, script.length - 1)]),
      executeTool: vi.fn(async () => 'Error: ENOENT no such file'),
      onEvent: vi.fn(),
    };

    await runToolLoop({
      messages: [{ role: 'user', content: NVDA_GOAL }],
      context: { configManager: {}, cwd: workspace, authorizationRequest: NVDA_GOAL },
      deps,
      maxSteps: 2,
      requireVerification: false,
      requireDeliverable: false,
    });

    // A failed READ is not outstanding work — only a refused mutation is.
    expect(loadOpenHandoffs(workspace)).toHaveLength(0);
  });
});

describe('the loop engine carries the hand-off into the next turn', () => {
  it('includes the unfinished work in the project context', async () => {
    recordStepHandoff({
      projectPath: workspace,
      goal: NVDA_GOAL,
      stepDescription: 'Create manifest.ini',
      declared: ['manifest.ini'],
      route: 'gemini:gemini-2.0-flash',
      kind: 'failed',
      reason: 'the provider returned an empty response',
    });

    const block = await buildLoopProjectContext(workspace);
    expect(block).toContain('## Unfinished work (hand-off)');
    expect(block).toContain('manifest.ini');
    expect(block).toContain('empty response');
  });

  it('adds nothing for a clean project', async () => {
    const block = await buildLoopProjectContext(workspace);
    expect(block).not.toContain('hand-off');
  });
});

describe('every pipeline agent prompt carries the hand-off', () => {
  it('assessProject populates openHandoffs when work is outstanding', () => {
    recordStepHandoff({
      projectPath: workspace,
      goal: NVDA_GOAL,
      stepDescription: 'Create manifest.ini',
      declared: ['manifest.ini'],
      route: 'gemini:gemini-2.0-flash',
      kind: 'failed',
      reason: 'the provider returned an empty response',
    });

    const assessment = assessProject(workspace);
    expect(assessment.openHandoffs).toBeTruthy();
    expect(assessment.openHandoffs).toContain('still missing: manifest.ini');
    expect(assessment.openHandoffs).toContain('Create manifest.ini');
  });

  it('leaves openHandoffs undefined for a clean project (no prompt weight)', () => {
    expect(assessProject(workspace).openHandoffs).toBeUndefined();
  });

  it('assemblePrompt places the hand-off in the project-context layer', () => {
    const text = assemblePrompt(
      'SYSTEM',
      {
        isGreenfield: false,
        hasTests: false,
        keyFiles: [],
        openHandoffs: '[Hand-off — earlier attempts did NOT finish]\n• still missing: manifest.ini',
      },
      'Create manifest.ini',
      'writer',
    );
    expect(text).toContain('# Project Context');
    expect(text).toContain('still missing: manifest.ini');
    expect(text).toContain('## Task\nCreate manifest.ini');
  });
});
