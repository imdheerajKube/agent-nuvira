/**
 * A long model attempt must say it is still alive.
 *
 * WHY (measured 2026-11-04): a CLI `assess the project` turn sat on
 * `gemini/gemini-3.1-flash-lite` for over three minutes with the terminal showing
 * only "thinking…". The failover path existed, but its lines were `logger.debug`
 * — invisible by default — so a slow attempt and a dead connection looked
 * identical, and the run was reported as a hang. The heartbeat is the fix; these
 * tests pin that it fires, names the pair, and stops when the call settles.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { logger } from '../../../src/utils/logger.js';
import { startWaitProgress, WAIT_HEARTBEAT_MS } from '../../../src/cli/ui/wait-progress.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('startWaitProgress', () => {
  it('prints a heartbeat while the call is pending, and stops on request', () => {
    vi.useFakeTimers();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});

    const stop = startWaitProgress('gemini/gemini-3.1-flash-lite', { everyMs: 30_000 });
    expect(info).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]![0])).toContain('still waiting on gemini/gemini-3.1-flash-lite');
    expect(String(info.mock.calls[0]![0])).toContain('(30s)');

    vi.advanceTimersByTime(30_000);
    expect(info).toHaveBeenCalledTimes(2);
    expect(String(info.mock.calls[1]![0])).toContain('(60s)');

    stop();
    vi.advanceTimersByTime(120_000);
    expect(info).toHaveBeenCalledTimes(2);
  });

  it('is silent when disabled (quiet runs)', () => {
    vi.useFakeTimers();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});

    const stop = startWaitProgress('local/deepseek-coder:latest', { enabled: false, everyMs: 1_000 });
    vi.advanceTimersByTime(10_000);
    expect(info).not.toHaveBeenCalled();
    stop();
  });

  it('defaults to a 30-second heartbeat', () => {
    expect(WAIT_HEARTBEAT_MS).toBe(30_000);
  });
});
