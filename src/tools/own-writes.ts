/**
 * The files THIS RUN wrote — and whether they still hold exactly those bytes.
 *
 * WHY THIS EXISTS (measured, trace-1793853385112-sf2exl, 2026-11-05). An
 * assessment turn created `AUDIT_CROSSCHECK.md` (§1, 2,189 chars) and then could
 * not add §2: the next `write_file` to that same path came back
 * `state-changing — NOT applied` because the path now existed, and the prompt
 * forbids asking permission for work the request already ordered. The report on
 * disk stopped at one section. A whole deliverable, lost to a gate that was
 * asking about the wrong thing.
 *
 * The gate's rule is right about USER data: a re-run cannot recover an overwrite
 * of content somebody else authored, so a human decides. It was wrong about the
 * agent's OWN output — those bytes are in this run's transcript, written minutes
 * ago by this very process.
 *
 * The digest is what keeps the permission NARROW. If the file no longer holds
 * exactly what this run wrote, someone edited it afterwards, the two cases
 * diverge, and the original gate applies again unchanged. So "recoverable" is a
 * property of the FILE as it stands, not an assumption about the tool call.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { ToolContext } from './registry.js';

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Record that this run wrote `content` to `abs`.
 *
 * `null` means the caller could not determine the final bytes (an append whose
 * read-back failed) — then nothing is recorded, and the file keeps the stricter
 * treatment. A missed record only costs a confirmation; a WRONG one would claim
 * a file the run never wrote.
 */
export function rememberOwnWrite(ctx: ToolContext, abs: string, content: string | null): void {
  if (content === null) return;
  const store = ctx.ownWrites ?? (ctx.ownWrites = new Map<string, string>());
  store.set(abs, digest(content));
}

/** Has this run written `abs` at all? */
export function wroteThisRun(ctx: ToolContext, abs: string): boolean {
  return ctx.ownWrites?.has(abs) === true;
}

/**
 * Does `abs` still hold exactly what this run wrote, given its current content?
 *
 * Needs no I/O because the callers that ask have already read the file — the
 * edit path has the content in hand and compares it there.
 */
export function isOwnContent(ctx: ToolContext, abs: string, content: string): boolean {
  const expected = ctx.ownWrites?.get(abs);
  return expected !== undefined && expected === digest(content);
}

/**
 * The same question for a call that has NOT read the file (a create-or-replace
 * write). Unreadable or vanished content answers `false`: "I cannot see it" is
 * not evidence that replacing it is safe.
 */
export async function isOwnUnchangedWrite(ctx: ToolContext, abs: string): Promise<boolean> {
  if (!ctx.ownWrites?.has(abs)) return false;
  try {
    return isOwnContent(ctx, abs, await readFile(abs, 'utf-8'));
  } catch {
    return false;
  }
}
