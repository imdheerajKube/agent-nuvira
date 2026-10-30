/**
 * The requirement has to be found under the name it was actually written with.
 *
 * Found while validating against the real benchmark trees (2026-10-27): the harness wrote
 * `CHANGE_REQUESTS.md` — plural, several events in one file — and the reader only ever
 * opened `CHANGE_REQUEST.md`. A requirement delivered under a name the loop does not read
 * is indistinguishable from one nobody sent, which is precisely the failure the module
 * exists to end: measured earlier, no agent mentioned the request in two whole rounds.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CHANGE_REQUEST_FILES, readChangeRequest } from '../../src/learning/change-request.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'change-request-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const TEXT = [
  '# Requirement change — Teams replace Projects',
  '',
  '- Users now need TEAMS instead of Projects.',
  '',
].join('\n');

describe('readChangeRequest — both names', () => {
  it('reads the plural file the harness wrote in the measured runs', () => {
    writeFileSync(join(root, 'CHANGE_REQUESTS.md'), TEXT);
    const request = readChangeRequest(root);
    expect(request?.path).toBe('CHANGE_REQUESTS.md');
    expect(request?.title).toContain('Teams replace Projects');
    expect(request?.bullets).toEqual(['Users now need TEAMS instead of Projects.']);
  });

  it('keeps the singular name first, and prefers it when both exist', () => {
    expect(CHANGE_REQUEST_FILES[0]).toBe('CHANGE_REQUEST.md');
    writeFileSync(join(root, 'CHANGE_REQUEST.md'), '# A\n\n- one\n');
    writeFileSync(join(root, 'CHANGE_REQUESTS.md'), TEXT);
    expect(readChangeRequest(root)?.path).toBe('CHANGE_REQUEST.md');
  });

  it('returns null when neither exists', () => {
    expect(readChangeRequest(root)).toBeNull();
  });
});
