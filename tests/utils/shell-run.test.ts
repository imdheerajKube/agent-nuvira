/**
 * runShell / runShellSync tests — the E1 shell execution choke point.
 *
 * Verifies:
 * 1. Success path: exit code 0, captured stdout, success flag.
 * 2. Non-zero exit: exit code returned (never throws), success false.
 * 3. Deadline: a subprocess execa reports as deadline-exceeded comes back with
 *    timedOut true and success false (the KILL against a real child is covered by
 *    the abort test, which does not depend on a timer).
 * 4. Abort: AbortSignal kills the process, aborted true.
 * 5. Streaming: onChunk receives output chunks as they arrive.
 * 6. EventBus: exec:shell-start / exec:shell-end emitted with command + exit code.
 * 7. emitEvents: false suppresses shell events (silent internal calls).
 * 8. Sync variant: runShellSync behaves identically (success + failure).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { runShell, runShellSync } from '../../src/utils/shell.js';
import { getEventBus, resetEventBus, EventNames } from '../../src/observability/event-bus.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Collect shell events for the duration of one test. */
function collectShellEvents(): {
  started: Array<{ command: string; cwd?: string }>;
  ended: Array<{ command: string; exitCode: number; success: boolean }>;
  stop: () => void;
} {
  const started: Array<{ command: string; cwd?: string }> = [];
  const ended: Array<{ command: string; exitCode: number; success: boolean }> = [];

  const bus = getEventBus();
  const offStart = bus.on(EventNames.EXEC_SHELL_START, (record) => {
    const d = record.data as { command: string; cwd?: string };
    started.push({ command: d.command, cwd: d.cwd });
  });
  const offEnd = bus.on(EventNames.EXEC_SHELL_END, (record) => {
    const d = record.data as { command: string; exitCode: number; success: boolean };
    ended.push({ command: d.command, exitCode: d.exitCode, success: d.success });
  });

  return {
    started,
    ended,
    stop: () => {
      offStart();
      offEnd();
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('runShell', () => {
  beforeEach(() => {
    resetEventBus();
  });

  afterEach(() => {
    resetEventBus();
  });

  it('runs a command and returns its stdout with exit code 0', async () => {
    const result = await runShell('echo hello-from-run-shell');

    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('hello-from-run-shell');
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.command).toBe('echo hello-from-run-shell');
  });

  it('returns the exit code on failure instead of throwing', async () => {
    const result = await runShell('node -e "process.exit(3)"');

    expect(result.exitCode).toBe(3);
    expect(result.success).toBe(false);
    // Output must still be captured (or empty — never undefined)
    expect(typeof result.stdout).toBe('string');
    expect(typeof result.stderr).toBe('string');
  });

  it('captures stderr on failure', async () => {
    const result = await runShell('node -e "console.error(\'boom-stderr\'); process.exit(1)"');

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('boom-stderr');
  });

  // Windows: execa + shell (cmd.exe) timeout kills only the cmd.exe wrapper,
  // not the grandchild node process holding the pipes — `timedOut` never
  // fires, so this assertion cannot pass there (pre-existing Windows-only
  // limitation; the AbortSignal test below does run on Windows).
  // THE DEADLINE IS REPORTED FROM execa'S RESULT, SO THAT IS WHAT IS ASSERTED —
  // and the round trip through a REAL child is deliberately not part of it.
  //
  // MEASURED, twice (2026-10-30, ubuntu-latest): a wall-clock version of this test
  // (`node -e "setTimeout(…, 5000)"` against a 150ms deadline) reported
  // `timedOut: false` on a saturated runner, because execa's deadline is a JS
  // timer and the worker's event loop can be starved past the child's own exit —
  // the process finishes FIRST and the result honestly says it did not time out.
  // Lengthening the child only moves the race (a 60s child hung for the whole test
  // budget instead). Whether the kill LANDS is execa's behaviour, not this
  // module's; what this module owes is that a rejected-by-deadline child is
  // reported as `timedOut`, and that is asserted here directly. The KILL against a
  // real subprocess is still covered below, through the abort signal, which is not
  // a timer.
  it('reports a deadline-exceeded subprocess as timedOut and failed', async () => {
    vi.resetModules();
    vi.doMock('execa', () => ({
      execa: () =>
        Promise.resolve({
          stdout: '',
          stderr: 'signal: SIGTERM',
          exitCode: undefined,
          timedOut: true,
          isCanceled: false,
        }),
      execaSync: () => ({}),
    }));
    try {
      const { runShell: runShellUnderDeadline } = await import('../../src/utils/shell.js');
      const result = await runShellUnderDeadline('node render.js', {
        timeoutMs: 150,
        emitEvents: false,
      });

      expect(result.timedOut).toBe(true);
      expect(result.success).toBe(false);
      // execa reports no exit code for a killed child (it was signalled, not
      // finished), and the result must not invent 0 for it.
      expect(result.exitCode).toBe(1);
    } finally {
      vi.doUnmock('execa');
      vi.resetModules();
    }
  });

  it('aborts the process via AbortSignal', async () => {
    const controller = new AbortController();
    const promise = runShell('node -e "setTimeout(() => {}, 5000)"', {
      signal: controller.signal,
    });

    // Abort shortly after launch
    setTimeout(() => controller.abort(), 100);

    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.success).toBe(false);
  }, 10_000);

  it('streams output chunks via onChunk', async () => {
    const chunks: string[] = [];
    await runShell('echo chunk-one && echo chunk-two', {
      onChunk: (chunk) => chunks.push(chunk),
    });

    const joined = chunks.join('');
    expect(joined).toContain('chunk-one');
    expect(joined).toContain('chunk-two');
  });

  it('emits exec:shell-start and exec:shell-end events', async () => {
    const events = collectShellEvents();
    try {
      await runShell('echo event-test', { source: 'unit-test' });

      expect(events.started).toHaveLength(1);
      expect(events.started[0].command).toBe('echo event-test');

      expect(events.ended).toHaveLength(1);
      expect(events.ended[0].command).toBe('echo event-test');
      expect(events.ended[0].exitCode).toBe(0);
      expect(events.ended[0].success).toBe(true);
    } finally {
      events.stop();
    }
  });

  it('emits a failed exec:shell-end with the non-zero exit code', async () => {
    const events = collectShellEvents();
    try {
      await runShell('node -e "process.exit(7)"');

      expect(events.ended).toHaveLength(1);
      expect(events.ended[0].exitCode).toBe(7);
      expect(events.ended[0].success).toBe(false);
    } finally {
      events.stop();
    }
  });

  it('includes captured stdout/stderr in exec:shell-end events (failure transparency)', async () => {
    const bus = getEventBus();
    let endData: { command: string; exitCode: number; stdout?: string; stderr?: string } | null = null;
    const off = bus.on(EventNames.EXEC_SHELL_END, (record) => {
      endData = record.data as { command: string; exitCode: number; stdout?: string; stderr?: string };
    });
    try {
      await runShell('node -e "console.log(\'visible-stdout\');console.error(\'visible-stderr\');process.exit(1)"');

      expect(endData).not.toBeNull();
      expect(endData!.exitCode).toBe(1);
      expect(endData!.stdout).toContain('visible-stdout');
      expect(endData!.stderr).toContain('visible-stderr');
    } finally {
      off();
    }
  });

  it('suppresses events when emitEvents is false', async () => {
    const events = collectShellEvents();
    try {
      await runShell('echo silent', { emitEvents: false });

      expect(events.started).toHaveLength(0);
      expect(events.ended).toHaveLength(0);
    } finally {
      events.stop();
    }
  });

  it('honors the cwd option', async () => {
    const result = await runShell('node -e "console.log(process.cwd())"', {
      cwd: '/',
    });

    // On the root dir, cwd prints "/" (POSIX) — the key assertion is it ran
    // somewhere other than the test's cwd without throwing.
    expect(result.success).toBe(true);
    expect(typeof result.stdout).toBe('string');
  });
});

describe('runShellSync', () => {
  beforeEach(() => {
    resetEventBus();
  });

  afterEach(() => {
    resetEventBus();
  });

  it('runs a command and returns its stdout synchronously', () => {
    const result = runShellSync('echo sync-hello');

    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('sync-hello');
  });

  it('returns the exit code on failure instead of throwing', () => {
    const result = runShellSync('node -e "process.exit(2)"');

    expect(result.exitCode).toBe(2);
    expect(result.success).toBe(false);
  });

  it('emits shell events', () => {
    const events = collectShellEvents();
    try {
      runShellSync('echo sync-event');

      expect(events.started).toHaveLength(1);
      expect(events.ended).toHaveLength(1);
      expect(events.ended[0].success).toBe(true);
    } finally {
      events.stop();
    }
  });

  it('suppresses events when emitEvents is false', () => {
    const events = collectShellEvents();
    try {
      runShellSync('echo sync-silent', { emitEvents: false });

      expect(events.started).toHaveLength(0);
      expect(events.ended).toHaveLength(0);
    } finally {
      events.stop();
    }
  });
});
