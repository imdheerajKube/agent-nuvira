/**
 * Trace command — inspect and replay per-step reasoning traces (assessment P0).
 *
 * Every multi-agent pipeline records each LLM call (agent × model × prompt
 * digest × response × tokens × latency × routing snapshot) into
 * ~/.nuvira/memory/reasoning-traces.json. This command lets you:
 *
 *   nuvira trace list               — Show recent traces
 *   nuvira trace show <id>          — Show one trace (steps summary)
 *   nuvira trace replay <id>        — Step-by-step replay of a trace
 *   nuvira trace clear              — Delete all traces
 *
 * The `replay` command is the debugging centerpiece: it walks every LLM call
 * in execution order with the prompt digest, the model that handled it, token
 * usage, latency, and the Auto-router decision snapshot — so you can see why
 * an agent's reasoning went a particular way (the "semantic visibility" gap
 * the assessment P0 closes).
 */
import { Command } from 'commander';
export declare class TraceCommand {
    create(): Command;
    private listTraces;
    private showTrace;
    private replayTrace;
    private clear;
}
//# sourceMappingURL=trace.d.ts.map