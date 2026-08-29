/**
 * Benchmark command — Run standardized model benchmarks against coding tasks.
 *
 * Usage:
 *   nuvira benchmark                      — Run all tasks against default provider
 *   nuvira benchmark --provider groq      — Run against a specific provider
 *   nuvira benchmark --model llama-3.3    — Use a specific model
 *   nuvira benchmark --tasks quick        — Run only quick tasks
 *   nuvira benchmark --budget 0.50        — Stop if costs exceed $0.50
 *   nuvira benchmark list                 — List available benchmark tasks
 *   nuvira benchmark results              — Show previous benchmark results
 *   nuvira benchmark results --last       — Show last run only
 *   nuvira benchmark results --compare    — Compare last two runs
 *   nuvira benchmark clear                — Clear all benchmark data
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class BenchmarkCommand extends BaseCommand {
    create(): Command;
    private runBenchmark;
    /**
     * Benchmark the exact provider/model pairs the Auto router would pick for the
     * benchmark tasks — closing the loop between routing decisions and measured
     * quality. Each distinct pick runs the (filtered) task suite; a final
     * comparison ranks the picks by quality score.
     */
    private runRoutingBenchmark;
    private listTasks;
    private showResults;
}
//# sourceMappingURL=benchmark.d.ts.map