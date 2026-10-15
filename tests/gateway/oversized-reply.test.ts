/**
 * The size half of the messaging rule: a reply the channel cannot carry is
 * SAVED, not sliced.
 *
 * Before this, `sanitizeOutbound` was a plain `.slice(0, cap)` — the tail of a
 * long answer was destroyed with no notice to anyone, and the sender saw the text
 * stop mid-word. These tests pin the properties that make the replacement safe:
 * the FULL text is on disk, the head the channel carries FITS the cap, the head
 * never ends mid-word when it can avoid it, and a failed write returns nothing
 * (so the caller truncates rather than pointing at a file that does not exist).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { oversizedReplyFilename, saveOversizedReply } from '../../src/gateway/oversized-reply.js';

let dir: string;
const AT = Date.UTC(2026, 9, 15, 10, 53, 49);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'buff-oversized-reply-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A reply of roughly WhatsApp length, with clean line breaks throughout. */
function longReply(lines = 400): string {
  return Array.from({ length: lines }, (_, i) => `Line ${i + 1}: a paragraph of the long answer.`).join('\n');
}

describe('saveOversizedReply', () => {
  it('writes the FULL text and returns a head that fits the cap', () => {
    const content = longReply();
    const cap = 4096;
    const saved = saveOversizedReply(dir, content, cap, AT);

    expect(saved).toBeTruthy();
    const { path, head } = saved!;
    // Byte-for-byte recovery of what was delivered.
    expect(readFileSync(path, 'utf-8')).toBe(content);
    // The head is what the channel sends: it must fit, pointer included.
    expect(head.length).toBeLessThanOrEqual(cap);
    expect(head).toContain(path);
    expect(head).toMatch(/the full text is \d+ characters/);
    // The head is a genuine PREFIX of the answer, not a rewrite.
    const firstLine = content.split('\n')[0];
    expect(head.startsWith(firstLine)).toBe(true);
  });

  it('cuts on a line boundary rather than mid-word', () => {
    const content = longReply();
    const saved = saveOversizedReply(dir, content, 500, AT)!;
    const body = saved.head.split('\n\n…(the full text')[0];
    expect(content.startsWith(body)).toBe(true);
    // Ends at a complete line: the next character in the source is a newline.
    expect(content[body.length]).toBe('\n');
  });

  it('names the file from the clock it was given (stable + sortable)', () => {
    expect(oversizedReplyFilename(AT)).toBe('reply-2026-10-15T10-53-49-000Z.md');
    const saved = saveOversizedReply(dir, longReply(), 4096, AT)!;
    expect(saved.path).toBe(join(dir, oversizedReplyFilename(AT)));
  });

  it('returns undefined when the file cannot be written — never a pointer to nothing', () => {
    const missing = join(dir, 'no-such-dir', 'deeper');
    expect(saveOversizedReply(missing, longReply(), 4096, AT)).toBeUndefined();
    expect(existsSync(missing)).toBe(false);
  });
});
