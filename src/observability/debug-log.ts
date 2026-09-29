/**
 * WS2 (#24) — the session debug log you attach to a bug report.
 *
 * WHY THIS EXISTS, and what it is NOT. This repository's bug reports keep
 * arriving as prose: "the dashboard did not answer", "the gateway sent the
 * wrong thing", "it worked yesterday". Every one of them is then re-litigated
 * by reading code, because the failing run left nothing behind that records
 * WHICH BACKEND SERVED IT. The trace store (`learning/reasoning-trace.ts`) is
 * the audit of what the MODEL was asked; the DAG bridge and the gateway log are
 * per-surface records. None of them is the thing a user can attach to a bug
 * report, and none of them is reachable the same way from all five surfaces.
 *
 * So a session debug log is deliberately boring: a plain-text file, ordered,
 * with a header that names the surface and THE BACKEND — provider, model,
 * transport, engine — before a single line of detail. If a bug report can only
 * carry one thing, that header is the thing that makes it actionable.
 *
 * FOUR RULES, each closing a way a debug log becomes worse than none:
 *
 *  1. OPT-IN, AND CHEAP WHEN OFF. `NUVIRA_DEBUG_LOG=1` turns it on; with it off
 *     `sessionDebugLog()` returns `null` and every call site's `?.` makes the
 *     cost one boolean check. A logging path that is on by default is a disk
 *     leak and a privacy hazard wearing a helpful face.
 *
 *  2. REDACTED BY CONSTRUCTION. A log we ask a user to attach to a bug report
 *     is a log that will be pasted into an issue tracker. Every event line is
 *     scrubbed with the SAME `scrubSecrets` the gateway log uses (reused, not
 *     re-implemented: two regex lists drift, and the one that drifts is the one
 *     that leaks). The header carries the backend and versions — never a key.
 *
 *  3. BOUNDED. Events are capped, each line is truncated to a preview, and the
 *     file is capped by bytes. An instrument must never be the reason a run
 *     dies, and a nightly-failing turn must not fill a disk.
 *
 *  4. WRITTEN ONCE, AT CLOSE. The header has to name the backend that served
 *     the turn, and the backend is only known at the end (the loop may fail
 *     over between providers). So events buffer in memory and `write()`
 *     produces the whole file — header first — at the end of the turn. That
 *     also means a crashed process leaves NO half-written log, which is the
 *     honest outcome: a log whose header lies about the backend is worse than
 *     no log.
 *
 * The five surfaces each open one at their own turn seam (`cli/chat.ts`,
 * `cli/loop-executor.ts`, `tools/child-agent-runtime.ts`, with the dashboard
 * console and the gateway passing their identity down to the shared chat
 * engine), and the parity harness reads the file back and asserts every
 * surface's header names the SAME backend — the capability
 * `debug-log@<surface>` is proved against.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveNuviraDataPath } from '../config/paths.js';
import { scrubSecrets } from '../gateway/gateway-log.js';

/** The env var that turns session debug logging on (`NUVIRA_DEBUG_LOG=1`). */
export const DEBUG_LOG_ENV = 'DEBUG_LOG';
/** Optional directory override for the log files (`NUVIRA_DEBUG_LOG_DIR`). */
export const DEBUG_LOG_DIR_ENV = 'DEBUG_LOG_DIR';
/** Hard cap on the written file. Bounded on purpose — see rule 3 above. */
export const DEBUG_LOG_MAX_BYTES = 512 * 1024;
/** Per-line detail preview cap. Never the whole payload. */
export const DEBUG_LOG_PREVIEW_CHARS = 300;
/** Event cap. Beyond it the OLDEST events are dropped, and the count is stated. */
export const DEBUG_LOG_MAX_EVENTS = 2_000;

/** The backend that served a turn — the fact the header exists to carry. */
export interface DebugLogBackend {
  provider?: string | null;
  model?: string | null;
  /** Tool transport: `native` / `json` / `none`. */
  transport?: string | null;
  /** The engine label the surface ran under (`loop` / `pipeline`). */
  engine?: string | null;
}

/**
 * The parsed header. Every field is present (null when the surface never
 * learned it), so a reader can tell "not reported" apart from "reading failed".
 */
export interface DebugLogHeader {
  surface: string | null;
  engine: string | null;
  provider: string | null;
  model: string | null;
  transport: string | null;
  /** The agent-nuvira version that wrote the log. */
  version: string | null;
  startedAt: number | null;
  /** The writing process — a forked subagent has its own, and that matters. */
  pid: number | null;
  platform: string | null;
}

/** One log file on disk, with its parsed header when it could be read. */
export interface DebugLogFile {
  path: string;
  /** Null when the file is unreadable or its header is malformed. */
  header: DebugLogHeader | null;
}

/** Omit a value from the header rather than writing `undefined`/`null` as a lie. */
function orNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Read the running version from the repo's `package.json`.
 *
 * Best-effort and cached: a debug log must never break a turn over a missing
 * file (the published `dist/` layout resolves `../../package.json` the same way
 * `cli-program.ts` already does), and a wrong-but-absent version is honest
 * where a thrown error is not.
 */
let cachedVersion: string | null | undefined;
function agentVersion(): string | null {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { version?: unknown };
    cachedVersion = orNull(pkg.version);
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}

/**
 * Is session debug logging on?
 *
 * `NUVIRA_DEBUG_LOG` (or legacy `BUFF_DEBUG_LOG`) set to anything other than
 * `0` / `false` / `off` enables it. Deliberately not "truthy string" only: a
 * user who writes `NUVIRA_DEBUG_LOG=false` in an `.env` means off.
 */
export function debugLoggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.NUVIRA_DEBUG_LOG ?? env.BUFF_DEBUG_LOG;
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false' && value !== 'off' && value !== 'no';
}

/**
 * Where the log files live.
 *
 * `NUVIRA_DEBUG_LOG_DIR` wins when set; otherwise `<config dir>/debug-logs`
 * through `resolveNuviraDataPath`, so an isolated profile (tests, CI, the
 * parity harness) can never write into the developer's real `~/.nuvira`.
 */
export function debugLogDir(env: NodeJS.ProcessEnv = process.env): string {
  // Dual-read (NUVIRA_ then legacy BUFF_), matching every other path resolver.
  // Dual-read (NUVIRA_ then legacy BUFF_), matching every other path resolver. A
  // BLANK value counts as unset rather than as `''` — `||` not `??` — so an
  // empty `NUVIRA_DEBUG_LOG_DIR` still lets a legacy override through.
  const override = env[`NUVIRA_${DEBUG_LOG_DIR_ENV}`]?.trim() || env[`BUFF_${DEBUG_LOG_DIR_ENV}`]?.trim();
  if (override) return override;
  // `<config dir>/debug-logs` — so an isolated profile never writes into the
  // developer's real `~/.nuvira`.
  return resolveNuviraDataPath('debug-logs');
}

/** A filename-safe surface label (`cli-chat` → `cli-chat`; odd input → dashes). */
function safeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

/** One ordered event line, as it will read in the file. */
interface DebugLogEntry {
  at: number;
  name: string;
  detail?: string;
}

/**
 * One session's debug log, buffered and written once.
 *
 * Deliberately a class rather than a bag of functions: the buffered state IS
 * the object, and a surface that opens one and forgets to write it produces no
 * file at all — which the parity harness reads as `written: false` rather than
 * as agreement.
 */
export class SessionDebugLog {
  readonly id: string;
  readonly startedAt: number;
  private readonly surface: string;
  private readonly goal: string | null;
  private backend: DebugLogBackend;
  private readonly extra: Array<[string, string]> = [];
  private readonly entries: DebugLogEntry[] = [];
  private dropped = 0;
  private truncatedLines = 0;
  private readonly dir: string | null;
  private readonly now: () => number;
  private writtenPath: string | null = null;

  constructor(opts: { surface: string; goal?: string; backend?: DebugLogBackend; dir?: string | null; now?: () => number }) {
    this.surface = safeLabel(opts.surface);
    this.goal = orNull(opts.goal) ? scrubSecrets(cap(String(opts.goal), DEBUG_LOG_PREVIEW_CHARS)) : null;
    this.backend = { ...(opts.backend ?? {}) };
    this.now = opts.now ?? (() => Date.now());
    this.startedAt = this.now();
    this.dir = opts.dir === undefined ? debugLogDir() : opts.dir;
    this.id = `${this.surface}-${this.startedAt}`;
  }

  /** The backend that served the turn. Set as it is learned; last call wins. */
  backendOf(backend: DebugLogBackend): this {
    this.backend = { ...this.backend, ...backend };
    return this;
  }

  /**
   * Preview one detail value: flattened, cut to the cap, then redacted.
   *
   * The cut is counted BEFORE the scrub (the scrub only shortens), so the
   * "truncated" line in the file reports how much was actually lost.
   */
  private detailText(value: unknown): string {
    const flat = previewOf(value);
    const capped = cap(flat, DEBUG_LOG_PREVIEW_CHARS);
    if (capped.length < flat.length) this.truncatedLines += 1;
    return scrubSecrets(capped);
  }

  /** One ordered event. `detail` is previewed and redacted. */
  event(name: string, detail?: unknown): this {
    const rendered = detail === undefined ? undefined : this.detailText(detail);
    this.entries.push({
      at: this.now(),
      name: scrubSecrets(name),
      ...(rendered ? { detail: rendered } : {}),
    });
    if (this.entries.length > DEBUG_LOG_MAX_EVENTS) {
      // Drop the OLDEST: the most recent events are the ones a failure report
      // reads, exactly like the trace store's tail-keeping caps.
      this.entries.shift();
      this.dropped += 1;
    }
    return this;
  }

  /** A non-secret header field (a version, a channel, a bound). */
  detail(key: string, value: unknown): this {
    if (value === undefined || value === null || value === '') return this;
    this.extra.push([scrubSecrets(key), this.detailText(value)]);
    return this;
  }

  /** The attachable text: header first, then the events in order. */
  render(): string {
    const b = this.backend;
    const lines: string[] = [
      '# nuvira session debug log — safe to attach to a bug report',
      '# credentials are redacted; memory and prompts are previews, not payloads',
      `# surface: ${this.surface}`,
      `# engine: ${orNull(b.engine) ?? 'unknown'}`,
      `# backend.provider: ${orNull(b.provider) ?? 'unknown'}`,
      `# backend.model: ${orNull(b.model) ?? 'unknown'}`,
      `# backend.transport: ${orNull(b.transport) ?? 'unknown'}`,
      `# version: ${agentVersion() ?? 'unknown'}`,
      `# started: ${new Date(this.startedAt).toISOString()}`,
      `# pid: ${process.pid}`,
      `# platform: ${process.platform} ${process.arch} · node ${process.version}`,
      `# events: ${this.entries.length}${this.dropped > 0 ? ` (+${this.dropped} older dropped)` : ''}`,
      ...(this.truncatedLines > 0 ? [`# truncated: ${this.truncatedLines} event(s) were longer than ${DEBUG_LOG_PREVIEW_CHARS} chars`] : []),
      ...(this.goal ? [`# goal: ${JSON.stringify(this.goal)}`] : []),
      ...this.extra.map(([key, value]) => `# ${key}: ${value}`),
      '# ' + '-'.repeat(58),
    ];
    for (const entry of this.entries) {
      lines.push(`${new Date(entry.at).toISOString()} ${entry.name}${entry.detail ? ` ${entry.detail}` : ''}`);
    }
    return `${lines.join('\n')}\n`;
  }

  /**
   * Write the file. Returns the path, or null when logging is disabled, no
   * directory was resolved, or the write failed — every one of which is a
   * normal outcome a caller must not have to handle.
   */
  write(): string | null {
    if (!this.dir) return null;
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      const path = join(this.dir, `${this.id}.log`);
      writeFileSync(path, cap(this.render(), DEBUG_LOG_MAX_BYTES), 'utf-8');
      this.writtenPath = path;
      return path;
    } catch {
      // Best-effort: a debug log must never break the run it observes.
      return null;
    }
  }

  /** The path after a successful `write()` (null before it / on failure). */
  path(): string | null {
    return this.writtenPath;
  }
}

/**
 * Open a session debug log, or `null` when logging is off (or in a unit test
 * that passed no directory). Callers use `?.` throughout, so the off path costs
 * one boolean.
 */
export function sessionDebugLog(opts: {
  surface: string;
  goal?: string;
  backend?: DebugLogBackend;
  /** Explicit directory (tests / a harness that isolates the profile). */
  dir?: string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): SessionDebugLog | null {
  const env = opts.env ?? process.env;
  if (!debugLoggingEnabled(env)) return null;
  return new SessionDebugLog({
    surface: opts.surface,
    ...(opts.goal !== undefined ? { goal: opts.goal } : {}),
    ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
    dir: opts.dir === undefined ? debugLogDir(env) : opts.dir,
    ...(opts.now ? { now: opts.now } : {}),
  });
}

/** Cut a string to `max` chars, marking the cut so a reader knows it happened. */
function cap(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Render any detail value to one flat, bounded line. */
function previewOf(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (Array.isArray(value)) return value.map((v) => previewOf(v)).join(', ');
  try {
    return JSON.stringify(value, replacerForPreview) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Bounded JSON: long strings are cut before serialising, so one huge arg cannot blow the line. */
function replacerForPreview(_key: string, value: unknown): unknown {
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 119)}…` : value;
  return value;
}

/**
 * Parse a rendered log's header.
 *
 * Reads the leading `# key: value` comment block only, and returns null when
 * `surface` is absent — the one field every header must have. Unknown keys are
 * ignored rather than rejected, so an older reader can still open a newer log.
 */
export function parseDebugLogHeader(text: string): DebugLogHeader | null {
  const header: DebugLogHeader = {
    surface: null,
    engine: null,
    provider: null,
    model: null,
    transport: null,
    version: null,
    startedAt: null,
    pid: null,
    platform: null,
  };
  for (const line of text.split('\n')) {
    if (!line.startsWith('#')) break;
    const match = /^#\s+(?:backend\.)?([a-z_]+):\s*(.*)$/i.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    const trimmed = value.trim();
    switch (key.toLowerCase()) {
      case 'surface': header.surface = trimmed || null; break;
      case 'engine': header.engine = namedOrNull(trimmed); break;
      case 'provider': header.provider = namedOrNull(trimmed); break;
      case 'model': header.model = namedOrNull(trimmed); break;
      case 'transport': header.transport = namedOrNull(trimmed); break;
      case 'version': header.version = namedOrNull(trimmed); break;
      case 'pid': header.pid = Number.isFinite(Number(trimmed)) ? Number(trimmed) : null; break;
      case 'platform': header.platform = orNull(trimmed); break;
      case 'started': {
        const at = Date.parse(trimmed);
        header.startedAt = Number.isFinite(at) ? at : null;
        break;
      }
      default: break;
    }
  }
  return header.surface ? header : null;
}

/**
 * A named header value, or null.
 *
 * `render()` writes the literal `unknown` when a surface never learned a field.
 * That is the right thing to READ in the file and the wrong thing to COMPARE:
 * "two surfaces both said unknown" must not read as agreement about a backend,
 * so the parser maps the sentinel back to null and the comparison sees "not
 * named" for what it is.
 */
function namedOrNull(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') return null;
  return trimmed;
}

/** Every log file in `dir`, newest first. Missing directory = empty list. */
export function listDebugLogs(dir: string = debugLogDir()): DebugLogFile[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.log'))
      .map((name) => {
        const path = join(dir, name);
        return { path, header: parseDebugLogHeader(readFileSafe(path) ?? ''), at: statSafe(path) };
      })
      .sort((a, b) => b.at - a.at)
      .map(({ path, header }) => ({ path, header }));
  } catch {
    return [];
  }
}

/**
 * The newest log a given surface wrote, or null.
 *
 * This is how the parity harness reads a surface's OWN durable artifact — the
 * same reasoning the gateway driver uses to read `inbound.chat` from the
 * gateway log rather than trusting a return value.
 */
export function readLatestDebugLog(
  surface: string,
  dir: string = debugLogDir(),
): { path: string; header: DebugLogHeader; text: string } | null {
  const want = safeLabel(surface);
  for (const file of listDebugLogs(dir)) {
    if (file.header?.surface !== want) continue;
    const text = readFileSafe(file.path);
    if (text) return { path: file.path, header: file.header, text };
  }
  return null;
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function statSafe(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * A one-line notice a surface can print so the user knows a log exists to
 * attach. Kept here so all five surfaces word it identically.
 */
export function debugLogNotice(surface: string, path: string | null): string | null {
  if (!path) return null;
  return `🐞 ${surface}: session debug log written to ${path} — attach it to a bug report.`;
}
