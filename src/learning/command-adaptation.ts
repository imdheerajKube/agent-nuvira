/**
 * Command adaptation — the "run → adapt" half of the long-tail loop.
 *
 * When a command fails because an executable is not on this machine, the failure
 * is not the end of the turn: it is the point at which the model should CHOOSE a
 * command for this machine (or check one against it) instead of assuming. These
 * helpers turn that OS signal into a bounded, factual note appended to the tool
 * result.
 *
 * KEYED ON THE SHELL'S OWN SIGNAL, not on wording in the model's prose: a missing
 * command is exit 127 (POSIX) or 9009 (cmd.exe), and the stderr text is used only
 * as a secondary signal. That is why this is not a phrase list — it is the shell
 * reporting the one thing it already knows.
 */

import { detectMachineFacts } from './machine-facts.js';

/**
 * The first executable-looking token of a command line, skipping env assignments
 * (`FOO=bar`) and leading flags. Returns null when the line does not start with a
 * plain executable (e.g. a shell builtin chain or a quoted blob).
 */
export function leadingBinary(command: string): string | null {
  const tokens = String(command ?? '').trim().split(/\s+/);
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // FOO=bar
    if (token.startsWith('-')) continue;
    const name = token.replace(/^["']|["']$/g, '');
    return /^[A-Za-z0-9._/\\-]+$/.test(name) ? name : null;
  }
  return null;
}

/**
 * Did this tool output describe a MISSING COMMAND? The primary signals are the
 * shell's own exit codes (127 = POSIX "command not found", 9009 = cmd.exe); the
 * stderr wordings are a fallback for shells that exit otherwise.
 */
export function isMissingBinaryFailure(output: string): boolean {
  const text = String(output ?? '');
  if (/\(exit 127\)/.test(text)) return true;
  if (/\(exit 9009\)/.test(text)) return true;
  if (/command not found/i.test(text)) return true;
  if (/is not recognized as an internal or external command/i.test(text)) return true;
  return false;
}

/**
 * A bounded note telling the model WHERE it is and what is present, so it can
 * adapt the command itself. Names the likely executable when the command line
 * makes it obvious; otherwise stays general, because guessing the wrong token
 * would be its own false claim.
 */
export function buildMissingBinaryNote(command?: string): string {
  const facts = detectMachineFacts();
  const bin = command ? leadingBinary(command) : null;
  const managers = facts.packageManagers.length > 0 ? facts.packageManagers.join(', ') : '(none detected)';
  return [
    '',
    '⚠️ A command here was not found on this machine.',
    ...(bin ? [`\`${bin}\` is not on PATH.`] : []),
    `This machine: ${facts.osName} · shell ${facts.shellName ?? 'unknown'}.`,
    `Package managers present: ${managers}.`,
    'Choose the command for THIS machine from these facts. Check one against the machine with tool_search (action "resolve") before re-running, and record a working one with action "record" so it is known next time.',
  ].join('\n');
}
