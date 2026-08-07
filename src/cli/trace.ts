/**
 * Trace command — inspect and replay per-step reasoning traces (assessment P0).
 *
 * Every multi-agent pipeline records each LLM call (agent × model × prompt
 * digest × response × tokens × latency × routing snapshot) into
 * ~/.buff/memory/reasoning-traces.json. This command lets you:
 *
 *   buff trace list               — Show recent traces
 *   buff trace show <id>          — Show one trace (steps summary)
 *   buff trace replay <id>        — Step-by-step replay of a trace
 *   buff trace clear              — Delete all traces
 *
 * The `replay` command is the debugging centerpiece: it walks every LLM call
 * in execution order with the prompt digest, the model that handled it, token
 * usage, latency, and the Auto-router decision snapshot — so you can see why
 * an agent's reasoning went a particular way (the "semantic visibility" gap
 * the assessment P0 closes).
 */

import { Command } from 'commander';
import { getTrace, listTraces, clearTraces, getTraceStats } from '../learning/reasoning-trace.js';

export class TraceCommand {
  create(): Command {
    const command = new Command('trace')
      .description('Inspect and replay per-step reasoning traces (every LLM call in a pipeline)');

    command
      .command('list')
      .description('Show recent traces')
      .option('-l, --limit <number>', 'Maximum traces to show', parseInt, 10)
      .action((opts?: { limit?: number }) => this.listTraces(opts?.limit ?? 10));

    command
      .command('show')
      .description('Show a single trace (goal, timing, step summary)')
      .argument('<id>', 'Trace id (e.g. trace-1712345678-abc123)')
      .action((id: string) => this.showTrace(id));

    command
      .command('replay')
      .description('Step-by-step replay of a trace — every LLM call with prompt digest, model, tokens, latency, and routing')
      .argument('<id>', 'Trace id (e.g. trace-1712345678-abc123)')
      .option('-f, --full', 'Show full prompt/response previews (default: truncated)', false)
      .action((id: string, opts?: { full?: boolean }) => this.replayTrace(id, !!opts?.full));

    command
      .command('clear')
      .description('Delete all stored traces')
      .action(() => this.clear());

    return command;
  }

  // ── Action handlers ───────────────────────────────────────────────────

  private listTraces(limit: number): void {
    const traces = listTraces(limit);
    const stats = getTraceStats();

    console.log(`🔍 Reasoning Traces — ${stats.total} trace(s), ${stats.totalSteps} LLM call(s) recorded\n`);
    console.log(`   Total estimated tokens: ${stats.totalTokens.toLocaleString()}`);
    console.log(`   Avg per-call latency:   ${stats.avgLatencyMs}ms`);
    console.log('');

    if (traces.length === 0) {
      console.log('   No traces yet. Run `buff execute` (or auto-routed chat) — every LLM call is recorded.');
      console.log('   Trace file: ~/.buff/memory/reasoning-traces.json');
      return;
    }

    for (const trace of traces) {
      const successIcon = trace.success === true ? '✅' : trace.success === false ? '❌' : '⏳';
      const duration = trace.durationMs !== undefined ? `${(trace.durationMs / 1000).toFixed(1)}s` : 'running…';
      const started = new Date(trace.startedAt).toLocaleString();
      const agents = [...new Set(trace.steps.map((s) => s.agentType))].join(', ');
      console.log(`   ${successIcon} ${trace.id}`);
      console.log(`      ${trace.goal.slice(0, 90)}`);
      console.log(`      ${trace.steps.length} call(s) · ${duration} · started ${started}`);
      if (agents) console.log(`      agents: ${agents}`);
      console.log('');
    }

    console.log('   Run `buff trace replay <id>` to step through a trace.');
  }

  private showTrace(id: string): void {
    const trace = getTrace(id);
    if (!trace) {
      console.log(`❌ Trace not found: ${id}`);
      console.log('   Run `buff trace list` to see available traces.');
      return;
    }

    const status = trace.success === true ? '✅ success' : trace.success === false ? '❌ failed' : '⏳ in progress';
    console.log(`🔍 Trace ${id} — ${status}\n`);
    console.log(`   Goal:     ${trace.goal}`);
    console.log(`   Started:  ${new Date(trace.startedAt).toLocaleString()}`);
    if (trace.endedAt) console.log(`   Ended:    ${new Date(trace.endedAt).toLocaleString()}`);
    if (trace.durationMs !== undefined) console.log(`   Duration: ${(trace.durationMs / 1000).toFixed(1)}s`);
    if (trace.provider) console.log(`   Provider: ${trace.provider}`);
    if (trace.model) console.log(`   Model:    ${trace.model}`);
    console.log(`   Steps:    ${trace.steps.length} LLM call(s)`);
    console.log('');

    if (trace.steps.length === 0) {
      console.log('   No LLM calls recorded in this trace.');
      return;
    }

    console.log('   ── Step summary ──');
    for (const step of trace.steps) {
      const icon = step.success ? '✅' : '❌';
      const routing = step.routing
        ? ` [auto → ${step.routing.provider}/${step.routing.model}]`
        : '';
      console.log(
        `   ${String(step.seq).padStart(3)}. ${icon} ${step.agentType.padEnd(16)} ${step.provider}/${step.model}${routing}`,
      );
      console.log(`       ${(step.latencyMs / 1000).toFixed(2)}s · ${step.inputTokens} in / ${step.outputTokens} out tok · digest ${step.promptDigest}`);
      if (step.description && step.description.length > 110) {
        console.log(`       ${step.description.slice(0, 110)}…`);
      } else if (step.description) {
        console.log(`       ${step.description}`);
      }
      if (step.error) console.log(`       ⚠️ ${step.error.slice(0, 120)}`);
    }
    console.log('');
    console.log('   Run `buff trace replay <id>` for the full step-by-step reasoning replay.');
  }

  private replayTrace(id: string, full: boolean): void {
    const trace = getTrace(id);
    if (!trace) {
      console.log(`❌ Trace not found: ${id}`);
      console.log('   Run `buff trace list` to see available traces.');
      return;
    }

    const status = trace.success === true ? '✅ success' : trace.success === false ? '❌ failed' : '⏳ in progress';
    console.log('═'.repeat(72));
    console.log(`  REASONING TRACE REPLAY — ${trace.id} ${status}`);
    console.log('═'.repeat(72));
    console.log(`  Goal:      ${trace.goal}`);
    console.log(`  Started:   ${new Date(trace.startedAt).toLocaleString()}`);
    console.log(`  Duration:  ${trace.durationMs !== undefined ? (trace.durationMs / 1000).toFixed(1) + 's' : 'running…'}`);
    console.log(`  Total:     ${trace.steps.length} LLM call(s)`);
    console.log('');

    if (trace.steps.length === 0) {
      console.log('  (no LLM calls recorded)');
      return;
    }

    for (const step of trace.steps) {
      const previewChars = full ? 800 : 240;
      console.log('─'.repeat(72));
      console.log(`  STEP ${step.seq}/${trace.steps.length} — ${step.agentType}`);
      console.log(`  Model:     ${step.provider}/${step.model}`);
      if (step.taskId) console.log(`  Task:      ${step.taskId}`);
      if (step.description) console.log(`  Task desc: ${step.description.slice(0, 140)}`);
      console.log(`  Result:    ${step.success ? '✅ ok' : '❌ failed'} · ${(step.latencyMs / 1000).toFixed(2)}s · ${step.inputTokens} in / ${step.outputTokens} out tok`);
      if (step.error) console.log(`  Error:     ${step.error.slice(0, 200)}`);
      if (step.routing) {
        console.log(`  Routing:   🤖 auto → ${step.routing.provider}/${step.routing.model} (score ${step.routing.score.toFixed(3)}, ${step.routing.complexity})`);
        if (step.routing.explanation) {
          console.log(`             ${step.routing.explanation.slice(0, 180)}`);
        }
      }
      console.log(`  Prompt:    digest ${step.promptDigest} (${step.promptPreview.length}+ chars)`);
      if (step.promptPreview) {
        console.log(`  ┌─ prompt preview ─────────────────────────────`);
        console.log(`  │ ${step.promptPreview.split('\n').slice(0, 6).join('\n  │ ').slice(0, previewChars)}`);
        console.log('  └──────────────────────────────────────────────');
      }
      if (step.responsePreview) {
        console.log(`  ┌─ response (${step.responseLength} chars total) ───────────────`);
        console.log(`  │ ${step.responsePreview.split('\n').slice(0, 8).join('\n  │ ').slice(0, previewChars)}`);
        console.log('  └──────────────────────────────────────────────');
      }
      console.log('');
    }
    console.log('═'.repeat(72));
    console.log('  End of replay.');
  }

  private clear(): void {
    clearTraces();
    console.log('🗑️  All reasoning traces cleared.');
  }
}
