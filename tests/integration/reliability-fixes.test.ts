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
import { resetLearnedMaxTokensLimits } from '../../src/learning/provider-limits.js';

const root = mkdtempSync(join(tmpdir(), 'buff-relfix-'));
const cfgDir = join(root, '.nuvira');
const memDir = join(root, '.nuvira', 'memory');
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;
const ORIG_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;

beforeAll(() => {
  mkdirSync(memDir, { recursive: true });
  process.env.NUVIRA_CONFIG_DIR = cfgDir;
  process.env.NUVIRA_MEMORY_DIR = memDir;
});

afterAll(() => {
  // Close the SQLite workspace handle BEFORE removing the dir — an open
  // workspaces.db makes rmSync fail on Windows (EBUSY).
  resetWorkspaceStore();
  if (ORIG_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = ORIG_CONFIG_DIR;
  if (ORIG_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIG_MEMORY_DIR;
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
    // G15 learned caps are process-local; each test starts from none learned.
    resetLearnedMaxTokensLimits();
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
      // This case pins the ONE-SHOT writer's parse discipline (Session 46):
      // its `filepath:` fence format, its strict-format retry, and its
      // failure classification. The tool-calling writer is the default now
      // and speaks a different protocol — covered by the test below.
      useToolCalling: false,
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
      useToolCalling: false, // one-shot writer's parse-failure path (see above)
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
      useToolCalling: false, // one-shot writer/reviewer protocol (see above)
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

  it('the DEFAULT tool-calling writer cannot report a false success either', async () => {
    // Writer-tc protocol: prose alone proposes nothing. Attempt 1 is prose
    // (no tool call) → the writer must FAIL, not stamp success:true; the
    // repair re-prompt then emits a real propose_change tool call, which the
    // loop executes, followed by the model's closing text.
    // NOTE the double-escaped \n INSIDE the JSON string: a real newline makes
    // the payload invalid JSON, the tool call never parses, and the test would
    // silently measure the parse-failure path instead of the recovery path.
    const TOOL_CALL =
      '```json\n' +
      '{"tool":"propose_change","args":{"path":"addon/addon_handler.py",' +
      '"content":"import globalVars\\n\\ndef onInit():\\n    pass\\n"}}\n' +
      '```';
    const fake = fakeProvider([UNPARSEABLE_PROSE, TOOL_CALL, 'Done — registered the gesture.']);
    createSpy.mockImplementation(() => fake as any);

    const result = await orchestrator.execute('Build the NVDA addon shortcut', {
      provider: 'local',
      model: 'test-model',
      prefillPlan: [WRITER_STEP],
      dryRun: true,
      // no useToolCalling → the DEFAULT (iterative) writer
    });

    // It recovered through repair and the deliverable really exists.
    expect(result.stats?.repairAttempts).toBeGreaterThanOrEqual(1);
    expect(result.stats?.recoveredFailures).toBe(1);
    expect(result.fileChanges).toContain('addon/addon_handler.py');
    // The first (prose-only) attempt failed loudly rather than reporting
    // success with an empty deliverable — the repair prompt proves it reached
    // the repair engine.
    expect(fake.prompts.some((p) => p.includes('[REPAIR ATTEMPT 1]'))).toBe(true);
  });

  // ── G15: a provider that NAMES its output cap must not fail every step ────
  //
  // The live unattended story run failed EVERY prose unit with a Groq 400
  // (`max_tokens` must be <= 512) because our own call asked for 8192. These
  // tests pin the two halves of the fix against a fake provider that enforces
  // the cap for real: the named limit is learned, and the learn-from-error path
  // is the orchestrator's SINGLE call point — so it covers every agent.
  const GROQ_CAP_400 =
    'Groq API error (400): {"error":{"message":"`max_tokens` must be less than ' +
    'or equal to `512`, the maximum value for `max_tokens` is less than the ' +
    '`context_window` for this model","type":"invalid_request_error","param":"max_tokens"}}';

  /** Provider that rejects any request above its real output cap. */
  function cappedProvider(cap: number) {
    const seen: number[] = [];
    const generate = vi.fn(async (_prompt: string, options?: { maxTokens?: number }) => {
      const asked = options?.maxTokens ?? 0;
      seen.push(asked);
      if (asked > cap) throw new Error(GROQ_CAP_400);
      return HANDLER_FILE;
    });
    return { generate, seen };
  }

  it('a provider-named output cap is obeyed on retry instead of failing the step', async () => {
    const fake = cappedProvider(512);
    createSpy.mockImplementation(() => fake as any);

    const result = await orchestrator.execute('Build the NVDA addon shortcut', {
      provider: 'local',
      model: 'test-model',
      prefillPlan: [WRITER_STEP],
      dryRun: true,
      useToolCalling: false,
    });

    // The step SUCCEEDS: the cap is our misconfiguration, not a broken model.
    expect(result.success).toBe(true);
    expect(result.fileChanges).toContain('addon/addon_handler.py');
    // The first send genuinely exceeded the cap, and the retry used the number
    // the provider itself named — not a smaller guess, not 8192 again.
    expect(fake.seen[0]).toBeGreaterThan(512);
    expect(fake.seen[1]).toBe(512);
  });

  it('the learned cap is applied predictively to later calls (one rejection, not one per call)', async () => {
    const fake = cappedProvider(512);
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
      useToolCalling: false,
    });

    expect(result.success).toBe(true);
    // Exactly ONE call was ever rejected. Without the learned cap, every
    // request above 512 would be rejected and the 400 would repeat per step —
    // which is what made the live run burn 6 batches on the same mistake.
    const rejected = fake.seen.filter((n) => n > 512);
    expect(rejected).toHaveLength(1);
  });
});
