/**
 * MCP runtime override — start a stdio server under its OWN interpreter.
 *
 * THE PROBLEM THIS SOLVES. `@upstash/context7-mcp@4.3.0` declares
 * `engines.node: ">=20.18.1"`. Nuvira ships `engines.node: ">=18.18.0"` and is
 * widely installed on Node 18 and 20. Raising the global floor would drop
 * supported machines; leaving the pin at the broken 1.5.2 would keep a
 * capability advertised that cannot start. A per-server runtime override keeps
 * both honest: the product's floor does not move, and the outlier server runs
 * under the interpreter it requires.
 *
 * THE CONTRACT. A config may carry
 *
 *   "runtime": { "command": "/opt/node20/bin/node", "args": ["/usr/local/bin/npx"] }
 *
 * and the child process becomes
 *
 *   /opt/node20/bin/node /usr/local/bin/npx <the variant's command>…
 *
 * i.e. `runtime.command` + `runtime.args` + the server's own `command` and
 * `args`. For an `npx`-based server that is exactly "run npx with a newer Node"
 * — `npx` is a JS entry point, so the interpreter that starts it is what decides
 * the Node version. For a native binary the prefix is simply omitted.
 *
 * VERIFICATION IS HONEST. The prerequisite probe checks only that
 * `runtime.command` EXISTS; its version is established by the MCP handshake when
 * the server connects (`initialize` carries the protocol version, and a wrong
 * interpreter fails there loudly) — never claimed as verified before that.
 */

import type { MCPServerConfig } from './types.js';

/** The command + args actually spawned for a stdio server, runtime prefix applied. */
export interface ResolvedStdioCommand {
  command: string;
  args: string[];
  /** True when a runtime override was applied (for reporting/tests). */
  runtimeApplied: boolean;
}

/**
 * Resolve the stdio command and args to spawn, applying `config.runtime` when
 * present. Pure — no spawn, no filesystem — so it is trivially testable and
 * usable by a dry-run reporter.
 */
export function resolveStdioCommand(config: Pick<MCPServerConfig, 'command' | 'args' | 'runtime'>): ResolvedStdioCommand {
  const command = String(config.command ?? '').trim();
  if (!command) {
    throw new Error('No stdio command to run');
  }
  const serverArgs = config.args ?? [];
  const runtime = config.runtime;
  if (!runtime || !runtime.command || !String(runtime.command).trim()) {
    return { command, args: [...serverArgs], runtimeApplied: false };
  }
  return {
    command: String(runtime.command).trim(),
    args: [...(runtime.args ?? []), command, ...serverArgs],
    runtimeApplied: true,
  };
}

/**
 * Parse a runtime spec from a command line (`--runtime "/opt/node20/bin/node
 * /usr/local/bin/npx"` or the dashboard's single text field) into a runtime
 * override. The first token is the command, the rest are its args. Returns null
 * for an empty spec.
 *
 * Lives here, not in the CLI, because the dashboard's MCP page accepts the same
 * string — one parser means `--runtime` and the UI field cannot disagree.
 */
export function parseRuntimeSpec(spec: string | undefined): { command: string; args?: string[] } | null {
  const parts = String(spec ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return parts.length === 1 ? { command: parts[0] } : { command: parts[0], args: parts.slice(1) };
}

/** A one-line description of what will be spawned (used by CLI listings). */
export function describeStdioCommand(config: Pick<MCPServerConfig, 'command' | 'args' | 'runtime'>): string {
  try {
    const resolved = resolveStdioCommand(config);
    const line = [resolved.command, ...resolved.args].join(' ');
    return resolved.runtimeApplied ? `${line}   (runtime override)` : line;
  } catch {
    return '(no command)';
  }
}
