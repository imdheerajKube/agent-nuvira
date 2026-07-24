/**
 * SDK Command — Create and manage custom agents with the Agent-Baba-D SDK.
 *
 * Usage:
 *   buff sdk scaffold <outDir> <agentName> [description]  — Generate a new agent project
 *   buff sdk scaffold --template basic-agent ...            — Use a minimal template
 *   buff sdk scaffold --template agent-pack ...             — Multi-agent package template
 *   buff sdk templates                                     — List available templates
 *   buff sdk info                                          — Show SDK package info
 *
 * The scaffold subcommand creates a complete, ready-to-extend agent package with:
 * - TypeScript configuration
 * - A custom agent class extending Agent
 * - Unit tests using the SDK testing utilities
 * - Package.json with build/test scripts
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class SDKCommand extends BaseCommand {
    create(): Command;
    private handleScaffold;
    private handleListTemplates;
    private handleInfo;
    private handleRegister;
    private handleUnregister;
}
//# sourceMappingURL=sdk.d.ts.map