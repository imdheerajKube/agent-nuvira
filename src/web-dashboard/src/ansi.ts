/**
 * P2 — ANSI escape stripping for terminal output rendered in the dashboard.
 *
 * The P1 task runner streams a child process's RAW stdout/stderr — chalk
 * colors, cursor-control (progress bars / spinners), and OSC window-title
 * sequences all arrive intact. The task-run card must render clean text, so
 * every escape sequence is removed here (pure string in → string out).
 *
 * Coverage:
 *   - CSI sequences  ESC [ ... (params) (intermediates) final  — `\x1b[32m`,
 *     `\x1b[2K` (clear line), `\x1b[1A` (cursor up), `\x1b[?25l` (hide cursor)
 *   - OSC sequences  ESC ] ... BEL|ST                        — `\x1b]0;title\x07`
 *   - Single-char escapes                                     — `\x1b7` etc.
 */

const ANSI_PATTERN = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  if (!text) return '';
  return text.replace(ANSI_PATTERN, '');
}
