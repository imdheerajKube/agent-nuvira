/**
 * The Run Trace — the loop's representation of ITS OWN behaviour.
 *
 * WHY THIS EXISTS (the "it took no concern out of it" audit):
 *
 * A user asked agent-nuvira, in as many words, "why are you asking me this again
 * and again?" — and the turn did not acknowledge it. Not because the model was
 * incapable, but because **nothing in the architecture held the fact that it had
 * asked four times**. The loop's counters measure the loop's own NUDGES
 * (`permissionNudges < 1`), not the model's repeated questions; the gates judge
 * the CURRENT step's text; and the transcript is not a data structure anything
 * reasons over. So the agent could not notice a loop, could not answer a
 * question about one, and could not stop one.
 *
 * That is the whole difference between an agent that reviews its own actions and
 * one that merely executes a pipeline: a REPRESENTATION of the run. This module
 * is it. Every question the agent asks is recorded with a *shape*, every refused
 * tool call is recorded with its reason, and every mutation is recorded with its
 * target — so the run can answer three questions it previously could not:
 *
 *   1. "Have I already asked this?"  -> the repetition gate refuses to re-ask.
 *   2. "What did the user answer?"   -> the earlier answer is handed back.
 *   3. "Why are you asking again?"   -> a self-report the model answers FROM.
 *
 * SCOPE: per CONVERSATION, like the intent envelope — the dashboard console
 * keeps one plan store per session and re-injects it every turn, so the trace
 * outlives the turn and a loop across turns is visible. Storage is bounded (the
 * last N entries), so a long conversation cannot grow it without limit.
 *
 * DELIBERATELY DETERMINISTIC AND LLM-FREE: like `autonomy-policy.ts`, this is a
 * guard rail around a model's own instinct. Asking a model "are you looping?" on
 * every step is both expensive and unreliable; counting is neither. The model is
 * asked to INTERPRET the trace only when the user asks about it.
 */

/** The salient content of a question — what it is actually about. */
export interface QuestionShape {
  /** Explicit targets: backticked text, file paths, command names. */
  targets: string[];
  /** Significant words, boilerplate removed. */
  tokens: string[];
}

/**
 * Words that carry no signal about WHAT is being asked — permission boilerplate
 * and ordinary English. Stripping them is what lets "May I run `node -c
 * script.js` to verify?" and "Run a JavaScript syntax check (`node -c
 * script.js`)?" collapse to the same question.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'you', 'your', 'yours', 'for', 'with', 'that', 'this', 'these', 'those',
  'are', 'was', 'were', 'can', 'may', 'should', 'would', 'could', 'will', 'shall',
  'please', 'want', 'like', 'let', 'me', 'us', 'to', 'of', 'in', 'on', 'at', 'by', 'it',
  'is', 'be', 'been', 'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'not', 'no',
  'yes', 'ok', 'okay', 'a', 'an', 'i', 'we', 'my', 'our', 'about', 'then', 'than',
  'run', 'running', 'ran', 'verify', 'verifying', 'verified', 'check', 'checking',
  'perform', 'performing', 'before', 'after', 'now', 'again', 'sure', 'proceed',
  'continue', 'go', 'ahead', 'use', 'using', 'make', 'making', 'need', 'needs', 'help',
  'just', 'also', 'here', 'there', 'what', 'why', 'how', 'some', 'any', 'all',
]);

/** Normalize text for comparison (case, whitespace, punctuation-insensitive). */
function normalize(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}./_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** File-ish and command-ish targets, matched without requiring backticks. */
const FILE_TARGET_RE =
  /\b[\w./-]+\.(?:js|cjs|mjs|ts|tsx|jsx|json|css|scss|html|md|py|go|rs|java|rb|yml|yaml|sh|toml|sql)\b/gi;
// NOTE: deliberately no `go`/`make`/`bun`-style English-word collisions — a
// command NAME is a target, but "make the logo bigger" must not become one, or
// two unrelated questions would collide on the shared word "make".
const COMMAND_TARGET_RE =
  /\b(?:node|npm|npx|pnpm|yarn|deno|python3?|pip3?|git|tsc|vitest|jest|mocha|cargo|docker|kubectl|curl|gh)\b[^\s`.,;:!?)]*/gi;

/**
 * Reduce a question to its salient shape.
 *
 * Targets are the strongest signal: if two questions both name `node -c
 * script.js`, they are the same ask however differently they are phrased. Tokens
 * are the fallback for a question with no explicit target.
 */
export function questionShape(question: string): QuestionShape {
  const text = String(question ?? '');
  const targets = new Set<string>();

  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const t = normalize(m[1]);
    if (t) targets.add(t);
  }
  for (const m of text.matchAll(FILE_TARGET_RE)) targets.add(normalize(m[0]));
  for (const m of text.matchAll(COMMAND_TARGET_RE)) {
    const t = normalize(m[0]);
    if (t) targets.add(t);
  }

  const tokens = [...new Set(normalize(text).split(' ').filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];

  return { targets: [...targets].sort(), tokens };
}

/** Jaccard overlap of two token sets (0 when either is empty). */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const shared = a.filter((t) => setB.has(t)).length;
  return shared / (a.length + b.length - shared);
}

/** Above this overlap two questions are treated as the same ask. */
export const SAME_QUESTION_OVERLAP = 0.6;

/**
 * Is this the same question as an earlier one?
 *
 * Targets first — a shared target means the same thing is being asked about,
 * which is the reliable signal ("May I run `node -c script.js`?" vs "Run a
 * JavaScript syntax check (`node -c script.js`)?"). Only when neither has a
 * target does token overlap decide, so a genuinely different question with the
 * same shape ("which runtime?" … "which database?") is not counted as a repeat.
 */
export function isSameQuestion(a: QuestionShape, b: QuestionShape): boolean {
  if (a.targets.length > 0 && b.targets.length > 0) {
    return a.targets.some((t) => b.targets.includes(t));
  }
  return jaccard(a.tokens, b.tokens) >= SAME_QUESTION_OVERLAP;
}

/** One question the agent asked. */
interface AskRecord {
  question: string;
  shape: QuestionShape;
  /** False when the gate settled it without showing the user. */
  shown: boolean;
  /** The user's answer, when there was one. */
  answer?: string;
  at: number;
}

/** One tool call that was REFUSED (a gate, not a provider error). */
interface RefusalRecord {
  tool: string;
  /** The refusal's own reason line, normalized for comparison. */
  signature: string;
  detail: string;
  at: number;
}

/**
 * One FAILED action (a command that exited non-zero, a timed-out build, a tool
 * error) — distinct from a REFUSAL, which is a gate declining to run at all.
 *
 * Why this record exists: a refusal is recorded and re-fed to the next run
 * (step-handoff), but a command that RUNS and FAILS was never remembered, so a
 * run could re-issue the identical failing command dozens of times — the live
 * macOS-build turn retried `npx tauri build` ~10 times, each time with the same
 * missing-Cargo cause, and never once stopped to ask WHY. Recording the failure
 * by its ACTION signature is what lets the loop notice "same action, same
 * failure, again" and demand a diagnosis instead of another blind retry.
 */
interface FailureRecord {
  tool: string;
  /** The action's signature (the command / path), normalized for comparison. */
  action: string;
  /** The failure's own line, for the diagnosis prompt. */
  detail: string;
  at: number;
}

/** One workspace mutation. */
interface MutationRecord {
  tool: string;
  path?: string;
  at: number;
}

/** How many of each record the trace keeps (bounded — a long run must not grow). */
export const MAX_TRACE_ENTRIES = 60;

/** The trace's counts, as data (see {@link RunTrace.snapshot}). */
export interface RunTraceSnapshot {
  /** Questions the agent asked, including the ones a gate suppressed. */
  asks: number;
  /** Questions that actually reached the user — the interruptions they felt. */
  shownAsks: number;
  /** Questions that repeated one already asked (the loop signal). */
  repeatedAsks: number;
  /** Tool calls refused, by any gate. */
  refusals: number;
  /** Workspace mutations applied. */
  mutations: number;
  /** The distinct files changed. */
  paths: string[];
}

/**
 * The run's own behaviour, as data.
 *
 * A class (not a plain array) because every consumer asks a QUESTION of it —
 * "have I asked this?", "what was the answer?", "did I loop?" — and those
 * questions should be answered in one place rather than re-derived by each
 * caller.
 */
export class RunTrace {
  private asks: AskRecord[] = [];
  private refusals: RefusalRecord[] = [];
  private failures: FailureRecord[] = [];
  private mutations: MutationRecord[] = [];

  /** Prior asks that are the SAME question as this one (excluding it). */
  priorAskMatches(question: string): AskRecord[] {
    const shape = questionShape(question);
    return this.asks.filter((a) => isSameQuestion(shape, a.shape));
  }

  /** The most recent SHOWN answer to this question, if the user gave one. */
  priorAnswer(question: string): string | undefined {
    const matches = this.priorAskMatches(question).filter((a) => a.shown && a.answer);
    return matches.length > 0 ? matches[matches.length - 1].answer : undefined;
  }

  /** Record that the agent asked something, and whether the user saw it. */
  recordAsk(question: string, shown: boolean, answer?: string): void {
    this.asks.push({
      question: String(question ?? ''),
      shape: questionShape(question),
      shown,
      ...(answer ? { answer } : {}),
      at: Date.now(),
    });
    if (this.asks.length > MAX_TRACE_ENTRIES) this.asks.shift();
  }

  /** Prior refusals of the SAME tool for the SAME reason. */
  priorRefusalMatches(tool: string, detail: string): number {
    const signature = normalize(detail).slice(0, 200);
    return this.refusals.filter((r) => r.tool === tool && r.signature === signature).length;
  }

  recordRefusal(tool: string, reason: string, detail: string): void {
    this.refusals.push({
      tool,
      signature: normalize(detail).slice(0, 200),
      detail: String(detail ?? '').slice(0, 200),
      at: Date.now(),
    });
    if (this.refusals.length > MAX_TRACE_ENTRIES) this.refusals.shift();
  }

  /**
   * Record an action that RAN and FAILED, keyed by what it was (the command or
   * path), so the identical retry is recognizable.
   */
  recordFailure(tool: string, action: string, detail: string): void {
    this.failures.push({
      tool,
      action: normalize(action).slice(0, 200),
      detail: String(detail ?? '').slice(0, 200),
      at: Date.now(),
    });
    if (this.failures.length > MAX_TRACE_ENTRIES) this.failures.shift();
  }

  /**
   * The most recent FAILED actions, newest last — for a stall nudge that must
   * name what was actually tried instead of describing "your attempts".
   *
   * Bounded by the caller (the loop asks for the last few), so the prompt a
   * stuck model reads stays short and specific.
   */
  recentFailures(limit = 3): Array<{ tool: string; action: string; detail: string }> {
    return this.failures.slice(-Math.max(1, limit)).map((f) => ({ tool: f.tool, action: f.action, detail: f.detail }));
  }

  /**
   * The action that has failed MORE THAN ONCE, with its count — or null when no
   * action has repeated.
   *
   * The single signal a stuck run needs: "I have tried this exact thing N times
   * and it has failed every time." Deliberately counts by ACTION (the command /
   * path), not by tool: `run_terminal` failing once on `npm test` and once on
   * `npm build` is normal iteration, while the SAME command failing twice is a
   * loop that will not resolve by trying it a third time.
   */
  repeatedFailure(): { tool: string; action: string; times: number; detail: string } | null {
    const counts = new Map<string, { tool: string; action: string; times: number; detail: string }>();
    for (const f of this.failures) {
      const key = `${f.tool}\u0000${f.action}`;
      const hit = counts.get(key);
      if (hit) {
        hit.times += 1;
        hit.detail = f.detail;
      } else {
        counts.set(key, { tool: f.tool, action: f.action, times: 1, detail: f.detail });
      }
    }
    let worst: { tool: string; action: string; times: number; detail: string } | null = null;
    for (const entry of counts.values()) {
      if (entry.times >= 2 && (!worst || entry.times > worst.times)) worst = entry;
    }
    return worst;
  }

  recordMutation(tool: string, path?: string): void {
    this.mutations.push({ tool, ...(path ? { path } : {}), at: Date.now() });
    if (this.mutations.length > MAX_TRACE_ENTRIES) this.mutations.shift();
  }

  countAsks(): number {
    return this.asks.length;
  }

  countShownAsks(): number {
    return this.asks.filter((a) => a.shown).length;
  }

  /**
   * How many questions were asked more than once. The single number that says
   * "this run looped on the conversation" — and the metric the fix is judged by.
   */
  repeatedAskCount(): number {
    let repeats = 0;
    for (let i = 0; i < this.asks.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        if (isSameQuestion(this.asks[i].shape, this.asks[j].shape)) {
          repeats += 1;
          break;
        }
      }
    }
    return repeats;
  }

  /**
   * The counts, as a plain object — for surfaces that need the NUMBERS rather
   * than the prose (the loop's result, the eval metric, the dashboard badge).
   *
   * `shownAsks` is the one that matters to a user: how many times the run
   * actually stopped and asked them something. `asks` counts attempts, which is
   * the number a gate can influence before the user ever sees it.
   */
  snapshot(): RunTraceSnapshot {
    return {
      asks: this.asks.length,
      shownAsks: this.countShownAsks(),
      repeatedAsks: this.repeatedAskCount(),
      refusals: this.refusals.length,
      mutations: this.mutations.length,
      paths: this.distinctMutationPaths(),
    };
  }

  /** Distinct questions, each with how many times it was asked and its answer. */
  askSummary(): Array<{ question: string; times: number; answer?: string }> {
    const groups: Array<{ shape: QuestionShape; question: string; times: number; answer?: string }> = [];
    for (const ask of this.asks) {
      const hit = groups.find((g) => isSameQuestion(g.shape, ask.shape));
      if (hit) {
        hit.times += 1;
        if (ask.shown && ask.answer) hit.answer = ask.answer;
      } else {
        groups.push({ shape: ask.shape, question: ask.question, times: 1, answer: ask.shown ? ask.answer : undefined });
      }
    }
    return groups.map(({ question, times, answer }) => ({
      question,
      times,
      ...(answer ? { answer } : {}),
    }));
  }

  distinctMutationPaths(): string[] {
    return [...new Set(this.mutations.map((m) => m.path).filter((p): p is string => Boolean(p)))];
  }

  /**
   * The trace as text, for the model to answer FROM.
   *
   * Written for a reader that must not mistake it for a summary of the work: it
   * describes the agent's OWN behaviour, so the number it leads with is the one
   * a stuck run needs to see — how often it repeated itself.
   */
  selfReport(): string {
    const lines: string[] = ['[Run trace — your own behaviour this conversation]'];
    const shown = this.countShownAsks();
    const repeated = this.repeatedAskCount();

    if (this.asks.length === 0) {
      lines.push('You have not asked the user any questions.');
    } else {
      lines.push(
        `You asked ${this.asks.length} question(s); ${shown} reached the user; ` +
          `${repeated} of them repeated a question you had already asked.`,
      );
      for (const s of this.askSummary()) {
        const answer = s.answer ? ` — the user answered: "${s.answer}"` : ' — no answer recorded';
        lines.push(`  • asked ${s.times}×: ${s.question.slice(0, 140)}${answer}`);
      }
    }

    if (this.refusals.length > 0) {
      lines.push(`Refused tool calls: ${this.refusals.length}.`);
      for (const r of this.refusals.slice(-5)) {
        lines.push(`  • ${r.tool}: ${r.detail}`);
      }
    }

    const paths = this.distinctMutationPaths();
    lines.push(
      paths.length > 0
        ? `Files you changed: ${paths.slice(0, 10).join(', ')}${paths.length > 10 ? ` (+${paths.length - 10} more)` : ''}.`
        : 'You have not changed any files.',
    );

    if (repeated > 0) {
      lines.push(
        'You REPEATED a question the user had already answered. Do not ask it again: ' +
          'the answer above is the answer. Either act on it, or state plainly what blocks you.',
      );
    }
    return lines.join('\n');
  }
}

/**
 * The correction handed back when the turn closes on a question the user has
 * ALREADY answered.
 *
 * Deliberately does NOT say "proceed": a bare order to carry on would be unsafe
 * when the answer was "no". It says the answer is already in hand — so act on
 * it, or state plainly what blocks you. That is the difference between stopping
 * a loop and bulldozing a decision.
 */
export function repeatNudge(question: string, answer?: string): string {
  return (
    'You just asked a question the user has ALREADY answered in this conversation: ' +
    `"${String(question ?? '').slice(0, 200)}". ` +
    (answer ? `Their answer was: "${answer}". ` : '') +
    'Do NOT ask it again. Act on the answer you already have, or — if it genuinely ' +
    'does not settle the matter — say plainly what blocks you and what you need, instead ' +
    'of repeating the question. Repeating a question the user has answered is the one ' +
    'behaviour they will read as the agent being stuck.'
  );
}

/**
 * The correction handed back when the SAME action has failed more than once.
 *
 * This is the loop's missing self-diagnosis. A run that re-issues the identical
 * command and gets the identical failure is not "trying again" — it is
 * rediscovering the same wall, and the next attempt will hit it too. The nudge
 * does not tell the model what the cause is (it does not know); it demands that
 * the model STOP and diagnose: state the cause, and change the APPROACH rather
 * than the command. Crucially it forbids the one move that produced the loop —
 * asking the user for permission to run the same failing command again.
 */
export function repeatedFailureNudge(
  failure: { tool: string; action: string; times: number; detail: string },
): string {
  return (
    `You have run the SAME action ${failure.times} times and it has FAILED every time: ` +
    `\`${failure.action}\` (${failure.tool}).\n` +
    `Most recent failure: ${failure.detail}\n` +
    'STOP retrying it. Repeating an identical failing action is a loop, not progress. ' +
    'Before you do anything else, DIAGNOSE: (1) state the ROOT CAUSE of the failure in one line, ' +
    '(2) name the specific thing that must change (a missing tool, a wrong path, a config value, ' +
    'a version mismatch), and (3) take a DIFFERENT action that addresses that cause — or, if the ' +
    'blocker is genuinely outside your reach, say so plainly and stop. Do NOT ask the user for ' +
    'permission to run the same failing command again.'
  );
}

/**
 * The correction handed back when the run has taken several steps in a row and
 * NONE of them succeeded — the generalisation of {@link repeatedFailureNudge}.
 *
 * `repeatedFailure` catches the identical action retried verbatim. A weaker run
 * loops in a second shape that it misses entirely: it keeps substituting a
 * different command each step, every one of them failing the same underlying
 * way (`npx tauri build` → `cargo build` → `rustc …`, all against a missing
 * toolchain). Nothing repeats exactly, so nothing was caught, and the run burns
 * its whole budget rediscovering one wall. This nudge names the shared failure
 * and demands the same diagnosis — cause first, then a different APPROACH.
 */
export function noProgressNudge(
  failures: Array<{ tool: string; action: string; detail: string }>,
  steps: number,
): string {
  const listed =
    failures.length > 0
      ? failures.map((f) => `  • ${f.tool}: \`${f.action}\` → ${f.detail}`).join('\n')
      : '  • (no single action repeated, but none of them succeeded)';
  return (
    `You have made ${steps} attempts in a row and NONE of them succeeded:\n${listed}\n` +
    'This is a STALL, not progress. Do NOT keep substituting commands that fail the same way. ' +
    'Before you do anything else, DIAGNOSE: (1) state in ONE line why these attempts are failing — ' +
    'name the shared cause if there is one (a missing dependency or toolchain, an unconfigured tool, ' +
    'the wrong directory, a permission wall, a version mismatch); (2) name the ONE thing that must ' +
    'change; and (3) take a DIFFERENT action that addresses that cause — or, if the blocker is ' +
    'genuinely outside your reach, say plainly and specifically what it is and stop.'
  );
}

// ─── Frame detection: when is the user asking ABOUT the run? ────────────────

/**
 * The user asking about the agent's OWN behaviour ("why are you asking me this
 * again and again?", "stop asking every second", "you keep asking permission").
 *
 * This is a distinct frame from a request: it is not work to be done, it is a
 * question about the run. It must route the trace to the model rather than the
 * ordinary "the request does not authorize files" analysis path — which is what
 * previously happened, so the complaint was answered with planning prose and the
 * loop continued.
 */
const PROCESS_COMPLAINT_RE = new RegExp(
  [
    '\\b(?:why|how\\s+come)\\b[^?]{0,80}\\b(?:ask|asks|asking|question|questions|prompt|prompts|prompting|permission)\\b',
    '\\b(?:stop|quit|enough)\\s+(?:it\\s+)?(?:with\\s+)?(?:the\\s+)?(?:asking|questions|prompts|permission)\\b',
    '\\byou\\s+(?:keep|kept|are\\s+always)\\s+asking\\b',
    '\\bask(?:ing)?\\s+(?:me\\s+)?(?:again|repeatedly|every\\s+(?:second|time|step|turn))\\b',
    '\\bsame\\s+question\\b',
    '\\b(?:permission|approval)\\s+(?:again|every)\\b',
  ].join('|'),
  'i',
);

/** Is the user asking about the agent's own behaviour? */
export function detectProcessComplaint(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return PROCESS_COMPLAINT_RE.test(t);
}

// ─── Per-conversation storage ───────────────────────────────────────────────

const traces = new WeakMap<object, RunTrace>();

/** Is this object usable as a trace key (a session handle)? */
export function isTraceKey(key: unknown): key is object {
  return (typeof key === 'object' && key !== null) || typeof key === 'function';
}

/** The trace for a conversation, created on first use. */
export function runTraceFor(key: object): RunTrace {
  let trace = traces.get(key);
  if (!trace) {
    trace = new RunTrace();
    traces.set(key, trace);
  }
  return trace;
}

/** The trace for a conversation, or undefined when none exists yet. */
export function peekRunTrace(key: object | undefined): RunTrace | undefined {
  return isTraceKey(key) ? traces.get(key) : undefined;
}

/** Drop the trace (the conversation ended). */
export function clearRunTrace(key: object | undefined): void {
  if (isTraceKey(key)) traces.delete(key);
}
