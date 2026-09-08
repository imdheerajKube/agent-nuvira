/**
 * Loop executor (`src/cli/loop-executor.ts`) — AGENTIC_CAPABILITY_ASSESSMENT
 * Addendum v4 Phase 1.1: "Make `runToolLoop` the executor behind coding-intent
 * dispatch (…extend to `nuvira execute` default path behind
 * `--engine loop|pipeline`, default `pipeline` until Phase 0 numbers land)."
 *
 * `nuvira execute` currently goes straight to the Orchestrator. This module
 * is the LOOP arm: one agentic turn over the same `runToolLoop` the chat
 * engine uses, with the ambient project-context injection + tiered tool
 * exposure the chat path already has. The orchestrator stays the DEFAULT
 * until the Phase 0 eval numbers land; this arm ships complete so
 * `--engine loop` is a real path, not a stub.
 *
 * Engine selection (Phase 2) happens in the CALLER (`execute` dispatch):
 * `resolveEngine()` decides loop vs pipeline from the routed provider tier;
 * this module is deliberately single-responsibility (it IS the loop arm).
 *
 * Telemetry parity with the eval framework: the executor returns wall-clock
 * time, per-tool call counts, errored-tool names (captured from the
 * `tool:called` events, not guessed from content), the bounded flag, and the
 * generation-failed flag so Phase 0 can compare arms on identical metrics.
 *
 * Phase 1.3 guardrail note (v4 risk table): file ops stay deny-first /
 * confirm-gated (registry tools keep their own gates) and the orchestrator
 * remains available for CI/publish — enterprise semantics are not weakened.
 */

import { ConfigManager } from '../config/manager.js';
import { resolveProvider } from './router.js';
import { resolveWorkingModel } from '../inference/model-validator.js';
import { getAutoRouter, isAutoModel, isAutoProvider } from '../learning/auto-router.js';
import { buildLoopProjectContext } from '../tools/loop-project-context.js';
import { getLoopExposureMode } from '../tools/toolsets.js';
import { resolveEngine } from '../learning/engine-router.js';
import { logger } from '../utils/logger.js';
import type { InferenceProvider, ToolMessage } from '../inference/interface.js';
import type { ToolJsonSchema } from '../tools/registry.js';

/** The loop executor's result — every metric the Phase 0 eval needs. */
export interface LoopExecutorResult {
  /** Final assistant content (the loop's end-turn answer). */
  content: string;
  /** True when generation failed entirely (no content, no tools ran). */
  generationFailed: boolean;
  /** True when the loop hit its step bound before an end turn. */
  bounded: boolean;
  /** Tool names executed, in order (repair-count proxy). */
  toolCalls: string[];
  /** Tool names that returned an error result (captured from tool:called). */
  erroredTools: string[];
  /** Wall-clock duration (ms). */
  durationMs: number;
  /** The provider id used (telemetry echo). */
  provider: string;
  /** The model id used (telemetry echo). */
  model: string;
  /** The engine decision explanation (Phase 2 audit trail). */
  engineExplanation: string;
}

/** Options for runLoopExecutor — mirrors the pipeline arm's surface. */
export interface LoopExecutorOptions {
  /** Explicit provider id (auto-routed when omitted or 'auto'). */
  provider?: string;
  /** Explicit model (router-resolved when omitted or 'auto'). */
  model?: string;
  /** Stream content tokens live (CLI prints; eval ignores). */
  onToken?: (token: string) => void;
  /** External cancellation (execute's Ctrl+C). */
  signal?: AbortSignal;
  /** Skip the ambient [Project context] injection (tests). */
  skipProjectContext?: boolean;
  /**
   * Phase 3.2 — skip the loop-side skill match hint (tests / hint-free
   * comparisons). Default false: the hint is part of the loop arm's standard
   * context, mirroring the pipeline arm's skillGuidance injection.
   */
  skipSkillHint?: boolean;
  /** Override the step bound (default 16 — the loop's own default). */
  maxSteps?: number;
  /** Quiet mode: no progress logging (eval arms). */
  quiet?: boolean;
}

/** The system prompt for the execute-loop arm (verification-first). */
function buildExecuteLoopSystemPrompt(toolContractJson: string): string {
  return [
    'You are Nuvira, executing a coding task end-to-end. You have the project\'s tool surface: read files, edit/write files, search code, run terminal commands (typecheck/tests/build), plan with plan_todo, and delegate subtasks.',
    'Work autonomously: understand the code first (read_file/code_search), make the change (edit_file/write_file), then VERIFY by running typecheck/tests with run_terminal. Fix what fails and re-verify.',
    'When the task is complete, summarize what changed and why. End with suggest_followups listing sensible next steps.',
    '',
    'Some tools live in domain toolsets outside your visible list — if a tool you need is "unknown", call tool_search with {"action":"load","toolset":"<name>"} and its tools become callable immediately.',
    '',
    toolContractJson,
  ].join('\n');
}

/**
 * Run one coding goal through the single agentic loop (the v4 universal
 * engine). Resolves the route the same way chat does (explicit override or
 * AutoModelRouter candidate walk), injects the ambient project context, and
 * runs `runToolLoop` with tiered exposure per config. Never throws — a
 * failure returns a result with generationFailed=true (eval arms count it as
 * a loss; the CLI prints the message).
 */
export async function runLoopExecutor(
  goal: string,
  configManager: ConfigManager,
  opts: LoopExecutorOptions = {},
): Promise<LoopExecutorResult> {
  const startedAt = Date.now();

  // ── Route: explicit provider/model wins; otherwise the AutoModelRouter ──
  let providerType = 'auto';
  let model = 'default';
  let provider: InferenceProvider | null = null;

  try {
    if (opts.provider && !isAutoProvider(opts.provider)) {
      const resolved = resolveProvider(configManager, opts.provider);
      providerType = resolved.type;
      provider = resolved.provider;
      model = opts.model && !isAutoModel(opts.model)
        ? opts.model
        : await resolveWorkingModel(provider, providerType, undefined);
    } else {
      const routed = await getAutoRouter().resolve('execute', goal, { verbose: !opts.quiet }, configManager);
      // Walk the ranked candidates to the first AVAILABLE provider (the
      // router excludes unconfigured providers; isAvailable() is the gate).
      const candidates = [routed.provider, ...routed.ranked.map((r) => r.provider)];
      for (const candidate of candidates) {
        try {
          const resolved = resolveProvider(configManager, candidate);
          if (await resolved.provider.isAvailable()) {
            const desired = candidate === routed.provider
              ? routed.model
              : getAutoRouter().resolveModel(candidate, 'execute', configManager);
            providerType = resolved.type;
            provider = resolved.provider;
            model = await resolveWorkingModel(resolved.provider, resolved.type, desired);
            break;
          }
        } catch {
          // Next candidate.
        }
      }
    }
  } catch (err) {
    return failureResult(
      `Routing failed: ${err instanceof Error ? err.message : String(err)}`,
      startedAt,
      opts.provider ?? 'auto',
      opts.model ?? 'default',
      'routing failed before an engine decision was possible',
    );
  }

  if (!provider) {
    return failureResult(
      'No available provider for the loop engine (check API keys / local runner).',
      startedAt,
      opts.provider ?? 'auto',
      opts.model ?? 'default',
      'no available provider after the candidate walk',
    );
  }

  // ── Engine decision (Phase 2): audit-trail echo for the caller/telemetry ──
  // The CALLER decides loop-vs-pipeline with the same function; this echo
  // keeps the executor's telemetry self-describing (dashboard badge parity).
  let engineExplanation = '';
  try {
    engineExplanation = resolveEngine({ provider: providerType, model }).explanation;
  } catch {
    engineExplanation = 'engine decision unavailable';
  }
  if (!opts.quiet) logger.debug(`Engine: ${engineExplanation}`);

  // ── Ambient project context (Phase 1.4 — same block the chat engine uses) ──
  let projectContext: string | undefined;
  if (!opts.skipProjectContext) {
    try {
      const built = await buildLoopProjectContext(process.cwd());
      if (built) projectContext = built;
    } catch {
      projectContext = undefined; // best-effort — never breaks the turn
    }
  }

  // ── Loop-side skill match hint (Phase 3.2 — chat/execute parity) ─────────
  // The orchestrator consults SkillStore.findMatch + the hub catalog before
  // planning; the execute loop never heard about that layer. One
  // deterministic, best-effort match is appended to the system prompt
  // (methodology + exact skill-tool load syntax, bounded to ONE block). A
  // failure returns '' and the prompt is byte-identical to pre-3.2.
  let skillHint = '';
  if (!opts.skipSkillHint) {
    try {
      const { buildLoopSkillHint, markLoopSkillUsed } = await import('../tools/loop-skill-hint.js');
      const injected: { value: import('../tools/loop-skill-hint.js').LoopSkillHintMatch | null } = { value: null };
      skillHint = await buildLoopSkillHint(goal, configManager, injected);
      if (injected.value) {
        void markLoopSkillUsed(injected.value);
        if (!opts.quiet) logger.info(`   🧠 Matched skill '${injected.value.name}' — methodology injected into the loop context`);
      }
    } catch {
      skillHint = ''; // best-effort — never breaks the turn
    }
  }

  const { runToolLoop } = await import('../tools/tool-loop.js');
  const { getTool, TOOL_CONTRACT_JSON } = await import('../tools/registry.js');

  const thread: ToolMessage[] = [
    { role: 'system', content: buildExecuteLoopSystemPrompt(TOOL_CONTRACT_JSON) + skillHint },
    ...(projectContext ? [{ role: 'user' as const, content: `[Project context]\n${projectContext}` }] : []),
    { role: 'user', content: goal },
  ];

  const loadedExtraTools = new Set<string>();
  const erroredTools: string[] = [];

  const callModel = async (
    messages: ToolMessage[],
    schemas: ToolJsonSchema[],
    _stepOnToken?: (token: string) => void,
    stepSignal?: AbortSignal,
  ) => {
    void _stepOnToken;
    if (typeof provider!.generateTools === 'function' && schemas.length > 0) {
      if (typeof provider!.generateToolsStream === 'function' && opts.onToken) {
        return provider!.generateToolsStream(messages, schemas, { model, signal: stepSignal ?? opts.signal }, opts.onToken);
      }
      return provider!.generateTools(messages, schemas, { model, signal: stepSignal ?? opts.signal });
    }
    // JSON fallback transport — the shared helper the chat engine uses.
    const { buildJsonFallbackPrompt } = await import('../inference/tool-call-utils.js');
    const { extractFallbackToolCalls } = await import('../tools/tool-loop.js');
    const prompt = buildJsonFallbackPrompt(messages, schemas);
    let raw: string;
    if (typeof provider!.generateStream === 'function') {
      const chunks: string[] = [];
      await provider!.generateStream(prompt, { model, signal: stepSignal ?? opts.signal }, (t) => {
        chunks.push(t);
        opts.onToken?.(t);
      });
      raw = chunks.join('');
    } else {
      raw = await provider!.generate(prompt, { model, signal: stepSignal ?? opts.signal });
    }
    const { text, calls } = extractFallbackToolCalls(raw);
    return { content: text, toolCalls: calls };
  };

  try {
    const result = await runToolLoop({
      messages: thread,
      maxSteps: opts.maxSteps ?? 16,
      toolExposure: getLoopExposureMode(configManager),
      onToken: opts.onToken,
      signal: opts.signal,
      context: {
        configManager,
        loadedExtraTools,
        cwd: process.cwd(),
      },
      deps: {
        callModel,
        executeTool: async (name, args, ctx) => {
          const tool = getTool(name);
          if (!tool) throw new Error(`Unknown tool: ${name}`);
          const out = await tool.run(args, ctx);
          // Errored-tool telemetry (Phase 0 repair-count proxy). Two failure
          // conventions exist: the loop's `Error:` prefix (runtime throw) and
          // the coding tools' `<name>: cannot|no such file …` verbs (missing
          // file, unreadable path). A bare `<name>: ` prefix is NOT a failure
          // signal — successful list_dir/read_file output legitimately starts
          // with it — and soft refusals ("is a directory", "looks binary") are
          // advisory, not failures. Telemetry only — never alters the text.
          if (
            out.startsWith('Error:') ||
            new RegExp(`^${name}: (cannot |no such file |denied)`).test(out)
          ) {
            erroredTools.push(name);
          }
          return out;
        },
        onEvent: opts.quiet ? undefined : (line) => logger.info(line),
      },
    });

    return {
      content: result.content,
      generationFailed: result.generationFailed ?? false,
      bounded: result.bounded,
      toolCalls: result.toolCalls,
      erroredTools,
      durationMs: Date.now() - startedAt,
      provider: providerType,
      model,
      engineExplanation,
    };
  } catch (err) {
    return failureResult(
      `Loop execution failed: ${err instanceof Error ? err.message : String(err)}`,
      startedAt,
      providerType,
      model,
      engineExplanation,
    );
  }
}

/** Build a failed result (shape-complete for the eval arm comparison). */
function failureResult(message: string, startedAt: number, provider: string, model: string, engineExplanation: string): LoopExecutorResult {
  return {
    content: message,
    generationFailed: true,
    bounded: false,
    toolCalls: [],
    erroredTools: [],
    durationMs: Date.now() - startedAt,
    provider,
    model,
    engineExplanation,
  };
}
