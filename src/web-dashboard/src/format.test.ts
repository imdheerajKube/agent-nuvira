import { describe, it, expect } from 'vitest';
import { formatElapsed } from './format';

/**
 * The elapsed formatter both long-wait surfaces share (the chat turn's
 * "still running" notice and the task console's running command).
 *
 * It exists so a wait that can now be an hour reads as time passing rather than
 * as a page that stopped: sub-minute counts in seconds (`12s`), then minutes with
 * seconds (`3m 05s`), then hours with minutes (`1h 04m`). The zero-padding is
 * deliberate — without it the number appears to jump backwards as it grows.
 */
describe('formatElapsed — a duration that is still growing', () => {
  it('counts seconds under a minute', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(999)).toBe('0s');
    expect(formatElapsed(1_000)).toBe('1s');
    expect(formatElapsed(59_999)).toBe('59s');
  });

  it('pads the seconds once minutes are in play', () => {
    expect(formatElapsed(60_000)).toBe('1m 00s');
    expect(formatElapsed(185_000)).toBe('3m 05s');
    expect(formatElapsed(3_599_999)).toBe('59m 59s');
  });

  it('switches to hours with padded minutes', () => {
    expect(formatElapsed(3_600_000)).toBe('1h 00m');
    expect(formatElapsed(3_845_000)).toBe('1h 04m');
    // The longest turn measured in this project's own trace store (~43 min) and
    // a genuinely long one — both must read as elapsed time, not as a failure.
    expect(formatElapsed(2_571_000)).toBe('42m 51s');
    expect(formatElapsed(7_200_000)).toBe('2h 00m');
  });

  it('degrades to 0s rather than printing NaN', () => {
    expect(formatElapsed(Number.NaN)).toBe('0s');
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('0s');
    expect(formatElapsed(-1)).toBe('0s');
  });
});
