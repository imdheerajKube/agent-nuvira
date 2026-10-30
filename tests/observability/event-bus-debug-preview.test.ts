/**
 * The debug line is the only place a tool's ARGUMENTS reach the log.
 *
 * WHY THIS IS PINNED. A benchmark run of the agent recorded 11 `python` invocations
 * whose arguments were cut off at `cd … && python`, so nothing could tell whether
 * any of them was `python -m pytest` — and the scorer's "did it verify itself" axis,
 * which greps this log, answered no for a turn that ran commands in the repo. The
 * fix is a longer preview for `tool:started` ONLY: `tool:called` carries the tool's
 * RESULT, which is unbounded output, and a debug log has to stay bounded.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { EventBus, LoggerConsumer } from '../../src/observability/event-bus.js';
import { logger } from '../../src/utils/logger.js';

// Longer than the 200-char preview on purpose: the point is that the TAIL survives,
// and the tail is what a 200-char cut hid in the benchmark run.
const COMMAND =
  'cd /tmp/repo && python -m pytest -q tests/test_util.py tests/test_paths.py tests/test_settings.py ' +
  '--maxfail=1 -p no:cacheprovider 2>&1 | tail -20 && echo "exit=$?"';

function debugLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

describe('debug event lines — arguments stay readable', () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a long tool command whole, so "did it run a test" is answerable', () => {
    const bus = new EventBus();
    new LoggerConsumer().attach(bus);

    bus.emit('tool:started' as never, { tool: 'run_terminal', args: { command: COMMAND } } as never, 'loop');

    const line = debugLines(spy).find((l) => l.includes('[event] tool:started'));
    expect(line).toBeTruthy();
    // The whole command, not the first 200 characters of it.
    expect(line).toContain('python -m pytest');
    expect(line).toContain('tail -20');
    expect(line!.length).toBeGreaterThan(200);
  });

  it('still keeps an unbounded result short', () => {
    const bus = new EventBus();
    new LoggerConsumer().attach(bus);

    bus.emit(
      'tool:called' as never,
      { tool: 'run_terminal', ok: true, result: 'x'.repeat(5_000) } as never,
      'loop',
    );

    const line = debugLines(spy).find((l) => l.includes('[event] tool:called'));
    expect(line).toBeTruthy();
    // The 200-char preview, plus the `[event] tool:called [loop] ` prefix.
    expect(line!.length).toBeLessThan(300);
  });
});
