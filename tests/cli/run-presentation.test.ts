/**
 * `nuvira run` presentation layer.
 *
 * The command's OWN output (stdout/stderr of the executed program) must stay
 * verbatim — it is not markdown, and rendering it would corrupt it. What
 * changes is the SUMMARY header: a shell card on a terminal, the historical
 * ASCII banner on a pipe/CI stream (byte parity).
 *
 * The RunnerAgent is mocked so the test never spawns a real process; the mock
 * writes the same `context.metadata.runResult` the real agent does.
 *
 * NOTE ON CAPTURE: vitest intercepts `console.log` itself, so logger output
 * does NOT reach a `process.stdout.write` spy. Both channels are captured —
 * the card is written with `stdout.write`, the historical banner with
 * `console.log`, and a test that watches only one would silently miss half.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../src/cli/duties.js', () => ({
  maybeRunBackgroundDuties: async () => {},
}));

vi.mock('../../src/agents/agents/runner.js', () => ({
  RunnerAgent: class {
    async execute(context: { metadata: Record<string, unknown> }): Promise<{ success: boolean }> {
      context.metadata['runResult'] = {
        success: true,
        command: 'echo hi',
        exitCode: 0,
        stdout: 'hi from the command\n',
        stderr: '',
        duration: 3,
      };
      return { success: true };
    }
  },
}));

const { RunCommand } = await import('../../src/cli/run.js');

/** Capture BOTH channels a command writes through (see the note above). */
function captureOutput(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(((...args: unknown[]) => {
    chunks.push(args.map((a) => String(a)).join(' '));
  }) as never);
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
    chunks.push(String(c));
    return true;
  }) as never);
  const originalTTY = (process.stdout as { isTTY?: boolean }).isTTY;
  return {
    chunks,
    restore: (): void => {
      logSpy.mockRestore();
      writeSpy.mockRestore();
      Object.defineProperty(process.stdout, 'isTTY', { value: originalTTY, configurable: true });
    },
  };
}

function setStdoutTty(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

describe('RunCommand presentation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a shell card on a terminal and still passes the command output through', async () => {
    setStdoutTty(true);
    const capture = captureOutput();
    try {
      await (new RunCommand() as unknown as { execute: (c: string, o: object) => Promise<void> }).execute('echo hi', {});
    } finally {
      capture.restore();
    }
    const out = capture.chunks.join('\n');
    expect(out).toContain('💻');
    expect(out).toContain('echo hi');
    expect(out).toContain('exit 0');
    // The banner is gone on a terminal…
    expect(out).not.toContain('═'.repeat(60));
    // …but the program's own output is untouched.
    expect(out).toContain('hi from the command');
  });

  it('keeps the historical banner off a terminal (byte parity)', async () => {
    setStdoutTty(false);
    const capture = captureOutput();
    try {
      await (new RunCommand() as unknown as { execute: (c: string, o: object) => Promise<void> }).execute('echo hi', {});
    } finally {
      capture.restore();
    }
    const out = capture.chunks.join('\n');
    expect(out).toContain('═'.repeat(60));
    expect(out).not.toContain('╭');
    expect(out).toContain('hi from the command');
  });
});
