/**
 * `nuvira dashboard` runs the messaging gateway alongside itself.
 *
 * WHY. The gateway is what makes the agent reachable from WhatsApp/Telegram/
 * Slack/Email/Signal, and needing a second terminal to get it is exactly the
 * manual cadence a GUI-first user should not have to discover. One command
 * should be the whole product.
 *
 * The properties pinned here are the ones that make that safe:
 *   - it is ON by default (the whole point), and
 *   - it can be turned off (`--no-gateway`) and decoupled from the dashboard's
 *     lifetime (`--keep-gateway`).
 *
 * Options are read via `parseOptions`, which parses the command's flags WITHOUT
 * running its action — the action would try to bind a real port and start real
 * processes.
 */

import { describe, it, expect } from 'vitest';
import { createCLI } from '../../src/cli/cli-program.js';
import { isGatewayRunning } from '../../src/cli/process-control.js';

/**
 * Parse the dashboard command's flags WITHOUT running its action.
 *
 * `parseOptions` (commander 12) returns `{ operands, unknown }` — the parsed
 * values live on the command, which is what `opts()` reads back. A fresh CLI is
 * built per call because parsing the same command twice accumulates.
 */
function parseDashboard(argv: string[]): Record<string, unknown> {
  const cli = createCLI();
  const cmd = cli.commands.find((c) => c.name() === 'dashboard');
  if (!cmd) throw new Error('dashboard command is not registered');
  cmd.parseOptions(argv);
  return cmd.opts() as Record<string, unknown>;
}

function dashboardCommand() {
  const cli = createCLI();
  const cmd = cli.commands.find((c) => c.name() === 'dashboard');
  if (!cmd) throw new Error('dashboard command is not registered');
  return cmd;
}

describe('nuvira dashboard — gateway alongside (default ON)', () => {
  it('starts the gateway by default', () => {
    // commander's `--no-gateway` semantics: the default is true, so the flag is
    // what turns it OFF. Getting this backwards would silently disable messaging
    // for every user, which is why it is asserted rather than assumed.
    expect(parseDashboard([]).gateway).toBe(true);
  });

  it('--no-gateway opts out', () => {
    expect(parseDashboard(['--no-gateway']).gateway).toBe(false);
  });

  it('does not keep the gateway after the dashboard exits unless asked', () => {
    expect(parseDashboard([]).keepGateway).toBeUndefined();
    expect(parseDashboard(['--keep-gateway']).keepGateway).toBe(true);
  });

  it('uses the gateway webhook port 8787 by default, overridable', () => {
    expect(parseDashboard([]).gatewayPort).toBe(8787);
    expect(parseDashboard(['--gateway-port', '9123']).gatewayPort).toBe(9123);
  });

  it('still parses the pre-existing dashboard options (no regression)', () => {
    const opts = parseDashboard(['--port', '4040', '--no-open']);
    expect(opts.port).toBe(4040);
    expect(opts.open).toBe(false);
  });

  it('exposes the stop subcommand', () => {
    const names = dashboardCommand().commands.map((c) => c.name());
    expect(names).toContain('stop');
  });
});

describe('isGatewayRunning', () => {
  it('answers with a boolean verdict and never throws', async () => {
    // The verdict itself depends on the machine (a developer may well have a
    // gateway up), so the contract under test is that the probe always ANSWERS:
    // a throw here would crash `nuvira dashboard` at startup.
    const result = await isGatewayRunning({ port: 8787 });
    expect(typeof result.running).toBe('boolean');
    if (result.running) expect(typeof result.pid).toBe('number');
  });
});
