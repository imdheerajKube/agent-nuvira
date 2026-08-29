/**
 * Sandbox command — Manage Docker sandbox isolation for code execution.
 *
 * Usage:
 *   nuvira sandbox status             — Check if Docker is available
 *   nuvira sandbox config             — Show current sandbox config
 *   nuvira sandbox config --enable    — Enable Docker sandbox mode
 *   nuvira sandbox config --disable   — Disable Docker sandbox mode
 *   nuvira sandbox config --memory 2g — Set memory limit
 *   nuvira sandbox config --cpu 2     — Set CPU limit
 *   nuvira sandbox config --network   — Enable network access
 *   nuvira sandbox config --image python:3.12-slim — Set sandbox image
 *   nuvira sandbox images             — List available pre-defined images
 *   nuvira sandbox run <command>      — Run a command inside a sandbox container
 *   nuvira sandbox cleanup            — Destroy all active sandbox containers
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