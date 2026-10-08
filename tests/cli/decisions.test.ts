/**
 * `nuvira decisions` — list, show, search and revise a project's recorded
 * must-ask decisions (Bundle 36).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

import { DecisionsCommand } from '../../src/cli/decisions.js';
import { recordDecision, readDecisions } from '../../src/learning/decision-log.js';

function makeCli(): Command {
  const cli = new Command();
  cli.addCommand(new DecisionsCommand().create());
  cli.exitOverride();
  return cli;
}

function runCli(cli: Command, args: string[]): { out: string; code: number } {
  let out = '';
  const sink = (...chunks: unknown[]) => {
    out += chunks.map((c) => String(c)).join(' ') + '\n';
  };
  const logSpy = vi.spyOn(console, 'log').mockImplementation(sink);
  const errSpy = vi.spyOn(console, 'error').mockImplementation(sink);
  process.exitCode = 0;
  try {
    cli.parse(['node', 'buff', ...args]);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = 0;
  return { out, code };
}

describe('nuvira decisions', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'buff-decisions-cli-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('exposes --dir WITHOUT a short flag, so the root `-d` (--debug) cannot shadow it', () => {
    const cmd = new DecisionsCommand().create();
    expect(cmd.options.some((o) => o.long === '--dir')).toBe(true);
    expect(cmd.options.some((o) => o.short === '-d')).toBe(false);
  });

  it('reports an empty log honestly', () => {
    const { out, code } = runCli(makeCli(), ['decisions', '--dir', dir]);
    expect(code).toBe(0);
    expect(out).toMatch(/None yet/);
  });

  it('lists, shows, then revises a decision', () => {
    const rec = recordDecision({
      question: 'Which database should the service use?',
      answer: 'SQLite',
      choices: ['Postgres', 'SQLite'],
      source: 'ask_user',
      dir,
    })!;

    const listed = runCli(makeCli(), ['decisions', '--dir', dir]);
    expect(listed.out).toContain(rec.id);
    expect(listed.out).toContain('Which database');

    const shown = runCli(makeCli(), ['decisions', 'show', rec.id, '--dir', dir]);
    expect(shown.out).toContain('SQLite');
    expect(shown.out).toContain('offered:  Postgres | SQLite');

    const revised = runCli(makeCli(), [
      'decisions',
      'revise',
      rec.id,
      '-a',
      'Postgres',
      '-n',
      'needed JSONB',
      '--dir',
      dir,
    ]);
    expect(revised.code).toBe(0);
    expect(revised.out).toMatch(/Revised/);
    expect(readDecisions(dir)[0].answer).toBe('Postgres');
    expect(readDecisions(dir)[0].revisions?.[0].note).toBe('needed JSONB');
  });

  it('finds a decision relevant to a later ask', () => {
    recordDecision({ question: 'Which database should the service use?', answer: 'Postgres', dir });
    recordDecision({ question: 'What colour should the logo be?', answer: 'blue', dir });

    const { out } = runCli(makeCli(), ['decisions', '--for', 'migrate the service database', '--dir', dir]);
    expect(out).toContain('Postgres');
    expect(out).not.toContain('blue');
  });

  it('fails with a nonzero code when revising an unknown decision', () => {
    const { out, code } = runCli(makeCli(), ['decisions', 'revise', 'dec-nope', '-a', 'x', '--dir', dir]);
    expect(code).toBe(1);
    expect(out).toMatch(/no such decision/i);
  });
});
