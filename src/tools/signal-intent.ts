/**
 * Signal INTENT, not signal spelling.
 *
 * WHY THIS REPLACES A REGEX. The built-in floor used to refuse `kill -9` with
 * one pattern (`/kill\s+-9\b/`). That is a spelling, not an intent: `pkill -9`,
 * `kill -s KILL`, `kill -KILL` and `kill --signal=9` all pass it, while
 * `killall node` — an ordinary graceful restart — was refused as
 * "system-level destruction". An agent that needs to free a port and cannot use
 * the graceful form picks a spelling the regex misses, so the rule produced
 * workarounds instead of compliance. Measured repeatedly in normal use:
 * restarting a dev server, clearing a stale test run.
 *
 * THE MODEL. A signal operation is four attributes:
 *
 *   signal  TERM (default) | KILL | INT | HUP | ...
 *   target  a pid, a job spec, a name, or a pattern
 *   scope   single | pattern | mass
 *   force   whether KILL (9) was requested
 *
 * Policy applies to the tuple. Ownership decides the rest: stopping a process
 * this harness started is a supervisor action and is allowed; stopping anything
 * else needs a human, and forcing a broad set is refused outright.
 *
 * This is data, not text — which is why it cannot be bypassed by a flag order
 * and why it does not refuse the graceful form of the same operation.
 */

/** The signals policy cares about. Numeric aliases are mapped onto these. */
export type SignalName = 'TERM' | 'KILL' | 'INT' | 'HUP' | 'QUIT' | 'STOP' | 'TSTP' | 'CONT' | 'USR1' | 'USR2';

export type SignalScope = 'single' | 'pattern' | 'mass';

export interface ParsedSignalCommand {
  /** Which binary performs the signal. */
  tool: 'kill' | 'pkill' | 'killall';
  signal: SignalName;
  /** True when the signal is KILL (9) — the only "forced" signal. */
  force: boolean;
  scope: SignalScope;
  /** Set when the target is a numeric pid. */
  pid?: number;
  /** Set when the target is a pattern / process name. */
  pattern?: string;
}

export type SignalAction = 'allow' | 'confirm' | 'deny';

export interface SignalDecision {
  action: SignalAction;
  /** The built-in rule name when `action === 'deny'`; undefined otherwise. */
  rule?: string;
  reason: string;
}

// ─── Ownership registry ──────────────────────────────────────────────────────

/**
 * Pids this harness has spawned. A forced stop of one of these is the harness
 * reaping its own child — allowed without a prompt. Anything else is an
 * operator action.
 *
 * In-memory on purpose: ownership must not survive a restart, because a pid
 * reused by the OS after a restart does not belong to us any more. The
 * persisted monitored-run registry (run-terminal) reconciles its own runs
 * separately; this set answers "may I force-kill this pid right now".
 */
const ownedPids = new Set<number>();

export function registerOwnedPid(pid: number | undefined | null): void {
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 1) ownedPids.add(pid);
}

export function unregisterOwnedPid(pid: number | undefined | null): void {
  if (typeof pid === 'number') ownedPids.delete(pid);
}

export function isOwnedPid(pid: number): boolean {
  return pid === process.pid || ownedPids.has(pid);
}

/** Test hook: forget every registered pid. */
export function resetOwnedPids(): void {
  ownedPids.clear();
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

const NUMERIC_SIGNALS: Record<number, SignalName> = {
  1: 'HUP', 2: 'INT', 3: 'QUIT', 9: 'KILL', 15: 'TERM', 18: 'CONT', 19: 'STOP', 20: 'TSTP',
  10: 'USR1', 12: 'USR2',
};

const NAMED_SIGNALS = new Set<SignalName>([
  'TERM', 'KILL', 'INT', 'HUP', 'QUIT', 'STOP', 'TSTP', 'CONT', 'USR1', 'USR2',
]);

function normalizeSignal(raw: string): SignalName | null {
  const value = raw.trim().toUpperCase().replace(/^SIG/, '');
  if (/^\d+$/.test(value)) return NUMERIC_SIGNALS[Number(value)] ?? null;
  return NAMED_SIGNALS.has(value as SignalName) ? (value as SignalName) : null;
}

/** Split a shell string into command segments at separators, respecting quotes. */
function segments(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '`') {
      out.push(current);
      current = '';
      continue;
    }
    if (ch === '&' || ch === '|') {
      // `&&`, `||`, `|`, `&`, and `$(...)`-adjacent boundaries close a segment.
      if (current.trim()) out.push(current);
      current = '';
      // Skip the second character of && or ||
      if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) i++;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      if (current.trim()) out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

/** Tokenize one segment, keeping quoted strings together. */
function tokens(segment: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let quoted = false;
  for (const ch of segment.trim()) {
    if (quote) {
      if (ch === quote) { quote = null; } else { current += ch; }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; quoted = true; continue; }
    if (/\s/.test(ch)) {
      if (current || quoted) out.push(current);
      current = '';
      quoted = false;
      continue;
    }
    current += ch;
  }
  if (current || quoted) out.push(current);
  return out;
}

const LEADING_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', 'time', '!']);

/**
 * Parse the first signal operation in a command string, or null when there is
 * none. Recognised: `kill`, `pkill`, `killall` at a command position.
 */
export function parseSignalCommand(command: string): ParsedSignalCommand | null {
  if (!command || !/\b(?:kill|pkill|killall)\b/i.test(command)) return null;

  for (const segment of segments(command)) {
    let toks = tokens(segment);
    // Skip shell keywords and inline env assignments (`FOO=bar kill 1`).
    while (toks.length && (LEADING_KEYWORDS.has(toks[0].toLowerCase()) || /^[a-z_][a-z0-9_]*=/i.test(toks[0]))) {
      toks = toks.slice(1);
    }
    if (!toks.length) continue;
    const tool = toks[0].toLowerCase();
    if (tool !== 'kill' && tool !== 'pkill' && tool !== 'killall') continue;

    const rest = toks.slice(1);
    let signal: SignalName = 'TERM';
    let signalSeen = false;
    let fullMatch = false;
    const targets: string[] = [];

    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--') { targets.push(...rest.slice(i + 1)); break; }
      if (arg === '-f' || arg === '--full') { fullMatch = true; continue; }
      if (arg === '-s' || arg === '--signal') {
        const next = rest[i + 1];
        if (next) {
          const parsed = normalizeSignal(next);
          if (parsed) { signal = parsed; signalSeen = true; i++; continue; }
        }
        continue;
      }
      if (arg.startsWith('--signal=')) {
        const parsed = normalizeSignal(arg.slice('--signal='.length));
        if (parsed) { signal = parsed; signalSeen = true; }
        continue;
      }
      if (/^-[0-9]+$/.test(arg)) {
        // kill -9 / kill -15 / kill -2
        const parsed = normalizeSignal(arg.slice(1));
        if (parsed) { signal = parsed; signalSeen = true; }
        continue;
      }
      if (/^-[A-Za-z]+$/.test(arg)) {
        // kill -KILL / -SIGKILL / -TERM / -INT
        const parsed = normalizeSignal(arg.slice(1));
        if (parsed) { signal = parsed; signalSeen = true; }
        continue;
      }
      if (arg.startsWith('-') && arg.length > 1) continue; // other flags (-P, -u, -e)
      targets.push(arg);
    }

    // `kill` with no explicit signal defaults to TERM; `kill -l` lists and is not an operation.
    void signalSeen;
    const force = signal === 'KILL';
    const firstTarget = targets[0];
    const numeric = firstTarget && /^\d+$/.test(firstTarget) ? Number(firstTarget) : undefined;

    if (tool === 'killall') {
      return { tool, signal, force, scope: 'mass', pattern: firstTarget };
    }
    if (tool === 'pkill') {
      // -f means the pattern is matched against the full command line: broad,
      // but addressable (a port or a path in the pattern narrows it a lot).
      return { tool, signal, force, scope: 'pattern', pattern: targets.join(' ') || undefined };
    }
    if (numeric !== undefined) {
      return { tool, signal, force, scope: 'single', pid: numeric };
    }
    // `kill %1`, `kill $!`, or an unparseable target: treat as pattern-scope,
    // never as an owned single pid.
    return {
      tool, signal, force,
      scope: fullMatch || firstTarget ? 'pattern' : 'mass',
      pattern: firstTarget,
    };
  }
  return null;
}

// ─── Policy ──────────────────────────────────────────────────────────────────

/**
 * Decide a parsed signal operation.
 *
 *   forced + owned single        allow   (the harness reaping its own child)
 *   graceful + owned single      allow
 *   forced + unowned single      deny    ("forced kill")
 *   forced + pattern / mass      deny    ("forced mass kill")
 *   graceful + pattern           confirm (addressable, but not ours)
 *   graceful + mass              deny    ("mass process kill")
 *   graceful + unowned single    confirm (one human yes)
 */
export function decideSignalCommand(parsed: ParsedSignalCommand): SignalDecision {
  const owned = parsed.scope === 'single' && parsed.pid !== undefined && isOwnedPid(parsed.pid);

  if (parsed.force) {
    if (owned) {
      return { action: 'allow', reason: `SIGKILL to owned process ${parsed.pid} (harness child)` };
    }
    if (parsed.scope === 'single') {
      return {
        action: 'deny',
        rule: 'forced kill',
        reason:
          `SIGKILL to pid ${parsed.pid ?? '?'} which this session does not own. ` +
          'Graceful stop first (`kill <pid>`), or use `nuvira workspace process stop --port|--pid`.',
      };
    }
    return {
      action: 'deny',
      rule: 'forced mass kill',
      reason:
        'SIGKILL by name or pattern would kill processes this session does not own. ' +
        'Stop the specific pid gracefully, or use `nuvira workspace process stop`.',
    };
  }

  if (parsed.scope === 'mass') {
    return {
      action: 'deny',
      rule: 'mass process kill',
      reason:
        `\`${parsed.tool}\` stops every process matching ${parsed.pattern ?? 'a name'}, including ones this session does not own. ` +
        'Name the pid or the port instead.',
    };
  }

  if (parsed.scope === 'pattern') {
    return {
      action: 'confirm',
      reason: `Stopping processes matching "${parsed.pattern ?? ''}" needs one approval — the session cannot verify it owns all of them.`,
    };
  }

  if (owned) {
    return { action: 'allow', reason: `SIGTERM to owned process ${parsed.pid} (harness child)` };
  }
  return {
    action: 'confirm',
    reason: `SIGTERM to pid ${parsed.pid ?? '?'} which this session does not own — confirm once.`,
  };
}

/** Convenience: parse + decide in one call. Null when the command is not a signal op. */
export function classifySignalCommand(command: string): SignalDecision | null {
  const parsed = parseSignalCommand(command);
  return parsed ? decideSignalCommand(parsed) : null;
}
