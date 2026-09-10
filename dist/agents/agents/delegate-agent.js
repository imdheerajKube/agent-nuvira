/**
 * H2 — DelegateAgent (`src/agents/agents/delegate-agent.ts`).
 *
 * The MODULE-REGISTRY side of H2 (acceptance: "a plan step can delegate to 3
 * sub-agents in parallel and render each live lane"). When the planner (or a
 * workflow template) emits a task step whose agentType is `delegate` and whose
 * `delegation` array carries sub-agent specs, the orchestrator runs this agent:
 * it fans the specs out in parallel via `spawnSubagents` (each with a FRESH
 * isolated context) and aggregates the summary results into a single
 * AgentResult. The parent task line renders on the board alongside the live
 * delegation lanes.
 *
 * Kept in its OWN file (not inside `tools/delegation.ts`) with a lazy dynamic
 * import of `spawnSubagents` so there is NO import cycle: the ModuleRegistry
 * imports this agent, and `tools/delegation.ts` imports the ModuleRegistry.
 * Same convention as `tools/registry.ts`' deferred imports.
 */
import { Agent } from '../agent.js';
export class DelegateAgent extends Agent {
    name = 'Delegate';
    description = 'Fans out sub-agent delegation specs (taskStep.delegation) in parallel with fresh isolated contexts and aggregates their summary results';
    /**
     * Registry override for tests (matches the codebase pattern of public
     * agent-instance fields, like `currentTaskId`). Production leaves this
     * unset so spawnSubagents resolves the global ModuleRegistry.
     */
    delegationRegistry;
    async execute(context, callLLM) {
        // Find the OWN task step in the shared plan. The orchestrator sets the
        // per-INSTANCE `currentTaskId` field (race-free under parallel batches —
        // the shared vault metadata would be overwritten by concurrent tasks).
        // The metadata fallback only serves direct-call tests.
        const taskId = this.currentTaskId ?? context.metadata.currentTaskId;
        const step = context.taskPlan.find((s) => s.id === taskId);
        const specs = step?.delegation;
        if (!specs || specs.length === 0) {
            return {
                success: false,
                summary: 'Delegate step has no delegation specs',
                error: `Task step '${taskId || '?'}' has no delegation array — add taskStep.delegation to fan out sub-agents.`,
            };
        }
        this.report(context, 'delegating', `Delegating ${specs.length} sub-agent task(s) in parallel…`);
        // Lazy import: breaks the module-registry ⇄ delegation cycle.
        const { spawnSubagents } = await import('../tools/delegation.js');
        // Registry override seam: tests inject a registry with fake sub-agents via
        // context.metadata.delegationRegistry; production uses the global registry
        // (the same one the orchestrator resolves all agents through).
        const registry = context.metadata.delegationRegistry ?? this.delegationRegistry;
        const results = await spawnSubagents(specs, {
            callLLM,
            cwd: context.workingDirectory,
            ...(registry ? { registry } : {}),
        });
        const succeeded = results.filter((r) => r.success).length;
        const lines = results.map((r) => `  ${r.success ? '✅' : '❌'} ${r.agentType}: ${(r.summary || r.error || 'done').slice(0, 120)}`);
        const allOk = succeeded === results.length;
        if (allOk) {
            return {
                success: true,
                summary: `${succeeded}/${results.length} sub-agent(s) succeeded`,
                details: lines.join('\n'),
            };
        }
        // Partial or total failure — surface WHICH sub-agents failed so the user
        // (and the repair path) can act on specifics, never a blanket failure.
        return {
            success: succeeded > 0, // soft-success when SOME sub-agents delivered
            summary: `${succeeded}/${results.length} sub-agent(s) succeeded`,
            details: lines.join('\n'),
            error: succeeded === 0
                ? 'All delegated sub-agents failed'
                : `${results.length - succeeded} delegated sub-agent(s) failed`,
        };
    }
}
//# sourceMappingURL=delegate-agent.js.map