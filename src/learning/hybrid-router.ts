/**
 * HybridModelRouter — Intelligent model selection engine.
 *
 * Enhances the existing ModelRouter with:
 * 1. Task complexity analysis — detects complexity from goal/description
 * 2. Cost budget awareness — respects user's cost limits per session
 * 3. Multi-model consensus — runs critical tasks through multiple models
 * 4. Automatic fallback chains — if primary fails, try alternatives
 * 5. Routing decisions exposed for user override
 *
 * Integration:
 * - The Orchestrator calls `resolveRouting()` before each agent step
 * - Returns a `RoutingDecision` that the Orchestrator can inspect/override
 * - In verbose mode, decisions are logged for user visibility
 * - Users can set `--provider`/`--model` CLI flags to override any decision
 */

import { recommendModel, buildAgentModelMap, type AgentModelMap } from './model-router.js';
import { getCostTracker, calculateCost, estimateTokens } from './cost-tracker.js';
import { getBenchmarkRuns } from './benchmark.js';
import type { InferenceProvider } from '../inference/interface.js';
import { getDefaultModel } from '../inference/provider-catalog.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Complexity levels for routing decisions */
export type ComplexityLevel = 'trivial' | 'simple' | 'moderate' | 'complex' | 'critical';

/** A single model candidate in a fallback chain */
export interface ModelCandidate {
  provider: string;
  model: string;
  /** Estimated cost for this call (USD) */
  estimatedCost: number;
  /** Estimated quality score (0–1) from benchmark data */
  qualityScore: number;
  /** Reason this candidate was selected */
  reason: string;
  /**
   * M2.5: nominal input context window (tokens) for this provider×model, from
   * the context preflight table. Present when the context-fit signal is
   * enabled; absent (undefined) when disabled or unknown.
   */
  contextWindowTokens?: number;
}

/** The final routing decision for a single LLM call */
export interface RoutingDecision {
  /** The agent type this decision is for */
  agentType: string;
  /** Detected complexity level */
  complexity: ComplexityLevel;
  /** The selected provider */
  provider: string;
  /** The selected model */
  model: string;
  /** Full fallback chain (primary is first) */
  fallbackChain: ModelCandidate[];
  /** Whether multi-model consensus was used */
  useConsensus: boolean;
  /** Whether the user explicitly overrode this decision */
  userOverridden: boolean;
  /** Human-readable explanation of this decision */
  explanation: string;
}

/**
 * Preference modes for model routing.
 * - `balanced`: Default — matches provider to complexity
 * - `performance-first`: Prefers faster, higher-quality providers even for simpler tasks
 * - `cost-first`: Prefers cheaper providers even for complex tasks
 * - `privacy-first`: Prefers local/offline providers, avoids cloud APIs
 */
export type PreferenceMode = 'balanced' | 'performance-first' | 'cost-first' | 'privacy-first';

/** Options for the hybrid router */
export interface HybridRouterOptions {
  /** User's cost budget for this session (USD) */
  sessionBudget?: number;
  /** Whether to use multi-model consensus for critical tasks */
  enableConsensus?: boolean;
  /** Whether the user has explicitly set --provider or --model */
  userProvider?: string;
  userModel?: string;
  /** Whether logging is enabled */
  verbose?: boolean;
  /** Preference mode for routing decisions (default: 'balanced') */
  preferenceMode?: PreferenceMode;
  /** Whether to use runtime agent stats to adjust model selection (default: false) */
  useRuntimeStats?: boolean;
}

// ─── Complexity Analysis ────────────────────────────────────────────────────

/** Keywords that indicate task complexity */
const COMPLEXITY_KEYWORDS: Record<ComplexityLevel, RegExp[]> = {
  trivial: [
    /format|lint|comment|indent|rename/i,
    /typo|spelling|trivial/i,
    /simple\s+(change|fix|edit)/i,
  ],
  simple: [
    /refactor|extract|inline|move/i,
    /add\s+(method|function|route|endpoint)/i,
    /fix\s+(bug|issue|error)/i,
    /implement\s+(small|simple)/i,
  ],
  moderate: [
    /implement|create|build|develop/i,
    /add\s+(feature|module|component)/i,
    /integrate|migrate|convert/i,
    /auth|authentication|authorization|api/i,
  ],
  complex: [
    /architecture|architect|design\s+system/i,
    /security\s+(audit|review|scan)/i,
    /optimize|performance|scale/i,
    /multi[- ]?thread|concurrent|parallel/i,
    /database|migration|schema/i,
    /distributed|microservice/i,
  ],
  critical: [
    /production|deploy|release|rollout/i,
    /critical|urgent|emergency|p0|p1/i,
    /security\s+(fix|patch|vulnerability)/i,
    /consensus|vote|multiple\s+models/i,
    /data\s+(loss|breach|corruption)/i,
  ],
};

/**
 * The separable AREAS of work an ask names.
 *
 * B5 — WHY BREADTH IS MEASURED AT ALL. The keyword ladder below reads
 * VOCABULARY, and vocabulary is a poor proxy for size. The measured case: the
 * parity task *"Build a knowledge base web app where users can: upload documents
 * (PDF, TXT, Markdown); automatically extract embeddings (FAISS or Milvus); query
 * the knowledge base using an LLM (via adapters like Groq, Gemini, DeepSeek); view
 * results in a React dashboard."* names FOUR separable subsystems and eight
 * technologies, and rated `moderate` — because the only keyword that matched was
 * `build`, which is a `moderate` word. `/architecture/` never appears; nobody
 * writes "architect" when they write a requirements list.
 *
 * So the ask's SHAPE is measured too: how many distinct areas of work it names.
 * An ask that spans ingestion, embeddings, retrieval/generation and a UI is not a
 * moderate task whatever verb introduces it. The area set is deliberately coarse
 * (twelve areas, one regex each) — the question is "how many different kinds of
 * work", not "how many words are in my list", and a finer set would start
 * counting synonyms as subsystems.
 */
const CAPABILITY_AREA_RE: ReadonlyArray<readonly [string, RegExp]> = [
  ['ingestion', /upload|ingest|import|parse|extract\s+(?:text|data|content)|attachment/i],
  ['embeddings', /embedding|vector|faiss|milvus|pinecone|chroma|weaviate|semantic\s+(?:search|index)|training|fine[- ]?tun/i],
  ['generation', /\bllm\b|gpt|claude|gemini|deepseek|groq|openai|anthropic|prompt|rag\b|adapter/i],
  ['retrieval', /retriev|rank|relevance|\bindex(?:ing)?\b|\bsearch\b|quer(?:y|ies)/i],
  ['frontend', /dashboard|front[- ]?end|\bui\b|\bux\b|react|vue|svelte|component|screen|\bpage\b|html|css/i],
  ['backend', /\bapi\b|\bserver\b|endpoint|back[- ]?end|rest\b|graphql|\bservice\b|\broute[s]?\b/i],
  ['persistence', /database|storage|persist|\bschema\b|migration|\bsql\b|postgres|mongo|sqlite|redis|\btable[s]?\b/i],
  ['auth', /auth|login|sign[- ]?up|permission|\brole[s]?\b|session|token|oauth/i],
  ['realtime', /realtime|real[- ]time|websocket|\bsocket\b|stream|pubsub|\bqueue\b|worker|\bjob[s]?\b|cron/i],
  ['testing', /\btest[s]?\b|\bspec[s]?\b|coverage|vitest|jest|pytest|e2e|assertion/i],
  ['deploy', /deploy|docker|kubernetes|\bci\/cd\b|pipeline|container|cloud|\baws\b|\bgcp\b|azure|infrastructure/i],
  ['integration', /webhook|integration|third[- ]party|payment|stripe|\bemail\b|\bsms\b|notification|slack|whatsapp|telegram/i],
];

/**
 * The requirement UNITS an ask enumerates: its list items.
 *
 * Split on the separators that structure a request (a colon that introduces a
 * list, semicolons, newlines, bullet markers, numbered markers) and keep the
 * substantive ones. Deliberately NOT split on "and" or commas — "PDF, TXT,
 * Markdown" is ONE requirement with three file types, and counting it three
 * times would inflate every ask that mentions a list.
 */
export function requirementUnits(text: string): string[] {
  return (text ?? '')
    .split(/[:;\n]|(?:^|\s)[-*\u2022]\s|(?:^|\s)\d+[.)]\s/)
    .map((u) => u.trim())
    // A fragment this short is a label or a lead-in ("Requirements"), not a unit.
    .filter((u) => u.length >= 10);
}

/**
 * MEASURED breadth: how many requirement units, and how many distinct areas of
 * work. Exported so a test (and any future explain surface) can state WHY a
 * level was reached instead of asserting it blindly.
 */
export function measureTaskBreadth(text: string): {
  units: number;
  areas: number;
  areaNames: string[];
} {
  const areaNames = CAPABILITY_AREA_RE.filter(([, re]) => re.test(text ?? '')).map(([name]) => name);
  return { units: requirementUnits(text ?? '').length, areas: areaNames.length, areaNames };
}

/**
 * The breadth FLOOR: the level an ask's size alone justifies, or null.
 *
 * Both thresholds must be met — three or more enumerated requirements spanning
 * three or more areas of work — and requiring BOTH is what keeps this from firing
 * on an ordinary request that merely mentions several technologies ("build a todo
 * app with React and localStorage" is one requirement and one area, so `moderate`
 * stays right) or that enumerates a single area at length ("read a CSV; print a
 * table; write a JSON file" is 4 units but 0 named areas).
 *
 * Measured at both thresholds, then chosen: `areas >= 4` missed a four-component
 * ask that named Stripe + Postgres + React + email (5 units, exactly 3 areas), and
 * every false-positive shape above has units 1 or 2, so the looser area bar costs
 * nothing. It cannot reach `critical` in any case: breadth establishes SIZE, and
 * `critical` is about urgency and blast radius, which size alone does not imply.
 */
function breadthFloor(text: string): ComplexityLevel | null {
  const { units, areas } = measureTaskBreadth(text);
  if (units >= 3 && areas >= 3) return 'complex';
  return null;
}

/** Ordering so two levels can be compared (a floor may only RAISE a level). */
const LEVEL_RANK: Record<ComplexityLevel, number> = {
  trivial: 0,
  simple: 1,
  moderate: 2,
  complex: 3,
  critical: 4,
};

/**
 * Analyze a task description or user goal to determine its complexity level.
 *
 * Two signals, and the HIGHER one wins:
 * 1. the keyword ladder (vocabulary — what the ask says),
 * 2. the breadth floor (shape — how much separable work it enumerates).
 *
 * B5, measured before/after: the parity task above rated `moderate` on the
 * ladder alone (only `build` matched) and rates `complex` with the shape
 * measured (4 units, 5 areas: ingestion / embeddings / generation+retrieval /
 * frontend / persistence). The floor can only RAISE a level — a task whose words
 * already say `critical` still says `critical`, because size must never talk the
 * router down from urgency.
 *
 * @param text — The task description or user goal
 * @returns The detected complexity level
 */
export function analyzeComplexity(text: string): ComplexityLevel {
  const fromKeywords = complexityFromKeywords(text ?? '');
  const floor = breadthFloor(text ?? '');
  if (floor && LEVEL_RANK[floor] > LEVEL_RANK[fromKeywords]) return floor;
  return fromKeywords;
}

/**
 * Is this message NOTHING BUT a greeting?
 *
 * B2 — WHY A PREDICATE AND NOT THREE `includes()` CALLS. Both
 * `estimateTaskRequirements` implementations used to decide this with
 * `desc.includes('hello') || desc.includes('hi') || desc.includes('greeting')`,
 * and `'hi'` is a SUBSTRING of `this`, `which`, `anything`, `nothing`,
 * `shift`, `crashing`, `architecture`, `graphify`… Measured against the 160
 * distinct tasks in `~/.nuvira/memory/routing-history.json`: **77 of them**
 * matched the substring while containing no greeting at all, and 81/160 landed
 * on `reasoningNeed: 'low'` (only 2 on `'high'`). `low` is not cosmetic — it
 * flips the candidate weights to cost 0.30 / capabilityFit 0.15 and inverts
 * `capabilityFit` to PREFER small models, so a multi-provider engineering ask
 * was ranked `gemini/gemma-4-26b-a4b-it` (4B active) #1, `local/qwen2.5:0.5b`
 * #2, `gemini/allam-2-7b` #3 — the run that then fell through three providers.
 *
 * The intent is narrow: answering a bare "hi" should not provision a frontier
 * model. A greeting BURIED IN A REAL ASK is not that case, and neither is the
 * word "this". So the test is not "does it contain a greeting word" but "is
 * there nothing here but a greeting and pleasantries": the greeting is removed
 * and what remains must be empty or filler. `"hi"` → true; `"hi there!"` →
 * true; `"hello, how are you?"` → true; `"hi, build me a RAG pipeline"` →
 * false (that is a task that happens to open politely); `"this will work"` →
 * false (no greeting word at all).
 *
 * Shared from here so the two routers cannot drift apart on it again —
 * `model-first-router.ts` and `model-scoring.ts` previously carried two copies
 * of this rule that already disagreed about other phrases.
 */
export function isSmallTalk(text: string): boolean {
  const lower = (text ?? '').toLowerCase();
  // `\b` on both sides: a greeting is a whole word, never a fragment of one.
  const greetingRe = /\b(?:hello|hi|hey|howdy|greetings?|good\s+(?:morning|afternoon|evening))\b/g;
  const stripped = lower.replace(greetingRe, ' ');
  // No greeting word at all — including "this", "which", "anything".
  if (stripped === lower) return false;
  // What is left must be punctuation and pleasantries, nothing that names work.
  const fillerRe =
    /^(?:[\s,.!?~\-—–:;'"()\[\]]|"(?:s|t|re|ll|ve|d|m)"|\b(?:there|again|all|everyone|folks|team|buddy|mate|please|pls|thanks|thank|you|thx|and|ok|okay|k|so|just|now|yes|yeah|yep|sure|whats|what's|up|how|are|is|it|going|doing|was|were|been|im|i'm|am)\b)*$/;
  return fillerRe.test(stripped);
}

/** The keyword ladder, unchanged — the vocabulary half of the decision. */
function complexityFromKeywords(text: string): ComplexityLevel {
  // Check critical first (highest priority)
  for (const keyword of COMPLEXITY_KEYWORDS.critical) {
    if (keyword.test(text)) return 'critical';
  }

  // Check complex
  for (const keyword of COMPLEXITY_KEYWORDS.complex) {
    if (keyword.test(text)) return 'complex';
  }

  // Check moderate
  for (const keyword of COMPLEXITY_KEYWORDS.moderate) {
    if (keyword.test(text)) return 'moderate';
  }

  // Check simple
  for (const keyword of COMPLEXITY_KEYWORDS.simple) {
    if (keyword.test(text)) return 'simple';
  }

  // Check trivial
  for (const keyword of COMPLEXITY_KEYWORDS.trivial) {
    if (keyword.test(text)) return 'trivial';
  }

  // Default: moderate (safe default)
  return 'moderate';
}

/**
 * Get the recommended provider based on complexity and preference mode.
 *
 * @param complexity - Detected complexity level
 * @param mode - Preference mode (default: 'balanced')
 * @returns The recommended provider type
 */
function providerForComplexity(
  complexity: ComplexityLevel,
  mode: PreferenceMode = 'balanced',
): string {
  // privacy-first: always prefer local, fall back to groq only for complex work
  if (mode === 'privacy-first') {
    switch (complexity) {
      case 'trivial':
      case 'simple':
      case 'moderate': return 'local';
      case 'complex':
      case 'critical': return 'groq'; // minimal cloud exposure
    }
  }

  // cost-first: always choose the cheapest adequate provider
  if (mode === 'cost-first') {
    switch (complexity) {
      case 'trivial':
      case 'simple':
      case 'moderate': return 'local';
      case 'complex': return 'groq';
      case 'critical': return 'gemini';
    }
  }

  // performance-first: push harder tasks to stronger providers earlier
  if (mode === 'performance-first') {
    switch (complexity) {
      case 'trivial': return 'groq';
      case 'simple': return 'groq';
      case 'moderate': return 'gemini';
      case 'complex': return 'openrouter';
      case 'critical': return 'openrouter';
    }
  }

  // Default balanced mode
  switch (complexity) {
    case 'trivial': return 'local';
    case 'simple': return 'groq';
    case 'moderate': return 'groq';
    case 'complex': return 'gemini';
    case 'critical': return 'openrouter';
  }
}

/**
 * Estimate cost for a model call based on provider, model, and estimated token usage.
 * Reuses CostTracker's calculateCost and estimateTokens for consistent pricing.
 */
function estimateCallCost(
  provider: string,
  model: string,
  inputTokens?: number,
  outputTokens?: number,
): number {
  return calculateCost(
    provider,
    model,
    inputTokens ?? 1000,
    outputTokens ?? 500,
  );
}

// ─── Fallback Chain Builder ─────────────────────────────────────────────────

/**
 * Build a fallback chain for a given agent type and complexity.
 * The chain is ordered: primary → secondary → tertiary.
 * Respects preference mode and optionally uses runtime stats.
 *
 * @param agentType - The agent type (e.g., 'writer', 'planner')
 * @param complexity - Detected complexity level
 * @param options - Router options (budget, overrides, preferenceMode)
 * @param runtimeModel - Optional model name from runtime stats (overrides recommendation.model)
 * @returns An ordered array of model candidates
 */
export function buildFallbackChain(
  agentType: string,
  complexity: ComplexityLevel,
  options: HybridRouterOptions = {},
  runtimeModel?: string,
): ModelCandidate[] {
  const chain: ModelCandidate[] = [];
  const mode = options.preferenceMode || 'balanced';

  // If user explicitly set provider/model, that's the only option
  if (options.userProvider && options.userModel) {
    chain.push({
      provider: options.userProvider,
      model: options.userModel,
      estimatedCost: estimateCallCost(options.userProvider, options.userModel),
      qualityScore: 0.7,
      reason: 'User-specified provider/model',
    });
    return chain;
  }

  // Get the recommended model from the existing ModelRouter
  const recommendation = recommendModel(agentType);

  // Build fallback chain based on complexity and preference mode
  const preferredProvider = options.userProvider || providerForComplexity(complexity, mode);

  // Use runtime-adjusted model if available (overrides recommendation.model)
  const primaryModel = runtimeModel || recommendation.model || 'default';

  // Quality score baseline adjusted by preference mode
  const qualityBoost = mode === 'performance-first' ? 0.1
    : mode === 'privacy-first' ? -0.05
    : 0;

  // Primary: the complexity-matched or user-specified provider
  const primaryReason = runtimeModel
    ? `Primary choice (stats-adjusted: ${runtimeModel})`
    : `Primary choice for ${complexity} complexity`;
  chain.push({
    provider: preferredProvider,
    model: primaryModel,
    estimatedCost: estimateCallCost(preferredProvider, primaryModel),
    qualityScore: Math.min(1, (complexity === 'critical' ? 0.9 : complexity === 'complex' ? 0.8 : 0.7) + qualityBoost),
    reason: primaryReason,
  });

  // Secondary fallback: swap provider (adjusted for privacy-first mode)
  // CRITICAL: never use literal 'default' as model — resolve to a real model
  // name via the catalog so the provider API never receives a 404.
  const secondaryProvider = mode === 'privacy-first' ? 'groq'
    : preferredProvider === 'local' ? 'groq'
    : preferredProvider === 'groq' ? 'nim'
    : preferredProvider === 'nim' ? 'gemini'
    : preferredProvider === 'gemini' ? 'openrouter'
    : 'groq';
  const secondaryModel = getDefaultModel(secondaryProvider);

  chain.push({
    provider: secondaryProvider,
    model: secondaryModel,
    estimatedCost: estimateCallCost(secondaryProvider, secondaryModel),
    qualityScore: Math.min(1, 0.6 + qualityBoost),
    reason: `Fallback: switch to ${secondaryProvider}`,
  });

  // Tertiary fallback
  const tertiaryProvider = secondaryProvider === 'groq' ? 'gemini' : 'groq';
  const tertiaryModel = getDefaultModel(tertiaryProvider);
  chain.push({
    provider: tertiaryProvider,
    model: tertiaryModel,
    estimatedCost: estimateCallCost(tertiaryProvider, tertiaryModel),
    qualityScore: Math.min(1, 0.5 + qualityBoost),
    reason: `Final fallback: switch to ${tertiaryProvider}`,
  });

  return chain;
}

// ─── Budget Check ───────────────────────────────────────────────────────────

/**
 * Check if the session has remaining budget for a model call.
 *
 * @param options - Router options (includes sessionBudget)
 * @param estimatedCost - Estimated cost of the proposed call
 * @returns True if within budget, false if over
 */
export function checkBudget(
  options: HybridRouterOptions,
  estimatedCost: number,
): { withinBudget: boolean; remainingBudget: number } {
  if (!options.sessionBudget) {
    return { withinBudget: true, remainingBudget: Infinity };
  }

  const tracker = getCostTracker();
  const summary = tracker.getSummary();
  const spent = summary.sessionCost;
  const remaining = options.sessionBudget - spent;

  return {
    withinBudget: estimatedCost <= remaining,
    remainingBudget: remaining,
  };
}

/**
 * Select a model candidate from the fallback chain that fits the budget.
 */
function selectWithinBudget(
  chain: ModelCandidate[],
  options: HybridRouterOptions,
): ModelCandidate {
  for (const candidate of chain) {
    const { withinBudget } = checkBudget(options, candidate.estimatedCost);
    if (withinBudget) return candidate;
  }

  // If nothing fits the budget, return the cheapest option
  return chain.reduce((cheapest, candidate) =>
    candidate.estimatedCost < cheapest.estimatedCost ? candidate : cheapest,
  );
}

// ─── Multi-Model Consensus ──────────────────────────────────────────────────

/**
 * Results from a multi-model consensus run.
 */
export interface ConsensusResult {
  providerA: string;
  modelA: string;
  providerB: string;
  modelB: string;
  /** Whether the two models agreed */
  agreed: boolean;
  /** Combined/enhanced response (when agreed, uses A's response) */
  combinedResponse: string;
  /** Individual responses */
  responseA: string;
  responseB: string;
}

/**
 * Compare two model outputs and determine if they agree at a high level.
 * Simple heuristic: checks if key terms/sections overlap.
 *
 * @param responseA — Output from model A
 * @param responseB — Output from model B
 * @param threshold — Similarity threshold (0–1, default 0.3)
 * @returns Whether the responses agree
 */
export function checkConsensus(
  responseA: string,
  responseB: string,
  threshold: number = 0.3,
): boolean {
  // Tokenize into words (lowercase)
  const tokensA = new Set(
    responseA.toLowerCase().split(/\W+/).filter((t) => t.length > 3),
  );
  const tokensB = new Set(
    responseB.toLowerCase().split(/\W+/).filter((t) => t.length > 3),
  );

  if (tokensA.size === 0 || tokensB.size === 0) return true; // Fallback: assume agree

  // Calculate Jaccard similarity
  const intersection = new Set([...tokensA].filter((t) => tokensB.has(t)));
  const union = new Set([...tokensA, ...tokensB]);
  const similarity = intersection.size / union.size;

  return similarity >= threshold;
}

// ─── Hybrid Model Router ────────────────────────────────────────────────────

/**
 * The main HybridModelRouter class.
 *
 * Usage:
 * ```ts
 * const router = new HybridModelRouter({ sessionBudget: 0.50, verbose: true });
 * const decision = await router.resolveRouting('writer', 'Implement auth module');
 * console.log(decision.explanation);
 * // → "Moderate complexity: using groq/llama-3.3-70b-versatile. Budget remaining: $0.48"
 *
 * // For critical tasks with consensus:
 * if (decision.useConsensus) {
 *   const consensus = await router.runConsensus(
 *     prompt,
 *     decision.fallbackChain[0],
 *     decision.fallbackChain[1],
 *   );
 * }
 * ```
 */
export class HybridModelRouter {
  private options: HybridRouterOptions;

  constructor(options: HybridRouterOptions = {}) {
    this.options = {
      enableConsensus: true,
      verbose: false,
      ...options,
    };
  }

  /**
   * Resolve the optimal routing decision for a given agent type and task.
   *
   * Supports:
   * - Preference modes (performance-first, cost-first, privacy-first, balanced)
   * - Runtime stats integration (useRuntimeStats: reads agent-stats for best model)
   * - Budget awareness
   * - Consensus for critical tasks
   *
   * @param agentType — Agent type (e.g., 'writer', 'planner')
   * @param taskDescription — The task description or user goal
   * @param overrides — Optional per-call overrides
   * @returns A RoutingDecision with provider, model, fallback chain, and explanation
   */
  async resolveRouting(
    agentType: string,
    taskDescription: string,
    overrides?: Partial<HybridRouterOptions>,
  ): Promise<RoutingDecision> {
    const opts = { ...this.options, ...overrides };
    const mode = opts.preferenceMode || 'balanced';
    const complexity = analyzeComplexity(taskDescription);

    // Item 2: Runtime stats integration — adjust primary model based on historical performance
    let runtimeAdjustedModel: string | undefined;
    if (opts.useRuntimeStats) {
      try {
        const { getAgentStats } = await import('./agent-stats.js');
        const stats = getAgentStats();
        const bestModel = stats.getBestModel(agentType);
        if (bestModel) {
          runtimeAdjustedModel = bestModel;
          if (opts.verbose) {
            logger.info(`  📊 Runtime stats: best model for '${agentType}' is ${bestModel}`);
          }
        }
      } catch {
        // Non-critical — fall back to default routing
      }
    }

    // Build fallback chain with optionally runtime-adjusted model
    // Only apply runtime adjustment if user hasn't explicitly set --model
    const runtimeModel = runtimeAdjustedModel && !opts.userModel ? runtimeAdjustedModel : undefined;

    const fallbackChain = buildFallbackChain(agentType, complexity, opts, runtimeModel);

    // Select within budget
    const selected = selectWithinBudget(fallbackChain, opts);

    // Determine if consensus is needed
    const useConsensus = opts.enableConsensus !== false &&
      complexity === 'critical' &&
      !opts.userProvider;

    // Build explanation
    const explanation = this.buildExplanation(agentType, complexity, selected, fallbackChain, opts, runtimeAdjustedModel);

    if (opts.verbose) {
      logger.info(`  🔀 Routing: ${explanation}`);
    }

    return {
      agentType,
      complexity,
      provider: selected.provider,
      model: selected.model,
      fallbackChain,
      useConsensus,
      userOverridden: !!opts.userProvider,
      explanation,
    };
  }

  /**
   * Run multi-model consensus for a critical task.
   * Sends the same prompt to two different models and compares results.
   *
   * @param prompt — The LLM prompt
   * @param primary — Primary model (used if agreement reached)
   * @param secondary — Secondary model (for comparison)
   * @param callLLM — Function to call a specific provider/model
   * @returns Consensus result with combined response
   */
  async runConsensus(
    prompt: string,
    primary: ModelCandidate,
    secondary: ModelCandidate,
    callLLM: (prompt: string, provider: string, model: string) => Promise<string>,
  ): Promise<ConsensusResult> {
    logger.info('  🔀 Running multi-model consensus for critical task...');

    // Run both models in parallel
    const [responseA, responseB] = await Promise.all([
      callLLM(prompt, primary.provider, primary.model),
      callLLM(prompt, secondary.provider, secondary.model),
    ]);

    const agreed = checkConsensus(responseA, responseB);

    if (agreed) {
      logger.success('  ✅ Models agree — using primary model result');
    } else {
      logger.warn('  ⚠️  Models disagree — falling back to primary (higher quality score)');
    }

    return {
      providerA: primary.provider,
      modelA: primary.model,
      providerB: secondary.provider,
      modelB: secondary.model,
      agreed,
      combinedResponse: responseA,
      responseA,
      responseB,
    };
  }

  /**
   * Try the fallback chain for a single call.
   * Returns the first successful result, or throws if all fail.
   *
   * @param prompt — The LLM prompt
   * @param chain — Fallback chain of model candidates
   * @param callLLM — Function to call a specific provider/model
   * @returns The response from the first successful model
   */
  async tryFallbackChain(
    prompt: string,
    chain: ModelCandidate[],
    callLLM: (prompt: string, provider: string, model: string) => Promise<string>,
  ): Promise<{ response: string; usedCandidate: ModelCandidate }> {
    const errors: string[] = [];

    for (const candidate of chain) {
      try {
        logger.debug(`  🔀 Trying fallback: ${candidate.provider}/${candidate.model}`);
        const response = await callLLM(prompt, candidate.provider, candidate.model);
        return { response, usedCandidate: candidate };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${candidate.provider}/${candidate.model}: ${msg.slice(0, 100)}`);
        logger.warn(`  ⚠️  Fallback ${candidate.provider}/${candidate.model} failed: ${msg.slice(0, 100)}`);
        continue;
      }
    }

    throw new Error(
      `All models in fallback chain failed:\n${errors.join('\n')}`,
    );
  }

  /**
   * Build a human-readable explanation of the routing decision.
   */
  private buildExplanation(
    agentType: string,
    complexity: ComplexityLevel,
    selected: ModelCandidate,
    chain: ModelCandidate[],
    opts: HybridRouterOptions,
    runtimeModel?: string,
  ): string {
    const parts: string[] = [];
    const mode = opts.preferenceMode || 'balanced';

    // Complexity
    const complexityLabels: Record<ComplexityLevel, string> = {
      trivial: '🟢 trivial',
      simple: '🔵 simple',
      moderate: '🟡 moderate',
      complex: '🟠 complex',
      critical: '🔴 critical',
    };
    parts.push(`${agentType} (${complexityLabels[complexity]})`);

    // Preference mode (if not balanced)
    if (mode !== 'balanced') {
      const modeIcon = mode === 'performance-first' ? '⚡'
        : mode === 'cost-first' ? '💰'
        : '🔒'; // privacy-first
      parts.push(`${modeIcon} ${mode}`);
    }

    // Selected model
    parts.push(`→ ${selected.provider}/${selected.model}`);

    // Runtime stats indicator
    if (runtimeModel) {
      parts.push('📊 stats-adjusted');
    }

    // Budget info
    if (opts.sessionBudget) {
      const { remainingBudget } = checkBudget(opts, selected.estimatedCost);
      parts.push(`$${remainingBudget.toFixed(4)} remaining`);
    }

    // Fallback chain summary
    if (chain.length > 1) {
      const fallbacks = chain.slice(1)
        .map((c) => `${c.provider}/${c.model}`)
        .join(' → ');
      parts.push(`fallback: ${fallbacks}`);
    }

    // Consensus
    if (complexity === 'critical' && opts.enableConsensus) {
      parts.push('🔀 consensus enabled');
    }

    // User override
    if (opts.userProvider) {
      parts.push('👤 user override');
    }

    return parts.join(' | ');
  }

  /**
   * Update options (e.g., when user sets --budget).
   */
  updateOptions(options: Partial<HybridRouterOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Get current options.
   */
  getOptions(): HybridRouterOptions {
    return { ...this.options };
  }

  /**
   * Get benchmark-driven recommendations for the best model for each agent type.
   * Uses data from ModelCompare and BenchmarkRunner.
   */
  getBenchmarkRecommendations(): Array<{
    agentType: string;
    recommendedModel: string;
    confidence: 'high' | 'medium' | 'low';
  }> {
    const runs = getBenchmarkRuns();
    if (runs.length === 0) return [];

    // Group runs by result characteristics (task IDs used as agent type proxy)
    const byAgent: Record<string, Array<{ model: string; score: number }>> = {};

    for (const run of runs) {
      const key = `${run.provider}/${run.model}`;

      for (const result of run.results) {
        // Use taskId as the agent type proxy
        const agentType = result.taskId || 'default';
        if (!byAgent[agentType]) byAgent[agentType] = [];
        byAgent[agentType].push({ model: key, score: result.qualityScore });
      }
    }

    return Object.entries(byAgent).map(([agentType, entries]) => {
      const best = entries.sort((a, b) => b.score - a.score)[0];
      const confidence: 'high' | 'medium' | 'low' =
        entries.length >= 10 ? 'high'
        : entries.length >= 5 ? 'medium'
        : 'low';

      return {
        agentType,
        recommendedModel: best.model,
        confidence,
      };
    });
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let routerInstance: HybridModelRouter | null = null;

/**
 * Get or create the default HybridModelRouter singleton.
 */
export function getHybridRouter(): HybridModelRouter {
  if (!routerInstance) {
    routerInstance = new HybridModelRouter();
  }
  return routerInstance;
}

/**
 * Reset the singleton (useful for testing).
 */
export function resetHybridRouter(): void {
  routerInstance = null;
}
