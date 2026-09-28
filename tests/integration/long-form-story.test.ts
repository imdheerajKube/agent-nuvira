/**
 * END-TO-END — the WhatsApp 100-page story, on the hardened agent.
 *
 * This drives the REAL Orchestrator (real reasoner, real planner, real plan
 * replacement, real writer prose path, real file writes, real ledger) and only
 * the model is scripted. The script is deliberately hostile: the reasoner and
 * the planner return EXACTLY what the live run returned — a Python script that
 * would write the story — because the whole point of G7/G8 is that the agent's
 * own structure must not be able to deliver that plan.
 *
 * Baseline for comparison (the live session, 32 minutes, 6 orchestrator runs):
 *   plan      : context-gatherer, "Create a Python script …", runner, reviewer
 *   prose     : ZERO units — no step wrote any text
 *   on disk   : /Users/dheeraj/Documents/story/ did not exist
 *   result    : every run reported failure; the target was never produced
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Orchestrator } from '../../src/agents/orchestrator.js';
import { ProviderFactory } from '../../src/inference/factory.js';
import { resetWorkspaceStore } from '../../src/config/workspace.js';
import { clearLongFormJobs, findInProgressJob, countWords } from '../../src/learning/long-form.js';

const root = mkdtempSync(join(tmpdir(), 'buff-story-e2e-'));
const cfgDir = join(root, '.nuvira');
const memDir = join(root, '.nuvira', 'memory');
const projectDir = join(root, 'story');
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;
const ORIG_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;
const ORIG_CWD = process.cwd();

beforeAll(() => {
  mkdirSync(memDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  process.env.NUVIRA_CONFIG_DIR = cfgDir;
  process.env.NUVIRA_MEMORY_DIR = memDir;
});

afterAll(() => {
  process.chdir(ORIG_CWD);
  resetWorkspaceStore();
  if (ORIG_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = ORIG_CONFIG_DIR;
  if (ORIG_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIG_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  process.chdir(projectDir);
  clearLongFormJobs();
});

afterEach(() => {
  process.chdir(ORIG_CWD);
  vi.restoreAllMocks();
});

/** The verbatim goal from the failing WhatsApp session. */
const STORY_GOAL =
  'Continue , take multiple iterations if required- draft a plan and create story by getting detailed plan executed, ' +
  'I will appreciate if a pdf is created with 100 page story leveling to details like Harry Potter styles on magic and suspense.';

/** The reasoner decision the LIVE run produced (Python + reportlab). */
const MISFRAMED_DECISION = JSON.stringify({
  language: 'python',
  framework: 'none',
  platform: 'cli',
  architecture: 'multi-file',
  dependencies: ['os'],
  buildCommand: 'none',
  deliverable: 'markdown_file',
  constraints: ['Must append content to Mahagatha.md'],
  isGreenfield: false,
  confidence: 0.95,
  reasoning: 'The project already uses Python; a Python script is the most efficient way.',
});

/** The PLAN the live run produced — zero prose steps. */
const MISFRAMED_PLAN = JSON.stringify([
  { id: 'step-01-gather-context', description: 'Read existing chapters from the story directory.', agentType: 'context-gatherer', complexity: 'simple', dependsOn: [] },
  { id: 'step-02-write-content', description: "Create a Python script to append the story continuation to Mahagatha.md", agentType: 'writer', complexity: 'moderate', dependsOn: ['step-01-gather-context'] },
  { id: 'step-03-execute-update', description: 'Run the Python script to update Mahagatha.md', agentType: 'runner', complexity: 'simple', dependsOn: ['step-02-write-content'] },
  { id: 'step-04-review', description: 'Review the updated file', agentType: 'reviewer', complexity: 'simple', dependsOn: ['step-03-execute-update'] },
]);

/**
 * A prompt-aware fake provider: the two decision layers return the LIVE
 * (hostile) answers, and the author path returns real prose of a measurable
 * length, keyed to the unit it was asked for.
 */
function storyProvider() {
  const prompts: string[] = [];
  const generate = vi.fn(async (prompt: string) => {
    prompts.push(prompt);
    if (/senior software architect/.test(prompt)) return MISFRAMED_DECISION;
    if (/agentType: One of/.test(prompt)) return MISFRAMED_PLAN;
    if (/You are an author/.test(prompt)) {
      const unit = /unit (\d+) of (\d+)/.exec(prompt);
      const n = unit ? unit[1] : '?';
      return `Chapter ${n} of Mahagatha. `.repeat(4) + 'The lamp guttered in the hall as the door closed. '.repeat(90);
    }
    return 'ok';
  });
  return { generate, prompts };
}

function ledger() {
  const file = join(memDir, 'long-form.json');
  if (!existsSync(file)) return { jobs: {} as Record<string, { sections: Array<{ status: string; words: number; path: string }> }> };
  return JSON.parse(readFileSync(file, 'utf-8')) as { jobs: Record<string, { sections: Array<{ status: string; words: number; path: string }> }> };
}

// Every test here drives TWO real orchestrator runs (real reasoner, planner,
// plan replacement, writer prose path, file writes, ledger) against a scripted
// model. Measured ~3.6s each when nothing else runs, and over the default 5s
// once the file shares the machine with other workers — which is how the 3.3.2
// release's Test Verification gate failed on a suite where these tests pass.
// The budget stays explicit here rather than leaning on the suite default: a
// test this far above its peers in cost should say so at the call site.
describe('E2E — the 100-page story ask on the hardened agent', () => {
  it('turns the hostile Python plan into bounded PROSE units and writes them to disk', async () => {
    const fake = storyProvider();
    vi.spyOn(ProviderFactory, 'createProvider').mockImplementation(() => fake as never);

    const result = await new Orchestrator().execute(STORY_GOAL, {
      provider: 'local',
      model: 'test-model',
      verbose: false,
    });

    // ── The plan was REPLACED, not obeyed ──────────────────────────────
    expect(result.agentResults.some((a) => a.agent === 'LongFormPlanner')).toBe(true);

    // ── Prose exists on disk, one bounded file per unit ────────────────
    const chaptersDir = join(projectDir, 'chapters');
    expect(existsSync(chaptersDir)).toBe(true);
    const written = readdirSync(chaptersDir).filter((f) => f.endsWith('.md')).sort();
    expect(written).toEqual([
      '01-chapter-1.md',
      '02-chapter-2.md',
      '03-chapter-3.md',
      '04-chapter-4.md',
    ]);
    for (const f of written) {
      const words = countWords(readFileSync(join(chaptersDir, f), 'utf-8'));
      expect(words, f).toBeGreaterThan(120);
    }

    // ── NOTHING from the Python plan was produced ──────────────────────
    const allFiles = readdirSync(projectDir, { recursive: true } as never).map(String);
    expect(allFiles.some((f) => f.endsWith('.py'))).toBe(false);
    expect(allFiles.some((f) => /requirements\.txt$/.test(f))).toBe(false);

    // ── The ledger knows exactly how much of the book exists ──────────
    // Ledger keys use the orchestrator's `process.cwd()` (the realpath form on
    // macOS: /private/var/… even though tmpdir() hands back /var/…).
    const job = findInProgressJob(process.cwd())!;
    expect(job).not.toBeNull();
    expect(job.sections).toHaveLength(39); // 100 pages ≈ 35,000 words
    expect(job.target.wordsTarget).toBe(35_000);
    expect(job.sections.filter((s) => s.status === 'done')).toHaveLength(4);

    // ── And the pipeline SAYS SO, instead of reporting a bare failure ──
    expect(result.summary).toMatch(/chapter 4\/39/);
    expect(result.summary).toMatch(/words/);
    // The summary groups counts through the shared `formatCount` (pinned to en-US),
    // so the separator is a literal on every machine.
    expect(result.summary).toContain('/35,000 words');
    // G11 — it does NOT ask the user to say "continue": the remaining work is
    // handed to the calling surface as `pendingWork`, which keeps it going
    // unattended. Reporting progress while demanding a reply is the manual
    // cadence the user rejected.
    expect(result.summary).toMatch(/continuing automatically/i);
    expect(result.summary).not.toMatch(/reply "continue"/i);
    expect(result.pendingWork).toBeDefined();
    expect(result.pendingWork!.kind).toBe('long-form');
    expect(result.pendingWork!.percent).toBeGreaterThan(0);
    expect(result.pendingWork!.percent).toBeLessThan(100);
    expect(result.pendingWork!.reason).toMatch(/content units remaining/);
  }, 30_000);

  it('RESUMES on "continue" — it does not restart the book', async () => {
    const fake = storyProvider();
    vi.spyOn(ProviderFactory, 'createProvider').mockImplementation(() => fake as never);
    const orchestrator = new Orchestrator();

    // First batch…
    await orchestrator.execute(STORY_GOAL, { provider: 'local', model: 'test-model', verbose: false });
    const afterFirst = ledger();
    expect(Object.keys(afterFirst.jobs)).toHaveLength(1);

    // …then the bare follow-up the user actually sent.
    const second = await orchestrator.execute('continue', { provider: 'local', model: 'test-model', verbose: false });

    const chaptersDir = join(projectDir, 'chapters');
    const written = readdirSync(chaptersDir).filter((f) => f.endsWith('.md')).sort();
    // Units 5-8 — the SAME document, not a second one started from scratch.
    expect(written).toContain('05-chapter-5.md');
    expect(written).toContain('08-chapter-8.md');
    expect(written).toHaveLength(8);

    const afterSecond = ledger();
    expect(Object.keys(afterSecond.jobs)).toHaveLength(1);
    expect(findInProgressJob(process.cwd())!.sections.filter((s) => s.status === 'done')).toHaveLength(8);
    expect(second.summary).toMatch(/chapter 8\/39/);
  }, 30_000);

  it('does NOT re-decide the design on a continuation batch (G14)', async () => {
    // Continuing an in-flight job re-derives the unit plan from the ledger and
    // REPLACES whatever the reasoner/planner produce, so running them costs two
    // LLM round trips per batch and adds a failure surface the plan never uses
    // (live: the planner failed with `provider-error` on every unattended batch
    // and burned its whole repair budget before the real work began).
    const fake = storyProvider();
    vi.spyOn(ProviderFactory, 'createProvider').mockImplementation(() => fake as never);
    const orchestrator = new Orchestrator();
    const opts = { provider: 'local', model: 'test-model', verbose: false };
    const reasonerCalls = () => fake.prompts.filter((p) => /senior software architect/.test(p)).length;
    const plannerCalls = () => fake.prompts.filter((p) => /agentType: One of/.test(p)).length;

    // ── First, fresh ask: the design layers RUN (one batch, and it is the run
    //    where the deliverable class is being established).
    const first = await orchestrator.execute(STORY_GOAL, opts);
    const firstReasoner = first.agentResults.find((a) => a.agent === 'Reasoner')!;
    expect(firstReasoner.summary).not.toMatch(/Skipped/);
    const reasonerAfterFirst = reasonerCalls();
    const plannerAfterFirst = plannerCalls();
    expect(reasonerAfterFirst).toBeGreaterThan(0);

    // ── Continuation: neither layer is called AT ALL.
    const second = await orchestrator.execute('continue', opts);
    expect(reasonerCalls()).toBe(reasonerAfterFirst);
    expect(plannerCalls()).toBe(plannerAfterFirst);

    // …and the skip is REPORTED, not hidden — "no planner was needed" is a
    // fact about the run, so it must not read as a planning success.
    expect(second.agentResults.find((a) => a.agent === 'Reasoner')!.summary).toMatch(/Skipped/);
    expect(second.agentResults.find((a) => a.agent === 'Planner')!.summary).toMatch(/Skipped/);

    // The batch still did the real work: the next four units.
    expect(second.summary).toMatch(/chapter 8\/39/);
  }, 30_000);

  it('finishes a whole work and ASSEMBLES the single document the user asked for', async () => {
    const fake = storyProvider();
    vi.spyOn(ProviderFactory, 'createProvider').mockImplementation(() => fake as never);
    const orchestrator = new Orchestrator();

    // A 12-page ask → 4,200 words → 5 bounded units, so the arc needs two runs
    // (a batch is capped at 4) — which is exactly the multi-turn behaviour the
    // original session never achieved.
    const goal = 'write a 12 page story to book.md about magic and suspense';
    const first = await orchestrator.execute(goal, { provider: 'local', model: 'test-model', verbose: false });
    // G11 — the batch reports the work left and continues on its own.
    expect(first.summary).toMatch(/continuing automatically/);
    expect(first.summary).toMatch(/1 unit\(s\) left/);
    // Measured from WORDS on disk (4 of 5 units, biased by the remainder
    // distribution), not from the number of steps that ran.
    expect(first.pendingWork?.percent).toBeGreaterThan(50);
    expect(first.pendingWork?.percent).toBeLessThan(100);

    const second = await orchestrator.execute('continue', { provider: 'local', model: 'test-model', verbose: false });

    // Every unit done → deterministic assembly of the document.
    const doc = join(projectDir, 'book.md');
    // …named exactly as the user named it (a path pattern that swallowed the
    // surrounding sentence once produced a file called "write a 12 page …").
    expect(existsSync(doc)).toBe(true);
    expect(readdirSync(projectDir).filter((f) => f.endsWith('.md'))).toEqual(['book.md']);
    const text = readFileSync(doc, 'utf-8');
    expect(text).toMatch(/^# Chapter 1/);
    expect(text).toMatch(/# Chapter /);
    expect(second.summary).toMatch(/All \d+ units written/);
    expect(second.summary).toMatch(/words/);

    // Nothing is left claimed-and-missing.
    expect(findInProgressJob(process.cwd())).toBeNull();
  }, 30_000);
});
