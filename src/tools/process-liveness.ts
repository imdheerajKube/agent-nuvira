/**
 * Process liveness — is a long-running command WORKING, or is it HUNG?
 *
 * WHY THIS EXISTS. Handing a command to monitoring instead of killing it at a
 * clock (see `run-terminal.ts`) removed the false failure, but it left the
 * opposite hole open: a command that is genuinely STUCK — waiting on a prompt
 * with no stdin, holding a lock, blocked on a socket that will never answer —
 * now runs forever, and "it is still running" is not a diagnosis. Silence alone
 * cannot tell the two apart, because a real test suite can be quiet for minutes
 * while it works. The signal that separates them is CPU:
 *
 *   - producing output                → it is doing something
 *   - burning CPU with no output      → it is computing (a build, a solver)
 *   - NO output AND NO CPU for a long time → it is waiting for something that is
 *     never coming. That is a hang, and it is a FACT about the process, not a
 *     guess from a stopwatch.
 *
 * So this module samples the process TREE (the shell `spawn(..., { shell: true })`
 * creates plus everything under it) for cumulative CPU time, and classifies a
 * run into `working` / `stalled` / `hung` with the evidence attached. Callers
 * decide what to do with the verdict; the one rule this module enforces is that
 * `hung` requires POSITIVE evidence (measurable CPU that is not advancing) —
 * when CPU cannot be measured, a long silence is reported as `stalled`, never as
 * `hung`, because an unmeasurable process must not be reaped on a guess.
 *
 * Platform: on POSIX the table comes from `ps` (macOS + Linux), the same tool
 * `src/cli/process-control.ts` already relies on. On Windows it comes from ONE
 * `Get-CimInstance Win32_Process` query — which reports `ParentProcessId` AND
 * `KernelModeTime` + `UserModeTime` (CPU, in 100ns units) — so the same rule
 * works there instead of degrading to silence-only: the tree walk and the
 * zero-CPU evidence are both available, with `wmic` as the fallback the rest of
 * this repo already uses.
 *
 * One Windows semantic difference is worth stating plainly, because `kill`
 * implies something it cannot deliver there: Windows has no graceful SIGTERM.
 * `process.kill(pid, 'SIGTERM')` is an immediate termination, so the
 * SIGTERM→grace→SIGKILL ladder is a POSIX-only refinement.
 */

import { execFileSync, execSync } from 'node:child_process';

/** How a long run is doing: the state a clock alone cannot distinguish. */
export type Liveness = 'finished' | 'starting' | 'working' | 'stalled' | 'hung';

/** The thresholds the classification is made from (ms). */
export interface LivenessThresholds {
  /** Silence after which a run is worth *reporting* as stalled. */
  stallQuietMs: number;
  /** Silence after which, WITH no CPU, a run is HUNG. */
  hangQuietMs: number;
  /** CPU ms over one sample window that counts as "it is computing". */
  hangCpuFloorMs: number;
}

export const DEFAULT_LIVENESS_THRESHOLDS: LivenessThresholds = {
  stallQuietMs: 60_000,
  hangQuietMs: 300_000,
  hangCpuFloorMs: 500,
};

/**
 * The thresholds, with env overrides — read at CALL time, not module load, so a
 * test (or an operator) can change them without re-importing.
 *
 * `NUVIRA_HANG_QUIET_MS` is the one that matters operationally: it is how long a
 * command may be silent AND idle before the agent is told it is hung.
 */
export function livenessThresholds(env: NodeJS.ProcessEnv = process.env): LivenessThresholds {
  const int = (raw: string | undefined, fallback: number): number => {
    const n = Number.parseInt(String(raw ?? '').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    stallQuietMs: int(env.NUVIRA_STALL_QUIET_MS, DEFAULT_LIVENESS_THRESHOLDS.stallQuietMs),
    hangQuietMs: int(env.NUVIRA_HANG_QUIET_MS, DEFAULT_LIVENESS_THRESHOLDS.hangQuietMs),
    hangCpuFloorMs: int(env.NUVIRA_HANG_CPU_MS, DEFAULT_LIVENESS_THRESHOLDS.hangCpuFloorMs),
  };
}

/**
 * Parse a `ps -o time=` value into milliseconds of cumulative CPU.
 *
 * Formats seen in the wild: `MM:SS.cc` (macOS), `HH:MM:SS` (Linux), and
 * `DD-HH:MM:SS` (BSD, for a long-lived process). A value that does not parse is
 * `null` — the caller must treat "no reading" differently from "no CPU", or a
 * formatting change would read as a hang.
 */
export function parseCpuTime(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  if (![days, hours, minutes, seconds].every((n) => Number.isFinite(n))) return null;
  return ((days * 24 + hours) * 60 + minutes) * 60_000 + Math.round(seconds * 1000);
}

export interface ProcessTreeSample {
  /** The root pid was found in the process table. */
  found: boolean;
  /** Cumulative CPU (ms) of the root AND every descendant; null = unmeasurable. */
  cpuMs: number | null;
  /** The tree, root first, children after (deepest last) — the kill order. */
  pids: number[];
}

/** One row of the process table. */
export interface ProcessRow {
  ppid: number;
  /** Cumulative CPU (user+sys) ms of THIS process; null = unmeasurable. */
  cpuMs: number | null;
  /** The process line, when the platform reports one (used for identity checks). */
  command: string | null;
  /**
   * When the OS says this process STARTED, as an opaque per-platform token —
   * `lstart` text on POSIX, Windows file-time ticks. `null` = unreadable.
   *
   * It exists to answer one question a pid cannot: is this the SAME process?
   * A pid is a number the kernel reuses (Windows recycles aggressively, Linux
   * wraps at a few million), so `pid === 1234` is not identity — it is a hint.
   * This is a VALUE the kernel will not hand to two different processes, which
   * is what makes it a witness. Kept as the raw token rather than a parsed date
   * on purpose: two reads of the same process produce the same token, and
   * comparing tokens cannot be skewed by a clock step, a timezone change or a
   * rounding error. Unknown stays `null`, never a fabricated value.
   */
  startedAtText: string | null;
}

export type ProcessTable = Map<number, ProcessRow>;

/**
 * `lstart`, the OS's own answer to "when did this process start" — `Day Mon D
 * HH:MM:SS YYYY` (e.g. `Tue Oct 14 15:02:03 2026`).
 *
 * Matched structurally because `ps` has no way to emit a marker column: the
 * pattern is anchored right after the CPU field, and a command line whose first
 * five words happen to look exactly like that is not a thing. If it does not
 * match, the remainder is the command — the old behaviour, unchanged.
 */
const POSIX_LSTART = /^([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

/**
 * Parse a POSIX process table: `ps -eo pid=,ppid=,time=,lstart=,command=` — and
 * the older `…,command=` shape, which parses identically minus the start token.
 *
 * The command column is LAST on purpose: it may contain spaces and anything else,
 * so everything after the known fields is taken verbatim.
 */
export function parsePosixProcessTable(stdout: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[4].trim();
    const withStart = POSIX_LSTART.exec(rest);
    table.set(Number.parseInt(m[1], 10), {
      ppid: Number.parseInt(m[2], 10),
      cpuMs: parseCpuTime(m[3]),
      command: (withStart ? withStart[2] : rest).trim() || null,
      // Whitespace inside the token is collapsed so `ps`'s column padding cannot
      // make two readings of the SAME process compare unequal.
      startedAtText: withStart ? withStart[1].replace(/\s+/g, ' ').trim() : null,
    });
  }
  return table;
}

/**
 * Parse the Windows probe: `<pid>|<ppid>|<kernel 100ns>|<user 100ns>|<command>`.
 *
 * The pipe-delimited shape is the one `src/cli/process-control.ts` already uses
 * for the same reason: it survives command lines that contain spaces, commas or
 * quotes. A process whose CPU counters are unreadable (`KernelModeTime` is null
 * for some system processes) yields an EMPTY field, which must stay
 * "unmeasurable" — not zero — or an unreadable counter would read as a hang.
 *
 * 100ns units are converted to ms (÷10 000), the same unit `ps` reports in.
 */
export function parseWindowsProcessTable(stdout: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.split('|');
    if (parts.length < 4) continue;
    const pid = Number.parseInt(parts[0].trim(), 10);
    const ppid = Number.parseInt(parts[1].trim(), 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const kernel = Number.parseInt(parts[2].trim(), 10);
    const user = Number.parseInt(parts[3].trim(), 10);
    const measurable = Number.isFinite(kernel) && Number.isFinite(user);
    // The start token is MARKED (`t<ticks>`), so the shape is unambiguous: a
    // command line containing `|` can add fields but cannot manufacture a `t`
    // marker, which a positional guess could be fooled by. A `t` with nothing
    // after it is the honest "the OS would not tell us", not a fabricated value.
    const marked = parts.length >= 5 && /^t\d*$/.test(parts[4].trim());
    const commandFrom = marked ? 5 : 4;
    table.set(pid, {
      ppid,
      cpuMs: measurable ? Math.round((kernel + user) / 10_000) : null,
      command: (parts.slice(commandFrom).join('|').trim() || null),
      startedAtText: marked ? parts[4].trim().slice(1) || null : null,
    });
  }
  return table;
}

/**
 * Parse the `wmic … /format:csv` fallback.
 *
 * Header-driven, because wmic emits its columns in QUERY order and the values
 * themselves can contain commas — so the header is the only reliable index.
 */
export function parseWmicProcessTable(stdout: string): ProcessTable {
  const table: ProcessTable = new Map();
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return table;
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const at = (...names: string[]): number => header.findIndex((h) => names.includes(h));
  const pidAt = at('processid');
  const ppidAt = at('parentprocessid');
  const kernelAt = at('kernelmodetime');
  const userAt = at('usermodetime');
  const created = at('creationdate');
  if (pidAt < 0) return table;
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const pid = Number.parseInt((cells[pidAt] ?? '').trim(), 10);
    if (!Number.isFinite(pid)) continue;
    const ppid = ppidAt >= 0 ? Number.parseInt((cells[ppidAt] ?? '').trim(), 10) : 0;
    const kernel = kernelAt >= 0 ? Number.parseInt((cells[kernelAt] ?? '').trim(), 10) : Number.NaN;
    const user = userAt >= 0 ? Number.parseInt((cells[userAt] ?? '').trim(), 10) : Number.NaN;
    const measurable = Number.isFinite(kernel) && Number.isFinite(user);
    // wmic CSV puts the host name first and the command line LAST (it can itself
    // contain commas, so it is everything after the last known column).
    table.set(pid, {
      ppid: Number.isFinite(ppid) ? ppid : 0,
      cpuMs: measurable ? Math.round((kernel + user) / 10_000) : null,
      command: null,
      // wmic's `creationdate` (`20261014150203.000000+060`): an opaque token that
      // is stable across reads, which is all the identity check needs.
      startedAtText: created >= 0 ? (cells[created] ?? '').trim() || null : null,
    });
  }
  return table;
}

/**
 * The Windows probe. `CreationDate.Ticks` (100ns since 0001-01-01) is the start
 * token: a plain integer, so it cannot be mangled by locale, date format or the
 * pipe the rest of the row uses. The `t` prefix marks the field's PRESENCE — an
 * absent `CreationDate` yields bare `t`, which parses as "unknown", rather than
 * shifting the command line into the wrong column.
 */
const WINDOWS_PS_QUERY =
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.KernelModeTime)|$($_.UserModeTime)|t$(if ($_.CreationDate) { $_.CreationDate.Ticks })|$($_.CommandLine)" }';

function readWindowsProcessTable(): ProcessTable | null {
  // execFileSync, not execSync: cmd.exe mangles PowerShell's `$()` syntax.
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PS_QUERY],
      { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const table = parseWindowsProcessTable(out);
    if (table.size > 0) return table;
  } catch {
    // PowerShell unavailable or too slow — try the older tool.
  }
  try {
    const out = execSync(
      'wmic process get processid,parentprocessid,kernelmodetime,usermodetime,creationdate /format:csv',
      { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const table = parseWmicProcessTable(out);
    return table.size > 0 ? table : null;
  } catch {
    return null;
  }
}

function readPosixProcessTable(): ProcessTable | null {
  // `lstart` first, because it carries the identity token. A `ps` without it
  // (an old or trimmed build) still gets the whole table — the start token is
  // then simply unknown, which the identity rule treats as "no second witness"
  // rather than as a mismatch.
  for (const args of ['ps -eo pid=,ppid=,time=,lstart=,command=', 'ps -eo pid=,ppid=,time=,command=']) {
    try {
      const out = execSync(args, {
        encoding: 'utf8',
        timeout: 3_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const table = parsePosixProcessTable(out);
      if (table.size > 0) return table;
    } catch {
      // Try the next shape; if both fail the answer is "unmeasurable", never
      // "no CPU" — that distinction is what keeps a missing reading from
      // certifying a hang.
    }
  }
  return null;
}

/**
 * The last window in which the process-table probe held the event loop — the
 * time during which this process could not have NOTICED the output a monitored
 * command was producing.
 *
 * It is not bookkeeping for its own sake. The probe is SYNCHRONOUS
 * (`execFileSync`/`execSync`), so while it runs the child's stdout events sit in
 * the queue unread and `lastOutputAt` stays frozen at the last drain. On POSIX
 * `ps` costs ~10-30ms and that is invisible, but on Windows it is a PowerShell
 * start — MEASURED at ~1s on the release runners — which is longer than the
 * silence a watchdog is willing to call a hang. The consequence was REAL and
 * reproduced in CI: a command printing a line every 80ms was reported "HUNG — no
 * output for 1s and no CPU in that time", because the only second of silence in
 * the picture was the watchdog's own blindness. Callers subtract this window from
 * the silence they are willing to hold against a run (see
 * `LivenessInput.unobservedMs`), which is the difference between "it said
 * nothing" and "I was not looking".
 *
 * It is the COMPLEMENT of the byte count (`LivenessInput.bytesSinceLastSample`),
 * which is the primary rule: a run whose output WAS read between two samples is
 * plainly working, and that covers a monitor slow enough to batch its reads. This
 * window covers the other half — a sample that read nothing at all, because its
 * own probe held the loop for the span being judged.
 *
 * The MOST RECENT read only, and that is the one that matters: a tick reads this
 * BEFORE running its own probe, so what it gets is the PREVIOUS probe's block —
 * precisely the block that can have frozen the quiet window it is judging.
 */
let lastProbeBlockedFrom = 0;
let lastProbeBlockedUntil = 0;

export function lastProbeBlockedWindow(): { from: number; until: number } {
  return { from: lastProbeBlockedFrom, until: lastProbeBlockedUntil };
}

/** One process table read: pid → { parent, cpu, command }. NEVER cached. */
function readProcessTable(): ProcessTable | null {
  const from = Date.now();
  try {
    return process.platform === 'win32' ? readWindowsProcessTable() : readPosixProcessTable();
  } finally {
    // Recorded in `finally` so a probe that THREW still reports the time it held
    // the loop — a failed read hides output exactly as well as a slow one.
    lastProbeBlockedFrom = from;
    lastProbeBlockedUntil = Date.now();
  }
}

/**
 * One process table read, for a caller that needs the SAME view several times.
 *
 * A sample tick asks about every monitored run and then signals some of them, and
 * on Windows each read costs a PowerShell start — so the tick reads the table ONCE
 * and threads it through, instead of N times.
 *
 * Deliberately NOT a time-based cache. A cached table can answer about a snapshot
 * taken before a process existed, and the answer it gives is "not found" — which
 * a caller reads as "it is gone". That is the one direction this module must never
 * guess in.
 */
export function processTableSnapshot(): ProcessTable | null {
  return readProcessTable();
}

/**
 * Sample the process tree rooted at `pid`: whether it exists, what it has cost
 * in CPU so far, and every pid in it.
 *
 * The tree is the point. `spawn(command, { shell: true })` means the REAL work
 * is a child of the shell we hold the handle to, so a sample (and a stop) that
 * only looked at the root would report the shell's own ~0 CPU while the build
 * underneath burned a core — the exact false hang this must not produce.
 */
export function processTreeOf(table: ProcessTable, pid: number): ProcessTreeSample {
  // pid <= 0 is not a process: 0 means "my process group" and -1 means "EVERY
  // process I am allowed to signal". A caller that lost its pid must get an empty
  // sample, never a signal to the whole machine.
  if (!Number.isFinite(pid) || pid <= 0) return { found: false, cpuMs: null, pids: [] };
  if (!table.has(pid)) return { found: false, cpuMs: null, pids: [pid] };

  // Children indexed by parent, so the walk is one pass per level.
  const byParent = new Map<number, number[]>();
  for (const [childPid, info] of table) {
    const siblings = byParent.get(info.ppid);
    if (siblings) siblings.push(childPid);
    else byParent.set(info.ppid, [childPid]);
  }

  const pids: number[] = [];
  const queue = [pid];
  const seen = new Set<number>([pid]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    pids.push(current);
    for (const child of byParent.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }

  // CPU is summed only when EVERY node gave a reading: a partial sum would look
  // like "less CPU than it really used", which is the safe direction only by
  // accident. Missing data must stay "unmeasurable" — because "unmeasurable"
  // cannot certify a hang, while a partial zero can.
  let total = 0;
  let measurable = true;
  for (const treePid of pids) {
    const info = table.get(treePid);
    if (!info || info.cpuMs === null) {
      measurable = false;
      break;
    }
    total += info.cpuMs;
  }
  return { found: true, cpuMs: measurable ? total : null, pids };
}

export function sampleProcessTree(pid: number, table?: ProcessTable | null): ProcessTreeSample {
  if (!Number.isFinite(pid) || pid <= 0) return { found: false, cpuMs: null, pids: [] };
  const resolved = table === undefined ? readProcessTable() : table;
  if (!resolved) return { found: false, cpuMs: null, pids: [pid] };
  return processTreeOf(resolved, pid);
}

/**
 * Is this pid running? `null` means THIS PLATFORM CANNOT TELL.
 *
 * The distinction is load-bearing for a run recovered from disk: "not found"
 * must never be read as "finished" on a platform where the process table is not
 * readable, or a restart would declare live work dead (and a dead run's recorded
 * exit code would be reported as its verdict).
 */
export function processAlive(pid: number): boolean | null {
  return tableAlive(readProcessTable(), pid);
}

/**
 * `processAlive`, answered from a table the caller ALREADY read — so a tick that
 * samples every monitored run (and reconciles the recovered ones) costs one
 * process listing, not one per run.
 */
export function tableAlive(table: ProcessTable | null, pid: number): boolean | null {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (!table) return null;
  return table.has(pid);
}

/**
 * One process's row, cross-platform: `null` when the platform cannot read the
 * table at all, `{ found: false }` when the pid is simply not there.
 *
 * The distinction matters to a caller that has to decide whether a pid is still
 * OURS: "gone" is an answer, "cannot tell" is not.
 */
export function lookupProcess(
  pid: number,
): { found: boolean; command: string | null; startedAtText: string | null } | null {
  if (!Number.isFinite(pid) || pid <= 0) return { found: false, command: null, startedAtText: null };
  const table = readProcessTable();
  if (!table) return null;
  const row = table.get(pid);
  return row
    ? { found: true, command: row.command, startedAtText: row.startedAtText }
    : { found: false, command: null, startedAtText: null };
}

/**
 * How much of a quiet window `[quietFrom, quietUntil]` fell inside a window in
 * which the monitor could not observe output at all.
 *
 * That part of the silence is not evidence: an output byte produced while the
 * observer's event loop was blocked is timestamped only once the loop is free
 * again, so it shows up as silence that never happened. Pure, so the overlap can
 * be asserted directly (see `lastProbeBlockedWindow` for where the blocked
 * window comes from).
 */
export function unobservedPartOf(
  quietFrom: number,
  quietUntil: number,
  blocked: { from: number; until: number },
): number {
  if (blocked.until <= blocked.from) return 0;
  const overlap = Math.min(blocked.until, quietUntil) - Math.max(blocked.from, quietFrom);
  return Math.max(0, overlap);
}

export interface LivenessInput {
  /** The run still exists (the registry has not seen it exit). */
  alive: boolean;
  /** Bytes produced since the run started. */
  bytes: number;
  /** ms since the last output byte (or since the start when nothing came). */
  quietMs: number;
  /**
   * How much of `quietMs` the monitor itself could not have observed — time its
   * own synchronous probe held the event loop (see `lastProbeBlockedWindow`, and
   * `unobservedPartOf` for computing it). SUBTRACTED before any verdict is made:
   * silence we were blind for is not the command's silence. Optional, and 0 by
   * default, because a caller that knows it was watching the whole time has
   * nothing to subtract.
   */
  unobservedMs?: number;
  /**
   * Output bytes that arrived SINCE THE PREVIOUS SAMPLE.
   *
   * This is the load-bearing signal, and it exists because a byte's timestamp is
   * the moment the monitor READ it, not the moment the command wrote it: while a
   * sample holds the event loop (the process-table probe is synchronous — ~10-30ms
   * of `ps`, but ~1s of PowerShell on the windows release runners), everything the
   * command prints queues up unread and is stamped all at once when the loop is
   * free. So measured silence can be an artefact of the observer, and a command
   * printing a line every 80ms was reported in CI as "HUNG — no output for 1s and
   * no CPU in that time". Bytes moved, though. They always move when a command is
   * producing, whatever the clock of the reader says, and they do NOT move when it
   * is genuinely stuck — which is exactly the distinction being made.
   *
   * 0/undefined (nothing arrived, or this is the first sample and there is no
   * baseline) is NOT evidence of anything, so it leaves the CPU and silence rules
   * to decide.
   */
  bytesSinceLastSample?: number;
  /** ms since the run started. */
  ageMs: number;
  /** CPU ms now, and at the previous sample (null = unmeasurable). */
  cpuMs: number | null;
  prevCpuMs: number | null;
  /** ms between the two CPU samples. */
  sampleWindowMs: number;
}

export interface LivenessVerdict {
  verdict: Liveness;
  /** The evidence, in words — this is what the agent and the operator read. */
  why: string;
}

/** `45s` / `3m 05s` — how long, for a human reading a message. */
export function formatSpan(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Classify a run from its evidence. Deterministic and pure, so the decision can
 * be asserted directly instead of inferred from a message.
 *
 * Order matters, and it is deliberately "innocent until proven hung":
 * output recently → working; CPU advancing → working; only then, silence PLUS a
 * measurable absence of CPU → hung. Anything we cannot prove lands in `stalled`,
 * which is reported but never reaped.
 *
 * The silence is the ATTESTED silence: `quietMs` minus the part of it the monitor
 * could not have observed (`unobservedMs`). Silence nobody was watching for is
 * not something to accuse a command of.
 */
export function classifyLiveness(
  input: LivenessInput,
  thresholds: LivenessThresholds = DEFAULT_LIVENESS_THRESHOLDS,
): LivenessVerdict {
  if (!input.alive) return { verdict: 'finished', why: 'the process has exited' };
  // A command seconds old has simply not said anything yet.
  if (input.ageMs < 3_000) return { verdict: 'starting', why: 'just started' };

  // It produced something since we last looked — that is production itself, and
  // it outranks the clock (see `bytesSinceLastSample`: the clock measures when we
  // READ, so it under-reports a command we were too busy to listen to).
  const arrived = input.bytesSinceLastSample ?? 0;
  if (arrived > 0) {
    return {
      verdict: 'working',
      why: `${arrived} bytes of output arrived since the last sample — still producing`,
    };
  }

  const quietMs = Math.max(0, input.quietMs - Math.max(0, input.unobservedMs ?? 0));

  if (quietMs < thresholds.stallQuietMs) {
    return {
      verdict: 'working',
      why: input.bytes > 0 ? `produced output ${formatSpan(quietMs)} ago` : 'producing output',
    };
  }

  // "the last 0s" reads as nonsense, so a sub-second sample window is reported
  // as one second — the point is that a MEASURABLE window passed with no CPU.
  const windowLabel = formatSpan(Math.max(1_000, input.sampleWindowMs));
  const measurable = input.cpuMs !== null && input.prevCpuMs !== null;
  const cpuDelta = measurable ? Math.max(0, (input.cpuMs as number) - (input.prevCpuMs as number)) : null;
  if (cpuDelta !== null && cpuDelta >= thresholds.hangCpuFloorMs) {
    return {
      verdict: 'working',
      why:
        `silent for ${formatSpan(quietMs)} but still computing — ` +
        `${cpuDelta}ms of CPU in the last ${windowLabel}`,
    };
  }

  if (quietMs >= thresholds.hangQuietMs) {
    if (cpuDelta !== null) {
      return {
        verdict: 'hung',
        why:
          `no output for ${formatSpan(quietMs)} and no CPU in that time ` +
          `(${cpuDelta}ms over the last ${windowLabel}) — it is waiting for something ` +
          `that is not coming (a prompt with no stdin, a lock, or a socket that never answers)`,
      };
    }
    return {
      verdict: 'stalled',
      why:
        `no output for ${formatSpan(quietMs)}; CPU is not measurable on this platform, so this is ` +
        `reported rather than treated as a confirmed hang`,
    };
  }

  return {
    verdict: 'stalled',
    why: measurable
      ? `quiet for ${formatSpan(quietMs)} with only ${cpuDelta}ms of CPU in the last ` +
        `${windowLabel} — slowing rather than stopped`
      : `quiet for ${formatSpan(quietMs)}`,
  };
}

/**
 * Stop a process TREE, deepest first — the shell we spawned and the real work
 * under it.
 *
 * A plain `child.kill()` reaches only the shell, which is why a "stopped" hung
 * build can keep running: the shell dies, the compiler it launched does not.
 * Best-effort throughout — a pid that exited between the sample and the signal
 * must not throw, and a failed signal falls back to the child handle.
 *
 * On Windows the tree comes from WMI (`Get-CimInstance`), so this genuinely
 * reaches grandchildren there too; if that probe is unavailable the tree is just
 * the root, which is the old behaviour rather than a regression. Note that a
 * Windows "signal" takes effect immediately — there is no graceful SIGTERM to
 * follow with a SIGKILL.
 */
export function killProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  child?: { kill(signal?: NodeJS.Signals | number): boolean },
  table?: ProcessTable | null,
): number[] {
  const signalled: number[] = [];
  // GUARD, and it is not defensive theatre: `process.kill(-1, sig)` signals
  // EVERY process this user can signal — on a developer machine that is a
  // spontaneous logout. Only real, positive pids are ever signalled.
  if (Number.isFinite(pid) && pid > 0) {
    const { pids } = sampleProcessTree(pid, table);
    for (const treePid of [...pids].reverse()) {
      if (!Number.isFinite(treePid) || treePid <= 0) continue;
      try {
        process.kill(treePid, signal);
        signalled.push(treePid);
      } catch {
        /* already gone — nothing to do */
      }
    }
  }
  if (signalled.length === 0 && child) {
    try {
      child.kill(signal);
    } catch {
      /* best-effort */
    }
  }
  return signalled;
}
