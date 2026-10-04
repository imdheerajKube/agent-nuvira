/**
 * Capability parity (`src/learning/capability-parity.ts`) — the MEASUREMENT half
 * of the "narrow the gap" work.
 *
 * The whole point of the capability switch is a claim: `max` should reason and
 * self-correct more like a frontier agent than `balanced`. A claim without a
 * measurement is a vibe. This module runs the SAME hard, multi-step eval tasks
 * twice — once under `balanced`, once under `max` — and reports the deltas that
 * actually matter for the gap:
 *
 *   - completion + hidden-test pass rate  → does it DELIVER?
 *   - bounded rate                        → does it run out of room?
 *   - interruptions (permission asks)     → does it stop to nag?
 *   - tokens + cost                       → what the extra capability costs.
 *
 * It deliberately reuses the existing eval tasks (`eval-framework.ts`) rather
 * than inventing fragile fixtures: the parity question is "does the same task
 * score better at higher capability", so the tasks must be the established ones.
 *
 * Running it needs a real provider (real tokens, real cost), so it is NOT a CI
 * unit test — the pure summary/compare layer is unit-tested, and the run itself
 * is invoked on demand. The mode is applied through `NUVIRA_CAPABILITY_MODE`,
 * the same switch the CLI and dashboard write, so the measurement exercises the
 * REAL resolution path rather than a test-only knob.
 */

import type { InferenceProvider } from '../inference/interface.js';
import type { EvalRun, EvalResult } from './eval-framework.js';

/** The capability modes compared, in run order. */
export type ParityMode = 'balanced' | 'max';

/**
 * The task ids the parity run uses by default: the established tasks that are
 * genuinely multi-step and long-horizon, which is exactly where capability is
 * expected to separate the two modes. `loop-autonomy-multistep` is the purest
 * one (it exists to measure unattended multi-step autonomy); the continuation
 * and multi-file tasks add the long-context dimension; the display-state trace
 * task adds the "observe behaviour, don't just parse" dimension.
 *
 * The non-coding (loop-only) tasks are appended when their env gate is on, so
 * the parity run covers the loop's expanded reach too.
 */
export const PARITY_TASK_IDS: readonly string[] = [
  'loop-autonomy-multistep',
  'js-display-state-trace-fix',
  'js-continuation',
  'py-multi-file',
  'py-nvda-addon',
];

/** One mode's aggregate over the parity tasks. */
export interface CapabilityRunSummary {
  mode: ParityMode;
  tasks: number;
  /** Mean composite score (0–1). */
  avgComposite: number;
  /** Fraction of tasks whose hidden tests passed. */
  testPassRate: number;
  /** Fraction of tasks reported complete. */
  completedRate: number;
  /** Fraction of tasks that hit their step bound (lower is better). */
  boundedRate: number;
  /** Mean user-visible interruptions per task (lower is better). */
  avgPermissionAsks: number;
  totalTokens: number;
  totalCostUsd: number;
  /**
   * Tasks whose SERVED model differed from the requested pin. Non-zero means the
   * comparison did not run the model the user asked for — both arms may then have
   * run the same substituted model, and a zero delta measures nothing. Surfaced
   * because this was the exact trap: three live parity runs substituted to the
   * same weak model and reported a delta of 0 by construction.
   */
  substitutedTasks: number;
  /** Tasks that ran no tool at all (loop arm; not a completion). */
  actionlessTasks: number;
}

/** The full report: each mode plus the max-minus-balanced deltas. */
export interface CapabilityParityReport {
  balanced: CapabilityRunSummary;
  max: CapabilityRunSummary;
  /** max − balanced for each numeric metric (positive = max is higher). */
  delta: Omit<CapabilityRunSummary, 'mode'>;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Aggregate one eval run into the comparable summary (pure). */
export function summarizeCapabilityRun(mode: ParityMode, run: EvalRun): CapabilityRunSummary {
  const results: EvalResult[] = run.results ?? [];
  const bounded = results.filter((r) => r.metrics.bounded === true).length;
  const asks = results
    .map((r) => r.metrics.permissionAsks)
    .filter((n): n is number => typeof n === 'number');
  return {
    mode,
    tasks: results.length,
    avgComposite: mean(results.map((r) => r.compositeScore)),
    testPassRate: mean(results.map((r) => (r.metrics.testPassed ? 1 : 0))),
    completedRate: mean(results.map((r) => (r.metrics.completed ? 1 : 0))),
    boundedRate: results.length === 0 ? 0 : bounded / results.length,
    // Interruptions are only observable on arms that can ask; a run with none
    // recorded reports 0 rather than fabricating a number.
    avgPermissionAsks: asks.length === 0 ? 0 : mean(asks),
    totalTokens: results.reduce((a, r) => a + (r.metrics.totalTokens ?? 0), 0),
    totalCostUsd: results.reduce((a, r) => a + (r.metrics.costUsd ?? 0), 0),
    substitutedTasks: results.filter(
      (r) => r.metrics.servedModel !== undefined && r.metrics.servedModel !== r.metrics.requestedModel,
    ).length,
    actionlessTasks: results.filter((r) => r.metrics.actionless === true).length,
  };
}

/** Compare the two modes (pure). Positive deltas mean `max` is higher. */
export function compareCapabilityRuns(balanced: EvalRun, max: EvalRun): CapabilityParityReport {
  const b = summarizeCapabilityRun('balanced', balanced);
  const m = summarizeCapabilityRun('max', max);
  return {
    balanced: b,
    max: m,
    delta: {
      tasks: m.tasks - b.tasks,
      avgComposite: m.avgComposite - b.avgComposite,
      testPassRate: m.testPassRate - b.testPassRate,
      completedRate: m.completedRate - b.completedRate,
      boundedRate: m.boundedRate - b.boundedRate,
      avgPermissionAsks: m.avgPermissionAsks - b.avgPermissionAsks,
      totalTokens: m.totalTokens - b.totalTokens,
      totalCostUsd: m.totalCostUsd - b.totalCostUsd,
      substitutedTasks: m.substitutedTasks - b.substitutedTasks,
      actionlessTasks: m.actionlessTasks - b.actionlessTasks,
    },
  };
}

export interface CapabilityParityOptions {
  /** Provider + model to run (required unless `runSuite` is injected). */
  provider?: InferenceProvider;
  providerName?: string;
  model?: string;
  /** Override the default parity task set. */
  taskIds?: readonly string[];
  /** Engine arm to measure — the loop is where the capability gap lives. */
  engine?: 'loop' | 'pipeline';
  /**
   * Injection seam for tests / custom runners: given the mode, run the suite
   * and return its `EvalRun`. The mode is passed for the runner's own logging,
   * but this function has ALREADY set `NUVIRA_CAPABILITY_MODE` for the duration
   * of the call and restores it afterwards — the runner must not set it itself.
   */
  runSuite?: (mode: ParityMode) => Promise<EvalRun>;
}

/**
 * Run the parity tasks under both modes and return the comparison.
 *
 * The mode is applied with `NUVIRA_CAPABILITY_MODE` (saved + restored, even on
 * failure) so the run exercises the real resolution path — the same switch the
 * CLI and dashboard use. Order is balanced → max, so a crash in the second run
 * still leaves the first measured.
 */
export async function runCapabilityParity(options: CapabilityParityOptions): Promise<CapabilityParityReport> {
  const ids = options.taskIds && options.taskIds.length > 0 ? [...options.taskIds] : [...PARITY_TASK_IDS];
  const engine = options.engine ?? 'loop';
  const previous = process.env.NUVIRA_CAPABILITY_MODE;

  const runOne = async (mode: ParityMode): Promise<EvalRun> => {
    process.env.NUVIRA_CAPABILITY_MODE = mode;
    try {
      if (options.runSuite) return await options.runSuite(mode);
      if (!options.provider) {
        throw new Error('runCapabilityParity needs a provider (or an injected runSuite) to run the eval.');
      }
      const { runEvalSuite } = await import('./eval-framework.js');
      return await runEvalSuite(options.provider, options.providerName ?? 'auto', options.model ?? 'auto', {
        taskIds: ids,
        engine,
      });
    } finally {
      if (previous === undefined) delete process.env.NUVIRA_CAPABILITY_MODE;
      else process.env.NUVIRA_CAPABILITY_MODE = previous;
    }
  };

  const balanced = await runOne('balanced');
  const max = await runOne('max');
  return compareCapabilityRuns(balanced, max);
}

/** Render the report as a short, readable table (for a CLI/log surface). */
export function formatCapabilityParity(report: CapabilityParityReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const signedPct = (n: number) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(0)}%`;
  const rows: Array<[string, string, string, string]> = [
    ['tasks', String(report.balanced.tasks), String(report.max.tasks), ''],
    ['composite (0-1)', report.balanced.avgComposite.toFixed(3), report.max.avgComposite.toFixed(3), report.delta.avgComposite.toFixed(3)],
    ['hidden tests pass', pct(report.balanced.testPassRate), pct(report.max.testPassRate), signedPct(report.delta.testPassRate)],
    ['completed', pct(report.balanced.completedRate), pct(report.max.completedRate), signedPct(report.delta.completedRate)],
    ['bounded (lower better)', pct(report.balanced.boundedRate), pct(report.max.boundedRate), signedPct(report.delta.boundedRate)],
    ['asks/task (lower better)', report.balanced.avgPermissionAsks.toFixed(2), report.max.avgPermissionAsks.toFixed(2), report.delta.avgPermissionAsks.toFixed(2)],
    ['substituted (lower better)', String(report.balanced.substitutedTasks), String(report.max.substitutedTasks), String(report.delta.substitutedTasks)],
    ['no-action (lower better)', String(report.balanced.actionlessTasks), String(report.max.actionlessTasks), String(report.delta.actionlessTasks)],
    ['tokens', String(report.balanced.totalTokens), String(report.max.totalTokens), String(report.delta.totalTokens)],
    ['cost (USD)', report.balanced.totalCostUsd.toFixed(4), report.max.totalCostUsd.toFixed(4), report.delta.totalCostUsd.toFixed(4)],
  ];
  const width = Math.max(...rows.map((r) => r[0].length), 10);
  const line = (label: string, a: string, b: string, d: string) =>
    `${label.padEnd(width)}  ${a.padStart(10)}  ${b.padStart(10)}  ${d.padStart(10)}`;
  return [
    'Capability parity — balanced vs max (same tasks, same engine)',
    line('metric', 'balanced', 'max', 'delta'),
    ...rows.map((r) => line(...r)),
  ].join('\n');
}
