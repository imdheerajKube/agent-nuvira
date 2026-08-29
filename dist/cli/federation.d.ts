/**
 * Federation command — Connect to and manage remote agent instances.
 *
 * Usage:
 *   nuvira federation status                — Show connection status and info
 *   nuvira federation start                 — Start the federation server
 *   nuvira federation start --port 8374     — Start on a specific port
 *   nuvira federation start --daemon        — Run in background (detached)
 *   nuvira federation connect <host>        — Connect to a remote server
 *   nuvira federation connect <host> --port 8374
 *   nuvira federation connect <host> --secret mykey
 *   nuvira federation disconnect            — Disconnect from remote server
 *   nuvira federation run <goal>            — Run a task on the remote server
 *   nuvira federation run <goal> --agent writer
 *   nuvira federation health                — Check remote server health
 *   nuvira federation a2a start             — Start the A2A server
 *   nuvira federation a2a discover <url>    — Discover an A2A agent
 *   nuvira federation a2a status <url>      — Check A2A agent health
 *   nuvira federation a2a run <url> <goal>  — Delegate task to A2A agent
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class FederationCommand extends BaseCommand {
    private client;
    create(): Command;
    private showStatus;
    private startServer;
    private connectToServer;
    private disconnectFromServer;
    private runRemoteTask;
    private checkHealth;
    private renderHealth;
    private manageConfig;
    private a2aDiscover;
    private a2aStartServer;
    private a2aStatus;
    private a2aRun;
}
//# sourceMappingURL=federation.d.ts.map