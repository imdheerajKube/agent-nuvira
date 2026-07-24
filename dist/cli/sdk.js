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
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import { scaffold, listTemplates } from '../agent-sdk/src/scaffold.js';
import { registerAgent, unregisterAgent } from '../agent-sdk/src/register.js';
// ─── SDKCommand ─────────────────────────────────────────────────────────────
export class SDKCommand extends BaseCommand {
    create() {
        const command = new Command('sdk')
            .description('Create and manage custom agents with the Agent-Baba-D SDK');
        // ── scaffold subcommand ─────────────────────────────────────────────
        const scaffoldCmd = new Command('scaffold')
            .description('Generate a new custom agent project')
            .argument('<outDir>', 'Output directory for the new agent project')
            .argument('<agentName>', 'Agent class name in PascalCase (e.g. CodeFormatter)')
            .argument('[description]', 'Description of what the agent does', 'A custom agent')
            .option('-t, --template <template>', 'Template type: basic-agent, full-agent, or agent-pack', 'full-agent')
            .option('--agent-type <type>', 'Agent type identifier for task plans (default: kebab-case of name)')
            .action(async (outDir, agentName, description, options) => {
            await this.handleScaffold(outDir, agentName, description, options);
        });
        command.addCommand(scaffoldCmd);
        // ── templates subcommand ────────────────────────────────────────────
        const templatesCmd = new Command('templates')
            .description('List available scaffold templates')
            .action(() => {
            this.handleListTemplates();
        });
        command.addCommand(templatesCmd);
        // ── info subcommand ────────────────────────────────────────────
        const infoCmd = new Command('info')
            .description('Show SDK package info and version')
            .action(() => {
            this.handleInfo();
        });
        command.addCommand(infoCmd);
        // ── register subcommand ─────────────────────────────────────────
        const registerCmd = new Command('register')
            .description('Register a custom agent with the orchestrator')
            .argument('<className>', 'Exported class name (e.g. CodeFormatter)')
            .argument('<agentType>', 'Agent type for task plans (e.g. code-formatter)')
            .argument('<sourceModule>', 'Import module path relative to orchestrator.ts (e.g. ./agents/my-agent.js)')
            .option('-i, --icon <emoji>', 'Emoji icon for the agent (default: 🧩)', '🧩')
            .option('--orchestrator-path <path>', 'Path to orchestrator.ts (auto-detected if not set)')
            .action(async (className, agentType, sourceModule, options) => {
            await this.handleRegister(className, agentType, sourceModule, options);
        });
        command.addCommand(registerCmd);
        // ── unregister subcommand ───────────────────────────────────────
        const unregisterCmd = new Command('unregister')
            .description('Remove a custom agent from the orchestrator')
            .argument('<agentType>', 'Agent type to remove (e.g. code-formatter)')
            .option('--orchestrator-path <path>', 'Path to orchestrator.ts (auto-detected if not set)')
            .action(async (agentType, options) => {
            await this.handleUnregister(agentType, options);
        });
        command.addCommand(unregisterCmd);
        return command;
    }
    // ─── Handlers ─────────────────────────────────────────────────────────
    async handleScaffold(outDir, agentName, description, options) {
        const resolvedDir = join(process.cwd(), outDir);
        // Validate template
        const validTemplates = listTemplates().map((t) => t.name);
        const template = options.template || 'full-agent';
        if (!validTemplates.includes(template)) {
            logger.error(`Unknown template: "${template}". Valid templates: ${validTemplates.join(', ')}`);
            return;
        }
        // Validate agent name
        if (!agentName.match(/^[A-Z][a-zA-Z0-9]*$/)) {
            logger.error(`Invalid agent name "${agentName}". Must be in PascalCase (e.g. "CodeFormatter", "MyAgent").`);
            return;
        }
        if (existsSync(resolvedDir)) {
            logger.error(`Output directory already exists: ${resolvedDir}`);
            return;
        }
        logger.info(`Generating ${template} agent: ${agentName}...`);
        try {
            const files = scaffold({
                outDir: resolvedDir,
                agentName,
                description: description || 'A custom agent',
                template: template,
                agentType: options.agentType,
            });
            logger.success(`Created ${files.length} files in ${outDir}/`);
            console.log('');
            for (const file of files) {
                const relativePath = file.replace(resolvedDir, '').replace(/^\//, '');
                console.log(`   📄 ${relativePath}`);
            }
            console.log('');
            logger.success('Next steps:');
            console.log('');
            console.log(`   cd ${outDir}`);
            console.log('   npm install');
            console.log('   npm run build');
            console.log('   npm test');
            console.log('');
            logger.info('To register this agent with the orchestrator, add it to the createAgent() switch in src/agents/orchestrator.ts');
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`Failed to scaffold agent: ${msg}`);
        }
    }
    handleListTemplates() {
        const templates = listTemplates();
        logger.highlight('Available scaffold templates:');
        console.log('');
        for (const t of templates) {
            console.log(`   ${t.name}`);
            console.log(`      ${t.description}`);
            console.log('');
        }
        logger.info('Use: buff sdk scaffold <outDir> <agentName> [description] --template <name>');
    }
    handleInfo() {
        logger.highlight('@agent-baba-d/sdk');
        console.log('');
        console.log('   Build custom agents for the Agent-Baba-D multi-agent system.');
        console.log('');
        console.log('   Subcommands:');
        console.log('     scaffold    Generate a new custom agent project');
        console.log('     templates   List available scaffold templates');
        console.log('     info        Show this information');
        console.log('');
        console.log('   Entry points:');
        console.log('     @agent-baba-d/sdk              Base Agent class + core types');
        console.log('     @agent-baba-d/sdk/testing      Testing utilities');
        console.log('');
        console.log('   API Docs: https://github.com/imdheerajKube/agent-baba-d');
    }
    async handleRegister(className, agentType, sourceModule, options) {
        // Validate className (must be PascalCase)
        if (!className.match(/^[A-Z][a-zA-Z0-9]*$/)) {
            logger.error(`Invalid class name "${className}". Must be in PascalCase (e.g. "CodeFormatter").`);
            return;
        }
        // Validate agentType (must be kebab-case)
        if (!agentType.match(/^[a-z][a-z0-9-]*$/)) {
            logger.error(`Invalid agent type "${agentType}". Must be kebab-case (e.g. "code-formatter").`);
            return;
        }
        logger.info(`Registering agent '${agentType}' (${className}) from ${sourceModule}...`);
        const result = registerAgent({
            sourceModule,
            className,
            agentType,
            icon: options.icon,
            orchestratorPath: options.orchestratorPath,
        });
        if (result.success) {
            logger.success(result.message);
            if (result.modifiedFiles.length > 0) {
                console.log('');
                logger.success('Next steps:');
                console.log('');
                console.log('   Add the agent to a task plan in your workflow or CLI command:');
                console.log(`     { agentType: '${agentType}', description: '...', dependsOn: [] }`);
                console.log('');
                console.log('   Or use it directly in a goal:');
                console.log(`     buff execute "Run ${agentType} on the project"`);
            }
        }
        else {
            logger.error(result.message);
        }
    }
    async handleUnregister(agentType, options) {
        logger.info(`Unregistering agent '${agentType}'...`);
        const result = unregisterAgent({
            agentType,
            orchestratorPath: options.orchestratorPath,
        });
        if (result.success) {
            logger.success(result.message);
        }
        else {
            logger.error(result.message);
        }
    }
}
//# sourceMappingURL=sdk.js.map