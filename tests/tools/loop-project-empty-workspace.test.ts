/**
 * An EMPTY workspace is a fact the prompt owes the model.
 *
 * Measured 2026-10-30 (GREENFIELD-API, the head-to-head): a greenfield build was
 * told nothing about its project — `looksLikeProject` was false for an empty
 * directory, so the whole `[Project context]` block was omitted — and the model
 * spent its first steps `read_file`/`glob`/`list_dir` discovering that there was
 * nothing there. Two of 31 steps went to a fact the loop already knew.
 *
 * The line must not appear for a directory that merely lacks project markers: a
 * home directory with unrelated files is not empty, and telling the model "create
 * what the request asks for" there would be wrong.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildLoopProjectContext } from '../../src/tools/loop-project-context.js';

let workspace = '';

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'nuvira-lpc-empty-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('buildLoopProjectContext — the empty workspace', () => {
  it('says the workspace is empty, and that there is nothing to explore', async () => {
    const block = await buildLoopProjectContext(workspace);
    expect(block).toContain('## Project');
    expect(block).toContain('empty/greenfield');
    expect(block).toMatch(/nothing here to read/i);
  });

  it('still says it when the only thing present is a .git directory', async () => {
    // The harness `git init`s a fresh workspace, so "empty" must ignore it.
    mkdirSync(join(workspace, '.git'));
    const block = await buildLoopProjectContext(workspace);
    expect(block).toContain('empty/greenfield');
  });

  it('stays silent for a directory that has files but no project markers', async () => {
    // Not empty — the model may genuinely want to look. Silence, as before.
    writeFileSync(join(workspace, 'notes.txt'), 'something unrelated\n');
    const block = await buildLoopProjectContext(workspace);
    expect(block).not.toContain('empty/greenfield');
    expect(block).toBe('');
  });

  it('describes a real project instead of telling the model not to look', async () => {
    // `isGreenfield` in the assessment means "no source yet", which a bare
    // package.json still is — so the assertion is about MY line, not that flag.
    writeFileSync(join(workspace, 'package.json'), '{"name":"probe"}\n');
    const block = await buildLoopProjectContext(workspace);
    expect(block).toContain('## Project');
    expect(block).toMatch(/package\.json/);
    expect(block).not.toMatch(/nothing here to read/i);
  });
});
