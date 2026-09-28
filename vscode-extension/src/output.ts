/**
 * Output channel — one place where extension diagnostics are written.
 *
 * The extension previously logged activation and routing facts only to
 * `console.log`, which is invisible to a user who needs to see why the CLI is
 * not being found or why a request routed where it did. A named Output channel
 * ("Agent-Nuvira") puts the same facts in View → Output where they belong, and
 * gives every module a stable sink to write to.
 *
 * Best-effort: writing to the channel must never throw into an activation path,
 * so every call is guarded.
 */

import * as vscode from 'vscode';

let channel: vscode.OutputChannel | null = null;

/** The shared channel, created on first use. */
export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Agent-Nuvira');
  }
  return channel;
}

/** Append a timestamped line to the Agent-Nuvira output channel. */
export function log(message: string): void {
  try {
    const ts = new Date().toISOString().slice(11, 19);
    getOutputChannel().appendLine(`[${ts}] ${message}`);
  } catch {
    // Output must never break a running command.
  }
}

/** Append an error line, prefixed for grep-ability. */
export function logError(message: string): void {
  log(`ERROR ${message}`);
}

/** Dispose the channel (called on deactivate). */
export function disposeOutputChannel(): void {
  try {
    channel?.dispose();
  } catch {
    // Best-effort.
  }
  channel = null;
}
