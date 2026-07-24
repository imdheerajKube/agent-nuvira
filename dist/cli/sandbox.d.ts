/**
 * Sandbox command — Manage Docker sandbox isolation for code execution.
 *
 * Usage:
 *   buff sandbox status             — Check if Docker is available
 *   buff sandbox config             — Show current sandbox config
 *   buff sandbox config --enable    — Enable Docker sandbox mode
 *   buff sandbox config --disable   — Disable Docker sandbox mode
 *   buff sandbox config --memory 2g — Set memory limit
 *   buff sandbox config --cpu 2     — Set CPU limit
 *   buff sandbox config --network   — Enable network access
 *   buff sandbox config --image python:3.12-slim — Set sandbox image
 *   buff sandbox images             — List available pre-defined images
 *   buff sandbox run <command>      — Run a command inside a sandbox container
 *   buff sandbox cleanup            — Destroy all active sandbox containers
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class SandboxCommand extends BaseCommand {
    create(): Command;
    private showStatus;
    private manageConfig;
    private listImages;
    private runInSandbox;
    private cleanupAll;
}
//# sourceMappingURL=sandbox.d.ts.map