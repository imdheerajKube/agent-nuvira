/**
 * P2 — ANSI escape stripping unit tests: the pure string→string function the
 * task-run card uses to render child-process output without chalk colors,
 * cursor-control, or OSC window-title sequences.
 */

import { describe, it, expect } from 'vitest';
import { stripAnsi } from './ansi';

describe('stripAnsi', () => {
  it('removes SGR color codes (single and multi-param)', () => {
    expect(stripAnsi('\x1b[32mgreen\x1b[0m')).toBe('green');
    expect(stripAnsi('\x1b[38;2;255;0;0m rgb \x1b[39m')).toBe(' rgb ');
  });

  it('removes cursor-control and clear-line sequences (progress bars)', () => {
    expect(stripAnsi('\x1b[2K\x1b[1A\x1b[2Kprogress 50%')).toBe('progress 50%');
    expect(stripAnsi('\x1b[?25l\x1b[?25h')).toBe('');
  });

  it('removes OSC window-title sequences', () => {
    expect(stripAnsi('\x1b]0;my title\x07content')).toBe('content');
    expect(stripAnsi('\x1b]0;another\x1b\\tail')).toBe('tail');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain output 123')).toBe('plain output 123');
    expect(stripAnsi('')).toBe('');
  });

  it('handles mixed lines with multiple sequences', () => {
    const line = '\x1b[1mBOLD\x1b[22m \x1b[31mRED\x1b[0m \x1b[2Kdone';
    expect(stripAnsi(line)).toBe('BOLD RED done');
  });
});
