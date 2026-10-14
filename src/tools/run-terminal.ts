/**
 * P0.4 — `run_terminal` — the verify tool (`src/tools/run-terminal.ts`).
 *
 * The ask (master-plan P0.4): *"test not only by scripts but by actual
 * invocation"* — the agent must run a single test file, a typecheck, a git
 * diff, and see the REAL output in the conversation, not a black-box
 * summary. This is the tool that turns "the tests pass" into verifiable
 * truth the agent can iterate on: run → read failure → edit → re-run.
 *
 * Security model — deny-first, three classes:
 *
 * 1. **deny** — NEVER runs, regardless of confirm. Destructive/system-level
 *    commands outside the loop's business: `sudo`, `git push`, `git reset
 *    --hard`, `git clean`, `git checkout -- .`, `rm -rf` at dangerous
 *    targets, mkfs/dd/shutdown/kill -9, fork bombs. The deny regexes scan
 *    the ENTIRE command string — so `echo $(rm -rf /)` and piped variants
 *    are caught too, not just a leading command.
 * 2. **verify** — read-only check commands run WITHOUT confirmation:
 *    typecheck/test/lint/build runners and git read-only + basic shell
 *    reads. This is a POSITIVE allowlist of leading-token prefixes —
 *    anything not listed falls through to confirm (deny-first default).
 * 3. **confirm** — everything else (state-changing: installs, mutations,
 *    network, arbitrary code) requires `confirm: true`, which the model
 *    only has after the user approved via ask_user — the same gate as
 *    edit_file/write_file and run_cli.
 *
 * Also: a leading `buff`/`agent-nuvira` command is routed to run_cli (the
 * manifest resolver) instead — no double execution paths for CLI control.
 *
 * Output: capped (a 40MB log must not flood context) and masked
 * (maskSenderId — phone numbers never echo back in full).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  applyRemediationAutoFixes,
  diagnoseFailure,
  formatAutoApply,
  formatRemediation,
  remediationAutoApplyEnabled,
} from './remediation-ladder.js';
import type { ToolContext } from './registry.js';
import {
  classifyLiveness,
  formatSpan,
  killProcessTree,
  livenessThresholds,
  processAlive,
  processTableSnapshot,
  sampleProcessTree,
  tableAlive,
  lookupProcess,
  type Liveness,
  type ProcessTable,
} from './process-liveness.js';
import {
  loadRuns,
  processIdentityCheck,
  outputWindow,
  saveRun,
  spoolBytes,
  spoolPath,
  readSpool,
  sweepSpools,
  SpoolWriter,
  type PersistedRun,
} from './run-registry.js';
import { maskSenderId } from '../utils/mask.js';
import { decideStateChange } from '../learning/autonomy-policy.js';
import { envelopeCoversAction } from '../learning/intent-envelope.js';
import { sessionGrantCovers } from '../learning/session-grant.js';
import { grantCategoryForEffect } from './capability-registry.js';
import { applyProjectEnvironment, guardCommandEnvironment } from '../utils/project-env.js';
import { formatEffectVerdict, isBuildCommand, verifyBuildEffect } from '../utils/effect-verification.js';
import { lookupMemo, memoNotice, storeMemo } from './command-memo.js';

/** Cap on how much terminal output is fed back to the model. */
const MAX_OUTPUT_CHARS = 6000;
/** Default timeout for a terminal command (tests/builds are slow). */
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * P7 (fix_model_routing) — the default when a PERSON is watching.
 *
 * The live failure: three back-to-back 120-second `run_terminal` timeouts in one
 * turn (4 minutes of a 5-minute run) while the dashboard console showed nothing,
 * and then the agent gave up. Two minutes of silence in front of a person is not
 * patience, it is a bug. Sixty seconds still covers a real test/build on this
 * class of project, and an explicit `timeout_ms` (up to MAX_WAIT_MS) still buys
 * the model as much time as the work genuinely needs.
 */
const INTERACTIVE_DEFAULT_TIMEOUT_MS = 60_000;
/**
 * The longest this tool WAITS inside one call before handing the command to the
 * monitored (`still running`) path. This is NOT a kill switch any more — see
 * `assessCommandTime` and the detached-run registry below: reaching it means the
 * tool stops blocking and reports, never that the work is destroyed.
 */
const MAX_WAIT_MS = 1_800_000;

/**
 * What a command CLASS actually needs, so the wait is chosen from the work
 * instead of a single flat number.
 *
 * The measured defect this replaces: every command that was not a quick read got
 * 60–120s and then a SIGTERM, so `npm test` on a real repo — minutes by nature,
 * and the very command the tool exists for — was killed mid-run, its partial
 * output reported as a failure, and the turn built conclusions on a run that
 * never finished. Freebuff-style behaviour is the opposite: assess the time the
 * work needs, wait for it, and when it outlives the wait, KEEP IT RUNNING and
 * report what it is doing — never destroy it and call that a result.
 *
 * Order matters: the first match wins, so the most specific/expensive class is
 * listed first (a `docker build` is not an `npm install`).
 */
const LONG_COMMAND_BUDGETS: Array<{ re: RegExp; budgetMs: number; why: string }> = [
  {
    re: /(^|\s)(docker\s+(build|compose\s+up)|make|cmake\s+--build|gradle(w)?\s|mvn\s)/,
    budgetMs: 900_000,
    why: 'a container/compiler build',
  },
  {
    re: /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?(test|test:\S+|ci|install|i|add)\b|(^|\s)(vitest|jest|pytest|go\s+test|cargo\s+test|ng\s+test)\b/,
    budgetMs: 900_000,
    why: 'a test suite / dependency install',
  },
  {
    re: /(^|\s)(npm|pnpm|yarn|bun)\s+run\s+(build|compile|bundle|dist)\b|(^|\s)(tsc|vite\s+build|webpack|rollup|esbuild|cargo\s+build|go\s+build)\b/,
    budgetMs: 600_000,
    why: 'a build',
  },
  {
    re: /(^|\s)(pip3?|poetry|bundle|composer)\s+(install|add|sync)\b/,
    budgetMs: 600_000,
    why: 'a dependency install',
  },
];

/**
 * The wait budget this command deserves, and the reason (for the message).
 * Exported so the assessment is testable on its own — it is a decision, not an
 * implementation detail.
 */
export function assessCommandTime(command: string): { budgetMs: number; why: string } | null {
  const cmd = command.toLowerCase();
  for (const { re, budgetMs, why } of LONG_COMMAND_BUDGETS) {
    if (re.test(cmd)) return { budgetMs, why };
  }
  return null;
}

/**
 * How long this call waits before handing the command to monitoring.
 *
 * Priority, and why in that order:
 *  1. an explicit `timeout_ms` — the model knows something the classifier does not;
 *  2. the ASSESSED class — a full test suite or a build is minutes by nature, and
 *     giving it the short default is what produced the kill-mid-run failures;
 *  3. the room — a person watching waits less (P7), an unattended run waits more.
 *
 * Exported because this is a decision, not an implementation detail: it is what
 * `run_terminal` believes the work needs, and it should be asserted directly
 * rather than inferred from a message.
 */
export function resolveWaitMs(
  command: string,
  explicitMs: number | undefined,
  interactive: boolean | undefined,
): number {
  const assessed = assessCommandTime(command);
  const base = interactive ? INTERACTIVE_DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_WAIT_MS, Math.max(1000, Math.floor(explicitMs ?? assessed?.budgetMs ?? base)));
}
/**
 * P7 — how many times the SAME command (at the SAME timeout) may fail before the
 * next call is refused.
 *
 * Two, measured from the live run: it ran a near-identical command three times
 * (120s, 13s, 120s) and learned nothing from any of them — so the third blind
 * repeat is exactly what must not happen. A flaky command still gets one retry
 * (transient failures are real: a held lock, a dead port, a cold cache). After
 * the second identical failure the refusal is returned in milliseconds with what
 * to do instead, rather than spending another 60–120 seconds to learn nothing.
 *
 * The streak key (see the call site) includes the EFFECTIVE TIMEOUT, so the
 * remedy this very tool advertises on a timeout — "re-call with an explicit
 * `timeout_ms`" — is a genuinely different attempt and is never blocked here.
 */
const IDENTICAL_FAILURE_CAP = 2;
/** Failures older than this do not count toward the cap — the world may have changed. */
const FAILURE_STREAK_WINDOW_MS = 10 * 60_000;
/** Bound on the streak table (a long session must not accumulate). */
const FAILURE_STREAK_MAX_ENTRIES = 50;

/** `key → {count, lastAt}` for the identical-command guard. */
const commandFailureStreaks = new Map<string, { count: number; lastAt: number }>();

/** Test/DI seam: forget every recorded failure streak. */
export function resetTerminalFailureStreaks(): void {
  commandFailureStreaks.clear();
}

/** Record a failure for this exact command in this directory; report the streak. */
function recordCommandFailure(key: string, now: number): number {
  const prev = commandFailureStreaks.get(key);
  const withinWindow = prev && now - prev.lastAt <= FAILURE_STREAK_WINDOW_MS;
  const count = (withinWindow ? prev.count : 0) + 1;
  commandFailureStreaks.set(key, { count, lastAt: now });
  if (commandFailureStreaks.size > FAILURE_STREAK_MAX_ENTRIES) {
    for (const [k, v] of commandFailureStreaks) {
      if (commandFailureStreaks.size <= FAILURE_STREAK_MAX_ENTRIES) break;
      if (now - v.lastAt > FAILURE_STREAK_WINDOW_MS) commandFailureStreaks.delete(k);
    }
    // Still too big (all recent) — drop the oldest half by insertion order.
    if (commandFailureStreaks.size > FAILURE_STREAK_MAX_ENTRIES) {
      const drop = Math.ceil(commandFailureStreaks.size / 2);
      let i = 0;
      for (const k of commandFailureStreaks.keys()) {
        if (i++ >= drop) break;
        commandFailureStreaks.delete(k);
      }
    }
  }
  return count;
}

/** A command that just SUCCEEDED has nothing to retry — clear its streak. */
function clearCommandFailure(key: string): void {
  commandFailureStreaks.delete(key);
}

/**
 * ─── Monitored runs: a long command is FOLLOWED, never killed ───────────────
 *
 * This registry is the whole difference between the old behaviour and this one.
 * The old code armed a timer that SIGTERMed the child, so a command whose real
 * runtime is minutes — a full test suite, a build — was destroyed mid-run and
 * the tool reported a failure about work that was merely unfinished; the model
 * then reasoned from a run that never completed. Killing is not a result.
 *
 * Now the wait budget only decides how long THIS CALL blocks. When it runs out,
 * the child keeps running, its output keeps accumulating here, and the tool
 * returns what it knows: how long it has been going, whether it is producing
 * output at all, and the id to follow it with. The agent polls, does other work,
 * and gets the real exit code when the work actually lands.
 */
interface DetachedRun {
  id: string;
  command: string;
  cwd: string;
  /**
   * The live handle — present only when THIS process spawned the run. A run
   * recovered from the registry after a restart has none: it is identified by
   * `pid` and followed through the spool.
   */
  child?: ChildProcess;
  /** The process-tree root to sample and signal. */
  pid: number | null;
  /**
   * Recovered from disk after a restart (no in-memory output, and the pid has to
   * be re-verified as OURS before it is ever signalled).
   */
  reattached?: boolean;
  /** `true`/`false` when the re-attached pid was checked; `null` = unverifiable. */
  pidVerified?: boolean | null;
  /** WHY that check came out that way — a refusal the operator can act on. */
  pidVerifiedWhy?: string;
  /**
   * The OS's own start token for this run's process, read ONCE while the process
   * is certainly still ours (at hand-off). It is the second identity witness —
   * see `processIdentityVerdict` for why a pid plus a command line is not enough.
   */
  osStartedAt?: string | null;
  /** True when the in-memory output is missing its beginning (the head is in the spool). */
  truncatedOutput?: boolean;
  /** The bounded head+tail spool for this run's output. */
  spool?: SpoolWriter;
  /** When the run ended, when it was watched to the end. */
  endedAt?: number;
  startedAt: number;
  /** When the last output byte arrived — the silence detector's input. */
  lastOutputAt: number;
  bytes: number;
  out: string;
  err: string;
  status: 'running' | 'done';
  exitCode: number | null;
  /** Cumulative CPU ms of the process TREE at the last sample (null = unmeasurable). */
  cpuMs?: number | null;
  /** When that sample was taken. */
  sampledAt?: number;
  /** The watchdog's last verdict for this run, and the evidence behind it. */
  verdict?: Liveness;
  verdictWhy?: string;
  /** When a CONFIRMED hang began (reset the moment the run speaks or computes). */
  hungSince?: number | null;
  /** True when the watchdog stopped the run (never for a run that was working). */
  reaped?: boolean;
  /** True when the model/operator asked for it to stop. */
  stopRequested?: boolean;
  /** Why the run stopped, when it was stopped rather than finishing on its own. */
  exitReason?: string;
  /** A confirmed hang that will NOT be stopped (a re-attached run we cannot re-verify). */
  hangUnstoppable?: boolean;
  /** SIGKILL grace after a SIGTERM. */
  killGrace?: ReturnType<typeof setTimeout> | null;
}

const detachedRuns = new Map<string, DetachedRun>();
/** Bounded: a long session must not accumulate output buffers. */
const MAX_DETACHED_RUNS = 20;

/** ─── The liveness watchdog: identifying a HANG, and acting on it ────────────
 *
 * Monitoring without a heartbeat recreates the opposite defect: a command that
 * is genuinely stuck (a prompt with no stdin, a lock, a socket that never
 * answers) runs forever, and "still running" is not a diagnosis. Terminating on
 * a clock is the bug this whole file already removed, so the replacement is:
 *
 *   identify — sample the run's process TREE for cumulative CPU every so often;
 *              silence ALONE is never a hang (a real suite is quiet for
 *              minutes), but silence AND a measurable absence of CPU is;
 *   report   — a confirmed hang is surfaced on `poll`/`list` with its evidence;
 *   act      — and only then, after a further grace in which the run shows
 *              neither output nor CPU, is it stopped (SIGTERM, then SIGKILL on
 *              the whole tree). Any output or any CPU at any sample clears the
 *              hang, so a slow-but-working command is never touched.
 *
 * `NUVIRA_HANG_REAP_MS=0` keeps the identification and reporting and disables
 * the stopping (report-only); `NUVIRA_HANG_QUIET_MS` and `NUVIRA_HANG_CPU_MS`
 * tune what counts as a hang; `NUVIRA_HANG_POLL_MS` tunes the sample rate.
 */
function envMs(name: string, fallback: number): number {
  const raw = Number.parseInt(String(process.env[name] ?? '').trim(), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** How often a monitored run's process tree is sampled. */
function hangPollMs(): number {
  return Math.max(1_000, envMs('NUVIRA_HANG_POLL_MS', 30_000));
}

/** How long a CONFIRMED hang is left running before it is stopped (0 = never). */
export function hangReapMs(): number {
  return envMs('NUVIRA_HANG_REAP_MS', 300_000);
}

let watchdog: ReturnType<typeof setInterval> | null = null;
let lastSampleAt = 0;

function ensureWatchdog(): void {
  if (watchdog) return;
  watchdog = setInterval(() => sampleMonitoredRuns(), hangPollMs());
  // A monitored run must never hold the process open — the CLI exits when the
  // turn ends, and the run's own exit handler is what reports its result.
  watchdog.unref?.();
}

function stopWatchdogIfIdle(): void {
  if (!watchdog) return;
  if ([...detachedRuns.values()].some((r) => r.status === 'running')) return;
  clearInterval(watchdog);
  watchdog = null;
}

/** Stop a run the watchdog has established is hung, and say why. */
function reapHungRun(run: DetachedRun, why: string, table?: ProcessTable | null): void {
  if (!maySignal(run)) {
    // A recovered run whose pid could not be re-verified is NEVER signalled — the
    // pid may belong to someone else by now. It stays flagged and reported, and
    // `exitReason` is NOT set: it is still running, and saying otherwise would be
    // the kind of lie the rest of this file exists to avoid.
    run.hangUnstoppable = true;
    return;
  }
  run.reaped = true;
  run.exitReason = why;
  killProcessTree(run.pid ?? -1, 'SIGTERM', run.child, table);
  run.killGrace = setTimeout(() => {
    killProcessTree(run.pid ?? -1, 'SIGKILL', run.child);
  }, 5_000);
  run.killGrace.unref?.();
  // Persisted IMMEDIATELY: the reason a run was stopped must survive the very
  // crash the registry exists for.
  persistRun(run);
}

/**
 * One heartbeat over every monitored run.
 *
 * Exported (and takes `now`) so the decision can be driven deterministically in
 * a test instead of waited for.
 */
export function sampleMonitoredRuns(now = Date.now()): void {
  const thresholds = livenessThresholds();
  const reapAfter = hangReapMs();
  const sampleWindowMs = lastSampleAt > 0 ? now - lastSampleAt : hangPollMs();
  lastSampleAt = now;
  // ONE read per tick, shared by every run, by the reconciliation below and by any
  // signalling: on Windows each read is a PowerShell start, and a tick must not
  // cost one per run. The registry is read at most once too, and only when there
  // is a recovered run to reconcile.
  const table = processTableSnapshot();
  const needsRegistry = [...detachedRuns.values()].some((r) => r.reattached && r.status === 'running');
  const recorded = needsRegistry ? loadRuns() : undefined;

  for (const run of [...detachedRuns.values()]) {
    if (run.status !== 'running') continue;
    refreshReattachedRun(run, now, { table, ...(recorded ? { recorded } : {}) });
    if (run.status !== 'running') continue; // it ended while we were not watching
    const sample = sampleProcessTree(run.pid ?? -1, table);
    // A run this process spawned is alive until its own exit event says otherwise.
    // A recovered one has no such event, so the process table is the only witness
    // — and "cannot tell" (null) must read as alive, never as finished.
    // `!== false` on purpose: a platform that cannot read the process table
    // reports `null`, and "cannot tell" must read as ALIVE (a recovered run is
    // never declared dead by a guess).
    const alive = run.reattached
      ? tableAlive(table, run.pid ?? -1) !== false
      : run.child !== undefined && run.child.exitCode === null && run.child.signalCode === null;
    const verdict = classifyLiveness(
      {
        alive,
        bytes: run.bytes,
        quietMs: now - run.lastOutputAt,
        ageMs: now - run.startedAt,
        cpuMs: sample.cpuMs,
        prevCpuMs: run.cpuMs ?? null,
        sampleWindowMs,
      },
      thresholds,
    );
    run.cpuMs = sample.cpuMs;
    run.sampledAt = now;
    run.verdict = verdict.verdict;
    run.verdictWhy = verdict.why;

    if (verdict.verdict === 'hung') {
      // The grace starts once, at the FIRST confirmed hang — and every later
      // sample that still shows a hang keeps it running toward the reap.
      run.hungSince = run.hungSince ?? now;
      if (reapAfter > 0 && now - run.hungSince >= reapAfter && !run.stopRequested) {
        reapHungRun(
          run,
          `hung: no output and no CPU for ${formatSpan(now - run.startedAt)} ` +
            `(confirmed hung for ${formatSpan(now - run.hungSince)})`,
          table,
        );
      }
    } else {
      // It spoke or it computed — it is not hung, and the grace starts over.
      run.hungSince = null;
    }
  }
  stopWatchdogIfIdle();
}

/**
 * The marker a result carries when the command OUTLIVED its wait budget and is
 * still running under monitoring.
 *
 * It is neither success nor failure, and the loop must read it as neither:
 *
 *  - NOT success — a live run has verified nothing yet. Counting it as proof is
 *    how a turn ends up claiming "the tests pass" about a suite that is still on
 *    its first file.
 *  - NOT failure — reporting it as one is the bug this whole change removes: the
 *    work was destroyed (or, now, is still going) and the user is told it broke.
 *
 * So it is its own state, and this exported string is the one both the tool and
 * the loop's success classifier read (see `ranOk` in tool-loop.ts).
 */
export const RUN_TERMINAL_INCOMPLETE_PREFIX = '⏳ run_terminal: still running';

/**
 * Write a run's record to the durable registry (see `run-registry.ts`).
 *
 * Best-effort by construction: a run must never fail because a state file could
 * not be written. What it buys is that the NEXT process can still answer "what is
 * running, and how did it end?" — which is otherwise lost with this one.
 */
function persistRun(run: DetachedRun): void {
  if (run.pid === null || run.pid <= 0) return;
  saveRun({
    id: run.id,
    command: run.command,
    cwd: run.cwd,
    pid: run.pid,
    startedAt: run.startedAt,
    status: run.status,
    exitCode: run.exitCode,
    ...(run.status === 'done' ? { endedAt: run.endedAt ?? Date.now() } : {}),
    ...(run.exitReason ? { exitReason: run.exitReason } : {}),
    ...(run.reaped ? { reaped: true } : {}),
    ...(run.stopRequested ? { stopRequested: true } : {}),
    ...(run.osStartedAt ? { osStartedAt: run.osStartedAt } : {}),
  });
}

/**
 * Re-verify a recovered run's pid against BOTH witnesses, keeping the evidence.
 * One process-table read, and the reason is reported alongside the verdict.
 */
function identityOf(entry: PersistedRun): { pidVerified: boolean | null; pidVerifiedWhy: string } {
  const check = processIdentityCheck(
    { command: entry.command, osStartedAt: entry.osStartedAt ?? null },
    lookupProcess(entry.pid),
  );
  return { pidVerified: check.verdict, pidVerifiedWhy: check.why };
}

/**
 * Read the OS's start token for a process we are holding a handle to.
 *
 * Called ONCE per run, at hand-off, for a reason: it has to be read while the
 * process is certainly still ours. Reading it later (at re-attach, after a
 * restart) would be asking the recycled pid to identify itself — the very thing
 * this token exists to check. A failed read is `null`, which downgrades the
 * recovered run to the command-line witness alone rather than inventing one.
 */
function readOsStartToken(pid: number | null): string | null {
  if (pid === null || pid <= 0) return null;
  try {
    return lookupProcess(pid)?.startedAtText ?? null;
  } catch {
    return null;
  }
}

/**
 * May this run be signalled?
 *
 * A run this process started — yes, we hold the child handle. A run RECOVERED
 * from the registry — only once its pid has been re-verified as still being that
 * command, because a pid that outlived the process table it came from may now
 * belong to something else, and this tool only ever signals work it started.
 */
function maySignal(run: DetachedRun): boolean {
  return run.reattached !== true || run.pidVerified === true;
}

/**
 * Bring a RE-ATTACHED run up to date with the truth on disk.
 *
 * A recovered run has no exit event — the process that would have fired one may
 * be gone — so nothing would ever move it out of `running`: the poll would report
 * "still running" forever about a command that finished minutes ago. Two
 * witnesses settle it: the registry entry (the owning process records the exit
 * code, the stop reason and the reap), and the process table.
 */
function refreshReattachedRun(
  run: DetachedRun,
  now = Date.now(),
  /** What a tick already read, so reconciling cost stays O(1) reads, not O(runs). */
  context: { table?: ProcessTable | null; recorded?: PersistedRun[] } = {},
): void {
  if (!run.reattached || run.status !== 'running') return;
  const recorded = (context.recorded ?? loadRuns()).find((r) => r.id === run.id);
  if (recorded && recorded.status === 'done') {
    run.status = 'done';
    run.exitCode = recorded.exitCode;
    run.endedAt = recorded.endedAt ?? now;
    if (recorded.exitReason) run.exitReason = recorded.exitReason;
    if (recorded.reaped) run.reaped = true;
    if (recorded.stopRequested) run.stopRequested = true;
    return;
  }
  // The tick's own table when it has one; otherwise (the poll path, a single call)
  // a read of its own. `false` is the only value that means gone.
  const alive =
    context.table === undefined ? processAlive(run.pid ?? -1) : tableAlive(context.table, run.pid ?? -1);
  if (alive === false) {
    run.status = 'done';
    run.endedAt = now;
    run.exitReason =
      run.exitReason ?? 'the process is gone, and its exit code was not recorded — nothing was watching when it ended';
  }
}

let hydrated = false;

/**
 * Re-attach to the runs a PREVIOUS process left behind.
 *
 * Without this, every restart orphaned the record of work that is still going:
 * the command keeps running, nothing can poll it, and the turn that started it
 * has no way to collect its real verdict. Runs whose process is gone are marked
 * finished (with an honest "its exit code was not recorded" reason), and live
 * ones are re-attached to be polled, sampled and — only after their pid is
 * re-verified — stopped.
 *
 * Returns how many runs were recovered.
 */
export function hydrateMonitoredRuns(): number {
  if (hydrated) return 0;
  hydrated = true;
  let recovered = 0;
  for (const entry of loadRuns()) {
    if (detachedRuns.has(entry.id)) continue;
    const alive = processAlive(entry.pid);
    const finished = entry.status === 'done' || alive === false;
    const run: DetachedRun = {
      id: entry.id,
      command: entry.command,
      cwd: entry.cwd,
      pid: entry.pid,
      startedAt: entry.startedAt,
      // The silence clock starts NOW, not at the start of the run: we have no
      // output timeline for a recovered run, and running it from `startedAt`
      // would judge a long-quiet-but-working command hung the instant we looked.
      lastOutputAt: entry.endedAt ?? Date.now(),
      bytes: spoolBytes(entry.id),
      out: '',
      err: '',
      status: finished ? 'done' : 'running',
      exitCode: entry.exitCode,
      reattached: true,
      // TWO witnesses, decided by `processIdentityVerdict`: the command line, and
      // the OS start token captured at hand-off. The token is what turns "I cannot
      // prove this is ours, so I will only watch it" into "this IS the process I
      // started, so it can still be stopped" — and, in the other direction, what
      // refuses to adopt a recycled pid running the SAME command line.
      ...(finished
        ? { pidVerified: false }
        : identityOf(entry)),
      osStartedAt: entry.osStartedAt ?? null,
      truncatedOutput: true, // the head lives in the spool, never in memory
      ...(entry.endedAt !== undefined ? { endedAt: entry.endedAt } : {}),
      ...(entry.exitReason ? { exitReason: entry.exitReason } : {}),
      ...(entry.reaped ? { reaped: true } : {}),
      ...(entry.stopRequested ? { stopRequested: true } : {}),
    };
    if (run.status === 'done' && entry.status !== 'done') {
      run.exitReason =
        'it ended while nothing was watching (this process restarted) — its exit code was not recorded';
      persistRun(run);
    }
    detachedRuns.set(run.id, run);
    recovered += 1;
  }
  if (recovered > 0) {
    pruneDetachedRuns();
    ensureWatchdog();
  }
  // Records are capped; files are not a record. Sweeping here — the one moment
  // the live set is exactly known — is what keeps "bounded state" true of the
  // disk and not just of the JSON.
  sweepSpools([...detachedRuns.keys()]);
  return recovered;
}

/** Test/DI seam: forget the monitored runs. Kills nothing (they keep running). */
export function resetDetachedRuns(): void {
  detachedRuns.clear();
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
  lastSampleAt = 0;
  hydrated = false;
}

function pruneDetachedRuns(): void {
  if (detachedRuns.size <= MAX_DETACHED_RUNS) return;
  // Finished first — they are only kept so a late poll can read their result.
  for (const [id, run] of detachedRuns) {
    if (detachedRuns.size <= MAX_DETACHED_RUNS) break;
    if (run.status === 'done') detachedRuns.delete(id);
  }
  if (detachedRuns.size > MAX_DETACHED_RUNS) {
    // All still running: drop the oldest MONITORING entry. The process is NOT
    // killed — it simply stops being pollable by id.
    const oldest = [...detachedRuns.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest) detachedRuns.delete(oldest.id);
  }
}

/** The tail of a buffer, capped like the output this tool returns. */
function outputTail(s: string): string {
  return s.trim().length > MAX_OUTPUT_CHARS ? s.trim().slice(-MAX_OUTPUT_CHARS) : s.trim();
}

/** `45s` / `3m 05s` — how long, for a human reading the tool result. */
function elapsedLabel(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
}

/**
 * This run's output, as the model should see it.
 *
 * The in-memory buffer is used when it is COMPLETE — the common case, and the
 * existing behaviour. When the beginning was lost to the buffer's bound, or the
 * run was recovered from disk and there is no buffer at all, the spooled
 * head+tail is read instead: a long run's diagnosis needs the first lines (what
 * it was doing, how it was invoked) as much as the last.
 */
function runOutputText(run: DetachedRun): string {
  if (!run.truncatedOutput && !run.reattached && (run.out || run.err)) return outputTail(run.out || run.err);
  const spooled = readSpool(run.id);
  if (spooled) {
    const window = outputWindow(spooled, MAX_OUTPUT_CHARS);
    if (window.text.trim()) return window.text.trim();
  }
  return outputTail(run.out || run.err);
}

/** The liveness of a monitored run, as a short badge for `list`/`poll`. */
function livenessBadge(run: DetachedRun): string {
  if (run.reaped) return '🧯 stopped (hung)';
  if (run.status === 'done') return `✔ finished (exit ${run.exitCode ?? '?'})`;
  const elapsed = `⏳ running ${elapsedLabel(Date.now() - run.startedAt)}`;
  switch (run.verdict) {
    case 'hung':
      return `${elapsed} · 🚫 HUNG (no output and no CPU) — will be stopped after the grace`;
    case 'stalled':
      return `${elapsed} · ⚠️ quiet — ${run.verdictWhy ?? 'no output recently'}`;
    case 'working':
      return `${elapsed} · ✅ working — ${run.verdictWhy ?? 'making progress'}`;
    default:
      return elapsed;
  }
}

/**
 * Everything currently being followed.
 *
 * Hydrates first, so this answers for the runs a PREVIOUS process left behind as
 * well as this one's — otherwise a restart would make the whole list vanish while
 * the commands are still running.
 */
export function listDetachedRuns(): string {
  const recovered = hydrateMonitoredRuns();
  if (detachedRuns.size === 0) {
    return 'run_terminal: nothing is being monitored — no command has outlived its wait budget in this process.';
  }
  const lines = [...detachedRuns.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(
      (r) =>
        `- run_terminal[${r.id}] ${livenessBadge(r)} · ${r.bytes} bytes · \`${maskSenderId(r.command)}\`` +
        (r.reattached ? ' · ↩ recovered from a previous process' : ''),
    );
  return (
    `run_terminal — monitored commands:\n${lines.join('\n')}\n\n` +
    `Poll one with run_terminal(action:'poll', process_id:'<id>'); stop one with run_terminal(action:'stop', process_id:'<id>').` +
    (recovered > 0
      ? `\n(${recovered} recovered from the registry a previous process wrote — they are still being followed.)`
      : '')
  );
}

/**
 * Stop one monitored run deliberately (the model's own decision after a
 * diagnosis). Bounded on purpose: it can only ever touch a command THIS tool
 * started and is still following — never an arbitrary pid.
 */
export function stopDetachedRun(id: string): string {
  hydrateMonitoredRuns();
  const run = id ? detachedRuns.get(id) : undefined;
  if (!run) return unknownRunMessage(id);
  if (run.status !== 'running') {
    return (
      `run_terminal[${run.id}] already finished (exit ${run.exitCode ?? '?'}) — nothing to stop. ` +
      (runOutputText(run) ? `Its output:\n${maskSenderId(runOutputText(run))}` : '(no output)')
    );
  }
  // A RECOVERED run is identified only by a pid, and a pid can be recycled — so
  // it is stopped only once its command line has been re-verified as ours. The
  // alternative is signalling a stranger's process, which this tool must never do.
  if (!maySignal(run)) {
    return (
      `Error: run_terminal: run_terminal[${run.id}] was recovered from a previous process, and its pid ` +
      `(${run.pid ?? '?'}) could not be re-verified as still being \`${maskSenderId(run.command)}\` — ` +
      `${run.pidVerifiedWhy ?? 'the check could not be completed'}. Refusing to signal it rather than risk ` +
      `stopping an unrelated process. Its output is spooled here: ${spoolPath(run.id)}. ` +
      `If you know it is still yours, stop it by hand with its PID.`
    );
  }
  run.stopRequested = true;
  run.exitReason = 'stopped on request';
  const signalled = killProcessTree(run.pid ?? -1, 'SIGTERM', run.child);
  run.killGrace = setTimeout(() => {
    killProcessTree(run.pid ?? -1, 'SIGKILL', run.child);
  }, 5_000);
  run.killGrace.unref?.();
  persistRun(run);
  return (
    `🛑 run_terminal[${run.id}] — SIGTERM sent to ${signalled.length || 'the'} process(es) of \`${maskSenderId(run.command)}\` ` +
    `(the shell AND the real work under it; SIGKILL follows in 5s if it does not exit).\n` +
    `Poll it with run_terminal(action:'poll', process_id:'${run.id}') to get its output and exit code. ` +
    `Nothing else was touched.`
  );
}

/** The one message a poll/stop gives for an id nobody is monitoring. */
function unknownRunMessage(id: string): string {
  const known = [...detachedRuns.keys()];
  return (
    `Error: run_terminal: no monitored command with id \`${maskSenderId(id)}\`.` +
    (known.length > 0 ? ` Known: ${known.join(', ')}.` : ' Nothing is being monitored.') +
    ` Use run_terminal(action:'list') to see what is.`
  );
}

/**
 * The state of one monitored command. A finished one keeps its result available
 * (bounded) so the agent can read the exit code and output after doing other
 * work — the poll is how a long command's verdict finally reaches the turn.
 */
export function pollDetachedRun(id: string): string {
  hydrateMonitoredRuns();
  const run = id ? detachedRuns.get(id) : undefined;
  if (!run) return unknownRunMessage(id);
  // A poll is exactly when "how is it doing?" is asked, so it is also when a
  // recovered run must be reconciled — otherwise it reports itself as running
  // forever (see `refreshReattachedRun`).
  refreshReattachedRun(run);
  const elapsed = elapsedLabel(Date.now() - run.startedAt);
  const body = runOutputText(run);
  if (run.status === 'running') {
    const quietMs = Date.now() - run.lastOutputAt;
    return (
      `${RUN_TERMINAL_INCOMPLETE_PREFIX} — run_terminal[${run.id}], ${elapsed} elapsed, ${run.bytes} bytes of output` +
      (run.reattached ? ' (recovered from a previous process)' : '') +
      (run.bytes === 0
        ? ', and NOTHING produced yet'
        : quietMs >= 60_000
          ? `, silent for the last ${elapsedLabel(quietMs)}`
          : '') +
      `.\nCommand: \`${maskSenderId(run.command)}\`` +
      // The liveness verdict, when the watchdog has one — this is the difference
      // between "it is still running" and "it is running, and here is why I
      // believe it is hung".
      (run.verdict && run.verdict !== 'starting'
        ? `\nLiveness: ${run.verdict.toUpperCase()} — ${run.verdictWhy ?? 'no evidence yet'}.`
        : '') +
      (body ? `\nOutput so far:\n${maskSenderId(body)}` : '') +
      `\nIt was NOT killed. Poll again later with run_terminal(action:'poll', process_id:'${run.id}'), or do other work first.` +
      (run.hangUnstoppable
        ? `\nIt looks HUNG, but it was recovered after a restart and its pid could not be re-verified as this ` +
          `command (${run.pidVerifiedWhy ?? 'the check could not be completed'}) — so it is deliberately NOT ` +
          `being stopped automatically. Its output is spooled here: ${spoolPath(run.id)}.`
        : run.verdict === 'hung'
          ? `\nIf you agree it is hung (it needs input it cannot get, or a lock/port it will never get), ` +
            `stop it with run_terminal(action:'stop', process_id:'${run.id}') and re-run it non-interactively — ` +
            `the watchdog stops it on its own after the grace either way.`
          : '')
    );
  }
  // A run that FAILED, or that was stopped (by the watchdog or on request), did
  // NOT verify anything — so it must carry the `Error: ` prefix the loop's honest
  // accounting reads (`ranOk` in tool-loop.ts). Without it, collecting a failing
  // suite through `poll` was recorded as a SUCCESSFUL tool call, which feeds the
  // "did you check it" gate: the turn could claim a check it never got a pass
  // from. Only a real exit-0 finish is a success here.
  const ok = run.exitCode === 0 && !run.reaped && !run.stopRequested;
  return (
    `${ok ? '✅ ' : 'Error: '}run_terminal[${run.id}] ` +
    (run.reaped || run.stopRequested
      ? `was STOPPED (${run.exitReason ?? 'stopped'})`
      : `finished${run.exitCode === 0 ? '' : ` (exit ${run.exitCode ?? '?'})`}`) +
    ` — ${elapsed} total.\n` +
    `Command: \`${maskSenderId(run.command)}\`` +
    // A run recovered as finished has a reason instead of an exit code, and it
    // must be stated: "finished" with no code is not the same fact as "exit 0".
    (run.reattached && run.exitReason ? `\n${run.exitReason}.` : '') +
    (run.reaped
      ? `\nThe work was doing nothing (no output, no CPU) and was stopped deliberately — this is NOT a test ` +
        `failure and NOT a verdict on the code. Fix what it was waiting for and re-run it.`
      : '') +
    (body ? `\nOutput:\n${maskSenderId(body)}` : '\n(no output)')
  );
}

/**
 * Why the command is taking as long as it is — the diagnosis a bare "timed out"
 * never gave. A long run is either PROGRESS (let it finish) or STUCK (a prompt,
 * a lock, a dead network call), and those need opposite responses, so the tool
 * says which one the evidence supports.
 */
function longRunDiagnosis(bytes: number, quietMs: number): string {
  if (bytes === 0) {
    return (
      'NO output at all yet. That is the signature of a command waiting on an interactive prompt ' +
      '(this tool gives it no stdin, so the prompt never gets an answer), or of a first step that is genuinely slow ' +
      '(a cold build, a large download). Make it non-interactive before re-running: `--yes`/`--no-input`/`-y`, ' +
      '`CI=1`, `--non-interactive`, or a flag that skips the prompt.'
    );
  }
  if (quietMs >= 60_000) {
    return (
      `Output STOPPED ${elapsedLabel(quietMs)} ago after ${bytes} bytes — it is stalled rather than working. ` +
      'Usual causes: waiting on a prompt, a lock held by another process, a network call with no timeout, or a test ' +
      'blocked on a server that never came up. Read the tail below for the last thing it said before going quiet.'
    );
  }
  return `It IS still producing output (${bytes} bytes, last one ${elapsedLabel(quietMs)} ago), so it is making progress — let it finish and poll rather than restarting it.`;
}

/**
 * What the model is told when a command outlives this call's wait budget.
 * Exported so the wording is testable: the two things it MUST say are that the
 * command was not killed and that re-running it is wrong.
 */
export function waitBudgetGuidance(
  command: string,
  id: string,
  waitMs: number,
  assessed: { why: string } | null,
  bytes: number,
  quietMs: number,
  reapAfterMs = 0,
): string {
  const seconds = Math.round(waitMs / 1000);
  return (
    ` — \`${maskSenderId(command)}\` has outlived this call's ${seconds}s wait budget. ` +
    `It was NOT killed and this is NOT a failure: the work is still going, and its output is accumulating.\n` +
    `${assessed ? `It was given an extended wait because it is ${assessed.why} — a class that is minutes by nature.\n` : ''}` +
    `Follow it with \`run_terminal(action:'poll', process_id:'${id}')\` — that returns its status, its liveness ` +
    `(WORKING / STALLED / HUNG, from its output and its CPU), its output tail, and its REAL exit code once it lands; ` +
    `\`run_terminal(action:'list')\` shows everything being monitored. ` +
    `Do NOT re-run the identical command: that would start a second copy of the same work. Do something useful while ` +
    `it finishes (read a file, plan the next step) and poll instead.` +
    (reapAfterMs > 0
      ? `\nA running command is WATCHED: if it stops producing output AND stops using CPU for ` +
        `${Math.round(livenessThresholds().hangQuietMs / 60_000)} minutes it is reported as HUNG, and if it stays that way for a further ` +
        `${Math.round(reapAfterMs / 60_000)} minutes it is stopped and its result reported — a real hang is not left running forever. ` +
        `Output or CPU at any point clears that, so a slow-but-working command is never touched.`
      : '')
  );
}

/** ─── Command classification (deny-first) ───────────────────────────────── */

/**
 * Absolute denials — scanned against the WHOLE command string (so `$(...)`
 * substitutions and pipes of denied commands are caught), never run even
 * with confirm:true. These are outside what the loop may do, full stop.
 */
const DENY_PATTERNS: RegExp[] = [
  // Privilege escalation.
  /\bsudo\b/,
  // Remote mutation — pushing is a human decision (deny-first, like the
  // agent's own git rules: never push from an autonomous loop).
  /\bgit\s+push\b/,
  // Irreversible working-tree destruction.
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+checkout\s+--\s*(\.|--)/,
  /\bgit\s+checkout\s+\.\s*$/,
  // System-level destruction.
  /\b(mkfs|fdisk|dd|shutdown|reboot|halt|poweroff|init|killall)\b/,
  /\bkill\s+-9\b/,
  // `rm -rf` at dangerous targets (absolute roots, home, system dirs, globs).
  // NOTE: tested against the LOWERCASED command, so targets are lowercase.
  /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-f[a-z]*r[a-z]*)\s+(\/|~|\*|\.|\.\/|\$home|\/home|\/etc|\/usr|\/var|\/bin|\/sbin|\/boot|\/opt|\/root|\/system|\/windows)/,
  // Fork bombs.
  /:\s*\(\s*\)\s*\{/,
];

/**
 * Verify-class leading-token prefixes — run WITHOUT confirmation. Positive
 * allowlist = deny-first: anything not listed here is confirm-class.
 * Each prefix is compared against the command's leading tokens, so
 * `npx vitest run tests/x.test.ts` matches "npx vitest".
 */
const VERIFY_PREFIXES: string[] = [
  // Typecheck / test / lint runners (the verify use cases) — both direct and
  // via npx (the model's default for local dev tools).
  'tsc', 'npx tsc', 'vitest', 'npx vitest', 'jest', 'npx jest', 'mocha', 'eslint', 'npx eslint',
  'npm test', 'npm run typecheck', 'npm run lint', 'npm run check', 'npm run build',
  'npm run test', 'npm run verify', 'npm run test:unit', 'npm run type-check',
  // Read-only PARSE checks. These execute nothing — they parse the file and
  // report a syntax error. They were absent from this allowlist, so the model's
  // cheapest verification (`node -c script.js`, the one a small project always
  // reaches for) classified as CONFIRM, the tool refused, and the refusal said
  // "call ask_user, then retry". A live turn produced exactly that loop: four
  // permission questions in one turn, all for a syntax check that cannot change
  // anything. A check that cannot mutate state must never generate a prompt.
  'node -c', 'node --check',
  // Git read-only.
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git rev-parse',
  // Basic read-only shell.
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'pwd', 'echo', 'wc', 'printf', 'which',
  'test', '[',
  // Read-only path helpers. Listed because a verify command routinely embeds
  // them in a substitution (`npx vitest run tests/$(basename x).test.ts`) and the
  // segment splitter cannot tell a helper from a real command.
  'basename', 'dirname', 'realpath',
  // Text processors. `awk` READS by default — inspecting a file's headers is a
  // read-only check the loop reaches for constantly. Its WRITE form is rejected
  // separately (`isTextProcessorWrite`), so `awk '{print}'` verifies while
  // `awk '{print > "f"}'` keeps the confirm gate. A command that cannot mutate
  // state must never generate a prompt (see the misfire below).
  'awk',
];

/** Text processors that READ by default but can WRITE when told to. */
const TEXT_PROCESSOR_PREFIXES = new Set(['awk']);

/**
 * Shell GRAMMAR keywords — the structure of a compound command, not a command.
 *
 * WHY THIS EXISTS (2026-10-08). A live chat turn
 * (`trace-1791390325578-4968th`) inspected its own output with a pure read-only
 * chain:
 *   grep -n '^#' NOTES.md && echo --- && wc -w NOTES.md &&
 *     for i in Introduction Design Operations; do printf "%s: " "$i"; done; echo
 * Every command in it reads a file, but the `for`/`do`/`done` segments were not
 * on the verify allowlist, so the WHOLE chain scored `confirm`, the gate refused
 * it as "state-changing", and the model burned a step declaring "the command
 * guard misfired on a read-only check" and reading the file a second way.
 *
 * A loop is judged by its BODY: the structural segments contribute nothing, and
 * a body-prefixing keyword (`do printf …`) is stripped so the real command is
 * classified. `for f in *; do rm -rf $f; done` still scores confirm (`rm`), so
 * the autonomy is bounded by what the body actually runs.
 */
const SHELL_STRUCTURAL_KEYWORDS = new Set(['for', 'done', 'fi', 'esac', 'case', '{', '}', '!', 'time', 'function']);
/** Keywords that PREFIX the real command within their own segment. */
const SHELL_BODY_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'while', 'until', 'if']);

/**
 * Does a text processor's segment WRITE? Over-rejects on purpose: a `>` in an
 * `awk` program may be a comparison inside quotes, but reading it as a write
 * only costs a confirmation, while missing a real `print > "file"` would let a
 * state change run unprompted (the safe direction is confirm).
 */
function isTextProcessorWrite(segment: string): boolean {
  return (
    /(?:^|\s)(?:-i\S*|--in-place)\b/.test(segment) ||
    />>?/.test(segment) ||
    /\b(?:system|close)\s*\(/.test(segment) ||
    /\bprintf?\s+>/.test(segment)
  );
}

/**
 * Read-only PROBES — `<cmd> --version` / `--help`, and package-metadata reads.
 *
 * WHY THIS EXISTS (2026-10-04). A version/help probe changes nothing, but it
 * was not on the verify allowlist, so the classifier scored it `confirm`, the
 * gate refused it as `external` ("has an effect outside this machine"), and a
 * live trace (`trace-1791118650644-d73hyr`) burned five steps on `cargo
 * --version` before stalling and failing over to a tiny local model. The old
 * `npm view …` refusal in `trace-1791037551766-gznlyy` is the same bug. A
 * command that cannot mutate state must never generate a prompt.
 *
 * Deliberately narrow: the LAST token must BE the probe flag (so `--version`
 * as a value, e.g. `echo --version`, still classifies by `echo`), and the
 * info commands listed all read remote metadata without writing anything.
 */
const READ_ONLY_PROBE_RE = /(?:^|\s)(?:--version|-V|--help|-h)$/;
const READ_ONLY_INFO_PREFIXES: string[] = [
  'npm view', 'npm info', 'npm ls', 'npm list', 'npm ping', 'npm outdated',
  'cargo search', 'cargo metadata', 'pip show', 'pip list', 'command -v',
  'go version', 'go env', 'java -version',
];

/**
 * Recoverable WORKSPACE commands — the state-changing operations a requested
 * build/development task legitimately needs, and that cannot strand the user
 * (a dependency uninstalls, a directory removes, a staged file unstages).
 *
 * They run without confirmation when the request authorized the work. That is
 * the case a build task hits on every single run: `npm install` was a mandatory
 * human round trip before this, which is the manual cadence in its purest form.
 *
 * Deliberately NOT here, so they keep the confirm gate:
 *   - anything global (`npm install -g`), which mutates the machine, not the repo;
 *   - anything fetched and executed (`curl … | bash`);
 *   - publishing, deploying, pushing (denied outright anyway);
 *   - arbitrary code (`node -e`, `python -c`) and unknown commands — the
 *     deny-first default is unchanged, so this list is the ONLY new autonomy;
 *   - **a command that ADDS a dependency** (`npm install bcrypt`, `yarn add x`,
 *     `cargo add y`) — see {@link addsDependency}.
 *
 * That last carve-out is the fix for a live incident: `bcrypt@^6.0.0` and
 * `express-jwt@^8.5.1` appeared in this repo's `package.json` and
 * `package-lock.json` mid-release, during a run in which the release pipeline
 * was between its commit and its publish phase — one `git add -A` from being
 * committed and published, with no code referencing either package. A
 * dependency is not a build step: "install what the manifest declares" is
 * setup (recoverable), while "declare a new dependency" is a supply-chain
 * decision, and that is a human's to make.
 */
const RECOVERABLE_PREFIXES: string[] = [
  // Dependency lifecycle — the requested build's own setup. The ADD forms are
  // filtered out by `addsDependency` (a new dependency is a decision).
  'npm install', 'npm i', 'npm ci', 'npm add', 'npm init',
  'pnpm install', 'pnpm i', 'pnpm add',
  'yarn install', 'yarn add',
  'bun install', 'bun add',
  'pip install', 'pip3 install', 'python -m pip install', 'uv pip install', 'uv add',
  'poetry add', 'poetry install',
  'cargo add', 'cargo build', 'go get', 'go mod tidy', 'composer require',
  // Workspace-local filesystem mutations.
  'mkdir', 'touch', 'cp', 'mv', 'ln -s',
  // Workspace-local git staging.
  'git add', 'git stage', 'git stash',
];

/**
 * Shell composition (`a && b`, `a | b`, `a > f`, `$(…)`) makes the effect
 * impossible to attribute to a single prefix, so a recoverable prefix never
 * gets autonomy inside a composed command: `npm install x && rm -rf src` is not
 * an install.
 */
const COMPOSED_COMMAND_RE = /[;&|<>`]|\$\(/;

/**
 * Package managers whose `<cmd> <pkg>` form WRITES a new dependency into a
 * manifest or lockfile. These always add, whatever the arguments look like.
 * (`npm ci` is absent on purpose: it installs the lockfile and accepts no
 * package arguments, so an argument passed to it is already out of contract —
 * it is handled by the generic rule below.)
 */
const ADD_COMMAND_PREFIXES: string[] = [
  // Only the forms that REQUIRE a package name. `npm i` is an alias of
  // `npm install` and is handled by the argument check below, so the bare
  // `npm i` (setup) stays recoverable while `npm i bcrypt` does not.
  'npm add', 'yarn add', 'pnpm add', 'bun add',
  'cargo add', 'go get', 'composer require', 'poetry add', 'uv add',
];

/**
 * Installers that are RECOVERABLE when they read a manifest and become an ADD
 * when they name a package (`npm install bcrypt`).
 */
const INSTALL_COMMAND_PREFIXES: string[] = [
  'npm install', 'npm i', 'npm ci', 'pnpm install', 'pnpm i',
  'yarn install', 'bun install',
  'pip install', 'pip3 install', 'python -m pip install', 'uv pip install',
  'poetry install',
];

/** Flags whose VALUE is the declared set (a requirements file, a local path). */
const DECLARED_INSTALL_FLAGS = new Set(['-r', '--requirement', '-e', '--editable']);

/** Bare arguments that mean "install what is already declared", not "install this". */
const DECLARED_INSTALL_ARGS = new Set(['.', '-d', '--dev']);

/**
 * Does this command ADD a dependency (rather than install what is declared)?
 *
 * This is the line between setup and a supply-chain decision, and it is drawn
 * from the command text alone: `npm install` reads the manifest, `npm install
 * bcrypt` writes to it. A command that cannot be read this way (composed,
 * global) is already excluded from autonomy by the callers' other gates.
 */
export function addsDependency(command: string): boolean {
  const lower = normalize(command).toLowerCase();
  if (!lower) return false;

  const hasPrefix = (prefixes: string[]): boolean => {
    const toks = leadingTokens(lower, 2);
    return prefixes.some((p) => {
      const pt = p.split(' ');
      return pt.length <= toks.length && toks.slice(0, pt.length).join(' ') === p;
    });
  };

  if (hasPrefix(ADD_COMMAND_PREFIXES)) return true;
  if (!hasPrefix(INSTALL_COMMAND_PREFIXES)) return false;
  // Reached only for an install form: decide from its arguments.

  const rest = lower.split(' ').slice(2);
  // `-r requirements.txt` / `-e .` ARE the declared set — the file/list that
  // follows the flag is not a package name, so the flag itself settles it.
  if (rest.some((a) => DECLARED_INSTALL_FLAGS.has(a))) return false;
  // Otherwise an installer WITH a package argument declares that package.
  const args = rest.filter((a) => !a.startsWith('-'));
  return args.some((arg) => !DECLARED_INSTALL_ARGS.has(arg));
}



/** A global install mutates the machine, not the repo — never recoverable. */
const GLOBAL_INSTALL_RE = /(?:^|\s)(?:-g|--global)(?:\s|$)/;

/**
 * Is this a recoverable workspace command the agent may run on its own when the
 * request authorized the work?
 */
export function isRecoverableWorkspaceCommand(command: string): boolean {
  const lower = normalize(command).toLowerCase();
  if (!lower) return false;
  if (COMPOSED_COMMAND_RE.test(lower)) return false;
  if (GLOBAL_INSTALL_RE.test(lower)) return false;
  // Declaring a NEW dependency is a human decision, not a build step (see the
  // docstring above and `addsDependency`). The bare install forms stay
  // recoverable: they introduce nothing the manifest did not already declare.
  if (addsDependency(lower)) return false;

  const toks = leadingTokens(lower, 3);
  return RECOVERABLE_PREFIXES.some((prefix) => {
    const pt = prefix.split(' ');
    return pt.length <= toks.length && toks.slice(0, pt.length).join(' ') === prefix;
  });
}

type CommandClass = 'deny' | 'verify' | 'confirm';

/** Severity order — a chain is only as safe as its WORST segment. */
const CLASS_SEVERITY: Record<CommandClass, number> = { deny: 3, confirm: 2, verify: 1 };

/** Normalize a command for classification (trim + collapse whitespace). */
function normalize(command: string): string {
  return String(command ?? '').trim().replace(/\s+/g, ' ');
}

function leadingTokens(lower: string, n: number): string[] {
  return lower.split(' ').slice(0, n);
}

/**
 * Split a command into the pieces a shell would run separately.
 *
 * AUDIT FIX (G17): the classifier used to score the WHOLE string against the
 * verify allowlist, so a verify prefix granted the entire line its safety —
 * `npm run build && rm -rf src/` was classified `verify` and ran with no
 * confirmation at all. Now each segment is classified and the chain takes the
 * WORST class. `npx tsc --noEmit && npx vitest run` (both verify) still runs
 * freely, which is the chained form the loop actually uses.
 *
 * Substitutions are split on too, so a body is classified as the command it is;
 * an unrecognised body falls through to `confirm` (the safe direction).
 */
function splitSegments(lower: string): string[] {
  return lower
    .split(/&&|\|\||;|\n|\||\$\(|`/)
    .map((s) => s.replace(/\)+/g, ' ').trim())
    .filter(Boolean);
}

/** Classify ONE segment by its leading tokens. */
function classifySegment(segment: string): CommandClass {
  // `verify` is the LOWEST severity, so returning it is how a segment stays
  // NEUTRAL: it cannot raise the chain's worst class.
  const head = leadingTokens(segment, 1)[0] ?? '';
  if (SHELL_STRUCTURAL_KEYWORDS.has(head)) return 'verify';
  let body = segment;
  if (SHELL_BODY_KEYWORDS.has(head)) {
    body = segment.slice(head.length).trim();
    if (!body) return 'verify';
  }
  const toks = leadingTokens(body, 3);
  for (const prefix of VERIFY_PREFIXES) {
    const pt = prefix.split(' ');
    if (pt.length <= toks.length && toks.slice(0, pt.length).join(' ') === prefix) {
      // A text processor may WRITE; only its read form is verify.
      if (TEXT_PROCESSOR_PREFIXES.has(prefix) && isTextProcessorWrite(body)) return 'confirm';
      return 'verify';
    }
  }
  // Read-only probes (`<cmd> --version` / `--help`) and metadata reads — they
  // cannot change state, so they never need confirmation (see the constants).
  if (READ_ONLY_PROBE_RE.test(body)) return 'verify';
  for (const prefix of READ_ONLY_INFO_PREFIXES) {
    const pt = prefix.split(' ');
    if (pt.length <= toks.length && toks.slice(0, pt.length).join(' ') === prefix) {
      return 'verify';
    }
  }
  return 'confirm';
}

/** Classify a command — deny regexes on the FULL string, worst-class on segments. */
export function classifyCommand(command: string): CommandClass {
  const c = normalize(command);
  const lower = c.toLowerCase();
  if (!lower) return 'deny';
  // Deny-first on the WHOLE string — a denied command cannot hide behind a
  // substitution or a pipe (this is what keeps `echo $(rm -rf /)` denied).
  for (const d of DENY_PATTERNS) {
    if (d.test(lower)) return 'deny';
  }
  let worst: CommandClass = 'verify';
  for (const segment of splitSegments(lower)) {
    const cls = classifySegment(segment);
    if (CLASS_SEVERITY[cls] > CLASS_SEVERITY[worst]) worst = cls;
  }
  return worst;
}

/** ─── The tool ───────────────────────────────────────────────────────────── */

export interface RunTerminalArgs {
  command: string;
  /**
   * 'run' (default) executes the command. 'poll' reports one monitored long run
   * (`process_id`), 'list' shows them all — the follow-up half of the
   * still-running hand-off, so a command that outlives its wait budget is
   * followed to its REAL exit code instead of being killed or guessed at.
   */
  action?: 'run' | 'poll' | 'list' | 'stop';
  /** The monitored run to stop or report on (from a `still running` result). */
  process_id?: string;
  confirm?: boolean;
  timeout_ms?: number;
  /**
   * What this command is FOR (e.g. "install java"). When the command SUCCEEDS,
   * it is remembered for this verb on this OS (a learned command, source
   * 'observed'), so a later `tool_search resolve` offers it. Optional: absent
   * means nothing is learned — the harness cannot name a verb the model did not.
   */
  verb?: string;
}

export async function runTerminalTool(args: RunTerminalArgs, ctx: ToolContext): Promise<string> {
  // The follow-up half of a long run: no command is needed to poll or list, and
  // these must work even when the model has nothing to spawn.
  // Recover whatever a PREVIOUS process left running, before anything is looked
  // up. Without this a restart silently orphans the record: the command keeps
  // running, `poll` reports no such id, and the turn can never collect it.
  hydrateMonitoredRuns();

  if (args.action === 'poll') return pollDetachedRun((args.process_id ?? '').trim());
  if (args.action === 'list') return listDetachedRuns();
  if (args.action === 'stop') return stopDetachedRun((args.process_id ?? '').trim());

  const command = normalize(args.command);
  // NOTE: every refusal below is prefixed `Error: ` on purpose. The tool-result
  // convention treats that prefix as "this did not run", and the loop's honest
  // accounting (successfulToolCalls → mutation/verification classification)
  // depends on it. Without the prefix, a no-op `run_terminal` (empty command,
  // denied, awaiting confirmation) counted as a SUCCESSFUL verification — a live
  // run produced exactly that: the model emitted `run_terminal` with no command
  // after the verification nudge and the turn read as verified.
  if (!command) return 'Error: run_terminal: empty command — supply the `command` to run.';

  // Route `buff`/`agent-nuvira` control to the manifest resolver — run_cli —
  // so CLI control has exactly one execution path (no double execution).
  const first = command.split(' ')[0].toLowerCase();
  if (first === 'buff' || first === 'agent-nuvira' || first === 'nuvira') {
    return (
      `Error: run_terminal: "${command}" looks like an agent-nuvira CLI command. Use the ` +
      `run_cli tool instead (it resolves the plain-English ask against the command ` +
      `manifest and applies its own confirmation rules).`
    );
  }

  const cls = classifyCommand(command);
  if (cls === 'deny') {
    return (
      `Error: run_terminal: command DENIED — "${command}" is outside what the agent may run. ` +
      `Tell the user, and suggest the safe alternative (or that they run it themselves).`
    );
  }

  // ── C3: ONE PROBE PER FACT PER RUN ────────────────────────────────────────
  // The measured defect (see src/tools/command-memo.ts): a single run asked the
  // same three facts twice — a combined probe and then the three individually —
  // and created `backend/.venv` twice. The model cannot remember what it already
  // ran; the harness can, because it ran it. So before spending a round trip,
  // ask the memo.
  //
  // The consult sits after the DENY check (a denied command never ran, so it can
  // never be in the memo) and BEFORE every other gate, and that ordering is the
  // point: the memo only holds commands that ALREADY ran successfully in THIS
  // run, under these same gates and this same context — so there is nothing left
  // for the confirm gate to decide. The one thing this must never do is let a
  // memo hit stand in for a command that would have been refused: it cannot, for
  // the reason just given. Failures are never stored (a non-zero exit is
  // retryable by definition), so a repaired project is never told "already done".
  // Scoped to the directory the run is in: `clone_repo` changes `ctx.cwd`
  // mid-run, and a fact learned in one tree is not a fact about another.
  const memoWhere = ctx.cwd || process.cwd();
  const memoHit = lookupMemo(ctx.commandMemo, command, memoWhere);
  if (memoHit) {
    ctx.emit?.('terminal:memoized', {
      command,
      answeredBy: memoHit.entry.command,
      parts: memoHit.parts,
    }, 'tool-loop');
    return memoNotice(command, memoHit);
  }

  // ── Project interpreter canonicalization + pre-run environment guard ──────
  // The live Aukat_check failure: a build ran against an interpreter that did
  // NOT have the project's own dependencies (PyQt6), produced a broken bundle,
  // and still reported success. Before running, pin this project's virtualenv
  // and refuse the two mistakes that caused it — installing Python packages
  // outside the project env, and building/running against an interpreter that
  // is missing the declared dependencies. See src/utils/project-env.ts.
  let runEnv: Record<string, string | undefined> | undefined;
  let envNote = '';
  const envVerdict = guardCommandEnvironment(command, ctx.cwd || process.cwd());
  if (envVerdict.action === 'refuse') {
    return (
      `Error: run_terminal: ${envVerdict.reason}. ${envVerdict.hint} ` +
      `(Guard: NUVIRA_ENV_GUARD=off bypasses this if the project genuinely uses a system interpreter.)`
    );
  }
  if (envVerdict.action === 'proceed' && envVerdict.venv) {
    runEnv = applyProjectEnvironment({ ...process.env }, envVerdict.venv);
    if (envVerdict.note) envNote = `\n🔒 ${envVerdict.note}`;
  }

  // ── G16: the gate consults the request before it consults the model ───────
  // A recoverable workspace command (dependency install, mkdir/cp/mv, git add)
  // on a run that authorized the work is the build's own setup, not a surprise
  // — `npm install` used to be a mandatory human round trip on every build
  // task. Everything else stays exactly where it was: classified `external`, so
  // it asks no matter what the request said.
  let decidedAutonomously = false;
  let autonomyReason = '';
  if (cls === 'confirm' && !args.confirm) {
    const recoverable = isRecoverableWorkspaceCommand(command);
    // The durable grant is consulted first. It can only cover `local-state` —
    // `external` is refused by the envelope itself, so this cannot widen what
    // may run: it only makes an already-authorized class stay authorized across
    // turns instead of being forgotten at the turn boundary.
    const envVerdict = envelopeCoversAction(ctx.envelope, {
      tool: 'run_terminal',
      changeClass: recoverable ? 'local-state' : 'external',
    });
    // The SESSION grant is consulted next, and WHICH category it is depends on
    // the command: a recoverable workspace command needs `terminal`, while an
    // off-machine one (network fetch, global/system install like winget) needs
    // the user to have explicitly granted `external`. The absolute DENY patterns
    // ran ABOVE, so nothing here can unlock sudo / rm -rf / / git push.
    const grantCategory = grantCategoryForEffect(recoverable ? 'local-state' : 'external');
    const grantCovers = grantCategory !== null && sessionGrantCovers(ctx.planStore, grantCategory);
    const verdict = envVerdict.covered || grantCovers
      ? {
          action: 'proceed' as const,
          reason: envVerdict.covered
            ? envVerdict.reason
            : 'allowed for this session by the user',
        }
      : decideStateChange({
          tool: 'run_terminal',
          action: `running "${command}"`,
          changeClass: recoverable ? 'local-state' : 'external',
          recoverable,
          authorizedByRequest: ctx.writesAuthorized?.authorized === true,
        });
    if (verdict.action !== 'proceed') {
      // Mark the pending confirmation so ask_user does NOT suppress the very
      // question this refusal asks for (see ToolContext.pendingConfirmation),
      // and so the ask can offer the matching session grant.
      ctx.pendingConfirmation = {
        tool: 'run_terminal',
        command,
        ...(grantCategory ? { category: grantCategory } : {}),
      };
      return (
        `Error: run_terminal: "${command}" changes state and needs explicit confirmation ` +
        `(${verdict.reason}). Call ask_user (yes/no, one-line reason), then re-call run_terminal ` +
        `with the SAME command plus confirm:true only if the user agreed.`
      );
    }
    decidedAutonomously = true;
    autonomyReason = verdict.reason;
    ctx.emit?.('autonomy:write-applied', {
      tool: 'run_terminal',
      command,
      reason: verdict.reason,
      authorization: ctx.writesAuthorized?.reason,
    }, 'tool-loop');
  }

  // ── Don't start the same work twice ─────────────────────────────────────────
  // A long command handed off to monitoring is STILL RUNNING. Re-issuing it
  // would spawn a second copy (two test suites competing for the same ports and
  // CPU, two installs over each other). The old code had no such case because
  // the first copy was already dead; now the honest answer is to follow it.
  const runningSame = [...detachedRuns.values()].find(
    (r) => r.status === 'running' && r.command === command && r.cwd === (ctx.cwd ?? process.cwd()),
  );
  if (runningSame) {
    return (
      `Error: run_terminal: \`${maskSenderId(command)}\` is ALREADY RUNNING (monitored as ` +
      `run_terminal[${runningSame.id}], ${elapsedLabel(Date.now() - runningSame.startedAt)} elapsed). ` +
      `Starting it again would do the same work twice. Follow it instead: ` +
      `run_terminal(action:'poll', process_id:'${runningSame.id}').`
    );
  }

  // P7 — the wait budget: an explicit `timeout_ms` wins; otherwise the command is
  // ASSESSED, so a test suite or a build gets the minutes it actually needs
  // instead of the short default meant for a quick read; otherwise the room
  // decides (a person watching waits less — see INTERACTIVE_DEFAULT_TIMEOUT_MS).
  // Reaching the budget now hands the command to monitoring rather than killing
  // it, so an under-estimate costs a poll, not the work.
  const assessed = assessCommandTime(command);
  const waitMs = resolveWaitMs(command, args.timeout_ms, ctx.interactive);
  // Reported so the model knows the hand-off is WATCHED: a run that goes silent
  // and idle will be identified as hung and stopped, not left forever.
  const reapAfterMs = hangReapMs();
  // P7 — the IDENTICAL-COMMAND guard. A command that has already failed twice at
  // this timeout in this directory will fail a third time the same way; the live
  // run spent two 120-second timeouts proving that. Refusing costs milliseconds
  // and says what to change instead of quietly spending another two minutes of
  // the user's time. Bounded, self-expiring, and reset by a success.
  //
  // The effective timeout is part of the key on purpose: the guidance a timeout
  // carries tells the model to re-call with a longer `timeout_ms` when the work
  // is genuinely long, and that advice must not be refused by this guard.
  const streakKey = `${ctx.cwd ?? process.cwd()}|${command}|${waitMs}`;
  const priorStreak = commandFailureStreaks.get(streakKey);
  if (
    priorStreak &&
    Date.now() - priorStreak.lastAt <= FAILURE_STREAK_WINDOW_MS &&
    priorStreak.count >= IDENTICAL_FAILURE_CAP
  ) {
    return (
      `Error: run_terminal: \`${maskSenderId(command)}\` has already failed ${priorStreak.count} times at this timeout ` +
      `and would fail the same way again — refusing to spend another run on it. Change the command before calling ` +
      `run_terminal again: fix the underlying cause, narrow the scope, raise \`timeout_ms\` if the work is simply long, ` +
      `or run a different check entirely.`
    );
  }
  const startedAt = Date.now();
  const outcome = await execCommand(command, ctx.cwd, waitMs, runEnv);

  // ── A command that outlived the wait budget is NOT a failure ────────────────
  // It is still running, its output is still accumulating, and the turn can
  // carry on: the guidance says how to follow it, what the evidence says about
  // why it is slow, and that re-running it would duplicate the work. Crucially
  // it does NOT record a failure streak — counting a live run as a failure is
  // what made the old behaviour report unfinished work as broken.
  if (outcome.kind === 'still-running') {
    ctx.emit?.('run_terminal:monitoring', {
      tool: 'run_terminal',
      command,
      processId: outcome.id,
      waitMs,
      bytes: outcome.bytes,
    }, 'tool-loop');
    return (
      `${RUN_TERMINAL_INCOMPLETE_PREFIX}` +
      waitBudgetGuidance(command, outcome.id, waitMs, assessed, outcome.bytes, outcome.quietMs, reapAfterMs) +
      `\nMonitored as run_terminal[${outcome.id}].\n` +
      longRunDiagnosis(outcome.bytes, outcome.quietMs)
    );
  }

  const output = outcome.output;
  // A real non-zero exit is the only thing that counts as a failure now.
  const failureStreak = output.startsWith('Error:') ? recordCommandFailure(streakKey, Date.now()) : 0;
  if (!output.startsWith('Error:')) clearCommandFailure(streakKey);
  const outputWithNotes = output;

  // A4 — a KNOWN toolchain failure gets its known fix appended, so the model
  // repairs instead of re-trying the identical command. Advisory only: the note
  // names the bounded, project-local step; it never mutates the workspace.
  const remediation = output.startsWith('Error:')
    ? diagnoseFailure(command, output, ctx.cwd)
    : null;
  const remediationNote = remediation ? `\n\n${formatRemediation(remediation)}` : '';
  // Auto-apply (opt-in, NUVIRA_REMEDIATE=auto): take the safe, idempotent
  // project-local step now instead of asking the model to transcribe it, and
  // report exactly what changed. Off by default — advisory stays the norm.
  const autoApplyNote =
    remediation?.autoFix?.length && remediationAutoApplyEnabled()
      ? (() => {
          const result = applyRemediationAutoFixes(remediation);
          ctx.emit?.('remediation:auto-applied', {
            id: remediation.id,
            applied: result.applied,
            skipped: result.skipped,
          }, 'tool-loop');
          return `\n\n${formatAutoApply(result)}`;
        })()
      : '';

  // ── A1: effect verification — a BUILD is not done until its artifact is
  // OBSERVED to launch. The live Aukat_check run reported "successfully built
  // and functional" for a bundle that crashed on import; exit code 0 is not
  // proof. Only a build whose artifact crashes turns the whole command into a
  // failure (with the launch stderr), so the model cannot keep narrating success.
  let effectNote = '';
  if (!output.startsWith('Error:') && isBuildCommand(command)) {
    const verdict = await verifyBuildEffect(command, ctx.cwd || process.cwd(), {
      sinceMs: startedAt,
      ...(runEnv ? { env: runEnv } : {}),
    });
    if (verdict.status === 'failed') {
      return (
        `Error: run_terminal: \`${maskSenderId(command)}\` exited 0, but ` +
        `${formatEffectVerdict(verdict)} Fix the artifact and re-run the build — do NOT ` +
        `report this as working. (NUVIRA_EFFECT_VERIFY=off disables this launch check.)`
      );
    }
    if (verdict.status === 'verified') effectNote = `\n${formatEffectVerdict(verdict)}`;
  }

  // Long-tail OS adaptation: a command that failed because an executable is not
  // on THIS machine is not a dead end — the model should choose a command for the
  // machine it is on. Keyed on the shell's OWN signal (exit 127 / 9009), so this
  // is a fact the shell reports, not a phrase match. Advisory only.
  let missingNote = '';
  if (output.startsWith('Error:')) {
    const { isMissingBinaryFailure, buildMissingBinaryNote } = await import('../learning/command-adaptation.js');
    if (isMissingBinaryFailure(output)) missingNote = buildMissingBinaryNote(command);
  }

  // The grown table: a SUCCESSFUL command the model LABELLED with a verb is
  // remembered for this machine (observed), so the same OS-specific command is
  // not re-derived. Only with a verb and only on success — a failure is not a
  // fact worth remembering, and a verbless command cannot be keyed. Best-effort.
  if (args.verb && !output.startsWith('Error:')) {
    try {
      const { recordLearnedCommand } = await import('../learning/learned-commands.js');
      const { leadingBinary } = await import('../learning/command-adaptation.js');
      const bin = leadingBinary(command);
      recordLearnedCommand({
        verb: args.verb,
        command,
        ...(bin ? { binary: bin } : {}),
        source: 'observed',
      });
    } catch {
      // Best-effort — learning must never break the run it learned from.
    }
  }

  // C3 — remember what a SUCCESSFUL run answered (whole command + every fact it
  // established), so the same question in the same run is answered from the
  // output above instead of a second spawn. `Error:`-prefixed output is a
  // refusal, a crash, or a real non-zero exit — not a fact worth remembering.
  // (A command that is merely still running never reaches here: it is followed
  // with `poll`, and its output is stored when it lands.)
  if (!output.startsWith('Error:')) storeMemo(ctx.commandMemo, command, output, memoWhere);

  if (!decidedAutonomously) return outputWithNotes + effectNote + envNote + remediationNote + autoApplyNote + missingNote;
  // Reported, never silent — a judgment call the user cannot see is
  // indistinguishable from a bug.
  return (
    `${outputWithNotes}${effectNote}\n💡 Ran without asking: ${autonomyReason}. State what you ran in your answer — ` +
    'do not ask for permission to do work the user already asked for.' +
    envNote +
    remediationNote +
    autoApplyNote +
    missingNote
  );
}

/**
 * The result of one call: either the command FINISHED inside its wait budget, or
 * it is still going and has been handed to the monitored registry.
 */
type ExecOutcome =
  | { kind: 'finished'; output: string }
  | { kind: 'still-running'; id: string; bytes: number; quietMs: number };

/**
 * Spawn the command (shell-interpreted — pipes, &&, substitutions work).
 *
 * `waitMs` is a WAIT budget, not a kill switch. When it runs out the child keeps
 * running, its output keeps accumulating in the registry, and the caller is told
 * how to follow it (`pollDetachedRun`). The only thing that changes at the budget
 * is that THIS CALL stops blocking.
 */
function execCommand(
  command: string,
  cwd: string | undefined,
  waitMs: number,
  envOverride?: Record<string, string | undefined>,
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    // On Windows, use Git Bash for cross-platform shell commands (pwd, touch, etc.)
    const shellOptions: Record<string, unknown> = {
      cwd: cwd || process.cwd(),
      shell: true,
      // A pinned project venv (`envOverride`) wins for PATH/VIRTUAL_ENV; the
      // color/CI flags are always enforced on top so output stays parseable.
      env: { ...(envOverride ?? process.env), FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    };
    if (process.platform === 'win32') {
      const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
      if (existsSync(gitBash)) {
        shellOptions.shell = gitBash;
      }
    }
    const id = randomUUID();
    // Spooling starts at SPAWN, not at hand-off: the beginning of the output is
    // exactly what an overflowing buffer loses while the wait budget is still
    // running, and that is the part a diagnosis needs. A run that finishes inside
    // its budget discards the spool (see `settleRun`).
    const spool = new SpoolWriter(id);
    const child = spawn(command, shellOptions as any);
    const startedAt = Date.now();
    const run: DetachedRun = {
      id,
      command,
      cwd: cwd || process.cwd(),
      child,
      pid: child.pid ?? null,
      spool,
      startedAt,
      lastOutputAt: startedAt,
      bytes: 0,
      out: '',
      err: '',
      status: 'running',
      exitCode: null,
    };
    // Whether this call has already answered (so a later exit does not resolve
    // twice — the registry owns the result from that point on).
    let answered = false;
    const timer = setTimeout(() => {
      if (answered) return;
      answered = true;
      // HAND OFF, do not kill. See the registry above.
      detachedRuns.set(run.id, run);
      pruneDetachedRuns();
      // Start watching it, so a run that stops making progress is IDENTIFIED
      // (and, on evidence, stopped) instead of running forever.
      ensureWatchdog();
      // …and make it DURABLE, so a restart can still follow and collect it. This
      // is also what puts the spool on disk: until a run is durable nobody could
      // read its output back, so writing it earlier only littered the config dir
      // with a file that a run finishing inside its budget then deleted.
      run.osStartedAt = readOsStartToken(run.pid);
      run.spool?.startPersisting();
      run.spool?.flush();
      persistRun(run);
      resolve({
        kind: 'still-running',
        id: run.id,
        bytes: run.bytes,
        quietMs: Date.now() - run.lastOutputAt,
      });
    }, waitMs);
    const note = (chunk: Buffer, stream: 'out' | 'err'): void => {
      const text = chunk.toString('utf-8');
      run[stream] += text;
      run.bytes += chunk.length;
      run.lastOutputAt = Date.now();
      // The spool keeps a bounded head AND tail, so what the buffer drops is still
      // readable later (and after a restart).
      run.spool?.write(text);
      // Bounded buffering: a 40MB log must not be held in memory, and the tool
      // only ever reports the tail.
      const cap = MAX_OUTPUT_CHARS * 2;
      if (run[stream].length > cap) {
        run[stream] = run[stream].slice(-cap);
        // Once anything is dropped the buffer is missing its BEGINNING, and the
        // poll must read the spool instead of presenting a tail as the whole story.
        run.truncatedOutput = true;
      }
    };

    /**
     * The run is over. Stop spooling, and keep the durable record only when it can
     * ever be read: a run handed to monitoring is collected by `poll` (possibly in
     * another process), while one that finished inside its wait budget already
     * delivered its result — its record and spool would be litter.
     */
    const settleRun = (): void => {
      run.endedAt = Date.now();
      if (detachedRuns.has(run.id)) {
        run.spool?.close();
        persistRun(run);
      } else {
        run.spool?.discard();
      }
    };
    child.stdout?.on('data', (b: Buffer) => note(b, 'out'));
    child.stderr?.on('data', (b: Buffer) => note(b, 'err'));
    child.on('error', (e) => {
      clearTimeout(timer);
      run.status = 'done';
      run.err += `\n${e.message}`;
      settleRun();
      if (answered) return;
      answered = true;
      resolve({ kind: 'finished', output: `Error: run_terminal: failed to spawn — ${e.message}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      run.status = 'done';
      run.exitCode = code;
      settleRun();
      if (answered) return; // already handed off — the poll reports the result
      answered = true;
      const body = (run.out || run.err).trim().slice(0, MAX_OUTPUT_CHARS);
      const masked = maskSenderId(body);
      // `code === null` now means the process was terminated by something ELSE
      // (a signal, the OOM killer, the user) — the tool no longer kills it, so
      // this is a real, reportable condition rather than its own timeout.
      const terminated = code === null;
      const ok = !terminated && code === 0;
      const status = terminated
        ? 'was terminated before it finished (a signal, not this tool)'
        : ok
          ? '✅ succeeded'
          : `❌ failed (exit ${code ?? '?'})`;
      // Enterprise G1: a command that FAILED is not a verification. The loop's
      // honest accounting reads the `Error:` prefix, and the verification gate
      // counts a successful run_terminal as proof — so a non-zero exit (or a
      // termination) MUST carry the prefix, or a failing test/build would mark
      // the turn "verified". The real output is preserved for diagnosis.
      resolve({
        kind: 'finished',
        output:
          `${ok ? '' : 'Error: '}run_terminal: \`${maskSenderId(command)}\` ${status}.\n` +
          (masked ? `Output:\n${masked}` : '(no output)'),
      });
    });
  });
}
