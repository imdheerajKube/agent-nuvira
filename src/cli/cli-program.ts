/**
 * The CLI DISPATCHER — builds the `commander` program and registers every
 * command. Split out of `router.ts` (2026-09-16) because that file held two
 * unrelated responsibilities:
 *
 *   1. `resolveProvider()` — a service imported by 17 modules (chat, execute,
 *      plan, the learning layer, the tool layer, …);
 *   2. `createCLI()` — this file's job, which must import all ~35 command
 *      modules.
 *
 * Keeping them together meant every command imported `router.ts` for the
 * service while `router.ts` imported every command back for the dispatcher —
 * a hub that put 28 modules (including `agents/orchestrator` and
 * `gateway/registry` through their own paths) into a single static import cycle.
 * Cycles are invisible in file review and break module load order, tree-shaking
 * and module-level test isolation.
 *
 * The rule this file establishes: a module that imports commands is a LEAF. It
 * may be imported by the process entry point (`src/index.ts`) and by nothing
 * else. Services live in their own modules (`router.ts`) and never reach back
 * into the command layer.
 *
 * Verified with `node scripts/check-import-cycles.mjs`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { ChatCommand } from './chat.js';
import { EditCommand } from './edit.js';
import { PlanCommand } from './plan.js';
import { ConfigCommand } from './config.js';
import { CacheCommand } from './cache.js';
import { ModelsCommand } from './models.js';
import { ModelCommand } from './model.js';
import { ExecuteCommand } from './execute.js';
import { RunCommand } from './run.js';
import { WorkflowCommand } from './workflow.js';
import { PluginsCommand } from './plugins.js';
import { LearnCommand } from './learn.js';
import { InitCommand } from './init.js';
import { StatsCommand } from './stats.js';
import { HistoryCommand } from './history.js';
import { SessionCommand } from './session.js';
import { SkillCommand } from './skill.js';
import { SkillsCommand } from './skills.js';
import { GatewayCommand } from './gateway.js';
import { WhatsAppCommand } from './whatsapp.js';
import { BenchmarkCommand } from './benchmark.js';
import { EvalCommand } from './eval.js';
import { SandboxCommand } from './sandbox.js';
import { DoctorCommand } from './doctor.js';
import { MemoryCommand } from './memory.js';
import { DashboardCommand } from './dashboard.js';
import { AgentCommand } from './agent.js';
import { FederationCommand } from './federation.js';
import { TeamCommand } from './team.js';
import { SDKCommand } from './sdk.js';
import { ProviderCommand } from './provider.js';
import { SecurityCommand } from './security.js';
import { AuditCommand } from './audit.js';
import { SbomCommand } from './sbom.js';
import { AdminCommand } from './admin.js';
import { FeedbackCommand } from './feedback.js';
import { MarketplaceCommand } from './marketplace.js';
import { MCPCommand } from './mcp.js';
import { CICommand } from './ci.js';
import { PublishCommand } from './publish.js';
import { PhaseCommand } from './phase.js';
import { RetrievalCommand } from './retrieval.js';
import { TraceCommand } from './trace.js';
import { BedrockCommand } from './bedrock.js';
import { NluCommand } from './nlu.js';
import { IntentCommand } from './intent.js';
import { CodeMapCommand } from './code-map.js';
import { ToolsCommand } from './tools.js';

/** Read version from package.json at build time */
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'));

/**
 * Create and configure the CLI program
 */
export function createCLI(): Command {
  const program = new Command();

  // Detect invocation name: 'nuvira' or 'agent-nuvira'.
  //
  // The product is agent-nuvira, so every help line, usage string and error
  // hint says `nuvira`. This used to default to the legacy `buff` alias, which
  // meant a plain `--help` announced the wrong product name on every install.
  const invoker = (() => {
    const arg0 = process.argv[1] || '';
    if (/nuvira/i.test(arg0)) return 'nuvira';
    if (/agent-nuvira/i.test(arg0)) return 'agent-nuvira';
    return 'nuvira';
  })();

  // Expose detected name so all CLI commands can use it in help text
  process.env.NUVIRA_CLI_NAME = invoker;

  program
    .name(invoker)
    .description('Nuvira — multi-agent AI coding CLI (local models & cloud APIs)')
    .version(pkg.version);

  // Global options
  //
  // `-t, --task <text>` is a ROOT-LEVEL shorthand for a one-shot agent turn.
  // Why it lives here as well as on `plan`: `-t/--task` is the natural flag for
  // "here is my task", so users type `nuvira -t "<task>"` — but the option is
  // declared on the `plan` subcommand, so commander parsed a root-level `-t`
  // before ever reaching it and died with its terse `error: unknown option
  // '-t'`. The root flag now dispatches through the REAL chat command (below),
  // so it behaves exactly like `nuvira chat "<task>"`.
  program
    .option('-d, --debug', 'Enable debug logging')
    .option('-t, --task <text>', 'Run one task through the agent (shorthand for `chat "<task>"`)');

  // An unrecognized flag must never be a dead end — print the error and then
  // the usage, so the next command is discoverable from the failure itself.
  program.showHelpAfterError(`(run \`${invoker} --help\` for the command list)`);

  // Register commands
  const chatCmd = new ChatCommand();
  const editCmd = new EditCommand();
  const planCmd = new PlanCommand();
  const adminCmd = new AdminCommand();
  const configCmd = new ConfigCommand();
  const cacheCmd = new CacheCommand();
  const modelsCmd = new ModelsCommand();
  const executeCmd = new ExecuteCommand();

  program.addCommand(adminCmd.create());
  program.addCommand(chatCmd.create());
  program.addCommand(editCmd.create());
  program.addCommand(planCmd.create());
  program.addCommand(configCmd.create());
  program.addCommand(cacheCmd.create());
  program.addCommand(modelsCmd.create());
  program.addCommand(executeCmd.create());

  const runCmd = new RunCommand();
  program.addCommand(runCmd.create());

  const workflowCmd = new WorkflowCommand();
  program.addCommand(workflowCmd.create());

  const whatsappCmd = new WhatsAppCommand();
  program.addCommand(whatsappCmd.create());

  const pluginsCmd = new PluginsCommand();
  program.addCommand(pluginsCmd.create());

  const learnCmd = new LearnCommand();
  program.addCommand(learnCmd.create());

  // Register new Phase 1 commands
  const initCmd = new InitCommand();
  program.addCommand(initCmd.create());

  const statsCmd = new StatsCommand();
  program.addCommand(statsCmd.create());

  const historyCmd = new HistoryCommand();
  program.addCommand(historyCmd.create());

  // Register Skill commands (Phase 1 enhancement)
  const skillCmd = new SkillCommand();
  program.addCommand(skillCmd.create());

  // Register Skills hub command (J3 — community skills search/install/update)
  const skillsCmd = new SkillsCommand();
  program.addCommand(skillsCmd.create());

  // Register Gateway command (J1 — multi-channel Telegram/Discord/Slack/WhatsApp)
  const gatewayCmd = new GatewayCommand();
  program.addCommand(gatewayCmd.create());

  // Register Model command (Phase 1.2: model switching)
  const modelCmd = new ModelCommand();
  program.addCommand(modelCmd.create());

  // Register Phase 2 commands
  const benchmarkCmd = new BenchmarkCommand();
  program.addCommand(benchmarkCmd.create());

  // Register evaluation framework command
  const evalCmd = new EvalCommand();
  program.addCommand(evalCmd.create());

  const sandboxCmd = new SandboxCommand();
  program.addCommand(sandboxCmd.create());

  // Register Phase 2.5 new commands
  const doctorCmd = new DoctorCommand();
  program.addCommand(doctorCmd.create());

  const memoryCmd = new MemoryCommand();
  program.addCommand(memoryCmd.create());

  // Register Phase 3.3 new commands
  const dashboardCmd = new DashboardCommand();
  program.addCommand(dashboardCmd.create());

  const agentCmd = new AgentCommand();
  program.addCommand(agentCmd.create());

  const federationCmd = new FederationCommand();
  program.addCommand(federationCmd.create());

  const teamCmd = new TeamCommand();
  program.addCommand(teamCmd.create());

  // Register Phase 3.6 commands
  const sdkCmd = new SDKCommand();
  program.addCommand(sdkCmd.create());

  // Register Provider command (from nextlevel roadmap)
  const providerCmd = new ProviderCommand();
  program.addCommand(providerCmd.create());

  // Register Security command (from nextlevel roadmap §4.1)
  const securityCmd = new SecurityCommand();
  program.addCommand(securityCmd.create());

  const auditCmd = new AuditCommand();
  program.addCommand(auditCmd.create());

  const sbomCmd = new SbomCommand();
  program.addCommand(sbomCmd.create());

  // Register Feedback command (from nextlevel roadmap §4.3)
  const feedbackCmd = new FeedbackCommand();
  program.addCommand(feedbackCmd.create());

  // Register C3 NLU command + the plain-English → CLI intent router
  program.addCommand(new NluCommand().create());
  program.addCommand(new IntentCommand().create());
  program.addCommand(new CodeMapCommand().create());
  program.addCommand(new ToolsCommand().create());

  // Register G1 session command (D1 debug surface)
  program.addCommand(new SessionCommand().create());

  // Register Marketplace command (from nextlevel roadmap §5.3)
  const marketplaceCmd = new MarketplaceCommand();
  program.addCommand(marketplaceCmd.create());

  // Register MCP command (Phase 4.1 — Model Context Protocol)
  const mcpCmd = new MCPCommand();
  program.addCommand(mcpCmd.create());

  // Register CI command (Phase 4.5 — Headless CI/CD mode)
  const ciCmd = new CICommand();
  program.addCommand(ciCmd.create());

  // Register Publish command (Autonomous publish workflow)
  const publishCmd = new PublishCommand();
  program.addCommand(publishCmd.create());

  // Register Bedrock command (dedicated AWS Bedrock onboarding)
  const bedrockCmd = new BedrockCommand();
  program.addCommand(bedrockCmd.create());

  // Register Phase command (Phase-wise scope execution)
  const phaseCmd = new PhaseCommand();
  program.addCommand(phaseCmd.create());

  // Register Retrieval command (vectorized token-efficient context)
  const retrievalCmd = new RetrievalCommand();
  program.addCommand(retrievalCmd.create());

  // Register Trace command (P0 reasoning-trace capture + replay)
  const traceCmd = new TraceCommand();
  program.addCommand(traceCmd.create());

  // Default action: a root `-t/--task` runs the task; otherwise show help.
  program.action(async (options?: { task?: string }) => {
    const task = typeof options?.task === 'string' ? options.task.trim() : '';
    if (task) {
      // Dispatch through the chat command itself (a fresh, standalone Command)
      // rather than duplicating the one-shot path: provider resolution, auto
      // failover, followups and history behave byte-identically.
      await chatCmd.create().parseAsync([process.argv[0], `${invoker} chat`, task]);
      return;
    }
    program.help();
  });

  return program;
}
