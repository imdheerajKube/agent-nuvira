/**
 * Eval command — Run the Agent-Nuvira evaluation framework.
 *
 * Runs real end-to-end coding tasks through the full multi-agent pipeline
 * and grades them across 8 reliability metrics (completion, test pass,
 * time-to-fix, edit accuracy, token efficiency, rollbacks, dependency
 * installs, and recovery via new approaches).
 *
 * Usage:
 *   buff eval run                      — Run all eval tasks against default provider
 *   buff eval run --provider groq      — Run against a specific provider
 *   buff eval run --model llama-3.3    — Use a specific model
 *   buff eval run --tasks quick        — Run only quick tasks
 *   buff eval run --budget 0.50        — Stop if costs exceed $0.50
 *   buff eval list                     — List available eval tasks
 *   buff eval results                  — Show previous eval runs
 *   buff eval score                    — Show the scoring rules
 *   buff eval clear                    — Clear all eval data
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