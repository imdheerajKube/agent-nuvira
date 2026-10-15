/**
 * A reply too long for the transport — saved as a FILE, not truncated.
 *
 * THE DEFECT. A messaging channel has a hard per-message cap (WhatsApp ~4096,
 * SMS 1600) and the gateway used to cope by slicing the text: `sanitizeOutbound`
 * is a plain `.slice(0, max)`, so the tail of a long answer was destroyed with no
 * notice to anyone — the sender saw a sentence stop mid-word and had no way to
 * know the rest had ever existed. Measured on a real turn: a 5,000-character
 * answer arrived as 4,096 characters and the remainder was simply gone.
 *
 * THE FIX, and why it is not a rewrite of the transport layer: the turn already
 * has a workspace (`config/scratch-workspace.ts` when no project is attached), so
 * the full text has somewhere legitimate to live. The channel carries a HEAD that
 * fits, plus the path — nothing is destroyed, the sender learns where the rest
 * is, and the file is inside the same temporary workspace the reply's own notice
 * already names, so the offer to move it applies to this file too.
 *
 * Deliberately deterministic (`at` is injectable): the file name is a function of
 * the caller's clock, so the caller can honour a per-message timestamp and the
 * test does not have to guess one.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the caller sends: a head that fits, and where the whole thing went. */
export interface SavedOversizedReply {
  /** Absolute path of the file holding the FULL text. */
  path: string;
  /** The part of the reply that fits the channel, with the pointer appended. */
  head: string;
}

/** How much of the channel's budget the head may use, leaving room for the pointer. */
const HEAD_BUDGET_RATIO = 0.85;

/** The filename a reply saved at `at` uses (stable, sortable, filesystem-safe). */
export function oversizedReplyFilename(at: number): string {
  return `reply-${new Date(at).toISOString().replace(/[:.]/g, '-')}.md`;
}

/**
 * Write `content` into `dir` and return the head the channel can carry.
 *
 * `undefined` means the file could NOT be written — the caller must then fall
 * back to the transport's own truncation rather than claiming a path that does
 * not exist. A pointer to a missing file is worse than a short message.
 */
export function saveOversizedReply(
  dir: string,
  content: string,
  cap: number,
  at: number = Date.now(),
): SavedOversizedReply | undefined {
  const path = join(dir, oversizedReplyFilename(at));
  try {
    writeFileSync(path, content, 'utf-8');
  } catch {
    return undefined;
  }
  const pointer = `\n\n…(the full text is ${content.length} characters — saved to ${path})`;
  const budget = Math.max(0, Math.min(cap - pointer.length, Math.floor(cap * HEAD_BUDGET_RATIO)));
  let head = content.slice(0, budget);
  // Cut on a line boundary when there is one, so the head never ends mid-word.
  const lastBreak = head.lastIndexOf('\n');
  if (lastBreak > budget * 0.5) head = head.slice(0, lastBreak);
  return { path, head: `${head.trimEnd()}${pointer}` };
}
