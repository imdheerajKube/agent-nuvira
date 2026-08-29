/**
 * Eval command — Run the Agent-Nuvira evaluation framework.
 *
 * Runs real end-to-end coding tasks through the full multi-agent pipeline
 * and grades them across 8 reliability metrics (completion, test pass,
 * time-to-fix, edit accuracy, token efficiency, rollbacks, dependency
 * installs, and recovery via new approaches).
 *
 * Usage:
 *   nuvira eval run                      — Run all eval tasks against default provider
 *   nuvira eval run --provider groq      — Run against a specific provider
 *   nuvira eval run --model llama-3.3    — Use a specific model
 *   nuvira eval run --tasks quick        — Run only quick tasks
 *   nuvira eval run --budget 0.50        — Stop if costs exceed $0.50
 *   nuvira eval list                     — List available eval tasks
 *   nuvira eval results                  — Show previous eval runs
 *   nuvira eval score                    — Show the scoring rules
 *   nuvira eval clear                    — Clear all eval data
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class EvalCommand extends BaseCommand {
    create(): Command;
    /**
     * Evaluate the exact provider/model pairs the Auto router would pick for the
     * eval tasks — closing the loop between routing decisions and measured
     * reliability. Each distinct pick runs the (filtered) task suite; a final
     * comparison ranks the picks by composite score. Decisions are also recorded
     * to the routing-history store (audit trail + dashboard usage stats).
     */
    private runEvalRouting;
    private runEval;
    private listTasks;
    private showResults;
}
//# sourceMappingURL=eval.d.ts.map