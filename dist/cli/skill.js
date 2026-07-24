/**
 * SkillCommand — CLI interface for managing and running compiled skills.
 *
 * Subcommands:
 *   buff skill list            — List all compiled skills
 *   buff skill show <name>     — Show detailed skill definition
 *   buff skill run <name>      — Run a skill (directly invokes Orchestrator)
 *   buff skill compile         — Force skill compilation from trajectories
 *   buff skill search <query>  — Search skills by name/tag/description
 *   buff skill gc              — Garbage-collect low-quality skills
 *   buff skill quality         — Show skill quality and decay metrics
 *   buff skill clear           — Remove all skills
 */
import { Command } from 'commander';
import ora from 'ora';
import { getSkillStore } from '../learning/skill-store.js';
import { SkillCompiler } from '../learning/skill-compiler.js';
import { getSelfImprover } from '../learning/self-improver.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { printOrchestrationResult } from './execute.js';
import { ConfigManager } from '../config/manager.js';
import { ProviderFactory } from '../inference/factory.js';
import { logger } from '../utils/logger.js';
export class SkillCommand {
    configManager;
    constructor(configManager) {
        this.configManager = configManager ?? new ConfigManager();
    }
    create() {
        const cmd = new Command('skill')
            .description('Manage and run compiled skills — reusable execution plans derived from past trajectories');
        cmd
            .command('list')
            .description('List all compiled skills')
            .option('--quality <threshold>', 'Minimum quality threshold (0–1)', parseFloat)
            .action((opts) => this.listSkills(opts));
        cmd
            .command('show <name>')
            .description('Show detailed skill definition')
            .action((name) => this.showSkill(name));
        cmd
            .command('run <name>')
            .description('Run a skill — resolves parameters and invokes the multi-agent pipeline')
            .allowUnknownOption(true)
            .option('--params <params>', 'Comma-separated key=value parameters (e.g., "name=deploy,desc=A deploy command")')
            .option('-p, --provider <provider>', 'Inference provider for all agents')
            .option('-m, --model <model>', 'Model override for all agents')
            .option('-v, --verbose', 'Show detailed agent output', false)
            .option('--dry-run', 'Preview the task plan without executing', false)
            .option('--auto-route', 'Auto-route each step to the best model', false)
            .option('--memory', 'Enable persistent memory (learn from past execution)', false)
            .action(async (name, opts) => {
            await this.runSkill(name, opts);
        });
        cmd
            .command('compile')
            .description('Force skill compilation from stored trajectories')
            .option('--provider <provider>', 'Provider to use for LLM calls')
            .option('--model <model>', 'Model to use for compilation')
            .action((opts) => this.compileSkills(opts));
        cmd
            .command('search <query>')
            .description('Search skills by name, tag, or description')
            .action((query) => this.searchSkills(query));
        cmd
            .command('gc')
            .description('Garbage-collect low-quality skills')
            .option('-n, --dry-run', 'Show what would be removed without removing', false)
            .action((opts) => this.garbageCollect(opts));
        cmd
            .command('quality')
            .description('Show skill quality and decay metrics')
            .option('--details', 'Show detailed per-skill metrics', false)
            .action((opts) => this.showQuality(opts));
        cmd
            .command('clear')
            .description('Remove all compiled skills')
            .option('-f, --force', 'Skip confirmation prompt')
            .action((opts) => this.clearSkills(opts));
        return cmd;
    }
    // ── Action handlers ───────────────────────────────────────────────────
    listSkills(opts) {
        const store = getSkillStore();
        const all = store.getAll(opts.quality);
        console.log(SkillCompiler.formatSkillList(all));
        const summary = store.getSummary();
        if (summary.total > 0) {
            console.log('');
            console.log(`   Total invocations: ${summary.totalUsage}`);
            console.log(`   Average quality:   ${(summary.avgQualityScore * 100).toFixed(0)}%`);
        }
    }
    showSkill(nameOrId) {
        const store = getSkillStore();
        // Try direct ID match
        let skill = store.get(nameOrId);
        // Try search by name
        if (!skill) {
            const results = store.search(nameOrId);
            if (results.length > 0) {
                skill = results[0];
            }
        }
        if (!skill) {
            console.log(`🧠 Skill not found: '${nameOrId}'`);
            console.log('   Run `buff skill list` to see available skills.');
            return;
        }
        console.log(SkillCompiler.formatSkill(skill, true));
        console.log('');
        console.log('── Sources ──');
        console.log(`   Based on ${skill.sourceTrajectoryIds.length} trajectories`);
        console.log(`   Created: ${new Date(skill.createdAt).toLocaleDateString()}`);
        console.log(`   Last used: ${new Date(skill.lastUsedAt).toLocaleDateString()}`);
        console.log('');
        console.log('── Usage ──');
        console.log(`   Run: buff skill run "${skill.name}" --param1=value1 --param2=value2`);
    }
    async runSkill(name, opts) {
        const store = getSkillStore();
        // Find the skill
        let skill = store.get(name);
        if (!skill) {
            const results = store.search(name);
            if (results.length > 0) {
                skill = results[0];
            }
        }
        if (!skill) {
            console.log(`🧠 Skill not found: '${name}'`);
            console.log('   Run `buff skill list` to see available skills.');
            return;
        }
        // Parse parameters from --params option
        const params = {};
        if (opts.params) {
            for (const pair of opts.params.split(',')) {
                const eqIdx = pair.indexOf('=');
                if (eqIdx > 0) {
                    params[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
                }
            }
        }
        // Check for missing required parameters
        const missing = skill.parameters.filter((p) => p.required && !params[p.name]);
        if (missing.length > 0) {
            console.log(`🧠 Skill '${skill.name}' requires missing parameters:`);
            for (const p of missing) {
                console.log(`   --${p.name}=<value>  (${p.description})`);
            }
            return;
        }
        // Mark as used
        store.markUsed(skill.id);
        // Resolve parameter placeholders in prompt templates
        const prefillPlan = skill.steps.map((step, i) => {
            let description = step.promptTemplate || step.description;
            // Replace {{paramName}} with actual values
            for (const [key, value] of Object.entries(params)) {
                description = description.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
            }
            // Replace any remaining unset parameters with placeholders
            description = description.replace(/\{\{(\w+)\}\}/g, (_, pName) => {
                return params[pName] || `<${pName}>`;
            });
            return {
                id: `skill-step-${i}`,
                description,
                agentType: step.agentType,
                dependsOn: step.dependsOn.map((dep) => {
                    const match = dep.match(/^step-(\d+)$/);
                    return match ? `skill-step-${match[1]}` : dep;
                }),
                status: 'pending',
            };
        });
        // Build a descriptive goal from the skill name and parameters
        const paramSummary = Object.entries(params)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ');
        const goal = paramSummary
            ? `[Skill: ${skill.name}] ${paramSummary}`
            : `[Skill: ${skill.name}] ${skill.description}`;
        if (opts.verbose || opts.dryRun) {
            logger.info(`🧠 Skill: ${skill.name} v${skill.version}`);
            logger.info(`   ${skill.description}`);
            console.log('');
            logger.info(`   ${prefillPlan.length} step(s) prepared:`);
            for (const step of prefillPlan) {
                const shortDesc = step.description.length > 70
                    ? step.description.slice(0, 67) + '...'
                    : step.description;
                logger.info(`      [${step.agentType}] ${shortDesc}`);
            }
            if (opts.dryRun) {
                console.log('');
                console.log('   ── Pre-built Task Plan ──');
                console.log(JSON.stringify(prefillPlan, null, 2));
                console.log('');
                console.log('   (dry-run — no steps executed)');
                return;
            }
            console.log('');
            logger.info('Starting execution...');
            console.log('');
        }
        // ── Invoke the Orchestrator directly ─────────────────────────────────
        const spinner = ora({
            text: 'Executing skill...',
            spinner: 'dots',
        }).start();
        try {
            const orchestrator = new Orchestrator(this.configManager);
            const result = await orchestrator.execute(goal, {
                provider: opts.provider,
                model: opts.model,
                verbose: opts.verbose,
                dryRun: opts.dryRun,
                autoRouteModels: opts.autoRoute,
                useMemory: opts.memory,
                prefillPlan,
            });
            spinner.stop();
            // ── Display Results ──────────────────────────────────────────────────
            console.log('');
            printOrchestrationResult(result);
        }
        catch (err) {
            spinner.fail('Skill execution failed');
            logger.error(String(err));
        }
    }
    async compileSkills(opts) {
        console.log('🧠 Compiling skills from stored trajectories...\n');
        const providerType = (opts.provider || this.configManager.getAll().defaultProvider);
        const { config } = this.configManager.getProviderConfig(providerType);
        const provider = ProviderFactory.createProvider(providerType, config);
        const callLLM = async (prompt) => {
            const result = await provider.generate(prompt, {
                model: opts.model || config.model,
                temperature: 0.3,
                maxTokens: 4096,
            });
            return result;
        };
        const improver = getSelfImprover();
        const count = await improver.compileSkills(callLLM, true);
        improver.resetSkillCompilationCounter();
        if (count === 0) {
            console.log('\n   No skills compiled. Ensure you have high-scoring trajectories stored.');
            console.log('   Run some tasks with `--use-memory` to generate trajectories first.');
        }
    }
    searchSkills(query) {
        const store = getSkillStore();
        const results = store.search(query);
        if (results.length === 0) {
            console.log(`No skills found matching '${query}'.`);
            return;
        }
        console.log(SkillCompiler.formatSkillList(results));
    }
    garbageCollect(opts) {
        const store = getSkillStore();
        const qualityReport = store.getQualityReport();
        if (qualityReport.length === 0) {
            console.log('No skills to garbage-collect.');
            return;
        }
        // Show what would be removed
        const lowQuality = qualityReport.filter((q) => q.decayScore < 0.15);
        const totalBefore = qualityReport.length;
        if (opts.dryRun) {
            console.log(`🧠 Dry-run: ${lowQuality.length}/${totalBefore} skills below retention threshold\n`);
            for (const skill of lowQuality) {
                console.log(`   Would remove: ${skill.name} (decay: ${(skill.decayScore * 100).toFixed(0)}%, age: ${skill.ageDays}d)`);
            }
            if (lowQuality.length === 0) {
                console.log('   All skills are above retention threshold — nothing to remove.');
            }
            return;
        }
        const removed = store.garbageCollect(true);
        if (removed > 0) {
            console.log(`\n✅ Removed ${removed} low-quality skills.`);
        }
        else {
            console.log('No skills needed garbage collection.');
        }
    }
    showQuality(opts) {
        const store = getSkillStore();
        const summary = store.getSummary();
        if (summary.total === 0) {
            console.log('No skills compiled yet.');
            return;
        }
        console.log('🧠 Skill Quality Report\n');
        console.log(`   Total skills:     ${summary.total}`);
        console.log(`   Total invocations: ${summary.totalUsage}`);
        console.log(`   Average quality:   ${(summary.avgQualityScore * 100).toFixed(0)}%`);
        console.log(`   Oldest:           ${summary.oldestSkill}`);
        console.log(`   Newest:           ${summary.newestSkill}`);
        console.log('');
        if (summary.topTags.length > 0) {
            console.log('   Top tags:');
            for (const { tag, count } of summary.topTags.slice(0, 5)) {
                console.log(`      ${tag}: ${count} skill(s)`);
            }
            console.log('');
        }
        if (opts.details) {
            const qualityReport = store.getQualityReport();
            console.log('   Per-skill decay scores:');
            console.log('   ┌──────────────────────────────────┬────────────┬────────┬──────────┐');
            console.log('   │ Skill                            │ Decay      │ Uses   │ Age      │');
            console.log('   ├──────────────────────────────────┼────────────┼────────┼──────────┤');
            for (const q of qualityReport) {
                const name = q.name.padEnd(30).slice(0, 30);
                const decay = `${(q.decayScore * 100).toFixed(0)}%`.padStart(9);
                const uses = String(q.usageCount).padStart(7);
                const age = `${q.ageDays}d`.padStart(9);
                console.log(`   │ ${name} │ ${decay} │ ${uses} │ ${age} │`);
            }
            console.log('   └──────────────────────────────────┴────────────┴────────┴──────────┘');
        }
    }
    clearSkills(opts) {
        if (!opts.force) {
            logger.warn('Use `--force` to confirm removing all compiled skills.');
            logger.warn('This action cannot be undone.');
            return;
        }
        const store = getSkillStore();
        const before = store.getSummary().total;
        store.clear();
        logger.success(`Removed ${before} skills.`);
    }
}
//# sourceMappingURL=skill.js.map