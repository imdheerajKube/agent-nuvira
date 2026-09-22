/**
 * Long-form planning — turns an AUTHORED ask into bounded prose units
 * (enterprise-grade hardening, G7 + G8).
 *
 * WHY THIS EXISTS (the WhatsApp story audit):
 * The planner's output for "write a 100-page story" was a Python program:
 *
 *   step-01  context-gatherer  read existing chapters
 *   step-02  writer            "Create a Python script to append the story
 *                               continuation … to Mahagatha.md"
 *   step-03  runner            "Run the Python script"
 *   step-04  reviewer          review the script
 *
 * Not one step wrote prose. The agent built a machine to write the story and
 * never wrote the story — then the machine-creation step failed too, so the
 * target directory did not exist afterwards. Two structural fixes are needed,
 * and this module is the second one:
 *
 *   1. `deliverable-class.ts` — stop the decision layer mis-framing the ask.
 *   2. this module — plan the ask as UNITS OF CONTENT. Each unit is one
 *      bounded generation that fits an output cap, lands in its own file, and
 *      is recorded in the long-form ledger so the next run resumes instead of
 *      restarting. `long-form.ts` owns the arithmetic and the ledger; this
 *      module owns the bridge into the orchestrator's task plan.
 *
 * The units are deliberately capped per run (`MAX_UNITS_PER_RUN`). A 100-page
 * book is ~39 units; a single run that attempted all of them would fail the
 * way the original did (a plan far larger than one run can finish). A bounded
 * batch means every turn ENDS with real delivered text plus an honest progress
 * line, and "continue" resumes from the ledger.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { TaskStep } from './agent.js';
import {
  classifyDeliverable,
  type DeliverableClass,
} from '../learning/deliverable-class.js';
import {
  WORDS_PER_GENERATION,
  MAX_UNITS_PER_RUN,
  estimatePages,
  findInProgressJob,
  formatProgress,
  jobProgress,
  nextUnitBrief,
  parseLongFormTarget,
  startOrResumeJob,
  type LongFormJob,
} from '../learning/long-form.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Everything the writer needs to produce ONE unit of prose. */
export interface ProseUnit {
  /** The assembled document the user asked for (context, not the write target). */
  docPath: string;
  /** This unit's own file, relative to the project root. */
  path: string;
  /** Absolute path of `path`. */
  absolutePath: string;
  /** Display title, e.g. "Chapter 3". */
  title: string;
  /** 1-based unit index. */
  index: number;
  /** Total units in the work. */
  total: number;
  /** Words this unit should aim for. */
  targetWords: number;
  /** Tail of the previous unit, as captured at planning time (fallback). */
  previousTail: string;
  /**
   * Absolute path of the previous unit's file, so the writer can read the tail
   * AT EXECUTION TIME. Plan-time capture is stale for every unit after the
   * first in a batch — unit 2's predecessor file does not exist yet when the
   * batch is planned.
   */
  previousPath?: string;
  /** 'creative' | 'document'. */
  deliverableClass: 'creative' | 'document';
  /** The original goal, so the unit prompt can restate intent. */
  goal: string;
}

/** The result of planning an authored ask. */
export interface LongFormPlan {
  job: LongFormJob;
  /** One writer step per unit in this run's batch. */
  steps: TaskStep[];
  /** `proseUnit` for each step id (consumed by the writer via metadata). */
  units: Map<string, ProseUnit>;
  /** True when this run RESUMED existing work rather than starting fresh. */
  resumed: boolean;
  /** Honest one-line progress, shown to the user. */
  progressLine: string;
}

// ─── Document path resolution ───────────────────────────────────────────────

/** Text formats we can actually author deterministically. */
const AUTHORABLE = /\.(md|markdown|txt|mdx)$/i;

/**
 * Words that end a stated title ("…called Mahagatha about a village boy",
 * "…titled The Long Road in winter"). Without this the title regex would file
 * the whole clause as a filename.
 */
const TITLE_STOPWORDS = new Set([
  'about', 'with', 'in', 'at', 'on', 'for', 'that', 'which', 'who', 'whom', 'whose',
  'and', 'the', 'a', 'an', 'of', 'to', 'from', 'where', 'when', 'but', 'as', 'by',
  'into', 'over', 'under', 'between', 'while', 'whose', 'it', 'is', 'was', 'has', 'had',
]);

/**
 * The title the user SAID, when they said one.
 *
 * Live evidence from the audit: the request was "write a 5 page story called
 * Mahagatha about a village boy…" — no quotes, so the quoted-title branch never
 * fired and the book landed as `story.md`. The user's own name for their work
 * is the right filename, and getting it right is also what makes the work
 * RESUME across turns (the file is part of the ledger key).
 */
export function extractStatedTitle(goal: string): string | null {
  const m = (goal || '').match(
    /\b(?:called|titled|title|named|naam\s+se|नाम\s+से)\s*[:\-]?\s*["“'‘]?([A-Za-z][\w'-]*(?:\s+[A-Za-z][\w'-]*){0,4})["”'’]?/i,
  );
  if (!m) return null;
  const kept: string[] = [];
  for (const word of m[1].split(/\s+/)) {
    // Stop at the first continuation word: a capitalised first letter OR a
    // stop-word both mean the title ended ("Mahagatha about a village boy").
    if (kept.length > 0 && (TITLE_STOPWORDS.has(word.toLowerCase()) || /^[a-z]/.test(word))) break;
    kept.push(word);
  }
  const title = kept.join(' ').trim();
  return title.length >= 2 ? title : null;
}

/**
 * Work out which document the user asked for.
 *
 * Priority: an explicit path in the goal ("./story/Mahagatha.md") wins, then a
 * quoted title ("the story 'Mahagatha'"), then a class default. The default
 * matters: a goal with no path must still land somewhere predictable, and a
 * predictable name is what makes the work RESUME across turns.
 */
export function resolveDocumentPath(goal: string, workingDir: string, cls: 'creative' | 'document'): string {
  // A path token, NOT a sentence: no spaces inside the filename. An earlier
  // version allowed spaces and happily captured "write a 12 page story to
  // book.md" as the document name.
  //
  // Spaces AROUND a slash are a different matter — the live request said
  // "…/Documents/story/ Mahagatha.md", which must still target that file. They
  // are normalised out of a copy used only for path extraction.
  // Segments are separated by `/` with optional trailing space (never a LEADING
  // space, which would swallow the word before the path and capture
  // "to /tmp/books/x.md" as the name).
  const explicit = goal.match(/["'`]?((?:\/)?(?:[\w.-]+\/\s*)*[\w.-]+\.(?:md|markdown|txt|mdx))["'`]?/i);
  if (explicit) {
    // A path typed naturally can carry stray spaces around a segment — the
    // live story request literally said "…/Documents/story/ Mahagatha.md",
    // which would otherwise target a file named " Mahagatha.md". Normalise
    // each segment rather than matching the raw slice.
    const raw = explicit[1]
      .split('/')
      .map((seg) => seg.trim())
      .join('/')
      .trim();
    if (raw && AUTHORABLE.test(raw)) {
      return isAbsolute(raw) ? raw : resolve(workingDir, raw);
    }
  }

  // A title the user STATED without quotes ("a story called Mahagatha") is as
  // explicit as one they quoted, and is the common phrasing in a spoken ask.
  const stated = extractStatedTitle(goal);
  if (stated) {
    const slug = stated.trim().replace(/\s+/g, '-').toLowerCase();
    if (slug) return resolve(workingDir, `${slug}.md`);
  }

  const quoted = goal.match(/["“'‘]([A-Za-z][\w .'-]{2,40})["”'’]/);
  if (quoted) {
    const slug = quoted[1].trim().replace(/\s+/g, '-').toLowerCase();
    if (slug) return resolve(workingDir, `${slug}.md`);
  }

  return resolve(workingDir, cls === 'creative' ? 'story.md' : 'document.md');
}

/** A one-unit target for an authored ask that named no magnitude. */
function fallbackTarget() {
  return {
    unit: 'sections' as const,
    amount: 1,
    wordsTarget: WORDS_PER_GENERATION,
    unitCount: 1,
    source: 'default (no length given)',
  };
}

// ─── Planning ───────────────────────────────────────────────────────────────

/**
 * Should this goal be planned as authored content? Thin wrapper over the
 * deterministic classifier so the orchestrator has ONE predicate to call.
 */
export function shouldPlanAsAuthored(goal: string): boolean {
  return classifyDeliverable(goal).authored;
}

/**
 * Is this a bare follow-up to work already in progress?
 *
 * "continue", "go on", "next chapters", "keep writing", "आगे लिखो" — these
 * carry no class and no magnitude, so classification alone would file them as
 * software. They are only meaningful against the ledger, which is why the
 * orchestrator pairs this predicate with `findInProgressJob`.
 */
export function isContinuationAsk(goal: string): boolean {
  const raw = (goal || '').trim();
  if (!raw) return false;
  const g = raw.toLowerCase();

  // Devanagari first: JS `\b` is defined against [A-Za-z0-9_], so it does not
  // behave as expected around Devanagari text.
  const devanagari = /आगे\s*(लिखो|बढ़ो|बढाओ)|जारी\s*रखो/.test(raw);

  const RESUME_PHRASES =
    /\b(continue|carry on|go on|keep going|keep writing|next chapters?|next units?|next sections?|next part|resume|finish it|finish the (story|book|document)|more chapters?|and more)\b/g;
  if (!RESUME_PHRASES.test(g) && !devanagari) return false;

  // A continuation says nothing BUT "carry on". If real content survives the
  // resume phrase — "continue building the react dashboard with websockets…" —
  // that is a new ask with context, and it must be planned on its own merits.
  const remainder = g.replace(RESUME_PHRASES, ' ').replace(/[\s.,!?…:;\-—'"()]/g, '');
  return devanagari || remainder.length <= 12;
}

/**
 * Build the unit plan for an authored goal, resuming existing work when there
 * is any.
 *
 * Returns `null` when the goal is not authored — the caller then keeps the
 * ordinary code path untouched (this module must never change how software is
 * planned).
 */
export function buildLongFormPlan(input: {
  goal: string;
  workingDir: string;
  /** Units to plan for this run. */
  limit?: number;
  /** Resume an existing job even if the goal text changed (a "continue" turn). */
  forceResume?: boolean;
  /**
   * Explicit document path — set by the composite planner, where the prose is
   * one PHASE of a larger deliverable and so lands in a fixed place inside the
   * project structure rather than beside it (e.g. `content/book.md`).
   */
  docPath?: string;
  /**
   * Directory for the per-unit files. Also fixed by the composite planner
   * (`content/chapters`), so the web layer can enumerate them predictably.
   */
  dir?: string;
  /**
   * Treat the ask as authored even when the classifier is unsure.
   *
   * Used by the composite planner, where the AGGREGATE verdict is already
   * known (a hybrid ask is authored AND software, and may not clear the
   * authored-confidence floor on its own wording).
   */
  assumeAuthored?: boolean;
}): LongFormPlan | null {
  const verdict = classifyDeliverable(input.goal);
  // A bare continuation ("continue") classifies as nothing on its own — the
  // LEDGER is the source of truth there, so a continuation resumes the project's
  // in-flight job instead of inventing a new document from the word "continue".
  const existing = input.forceResume ? findInProgressJob(input.workingDir) : null;
  if (!verdict.authored && !input.assumeAuthored && !existing) return null;

  const cls: 'creative' | 'document' = existing
    ? existing.deliverableClass
    : verdict.class === 'document'
      ? 'document'
      : 'creative';

  const docPath = existing
    ? existing.docPath
    : input.docPath
      ? resolve(input.workingDir, input.docPath)
      : resolveDocumentPath(input.goal, input.workingDir, cls);
  const target = existing ? existing.target : parseLongFormTarget(input.goal) ?? fallbackTarget();

  const { job, resumed } = startOrResumeJob({
    projectPath: input.workingDir,
    docPath,
    goal: input.goal,
    target,
    deliverableClass: cls,
    ...(existing ? {} : input.dir ? { dir: input.dir } : {}),
  });

  const limit = Math.max(1, input.limit ?? MAX_UNITS_PER_RUN);
  const briefs = nextUnitBrief(job, limit);
  const units = new Map<string, ProseUnit>();
  const steps: TaskStep[] = [];

  let previousStepId: string | undefined;
  for (const brief of briefs) {
    const stepId = `long-form-unit-${brief.index}`;
    steps.push({
      id: stepId,
      description:
        `Write ${brief.title} (unit ${brief.index} of ${job.sections.length}) of the ${cls === 'creative' ? 'story' : 'document'} requested by the user. ` +
        `Produce roughly ${brief.targetWords} words of finished prose and nothing else — no code, no explanation, no plan. ` +
        `Destination: ${brief.path}. This is CONTINUATION work: match the established voice, characters and plot from the previous unit.`,
      agentType: 'writer',
      // UNITS RUN IN ORDER. A book is sequential: unit N needs unit N-1 on disk
      // for continuity, they must not race on the shared per-task metadata slot,
      // and the deliverable check for unit N is only meaningful once unit N-1
      // has been applied. Parallel units produced four copies of the last
      // chapter in the first end-to-end run.
      dependsOn: previousStepId ? [previousStepId] : [],
      status: 'pending',
      complexity: 'complex',
      // The writer must actually produce this file. The orchestrator already
      // treats "step succeeded without touching its expected files" as a
      // failure, which is exactly the guarantee long-form work needs.
      expectedFiles: [brief.path],
    });
    const previousSection = job.sections.find((s) => s.index === brief.index - 1);
    units.set(stepId, {
      docPath,
      path: brief.path,
      absolutePath: resolve(input.workingDir, brief.path),
      title: brief.title,
      index: brief.index,
      total: job.sections.length,
      targetWords: brief.targetWords,
      previousTail: brief.previousTail,
      ...(previousSection
        ? { previousPath: resolve(input.workingDir, previousSection.path) }
        : {}),
      deliverableClass: cls,
      goal: input.goal,
    });
    previousStepId = stepId;
  }

  return { job, steps, units, resumed, progressLine: formatProgress(job) };
}

/**
 * The line the pipeline reports when the batch is finished but the work is not.
 *
 * This is the honest substitute for the original session's six 30-second
 * "Failed" messages: instead of claiming a failure, it states exactly how much
 * of the book exists on disk and what the next turn should say.
 */
export function longFormContinuationNote(job: LongFormJob, projectPath: string): string {
  const p = jobProgress(job);
  if (p.complete) {
    return `✅ All ${p.total} units written — ${p.words.toLocaleString()} words (~${p.pagesTarget} pages).`;
  }
  const remaining = p.total - p.done;
  return (
    `${formatProgress(job)} — ${remaining} unit${remaining === 1 ? '' : 's'} remaining. ` +
    `Reply "continue" and I will write the next batch from ${projectPath}.`
  );
}

/** True when the job's finished document exists on disk. */
export function documentExists(job: LongFormJob): boolean {
  try {
    return existsSync(join(job.projectPath, job.docPath));
  } catch {
    return false;
  }
}

/** Pages a target implies — re-exported so callers need one import. */
export { estimatePages };
