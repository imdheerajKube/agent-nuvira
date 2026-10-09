/**
 * `nuvira trace degraded` — the read-only census the Requests panel's error rate
 * cannot express.
 *
 * A pair that served steps while not agentic-capable ANSWERED, so the
 * hash-chained action log books it as `verified` and its error rate is not a
 * quality measurement. This command derives the truth from the traces and writes
 * nothing back, so the test asserts both halves: the weak pair is reported with
 * its step/trace counts, and an agentic-capable pair is never reported.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'nuvira-trace-cli-'));
process.env.NUVIRA_MEMORY_DIR = join(testDir, 'memory');

const { TraceCommand } = await import('../../src/cli/trace.js');
const { beginTrace, recordStep, endTrace, clearTraces } = await import(
  '../../src/learning/reasoning-trace.js'
);

const step = (provider: string, model: string) => ({
  agentType: 'chat',
  provider,
  model,
  promptDigest: 'd1',
  promptPreview: 'p',
  responsePreview: 'r',
  responseLength: 1,
  inputTokens: 1,
  outputTokens: 1,
  latencyMs: 1,
  success: true,
});

/** Run `nuvira trace …` through the real commander tree. */
async function runTrace(args: string[]): Promise<void> {
  const program = new Command();
  program.addCommand(new TraceCommand().create());
  await program.parseAsync(['node', 'test', 'trace', ...args]);
}

describe('nuvira trace degraded', () => {
  let out: string[];

  beforeEach(() => {
    clearTraces();
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out.push(a.map((x) => String(x)).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      out.push(a.map((x) => String(x)).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('lists the weak pair with its step and trace counts, never an agentic pair', async () => {
    const a = beginTrace({ goal: 'fix the buttons', source: 'chat', provider: 'gemini' });
    recordStep(a, step('gemini', 'gemma-4-31b-it'));
    recordStep(a, step('local', 'qwen2.5:0.5b'));
    endTrace(a, true);

    await runTrace(['degraded']);
    const printed = out.join('\n');
    expect(printed).toContain('local/qwen2.5:0.5b');
    expect(printed).toContain('1 step(s) across 1 trace(s)');
    expect(printed).toContain(a);
    expect(printed).not.toContain('gemma-4-31b-it');
    // It names what it is: a derivation, not a rewrite of the action log.
    expect(printed).toContain('DERIVED from the traces');
  });

  it('says so plainly when nothing was degraded', async () => {
    const b = beginTrace({ goal: 'build a web app', source: 'chat', provider: 'groq' });
    recordStep(b, step('groq', 'openai/gpt-oss-120b'));
    endTrace(b, true);

    await runTrace(['degraded']);
    expect(out.join('\n')).toContain('No non-agentic-capable pair served a traced step');
  });

  /**
   * MEASURED 2026-10-09, on the live store: `nuvira trace degraded -l 60` printed
   * "0 trace(s) … No non-agentic-capable pair served a traced step" while the same
   * derivation over the same file found `local/qwen2.5:0.5b — 10 steps across 6
   * traces`. Commander hands a custom option parser `(value, previous)`, so the
   * bare `parseInt` idiom passed the option's DEFAULT (60) as the RADIX:
   * `parseInt('60', 60)` is NaN, and `listTraces` slices a NaN limit away to
   * nothing. The derivation was right; the option surface was lying. This case
   * goes through the real commander tree WITH `-l` — the hole the other cases left.
   */
  it('honours -l without emptying the census', async () => {
    const c = beginTrace({ goal: 'answer the three bugs', source: 'chat', provider: 'gemini' });
    recordStep(c, step('gemini', 'gemma-4-31b-it'));
    recordStep(c, step('local', 'qwen2.5:0.5b'));
    endTrace(c, true);

    await runTrace(['degraded', '-l', '60']);
    const printed = out.join('\n');
    expect(printed).toContain('from 1 trace(s)');
    expect(printed).toContain('local/qwen2.5:0.5b');
    expect(printed).not.toContain('No non-agentic-capable pair served a traced step');
  });

  it('scans only the -l most recent traces', async () => {
    const older = beginTrace({ goal: 'older turn', source: 'chat', provider: 'gemini' });
    recordStep(older, step('local', 'qwen2.5:0.5b'));
    endTrace(older, true);
    const recent = beginTrace({ goal: 'recent turn', source: 'chat', provider: 'groq' });
    recordStep(recent, step('groq', 'openai/gpt-oss-120b'));
    endTrace(recent, true);

    await runTrace(['degraded', '-l', '1']);
    const printed = out.join('\n');
    expect(printed).toContain('from 1 trace(s)');
    expect(printed).toContain('No non-agentic-capable pair served a traced step');
  });

  it('does not let a non-numeric -l report an empty census', async () => {
    const d = beginTrace({ goal: 'a turn', source: 'chat', provider: 'gemini' });
    recordStep(d, step('local', 'qwen2.5:0.5b'));
    endTrace(d, true);

    await runTrace(['degraded', '-l', 'abc']);
    const printed = out.join('\n');
    expect(printed).toContain('from 1 trace(s)');
    expect(printed).toContain('local/qwen2.5:0.5b');
  });
});
