/**
 * Configurable size limits + the no-write instruction.
 *
 * Two live failures drive this suite:
 *   1. `read_extract` capped at 40,000 chars and reported truncation only in
 *      metadata, so a model read half a 66,021-char lab report and assessed it as
 *      if complete. The cap is now configurable AND the truncation travels in the
 *      returned text.
 *   2. A request that said "do NOT write, create, or modify any files … answer in
 *      chat" was still read as an authored-artifact ask, and the pipeline wrote a
 *      file against the instruction. A negative instruction must outrank it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_ATTACHMENT_MAX_BYTES,
  DEFAULT_EXTRACT_MAX_CHARS,
  resolveAttachmentMaxBytes,
  resolveExtractMaxChars,
} from '../../src/config/limits.js';
import { getReadExtractManager } from '../../src/tools/read-extract.js';
import { requestForbidsWrites } from '../../src/learning/autonomy-policy.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'limits-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.NUVIRA_EXTRACT_MAX_CHARS;
  delete process.env.NUVIRA_ATTACHMENT_MAX_BYTES;
});

describe('resolveExtractMaxChars', () => {
  it('defaults to 40,000 characters', () => {
    expect(resolveExtractMaxChars()).toBe(DEFAULT_EXTRACT_MAX_CHARS);
  });

  it('reads NUVIRA_EXTRACT_MAX_CHARS, and the BUFF_ alias', () => {
    process.env.NUVIRA_EXTRACT_MAX_CHARS = '120000';
    expect(resolveExtractMaxChars()).toBe(120_000);
    delete process.env.NUVIRA_EXTRACT_MAX_CHARS;
    process.env.BUFF_EXTRACT_MAX_CHARS = '50000';
    expect(resolveExtractMaxChars()).toBe(50_000);
    delete process.env.BUFF_EXTRACT_MAX_CHARS;
  });

  it('falls back to the default on a malformed value rather than throwing', () => {
    for (const bad of ['abc', '-5', '0', '1.5', '']) {
      process.env.NUVIRA_EXTRACT_MAX_CHARS = bad;
      expect(resolveExtractMaxChars(), bad).toBe(DEFAULT_EXTRACT_MAX_CHARS);
    }
  });

  it('clamps a value above the ceiling', () => {
    process.env.NUVIRA_EXTRACT_MAX_CHARS = '999999999999';
    expect(resolveExtractMaxChars()).toBe(8_000_000);
  });
});

describe('resolveAttachmentMaxBytes', () => {
  it('defaults to 300,000 bytes', () => {
    expect(resolveAttachmentMaxBytes()).toBe(DEFAULT_ATTACHMENT_MAX_BYTES);
  });

  it('reads NUVIRA_ATTACHMENT_MAX_BYTES', () => {
    process.env.NUVIRA_ATTACHMENT_MAX_BYTES = '5242880';
    expect(resolveAttachmentMaxBytes()).toBe(5_242_880);
  });
});

describe('read_extract honours the configured cap and states truncation in the TEXT', () => {
  it('returns the whole file when it fits', async () => {
    const root = tmp();
    const file = join(root, 'small.txt');
    writeFileSync(file, 'hello world');
    const r = await getReadExtractManager().extract(file);
    expect(r.success).toBe(true);
    expect(r.text).toBe('hello world');
    expect(r.metadata?.truncated).toBe(false);
  });

  it('truncates at the cap and puts a loud notice IN the text, not only in metadata', async () => {
    process.env.NUVIRA_EXTRACT_MAX_CHARS = '100';
    const root = tmp();
    const file = join(root, 'big.txt');
    writeFileSync(file, 'x'.repeat(5_000));
    const r = await getReadExtractManager().extract(file);

    expect(r.success).toBe(true);
    expect(r.metadata?.truncated).toBe(true);
    // The model reads the TEXT. The fact must be there.
    expect(r.text).toContain('TRUNCATED');
    expect(r.text).toContain('100');
    expect(r.text).toContain('NUVIRA_EXTRACT_MAX_CHARS');
    // The body is capped at the configured budget (the notice is appended after).
    expect(r.text.startsWith('x'.repeat(100))).toBe(true);
  });

  it('a raised cap reads a file the default would have cut', async () => {
    const root = tmp();
    const file = join(root, 'mid.txt');
    const body = 'y'.repeat(50_000);
    writeFileSync(file, body);

    const atDefault = await getReadExtractManager().extract(file);
    expect(atDefault.metadata?.truncated).toBe(true);

    process.env.NUVIRA_EXTRACT_MAX_CHARS = '100000';
    const raised = await getReadExtractManager().extract(file);
    expect(raised.metadata?.truncated).toBe(false);
    expect(raised.text).toBe(body);
  });
});

describe('requestForbidsWrites', () => {
  it('detects the live instruction that was ignored', () => {
    expect(
      requestForbidsWrites(
        'read this report. do NOT write, create, or modify any files, and do NOT run any commands. Just answer in chat.',
      ),
    ).toBe(true);
  });

  it('detects other phrasings', () => {
    for (const ask of [
      "don't write any files, just tell me",
      'explain it here without creating anything',
      'reply in chat, do not save',
      'this is read-only',
      'no new files please',
      'never modify the project',
    ]) {
      expect(requestForbidsWrites(ask), ask).toBe(true);
    }
  });

  it('does NOT fire on an ordinary authored ask', () => {
    for (const ask of [
      'write a 12 page story to /tmp/story.md',
      'create a report about the API',
      'generate a summary document',
    ]) {
      expect(requestForbidsWrites(ask), ask).toBe(false);
    }
  });
});
