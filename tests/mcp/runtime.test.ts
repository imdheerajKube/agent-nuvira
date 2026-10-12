/**
 * MCP runtime-override tests (`src/mcp/runtime.ts`).
 *
 * What must hold: with no override the spawn is unchanged (byte-identical
 * command + args), and with one the child is `runtime.command runtime.args…
 * <command> <args…>` — the mechanism that lets a server needing Node ≥20 run
 * under its own Node while the product keeps its own floor.
 */

import { describe, it, expect } from 'vitest';

import { describeStdioCommand, resolveStdioCommand } from '../../src/mcp/runtime.js';

describe('resolveStdioCommand', () => {
  it('leaves the command and args untouched when no runtime is declared', () => {
    const resolved = resolveStdioCommand({
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@4.3.0'],
    });
    expect(resolved).toEqual({
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@4.3.0'],
      runtimeApplied: false,
    });
  });

  it('prefixes the runtime command and its args over the server command', () => {
    const resolved = resolveStdioCommand({
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@4.3.0'],
      runtime: { command: '/opt/node20/bin/node', args: ['/usr/local/bin/npx'] },
    });
    expect(resolved.command).toBe('/opt/node20/bin/node');
    // node → npx → the package. This is `node npx -y pkg@ver`, which is what
    // actually decides which Node version runs the server.
    expect(resolved.args).toEqual(['/usr/local/bin/npx', 'npx', '-y', '@upstash/context7-mcp@4.3.0']);
    expect(resolved.runtimeApplied).toBe(true);
  });

  it('applies a runtime with no args of its own', () => {
    const resolved = resolveStdioCommand({ command: 'uvx', args: ['mcp-server-fetch'], runtime: { command: '/opt/bin/uvx' } });
    expect(resolved.args).toEqual(['uvx', 'mcp-server-fetch']);
  });

  it('ignores an empty runtime command instead of spawning nonsense', () => {
    const resolved = resolveStdioCommand({ command: 'npx', args: [], runtime: { command: '   ' } });
    expect(resolved).toEqual({ command: 'npx', args: [], runtimeApplied: false });
  });

  it('throws when there is no command at all', () => {
    expect(() => resolveStdioCommand({})).toThrow(/No stdio command/);
  });

  it('never mutates the config it reads', () => {
    const args = ['-y', 'pkg@1.0.0'];
    resolveStdioCommand({ command: 'npx', args, runtime: { command: 'node20' } });
    expect(args).toEqual(['-y', 'pkg@1.0.0']);
  });
});

describe('describeStdioCommand', () => {
  it('renders the spawn line and marks an override', () => {
    expect(describeStdioCommand({ command: 'npx', args: ['-y', 'pkg@1.0.0'] })).toBe('npx -y pkg@1.0.0');
    expect(
      describeStdioCommand({ command: 'npx', args: ['-y', 'pkg@1.0.0'], runtime: { command: 'node20' } }),
    ).toContain('runtime override');
  });

  it('reports a missing command without throwing', () => {
    expect(describeStdioCommand({})).toBe('(no command)');
  });
});
