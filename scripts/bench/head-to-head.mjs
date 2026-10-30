#!/usr/bin/env node
/**
 * head-to-head — run one agent on a snapshot of a repository and SCORE it.
 *
 * WHY THIS EXISTS (2026-10-25). The plan this gate serves was built from a
 * hand-scored head-to-head: a human counted sections, tags and citations,
 * reconciled 32 defects against the source, and read the cost out of ledger rows.
 * That produced a good answer once and a gate nobody could run again. This script
 * is the repeatable half:
 *
 *   snapshot (git archive, so the audited tree can never be the working tree)
 *     → run the agent under a wall-clock cap, capturing its log
 *     → read the deliverable it produced
 *     → score it (findings, tags, citations, sections, verified recall)
 *     → apply the release gate (cache share, calls/finding, recall)
 *
 * Usage:
 *   node scripts/bench/head-to-head.mjs \
 *     --repo /path/to/project --task ./TASK.md --out /tmp/bench/run1 \
 *     --agent "node dist/index.js chat \"$(cat TASK.md)\" --provider deepseek -m deepseek-flash" \
 *     --cap 1500 --report ../REPORT.md
 *
 *   # score an existing run without spending anything:
 *   node scripts/bench/head-to-head.mjs --out /tmp/bench/run1 --score-only
 *
 * Exit codes: 0 = gate passed, 1 = gate failed, 2 = the run itself failed.
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseUsage, releaseGate, scoreRun } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GROUND_TRUTH = join(HERE, 'fixtures', 'audit-ground-truth.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const outDir = resolve(String(args.out ?? join(process.cwd(), 'bench-run')));
const groundTruthPath = resolve(String(args['ground-truth'] ?? DEFAULT_GROUND_TRUTH));
const reportPath = resolve(outDir, String(args.report ?? 'report.md'));
const logPath = join(outDir, 'run.log');
const repoDir = join(outDir, 'repo');
const summaryJson = join(outDir, 'summary.json');
const summaryMd = join(outDir, 'summary.md');

/** Kill the agent at the cap — a bench that waits forever measures nothing. */
const capSeconds = Number(args.cap ?? 1500);

function fail(message, code = 2) {
  console.error(`head-to-head: ${message}`);
  process.exit(code);
}

/**
 * Snapshot the audited tree. `git archive HEAD` is the point: the agent must never
 * run against a working tree whose uncommitted state (or the agent's own earlier
 * writes) changes the result. A non-git directory is copied instead, with a note.
 */
function snapshot(repo, dest) {
  return new Promise((resolvePromise, rejectPromise) => {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    // `pipefail` is load-bearing: without it the pipeline's status is TAR's, so a
    // `git archive` that failed (not a git checkout) still exited 0 and the
    // "snapshot" was an empty directory. Measured 2026-10-25: two 25-minute runs
    // then audited the parent folder instead of the snapshot, and their numbers
    // were void. bash is used rather than sh because `set -o pipefail` is not
    // POSIX.
    const archive = spawn('bash', ['-o', 'pipefail', '-c', 'git archive HEAD | tar -x -C "$0"', dest], {
      cwd: repo,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    archive.stderr.on('data', (d) => {
      err += String(d);
    });
    archive.on('error', rejectPromise);
    archive.on('close', (code) => {
      if (code === 0) return resolvePromise({ copier: false });
      if (!err.trim()) return rejectPromise(new Error(`git archive failed (exit ${code})`));
      // Not a git checkout — copy it, and say so in the summary.
      try {
        cpSync(repo, dest, { recursive: true, filter: (src) => !src.includes(`${join(repo, '.git')}`) });
        resolvePromise({ copier: true, note: `not a git checkout (${err.trim().split('\n')[0]}) — copied instead` });
      } catch (copyErr) {
        rejectPromise(copyErr);
      }
    });
  });
}

/** Run the agent's command line in the snapshot, capped, streaming to the log. */
function runAgent(command, cwd) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const child = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const collect = (d) => {
      chunks.push(String(d));
      // Stream to the terminal too: a 25-minute run with no output looks hung.
      process.stderr.write(d);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, capSeconds * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, timedOut, wallClockMs: Date.now() - startedAt, log: chunks.join('') });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ code: 1, timedOut: false, wallClockMs: Date.now() - startedAt, log: `${chunks.join('')}\n${err.message}` });
    });
  });
}

function readIfPresent(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

/**
 * Read the deliverable, tolerating the case the AGENT used for its name.
 *
 * The bench cannot require `report.md` while an agent writes `REPORT.md`: on a
 * case-sensitive runner that would score an 80 KB deliverable as "none" and call
 * it a failed run. Only the basename case is normalised — the directory is exactly
 * the one the run was told about.
 */
function readReport(path) {
  const direct = readIfPresent(path);
  if (direct) return direct;
  const dir = dirname(path);
  const base = basename(path);
  for (const candidate of [base.toUpperCase(), base.toLowerCase()]) {
    const text = readIfPresent(join(dir, candidate));
    if (text) return text;
  }
  return '';
}

function fmt(n, digits = 0) {
  return n === null || n === undefined ? '—' : Number(n).toFixed(digits);
}

async function main() {
  if (!existsSync(groundTruthPath)) fail(`ground truth not found: ${groundTruthPath}`);
  const groundTruth = JSON.parse(readFileSync(groundTruthPath, 'utf8'));

  let run = { code: 0, timedOut: false, wallClockMs: null, log: '', snapshotNote: null };
  if (!args['score-only']) {
    if (!args.repo) fail('--repo is required (or pass --score-only with an existing --out)');
    if (!args.agent) fail('--agent is required: the shell command that runs the agent');
    mkdirSync(outDir, { recursive: true });
    const snap = await snapshot(resolve(String(args.repo)), repoDir);
    if (snap.note) run.snapshotNote = snap.note;
    run = { ...run, ...(await runAgent(String(args.agent), repoDir)) };
    writeFileSync(logPath, run.log);
  } else {
    run.log = readIfPresent(logPath);
  }

  const report = readReport(reportPath);
  const usage = parseUsage(run.log);
  const metrics = scoreRun({
    report,
    groundTruth,
    requiredSections: groundTruth.requiredSections ?? [],
    usage,
    wallClockMs: run.wallClockMs,
  });
  const gate = releaseGate(metrics, {
    minCacheShare: Number(args['min-cache-share'] ?? 0.85),
    maxCallsPerFinding: Number(args['max-calls-per-finding'] ?? 3),
    minRecall: args['min-recall'] !== undefined ? Number(args['min-recall']) : null,
    // A timed-out or crashed run is a failure of the RUN, not a set of metrics to
    // compare: without this it scored as a pass because no threshold was breached.
    runCompleted: run.code === 0 && !run.timedOut,
  });

  const summary = {
    ranAt: new Date().toISOString(),
    repo: args.repo ? resolve(String(args.repo)) : null,
    groundTruth: groundTruth.id ?? null,
    exitCode: run.code,
    timedOut: run.timedOut,
    reportBytes: metrics.bytes,
    ...metrics,
    gate,
    snapshotNote: run.snapshotNote,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(summaryJson, `${JSON.stringify(summary, null, 2)}\n`);

  const md = [
    `# Bench run — ${groundTruth.id ?? 'unknown fixture'}`,
    '',
    `| Metric | Value |`,
    `|---|---:|`,
    `| Deliverable | ${metrics.bytes > 0 ? `${metrics.bytes} bytes` : '**none**'} |`,
    `| Wall clock | ${run.wallClockMs === null ? '—' : `${(run.wallClockMs / 1000).toFixed(1)} s`} |`,
    `| Exit code | ${run.code}${run.timedOut ? ' (timed out — killed at the cap)' : ''} |`,
    `| Model calls | ${usage.calls} |`,
    `| Input tokens | ${usage.inputTokens.toLocaleString('en-US')} |`,
    `| Cache share | ${(usage.cacheShare * 100).toFixed(1)}% |`,
    `| Findings | ${metrics.findings} |`,
    `| [F] / [I] / [S] | ${metrics.tags.facts} / ${metrics.tags.inferences} / ${metrics.tags.speculation} |`,
    `| file:line citations | ${metrics.citations} |`,
    `| Sections | ${metrics.sections.delivered} / ${metrics.sections.required} |`,
    `| Verified recall | ${(metrics.recall * 100).toFixed(0)}% (${metrics.matched.length}/${metrics.matched.length + metrics.missed.length}) |`,
    `| Calls per finding | ${fmt(metrics.callsPerFinding, 2)} |`,
    '',
    `**Gate:** ${gate.ok ? '✅ pass' : '❌ fail'}`,
    ...gate.failures.map((f) => `- ${f}`),
    '',
    metrics.missed.length > 0 ? `**Missed ground truth:** ${metrics.missed.join(', ')}` : '',
    run.snapshotNote ? `\n_${run.snapshotNote}_` : '',
    '',
  ].join('\n');
  writeFileSync(summaryMd, md);
  process.stdout.write(`\n${md}\n`);

  if (run.code !== 0 || run.timedOut) process.exit(2);
  process.exit(gate.ok ? 0 : 1);
}

main().catch((err) => fail(err?.stack ?? String(err)));
