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
 *   nuvira trace degraded           — Pair(s) that served steps without agentic capability
 *   nuvira trace clear              — Delete all traces
 *
 * The `replay` command is the debugging centerpiece: it walks every LLM call
 * in execution order with the prompt digest, the model that handled it, token
 * usage, latency, and the Auto-router decision snapshot — so you can see why
 * an agent's reasoning went a particular way (the "semantic visibility" gap
 * the assessment P0 closes).
 */

import { Command } from 'commander';
import { formatCount } from '../utils/format.js';
import {
  getTrace,
  listTraces,
  clearTraces,
  getTraceStats,
  degradedCallsFromTraces,
  MAX_TRACES,
  type TraceEvent,
} from '../learning/reasoning-trace.js';

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
      .command('degraded')
      .description('List provider × model pairs that served steps without agentic capability (derived, read-only, from the traces)')
      .option('-l, --limit <number>', 'Maximum traces to scan', parseInt, MAX_TRACES)
      .action((opts?: { limit?: number }) => this.degraded(opts?.limit ?? MAX_TRACES));

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
    console.log(`   Total estimated tokens: ${formatCount(stats.totalTokens)}`);
    console.log(`   Avg per-call latency:   ${stats.avgLatencyMs}ms`);
    // G18 — the non-LLM half: what the loops actually DID (tool calls, gate
    // decisions) and what they DECLINED. Reported at the top level because
    // "0 refusals" used to be unanswerable: the store could not see refusals at
    // all, so it could not tell "none were declined" from "nothing is looking".
    console.log(
      `   Events:                 ${stats.totalEvents} (${stats.gateDecisions} gate decision(s), ${stats.refusals} refusal(s))`,
    );
    console.log('');

    if (traces.length === 0) {
      console.log('   No traces yet. Run `${getCliName()} execute` (or auto-routed chat) — every LLM call is recorded.');
      console.log('   Trace file: ~/.nuvira/memory/reasoning-traces.json');
      return;
    }

    for (const trace of traces) {
      const successIcon = trace.success === true ? '✅' : trace.success === false ? '❌' : '⏳';
      const duration = trace.durationMs !== undefined ? `${(trace.durationMs / 1000).toFixed(1)}s` : 'running…';
      const started = new Date(trace.startedAt).toLocaleString();
      const agents = [...new Set(trace.steps.map((s) => s.agentType))].join(', ');
      const eventCount = trace.events?.length ?? 0;
      const refusals = (trace.events ?? []).filter((e) => e.kind === 'refusal').length;
      console.log(`   ${successIcon} ${trace.id}`);
      console.log(`      ${trace.goal.slice(0, 90)}`);
      console.log(
        `      ${trace.steps.length} call(s) · ${eventCount} event(s)${
          refusals > 0 ? ` (${refusals} refused)` : ''
        } · ${duration} · started ${started}`,
      );
      if (agents) console.log(`      agents: ${agents}`);
      console.log('');
    }

    console.log('   Run `${getCliName()} trace replay <id>` to step through a trace.');
  }

  private showTrace(id: string): void {
    const trace = getTrace(id);
    if (!trace) {
      console.log(`❌ Trace not found: ${id}`);
      console.log('   Run `${getCliName()} trace list` to see available traces.');
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

    // Session 3 — the FULL stable layer, captured once per trace. Without this
    // the prompt was unreviewable (the preview showed 80 chars of it).
    if (trace.systemPrompt) {
      const total = trace.systemPromptChars ?? trace.systemPrompt.length;
      const shown = trace.systemPrompt.length > 2000 ? trace.systemPrompt.slice(0, 2000) + '\n… (truncated)' : trace.systemPrompt;
      console.log(`   ── System prompt (stable layer, ${total} chars) ──`);
      console.log(shown.split('\n').map((l) => `   │ ${l}`).join('\n'));
      console.log('');
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
      // Per-layer digests: sys stable across steps = prompt-cacheable.
      if (step.layers) {
        const L = step.layers;
        console.log(
          `       layers: sys ${L.systemChars}c/${L.systemDigest} · ctx ${L.contextChars}c/${L.contextDigest} · vol ${L.volatileChars}c/${L.volatileDigest}`,
        );
      }
      if (step.description && step.description.length > 110) {
        console.log(`       ${step.description.slice(0, 110)}…`);
      } else if (step.description) {
        console.log(`       ${step.description}`);
      }
      if (step.error) console.log(`       ⚠️ ${step.error.slice(0, 120)}`);
    }
    console.log('');

    // G18 — the loop's non-LLM facts. Printed for EVERY trace that has them,
    // including pipeline traces: a refusal or a gate decision is the same kind
    // of fact whichever engine produced it.
    if ((trace.events?.length ?? 0) > 0) {
      const counts = countEvents(trace.events ?? []);
      console.log(
        `   ── Events (${trace.events!.length}: ${counts.tool} tool call(s), ${counts.gate} gate decision(s), ` +
          `${counts.refusal} refusal(s), ${counts.decision} decision(s)) ──`,
      );
      for (const event of trace.events!) {
        console.log(`   ${String(event.seq).padStart(3)}. ${eventIcon(event)} ${eventLine(event)}`);
      }
      console.log('');
    } else if (trace.steps.length > 0) {
      console.log('   (no non-LLM events recorded — the run predates event capture)');
      console.log('');
    }

    console.log('   Run `${getCliName()} trace replay <id>` for the full step-by-step reasoning replay.');
  }

  private replayTrace(id: string, full: boolean): void {
    const trace = getTrace(id);
    if (!trace) {
      console.log(`❌ Trace not found: ${id}`);
      console.log('   Run `${getCliName()} trace list` to see available traces.');
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
    // Session 3 — full stable layer (the persona / tool contract / rules).
    if (trace.systemPrompt) {
      const total = trace.systemPromptChars ?? trace.systemPrompt.length;
      const body = full || trace.systemPrompt.length <= 3000 ? trace.systemPrompt : trace.systemPrompt.slice(0, 3000) + '\n… (use --full for the whole system prompt)';
      console.log('');
      console.log(`  ── System prompt (stable layer, ${total} chars) ──`);
      console.log(body.split('\n').map((l) => `  │ ${l}`).join('\n'));
    }
    // G18 — the non-LLM half of the run, BEFORE the LLM steps: what the turn
    // actually did (and declined) is the first thing an audit needs, and the
    // step list below explains what the model was asked.
    if ((trace.events?.length ?? 0) > 0) {
      console.log('');
      console.log(`  ── Loop events (${trace.events!.length}) ──`);
      for (const event of trace.events!) {
        console.log(`  ${String(event.seq).padStart(4)} ${eventIcon(event)} ${eventLine(event)}`);
        if (event.result) console.log(`        ↳ ${event.result}`);
      }
    }
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
      if (step.layers) {
        const L = step.layers;
        console.log(
          `  Layers:    sys ${L.systemChars}c/${L.systemDigest} · ctx ${L.contextChars}c/${L.contextDigest} · vol ${L.volatileChars}c/${L.volatileDigest}`,
        );
        console.log('             (sys stable across steps ⇒ the stable layer is prompt-cacheable)');
      }
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

  /**
   * The read-only correction for the Requests panel vouching for a weak model.
   * The action log records that a provider ANSWERED, so an unusable reply from a
   * pair that cannot hold an agentic task books as `verified` and its 0.0% error
   * rate is not a quality measurement. The log is hash-chained (a correction
   * cannot be appended without inventing an event), so the truth is DERIVED from
   * the traces, which record the served pair per step — nothing is written back.
   */
  private degraded(limit: number): void {
    const traces = listTraces(limit);
    const degraded = degradedCallsFromTraces(traces);

    console.log(`⚠️  Degraded calls — derived read-only from ${traces.length} trace(s)\n`);

    if (degraded.length === 0) {
      console.log('   No non-agentic-capable pair served a traced step.');
      console.log('');
      return;
    }

    for (const d of degraded) {
      console.log(`   ⚠️ ${d.provider}/${d.model} — ${d.steps} step(s) across ${d.traces.length} trace(s)`);
      if (d.traces.length > 0) console.log(`      traces: ${d.traces.join(', ')}`);
    }
    console.log('');
    console.log('   These pairs answered, so the action log (and the dashboard Requests panel)');
    console.log('   reads them as healthy — but the served pair cannot hold an agentic task.');
    console.log('   This census is DERIVED from the traces; the hash-chained log is untouched.');
  }

  private clear(): void {
    clearTraces();
    console.log('🗑️  All reasoning traces cleared.');
  }
}

// ─── Event rendering (G18) ──────────────────────────────────────────────────

/** Per-kind counts, so a section header states the composition, not just a total. */
function countEvents(events: readonly TraceEvent[]): {
  tool: number;
  gate: number;
  refusal: number;
  decision: number;
} {
  return {
    tool: events.filter((e) => e.kind === 'tool').length,
    gate: events.filter((e) => e.kind === 'gate').length,
    refusal: events.filter((e) => e.kind === 'refusal').length,
    decision: events.filter((e) => e.kind === 'decision').length,
  };
}

/** The icon names the KIND first — a refusal must never look like a call. */
function eventIcon(event: TraceEvent): string {
  switch (event.kind) {
    case 'tool':
      return event.ok === false ? '⚠️' : '🔧';
    case 'refusal':
      return '⛔';
    case 'gate':
      switch (event.gate) {
        case 'autonomy':
          return '🤖';
        case 'verification':
          return '🔎';
        case 'deliverable':
          return '📄';
        case 'promise':
          return '🔁';
        case 'permission':
          return '🛡️';
        default:
          return '🚦';
      }
    default:
      return '🧭';
  }
}

/** One line per event: subject, the args the gate saw, timing, and the verdict. */
function eventLine(event: TraceEvent): string {
  const subject = event.tool ?? (event.gate ? `${event.gate} gate` : event.kind);
  const args = event.args && event.args !== '{}' ? ` ${event.args}` : '';
  const timing = event.durationMs !== undefined ? ` (${(event.durationMs / 1000).toFixed(2)}s)` : '';
  return `${subject.padEnd(16)}${args}${timing} — ${event.summary}`;
}

/** Exported for tests — the rendering is pure, so it can be asserted directly. */
export const traceEventRender = { countEvents, eventIcon, eventLine };
