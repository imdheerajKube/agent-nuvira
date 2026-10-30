/**
 * `nuvira checkpoint` — the surface a person uses to undo a batch of edits.
 *
 * The safety property is the point of most of these tests: `--clean` deletes
 * files, so it must be impossible to trigger by a typo — and a refused restore
 * must leave the tree exactly as it was, not half-restored.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

import { CheckpointCommand } from '../../src/cli/checkpoint.js';

let storeDir: string;
let project: string;
const ORIGINAL_STORE = process.env.NUVIRA_CHECKPOINT_DIR;
const ORIGINAL_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), 'ckpt-cli-store-'));
  project = mkdtempSync(join(tmpdir(), 'ckpt-cli-proj-'));
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'app.ts'), 'export const a = 1;\n');
  writeFileSync(join(project, 'README.md'), '# project\n');
  process.env.NUVIRA_CHECKPOINT_DIR = storeDir;
  // The command touches the project-state helpers, which persist under the memory
  // dir; point them at a temp dir so a real profile is never read.
  process.env.NUVIRA_MEMORY_DIR = mkdtempSync(join(tmpdir(), 'ckpt-cli-mem-'));
});

afterEach(() => {
  if (ORIGINAL_STORE === undefined) delete process.env.NUVIRA_CHECKPOINT_DIR;
  else process.env.NUVIRA_CHECKPOINT_DIR = ORIGINAL_STORE;
  if (ORIGINAL_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIGINAL_MEMORY_DIR;
  rmSync(storeDir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  process.exitCode = undefined;
});

/**
 * Run the command the way the CLI does, and return everything it printed.
 *
 * The ROOT program is part of the fixture on purpose: it declares `-d, --debug`
 * and does not enable positional options, so it parses `--dir` before the
 * subcommand sees it. Parsing the checkpoint command in isolation hid exactly
 * that — the built CLI then ignored `--dir` and checkpointed the repository the
 * test was launched from. A test that does not reproduce the real parse order
 * cannot see the bug it exists for.
 *
 * Both streams are captured: `logger.info`/`logger.highlight` write to stdout and
 * `logger.error` to stderr, and a test that watched only stdout would read a
 * refusal as silence.
 */
async function run(args: string[]): Promise<string> {
  const lines: string[] = [];
  const capture = (...a: unknown[]): void => {
    lines.push(a.map((x) => String(x)).join(' '));
  };
  const out = vi.spyOn(console, 'log').mockImplementation(capture);
  const err = vi.spyOn(console, 'error').mockImplementation(capture);
  try {
    const root = new Command();
    root.option('-d, --debug').option('-t, --task <text>');
    root.addCommand(new CheckpointCommand().create());
    await root.parseAsync(['node', 'nuvira', 'checkpoint', ...args]);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return lines.join('\n');
}

const idFrom = (output: string): string => /checkpoint (\S+)/.exec(output)?.[1] ?? '';

describe('nuvira checkpoint', () => {
  it('creates, lists and shows a checkpoint', async () => {
    const created = await run(['create', 'before refactor', '--dir', project]);
    const id = idFrom(created);
    expect(id).toMatch(/^[a-z0-9]+-[a-z0-9]{6}$/);
    expect(created).toContain('before refactor');
    expect(created).toContain('2 entry(s)');
    // The regression: `--dir` reached the command through the ROOT program, so a
    // checkpoint of the project must be a checkpoint of the PROJECT, not of the
    // directory the test ran in.
    expect(created).toContain(project);
    expect(created).not.toContain(process.cwd());

    const listed = await run(['list', '--dir', project]);
    expect(listed).toContain(id);
    expect(listed).toContain('before refactor');

    const shown = await run(['show', id, '--dir', project]);
    expect(shown).toContain('before refactor');
    expect(shown).toContain(project);
  });

  it('lists this project\u2019s checkpoints when no subcommand is given', async () => {
    const id = idFrom(await run(['create', '--dir', project]));
    const output = await run(['--dir', project]);
    expect(output).toContain(id);
    expect(output).toContain('restore with');
  });

  it('restores a batch of edits', async () => {
    const id = idFrom(await run(['create', '--dir', project]));
    writeFileSync(join(project, 'src', 'app.ts'), 'broken\n');
    writeFileSync(join(project, 'src', 'extra.ts'), 'junk\n');

    const output = await run(['restore', id, '--dir', project]);
    expect(output).toContain('restored 2 file(s)');
    expect(readFileSync(join(project, 'src', 'app.ts'), 'utf-8')).toBe('export const a = 1;\n');
    // Left in place, and said so.
    expect(existsSync(join(project, 'src', 'extra.ts'))).toBe(true);
    expect(output).toContain('--clean --yes');
  });

  it('refuses --clean without --yes and leaves the tree untouched', async () => {
    const id = idFrom(await run(['create', '--dir', project]));
    writeFileSync(join(project, 'src', 'app.ts'), 'broken\n');
    writeFileSync(join(project, 'src', 'extra.ts'), 'junk\n');

    const output = await run(['restore', id, '--dir', project, '--clean']);
    expect(output).toContain('--clean --yes');
    expect(process.exitCode).toBe(1);
    // Nothing was restored and nothing was deleted: the refusal is total.
    expect(readFileSync(join(project, 'src', 'app.ts'), 'utf-8')).toBe('broken\n');
    expect(existsSync(join(project, 'src', 'extra.ts'))).toBe(true);
  });

  it('deletes files created after the checkpoint with --clean --yes', async () => {
    const id = idFrom(await run(['create', '--dir', project]));
    writeFileSync(join(project, 'src', 'extra.ts'), 'junk\n');

    const output = await run(['restore', id, '--dir', project, '--clean', '--yes']);
    expect(output).toContain('removed 1 file(s)');
    expect(existsSync(join(project, 'src', 'extra.ts'))).toBe(false);
  });

  it('--dry-run reports without writing', async () => {
    const id = idFrom(await run(['create', '--dir', project]));
    writeFileSync(join(project, 'src', 'app.ts'), 'broken\n');

    const output = await run(['restore', id, '--dir', project, '--dry-run']);
    expect(output).toContain('would restore 2 file(s)');
    expect(readFileSync(join(project, 'src', 'app.ts'), 'utf-8')).toBe('broken\n');
  });

  it('reports a missing checkpoint as an error, not a crash', async () => {
    const output = await run(['restore', 'does-not-exist', '--dir', project]);
    expect(output).toContain('checkpoint not found');
    expect(process.exitCode).toBe(1);
  });

  it('deletes a checkpoint on request', async () => {
    const id = idFrom(await run(['create', '--dir', project]));
    const output = await run(['delete', id]);
    expect(output).toContain('deleted checkpoint');
    expect(await run(['list', '--dir', project])).toContain('no checkpoints');
  });

  it('prunes old checkpoints', async () => {
    for (let i = 0; i < 3; i += 1) await run(['create', `point ${i}`, '--dir', project]);
    const output = await run(['prune', '--keep', '1']);
    expect(output).toContain('pruned 2 checkpoint(s)');
    expect(await run(['list', '--dir', project, '--json'])).toContain('point 2');
  });

  it('--json prints the same facts for a script', async () => {
    const id = idFrom(await run(['create', '--dir', project]));
    const json = JSON.parse(await run(['show', id, '--json'])) as { id: string; totals: { files: number } };
    expect(json.id).toBe(id);
    expect(json.totals.files).toBe(2);
  });
});
