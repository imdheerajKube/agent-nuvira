/**
 * H1/E3b — Pipeline tool (`src/tools/pipeline-tool.ts`).
 *
 * The orchestrator pipeline as a CALLABLE TOOL — the Freebuff/Hermes
 * tool-call model ("a chat turn can invoke plan/execute/edit as a tool call",
 * H1 acceptance). Extracted from `runDeveloperMode` (chat.ts) so the same
 * pipeline core serves three entry points with zero divergence:
 *   1. `buff chat` pre-dispatch (runDeveloperMode — thin wrapper, prints).
 *   2. The H1 tool registry (build/resume/repair tools — return a summary
 *      text fed back to the model).
 *   3. Any future command (execute/plan/run) — STANDING RULE.
 *
 * Everything the old runDeveloperMode did is preserved: auto provider/model
 * resolution (never a literal 'auto' handed to the orchestrator), model
 * health repair via resolveWorkingModel, the E3a understand-card on the live
 * board, and D1 recall wiring for `continue` (mode 'recall').
 */

import { resolveProvider } from '../cli/router.js';
import { resolveWorkingModel } from '../inference/model-validator.js';
import { getAutoRouter, isAutoProvider, isAutoModel } from '../learning/auto-router.js';
import { Orchestrator, type OrchestrationResult } from '../agents/orchestrator.js';
import { getEventBus, EventNames } from '../observability/event-bus.js';
import { parseRequestSync } from '../nlu/parser.js';
import { resolveDispatch } from '../nlu/actions.js';
import { contractFromParsed, renderContractCard } from '../nlu/contract.js';
import { maybeAutoRecall, recallCard, recallContextBlock } from '../context/session-recall.js';
import { logger } from '../utils/logger.js';
import type { ModeHint } from '../nlu/intent.js';
import type { TaskIntent } from '../learning/auto-router.js';
import { PipelineBoard } from '../cli/pipeline-board.js';
import type { ToolContext } from './registry.js';

/** Options for a pipeline tool run. */
export interface PipelineToolOptions {
  provider?: string;
  model?: string;
  /**
   * The pipeline that runs (dev/execute/recall). When absent, derived from
   * the goal's NLU dispatch (mirrors the legacy runDeveloperMode behavior —
   * `continue` requests recall automatically).
   */
  mode?: ModeHint;
  /** Router task-intent seed. */
  taskIntentHint?: TaskIntent;
  /** Pre-built recall context (resume builds it from query + timeRange). */
  recallContext?: string;
  /** Show the live ink board (default: true). */
  board?: boolean;
  /** Extra understand-card note lines (tool name transparency). */
  notes?: string[];
}

/** The tool-callable pipeline result. */
export interface PipelineToolResult {
  success: boolean;
  /** One-line summary (fed back to the model on tool calls). */
  summary: string;
  /** Detail lines (agent results, file changes). */
  details: string[];
  /** The raw orchestration result (for callers that print it). */
  result: OrchestrationResult | null;
  error?: string;
}

/**
 * Run the orchestrator pipeline for a goal — the shared core.
 * Returns a summary; NEVER throws (failures are captured in the result).
 */
export async function runPipelineTool(
  goal: string,
  configManager: any,
  opts: PipelineToolOptions,
): Promise<PipelineToolResult> {
  const board = opts.board !== false;
  // Resolve a REAL provider/model — never hand a literal 'auto' to the
  // orchestrator (mirrors runDeveloperMode).
  let provider = opts.provider;
  let model = opts.model;
  if (isAutoProvider(provider) || isAutoModel(model)) {
    try {
      const decision = getAutoRouter().resolve(
        'chat',
        goal,
        { verbose: true, useRuntimeStats: true },
        configManager,
      );
      const resolved = resolveProvider(configManager, decision.provider);
      provider = resolved.type;
      model = await resolveWorkingModel(resolved.provider, decision.provider, decision.model);
    } catch (err) {
      return {
        success: false,
        summary: 'Pipeline failed: could not resolve a working provider/model',
        details: [String(err)],
        result: null,
        error: String(err),
      };
    }
  }

  // E3a + Session 20: intent transparency + D1 recall parity — parse ONCE,
  // resolve the REQUEST CONTRACT (understanding-first), seed the 🧠 card +
  // router task-intent hint. The contract's acceptance criteria are passed to
  // the orchestrator so the verification pass checks the changes against
  // them at pipeline end (Decision 3 — spec→verify).
  const parsed = parseRequestSync(goal);
  const dispatch = resolveDispatch(parsed);
  // Zero-reparse: the contract reuses the parse just computed above.
  const contract = contractFromParsed(goal, parsed);
  // The pipeline that runs: explicit (tool vocabulary) or derived from the
  // goal's NLU dispatch (legacy runDeveloperMode behavior).
  const mode = opts.mode ?? dispatch.mode;
  const notes: string[] = [
    `🧠 Understood: ${contract.actionLabel} · ${Math.round(parsed.confidence * 100)}% confidence — running the coding pipeline`,
    ...(opts.notes || []),
  ];
  let recallContext = opts.recallContext;
  if (mode === 'recall' && !recallContext) {
    try {
      const recall = await maybeAutoRecall(process.cwd(), configManager.getWorkspaceStore());
      if (recall) {
        notes.push(...recallCard(recall).split('\n').filter((l) => l.trim() !== ''));
        recallContext = recallContextBlock(recall);
      }
    } catch { /* recall must never break dispatch */ }
  }

  // Session 20: the 🧠 Understood card is printed BEFORE the pipeline runs
  // (fast-accept by default — display-only, never a blocking wizard). The
  // user always sees what the agent understood, then execution starts.
  console.log('\n' + renderContractCard(contract) + '\n');

  // Live pipeline board (the E2 ink TUI) — visible steps, lanes, retries.
  let liveBoard: PipelineBoard | null = null;
  if (board) {
    liveBoard = new PipelineBoard();
    liveBoard.start(goal);
  }
  getEventBus().emit(EventNames.ORCHESTRATOR_INSPECTION, { lines: notes }, 'chat');

  try {
    const orchestrator = new Orchestrator(configManager);
    const result = await orchestrator.execute(goal, {
      provider,
      model,
      verbose: false,
      ...(liveBoard ? { spinner: liveBoard } : {}),
      taskIntentHint: opts.taskIntentHint ?? dispatch.taskIntentHint,
      recallContext,
      acceptanceCriteria: contract.acceptanceCriteria,
      // The 🧠 card advertises resumability — make it true for every pipeline
      // run (cheap per-batch JSON checkpoints; a Ctrl+C / quota kill can then
      // `buff execute --resume` instead of restarting).
      checkpoint: true,
    });

    liveBoard?.finish(result.success);
    return {
      success: result.success,
      summary: result.summary,
      details: buildResultDetails(result),
      result,
    };
  } catch (err) {
    liveBoard?.finish(false);
    const message = err instanceof Error ? err.message : String(err);
    logger.error(message);
    return { success: false, summary: `Pipeline failed: ${message}`, details: [], result: null, error: message };
  }
}

/** Detail lines from an orchestration result (agent summaries + file changes). */
export function buildResultDetails(result: OrchestrationResult): string[] {
  const details: string[] = [];
  details.push(`Tasks: ${result.tasksCompleted}/${result.tasksTotal} completed`);
  for (const ar of result.agentResults) {
    details.push(`${ar.success ? '✅' : '❌'} ${ar.agent}: ${ar.summary.slice(0, 120)}`);
  }
  if (result.fileChanges && result.fileChanges !== 'No files changed.') {
    for (const line of result.fileChanges.split('\n')) {
      if (line.trim()) details.push(`📄 ${line.trim()}`);
    }
  }
  return details;
}

// ─── Registry adapter ───────────────────────────────────────────────────────

const ACTION_MODE: Record<string, ModeHint> = {
  build: 'dev',
  resume: 'recall',
  repair: 'execute',
  // E3c model-decides task tools — the pipeline mode + router task-intent
  // seed for each (document/website/analyze run the dev pipeline; test runs
  // the execute pipeline so the verification task-type biases routing).
  document: 'dev',
  website: 'dev',
  analyze: 'dev',
  test: 'execute',
};
const ACTION_INTENT: Record<string, TaskIntent> = {
  build: 'coding',
  resume: 'coding',
  repair: 'debugging',
  document: 'planning',
  website: 'coding',
  analyze: 'architecture',
  test: 'verification',
};

/**
 * H1 tool-registry adapter — runs the pipeline for a build/resume/repair tool
 * call (or an E3c task tool: document/website/analyze/test) and returns the
 * model-feedable result text (never throws).
 */
export async function runPipelineToolFromRegistry(
  action: string,
  args: unknown,
  ctx: ToolContext,
): Promise<string> {
  const mode = ACTION_MODE[action];
  if (!mode) return `Unknown pipeline action: ${action}`;

  const a = args as { goal?: string; query?: string; timeRange?: { text: string; start?: string; end?: string } };
  const goal = (mode === 'recall' ? a.query : a.goal)?.trim();
  if (!goal) return `Tool "${action}" requires a ${mode === 'recall' ? 'query' : 'goal'} argument.`;

  const result = await runPipelineTool(goal, ctx.configManager, {
    mode,
    taskIntentHint: ACTION_INTENT[action],
    board: ctx.board === undefined ? true : !!ctx.board,
    notes: [`⚙ ${action} called from the chat loop`],
  });

  return [
    result.success ? `✅ ${action} succeeded` : `❌ ${action} failed`,
    result.summary,
    ...result.details,
  ].join('\n');
}
