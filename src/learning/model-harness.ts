/**
 * Model Harness Profile (R1) — fit the harness to the MODEL, not just to config.
 *
 * ROOT CAUSE this module exists to fix: every harness decision in the agent loop
 * was made without knowing which model would run. `getLoopExposureMode(cm)`
 * reads a config key and returns the same value for a 0.5B local model and for
 * gpt-oss:120b; the transport choice (`generateTools` vs the JSON contract) is
 * made per candidate and only learns a model cannot take native tools by first
 * burning a 400 on it, every turn, because the memo is per-call. Effective
 * capability is `model × (1 − harness tax)`, so a fixed harness taxes the weak
 * model hardest — which is why a smaller model elsewhere can outperform a 120B
 * here.
 *
 * This is deliberately a PURE function: no I/O, no registry, no config reads
 * beyond the exposure the caller already resolved. That keeps it cheap enough to
 * call per candidate, trivial to test, and free of import-cycle risk (the loop
 * and the CLI both depend on it, so it must not depend on them).
 *
 * Model knowledge here is name/family based, with a documented rationale per
 * rule. Where a caller knows the real context window (the model registry records
 * it from a provider's `listModels` probe), it should pass it: the context gate
 * is the difference between a 4K model receiving ~3.8K tokens of schemas and
 * receiving ~17K tokens of them and dying.
 */

/** How tool calls reach the model. */
export type HarnessTransport = 'native' | 'json';

export interface ModelHarnessProfile {
  /**
   * Tool exposure. `tiered` starts at the CORE primitive set (~16 schemas,
   * ~3.8K tokens/step) and loads domain toolsets mid-turn via `tool_search`;
   * `all` hands over every schema (~110, ~17K tokens/step).
   */
  exposure: 'tiered' | 'all';
  /** Native provider tool-calling, or the explicit JSON tool contract. */
  transport: HarnessTransport;
  /** Bound on concurrent read-only tool calls in one step. */
  maxParallelReads: number;
  /** Human-readable justification — logged, and asserted in tests. */
  reason: string;
}

export interface ModelHarnessInput {
  /** Model tag as the provider knows it (e.g. `gpt-oss:120b`, `qwen2.5:0.5b`). */
  model?: string;
  /** Exposure resolved from config (`tools.loopExposure`), the user's opt-in. */
  configExposure?: 'tiered' | 'all';
  /** Real context window in tokens when the caller knows it (registry/probe). */
  contextLength?: number;
}

/**
 * Models at or below ~4B effective parameters. They are the ones that visibly
 * fail on a wide schema wall and on multi-call steps, so they get the tightest
 * harness. Matches `:0.5b`, `:1b`, `:1.5b`, `:3b`, `:4b`, `:e2b`, `:e4b` — but
 * deliberately NOT `:20b`, `:70b`, `:120b`.
 */
const TINY_MODEL = /(?:[:@\-])(?:0\.\d+|[1-4]|e[1-4])b\b/i;

/** Families that are tiny regardless of tag (no size in the name). */
// Trailing version digits are part of the name (`phi3`, `phi-3`), so the family
// alternates allow a numeric suffix: a trailing `\b` right after `phi` would
// never match `phi3` (there is no word boundary between `i` and `3`).
const TINY_FAMILY = /\b(phi[\d.\-]*|tinyllama|smollm|flan-t5)\b/i;

/**
 * Families that ship an OpenAI-compatible (or harmony) tool-calling API. For
 * these, native tools are the fast and reliable path; everything else starts on
 * the JSON contract rather than discovering a 400 first.
 */
const NATIVE_TOOL_FAMILIES =
  /\b(gpt-oss|gpt-4|gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4[-:]|claude|gemini|qwen|llama-?3\.[123]|mixtral|mistral|magistral|devstral|glm-?4|command-r|deepseek|kimi|grok|minimax|liquid|granite|hermes|firefunction)\b/i;

/**
 * `all` exposure costs roughly 17K tokens of schema per step. A model whose
 * window cannot hold that plus the thread must never be handed it, whatever the
 * config says — that is the schema wall that kills small-context models.
 */
const ALL_EXPOSURE_MIN_CONTEXT = 32_000;

const STRONG_PARALLEL_READS = 4;
/** Small models rarely emit parallel calls, and interleaved results confuse them. */
const TINY_PARALLEL_READS = 1;

/**
 * Resolve the harness for one model. Pure and side-effect free.
 *
 * Precedence: a tiny model always gets the tightened harness (it cannot handle
 * the wide surface); otherwise the caller's config choice is honoured, except
 * that `all` requires enough context to pay for it.
 */
export function resolveModelHarnessProfile(input: ModelHarnessInput): ModelHarnessProfile {
  const model = (input.model ?? '').trim();
  const configExposure = input.configExposure ?? 'tiered';
  const isTiny = isTinyModel(model);
  const hasNativeTools = NATIVE_TOOL_FAMILIES.test(model);
  const native = hasNativeTools && !isTiny;

  // Native tools are the fast path only where we actually expect support;
  // otherwise the JSON contract is the deterministic answer instead of a 400.
  const transport: HarnessTransport = native ? 'native' : 'json';

  let exposure: 'tiered' | 'all' = 'tiered';
  let reason: string;

  if (isTiny) {
    exposure = 'tiered';
    reason = `tiny model (${model || 'unknown'}) — tiered exposure, ${transport} transport`;
  } else if (configExposure === 'all') {
    const window = input.contextLength;
    if (window === undefined || window >= ALL_EXPOSURE_MIN_CONTEXT) {
      exposure = 'all';
      reason = `config opted into full exposure and ${window === undefined ? 'window is unknown' : `window ${window} >= ${ALL_EXPOSURE_MIN_CONTEXT}`}`;
    } else {
      exposure = 'tiered';
      reason = `config opted into full exposure but window ${window} < ${ALL_EXPOSURE_MIN_CONTEXT} (~17K tokens of schemas would not fit)`;
    }
  } else {
    reason = `config exposure '${configExposure}'${native ? '' : ` — ${transport} transport for unknown/weak tool-calling family`}`;
  }

  return {
    exposure,
    transport,
    maxParallelReads: isTiny ? TINY_PARALLEL_READS : STRONG_PARALLEL_READS,
    reason,
  };
}

/**
 * Is this model small enough that the wide harness actively hurts it?
 * Exported because more than one seam needs the same answer.
 */
export function isTinyModel(model: string | undefined): boolean {
  const tag = (model ?? '').trim();
  return TINY_MODEL.test(tag) || TINY_FAMILY.test(tag);
}

/**
 * Should this model skip a native tool-calling attempt entirely?
 *
 * The CLI used to find out by trying: a model without native support answered
 * with a 400, and the JSON contract took over — re-paid on every turn because
 * the refusal memo never outlived the call. Asking this up front turns that into
 * a deterministic transport decision.
 *
 * Deliberately narrow: it answers `true` only on POSITIVE evidence of weakness
 * (a tiny model). An unrecognised family still attempts native tools and falls
 * back on the existing 400 → JSON path, so a model this file has never heard of
 * cannot silently lose the fast path.
 */
export function shouldSkipNativeTools(input: ModelHarnessInput): boolean {
  return isTinyModel(input.model);
}
