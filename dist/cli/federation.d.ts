/**
 * Federation command — Connect to and manage remote agent instances.
 *
 * Usage:
 *   buff federation status                — Show connection status and info
 *   buff federation start                 — Start the federation server
 *   buff federation start --port 8374     — Start on a specific port
 *   buff federation start --daemon        — Run in background (detached)
 *   buff federation connect <host>        — Connect to a remote server
 *   buff federation connect <host> --port 8374
 *   buff federation connect <host> --secret mykey
 *   buff federation disconnect            — Disconnect from remote server
 *   buff federation run <goal>            — Run a task on the remote server
 *   buff federation run <goal> --agent writer
 *   buff federation health                — Check remote server health
 *   buff federation a2a start             — Start the A2A server
 *   buff federation a2a discover <url>    — Discover an A2A agent
 *   buff federation a2a status <url>      — Check A2A agent health
 *   buff federation a2a run <url> <goal>  — Delegate task to A2A agent
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