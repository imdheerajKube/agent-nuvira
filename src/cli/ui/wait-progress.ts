/**
 * A heartbeat for a model call that is taking a long time.
 *
 * WHY THIS EXISTS (measured 2026-11-04). A CLI `assess the project` turn routed
 * to `gemini/gemini-3.1-flash-lite` and the terminal showed "thinking…" with
 * nothing after it; the process was killed three minutes later and the trace was
 * left `in progress`. The walk DID have a failover path, but the only lines it
 * emitted were `logger.debug`, which is off by default, so a long attempt and a
 * dead connection looked identical to the user. A silent wait is indistinguishable
 * from a hang, and it was reported as one.
 *
 * The heartbeat states the pair being waited on and the elapsed time, so
 * "it is still trying X" is visible while it happens. It never changes the
 * attempt itself: the caller stops it when the call settles, and the timer is
 * unref'd so a forgotten stop cannot keep the process alive.
 */

import { logger } from '../../utils/logger.js';

/** How long one attempt may go quiet before the user is told it is still alive. */
export const WAIT_HEARTBEAT_MS = 30_000;

export interface WaitProgressOptions {
  /** Suppress the heartbeat entirely (quiet runs). */
  enabled?: boolean;
  /** Override the interval (tests). */
  everyMs?: number;
}

/**
 * Start printing "still waiting on <label>" every {@link WAIT_HEARTBEAT_MS}.
 * Returns the stop function; call it in a `finally` so no line outlives its call.
 */
export function startWaitProgress(label: string, opts: WaitProgressOptions = {}): () => void {
  if (opts.enabled === false) return () => {};
  const everyMs = opts.everyMs && opts.everyMs > 0 ? opts.everyMs : WAIT_HEARTBEAT_MS;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const waitedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    logger.info(
      `   ⏳ still waiting on ${label} (${waitedSeconds}s) — no answer yet; this attempt will time out and fail over, not hang`,
    );
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
