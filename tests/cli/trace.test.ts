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
});
