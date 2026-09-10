"use strict";
/**
 * P2 — ANSI escape stripping unit tests: the pure string→string function the
 * task-run card uses to render child-process output without chalk colors,
 * cursor-control, or OSC window-title sequences.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const ansi_1 = require("./ansi");
(0, vitest_1.describe)('stripAnsi', () => {
    (0, vitest_1.it)('removes SGR color codes (single and multi-param)', () => {
        (0, vitest_1.expect)((0, ansi_1.stripAnsi)('\x1b[32mgreen\x1b[0m')).toBe('green');
        (0, vitest_1.expect)((0, ansi_1.stripAnsi)('\x1b[38;2;255;0;0m rgb \x1b[39m')).toBe(' rgb ');
    });
    (0, vitest_1.it)('removes cursor-control and clear-line sequences (progress bars)', () => {
        (0, vitest_1.expect)((0, ansi_1.stripAnsi)('\x1b[2K\x1b[1A\x1b[2Kprogress 50%')).toBe('progress 50%');
        (0, vitest_1.expect)((0, ansi_1.stripAnsi)('\x1b[?25l\x1b[?25h')).toBe('');
    });
    (0, vitest_1.it)('removes OSC window-title sequences', () => {
        (0, vitest_1.expect)((0, ansi_1.stripAnsi)('\x1b]0;my title\x07content')).toBe('content');
        (0, vitest_1.expect)((0, ansi_1.stripAnsi)('\x1b]0;another\x1b\\tail')).toBe('tail');
    });
    (0, vitest_1.it)('leaves plain text untouched', () => {
        (0, vitest_1.expect)((0, ansi_1.stripAnsi)('plain output 123')).toBe('plain output 123');
        (0, vitest_1.expect)((0, ansi_1.stripAnsi)('')).toBe('');
    });
    (0, vitest_1.it)('handles mixed lines with multiple sequences', () => {
        const line = '\x1b[1mBOLD\x1b[22m \x1b[31mRED\x1b[0m \x1b[2Kdone';
        (0, vitest_1.expect)((0, ansi_1.stripAnsi)(line)).toBe('BOLD RED done');
    });
});
