/**
 * `nuvira rate --explain <id>` — Bundle 36.
 *
 * A single rating must be auditable: the command prints the SAME features the fit
 * derives, the label (or an honest "unrated"), and the fitted `P(accepted)`. It is
 * read-only, so it must never change the corpus it describes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

import { RateCommand } from '../../src/cli/rate.js';
import { beginTrace, clearTraces, recordTraceEvent, recordTurnReport } from '../../src/learning/reasoning-trace.js';
import { collectLabelledTurns } from '../../src/learning/acceptance-model.js';
import { getRouterBandit, resetRouterBandit } from '../../src/learning/router-bandit.js';
import type { TurnReport } from '../../src/learning/turn-report.js';

function report(verification: string, flags: Record<string, boolean> = {}): TurnReport {
  return {
    goal: 'a guided turn',
    planned: false,
    steps: [],
    stepCounts: { done: 0, blocked: 0, pending: 0, running: 0, total: 0 },
    toolCalls: [],
    successfulToolCalls: [],
    failedToolCalls: [],
    mutations: 0,
    changedPaths: [],
    verification,
    flags,
    assumptions: [],
    summary: null,
  } as unknown as TurnReport;
}

function makeCli(): Command {
  const cli = new Command();
  cli.addCommand(new RateCommand().create());
  cli.exitOverride();
  return cli;
}

function runCli(cli: Command, args: string[]): { stdout: string; code: number } {
  let stdout = '';
  const logSpy = vi
    .spyOn(console, 'log')
    .mockImplementation((...chunks: unknown[]) => { stdout += chunks.map((c) => String(c)).join(' ') + '\n'; });
  const errSpy = vi
    .spyOn(console, 'error')
    .mockImplementation((...chunks: unknown[]) => { stdout += chunks.map((c) => String(c)).join(' ') + '\n'; });
  process.exitCode = 0;
  try {
    cli.parse(['node', 'buff', ...args]);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = 0;
  return { stdout, code };
}

describe('rate --explain', () => {
  let tempDir: string;
  let origMemory: string | undefined;
  let origConfig: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-rate-explain-'));
    origMemory = process.env.NUVIRA_MEMORY_DIR;
    origConfig = process.env.NUVIRA_CONFIG_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    process.env.NUVIRA_CONFIG_DIR = join(tempDir, 'config');
    resetRouterBandit();
    clearTraces();
  });

  afterEach(() => {
    if (origMemory === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = origMemory;
    if (origConfig === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = origConfig;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('prints the features and an honest unrated label, and writes nothing', () => {
    const id = beginTrace({ goal: 'explain me', source: 'chat', provider: 'groq', model: 'm1' });
    recordTurnReport(id, report('unverified', { unverifiedEdit: true }));

    const { stdout, code } = runCli(makeCli(), ['rate', '--explain', id]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Acceptance explanation/);
    expect(stdout).toContain(id);
    expect(stdout).toMatch(/features: verified=0\s+unverified=1\s+flag=1\s+delivered=0/);
    expect(stdout).toMatch(/label: unrated \(silence is not acceptance\)/);
    expect(stdout).toMatch(/P\(accepted \| these features\): n\/a/);
    expect(stdout).toMatch(/read-only/);

    // Read-only: the audit did not invent a label.
    expect(collectLabelledTurns()).toHaveLength(0);
  });

  it('fails with a nonzero code for a trace that does not exist', () => {
    const { stdout, code } = runCli(makeCli(), ['rate', '--explain', 'trace-nope']);
    expect(code).toBe(1);
    expect(stdout).toMatch(/Trace not found: trace-nope/);
  });

  it('`rate bad` also corrects the router, and re-rating does not correct it twice', () => {
    const id = beginTrace({ goal: 'implement a login form', source: 'chat', provider: 'auto', model: 'auto' });
    recordTurnReport(id, report('verified'));
    recordTraceEvent(id, {
      kind: 'decision',
      gate: 'routing',
      summary: 'routed to groq/llama (complexity moderate)',
      routing: {
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        score: 0.9,
        complexity: 'moderate',
        explanation: 'test',
        taskIntent: 'coding',
      },
    });
    getRouterBandit().recordOutcome('groq', 'implement a login form', 'success', 1.0, undefined, 'coding');

    const first = runCli(makeCli(), ['rate', 'bad', '-t', id]);
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/Router: corrected 1 bandit prior\(s\)/);

    const second = runCli(makeCli(), ['rate', 'bad', '-t', id]);
    expect(second.stdout).toMatch(/already applied/);
  });
});
