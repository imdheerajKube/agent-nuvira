/**
 * Step hand-off — the durable record a FAILED step leaves for whoever runs next.
 *
 * WHY THIS EXISTS (the live NVDA-addon failure):
 * Over 19 attempts on one WhatsApp ask the pipeline never produced the add-on,
 * and every attempt started from an empty hand. The morning's traces show the
 * shape of it: the same plan re-planned 18 times, the same three files "created"
 * 18 times, and a 934s stall in the middle of the run that had a model change
 * underneath it. The design says a broken task is handed to another model — and
 * it is, WITHIN a step (`loop-executor`'s candidate walk). What did not exist is
 * the record that survives the step. So the next candidate, the next turn and
 * the next *run* each re-derived the same plan and re-attempted the same files,
 * with nothing telling them that a previous attempt had already landed two of
 * the three files.
 *
 * The four facts a hand-off carries, in the order they matter:
 *   1. WHAT the step must produce (`declared`) — from the planner's
 *      `expectedFiles` / the goal's named deliverable, not from the model's
 *      self-report.
 *   2. WHAT IS ALREADY ON DISK (`landed`) — re-derived from the filesystem on
 *      every read, never trusted from a previous write. A hand-off that
 *      remembered "installTasks.py: done" while the file was absent would
 *      recreate the exact false completion this exists to end.
 *   3. WHAT IS STILL MISSING (`remaining`).
 *   4. WHO TRIED AND WHY IT FAILED (`attempts`) — so the incoming model is told
 *      what was already attempted, not silently handed the same prompt.
 *
 * Keying (this is what makes a REWORDED ask resume):
 * A step's key is the digest of its DECLARED ARTIFACTS, sorted, so the same
 * deliverable written two different ways in one project maps to one hand-off.
 * Only when a step declares no artifacts does the key fall back to a normalized
 * digest of its description. `loadOpenHandoffs` is project-scoped for the same
 * reason: a run that asks for the same thing in different words still finds the
 * previous attempt, because it is looking at the project, not at the sentence.
 *
 * Deliberately deterministic and LLM-free, like the working-state ledger: facts
 * and a compact block, no summarizer, no drift. Storage is
 * `~/.nuvira/memory/step-handoffs.json` (honours NUVIRA_MEMORY_DIR /
 * BUFF_MEMORY_DIR). Every operation is best-effort and must NEVER throw — a
 * hand-off failure reports, it does not break a run.
 */

import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import { verifyArtifacts } from './artifact-verification.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Why an attempt did not finish. Kept apart: each implies a different repair. */
export type HandoffAttemptKind =
  /** The model never produced a usable reply (generation error / empty step). */
  | 'failed'
  /** A tool gate refused the work (e.g. the path is outside the workspace). */
  | 'refused'
  /** The model answered in the wrong voice (its own reasoning / the tool contract). */
  | 'quality';

/** One model's attempt at a step, and why it stopped. */
export interface HandoffAttempt {
  /** Epoch ms of the attempt. */
  at: number;
  /** `provider:model` that made the attempt. */
  route: string;
  kind: HandoffAttemptKind;
  /** One line naming the failure, for the next model to avoid repeating it. */
  reason: string;
  /** Tokens spent before it stopped, when the caller knows (0 otherwise). */
  tokens?: number;
}

/** Everything worth keeping about one unfinished step. */
export interface StepHandoff {
  /** The goal this step belongs to, as the user stated it. */
  goal: string;
  /** Absolute project path — the hand-off's home. */
  projectPath: string;
  /** Deterministic key for this step (see `stepKeyFor`). */
  stepKey: string;
  /** Human-readable step description, for the injected block. */
  stepDescription: string;
  /** Artifacts the step must produce (absolute or project-relative). */
  declared: string[];
  /** Declared artifacts that ARE on disk right now (re-checked on every read). */
  landed: string[];
  /** Declared artifacts still absent right now. */
  remaining: string[];
  /** Attempts, oldest first (capped). */
  attempts: HandoffAttempt[];
  /**
   * Declared artifacts that are legitimately empty (touch-style markers). The
   * live add-on plan asked for an EMPTY `installTasks.py`, so treating every
   * empty file as unfinished would keep a finished step on the outstanding list
   * forever.
   */
  allowEmpty?: string[];
  updatedAt: number;
}

/** What a caller reports when an attempt at a step stops without finishing. */
export interface HandoffAttemptInput {
  projectPath: string;
  goal: string;
  stepDescription: string;
  /** Artifacts the step must produce. Empty means "key by the description". */
  declared?: string[];
  /** Explicit step key, when the caller already has a stable one (orchestrator task id). */
  stepKey?: string;
  route: string;
  kind: HandoffAttemptKind;
  reason: string;
  tokens?: number;
}

interface HandoffFile {
  version: number;
  entries: Record<string, StepHandoff>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CURRENT_VERSION = 1;
/** Cap on remembered attempts per step (oldest drop first). */
export const MAX_ATTEMPTS = 10;
/** Cap on remembered steps in the whole file (oldest drop first). */
export const MAX_ENTRIES = 120;
/** Cap on the injected block — it rides in prompts, so it stays short. */
export const MAX_BLOCK_CHARS = 1_600;

/**
 * How long a refused/failed attempt stays worth surfacing. A step with no
 * declared artifacts is only "outstanding" while its failure is recent; an
 * ancient refusal is history, not a blocker.
 */
export const MAX_ATTEMPT_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Built-in artifacts a plan may name without the planner declaring them. */
const DELIVERABLE_EXTENSIONS = [
  '.nvda-addon', '.zip', '.wheel', '.whl', '.vsix', '.tar.gz', '.tgz', '.jar', '.epub',
];

// ─── Storage ────────────────────────────────────────────────────────────────

function memoryDir(): string {
  return envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
}

function storePath(): string {
  return join(memoryDir(), 'step-handoffs.json');
}

function readFileSafe(): HandoffFile {
  try {
    if (!existsSync(storePath())) return { version: CURRENT_VERSION, entries: {} };
    const data = JSON.parse(readFileSync(storePath(), 'utf-8')) as HandoffFile;
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
      return { version: CURRENT_VERSION, entries: {} };
    }
    return data;
  } catch {
    return { version: CURRENT_VERSION, entries: {} };
  }
}

function writeFileSafe(data: HandoffFile): void {
  try {
    if (!existsSync(memoryDir())) mkdirSync(memoryDir(), { recursive: true });
    writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Best-effort — a hand-off write must never break a run.
  }
}

/** Normalize a project path so one project always maps to one entry. */
export function normalizeProjectPath(projectPath: string): string {
  try {
    return resolve(projectPath);
  } catch {
    return projectPath;
  }
}

function sha(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/**
 * Normalize a declared artifact path so two spellings of the same file collide:
 * absolute or relative, with either slash, with surrounding quotes or whitespace.
 * Deliberately does NOT resolve against a root — the stored key must be stable
 * whether the caller passes `manifest.ini` or the absolute path.
 */
function normalizeArtifact(declared: string): string {
  return declared
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase();
}

/**
 * Lowercase, punctuation-free, whitespace-collapsed — so rewording still matches.
 * Hyphens and underscores are JOINED rather than split: "add-on" and "addon"
 * are the same word, and that is the pair a person varies most when re-asking.
 */
function normalizeGoal(goal: string): string {
  return (goal || '')
    .toLowerCase()
    .replace(/[-_]+/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * The stable key for a step.
 *
 * Artifacts win when there are any: the same deliverable asked for in different
 * words yields the same key, which is the whole point (a reworded ask must
 * resume). The description is the fallback, normalized so trivial rewording
 * ("Package the addon" / "package  the add-on") collapses to one key.
 */
export function stepKeyFor(input: {
  declared?: string[];
  stepDescription?: string;
  goal?: string;
}): string {
  const artifacts = (input.declared ?? [])
    .map(normalizeArtifact)
    .filter(Boolean)
    .sort();
  if (artifacts.length > 0) return `art:${sha(artifacts.join('\n'))}`;
  const text = input.stepDescription?.trim() || input.goal?.trim() || 'step';
  return `txt:${sha(normalizeGoal(text))}`;
}

/** The composite store key: project + step. Goal text is NOT part of it, on purpose. */
function entryKey(projectPath: string, stepKey: string): string {
  return `${normalizeProjectPath(projectPath)}\u0000${stepKey}`;
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

/**
 * Re-derive `landed` / `remaining` from the filesystem.
 *
 * This is the rule that keeps a hand-off honest: a stored field saying a file
 * was written is a CLAIM, and the live failure was a run that believed one. So
 * every read of a hand-off re-checks disk, and a file that has since vanished
 * moves back into `remaining`.
 */
export function reconcileHandoff(handoff: StepHandoff): StepHandoff {
  const declared = handoff.declared ?? [];
  if (declared.length === 0) return handoff;
  try {
    const check = verifyArtifacts(declared, handoff.projectPath, handoff.allowEmpty ? { allowEmpty: handoff.allowEmpty } : {});
    const bad = new Set([...check.missing, ...check.empty].map(normalizeArtifact));
    const landed = declared.filter((d) => !bad.has(normalizeArtifact(d)));
    const remaining = declared.filter((d) => bad.has(normalizeArtifact(d)));
    return { ...handoff, landed, remaining };
  } catch {
    // An unreadable filesystem is not a verdict — keep the previous split.
    return handoff;
  }
}

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * Record one failed attempt at a step, and return the updated hand-off.
 *
 * Called wherever an attempt stops without finishing: a candidate failing in the
 * loop's failover walk, a task failing in the pipeline, a deliverable that is
 * missing after a step claimed success. A step that later succeeds should call
 * {@link clearStepHandoff} so the next run does not inherit stale guidance.
 */
export function recordStepHandoff(input: HandoffAttemptInput): StepHandoff {
  const projectPath = normalizeProjectPath(input.projectPath);
  const stepKey = input.stepKey || stepKeyFor({
    ...(input.declared ? { declared: input.declared } : {}),
    stepDescription: input.stepDescription,
    goal: input.goal,
  });
  const key = entryKey(projectPath, stepKey);
  const data = readFileSafe();
  const now = Date.now();
  const declared = (input.declared ?? []).filter((d) => d && d.trim());

  const prev: StepHandoff = data.entries[key] ?? {
    goal: input.goal,
    projectPath,
    stepKey,
    stepDescription: input.stepDescription,
    declared,
    landed: [],
    remaining: declared,
    attempts: [],
    updatedAt: now,
  };

  const attempt: HandoffAttempt = {
    at: now,
    route: input.route,
    kind: input.kind,
    reason: (input.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    ...(input.tokens ? { tokens: input.tokens } : {}),
  };

  const attempts = [...prev.attempts, attempt];
  if (attempts.length > MAX_ATTEMPTS) attempts.splice(0, attempts.length - MAX_ATTEMPTS);

  const next = reconcileHandoff({
    ...prev,
    // A later statement of the same step wins: the planner may have learned the
    // real file list on a retry, and the freshest declaration is the better one.
    goal: input.goal || prev.goal,
    stepDescription: input.stepDescription || prev.stepDescription,
    declared: declared.length > 0 ? declared : prev.declared,
    attempts,
    updatedAt: now,
  });

  data.entries[key] = next;
  prune(data);
  writeFileSafe(data);
  return next;
}

/** Drop the oldest entries once the file is over its cap. */
function prune(data: HandoffFile): void {
  const entries = Object.entries(data.entries);
  if (entries.length <= MAX_ENTRIES) return;
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  data.entries = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
}

/** Load one step's hand-off, reconciled against disk (null when none). */
export function loadStepHandoff(
  projectPath: string,
  stepKey: string,
): StepHandoff | null {
  const data = readFileSafe();
  const found = data.entries[entryKey(projectPath, stepKey)];
  return found ? reconcileHandoff(found) : null;
}

/**
 * Every hand-off for a project that still has work left, newest first.
 *
 * Project-scoped rather than goal-scoped on purpose: this is what lets a
 * REWORDED ask resume. The caller asked the same thing of the same project, so
 * the outstanding work is found by project, not by matching sentences.
 *
 * A hand-off whose `remaining` is empty is finished — it is filtered out here so
 * a completed step is never presented as outstanding.
 */
/**
 * Is a step with NO declared artifacts still outstanding?
 *
 * WHY THIS CASE EXISTS (the live Aukat_check ledger): the only entry for that
 * project was `…Aukat_check\0txt:c32b0bf58c29`, `declared: []`, with TEN recorded
 * `refused` attempts — the same `run_terminal` command gated over and over. The
 * old rule dropped every `declared: []` entry, so the ledger recorded ten
 * refusals and the agent was told about none of them. The work was not "a missing
 * file"; it was "a command that keeps being refused", and that is exactly what
 * the next run needed to know.
 */
function hasUnfinishedAttempt(handoff: StepHandoff, now: number): boolean {
  if (handoff.declared.length > 0) return false;
  const last = handoff.attempts[handoff.attempts.length - 1];
  if (!last) return false;
  if (last.kind !== 'refused' && last.kind !== 'failed') return false;
  if (now - last.at > MAX_ATTEMPT_AGE_MS) return false;
  // A REFUSAL is describable outstanding work on its own: the gate asked, the
  // command never ran, and the next run needs to know that. A single vague
  // FAILURE with nothing declared is not ("think about the design" is a note,
  // not a step) — but a step that has failed MORE THAN ONCE is, because the
  // repeat is the signal that the approach is not working.
  return last.kind === 'refused' || handoff.attempts.length >= 2;
}

/**
 * Every hand-off for a project that still has work left, newest first.
 *
 * Project-scoped rather than goal-scoped on purpose: this is what lets a
 * REWORDED ask resume. The caller asked the same thing of the same project, so
 * the outstanding work is found by project, not by matching sentences.
 *
 * "Outstanding" has two honest shapes, and BOTH are returned:
 *   1. a declared artifact that is still missing (`remaining.length > 0`), and
 *   2. a step with no declared artifacts that was REFUSED recently, or has
 *      failed more than once — the repeated-refusal case above.
 * A hand-off that is finished on both counts is filtered out, so a completed
 * step is never presented as outstanding.
 */
export function loadOpenHandoffs(projectPath: string, options: { limit?: number } = {}): StepHandoff[] {
  const key = normalizeProjectPath(projectPath);
  const now = Date.now();
  const data = readFileSafe();
  const open: StepHandoff[] = [];
  for (const [k, value] of Object.entries(data.entries)) {
    if (!k.startsWith(`${key}\u0000`)) continue;
    const reconciled = reconcileHandoff(value);
    const missingArtifact = reconciled.remaining.length > 0;
    if (!missingArtifact && !hasUnfinishedAttempt(reconciled, now)) continue;
    open.push(reconciled);
  }
  open.sort((a, b) => b.updatedAt - a.updatedAt);
  const limit = options.limit ?? 5;
  return open.slice(0, limit);
}

/** Forget one step's hand-off (call it when the step has genuinely finished). */
export function clearStepHandoff(projectPath: string, stepKey: string): void {
  const data = readFileSafe();
  const key = entryKey(projectPath, stepKey);
  if (!(key in data.entries)) return;
  delete data.entries[key];
  writeFileSafe(data);
}

/** Forget every hand-off for a project. */
export function clearProjectHandoffs(projectPath: string): void {
  const prefix = `${normalizeProjectPath(projectPath)}\u0000`;
  const data = readFileSafe();
  let changed = false;
  for (const k of Object.keys(data.entries)) {
    if (k.startsWith(prefix)) {
      delete data.entries[k];
      changed = true;
    }
  }
  if (changed) writeFileSafe(data);
}

// ─── Formatting (the injected block) ────────────────────────────────────────

/** `provider:model` → `provider` (the model name is noise when both are shown). */
function providerOf(route: string): string {
  const idx = route.indexOf(':');
  return idx > 0 ? route.slice(0, idx) : route;
}

/**
 * Format hand-offs as a compact, model-readable block ('' when there is nothing
 * outstanding — a clean project must add no prompt weight).
 *
 * The instruction is blunt by design. The live failure was a run that re-derived
 * a plan it already had and re-attempted files that already existed; "do NOT
 * redo the files listed as already on disk" is the one sentence that changes
 * that behaviour, so it is stated rather than implied.
 */
export function formatHandoffs(handoffs: readonly StepHandoff[], now: number = Date.now()): string {
  // Both shapes of outstanding work (missing artifact, or a repeatedly refused
  // step with nothing declared) are rendered — see `loadOpenHandoffs`.
  const open = handoffs.filter(
    (h) => h.remaining.length > 0 || hasUnfinishedAttempt(h, now),
  );
  if (open.length === 0) return '';

  const lines: string[] = [
    '[Hand-off — earlier attempts at this work did NOT finish. Continue from this state; do not start over.]',
  ];

  for (const h of open) {
    const label = (h.stepDescription || h.goal || 'unfinished step').replace(/\s+/g, ' ').trim().slice(0, 160);
    lines.push(`• ${label}`);
    if (h.landed.length > 0) {
      // Wrapped, not passed by reference: `Array.map` hands the callback
      // (value, index, array), so `.map(shorten)` would pass the INDEX as the
      // width and truncate every path to `…`.
      lines.push(`  ✅ already on disk (do NOT redo): ${h.landed.map((p) => shorten(p)).join(', ')}`);
    }
    if (h.remaining.length > 0) {
      lines.push(`  ⬜ still missing: ${h.remaining.map((p) => shorten(p)).join(', ')}`);
    } else if (h.attempts.length > 0) {
      // No declared artifact: the outstanding fact is the ATTEMPT itself — a
      // step whose command keeps being refused. Naming the count is what turns
      // "it failed again" into "this approach has not worked N times".
      const refused = h.attempts.filter((a) => a.kind === 'refused').length;
      const noun = refused === h.attempts.length ? 'refused' : 'attempted';
      lines.push(`  ⬜ no artifact declared — this step has been ${noun} ${h.attempts.length}×`);
    }
    const last = h.attempts[h.attempts.length - 1];
    if (last) {
      const age = relativeAge(last.at, now);
      const what = last.kind === 'quality'
        ? 'answered with its own reasoning instead of the work'
        : last.kind === 'refused'
          ? 'was refused by a tool gate'
          : 'failed';
      lines.push(`  ⚠️ last attempt (${age}, ${providerOf(last.route)}) ${what}${last.reason ? `: ${last.reason}` : ''}`);
      if (h.attempts.length > 1) {
        lines.push(`  ℹ️ ${h.attempts.length} attempts so far — the approaches above did not work; take a different one.`);
      }
    }
  }

  let block = lines.join('\n');
  if (block.length > MAX_BLOCK_CHARS) {
    block = `${block.slice(0, MAX_BLOCK_CHARS)}\n[hand-off truncated to fit the context budget]`;
  }
  return block;
}

/** Show the tail of a long path — the filename is the part that matters. */
function shorten(path: string, max = 60): string {
  const flat = path.replace(/\\/g, '/');
  if (flat.length <= max) return flat;
  const tail = flat.split('/').slice(-2).join('/');
  return tail.length <= max ? `…/${tail}` : `…${flat.slice(-max)}`;
}

function relativeAge(ts: number, now: number): string {
  const mins = Math.max(0, Math.round((now - ts) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Convenience: the block a caller injects for a project, '' when clean.
 * The single entry point every surface uses, so "load and reconcile" is one
 * call rather than a convention each caller has to remember.
 */
export function handoffBlockFor(projectPath: string, options: { limit?: number } = {}): string {
  try {
    return formatHandoffs(loadOpenHandoffs(projectPath, options));
  } catch {
    return '';
  }
}

/**
 * The artifacts a goal names but a plan may not have declared.
 *
 * A planner that forgets `expectedFiles` leaves the deliverable unverified —
 * exactly the shape of the live failure, where the ask named
 * `kuttaaddon.nvda-addon` and no step declared it. Pulling obvious deliverable
 * paths out of the goal text gives the hand-off (and the verifier) something
 * concrete to check even then. Best-effort and deliberately narrow: only paths
 * with a file extension are taken, capped, and never invented.
 */
export function deliverablesNamedIn(goal: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (path: string): boolean => {
    const key = normalizeArtifact(path);
    if (!path || seen.has(key)) return false;
    seen.add(key);
    found.push(path);
    return found.length >= 8;
  };

  // 1. Anything with a file extension: `kuttaaddon.nvda-addon`, `report.pdf`.
  //    The extension group allows an INTERNAL hyphen, because the deliverable
  //    in the live failure was `.nvda-addon` — the one extension that matters
  //    here is the one a plain `[a-z0-9]` class cannot match.
  const withExt = (goal || '').match(/[~./\w-]*[\w.-]+\.(?:[a-z0-9][a-z0-9-]{0,15})(?:\.[a-z0-9]{2,8})?/gi) ?? [];
  for (const raw of withExt) {
    const path = raw.replace(/^['"]|['"]$/g, '').trim();
    if (!path || !path.includes('.')) continue;
    const lower = path.toLowerCase();
    const interesting =
      DELIVERABLE_EXTENSIONS.some((ext) => lower.endsWith(ext)) ||
      /\//.test(path) ||
      /^(dockerfile|makefile)$/i.test(path);
    if (!interesting) continue;
    if (push(path)) return found;
  }

  // 2. An ABSOLUTE destination with no extension — `Save this in folder
  //    /Users/dheeraj/Documents/kuttaaddon/`. This is the case the live ask
  //    actually used: it named a destination DIRECTORY and never named the
  //    package, so extension-matching alone found nothing to hold the run
  //    accountable to. Two or more segments, so a bare `/tmp` in prose is not
  //    mistaken for a deliverable. Directories satisfy existence, so these are
  //    verified (and re-opened on resume) by the same artifact check as files.
  // Roots: POSIX absolute (`/x/y`), home (`~/x/y`), AND a Windows drive path
  // (`C:\\x\\y`). Without the drive form a Windows ask naming an absolute
  // destination folder — the live NVDA-addon case — matched nothing, so the
  // hand-off was keyed on the refused path instead of the deliverable the ask
  // actually named. Separators are accepted either way so the same goal works
  // on both platforms.
  // `~` is allowed inside a segment because Windows short names are built from
  // it (`C:\\Users\\RUNNER~1\\...`), and stopping at the tilde truncated the
  // destination to `C:\\Users\\RUNNER` — a path the ask never named.
  const absolute = (goal || '').match(/(?:~\/|\/|[A-Za-z]:[\\/])[\w.~-]+(?:[\\/][\w.~-]+)+[\\/]?/g) ?? [];
  for (const raw of absolute) {
    const path = raw.replace(/[.,;:]+$/, '').trim();
    if (!path || path.includes('.')) continue; // extensions handled above
    if (path.split(/[\\/]/).filter(Boolean).length < 2) continue;
    if (push(path)) return found;
  }

  return found;
}
