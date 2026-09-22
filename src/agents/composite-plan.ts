/**
 * Composite planning — phased plans for deliverables that are more than one
 * thing (enterprise-grade hardening, G12).
 *
 * WHY THIS EXISTS. The audit fixed "a story is not a program" (G7/G8) and the
 * next class of ask showed the same shape one level up:
 *
 *   "develop a web-based book (interactive, with voice assistance)"
 *   "build the app from this plan — it's a phased build, take the time you need"
 *
 * Both are AUTHORED work AND software, and a single-class planner can only fail
 * one half of them:
 *   - plan it as prose and the site never appears — the user asked for a web
 *     book and got a markdown file;
 *   - plan it as code and the book never appears — the exact non-delivery the
 *     original audit found, where the agent built a machine to write the story
 *     instead of writing the story.
 *
 * The answer is not a better single answer; it is PHASES. `buildCompositePlan`
 * emits the phases in dependency order, with the hard rule encoded: SHAPE first
 * (so the content has somewhere to land), then CONTENT, then the EXPERIENCE
 * layer, then optional SERVICES, then VERIFICATION.
 *
 * TWO DESIGN CALLS WORTH STATING
 *
 *  1. CONTENT IS NOT LAST, AND IT IS NOT OPTIONAL. A site scaffold is one
 *     small step; the book is dozens of units. Reserving the experience layer
 *     for the end means a run that stalls early still leaves real chapters on
 *     disk — which is what makes the work RESUMABLE rather than a half-built
 *     shell.
 *  2. AN OPTIONAL SERVICE MUST NEVER GATE THE DELIVERABLE. When the ask names
 *     Python/voice/TTS, the plan does create the script — but the web layer is
 *     required to work without it (browser speech), so the deliverable is
 *     complete the moment it is opened. A page that needs `pip install` before
 *     it says a word is not enterprise-grade; it is a dependency the user never
 *     agreed to maintain.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TaskStep } from './agent.js';
import { classifyDeliverable, describeSubstrates, type DeliverableVerdict, type Substrate } from '../learning/deliverable-class.js';
import {
  MAX_UNITS_PER_RUN,
  formatProgress,
  jobProgress,
  type LongFormJob,
} from '../learning/long-form.js';
import { buildLongFormPlan, type ProseUnit } from './long-form-plan.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** What a phase is for. Drives ordering, naming and reporting. */
export type PhaseKind = 'scaffold' | 'content' | 'interactivity' | 'assets' | 'verify';

/** One stage of a composite deliverable. */
export interface CompositePhase {
  /** Stable id, e.g. `phase-1-scaffold`. */
  id: string;
  kind: PhaseKind;
  /** Short label for the board/report, e.g. "Shape the site". */
  title: string;
  /** The steps that implement this phase, already dependency-wired. */
  steps: TaskStep[];
}

/** The plan for a composite ask. */
export interface CompositePlan {
  /** Phases in execution order. */
  phases: CompositePhase[];
  /** Every step, flattened and wired (this is what becomes the task plan). */
  steps: TaskStep[];
  /** `proseUnit` per step id, consumed by the writer via metadata. */
  proseUnits: Map<string, ProseUnit>;
  /**
   * The long-form ledger job backing the content phase.
   *
   * Always present: a composite plan only exists when it contains authored
   * content (see `buildCompositePlan`), and the ledger is how that content's
   * progress is measured and resumed.
   */
  job: LongFormJob;
  /** Honest one-line progress, shown to the user. */
  progressLine: string;
  /**
   * Files that must ALL exist before the deliverable counts as finished.
   *
   * The unattended runner uses this to MEASURE completion instead of trusting
   * a batch that reported success — the same "ran ≠ worked" rule G1/G2/G3
   * apply to single edits.
   */
  expectedArtifacts: string[];
  /** One line describing what the user is getting. */
  deliverableSummary: string;
  /** Which substrates this plan covers (for logs/traces). */
  substrates: Substrate[];
  /**
   * Steps that CREATE files from scratch — shape, experience layer, services.
   *
   * The orchestrator routes these to the ONE-SHOT writer rather than the
   * tool-calling one. The tool-calling writer exists for the read→edit→verify
   * loop, and there is nothing to read in a directory that does not exist yet:
   * in the live run the tool-calling writer returned zero file changes for the
   * site scaffold and the whole pipeline died on its first step. Writing a new
   * file from nothing is exactly what the one-shot writer's contract (complete
   * file contents in `filepath:` blocks) is for.
   */
  creationStepIds: string[];
}

// ─── Project shape ──────────────────────────────────────────────────────────

/** Where a composite web deliverable puts its presentation layer. */
const SITE_DIR = 'site';
/** Where a composite authored deliverable puts its prose. */
const CONTENT_DIR = 'content';
/** Where optional service scripts live. */
const TOOLS_DIR = 'tools';

/** The document the prose phase assembles. */
const BOOK_PATH = `${CONTENT_DIR}/book.md`;
/** Per-unit prose files, so the web layer can enumerate them predictably. */
const CHAPTERS_DIR = `${CONTENT_DIR}/chapters`;

/** The site's entry point and its supporting files. */
const SITE_FILES = [`${SITE_DIR}/index.html`, `${SITE_DIR}/styles.css`, `${SITE_DIR}/reader.js`];
/** The generated chapter index the reader consumes. */
const CHAPTER_INDEX = `${SITE_DIR}/chapters.js`;
/** The optional high-quality narration service. */
const NARRATION_SCRIPT = `${TOOLS_DIR}/narrate.py`;
/** A dependency-free export/build helper, for asks that named a runtime. */
const EXPORT_SCRIPT = `${TOOLS_DIR}/export.mjs`;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** JSON literal for embedding in a generated command. */
function jsArray(values: string[]): string {
  return `[${values.map((v) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(',')}]`;
}

/**
 * A JS single-quoted string literal for embedding in the generated command.
 *
 * NOT a shell-quoted argument: the command runs inside `node -e "…"`, so a
 * shell-quoted `"site"` has its quotes consumed by the shell and the script
 * then sees a bare identifier (`ReferenceError: site is not defined`). The
 * value has to arrive at Node as JS source, so it is rendered as one.
 */
function jsString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * The deterministic end-to-end check for a composite deliverable.
 *
 * Generated by US, not written by the model, for the same reason the assembly
 * of a book is pure concatenation: the thing that decides whether the work is
 * done must not be part of the work being judged. It runs as a `runner` step
 * whose non-zero exit FAILS the phase, so the run reports an honest "not
 * delivered" instead of a green summary over a missing site.
 *
 * It asserts the two facts a user would check in the first ten seconds:
 *   1. every artifact the deliverable promises exists on disk;
 *   2. for a web deliverable, the site actually enumerates the chapters —
 *      a reader that cannot see chapter 12 has not presented chapter 12.
 */
export function buildVerifyCommand(input: {
  artifacts: string[];
  /** The site's own directory, when there is a web layer to check. */
  siteDir?: string;
  /** The directory the site must read its chapters from. */
  chaptersDir?: string;
}): string {
  const artifacts = jsArray(input.artifacts);
  const siteDir = input.siteDir ?? '';
  const chaptersDir = jsString(input.chaptersDir ?? '');
  const checksSite = !!input.siteDir && !!input.chaptersDir;

  // ── What the site check asserts, and why it is shaped this way ──────────
  // It asserts the site ENUMERATES a chapters directory instead of hard-coding
  // a list. The tempting stronger check — "does the site source mention each
  // chapter FILE" — is wrong: a correct reader lists the directory at load time
  // and therefore names NO chapter file in its source, so that check would fail
  // exactly the implementation we asked for. Proving chapter 12 renders needs a
  // browser, which a runner step does not have. So we assert what is genuinely
  // verifiable: every promised file exists, and the site reads its content from
  // the chapters directory rather than embedding it.
  const siteScan = checksSite
    ? `const roots=[];const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else roots.push(p)}};` +
      `if(fs.existsSync(${jsString(siteDir)}))walk(${jsString(siteDir)});` +
      `const blob=roots.map(p=>fs.readFileSync(p,'utf8')).join(String.fromCharCode(10));` +
      `const enumerates=blob.includes(${chaptersDir});`
    : '';
  const siteCheck = checksSite
    ? `if(!enumerates){console.error('THE SITE DOES NOT READ ITS CHAPTERS FROM '+${chaptersDir});process.exit(1)}`
    : '';
  const success = checksSite
    ? `'OK: '+need.length+' artifact(s) present and the site reads its chapters from '+${chaptersDir}`
    : `'OK: '+need.length+' artifact(s) present'`;
  return (
    `node -e "const fs=require('fs');const path=require('path');` +
    `const need=${artifacts};` +
    `const missing=need.filter(p=>!fs.existsSync(p));` +
    siteScan +
    siteCheck +
    `if(missing.length){` +
    `console.error('MISSING FILES: '+missing.join(', '));` +
    `process.exit(1)}` +
    `console.log(${success})"`
  ).trim();
}

/**
 * Is this step's deliverable already on disk?
 *
 * A satisfied step is NOT planned again, and the second reason is the sharp
 * one: re-running a scaffold wastes tokens, and an idempotent writer that
 * correctly reports "no changes needed" is then marked as having FAILED its
 * expected files — a false failure that burned a whole repair budget on the
 * second run of the live composite test. A continuation must plan only what is
 * left to do.
 */
function alreadySatisfied(step: TaskStep, workingDir: string): boolean {
  const files = step.expectedFiles ?? [];
  if (files.length === 0) return false;
  return files.every((f) => existsSync(resolve(workingDir, f)));
}

/** A step that runs a deterministic command (the runner extracts backticks). */
function runStep(id: string, description: string, command: string, dependsOn: string[]): TaskStep {
  return {
    id,
    description: `${description} Run: \`${command}\``,
    agentType: 'runner',
    dependsOn,
    status: 'pending',
    complexity: 'simple',
    routingHints: { runSerially: true },
  };
}

/** A step that writes files. */
function writeStep(input: {
  id: string;
  description: string;
  expectedFiles: string[];
  dependsOn: string[];
  complexity?: 'simple' | 'moderate' | 'complex';
}): TaskStep {
  return {
    id: input.id,
    description: input.description,
    agentType: 'writer',
    dependsOn: input.dependsOn,
    status: 'pending',
    complexity: input.complexity ?? 'complex',
    expectedFiles: input.expectedFiles,
    routingHints: { runSerially: true },
  };
}

// ─── Phase builders ─────────────────────────────────────────────────────────

/** Phase 1 — the shape the content will land in. */
function scaffoldPhase(substrates: Substrate[]): CompositePhase | null {
  if (!substrates.includes('web')) return null;
  return {
    id: 'phase-1-scaffold',
    kind: 'scaffold',
    title: 'Shape the site',
    steps: [
      writeStep({
        id: 'scaffold-site',
        description:
          `Create the static site that will read and present the book: ${SITE_FILES.join(', ')}. ` +
          'The entry point must work by opening the HTML file directly from disk — no build step, no server, no package install. ' +
          `The reader must load the written content from the ${CHAPTERS_DIR}/ directory at runtime and render one chapter at a time ` +
          'with previous/next navigation and a table of contents. Include a "Read aloud" control that uses the browser\'s built-in ' +
          'speech synthesis so narration works with nothing installed. Keep styling self-contained in the CSS file; no external CDNs.',
        expectedFiles: SITE_FILES,
        dependsOn: [],
      }),
    ],
  };
}

/** Phase 2 — the content itself, via the bounded long-form engine. */
function contentPhase(input: {
  goal: string;
  workingDir: string;
  limit: number;
  dependsOn: string[];
}): { phase: CompositePhase; job: LongFormJob; proseUnits: Map<string, ProseUnit>; progressLine: string } | null {
  const prose = buildLongFormPlan({
    goal: input.goal,
    workingDir: input.workingDir,
    limit: input.limit,
    assumeAuthored: true,
    docPath: BOOK_PATH,
    dir: CHAPTERS_DIR,
  });
  if (!prose) return null;

  // The first unit must wait for the scaffold only when there IS one; a prose
  // unit's own chain already serializes the rest of the batch.
  const steps = prose.steps.map((step, i) => ({
    ...step,
    dependsOn: i === 0 ? [...input.dependsOn] : step.dependsOn,
  }));

  return {
    phase: { id: 'phase-2-content', kind: 'content', title: 'Write the content', steps },
    job: prose.job,
    proseUnits: prose.units,
    progressLine: prose.progressLine,
  };
}

/** Phase 3 — the experience layer that makes the content usable. */
function interactivityPhase(input: {
  goal: string;
  job: LongFormJob;
  dependsOn: string[];
  wantsNarration: boolean;
}): CompositePhase {
  const steps: TaskStep[] = [
    writeStep({
      id: 'site-chapter-index',
      description:
        `Create ${CHAPTER_INDEX}: a small module that lists every chapter file in ${CHAPTERS_DIR}/ ` +
        'in reading order, with a display title for each (derived from the file name), so the reader can build its ' +
        'table of contents and navigation without a server. It must enumerate the directory contents at load time ' +
        'rather than hard-coding a count.' +
        (input.wantsNarration
          ? ' Also wire the "Read aloud" button to the browser speech synthesis API with play/pause, and make the page ' +
            'note that an optional higher-quality narration script is available for those who want it.'
          : ''),
      expectedFiles: [CHAPTER_INDEX],
      dependsOn: input.dependsOn,
      complexity: 'moderate',
    }),
  ];
  return { id: 'phase-3-interactivity', kind: 'interactivity', title: 'Make it interactive', steps };
}

/**
 * Phase 4 — optional services.
 *
 * The narration script is generated but NOT wired as a requirement, and the
 * phase never fails the run on its own: a missing Python interpreter must not
 * cost the user their book (see the module header).
 */
function assetsPhase(input: {
  substrates: Substrate[];
  dependsOn: string[];
  goal: string;
}): CompositePhase | null {
  const wantsNarration = input.substrates.includes('python') || /audio|narrat|voice|speech|tts|listen|read\s+aloud/i.test(input.goal);
  const steps: TaskStep[] = [];

  if (wantsNarration) {
    steps.push(
      writeStep({
        id: 'tools-narrate',
        description:
          `Create ${NARRATION_SCRIPT}: an optional high-quality narration generator for this book. It must list the ` +
          `chapters, synthesise speech for each into an audio file next to it, and require only standard third-party ` +
          'libraries (gTTS or edge-tts), detecting which is installed and explaining what to install when neither is. ' +
          'It must NOT be required for the site to work — the site narrates through the browser without it.',
        expectedFiles: [NARRATION_SCRIPT],
        dependsOn: input.dependsOn,
        complexity: 'moderate',
      }),
    );
  }

  if (input.substrates.includes('python') && !wantsNarration) {
    steps.push(
      writeStep({
        id: 'tools-export',
        description:
          `Create ${EXPORT_SCRIPT}: a dependency-free Node build helper that assembles the finished document from its ` +
          'per-unit files into a single file and reports the word and page counts, so the deliverable can be rebuilt ' +
          'after any edit without an LLM.',
        expectedFiles: [EXPORT_SCRIPT],
        dependsOn: input.dependsOn,
        complexity: 'moderate',
      }),
    );
  }

  if (steps.length === 0) return null;
  return { id: 'phase-4-assets', kind: 'assets', title: 'Optional services', steps };
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Plan a hybrid ask as phases, or return `null` when the ask is not one.
 *
 * Returning null for every single-substrate goal is deliberate: this module
 * must be invisible to the existing code path, or it would change how ordinary
 * software and ordinary prose are planned — both of which work today.
 */
export function buildCompositePlan(input: {
  goal: string;
  workingDir: string;
  /** Units of prose to plan for this run. */
  limit?: number;
  /** Reuse an already-computed verdict (the orchestrator has one). */
  verdict?: DeliverableVerdict;
}): CompositePlan | null {
  const verdict = input.verdict ?? classifyDeliverable(input.goal);
  // Only hybrid asks take this path. An authored-only ask stays with
  // `buildLongFormPlan`; a software-only ask stays with the code planner.
  if (!verdict.composite) return null;
  // And the hybrid must actually contain authored content. "A React app with a
  // Python backend" is multi-substrate but it is a SOFTWARE ask, and the code
  // planner already plans those correctly.
  if (!verdict.substrates.includes('prose')) return null;

  const substrates = verdict.substrates;
  const limit = Math.max(1, input.limit ?? MAX_UNITS_PER_RUN);
  const phases: CompositePhase[] = [];

  const scaffold = scaffoldPhase(substrates);
  if (scaffold) {
    // Pruned BEFORE the content phase is built, not after: the content must not
    // declare a dependency on a step that is about to be dropped from the plan.
    // (Live evidence: on the second run the scaffold was satisfied and pruned,
    // but unit 1 still depended on `scaffold-site` — the scheduler found zero
    // runnable steps and the whole continuation failed at planning.)
    scaffold.steps = scaffold.steps.filter((s) => !alreadySatisfied(s, input.workingDir));
    if (scaffold.steps.length > 0) phases.push(scaffold);
  }

  const content = contentPhase({
    goal: input.goal,
    workingDir: input.workingDir,
    limit,
    dependsOn: scaffold && scaffold.steps.length > 0 ? scaffold.steps.map((s) => s.id) : [],
  });
  // Authored content is the point of a composite ask that includes prose. If
  // the long-form engine cannot plan it at all, the hybrid cannot be delivered
  // honestly — bail out to the ordinary path rather than planning a shell.
  if (!content) return null;
  phases.push(content.phase);

  // Everything after the content depends on the LAST content step: the site
  // must be able to enumerate finished chapters, and the narration script
  // should see real files.
  const lastContentStep = content.phase.steps[content.phase.steps.length - 1]?.id;
  const afterContent = lastContentStep ? [lastContentStep] : [];

  if (substrates.includes('web')) {
    phases.push(
      interactivityPhase({
        goal: input.goal,
        job: content.job,
        dependsOn: afterContent,
        wantsNarration: substrates.includes('python') || /audio|narrat|voice|speech|tts/i.test(input.goal),
      }),
    );
  }

  const assets = assetsPhase({ substrates, dependsOn: afterContent, goal: input.goal });
  if (assets) phases.push(assets);

  // ── Verification, generated by us ───────────────────────────────────────
  const chapterPaths = content.job.sections.map((s) => s.path);
  // Captured BEFORE pruning: a satisfied step is not planned again, but its
  // files are still part of what the deliverable promises — completion is
  // measured against this list either way.
  const expectedArtifacts: string[] = [
    BOOK_PATH,
    ...chapterPaths,
    ...(substrates.includes('web') ? [...SITE_FILES, CHAPTER_INDEX] : []),
    ...(assets ? assets.steps.flatMap((s) => s.expectedFiles ?? []) : []),
  ];

  // ── Plan only what is LEFT ──────────────────────────────────────────────
  // A presentation-layer step whose files already exist is dropped, so a
  // continuation goes straight to the unfinished content instead of rewriting a
  // site that is already correct.
  for (const phase of phases) {
    if (phase.kind === 'content' || phase.kind === 'verify') continue;
    phase.steps = phase.steps.filter((s) => !alreadySatisfied(s, input.workingDir));
  }
  const planned = phases.filter((p) => p.steps.length > 0);

  const verifyDependsOn = planned.flatMap((p) => p.steps.map((s) => s.id));
  const verify: CompositePhase = {
    id: 'phase-5-verify',
    kind: 'verify',
    title: 'Verify the whole deliverable',
    steps: [
      runStep(
        'verify-deliverable',
        'Verify the whole deliverable end to end: every promised file exists on disk, and the site reads its chapters from the content directory.',
        buildVerifyCommand({
          artifacts: expectedArtifacts,
          ...(substrates.includes('web') ? { siteDir: SITE_DIR, chaptersDir: CHAPTERS_DIR } : {}),
        }),
        verifyDependsOn,
      ),
    ],
  };
  planned.push(verify);

  const steps = planned.flatMap((p) => p.steps);

  return {
    phases: planned,
    steps,
    proseUnits: content.proseUnits,
    job: content.job,
    progressLine: content.progressLine,
    expectedArtifacts,
    substrates,
    creationStepIds: planned
      .filter((p) => p.kind === 'scaffold' || p.kind === 'interactivity' || p.kind === 'assets')
      .flatMap((p) => p.steps.map((s) => s.id)),
    deliverableSummary: `${describeSubstrates(verdict)} — ${steps.length} step(s) across ${planned.length} phase(s), ${content.job.sections.length} content units`,
  };
}

/**
 * The honest progress line for a composite job, derived from the ledger.
 *
 * Reported as units AND phases, because "3 of 5 phases" is meaningless when the
 * content phase is 36 of 39 chapters: the user asked for a book, so the book's
 * own completion is the number that matters.
 */
export function compositeProgressLine(job: LongFormJob, extra = ''): string {
  const suffix = extra ? ` · ${extra}` : '';
  return `${formatProgress(job)}${suffix}`;
}

/** Phase labels in execution order (for reports and traces). */
export function phaseSummary(plan: CompositePlan): string {
  return plan.phases.map((p) => `${p.title} (${p.steps.length})`).join(' → ');
}
