/**
 * The durable half of the monitored-run registry.
 *
 * WHY THIS EXISTS. Monitoring a long command in memory (see `run-terminal.ts`)
 * fixed the killing, but it made the record as fragile as the process holding it:
 * a CLI exit, a dashboard restart, a crash — all normal — and a command that is
 * still running becomes unpollable. Nothing is left to follow it with, its real
 * exit code is never collected, and the turn that started it can only re-run the
 * work (wrong) or guess at the outcome. Two facts have to outlive the process:
 *
 *   what is running  — id, command, cwd, pid, start time, and how it ended;
 *   what it said     — its output, from the FIRST byte as well as the last.
 *
 * The second one is why there is a spool file and not just a record. The
 * in-memory buffer is a bounded TAIL (a 40MB build log must not be held), so the
 * beginning of a long run was simply gone — the model could read the end of a
 * failure and not the line that explained it. The spool keeps a bounded HEAD and
 * a bounded TAIL (rewritten whole, so the file never grows past the cap), which
 * is the part a diagnosis actually uses.
 *
 * Everything here is best-effort and must never break a turn: a missing, unreadable
 * or corrupt registry is an empty registry, never a throw.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveNuviraDataPath } from '../config/paths.js';
import { lookupProcess } from './process-liveness.js';

/** The full-log cap, with an env override read at construction (test-friendly). */
function envFullBytes(): number {
  const raw = Number.parseInt(String(process.env.NUVIRA_RUN_LOG_FULL_BYTES ?? '').trim(), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : SPOOL_FULL_BYTES;
}

/** How much of the BEGINNING of a run's output is kept. */
export const SPOOL_HEAD_BYTES = 32_768;
/** How much of the END of a run's output is kept. */
export const SPOOL_TAIL_BYTES = 32_768;
/**
 * How much of a run's output is kept IN FULL before the window collapses to
 * head+tail.
 *
 * WHY THIS EXISTS. A bounded window throws away the MIDDLE of a long run, and
 * that is exactly where a failure explains itself — so the honest trade is to
 * keep everything while everything is small. Most runs never reach this cap, so
 * the common case stops losing anything at all; past it the file collapses to
 * head+tail (with the dropped count stated), which keeps the guarantee that a
 * chatty command cannot fill the disk. `NUVIRA_RUN_LOG_FULL_BYTES=0` restores
 * "always a bounded window".
 */
export const SPOOL_FULL_BYTES = 2_000_000;
/** Pending appends are flushed once they reach this, so memory stays bounded. */
const SPOOL_PENDING_BYTES = 262_144;
/** Bounded history: the registry cannot grow with the session. */
const MAX_PERSISTED_RUNS = 30;
/** How often an in-flight spool is written out (a crash loses at most this much). */
export const SPOOL_FLUSH_MS = 2_000;

export interface PersistedRun {
  id: string;
  command: string;
  cwd: string;
  /** The process-tree root: the shell we spawned, or the command it exec'd. */
  pid: number;
  startedAt: number;
  status: 'running' | 'done';
  exitCode: number | null;
  endedAt?: number;
  /** Why it stopped, when it was stopped rather than finishing on its own. */
  exitReason?: string;
  reaped?: boolean;
  stopRequested?: boolean;
  /**
   * The OS's own start token for the process this run was started as — the
   * second identity witness (see `processIdentityVerdict`). Recorded once, while
   * the process is certainly still ours; a run recovered without it can be
   * followed but not stopped, which is the old, safe behaviour.
   */
  osStartedAt?: string;
}

interface RunsFile {
  version: 1;
  runs: PersistedRun[];
}

/** `<config dir>/run-terminal` — isolated by `$NUVIRA_CONFIG_DIR`, like the rest. */
export function runsDir(): string {
  return resolveNuviraDataPath('run-terminal');
}

export function spoolPath(id: string): string {
  return join(runsDir(), 'out', `${id}.log`);
}

function registryPath(): string {
  return join(runsDir(), 'runs.json');
}

/** Read the registry. A missing/corrupt file is an empty registry. */
export function loadRuns(): PersistedRun[] {
  try {
    const path = registryPath();
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RunsFile>;
    if (!parsed || !Array.isArray(parsed.runs)) return [];
    return parsed.runs.filter(
      (r): r is PersistedRun =>
        !!r &&
        typeof r.id === 'string' &&
        typeof r.command === 'string' &&
        typeof r.pid === 'number' &&
        typeof r.startedAt === 'number' &&
        (r.status === 'running' || r.status === 'done'),
    );
  } catch {
    return [];
  }
}

function writeRuns(runs: PersistedRun[]): boolean {
  try {
    mkdirSync(runsDir(), { recursive: true });
    const path = registryPath();
    // Atomic-ish: a crash mid-write must not leave a half file that reads as an
    // empty registry (which would silently lose every live run).
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, runs } satisfies RunsFile, null, 2), 'utf-8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Add or update one run. Finished entries are kept (so a restart can still report
 * the real exit code) and the oldest are dropped past the cap.
 */
export function saveRun(entry: PersistedRun): void {
  const runs = loadRuns().filter((r) => r.id !== entry.id);
  runs.push(entry);
  const finished = runs.filter((r) => r.status === 'done');
  while (runs.length > MAX_PERSISTED_RUNS && finished.length > 0) {
    const oldest = finished.shift()!;
    const at = runs.findIndex((r) => r.id === oldest.id);
    if (at >= 0) runs.splice(at, 1);
  }
  // Never drop a LIVE run to satisfy the cap — the record of running work is the
  // whole point of the file.
  while (runs.length > MAX_PERSISTED_RUNS) {
    const oldest = runs.find((r) => r.status === 'done');
    if (!oldest) break;
    runs.splice(runs.indexOf(oldest), 1);
  }
  writeRuns(runs);
}

/** The spooled output of one run, or null when there is none. */
export function readSpool(id: string): string | null {
  try {
    const path = spoolPath(id);
    if (!existsSync(path)) return null;
    const text = readFileSync(path, 'utf-8');
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export function spoolBytes(id: string): number {
  try {
    const path = spoolPath(id);
    if (!existsSync(path)) return 0;
    return readFileSync(path).length;
  } catch {
    return 0;
  }
}

export function discardSpool(id: string): void {
  try {
    rmSync(spoolPath(id), { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Delete spool files no record refers to.
 *
 * The registry is capped, but a file is not a record: without this, every run
 * that was ever monitored would leave its log behind forever, and "bounded state"
 * would be true of the JSON and false of the disk. Run on hydrate, when the live
 * set is exactly known.
 */
export function sweepSpools(liveIds: readonly string[]): void {
  try {
    const keep = new Set(liveIds);
    const dir = join(runsDir(), 'out');
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.log')) continue;
      const id = name.slice(0, -4);
      if (keep.has(id)) continue;
      rmSync(join(dir, name), { force: true });
    }
  } catch {
    /* best-effort: a sweep that fails must not stop a turn */
  }
}

/**
 * A bounded head+tail window over some text.
 *
 * The head is kept because a run's first lines name what it is doing and how it
 * was invoked; the tail is kept because that is where the failure is. The middle
 * is what gets dropped — bounded, explicit, and never silently a lie about size.
 */
export function outputWindow(
  text: string,
  maxChars: number,
  headChars: number = SPOOL_HEAD_BYTES,
  tailChars: number = SPOOL_TAIL_BYTES,
): { text: string; omittedChars: number } {
  const clean = text.replace(/\r\n/g, '\n');
  if (clean.length <= maxChars) return { text: clean, omittedChars: 0 };
  const head = clean.slice(0, Math.min(headChars, Math.floor(maxChars / 2)));
  const tail = clean.slice(-Math.min(tailChars, Math.floor(maxChars / 2)));
  const omittedChars = Math.max(0, clean.length - head.length - tail.length);
  return {
    text: `${head}\n\n… [${omittedChars} characters omitted — the middle of a long run, kept at the ends] …\n\n${tail}`,
    omittedChars,
  };
}

/**
 * Write the spool for one run: HEAD (until it is full) + a rolling TAIL.
 *
 * The file is REWRITTEN whole rather than appended to, which is what keeps it
 * bounded: a chatty command can write gigabytes in an hour and the spool still
 * stays at ~64KB. Flushing is throttled (`SPOOL_FLUSH_MS`) so the write cost is
 * independent of the output rate; `close()` does the final write.
 *
 * NOTHING IS WRITTEN UNTIL {@link startPersisting}. Until a run is handed to
 * monitoring it is not durable (there is no registry entry to read it back), so a
 * file on disk would be litter the user never asked for — and litter they do get:
 * MEASURED, the first output chunk of an ordinary `npm test` created
 * `<config>/run-terminal/out/<id>.log` in the developer's REAL profile on every
 * test that spawned a command and finished inside its budget, for a spool that
 * was then discarded. Buffering in memory until hand-off loses nothing (the head
 * is bounded, and the window written at hand-off is the same one) and keeps the
 * suite out of the profile it runs in.
 */
export class SpoolWriter {
  private head = '';
  private tail = '';
  /** Everything ever written, so the window can say how much it dropped. */
  private total = 0;
  private dirty = false;
  private lastFlush = 0;
  private closed = false;
  private discarded = false;
  /** False until the run is durable — see {@link startPersisting}. */
  private persisting = false;
  /**
   * `append` — the file is growing with the run, byte for byte, because it is
   * still under the full-log cap. `window` — the cap was passed, so the file is
   * the bounded head+tail window from here on.
   */
  private mode: 'append' | 'window' = 'append';
  /** Text written since the last flush, in append mode. */
  private pending = '';
  private readonly fullBytes: number;

  constructor(
    private readonly id: string,
    private readonly headBytes: number = SPOOL_HEAD_BYTES,
    private readonly tailBytes: number = SPOOL_TAIL_BYTES,
    /**
     * Where the window is written. Defaults to the monitored-run spool dir; the
     * dashboard's tasks keep theirs beside their own records. Parameterised
     * rather than duplicated because the discipline — bounded, rewritten whole,
     * throttled, discarded when nobody will read it — is the part worth sharing.
     */
    private readonly dir: string = join(runsDir(), 'out'),
    fullBytes: number = envFullBytes(),
  ) {
    this.fullBytes = fullBytes;
  }

  /** The file this window lives in. */
  path(): string {
    return join(this.dir, `${this.id}.log`);
  }

  /**
   * Begin writing to disk: the run has outlived its wait budget and is now
   * durable (`persistRun`), so its output has to be readable by another process.
   */
  startPersisting(): void {
    this.persisting = true;
  }

  write(text: string): void {
    if (this.closed || this.discarded || !text) return;
    this.total += text.length;
    if (this.head.length < this.headBytes) {
      this.head += text.slice(0, this.headBytes - this.head.length);
    }
    // The tail only needs to remember the last `tailBytes`; a 2x window lets the
    // slice below stay cheap without re-slicing on every chunk.
    this.tail += text;
    if (this.tail.length > this.tailBytes * 2) this.tail = this.tail.slice(-this.tailBytes);
    this.dirty = true;

    if (this.persisting && this.mode === 'append') {
      if (this.total > this.fullBytes) {
        // The run outgrew the cap: drop what the window cannot hold, once.
        this.collapse();
        return;
      }
      this.pending += text;
      // A chatty command must not be able to buffer megabytes between flushes.
      if (this.pending.length >= SPOOL_PENDING_BYTES) this.flush();
    }
    this.flushIfDue();
  }

  private flushIfDue(): void {
    if (!this.persisting) return;
    const now = Date.now();
    if (now - this.lastFlush < SPOOL_FLUSH_MS) return;
    this.flush();
  }

  /**
   * Cross the cap: write the bounded window ONCE, and stop growing the file.
   *
   * The bytes already appended are what a run's middle looked like while it still
   * fit; rewriting the file is what keeps a gigabyte of output from becoming a
   * gigabyte of disk.
   */
  private collapse(): void {
    this.mode = 'window';
    this.pending = '';
    this.flush();
  }

  /**
   * Write what has accumulated. Safe to call at any time.
   *
   * The file is the HEAD plus the LAST `tailBytes` of the tail — taken from the
   * END, because the tail is where a failure explains itself. When everything
   * fits in the head, only the head is written: otherwise a short run's output
   * would be stored twice and read back doubled.
   */
  flush(): void {
    if (!this.persisting || !this.dirty || this.discarded || this.closed) return;
    this.dirty = false;
    this.lastFlush = Date.now();
    const tail = this.tail.slice(-this.tailBytes);
    const omitted = Math.max(0, this.total - this.head.length - tail.length);
    const body =
      omitted > 0
        ? `${this.head}\n… [${omitted} characters omitted — kept at the ends] …\n${tail}`
        : this.head || tail;
    try {
      mkdirSync(this.dir, { recursive: true });
      if (this.mode === 'append' && this.pending) {
        // UNDER THE CAP: append what the run actually printed, so the middle of a
        // long-but-not-huge run is still readable afterwards.
        appendFileSync(this.path(), this.pending, 'utf-8');
        this.pending = '';
        return;
      }
      writeFileSync(this.path(), body, 'utf-8');
    } catch {
      /* the spool is a convenience — never break the run for it */
    }
  }

  /**
   * Make sure the bytes still held in memory reach the file.
   *
   * `close()` cannot use `flush()` for this: in append mode a pause in output
   * older than the throttle leaves `pending` unwritten, and those are exactly the
   * last lines of a run — the ones that explain why it failed.
   */
  private drainPending(): void {
    if (!this.persisting || this.discarded || !this.pending) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.path(), this.pending, 'utf-8');
      this.pending = '';
    } catch {
      /* best-effort */
    }
  }

  /** Final write. The file stays (a finished run's output is still worth reading). */
  close(): void {
    if (this.closed) return;
    if (this.mode === 'append') this.drainPending();
    else this.flush();
    this.closed = true;
  }

  /** Drop the spool: the run finished inside its wait budget, so nobody will poll it. */
  discard(): void {
    this.discarded = true;
    this.closed = true;
    try {
      rmSync(this.path(), { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Is `pid` still the process we started, or has the pid been recycled?
 *
 * A run recovered from the registry is identified by a NUMBER that outlived the
 * process table it came from. Between the crash and the re-attach, that pid can
 * belong to something else entirely — and this tool's whole safety story is that
 * it only ever signals commands IT started. So before any recovered run is
 * signalled, it is identified all over again.
 *
 * The process line — `ps` on POSIX, the same `Get-CimInstance Win32_Process`
 * query the liveness sampler already runs on Windows — shows the shell we spawned
 * (`/bin/sh -c <command>`) or, when the shell exec'd a simple command, that
 * command's own line; both contain the command text, which is why the check is a
 * containment test rather than equality.
 */
export function commandMatchesProcess(pid: number, command: string): boolean | null {
  const row = lookupProcess(pid);
  if (row === null) return null; // this platform cannot read the process table
  if (!row.found) return false; // the pid is gone — definitely not ours
  return commandVerdict(command, row.command);
}

/**
 * The command-line witness alone, as a verdict: `true` ours, `false` not ours,
 * `null` no reading (which is NOT a match, and must never be treated as one).
 */
function commandVerdict(command: string, liveLine: string | null): boolean | null {
  const wanted = command.trim();
  if (!wanted) return null;
  if (!liveLine) return null; // a row whose command line could not be read
  try {
    // Quotes and runs of whitespace are NOT differences of identity: the shell
    // strips the quotes from `node -e "…"` before the process exists, so a naive
    // containment test would refuse to stop a run we really do own.
    const normalize = (s: string): string => s.replace(/["']/g, '').replace(/\s+/g, ' ').trim();
    const actual = normalize(liveLine);
    const wantedNorm = normalize(wanted);
    // The process line CONTAINS what we recorded — the shell carries it
    // (`sh -c npm test`), or the command is what the shell exec'd into.
    if (actual.includes(wantedNorm)) return true;
    // A process listing can TRUNCATE a very long command line, so a substantial
    // PREFIX of what we recorded is accepted — but only with the same binary,
    // and never a short bare name: a recycled pid showing just `node` must NOT
    // satisfy a recorded `node -e …`, which is how a stranger would be adopted.
    const first = wantedNorm.split(' ')[0];
    if (actual.length >= 16 && wantedNorm.startsWith(actual) && actual.split(' ')[0] === first) return true;
    return false;
  } catch {
    return null; // unknown — the caller must not treat this as a match
  }
}

/** What was recorded about the process a run was started as. */
export interface RecordedProcess {
  command: string;
  /**
   * The OS's own start token for that process (`lookupProcess().startedAtText`).
   * Absent for a record written before this existed, or when the read failed —
   * in which case the command line is the only witness, exactly as before.
   */
  osStartedAt?: string | null;
}

/** What the live process table says about a pid right now. */
export interface LiveProcess {
  found: boolean;
  command: string | null;
  startedAtText: string | null;
}

/**
 * WHICH KIND of answer an identity check gave — the distinction a caller needs to
 * avoid reading a statement about identity as a statement about liveness.
 *
 *  `verified`        ours, with evidence
 *  `gone`            the pid is not in the table: a fact, so a task may be
 *                    settled from it
 *  `not-ours`        the pid exists but is a DIFFERENT process. The task is not
 *                    ours any more either — but see the callers: this is a claim
 *                    about identity, and it must not be turned into "it finished"
 *                    without care, because a command line can change over a
 *                    process's life (a shell that `exec`s keeps its pid).
 *  `unknown`         nothing readable: never adopt, never signal, never conclude
 *  `unreadable-table` this platform cannot list processes at all
 */
export type IdentityKind = 'verified' | 'gone' | 'not-ours' | 'unknown' | 'unreadable-table';

/**
 * Identity, decided by TWO independent witnesses — pure, so every branch can be
 * asserted instead of hoped for.
 *
 *   pid + command line        what the run was started as
 *   pid + OS start token      when the OS says that process began
 *
 * The rule that makes this safe rather than merely clever:
 *
 *   a witness may VETO, and only the start token may ACCEPT ALONE.
 *
 *  - A different command line is not our process, so `false` wins over any
 *    agreement elsewhere — a recycled pid running something else is refused.
 *  - When the command lines agree, a start token that DISAGREES refuses too: the
 *    same command started as a different process (another `npm test` in another
 *    directory, a stranger's `node`) is precisely the case that used to be
 *    adopted. This is the new refusal, and it can only ever refuse.
 *  - When the command line cannot be read at all (some platforms hide it, and a
 *    kernel process has none), a MATCHING start token is accepted: that is a
 *    value the kernel does not hand out twice, and it is the difference between
 *    a recovered run that can be stopped and one that can only be stopped by
 *    hand. Anything short of a match stays `null` — unknown, never ours.
 */
export function processIdentityVerdict(
  recorded: RecordedProcess,
  live: LiveProcess | null,
): boolean | null {
  return processIdentityCheck(recorded, live).verdict;
}

/**
 * The verdict AND the evidence behind it.
 *
 * A refusal the operator cannot act on is barely better than a crash: the whole
 * consequence of `false` here is that a real command keeps running and can only
 * be stopped by hand, so the message has to say WHICH witness failed — a
 * different command line and a mismatched start time are different problems, and
 * "could not tell" is a third.
 */
export function processIdentityCheck(
  recorded: RecordedProcess,
  live: LiveProcess | null,
): { verdict: boolean | null; why: string; kind: IdentityKind } {
  if (live === null) {
    return {
      verdict: null,
      why: 'this platform could not read a process table, so the pid cannot be checked',
      kind: 'unreadable-table',
    };
  }
  // A FACT, as opposed to an inference: the pid is not in the table at all. Only
  // this branch may ever be read as "it is over" — every other refusal says
  // something about IDENTITY, which is not the same claim (see the callers).
  if (!live.found) return { verdict: false, why: 'the pid is not running any more', kind: 'gone' };

  const byCommand = commandVerdict(recorded.command, live.command);
  const start = recorded.osStartedAt;
  const byStart = start && live.startedAtText ? start === live.startedAtText : null;  if (byCommand === false) {
    return {
      verdict: false,
      kind: 'not-ours',
      why:
        `the pid now runs a different command line (\`${live.command}\`), so it is not the ` +
        `process that was started`,
    };
  }
  if (byCommand === true) {
    if (byStart === false) {
      return {
        verdict: false,
        kind: 'not-ours',
        why:
          `its command line matches, but the OS start time differs from the one recorded for this run ` +
          `(\`${live.startedAtText}\` now vs \`${start}\` then) — the pid was RECYCLED by a different process ` +
          `that happens to run the same command`,
      };
    }
    return {
      verdict: true,
      kind: 'verified',
      why:
        byStart === true
          ? 'its command line AND its OS start time match what was recorded when it was started'
          : 'its command line matches what was recorded (no start-time token was recorded to compare)',
    };
  }
  if (byStart === true) {
    return {
      verdict: true,
      kind: 'verified',
      why:
        'its OS start time matches the token recorded when it was started, which is a value the OS does not ' +
        'hand to two different processes (its command line could not be read)',
    };
  }
  return {
    verdict: null,
    kind: 'unknown',
    why: byStart === false
      ? 'its start time does not match, and its command line could not be read'
      : 'neither its command line nor its start time could be read',
  };
}

/** `processIdentityVerdict` against the live table: one read, both witnesses. */
export function processIdentityMatches(pid: number, recorded: RecordedProcess): boolean | null {
  return processIdentityVerdict(recorded, lookupProcess(pid));
}
