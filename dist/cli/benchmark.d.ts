/**
 * Benchmark command — Run standardized model benchmarks against coding tasks.
 *
 * Usage:
 *   buff benchmark                      — Run all tasks against default provider
 *   buff benchmark --provider groq      — Run against a specific provider
 *   buff benchmark --model llama-3.3    — Use a specific model
 *   buff benchmark --tasks quick        — Run only quick tasks
 *   buff benchmark --budget 0.50        — Stop if costs exceed $0.50
 *   buff benchmark list                 — List available benchmark tasks
 *   buff benchmark results              — Show previous benchmark results
 *   buff benchmark results --last       — Show last run only
 *   buff benchmark results --compare    — Compare last two runs
 *   buff benchmark clear                — Clear all benchmark data
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class BenchmarkCommand extends BaseCommand {
    create(): Command;
    private runBenchmark;
    private listTasks;
    private showResults;
}
//# sourceMappingURL=benchmark.d.ts.map