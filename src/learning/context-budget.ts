/**
 * Context + output budget resolution.
 *
 * THE PROBLEM: the pipeline hardcoded its budgets — `options.contextLimit ||
 * 128_000` for the ContextPruner and `maxTokens ?? 4096` for every call. The
 * registry has always RECORDED each model's real, provider-advertised window
 * (`ModelRegistryEntry.contextWindowTokens`, read from Ollama's
 * `general.context_length`, OpenRouter's `context_length`, etc.), and the
 * auto-router already consumes it for its context prefit — but the budgets that
 * actually decide how much the model GETS TO SEE were fixed constants.
 *
 * So a 1M-token model was pruned as if it had 128K, and could emit at most 4096
 * tokens, no matter what it supports. The better the model, the more of its
 * capability the constants left on the floor.
 *
 * WHAT THIS DOES NOT CLAIM: a bigger window is not automatically better. Filling
 * 1M tokens dilutes attention and costs real money, and on a free tier metered at
 * 8K tokens/MINUTE a large prompt is simply impossible. A bigger budget is
 * valuable because it lets the agent READ MORE OF THE PROJECT instead of a
 * fixed keyhole — not because bigger is better per se. Hence the headroom, the
 * floor, and the deliberate "unknown → unchanged" default so nothing regresses
 * for a model whose window we cannot discover.
 */

import { getModelRegistry } from './model-registry.js';
import { PROVIDER_CONTEXT_WINDOWS } from './model-selection.js';

/**
 * Used ONLY when the served model's real window cannot be discovered — keeping
 * today's behaviour exactly for unknown models.
 */
export const DEFAULT_CONTEXT_BUDGET = 128_000;

/**
 * Share of the window reserved for the model's own response plus the tool
 * schemas that ride along with every agentic step. Spending the entire window on
 * INPUT leaves no room to answer.
 */
export const CONTEXT_HEADROOM_PCT = 0.15;

/** Floor, so a small-window model is never pruned down to nothing. */
export const MIN_CONTEXT_BUDGET = 8_000;

/** Output cap when nothing better is known (the historical default). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

/**
 * Output cap granted to a model whose window is LARGE. A model advertising a
 * >= 200K window practically always accepts more than 4096 output tokens, so
 * holding it to the historical default is a pure capability loss. Still a
 * conservative figure: we raise the ceiling, we do not chase the model's true
 * maximum (which we do not track).
 */
export const LARGE_WINDOW_OUTPUT_TOKENS = 16_384;
const LARGE_WINDOW_THRESHOLD = 200_000;

/**
 * Characters-per-token heuristic. Mirrors ContextPruner (~4.5 chars/token for
 * code) so a token budget converts to the character budgets the loop's
 * `trimThreadBudget` and the writer/edit file selectors actually consume.
 */
export const CHARS_PER_TOKEN = 4.5;

/**
 * Ceiling on the tool-loop thread budget (~890K tokens at 4.5 chars/token).
 * A mis-advertised window must never produce an unbounded prompt; this still
 * lets a 1M-token model keep roughly its whole window.
 */
export const MAX_THREAD_BUDGET_CHARS = 4_000_000;

/**
 * THERE IS NO UNIVERSAL NEVER-SHRINK FLOOR (C1/C5, decided with the user).
 *
 * This module used to export `THREAD_BUDGET_FLOOR_CHARS = 200_000` and apply it
 * as `Math.max(FLOOR, windowDerivedChars)`, so the resolver could only ever
 * RAISE a budget. A model whose REAL window was 32,768 tokens was therefore
 * handed 200,000 chars (~44K tokens) of thread — **1.4× its own window**, from
 * the very lookup that had just established that window. That is C5: the floor
 * made a KNOWN window unenforceable, so a mid-turn handoff to a smaller model
 * could overflow the window we already knew about. (Measured against the old
 * rule: a 32K window returned 200,000.)
 *
 * The user's decision, and the reason no floor may sit above the window: the
 * thread is fitted to the model that is ANSWERING, because what makes a model
 * hallucinate is losing the ask. The protections that preserve perspective are
 * RULES in `trimThreadBudget`, not a budget number — the system prompt, the
 * FIRST user message, the last `RECENT_KEEP` messages and the work digest are
 * never touched, and only OLD TOOL OUTPUT is ever shrunk. So a large-window
 * model is deliberately left to use its window, and a small-window model gets a
 * thread that fits it.
 *
 * The UNKNOWN case is unchanged and is still the dominant one: no window → this
 * resolver returns `undefined` and the caller keeps its own default
 * (`DEFAULT_THREAD_BUDGET_CHARS` in `tools/tool-loop.ts`, also 200,000).
 */

/**
 * The smallest thread we will ask a model to work in (~4.4K tokens at 4.5
 * chars/token). A window recorded BELOW this is a registry error rather than a
 * real model, and trimming a thread to near-zero would destroy the turn — so
 * this is the one floor that survives, and it is deliberately far below the
 * 200,000 it replaces.
 */
export const MIN_THREAD_BUDGET_CHARS = 20_000;

/** Default per-prompt file-context caps (today's constants) for unknown models. */
export const DEFAULT_CONTEXT_FILES = 10;
export const DEFAULT_CONTEXT_FILE_CHARS = 16_000;

/** Ceiling on the model-aware file-context character budget (~333K tokens). */
export const MAX_CONTEXT_FILE_CHARS = 1_500_000;

/** Ceiling on how many files a single prompt may carry. */
export const MAX_CONTEXT_FILES = 60;

/**
 * Share of a model's window that CONTEXT FILES may occupy. The rest of the
 * prompt (goal, structure, MCP tools, instructions) plus the response needs
 * room, so files take a fraction rather than the whole budget — and the cap
 * below keeps the increase useful rather than merely large.
 */
export const CONTEXT_FILE_WINDOW_FRACTION = 0.35;

export interface BudgetInput {
  /** Provider type (e.g. 'gemini'). 'auto'/undefined → no model knowledge. */
  provider?: string;
  /** Concrete served model id. Unresolved/'default' → no model knowledge. */
  model?: string;
  /** Explicit caller/config value — always wins when supplied. */
  override?: number;
}

export interface ContextBudget {
  /** Input tokens the context may occupy. */
  budget: number;
  /** The discovered window, when one was known. */
  window?: number;
  /** Where the answer came from — surfaced for logs and tests. */
  source: 'override' | 'model' | 'provider' | 'default';
}

/** Is this a value we can actually look a window up for? */
function isConcrete(value: string | undefined): value is string {
  return !!value && value !== 'default' && value !== 'auto' && value !== 'unknown';
}

/** The model's real window from the registry, when recorded. */
function registryWindow(provider: string, model: string): number | undefined {
  try {
    const window = getModelRegistry().getEntry(provider, model)?.contextWindowTokens;
    return typeof window === 'number' && window > 0 ? window : undefined;
  } catch {
    // Best-effort — budget resolution must never break a call.
    return undefined;
  }
}

/**
 * Resolve the CONTEXT budget (input tokens) for a served provider × model.
 *
 * Precedence: explicit override → the registry's live descriptor for this exact
 * model → the provider's advertised `PROVIDER_CONTEXT_WINDOWS` entry → the
 * historical default. Whatever the window, `CONTEXT_HEADROOM_PCT` is withheld
 * for the response and `MIN_CONTEXT_BUDGET` floors the result.
 */
export function resolveContextBudget(input: BudgetInput = {}): ContextBudget {
  if (typeof input.override === 'number' && input.override > 0) {
    return { budget: input.override, source: 'override' };
  }

  const provider = input.provider;
  const model = input.model;

  let window: number | undefined;
  let source: ContextBudget['source'] = 'default';

  if (isConcrete(provider) && isConcrete(model)) {
    window = registryWindow(provider, model);
    if (window !== undefined) source = 'model';
  }
  if (window === undefined && isConcrete(provider)) {
    const providerWindow = PROVIDER_CONTEXT_WINDOWS[provider];
    if (typeof providerWindow === 'number' && providerWindow > 0) {
      window = providerWindow;
      source = 'provider';
    }
  }

  if (window === undefined) {
    // Unknown model: keep the historical behaviour untouched.
    return { budget: DEFAULT_CONTEXT_BUDGET, source: 'default' };
  }

  const budget = Math.max(
    MIN_CONTEXT_BUDGET,
    Math.floor(window * (1 - CONTEXT_HEADROOM_PCT)),
  );
  return { budget, window, source };
}

/**
 * Resolve the OUTPUT token cap for a served provider × model.
 *
 * Precedence: explicit override → a raised ceiling for a large-window model →
 * the historical default. Output limits are not recorded in the registry, so
 * this deliberately stays conservative: it lifts the constant out of the way for
 * models we KNOW are large, and changes nothing for everyone else.
 */
export function resolveMaxOutputTokens(input: BudgetInput = {}): number {
  if (typeof input.override === 'number' && input.override > 0) {
    return input.override;
  }

  const provider = input.provider;
  const model = input.model;
  let window: number | undefined;
  if (isConcrete(provider) && isConcrete(model)) {
    window = registryWindow(provider, model);
  }
  if (window === undefined && isConcrete(provider)) {
    window = PROVIDER_CONTEXT_WINDOWS[provider];
  }

  if (window !== undefined && window >= LARGE_WINDOW_THRESHOLD) {
    return LARGE_WINDOW_OUTPUT_TOKENS;
  }
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * Resolve the TOOL-LOOP thread budget (characters) for a served provider ×
 * model. Returns `undefined` when the window is UNKNOWN so the caller keeps
 * `DEFAULT_THREAD_BUDGET_CHARS` untouched ("unknown → unchanged", the same
 * discipline as `resolveContextBudget`); a known window converts its token
 * budget to characters so a 1M-token model is not trimmed to a 128K keyhole —
 * and, since C1/C5, so a 32K-token model is not handed a 44K-token thread.
 *
 * The WINDOW decides in BOTH directions. The old `Math.max(FLOOR, chars)` is
 * what made a known small window unenforceable; see the note on
 * `MIN_THREAD_BUDGET_CHARS` above.
 */
export function resolveThreadBudgetChars(input: BudgetInput = {}): number | undefined {
  const budget = resolveContextBudget(input);
  if (budget.source === 'default') return undefined;
  const basis = budget.window ?? budget.budget;
  const chars = Math.floor(basis * (1 - CONTEXT_HEADROOM_PCT) * CHARS_PER_TOKEN);
  return Math.max(MIN_THREAD_BUDGET_CHARS, Math.min(MAX_THREAD_BUDGET_CHARS, chars));
}

/**
 * Resolve the writer/edit FILE-CONTEXT caps for a served provider × model.
 * Unknown windows keep today's constants (10 files / 16K chars) exactly.
 * Known windows scale the character budget with the model's real window and
 * the file COUNT gently with it (more files of low relevance hurt more than
 * they help), both capped so a prompt stays useful, not merely large.
 */
export function resolveContextFileBudget(input: BudgetInput = {}): {
  maxFiles: number;
  maxChars: number;
} {
  const budget = resolveContextBudget(input);
  if (budget.source === 'default') {
    return { maxFiles: DEFAULT_CONTEXT_FILES, maxChars: DEFAULT_CONTEXT_FILE_CHARS };
  }
  // Base the file budget on the REAL window (not the floored budget) so a tiny
  // window is never handed more context than it can hold; an explicit override
  // (no window) falls back to the override's own token budget.
  const basis = budget.window ?? budget.budget;
  const maxChars = Math.min(
    MAX_CONTEXT_FILE_CHARS,
    Math.max(
      DEFAULT_CONTEXT_FILE_CHARS,
      Math.floor(basis * CONTEXT_FILE_WINDOW_FRACTION * CHARS_PER_TOKEN),
    ),
  );
  const maxFiles = Math.min(
    MAX_CONTEXT_FILES,
    Math.max(DEFAULT_CONTEXT_FILES, Math.round(maxChars / 25_000)),
  );
  return { maxFiles, maxChars };
}
