/**
 * Long-form execution — bounded units + a progress ledger for deliverables
 * that are larger than one LLM generation (enterprise-grade hardening, G8).
 *
 * WHY THIS EXISTS (the WhatsApp story audit):
 * The user asked for a 100-page story. Two facts made that ask IMPOSSIBLE for
 * any of the 507 eligible models, independently of the model-shortage myth the
 * failure message told:
 *
 *   1. The code writer generates with `maxTokens: 2048` — about 1,500 words,
 *      roughly 4–5 pages. A 100-page book is ~35,000 words, i.e. 25–40 times
 *      the largest artifact the pipeline could ever emit.
 *   2. Nothing in the pipeline decomposed the ask. The plan was 4 steps, none
 *      of which produced prose, and no component counted words or pages, so
 *      there was no notion of "partially done" and nothing to resume.
 *
 * So the fix is structural, not a bigger prompt: split the work into bounded
 * units that fit one generation, persist progress per unit, and report honest
 * completion ("chapter 7 of 39"). This module owns the arithmetic and the
 * ledger; the writer owns one unit at a time.
 *
 * WHY UNIT FILES, NOT APPENDS TO ONE FILE:
 * The obvious design — append each chapter to `Mahagatha.md` — requires the
 * writer to rewrite the whole file every unit (the FileChange contract is a
 * full-content write). By chapter 35 that is ~35k words of input tokens per
 * generation, which does not fit the context window it was going to be
 * generated from. One file per unit keeps every generation bounded and makes
 * the work genuinely resumable. The single document the user asked for is
 * ASSEMBLED deterministically (pure string concatenation, no LLM, no cost)
 * once the units are done.
 *
 * Storage: `~/.nuvira/memory/long-form.json`, keyed by project + document.
 * Honours `NUVIRA_MEMORY_DIR` / `BUFF_MEMORY_DIR` like the other ledgers.
 * Every write is best-effort — the ledger must NEVER break a turn.
 */

import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { formatCount } from '../utils/format.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Words per printed page. 350 is the standard estimate for a 12pt manuscript
 * page (double-spaced manuscript convention is ~250; a typeset book page is
 * ~350–400). Erring low keeps the plan honest: a "100-page" target that lands
 * at 35,000 words is comfortably 100 pages, never short of it.
 */
export const WORDS_PER_PAGE = 350;

/**
 * Words per generation unit. Sized to land inside a raised output cap with
 * headroom for the model to finish a sentence: 900 words ≈ 1,400 tokens,
 * comfortably under a 2,048-token floor and well within a 4k–8k cap. Larger
 * units risk truncation, which is exactly how the original writer failed
 * ("no parseable output" on a truncated response).
 */
export const WORDS_PER_GENERATION = 900;

/** Words per chapter when the user counts chapters instead of pages. */
export const WORDS_PER_CHAPTER = 2_500;

/**
 * Units planned per turn. A 100-page book is ~39 units; planning all of them
 * as orchestrator steps would build a plan the run could never finish, and a
 * single-run attempt is precisely the "bigger ask" the agent kept losing.
 * Bounded batches let each turn end with CONCRETE delivered text and a
 * recorded progress line, and the next turn resumes where it stopped.
 */
export const MAX_UNITS_PER_RUN = 4;

/** Largest section count we will ever plan (sanity bound on the ledger). */
const MAX_SECTIONS = 400;

const CURRENT_VERSION = 1;
const FILE_NAME = 'long-form.json';

// ─── Types ──────────────────────────────────────────────────────────────────

/** The unit the user counted in. */
export type LongFormUnit = 'pages' | 'words' | 'chapters' | 'sections';

/** A parsed long-form target derived from the goal. */
export interface LongFormTarget {
  /** What the user counted in ("100 pages"). */
  unit: LongFormUnit;
  /** How many of `unit` they asked for. */
  amount: number;
  /** Total words the finished deliverable should reach. */
  wordsTarget: number;
  /** How the work is split into generations. */
  unitCount: number;
  /** Where the number came from, for auditability. */
  source: string;
}

/** One bounded unit of work (a chapter/section). */
export interface SectionProgress {
  /** 1-based position. */
  index: number;
  /** Display title ("Chapter 3"). */
  title: string;
  /** Path of this unit's file, relative to the project root. */
  path: string;
  /** Words this unit should aim for. */
  targetWords: number;
  status: 'pending' | 'done' | 'failed';
  /** Words actually produced (measured from the file when present). */
  words: number;
  /** Generation attempts spent on this unit. */
  attempts: number;
  lastError?: string;
}

/** The persisted job: everything needed to resume the work in a later turn. */
export interface LongFormJob {
  /** Ledger key: project path + document path. */
  key: string;
  /** The original goal, so a resumed turn re-states intent faithfully. */
  goal: string;
  /** Absolute project root. */
  projectPath: string;
  /** The document the user actually asked for (assembled at the end). */
  docPath: string;
  /** 'creative' | 'document' — drives titling and the writer's prompt. */
  deliverableClass: 'creative' | 'document';
  target: LongFormTarget;
  sections: SectionProgress[];
  /** Words across every DONE unit. */
  words: number;
  status: 'in_progress' | 'done';
  createdAt: number;
  updatedAt: number;
}

// ─── Target parsing ─────────────────────────────────────────────────────────

/** Default chapter count when a book/novel is requested with no magnitude. */
const DEFAULT_CHAPTERS = 10;

/**
 * Extract the long-form target from a goal, or `null` when the goal does not
 * name a magnitude (in which case the ask fits one generation and this module
 * stays out of the way).
 *
 * Understands the shapes users actually type — "a 100 page story", "100-page
 * book", "in 12 chapters", "about 5000 words", "10 पेज", "एक उपन्यास जिसमें 8
 * अध्याय हों" — and prefers the most specific unit named.
 */
export function parseLongFormTarget(goal: string): LongFormTarget | null {
  const g = (goal || '').trim();
  if (!g) return null;

  // A magnitude must be explicit. Never invent one from "a long story".
  const pages = g.match(/(\d[\d,]*)\s*[-\s]?\s*(pages?|pg|पेज|पृष्ठ)/i);
  const chapters = g.match(/(\d[\d,]*)\s*[-\s]?\s*(chapters?|अध्याय)/i);
  const words = g.match(/(\d[\d,]*)\s*[-\s]?\s*(words?|शब्द)/i);
  const sections = g.match(/(\d[\d,]*)\s*[-\s]?\s*(sections?|parts?)/i);

  const num = (raw: string): number => Number.parseInt(raw.replace(/[,\s]/g, ''), 10);

  // Prefer the unit that most directly describes the deliverable: pages and
  // chapters are how books are specified; words is a fallback; sections last.
  if (pages) {
    return makeTarget('pages', num(pages[1]), `"${pages[0].trim()}"`);
  }
  if (chapters) {
    return makeTarget('chapters', num(chapters[1]), `"${chapters[0].trim()}"`);
  }
  if (words) {
    return makeTarget('words', num(words[1]), `"${words[0].trim()}"`);
  }
  if (sections) {
    return makeTarget('sections', num(sections[1]), `"${sections[0].trim()}"`);
  }

  // A book/novel with no magnitude still needs a plan: default to a sensible
  // chapter count rather than pretending it fits one generation.
  if (/\b(novel|novella|book|उपन्यास|पुस्तक)\b/i.test(g)) {
    return makeTarget('chapters', DEFAULT_CHAPTERS, 'default for an unnumbered book/novel');
  }
  return null;
}

/** Convert a user-facing magnitude into a word target and unit count. */
function makeTarget(unit: LongFormUnit, amount: number, source: string): LongFormTarget {
  const safeAmount = Math.max(1, Math.min(amount, 10_000));
  let wordsTarget: number;
  let unitCount: number;
  switch (unit) {
    case 'pages':
      // Pages are not a generation boundary — split into as many bounded units
      // as the word count needs (100 pages ≈ 39 units of ~900 words).
      wordsTarget = safeAmount * WORDS_PER_PAGE;
      unitCount = Math.ceil(wordsTarget / WORDS_PER_GENERATION);
      break;
    case 'words':
      wordsTarget = safeAmount;
      unitCount = Math.ceil(wordsTarget / WORDS_PER_GENERATION);
      break;
    case 'chapters':
      // A chapter IS the unit the user counted, so one unit per chapter.
      // Splitting "12 chapters" into 34 fragments would deliver something the
      // user did not ask for and mislabel every one of them.
      wordsTarget = safeAmount * WORDS_PER_CHAPTER;
      unitCount = safeAmount;
      break;
    default:
      wordsTarget = safeAmount * WORDS_PER_GENERATION;
      unitCount = safeAmount;
  }
  return { unit, amount: safeAmount, wordsTarget, unitCount: Math.max(1, Math.min(unitCount, MAX_SECTIONS)), source };
}

// ─── Section planning ───────────────────────────────────────────────────────

/** Filesystem-safe slug for a section title. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'unit';
}

/** Pad to two digits so chapter files sort lexicographically. */
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Default display title for a unit, by class. */
export function sectionTitle(cls: 'creative' | 'document', index: number): string {
  return cls === 'creative' ? `Chapter ${index}` : `Section ${index}`;
}

/**
 * Build the unit list for a target. Word targets are distributed evenly with
 * the remainder spread over the first units, so the SUM of unit targets always
 * equals the overall word target — the plan cannot silently undershoot the ask.
 */
export function planSections(
  target: LongFormTarget,
  cls: 'creative' | 'document',
  dir = 'chapters',
): SectionProgress[] {
  const count = target.unitCount;
  const base = Math.floor(target.wordsTarget / count);
  const remainder = target.wordsTarget - base * count;
  const sections: SectionProgress[] = [];
  for (let i = 1; i <= count; i++) {
    const title = sectionTitle(cls, i);
    sections.push({
      index: i,
      title,
      path: `${dir}/${pad(i)}-${slug(title)}.md`,
      targetWords: base + (i <= remainder ? 1 : 0),
      status: 'pending',
      words: 0,
      attempts: 0,
    });
  }
  return sections;
}

/** Pages implied by a word count (for progress reporting). */
export function estimatePages(words: number): number {
  return Math.max(0, Math.round((words / WORDS_PER_PAGE) * 10) / 10);
}

// ─── Ledger storage ─────────────────────────────────────────────────────────

interface LedgerFile {
  version: number;
  jobs: Record<string, LongFormJob>;
}

function envBuffSafe(name: string): string | undefined {
  try {
    return envBuff(name);
  } catch {
    return undefined;
  }
}

/** Memory dir, honouring the test/dev override. */
function memoryDir(): string {
  const override = envBuffSafe('MEMORY_DIR');
  if (override) return override;
  try {
    return join(resolveNuviraHome(), 'memory');
  } catch {
    return join(process.cwd(), '.nuvira-memory');
  }
}

function ledgerPath(): string {
  return join(memoryDir(), FILE_NAME);
}

function readLedger(): LedgerFile {
  try {
    const raw = readFileSync(ledgerPath(), 'utf-8');
    const parsed = JSON.parse(raw) as LedgerFile;
    if (parsed && typeof parsed === 'object' && parsed.jobs && typeof parsed.jobs === 'object') {
      return { version: parsed.version ?? CURRENT_VERSION, jobs: parsed.jobs };
    }
  } catch {
    // Missing or corrupt — start clean. A ledger read must never throw.
  }
  return { version: CURRENT_VERSION, jobs: {} };
}

function writeLedger(data: LedgerFile): void {
  try {
    const dir = memoryDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Bounded: keep the most recent 30 jobs so the file cannot grow forever.
    const entries = Object.entries(data.jobs);
    if (entries.length > 30) {
      entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      data.jobs = Object.fromEntries(entries.slice(0, 30));
    }
    writeFileSync(ledgerPath(), JSON.stringify({ ...data, version: CURRENT_VERSION }, null, 2), 'utf-8');
  } catch {
    // Best-effort — persistence must never break a turn.
  }
}

/** Stable key for a (project, document) pair. */
export function longFormKey(projectPath: string, docPath: string): string {
  return `${resolve(projectPath)}::${resolve(docPath)}`;
}

/** Both `chapters/03-chapter-3.md` (relative) and absolute path forms. */
export function sectionAbsolutePath(projectPath: string, sectionPath: string): string {
  return resolve(projectPath, sectionPath);
}

// ─── Job lifecycle ──────────────────────────────────────────────────────────

/**
 * Start a job, or RESUME an existing one for the same document.
 *
 * Resuming is the whole point: the failing session re-derived the same plan
 * six times and lost every partial result. A resumed job keeps its existing
 * units, their statuses and their word counts, so the caller can ask for the
 * next pending batch and make real forward progress per turn.
 */
export function startOrResumeJob(input: {
  projectPath: string;
  docPath: string;
  goal: string;
  target: LongFormTarget;
  deliverableClass: 'creative' | 'document';
  dir?: string;
}): { job: LongFormJob; resumed: boolean } {
  const key = longFormKey(input.projectPath, input.docPath);
  const data = readLedger();
  const existing = data.jobs[key];
  const now = Date.now();

  if (existing && existing.status === 'in_progress') {
    // Reconcile with disk: a unit marked done whose file vanished is pending
    // again (the user deleted it, or a write failed after the ledger write).
    let repaired = false;
    for (const s of existing.sections) {
      if (s.status === 'done' && !existsSync(sectionAbsolutePath(existing.projectPath, s.path))) {
        s.status = 'pending';
        s.words = 0;
        repaired = true;
      }
    }
    if (repaired) recalcWords(existing);
    existing.goal = input.goal;
    existing.updatedAt = now;
    data.jobs[key] = existing;
    writeLedger(data);
    return { job: existing, resumed: true };
  }

  const sections = planSections(input.target, input.deliverableClass, input.dir);
  const job: LongFormJob = {
    key,
    goal: input.goal,
    projectPath: resolve(input.projectPath),
    docPath: resolve(input.docPath),
    deliverableClass: input.deliverableClass,
    target: input.target,
    sections,
    words: 0,
    status: 'in_progress',
    createdAt: now,
    updatedAt: now,
  };
  data.jobs[key] = job;
  writeLedger(data);
  return { job, resumed: false };
}

/** Read a job without creating one. */
export function getJob(projectPath: string, docPath: string): LongFormJob | null {
  const data = readLedger();
  return data.jobs[longFormKey(projectPath, docPath)] ?? null;
}

/**
 * The most recently updated job for a project REGARDLESS of status, or null.
 *
 * The unattended runner needs this: after the last batch completes the job it
 * must be able to read the FINISHED record to confirm the document exists, and
 * `findInProgressJob` (correctly) hides those.
 */
export function findLatestJob(projectPath: string): LongFormJob | null {
  const data = readLedger();
  const key = resolve(projectPath);
  const candidates = Object.values(data.jobs)
    .filter((j) => j.projectPath === key)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return candidates[0] ?? null;
}

/**
 * The most recently updated UNFINISHED job for a project, or null.
 *
 * WHY: a follow-up turn says "continue" — which names no document, no length,
 * and no class. Re-deriving the job from that text would land on the default
 * filename and start a SECOND book from scratch, which is the "agent goes in a
 * loop and never delivers" behaviour this ledger exists to end. The in-flight
 * job for this project is the correct target for a continuation.
 */
export function findInProgressJob(projectPath: string): LongFormJob | null {
  const data = readLedger();
  const key = resolve(projectPath);
  const candidates = Object.values(data.jobs)
    .filter((j) => j.projectPath === key && j.status === 'in_progress')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return candidates[0] ?? null;
}

/** Number of words in a body of text (whitespace-delimited). */
export function countWords(text: string): number {
  const t = (text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function recalcWords(job: LongFormJob): void {
  job.words = job.sections.reduce((sum, s) => sum + (s.status === 'done' ? s.words : 0), 0);
}

/**
 * Record the outcome of ONE unit.
 *
 * `ok` requires actual content: a unit whose file is missing or empty is a
 * FAILURE even if the writer reported success. That is the G10 principle
 * applied to long-form work — "the step ran" is not "the work exists".
 */
export function recordSectionOutcome(
  job: LongFormJob,
  index: number,
  outcome: { ok: boolean; words?: number; error?: string },
): LongFormJob {
  const section = job.sections.find((s) => s.index === index);
  if (!section) return job;
  section.attempts += 1;
  if (outcome.ok) {
    section.status = 'done';
    section.words = outcome.words ?? section.words;
    delete section.lastError;
  } else {
    section.status = 'failed';
    section.lastError = (outcome.error || 'unknown error').slice(0, 300);
  }
  recalcWords(job);
  job.status = job.sections.every((s) => s.status === 'done') ? 'done' : 'in_progress';
  job.updatedAt = Date.now();
  const data = readLedger();
  data.jobs[job.key] = job;
  writeLedger(data);
  return job;
}

/**
 * Persist a job that the caller has already mutated (e.g. after writing unit
 * files). Kept separate from `recordSectionOutcome` so batch callers write
 * once instead of once per unit.
 */
export function saveJob(job: LongFormJob): void {
  job.updatedAt = Date.now();
  recalcWords(job);
  job.status = job.sections.every((s) => s.status === 'done') ? 'done' : 'in_progress';
  const data = readLedger();
  data.jobs[job.key] = job;
  writeLedger(data);
}

/**
 * The next pending units to execute — bounded per run so a turn always ends
 * with delivered text rather than an unfinished marathon.
 */
export function nextPendingSections(job: LongFormJob, limit = MAX_UNITS_PER_RUN): SectionProgress[] {
  return job.sections.filter((s) => s.status !== 'done').slice(0, Math.max(1, limit));
}

/** Progress snapshot for reporting. */
export interface LongFormProgress {
  done: number;
  total: number;
  words: number;
  wordsTarget: number;
  pages: number;
  pagesTarget: number;
  percent: number;
  complete: boolean;
}

export function jobProgress(job: LongFormJob): LongFormProgress {
  const total = job.sections.length;
  const done = job.sections.filter((s) => s.status === 'done').length;
  const words = job.sections.reduce((sum, s) => sum + (s.status === 'done' ? s.words : 0), 0);
  const wordsPercent = job.target.wordsTarget > 0
    ? Math.min(100, Math.round((words / job.target.wordsTarget) * 100))
    : 0;
  // The completion percentage is the MINIMUM of the two ways the deliverable can
  // be incomplete, and that is deliberate. Writers routinely OVERSHOOT the per-
  // chapter target — a live 100-page run hit 43,906 words against a 35,000 target
  // by chapter 31 of 39 — so a word-only percentage saturated at 100 while eight
  // units were still owed: the progress line read "31/39 complete … 100%", which
  // is the same class of contradiction as a listing count presented as a
  // capability. Units are the generation boundary and the work still outstanding,
  // so the lower of the two is the honest number, and 100% means the deliverable
  // EXISTS (all units done) rather than "the word count ran out of road".
  const unitPercent = total > 0 ? Math.round((done / total) * 100) : 0;
  const percent = Math.min(wordsPercent, unitPercent);
  return {
    done,
    total,
    words,
    wordsTarget: job.target.wordsTarget,
    pages: estimatePages(words),
    pagesTarget: estimatePages(job.target.wordsTarget),
    percent,
    complete: total > 0 && done === total,
  };
}

/**
 * The honest progress line — reported to the user every turn.
 *
 * Deliberately quotes BOTH the unit count and the words, because the user
 * asked in pages and a word count alone would look like a dodge. This is the
 * sentence the original session could never produce: it had no idea how much
 * of the book existed.
 */
export function formatProgress(job: LongFormJob): string {
  const p = jobProgress(job);
  const noun = job.deliverableClass === 'creative' ? 'chapter' : 'section';
  return `📖 ${noun} ${p.done}/${p.total} complete · ${formatCount(p.words)}/${formatCount(p.wordsTarget)} words (${p.pages} of ~${p.pagesTarget} pages, ${p.percent}%)`;
}

/** The next `limit` units as a plan the writer can execute one at a time. */
export function nextUnitBrief(job: LongFormJob, limit = MAX_UNITS_PER_RUN): Array<{
  index: number;
  title: string;
  path: string;
  targetWords: number;
  /** Continuity: the previous unit's tail, so the prose joins up. */
  previousTail: string;
}> {
  const briefs: Array<{ index: number; title: string; path: string; targetWords: number; previousTail: string }> = [];
  for (const s of nextPendingSections(job, limit)) {
    briefs.push({
      index: s.index,
      title: s.title,
      path: s.path,
      targetWords: s.targetWords,
      previousTail: readTail(sectionAbsolutePath(job.projectPath, prevSectionPath(job, s.index)), 1_200),
    });
  }
  return briefs;
}

/** Path of the unit before `index`, or '' when there is none. */
function prevSectionPath(job: LongFormJob, index: number): string {
  const prev = job.sections.find((s) => s.index === index - 1);
  return prev ? prev.path : '';
}

/** Last `chars` of a file, or '' when it does not exist. */
export function readTail(absolutePath: string, chars: number): string {
  try {
    if (!absolutePath || !existsSync(absolutePath)) return '';
    const text = readFileSync(absolutePath, 'utf-8');
    return text.length <= chars ? text : text.slice(text.length - chars);
  } catch {
    return '';
  }
}

// ─── Assembly ───────────────────────────────────────────────────────────────

export interface AssemblyResult {
  path: string;
  files: number;
  words: number;
  pages: number;
}

/**
 * Deterministically assemble the finished document from its unit files.
 *
 * Pure concatenation — no LLM, no cost, no drift. Runs only when every unit is
 * done, so the assembled document is never a half-book presented as complete.
 * Returns null when the job is not finished (the caller must not claim
 * completion, and must keep reporting progress instead).
 */
export function assembleDocument(job: LongFormJob): AssemblyResult | null {
  const progress = jobProgress(job);
  if (!progress.complete) return null;

  const parts: string[] = [];
  for (const s of job.sections) {
    const abs = sectionAbsolutePath(job.projectPath, s.path);
    let body = '';
    try {
      if (existsSync(abs)) body = readFileSync(abs, 'utf-8').trim();
    } catch {
      body = '';
    }
    if (body) parts.push(`# ${s.title}\n\n${body}`);
  }
  if (parts.length === 0) return null;

  const text = `${parts.join('\n\n---\n\n')}\n`;
  try {
    const dir = dirname(job.docPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(job.docPath, text, 'utf-8');
  } catch {
    return null;
  }
  const words = countWords(text);
  return { path: job.docPath, files: parts.length, words, pages: estimatePages(words) };
}

/** Relative path display, for a concise log line. */
export function displayPath(projectPath: string, absolute: string): string {
  try {
    return relative(projectPath, absolute) || absolute;
  } catch {
    return absolute;
  }
}

/** Test/reset hook: forget every job. */
export function clearLongFormJobs(): void {
  writeLedger({ version: CURRENT_VERSION, jobs: {} });
}
