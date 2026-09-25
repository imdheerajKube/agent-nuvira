/**
 * Artifact verification — does the work actually exist?
 *
 * WHY THIS EXISTS (the live NVDA-addon failure):
 * A WhatsApp task asked for an NVDA add-on packaged to
 * /Users/dheeraj/Documents/kuttaaddon/. Over 19 attempts the pipeline never
 * once produced the deliverable, and every attempt was reported as a SUCCESS.
 * The trail, in order:
 *
 *   1. `write_file` was refused — the target is outside the workspace — so the
 *      three planned files were never created.
 *   2. The packaging step ran `zip -r kuttaaddon.nvda-addon manifest.ini
 *      installTasks.py globalPlugins/` against files that did not exist. zip
 *      printed `zip warning: name not matched: …` for every input and still
 *      **exited 0**, emitting a valid 22-byte EMPTY archive.
 *   3. `runResult.success` was derived from the exit code, so the step counted
 *      as done and every task flipped to `completed` (5/5).
 *   4. `deliverableAuthored: false` was written into the same checkpoint
 *      metadata — the truth was recorded next to the false completion and
 *      nothing acted on it.
 *   5. `fileChanges` claimed `installTasks.py` was `created`. It does not exist.
 *      The existing expectedFiles guard accepted that CLAIM as proof, so the one
 *      check that could have caught the lie waived it.
 *
 * The contract this module enforces, in one line: **a step is not done because a
 * command exited 0, and not because the agent said it wrote something — it is
 * done because the artifact is on disk, and is not empty.**
 *
 * Deliberately deterministic and LLM-free: existence, size and archive entry
 * counts are facts. Everything here is best-effort and must never throw — a
 * verification failure reports, it does not crash a pipeline.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * The outcome of checking a set of declared artifacts.
 *
 * `missing` and `empty` are kept apart on purpose: "you never wrote it" and "you
 * wrote an empty one" are different bugs with different repairs, and the live
 * failure was the second one (a 22-byte archive that exists and holds nothing).
 */
export interface ArtifactCheck {
  ok: boolean;
  /** Declared paths that do not exist on disk. */
  missing: string[];
  /** Declared paths that exist but carry no content. */
  empty: string[];
  /** One line naming what is wrong, or undefined when ok. */
  reason?: string;
}

/** Options for {@link verifyArtifacts}. */
export interface VerifyOptions {
  /**
   * Files that are legitimately empty (touch-style markers). The add-on plan
   * itself asked for "an empty installTasks.py", so treating every empty file
   * as a failure would be wrong.
   */
  allowEmpty?: string[];
}

// ─── Archive helpers ────────────────────────────────────────────────────────

/** Zip End Of Central Directory signature — `PK\x05\x06`. */
const ZIP_EOCD_SIGNATURE = 0x06054b50;
/** An EOCD record is 22 bytes; the comment field can push it further back. */
const ZIP_EOCD_MIN_SIZE = 22;
const ZIP_MAX_COMMENT = 0xffff;

/** Extensions whose whole purpose is to be a container of other files. */
const ARCHIVE_EXTENSIONS = ['.zip', '.nvda-addon', '.jar', '.whl', '.vsix', '.epub', '.xpi'];

/** True when the path names a container format rather than a plain file. */
export function isArchivePath(path: string): boolean {
  const lower = path.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * True when `file` is a zip that contains ZERO entries.
 *
 * This is the check that would have caught the live failure: an empty zip is a
 * perfectly valid 22-byte file, so `existsSync` and a size check both pass it.
 * The entry count lives in the End Of Central Directory record at the end of the
 * file (the comment field can be up to 64KiB, so the record is searched from the
 * tail rather than assumed to start at byte 0 of the trailer).
 *
 * Returns false for anything unreadable or not recognisably a zip — an
 * unparseable archive is reported by the caller as unreadable, not as empty.
 */
export function isEmptyArchive(file: string): boolean {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    // Smaller than an EOCD record cannot be a zip at all.
    if (size < ZIP_EOCD_MIN_SIZE) return false;
    const readFrom = Math.max(0, size - ZIP_EOCD_MIN_SIZE - ZIP_MAX_COMMENT);
    const length = size - readFrom;
    const buffer = Buffer.alloc(length);
    fd = openSync(file, 'r');
    readSync(fd, buffer, 0, length, readFrom);
    // Search backwards for the EOCD signature.
    for (let i = buffer.length - ZIP_EOCD_MIN_SIZE; i >= 0; i -= 1) {
      if (buffer.readUInt32LE(i) !== ZIP_EOCD_SIGNATURE) continue;
      // Offset 10 of the EOCD holds "total number of entries in the central
      // directory" as a little-endian uint16.
      return buffer.readUInt16LE(i + 10) === 0;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}

// ─── Artifact verification ──────────────────────────────────────────────────

/** Resolve a declared path against the project root (absolute paths pass through). */
export function resolveArtifact(declared: string, root: string): string {
  return isAbsolute(declared) ? declared : resolve(root, declared);
}

/**
 * Verify that every declared path exists on disk, and that none of them is an
 * empty shell.
 *
 * A declared path is satisfied ONLY by a real file. Callers must not pass in the
 * agent's own report of what it wrote — that is exactly the substitution that
 * let the live failure through, where `fileChanges` said a file had been created
 * and the file did not exist.
 */
export function verifyArtifacts(
  declared: string[],
  root: string,
  options: VerifyOptions = {},
): ArtifactCheck {
  const allowEmpty = new Set((options.allowEmpty ?? []).map((p) => resolveArtifact(p, root)));
  const missing: string[] = [];
  const empty: string[] = [];

  for (const path of declared) {
    if (!path || !path.trim()) continue;
    const abs = resolveArtifact(path, root);
    try {
      if (!existsSync(abs)) {
        missing.push(path);
        continue;
      }
      // A directory satisfies existence; only files can be empty shells.
      const stat = statSync(abs);
      if (stat.isDirectory()) continue;
      if (stat.size === 0 && !allowEmpty.has(abs)) {
        empty.push(path);
        continue;
      }
      // The subtle case: non-zero size, but a container holding nothing.
      if (isArchivePath(abs) && isEmptyArchive(abs)) {
        empty.push(path);
      }
    } catch {
      // Unreadable is not the same as absent — report it as missing so the
      // repair path is the same (re-do the step) rather than silently passing.
      missing.push(path);
    }
  }

  if (missing.length === 0 && empty.length === 0) return { ok: true, missing, empty };

  const parts: string[] = [];
  if (missing.length) parts.push(`not on disk: ${missing.join(', ')}`);
  if (empty.length) parts.push(`produced empty: ${empty.join(', ')}`);
  return { ok: false, missing, empty, reason: parts.join(' | ') };
}

// ─── No-op command detection ────────────────────────────────────────────────

/**
 * Tools whose entire job is to turn inputs into a container. Only these are
 * considered for no-op detection, because "matched nothing" is unambiguously a
 * failure for them.
 */
const PRODUCER_TOOLS = ['zip', '7z', '7za', 'p7zip', 'tar', 'git'];

/**
 * Output signatures that mean an archive/lookup command matched NOTHING while
 * still exiting 0. Kept deliberately short and literal: a broad pattern like
 * `/no such file/` would fail legitimate commands (a `grep` that finds nothing
 * is not a broken build), so each entry here must be unambiguous on its own.
 */
const NO_OP_SIGNATURES: Array<{ pattern: RegExp; what: string }> = [
  // Info-ZIP's warning for an input that did not resolve. This is the exact line
  // the live run produced, once per declared input, next to `exit code 0`.
  { pattern: /zip warning: name not matched/i, what: 'zip matched none of its declared inputs' },
  { pattern: /zip error: nothing to do/i, what: 'zip had nothing to add' },
  { pattern: /nothing to commit|no changes added to commit/i, what: 'git found nothing to commit' },
  { pattern: /nothing to do\b/i, what: 'the command had nothing to do' },
  { pattern: /\b0 files? (?:added|archived|processed|packed)\b/i, what: 'the tool reported 0 files' },
];

/** True when the command line invokes one of the producer tools. */
function invokesProducerTool(command: string): boolean {
  // First word of each shell segment, so `cd x && zip …` is recognised.
  return command
    .split(/\|\||&&|;|\|/)
    .map((segment) => segment.trim().split(/\s+/)[0] ?? '')
    .some((head) => PRODUCER_TOOLS.includes(head.replace(/^.*\//, '')));
}

/**
 * Detect a command that finished successfully in the only sense the shell knows
 * — exit code 0 — while provably doing nothing.
 *
 * Returns a human-readable reason (for the trace, the checkpoint and the user),
 * or null when the command either genuinely ran or is not one we can judge.
 *
 * This exists because `zip` expresses "I matched none of your inputs" as a
 * WARNING and still exits 0. Deriving success from the exit code therefore
 * reports a fabricated deliverable as a finished one.
 */
export function detectNoOpCommand(
  command: string,
  stdout: string,
  stderr: string,
): string | null {
  if (!command) return null;
  if (!invokesProducerTool(command)) return null;
  const output = `${stdout}\n${stderr}`;
  for (const { pattern, what } of NO_OP_SIGNATURES) {
    if (pattern.test(output)) return what;
  }
  return null;
}

/**
 * Read a file's head for diagnostics, bounded. Never throws.
 * Used to show what actually landed when a step's artifact is suspect.
 */
export function peekFile(file: string, maxChars = 200): string {
  try {
    return readFileSync(file, 'utf-8').slice(0, maxChars);
  } catch {
    return '';
  }
}
