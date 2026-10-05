/**
 * PROMPT BUDGET (Workstream D1).
 *
 * Context is a finite resource with diminishing marginal returns ("context
 * rot"): as the prompt grows, recall and long-range reasoning get worse, so the
 * harness must manage what it SENDS, not just what it stores. Industry practice
 * converges on: a stable cached prefix + just-in-time retrieval + per-source
 * caps + measurement at assembly time + deterministic degradation. This module
 * provides the measurement and the degradation PLAN; the caller applies it.
 *
 * It is deliberately dependency-light and pure, so it can be unit tested without
 * a provider, a project, or a terminal.
 *
 * NOTE: this is distinct from `context-budget.ts`, which resolves a model's
 * WINDOW and output-token budget. `MAX_SYSTEM_PROMPT_CHARS` in reasoning-trace.ts
 * bounds what the TRACE stores. This module's thresholds bound what the MODEL is
 * SENT — the previously ungated thing (the 3.3.11 bloat was 7.6K → 32.8K chars
 * sent with no guard).
 */

/** Character budgets for the outbound context (estimates, not token counts). */
export interface PromptBudget {
  /** Note once the whole thread exceeds this many chars. */
  noteTotal: number;
  /** Warn once the whole thread exceeds this many chars. */
  warnTotal: number;
  /** Hard ceiling: trim optional contributors until under this. */
  maxTotal: number;
  /** Note once the stable SYSTEM layer exceeds this. */
  noteSystem: number;
  /** Warn once the stable SYSTEM layer exceeds this. */
  warnSystem: number;
}

export const DEFAULT_PROMPT_BUDGET: PromptBudget = {
  noteTotal: 24_000,
  warnTotal: 40_000,
  maxTotal: 48_000,
  noteSystem: 8_000,
  warnSystem: 12_000,
};

function positiveInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

interface ConfigLike {
  getAll?: () => { routing?: { promptBudget?: Partial<PromptBudget> } } | undefined;
}

/**
 * Resolve the budget: `routing.promptBudget` overrides the defaults per key.
 * Unknown/invalid values fall through rather than throwing.
 */
export function resolvePromptBudget(configManager?: ConfigLike): PromptBudget {
  let overrides: Partial<PromptBudget> | undefined;
  try {
    overrides = configManager?.getAll?.()?.routing?.promptBudget;
  } catch {
    overrides = undefined;
  }
  const o = overrides ?? {};
  return {
    noteTotal: positiveInt(o.noteTotal, DEFAULT_PROMPT_BUDGET.noteTotal),
    warnTotal: positiveInt(o.warnTotal, DEFAULT_PROMPT_BUDGET.warnTotal),
    maxTotal: positiveInt(o.maxTotal, DEFAULT_PROMPT_BUDGET.maxTotal),
    noteSystem: positiveInt(o.noteSystem, DEFAULT_PROMPT_BUDGET.noteSystem),
    warnSystem: positiveInt(o.warnSystem, DEFAULT_PROMPT_BUDGET.warnSystem),
  };
}

/** How far over budget the outbound context is. */
export type PromptBudgetLevel = 'ok' | 'note' | 'warn' | 'over';

/** One contributor to the outbound context. */
export interface PromptContribution {
  /** Stable name (`system:identity+tool-contract`, `skill-hint`, …). */
  name: string;
  /** Size in chars. */
  chars: number;
  /**
   * Degradation order: lower drops FIRST. `undefined` = never dropped (the
   * identity/tool contract and safety clauses must survive any trim).
   */
  dropPriority?: number;
}

export interface PromptBudgetReport {
  /** Total outbound chars across every contribution. */
  totalChars: number;
  /** The stable SYSTEM layer's chars. */
  systemChars: number;
  /** Budget band the total fell into. */
  level: PromptBudgetLevel;
  /** Contributions, largest first. */
  contributions: PromptContribution[];
  /** The single largest contributor (the one to attack first). */
  biggest?: PromptContribution;
  /**
   * Names to drop, lowest value first, until the total fits under `maxTotal`.
   * Empty when already under. Never includes a contribution without a
   * `dropPriority`.
   */
  trims: string[];
}

const SYSTEM_NAME_PREFIX = 'system:';

/**
 * Measure the outbound context and decide, deterministically, what to trim.
 *
 * The `system:`-prefixed contributions (identity/tool-contract, channel policy)
 * are treated as the stable layer for the system budget.
 */
export function measurePromptBudget(
  parts: PromptContribution[],
  opts?: { budget?: PromptBudget; systemName?: string },
): PromptBudgetReport {
  const budget = opts?.budget ?? DEFAULT_PROMPT_BUDGET;
  const clean = parts
    .filter((p) => Number.isFinite(p.chars) && p.chars > 0)
    .map((p) => ({ ...p, chars: Math.round(p.chars) }));
  const totalChars = clean.reduce((n, p) => n + p.chars, 0);
  const systemChars = clean
    .filter((p) => p.name.startsWith(SYSTEM_NAME_PREFIX) || p.name === opts?.systemName)
    .reduce((n, p) => n + p.chars, 0);

  const level: PromptBudgetLevel =
    totalChars > budget.maxTotal
      ? 'over'
      : totalChars > budget.warnTotal || systemChars > budget.warnSystem
        ? 'warn'
        : totalChars > budget.noteTotal || systemChars > budget.noteSystem
          ? 'note'
          : 'ok';

  const contributions = [...clean].sort((a, b) => b.chars - a.chars);
  const biggest = contributions[0];

  // Deterministic ladder: drop optional contributors by ascending dropPriority
  // (lowest value = least valuable = dropped first) until under the ceiling.
  const trims: string[] = [];
  if (totalChars > budget.maxTotal) {
    const droppable = clean
      .filter((p) => p.dropPriority !== undefined)
      .sort((a, b) => (a.dropPriority ?? 0) - (b.dropPriority ?? 0));
    let running = totalChars;
    for (const p of droppable) {
      if (running <= budget.maxTotal) break;
      trims.push(p.name);
      running -= p.chars;
    }
  }

  return { totalChars, systemChars, level, contributions, biggest, trims };
}

/** A compact one-line breakdown for the console / trace summary. */
export function formatPromptBudgetBreakdown(report: PromptBudgetReport): string {
  const top = report.contributions.slice(0, 5).map((c) => `${c.name} ${c.chars}`);
  return `context ${report.totalChars} chars (${report.level}) — ${top.join(', ')}`;
}
