/**
 * The honest EXHAUSTION REPORT (fix_model_routing P4, invariants 2, 4 and 7).
 *
 * WHY THIS EXISTS. When every reachable model has been tried and the task is
 * still not delivered, the old answer was a one-line apology plus — worse — a
 * question: *"Want me to retry? Reply yes."* That makes the USER the retry
 * button, which is the single clearest way to fail them: a competent operator
 * does not walk back to the requester to ask permission to try the next worker,
 * and they certainly do not do it after the requester already asked once. The
 * user's own words: *"if user need to say retry that we are failing."*
 *
 * So the report's job is to say, in plain language and with NO follow-up
 * question:
 *
 *   1. what was tried, per model, and why each one did not answer;
 *   2. which targets are exhausted vs. DEAD vs. merely COOLING DOWN, and the
 *      WALL-CLOCK TIME each cooling one frees up (a wait length is unactionable;
 *      "free at 18:42" is something a person can plan around);
 *   3. what the system itself is doing about it (routing to an untried model,
 *      or waiting for a window) — stated as the system's job, not the user's;
 *   4. the concrete levers only the user can pull: recharge/replace a rejected
 *      credential, knowingly accept a weaker model, or narrow the ask.
 *
 * DETERMINISTIC AND LLM-FREE on purpose. A failure explanation that is itself
 * generated can hallucinate a reason or a time, and this text is the only thing
 * the user has left to trust. Every line here comes from measured state: the
 * failover walk's own attempt log, the routing exclusion ledger, and the pool
 * count — the SAME sources enforcement reads, so the report can never disagree
 * with what routing actually did.
 *
 * It DELIBERATELY does not duplicate `renderModelBreadthReport`'s job of
 * explaining a failure to a caller that still has a retry mechanism available;
 * it is the terminal, "there is nothing left" message, and its distinguishing
 * features are the absolute clocks, the named levers and the refusal to ask the
 * user to trigger anything.
 */

/** One model the walk actually reached, and how it went. */
export interface ExhaustionAttempt {
  provider: string;
  model: string;
  /** The classified failure kind ('empty-response', 'rate-limit', 'auth', …). */
  kind: string;
  /** A short human phrase — what the user can act on. */
  reason: string;
  /** True when the candidate was ruled out WITHOUT being called. */
  skipped?: boolean;
}

/** A target that could not be reached, with why and (when known) until when. */
export interface ExhaustionExclusion {
  provider: string;
  model?: string;
  kind: string;
  /**
   * When it becomes usable again (ms epoch). Absent/0 means "not on its own" —
   * a retired pair or a rejected credential does not heal with time.
   */
  expiresAt?: number;
  /** 'registry' marks a ruling (the pair does not exist), not a cooldown. */
  source?: string;
}

export interface ExhaustionInput {
  attempts: ExhaustionAttempt[];
  exclusions?: ExhaustionExclusion[];
  /** Eligible models the router would consider right now (measured, never guessed). */
  poolSize?: number;
  poolProviders?: number;
  /** What the user asked for, for the header. */
  task?: string;
  /**
   * The underlying failure line, when there is one (e.g. the provider's own
   * rejection text). Rendered as a `Reason:` line so a specific, actionable
   * cause is never lost behind the report.
   */
  cause?: string;
  /** Injected clock — reports are pure functions of their inputs. */
  now?: number;
}

export interface ExhaustionOption {
  /** `recharge` | `wait` | `weaker-model` | `narrow`. */
  code: 'recharge' | 'wait' | 'weaker-model' | 'narrow';
  text: string;
}

export interface ExhaustionReport {
  headline: string;
  /** `provider/model — reason`, one per model that was reached and failed. */
  tried: string[];
  /** Targets that were not reachable, with an absolute free time when it exists. */
  unavailable: Array<{ target: string; reason: string; freeAt?: number }>;
  /** Pairs ruled out because they do not exist on that provider. */
  retired: string[];
  /** The measured pool claim, when the pool was measured. */
  poolClaim?: string;
  /**
   * True when a healthy pool existed and the walk simply did not reach the
   * remaining models. That is a ROUTING GAP, not a shortage — and the report
   * says so instead of presenting it as an outage.
   */
  routingGap: boolean;
  /** The soonest a capable model comes back on its own (ms epoch). */
  nextFreeAt?: number;
  options: ExhaustionOption[];
  /** The rendered, ready-to-deliver text. */
  text: string;
}

/** `18:42` in the operator's own clock. Deterministic given a timestamp. */
export function formatClockTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** `2m`, `55m`, `3h` — a wait a person can read. */
export function formatWaitShort(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

/**
 * A phrase for a failure kind, in the vocabulary the user can act on.
 *
 * Exported so a caller RECORDING an attempt (chat's own walk) writes the same
 * words the report will print — the alternative is a raw provider message
 * reaching the user, which is how a JSON quota dump once got delivered verbatim
 * as an answer.
 */
export function describeFailureKind(kind: string): string {
  switch (kind) {
    case 'empty-response':
      return 'answered with nothing (no text, no tool call)';
    case 'rate-limit':
      return 'out of quota for now';
    case 'auth':
      return 'rejected its credential';
    case 'timeout':
      return 'timed out';
    case 'network':
      return 'unreachable (network)';
    case 'model-not-found':
      return 'model not found on that provider';
    case 'context-window':
      return 'the prompt was too large for its window';
    case 'server':
      return 'provider-side error';
    case 'skipped':
      return 'was not tried';
    default:
      return kind && kind !== 'unknown' ? kind : 'failed';
  }
}

/**
 * Build the report. Pure: same inputs, same text — no clock reads, no network,
 * no model call (pass `now` explicitly; absent means "measured here").
 */
export function buildExhaustionReport(input: ExhaustionInput): ExhaustionReport {
  const now = input.now ?? Date.now();
  const attempts = input.attempts ?? [];
  const exclusions = input.exclusions ?? [];
  const triedAttempts = attempts.filter((a) => !a.skipped);
  const skippedAttempts = attempts.filter((a) => a.skipped);

  const isRuling = (e: ExhaustionExclusion): boolean =>
    e.source === 'registry' && !!e.model;
  const retired = exclusions.filter(isRuling).map((e) => `${e.provider}/${e.model}`);
  const cooling = exclusions.filter((e) => !isRuling(e));

  const tried = triedAttempts.map((a) => {
    const reason = a.reason?.trim() ? a.reason : describeFailureKind(a.kind);
    return `${a.provider}/${a.model} — ${reason}`;
  });

  const unavailable: Array<{ target: string; reason: string; freeAt?: number }> = [];
  for (const e of cooling) {
    const target = e.model ? `${e.provider}/${e.model}` : e.provider;
    const freeAt = e.expiresAt && e.expiresAt > now ? e.expiresAt : undefined;
    unavailable.push({
      target,
      reason: describeFailureKind(e.kind),
      ...(freeAt ? { freeAt } : {}),
    });
  }
  // Every exclusion that will heal is a legitimate wait option; take the soonest.
  const nextFreeAt = unavailable.reduce<number | undefined>(
    (acc, u) => (u.freeAt === undefined ? acc : acc === undefined || u.freeAt < acc ? u.freeAt : acc),
    undefined,
  );

  const poolMeasured = typeof input.poolSize === 'number';
  const poolSize = input.poolSize ?? 0;
  const poolProviders = input.poolProviders ?? 0;
  // A routing gap: the pool was measured, models were reached, and eligible
  // models remained untouched. Presenting that as an outage is the dishonesty
  // the user called out when a healthy pool sat unused behind "no model
  // available".
  const routingGap = poolMeasured && triedAttempts.length > 0 && poolSize > triedAttempts.length;
  const emptyPool = poolMeasured && poolSize === 0;

  const parts: string[] = [];
  const attemptCount = triedAttempts.length;
  parts.push(
    input.task
      ? `I couldn't finish: ${input.task.slice(0, 120)}`
      : "I couldn't finish this one.",
  );
  const cause = input.cause?.trim();
  if (cause) parts.push(`Reason: ${cause}`);

  if (attemptCount > 0) {
    parts.push('');
    parts.push(`Tried ${attemptCount} model${attemptCount === 1 ? '' : 's'}, and every one of them was unable to do it:`);
    for (const line of tried.slice(0, 8)) parts.push(`  • ${line}`);
    if (tried.length > 8) parts.push(`  • …and ${tried.length - 8} more`);
  } else if (skippedAttempts.length > 0) {
    parts.push('');
    parts.push(
      `No model could even be called: ${skippedAttempts.length} candidate${skippedAttempts.length === 1 ? ' was' : 's were'} ruled out before a request went out.`,
    );
  }

  if (unavailable.length > 0) {
    parts.push('');
    parts.push('Unavailable right now, and when each comes back:');
    for (const u of unavailable.slice(0, 8)) {
      const when = u.freeAt ? `free at ${formatClockTime(u.freeAt)} (about ${formatWaitShort(u.freeAt - now)})` : 'no reset window — this one needs a fix, not patience';
      parts.push(`  • ${u.target} — ${u.reason}; ${when}`);
    }
  }

  if (retired.length > 0) {
    parts.push('');
    parts.push('Ruled out (that model does not exist on that provider):');
    for (const r of retired.slice(0, 4)) parts.push(`  • ${r}`);
  }

  let poolClaim: string | undefined;
  if (poolMeasured && !emptyPool) {
    poolClaim = `${poolSize} model${poolSize === 1 ? '' : 's'} across ${poolProviders} provider${poolProviders === 1 ? '' : 's'} were eligible at the time.`;
    parts.push('');
    parts.push(poolClaim);
  }

  // ── What the SYSTEM is doing (never a question to the user) ──────────────
  parts.push('');
  if (routingGap) {
    parts.push(
      `This was a routing gap, not a shortage: only ${attemptCount} of ${poolSize} eligible models were actually tried. The next attempt routes to an untried model automatically — you do not need to trigger anything.`,
    );
  } else if (emptyPool) {
    parts.push(
      'No model was eligible at all — the pool is empty (no usable credential, or every model is ruled out).',
    );
  } else if (attemptCount === 0) {
    parts.push(
      'The model layer failed before it could try anything, which is a transport problem rather than a missing model.',
    );
  }

  // ── The levers only the user can pull ────────────────────────────────────
  const options: ExhaustionOption[] = [];
  const needsKey = exclusions.filter((e) => e.kind === 'auth');
  if (needsKey.length > 0) {
    options.push({
      code: 'recharge',
      text: `Recharge or replace the credential for ${[...new Set(needsKey.map((e) => e.provider))].join(', ')} — it was rejected, so no amount of waiting fixes it.`,
    });
  }
  const quotaBound = exclusions.filter((e) => e.kind === 'rate-limit');
  if (quotaBound.length > 0) {
    options.push({
      code: 'recharge',
      text: `Raise the quota / add a key for ${[...new Set(quotaBound.map((e) => e.provider))].join(', ')} if you need this done sooner than their reset window.`,
    });
  }
  if (nextFreeAt !== undefined) {
    options.push({
      code: 'wait',
      text: `Wait — a capable model frees up at ${formatClockTime(nextFreeAt)}, about ${formatWaitShort(nextFreeAt - now)} from now. Ask again after that and it will be used automatically.`,
    });
  }
  options.push({
    code: 'weaker-model',
    text: 'Allow a weaker or cheaper model for this task and accept that its answer may need more checking.',
  });
  options.push({
    code: 'narrow',
    text: 'Narrow the ask — one file, one change, or one question at a time — so a smaller (or cheaper) model can finish it.',
  });

  if (options.length > 0) {
    parts.push('');
    parts.push('Things that would unblock it:');
    for (const o of options) parts.push(`  • ${o.text}`);
  }

  return {
    headline: parts[0],
    tried,
    unavailable,
    retired,
    ...(poolClaim ? { poolClaim } : {}),
    routingGap,
    ...(nextFreeAt !== undefined ? { nextFreeAt } : {}),
    options,
    text: parts.join('\n'),
  };
}

/**
 * The report, or `undefined` when there is genuinely nothing concrete to say.
 *
 * Silent-when-empty is deliberate: a caller that already has an actionable line
 * ("the provider rejected the key") must keep it rather than trade it for an
 * empty report. "Concrete" means exactly one thing — a model was reached, or
 * something was ruled out. A report with neither is not evidence of exhaustion.
 */
export function renderExhaustionReport(input: ExhaustionInput): string | undefined {
  const attempts = input.attempts ?? [];
  const exclusions = input.exclusions ?? [];
  // A measured pool size is NOT evidence: a governance refusal, a bad pin or a
  // caller bug all fail with a perfectly healthy pool and no attempt at all, and
  // dressing those up as exhaustion would be a new lie in place of the old one.
  if (attempts.length === 0 && exclusions.length === 0) return undefined;
  return buildExhaustionReport(input).text;
}
