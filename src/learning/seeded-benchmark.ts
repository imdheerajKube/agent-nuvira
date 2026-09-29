/**
 * WS7 (#29) — running the seeded-bug suite and scoring it.
 *
 * WHY A SEPARATE MODULE FROM `seeded-bugs.ts`. That file is the SUITE — the
 * defects, their fixes, and the verification that each seed is genuinely broken. It
 * is pure data plus a verifier, and it must stay importable by a test with no
 * provider, no network and no engine. This file is the RUNNER: it scaffolds a
 * workspace, hands it to whatever runs the agent, and scores what came back. The
 * agent is INJECTED (`runAgent`) rather than called here, which is what keeps the
 * scoring testable offline — a fake agent that applies the reference fix and one
 * that does nothing are both first-class inputs, and neither costs a token.
 *
 * THREE THINGS ARE SCORED, and they are kept apart because they fail apart:
 *
 *   - DETECTED — did the run say what was wrong? Read from what the agent REPORTED
 *     (its own summary), matched against the defect's diagnostic vocabulary. An
 *     agent can fix a defect it never understood, and it can describe one it failed
 *     to fix; collapsing the two into "passed" hides exactly the difference a
 *     benchmark exists to measure.
 *   - FIXED — do the checks pass now? The ground truth, and the only one that is
 *     not a reading of the model's own prose.
 *   - TARGET-ONLY — did anything ELSE change? Measured by diffing every seeded file
 *     against its original content and listing files the seed never had. A fix that
 *     rewrites three unrelated files is not the same result as one that changes the
 *     single responsible line, and "the tests pass" cannot tell them apart.
 *
 * REFUSES TO SCORE AN UNVERIFIED SEED. Every task is verified first, and a seed
 * that is not provably broken (or not provably fixable) aborts the run instead of
 * being scored — a task that already passes measures nothing, and reporting a
 * number for it is worse than reporting none. `nuvira eval verify-seeds` runs the
 * same check from a terminal, so the ratchet needs no provider at all.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import {
  SEEDED_BUGS,
  materializeSeededBug,
  readWorkspaceFile,
  runSeedCheck,
  seededBugById,
  seededGoal,
  verifySeededBug,
  type SeedVerification,
  type SeededBug,
} from './seeded-bugs.js';

/** What the agent reported back. Everything else is measured from the workspace. */
export interface SeededAgentResult {
  /** What the run said it did — the only input to DETECTED. */
  summary: string;
  /** The run's own success flag, recorded even though scoring does not trust it. */
  success: boolean;
}

export interface SeededRunOptions {
  /** Only run these task ids. */
  taskIds?: string[];
  /** How to run the agent on one task's workspace. Injected for testability. */
  runAgent: (task: { goal: string; workspace: string; bug: SeededBug }) => Promise<SeededAgentResult>;
  /**
   * Verify every seed before scoring it. Default `true`, and turning it off is only
   * for a caller that has already run `verifySeeds()` in this process.
   */
  verifySeeds?: boolean;
  /** Leave the workspaces on disk for inspection. */
  keepWorkspaces?: boolean;
  onProgress?: (index: number, total: number, bug: SeededBug) => void;
}

/** One check's outcome after the run. */
export interface SeededCheckOutcome {
  command: string;
  passed: boolean;
  output: string;
}

/** What one seeded task scored. */
export interface SeededTaskScore {
  id: string;
  title: string;
  axis: string;
  difficulty: 'easy' | 'medium';
  /** The seed is provably broken and provably fixable (see `verifySeededBug`). */
  seedVerified: boolean;
  detected: boolean;
  /** The signal that matched, so a score can be audited rather than believed. */
  detectedBy: string | null;
  fixed: boolean;
  /** Seeded paths whose content differs after the run, plus files the seed never had. */
  changedFiles: string[];
  /** Changed files other than the one the fix belongs in. */
  collateral: string[];
  targetOnly: boolean;
  checks: SeededCheckOutcome[];
  /** 0-1. `null` when the seed did not verify, because nothing was measured. */
  composite: number | null;
  summary: string;
  durationMs: number;
  error?: string;
}

export interface SeededRunSummary {
  tasks: number;
  verified: number;
  detected: number;
  fixed: number;
  cleanFix: number;
  /** Mean composite over the tasks that were actually scored, or null. */
  composite: number | null;
}

export interface SeededRun {
  provider: string;
  model: string;
  startedAt: number;
  endedAt: number;
  scores: SeededTaskScore[];
  summary: SeededRunSummary;
  /** Set when the run refused to score anything, and why. */
  aborted?: string;
  verification?: SeedVerification[];
}

/** Verify every declared seed. Offline, deterministic, no provider. */
export function verifySeeds(taskIds?: string[]): SeedVerification[] {
  const bugs = taskIds && taskIds.length > 0 ? SEEDED_BUGS.filter((b) => taskIds.includes(b.id)) : SEEDED_BUGS;
  return bugs.map((bug) => verifySeededBug(bug));
}

/** Every file in a workspace, as workspace-relative paths. */
function listWorkspaceFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(join(dir, prefix));
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    let isDir = false;
    try {
      isDir = statSync(join(dir, rel)).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out.push(...listWorkspaceFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * What changed in the workspace, against the seed it started from.
 *
 * A file the seed never had is a change too (`seeded: false` at the call site), so
 * an agent that writes a scratch file or a new module cannot look tidier than one
 * that edited in place. Deleted seeded files count as changes as well — a
 * "fix" that removes the failing check is not a fix, and this is what makes that
 * visible rather than merely suspicious.
 */
export function changeReport(
  bug: SeededBug,
  workspace: string,
): { changedFiles: string[]; collateral: string[] } {
  const seeded = new Map(bug.files.map((file) => [file.path, file.content]));
  const present = listWorkspaceFiles(workspace);
  const changed: string[] = [];
  for (const file of present) {
    const content = readWorkspaceFile(workspace, file);
    if (content === null) continue;
    if (!seeded.has(file)) {
      changed.push(file); // created by the agent
      continue;
    }
    if (seeded.get(file) !== content) changed.push(file);
  }
  for (const path of seeded.keys()) {
    if (!present.includes(path)) changed.push(path); // deleted by the agent
  }
  const unique = [...new Set(changed)].sort();
  return {
    changedFiles: unique,
    collateral: unique.filter((file) => file !== bug.target),
  };
}

/** Score DETECTED from what the run reported. Case-insensitive substring match. */
export function detectDefect(bug: SeededBug, summary: string): string | null {
  const haystack = (summary ?? '').toLowerCase();
  for (const signal of bug.detectionSignals) {
    if (haystack.includes(signal.toLowerCase())) return signal;
  }
  return null;
}

/**
 * 0-1 composite: finding it and fixing it weigh the same, and precision is a
 * MODIFIER on a fix rather than a credit of its own.
 *
 * The precision component is gated on `fixed`, and that gate was added after the
 * first real run: a no-op agent scores 100% on "changed nothing but the target"
 * trivially, so an ungated 0.2 paid a run 20% for doing nothing at all — and made a
 * correct fix with collateral (0.8) look only four times better than a run that
 * never opened the file. "Left the rest alone" is only a fact about judgement once
 * there is a change to judge.
 *
 *   perfect (found + fixed + clean)              1.00
 *   fixed + clean, never explained it            0.60
 *   fixed, explained, touched something else     0.80
 *   explained it, never fixed it                 0.40
 *   did nothing                                   0.00
 */
export function scoreSeededTask(detected: boolean, fixed: boolean, targetOnly: boolean): number {
  const found = detected ? 0.4 : 0;
  const repaired = fixed ? 0.4 : 0;
  const precise = fixed && targetOnly ? 0.2 : 0;
  return found + repaired + precise;
}

/**
 * Run the suite and score it.
 *
 * Verification happens FIRST, and every task it rejects aborts the run: the point
 * of the benchmark is that its number is trustworthy, and a number computed over a
 * task that was not actually broken is not.
 */
export async function runSeededSuite(
  provider: string,
  model: string,
  options: SeededRunOptions,
): Promise<SeededRun> {
  const startedAt = Date.now();
  const bugs =
    options.taskIds && options.taskIds.length > 0
      ? options.taskIds.map((id) => seededBugById(id)).filter((b): b is SeededBug => Boolean(b))
      : [...SEEDED_BUGS];

  let verification: SeedVerification[] | undefined;
  if (options.verifySeeds !== false) {
    verification = bugs.map((bug) => verifySeededBug(bug));
    const failed = verification.filter((v) => !v.ok);
    if (failed.length > 0) {
      return {
        provider,
        model,
        startedAt,
        endedAt: Date.now(),
        scores: [],
        verification,
        aborted:
          `${failed.length} seeded bug(s) did not verify (${failed.map((f) => f.id).join(', ')}) — ` +
          'a task that is not provably broken measures nothing, so nothing was scored.',
        summary: { tasks: bugs.length, verified: bugs.length - failed.length, detected: 0, fixed: 0, cleanFix: 0, composite: null },
      };
    }
  }

  const verifiedIds = new Set((verification ?? []).filter((v) => v.ok).map((v) => v.id));
  const scores: SeededTaskScore[] = [];

  for (let index = 0; index < bugs.length; index += 1) {
    const bug = bugs[index];
    options.onProgress?.(index + 1, bugs.length, bug);
    const workspace = mkdtempSync(join(tmpdir(), `seed-run-${bug.id}-`));
    const taskStart = Date.now();
    let agent: SeededAgentResult = { summary: '', success: false };
    let error: string | undefined;
    try {
      materializeSeededBug(bug, workspace, false);
      try {
        agent = await options.runAgent({ goal: seededGoal(bug), workspace, bug });
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      // The checks run AFTER the agent, in the workspace it actually edited — the
      // same scripts that were failing before it started.
      const checks: SeededCheckOutcome[] = bug.checks.map((check) => {
        const result = runSeedCheck(workspace, check);
        return { command: check.command, passed: result.exitCode === 0, output: result.output };
      });
      const { changedFiles, collateral } = changeReport(bug, workspace);
      const detectedBy = detectDefect(bug, agent.summary);
      const fixed = checks.length > 0 && checks.every((c) => c.passed);
      const targetOnly = collateral.length === 0;
      const seedVerified = verification ? verifiedIds.has(bug.id) : true;
      scores.push({
        id: bug.id,
        title: bug.title,
        axis: bug.axis,
        difficulty: bug.difficulty,
        seedVerified,
        detected: detectedBy !== null,
        detectedBy,
        fixed,
        changedFiles,
        collateral,
        targetOnly,
        checks,
        composite: seedVerified ? scoreSeededTask(detectedBy !== null, fixed, targetOnly) : null,
        summary: agent.summary,
        durationMs: Date.now() - taskStart,
        ...(error ? { error } : {}),
      });
    } finally {
      if (!options.keepWorkspaces) rmSync(workspace, { recursive: true, force: true });
    }
  }

  const scored = scores.filter((s) => s.composite !== null);
  const run: SeededRun = {
    provider,
    model,
    startedAt,
    endedAt: Date.now(),
    scores,
    ...(verification ? { verification } : {}),
    summary: {
      tasks: scores.length,
      verified: scores.filter((s) => s.seedVerified).length,
      detected: scores.filter((s) => s.detected).length,
      fixed: scores.filter((s) => s.fixed).length,
      cleanFix: scores.filter((s) => s.fixed && s.targetOnly).length,
      composite:
        scored.length === 0 ? null : scored.reduce((sum, s) => sum + (s.composite ?? 0), 0) / scored.length,
    },
  };
  return run;
}

/** A one-screen report for the terminal. */
export function formatSeededReport(run: SeededRun): string {
  const lines = [
    `Seeded-bug benchmark — ${run.provider}/${run.model}`,
    `  ${((run.endedAt - run.startedAt) / 1000).toFixed(1)}s · ${run.scores.length} task(s)`,
    '',
  ];
  if (run.aborted) {
    lines.push(`✗ aborted: ${run.aborted}`);
    if (run.verification) lines.push('', formatVerificationInline(run.verification));
    return lines.join('\n');
  }
  for (const score of run.scores) {
    const mark = score.fixed && score.detected ? '✅' : score.fixed ? '🟡' : '✗ ';
    lines.push(`  ${mark} ${score.id.padEnd(36)} composite ${pct(score.composite)}`);
    lines.push(
      `      found: ${score.detected ? `yes (${score.detectedBy})` : 'no'} · fixed: ${score.fixed ? 'yes' : 'no'} · ` +
        `touched: ${score.changedFiles.length === 0 ? 'nothing' : score.changedFiles.join(', ')}` +
        (score.collateral.length > 0 ? ` (collateral: ${score.collateral.join(', ')})` : ''),
    );
    if (score.error) lines.push(`      run error: ${score.error}`);
  }
  const s = run.summary;
  lines.push(
    '',
    `  found ${s.detected}/${s.tasks} · fixed ${s.fixed}/${s.tasks} · fixed without touching anything else ` +
      `${s.cleanFix}/${s.tasks} · composite ${pct(s.composite)}`,
  );
  return lines.join('\n');
}

/** The markdown report written into `docs/benchmarks/`. */
export function formatSeededMarkdown(run: SeededRun): string {
  const lines = [
    '# Seeded-bug benchmark',
    '',
    `- **Provider / model:** \`${run.provider}/${run.model}\``,
    `- **Date:** ${new Date(run.startedAt).toISOString().slice(0, 10)}`,
    `- **Duration:** ${((run.endedAt - run.startedAt) / 1000).toFixed(1)}s`,
    `- **Composite:** ${pct(run.summary.composite)} — 40% found + 40% fixed + 20% for touching nothing else (the last only counts when the task was actually fixed)`,
    '',
  ];
  if (run.aborted) {
    lines.push('## Aborted', '', run.aborted, '');
    return lines.join('\n');
  }
  lines.push(
    '## Results',
    '',
    '| Task | Axis | Difficulty | Found | Fixed | Touched nothing else | Composite |',
    '|---|---|---|---|---|---|---|',
  );
  for (const score of run.scores) {
    lines.push(
      `| \`${score.id}\` | ${score.axis} | ${score.difficulty} | ${score.detected ? `yes (${score.detectedBy})` : 'no'} | ` +
        `${score.fixed ? 'yes' : 'no'} | ${score.targetOnly ? 'yes' : `no — ${score.collateral.join(', ')}`} | ${pct(score.composite)} |`,
    );
  }
  const s = run.summary;
  lines.push(
    '',
    '## Summary',
    '',
    `- Found the defect: **${s.detected}/${s.tasks}**`,
    `- Fixed it: **${s.fixed}/${s.tasks}**`,
    `- Fixed it without touching anything else: **${s.cleanFix}/${s.tasks}**`,
    '',
    '## How to read this',
    '',
    '- **Found** is read from what the run REPORTED, matched against the diagnostic',
    '  vocabulary declared with the defect. An agent can fix a defect it never explained, and',
    '  explain one it never fixed,',
    '  which is why the two columns are separate.',
    '- **Fixed** is ground truth: the same checks that failed before the run passed after it.',
    '- **Touched nothing else** diffs every seeded file against its original content and lists files',
    '  the seed never had, so a fix that rewrites unrelated code cannot look like a clean one. It',
    '  is scored as a modifier on a FIX, not as credit of its own — a run that changed nothing',
    '  satisfies "changed nothing it should not have" trivially, and earns 0.',
    '- Every task is verified BEFORE it is scored — a seed that already passes its checks aborts the',
    '  run rather than contributing a number.',
    '',
  );
  return lines.join('\n');
}

function formatVerificationInline(results: readonly SeedVerification[]): string {
  return results
    .map((r) => `  ${r.ok ? '✅' : '✗ '} ${r.id} — seed fails: ${r.seedFails ? 'yes' : 'NO'}, fix passes: ${r.fixPasses ? 'yes' : 'NO'}`)
    .join('\n');
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

/** Where a run's report belongs, matching the M2b convention in `docs/benchmarks/`. */
export function seededReportPath(provider: string, model: string): string {
  const safeModel = model.replace(/[/:]/g, '-');
  return join('docs', 'benchmarks', `seeded-bugs-${provider}-${safeModel}.md`);
}

/** Write a run's markdown report, returning the path. */
export function writeSeededReport(run: SeededRun, path = seededReportPath(run.provider, run.model)): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, formatSeededMarkdown(run), 'utf-8');
  return path;
}
