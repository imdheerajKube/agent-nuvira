/**
 * OmniRouteCommand — lifecycle control for the external OmniRoute gateway.
 *
 *   nuvira omniroute status   — is it running? (real HTTP probe + port/pid)
 *   nuvira omniroute start    — launch it in the background, wait until it answers
 *   nuvira omniroute stop     — SIGTERM the running gateway
 *
 * OmniRoute is installed and run outside nuvira (`npm install -g omniroute`);
 * this command is the same thin lifecycle layer the dashboard's Admin page uses
 * ({@link ./omniroute-control.js}), so "is it up?" and "how do I stop it?" have
 * one answer in both places. Starting/stopping is a service action and is gated
 * like `nuvira gateway stop` (gateway.manage); `status` is read-only.
 */

import { Command } from 'commander';
import { logger } from '../utils/logger.js';
import { guardRbacAction } from './rbac-guard.js';
import {
  omnirouteStatus,
  startOmniRoute,
  stopOmniRoute,
  OMNIROUTE_DEFAULT_URL,
} from './omniroute-control.js';

export class OmniRouteCommand {
  create(): Command {
    return new Command('omniroute')
      .description('Start / stop / inspect the external OmniRoute AI gateway (default port 20128)')
      .addCommand(
        new Command('status')
          .description('Probe the OmniRoute gateway and report whether it is reachable')
          .action(async () => this.status()),
      )
      .addCommand(
        new Command('start')
          .description('Start the OmniRoute gateway in the background and wait for it to answer')
          .action(async () => this.start()),
      )
      .addCommand(
        new Command('stop')
          .description('Stop the running OmniRoute gateway')
          .action(async () => this.stop()),
      );
  }

  private async status(): Promise<void> {
    const status = await omnirouteStatus();
    const icon = status.reachable ? '✅' : status.running ? '⚠️' : '❌';
    console.log(`${icon}  OmniRoute at ${status.baseUrl}`);
    console.log(`    ${status.detail}`);
    console.log(
      status.pid !== null
        ? `    process: running on port ${status.port} (PID ${status.pid})`
        : `    process: nothing found listening on port ${status.port}`,
    );
    if (!status.running) {
      console.log('    Start it with:  nuvira omniroute start   (install: npm install -g omniroute)');
    }
  }

  private async start(): Promise<void> {
    if (!guardRbacAction('gateway.manage')) return;
    logger.info(`Starting OmniRoute (${OMNIROUTE_DEFAULT_URL})…`);
    const result = await startOmniRoute();
    if (result.ok) {
      logger.success(result.detail);
      return;
    }
    logger.error(result.detail);
    process.exitCode = 1;
  }

  private async stop(): Promise<void> {
    if (!guardRbacAction('gateway.manage')) return;
    const result = await stopOmniRoute();
    if (result.stopped) {
      logger.success(`OmniRoute stopped (PID ${result.pid})`);
      return;
    }
    logger.warn(result.reason ?? 'OmniRoute is not running.');
  }
}
