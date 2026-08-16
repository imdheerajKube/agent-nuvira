/**
 * Session 46 — Reliability-fix E2E (the NVDA-run scenario).
 *
 * Drives the REAL Orchestrator.execute() pipeline (no planner — prefillPlan)
 * against a scripted fake LLM to prove the two fixes end-to-end:
 *
 *   1. A WRITER that produces unparseable output FAILS the task (no more
 *      masked success:true / "No files needed changes") and the repair
 *      engine recovers it on a re-prompt — the deliverable is actually
 *      produced, or the failure is surfaced.
 *   2. A REVIEWER "blocked" verdict triggers the WRITER FIX PASS (the repair
 *      goal carries "[REVIEW FEEDBACK — FIX THESE ISSUES]") and the re-review
 *      is the gate — instead of re-running the reviewer on unchanged code
 *      until the budget dies.
 *
 * Hermetic: temp BUFF_CONFIG_DIR + BUFF_MEMORY_DIR, ProviderFactory spied to
 * return a scripted fake adapter — no network, no real models, no disk writes
 * (dryRun).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Orchestrator } from '../../src/agents/orchestrator.js';
import { ProviderFactory } from '../../src/inference/factory.js';
import { resetWorkspaceStore } from '../../src/config/workspace.js';

const root = mkdtempSync(join(tmpdir(), 'buff-relfix-'));
const cfgDir = join(root, '.buff');
const memDir = join(root, '.buff', 'memory');
const ORIG_CONFIG_DIR = process.env.BUFF_CONFIG_DIR;
const ORIG_MEMORY_DIR = process.env.BUFF_MEMORY_DIR;

beforeAll(() => {
  mkdirSync(memDir, { recursive: true });
  process.env.BUFF_CONFIG_DIR = cfgDir;
  process.env.BUFF_MEMORY_DIR = memDir;
});

afterAll(() => {
  // Close the SQLite workspace handle BEFORE removing the dir — an open
  // workspaces.db makes rmSync fail on Windows (EBUSY).
  resetWorkspaceStore();
  if (ORIG_CONFIG_DIR === undefined) delete process.env.BUFF_CONFIG_DIR;
  else process.env.BUFF_CONFIG_DIR = ORIG_CONFIG_DIR;
  if (ORIG_MEMORY_DIR === undefined) delete process.env.BUFF_MEMORY_DIR;
  else process.env.BUFF_MEMORY_DIR = ORIG_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true });
});

/** A fake provider whose generate() pops scripted responses (last one repeats). */
function fakeProvider(script: string[]) {
  const prompts: string[] = [];
  const generate = vi.fn(async (prompt: string) => {
    prompts.push(prompt);
    return script.shift() ?? 'I will outline my approach below.';
  });
  return { generate, prompts };
}

const UNPARSEABLE_PROSE =
  'I will implement the handler now. First the imports, then the gesture registration logic.';
const NOOP_DECLINE = 'No changes needed — the file already implements the required functionality.';
const HANDLER_FILE = '```filepath:addon/addon_handler.py\nimport globalVars\n\ndef onInit():\n    pass\n```';
const CRITICAL_REVIEW = 'CRITICAL: shortcut handler missing.\nLocation: addon/addon_handler.py\nFix: register the gesture.';
const PASS_REVIEW = 'Review passed. No issues found.';

const WRITER_STEP = {
  id: 'step-1',
  agentType: 'writer',
  description: 'Implement the core logic in addon_handler.py: register NVDA key + alt + 1 to speak "Hello Ria Mote"',
  dependsOn: [] as string[],
  status: 'pending' as const,
  complexity: 'moderate' as const,
};

describe('Session 46 reliability fixes — end-to-end', () => {
  let orchestrator: Orchestrator;
  let createSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    orchestrator = new Orchestrator();
    createSpy = vi.spyOn(ProviderFactory, 'createProvider');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writer parse-failure is NOT masked: repair recovers it and the deliverable is produced', async () => {
    // Script: attempt 1 + strict-format retry both unparseable → the writer
    // FAILS loudly; repair re-prompt (attempt 3) finally emits the file.
    const fake = fakeProvider([UNPARSEABLE_PROSE, UNPARSEABLE_PROSE, HANDLER_FILE]);
    createSpy.mockImplementation(() => fake as any);

    const result = await orchestrator.execute('Build the NVDA addon shortcut', {
      provider: 'local',
      model: 'test-model',
      prefillPlan: [WRITER_STEP],
      dryRun: true,
    });

    // The task recovered via repair — and the actual file change exists
    // (the old code would have shown ✅ "No files needed changes" with an
    // empty deliverable).
    expect(result.success).toBe(true);
    expect(result.stats?.repairAttempts).toBeGreaterThanOrEqual(1);
    expect(result.stats?.recoveredFailures).toBe(1);
    const writer = result.agentResults.find((a) => a.agent === 'writer');
    expect(writer?.success).toBe(true);
    expect(writer?.summary).toContain('Proposed changes to 1 file');
    expect(result.fileChanges).toContain('addon/addon_handler.py');
    // The writer was re-prompted with a repair-suffixed goal — proof the
    // failure reached the repair engine instead of being masked.
    expect(fake.generate).toHaveBeenCalledTimes(3);
    expect(fake.prompts[2]).toContain('[REPAIR ATTEMPT 1]');
  });

  it('writer that can never parse FAILS the pipeline loudly (no false success)', async () => {
    const fake = fakeProvider([UNPARSEABLE_PROSE]);
    createSpy.mockImplementation(() => fake as any);

    const result = await orchestrator.execute('Build the NVDA addon shortcut', {
      provider: 'local',
      model: 'test-model',
      prefillPlan: [WRITER_STEP],
      dryRun: true,
    });

    // Every attempt (initial + retry + 3 repair re-prompts) produced no
    // parseable output → the step fails with the parse-failure surfaced.
    expect(result.success).toBe(false);
    const writer = result.agentResults.find((a) => a.agent === 'writer');
    expect(writer?.success).toBe(false);
    expect(writer?.summary).toContain('Repair budget exhausted');
    // The raw parse-failure error reached the repair engine (classified
    // llm-error, escalated) — not stamped as a silent success.
    expect(result.fileChanges).not.toContain('addon/addon_handler.py');
  });

  it('reviewer-blocked routes to a WRITER FIX PASS and the re-review is the gate', async () => {
    const fake = fakeProvider([HANDLER_FILE, CRITICAL_REVIEW, HANDLER_FILE, PASS_REVIEW]);
    createSpy.mockImplementation(() => fake as any);

    const result = await orchestrator.execute('Build the NVDA addon shortcut', {
      provider: 'local',
      model: 'test-model',
      prefillPlan: [
        WRITER_STEP,
        {
          id: 'step-2',
          agentType: 'reviewer',
          description: 'Review the complete addon code',
          dependsOn: ['step-1'],
          status: 'pending' as const,
          complexity: 'complex' as const,
        },
      ],
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.stats?.recoveredFailures).toBe(1);
    const reviewer = result.agentResults.find((a) => a.agent === 'reviewer');
    expect(reviewer?.summary).toBe('Review passed');

    // 4 LLM calls: writer → blocked review → FIX-PASS writer (goal carries
    // the review feedback) → passing re-review.
    expect(fake.generate).toHaveBeenCalledTimes(4);
    expect(fake.prompts[2]).toContain('[REVIEW FEEDBACK — FIX THESE ISSUES]');
    expect(fake.prompts[2]).toContain('CRITICAL: shortcut handler missing');
    // The re-review prompt reviews the (fixed) changes — the writer step
    // description is embedded in the review prompt.
    expect(fake.prompts[3]).toContain('Implement the core logic in addon_handler.py');
    expect(fake.prompts[3]).toContain('## Changes to Review');
  });
});
