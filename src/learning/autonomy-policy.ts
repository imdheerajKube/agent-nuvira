/**
 * Autonomy policy — may the agent decide for itself, or must it ask?
 * (enterprise-grade hardening, G11.)
 *
 * WHY THIS EXISTS (the WhatsApp story audit + the "manual cadence" complaint):
 * Two failure modes sit on opposite sides of the same missing rule.
 *
 *   1. STALLING ON AN ANSWERABLE QUESTION. The story session asked/implied
 *      decisions it could have made itself ("should I keep going?", "which
 *      file?"), and every one of those turned into a turn that ended without
 *      delivered work. An agent that consults on a choice it can make is not
 *      careful — it is a bottleneck, and it is how 32 minutes produced zero
 *      words.
 *   2. DECIDING SOMETHING THAT WAS NEVER ITS CALL. The opposite failure, where
 *      an agent silently picks a direction the user cared about (which
 *      provider to bill, whether to overwrite existing work, what to delete).
 *
 * The enterprise behaviour is a POLICY, not a mood: decide by default, consult
 * only when the decision is (a) genuinely the user's, (b) not implied by the
 * ask, (c) irreversible or expensive to get wrong, and (d) has no sensible
 * default. Everything else is the agent's job.
 *
 * This module is deterministic and LLM-free on purpose: it is the guard rail
 * around a model's own "should I ask?" instinct, which skews towards asking.
 */

/** How much damage a wrong choice does. */
export type DecisionImpact = 'low' | 'medium' | 'high';

/** One decision the agent is facing. */
export interface DecisionRequest {
  /** What is being decided, phrased for the user (used verbatim if we consult). */
  question: string;
  /** Candidate answers, best-first. Empty means the answer is free-form. */
  options?: string[];
  /** What the agent would pick on its own. Presence = "a sensible default exists". */
  defaultChoice?: string;
  /** How much a wrong pick costs. Defaults to `medium`. */
  impact?: DecisionImpact;
  /**
   * Can the choice be undone cheaply? Overwriting a file that exists, deleting
   * data, spending money and publishing are NOT reversible; picking a library
   * or a layout usually is.
   */
  reversible?: boolean;
  /**
   * Does the original ask already imply this choice? "a web-based book with
   * voice narration" has already answered "should it have audio?" and "should
   * it be a website?" — re-asking is a non-delivery dressed as diligence.
   */
  impliedByAsk?: boolean;
  /** Minutes of rework a wrong choice would add. */
  reworkMinutes?: number;
  /**
   * True when the run cannot continue at all without an answer.
   *
   * A non-blocking decision is a PREFERENCE: the agent proceeds with its
   * default and the user can redirect later, so consulting would only add a
   * round trip with no benefit.
   */
  blocking?: boolean;
}

/** The ruling. */
export interface DecisionVerdict {
  action: 'proceed' | 'consult';
  /** The choice to take when proceeding. */
  choice?: string;
  /** Why — recorded in the trace/log so the call is auditable, not vibes. */
  reason: string;
}

/**
 * Rework above this many minutes makes a defaulted choice expensive enough to
 * be worth a round trip even when the choice is reversible.
 */
export const REWORK_CONSULT_THRESHOLD_MINUTES = 45;

/**
 * Decide whether the agent proceeds on its own or asks the user.
 *
 * Order matters. The cheap, obviously-ours cases are settled first so that a
 * later rule can never turn an easy call into a consultation:
 *
 *  1. NOT BLOCKING, NOT HIGH-IMPACT -> proceed. Nothing is waiting on an
 *     answer, and the user can redirect at any time. Asking is pure latency.
 *  2. THE ASK ALREADY SAID SO -> proceed with the implied choice. Re-asking a
 *     question the user answered in their own request is the "cheap shortcut"
 *     in reverse: it looks like diligence and delivers nothing.
 *  3. A BLOCKING, HIGH-IMPACT, IRREVERSIBLE DECISION WITH NO DEFAULT -> this is
 *     the user's call. Consult — with a defaulted recommendation, so the reply
 *     is a one-word confirmation rather than an essay.
 *  4. OTHERWISE -> proceed with the default, unless the rework a wrong pick
 *     would cost is large enough to justify asking (rule 5).
 *  5. EXPENSIVE + NO DEFAULT -> consult.
 *
 * A blocking decision with a sensible default proceeds. That is the whole
 * point of the policy: "which file should I write to" has a default (the one
 * named in the ask, or a predictable one), so it must never stop a run.
 */
export function decideAutonomously(request: DecisionRequest): DecisionVerdict {
  const impact: DecisionImpact = request.impact ?? 'medium';
  const blocking = request.blocking === true;
  const choice = request.defaultChoice ?? request.options?.[0];

  if (!blocking && impact !== 'high') {
    return {
      action: 'proceed',
      choice,
      reason: 'non-blocking and not high-impact — proceeding and leaving the user free to redirect',
    };
  }

  if (request.impliedByAsk) {
    return {
      action: 'proceed',
      choice,
      reason: 'the request itself already specifies this — re-asking would be a round trip with no new information',
    };
  }

  const irreversible = request.reversible === false;
  const rework = request.reworkMinutes ?? 0;
  const hasDefault = typeof choice === 'string' && choice.length > 0;

  if (blocking && impact === 'high' && irreversible && !hasDefault) {
    return {
      action: 'consult',
      reason: 'blocking, high-impact, irreversible, and no sensible default — this is genuinely the user’s decision',
    };
  }

  if (hasDefault && !(irreversible && impact === 'high')) {
    return {
      action: 'proceed',
      choice,
      reason: 'a sensible default exists and the choice is recoverable — deciding it is the agent’s job',
    };
  }

  if (rework > REWORK_CONSULT_THRESHOLD_MINUTES && !hasDefault) {
    return {
      action: 'consult',
      reason: `a wrong pick would cost roughly ${rework} minutes and there is no default to fall back on`,
    };
  }

  if (!hasDefault && request.blocking) {
    return {
      action: 'consult',
      reason: 'blocking, with no default the agent is willing to stand behind',
    };
  }

  return {
    action: 'proceed',
    choice,
    reason: irreversible && impact === 'high'
      ? 'proceeding with the stated default; the choice is high-impact but the user’s own preference is already known'
      : 'no reason to wait on an answer — proceeding',
  };
}

// ── Write authorization: did the REQUEST already authorize this? ────────────

/**
 * Verbs that mean "produce the artifact", not "tell me about it".
 * Deliberately includes the edit verbs: "add a chapter", "update the README".
 */
const CREATE_VERB_RE =
  /\b(?:create|build|write|make|generate|develop|implement|scaffold|set\s+up|setup|add|produce|draft|code|rewrite|refactor|fix|update|change|edit|modify|migrate|upgrade|convert|render|export|deploy|install|save|store|persist)\b/i;

/** Nouns that name a FILE-SHAPED deliverable (the thing that lands on disk). */
const DELIVERABLE_NOUN_RE =
  /\b(?:file|files|folder|directory|project|repo|repository|app|application|website|site|webpage|web\s?page|page|pages|component|module|class|function|script|program|tool|cli|server|api|endpoint|test|tests|suite|config|document|doc|docs|report|readme|story|book|novel|chapter|chapters|poem|essay|article|post|plan|spec|schema|migration|template|templates|style|styles|asset|assets|manuscript|draft)\b/i;

/** A path is the strongest signal of all: the user named the destination. */
const PATH_RE = /(?:^|[\s"'`(])(?:~|\/|\.{1,2}\/)[\w./-]+/;

/**
 * Directive verbs that ask for a CHANGE to something that already exists.
 *
 * Kept separate from {@link CREATE_VERB_RE} because the evidence is different:
 * these need no file-shaped noun ("fix the calculator") — the verb applied to an
 * object already says the work is to change what is there. Still vetoed by an
 * analysis opener, so "why is the build failing?" remains a question.
 */
const MAINTENANCE_VERB_RE =
  /\b(?:fix|repair|refactor|update|change|edit|modify|migrate|upgrade|improve|optimize|optimise|clean\s*up|rewrite|rename|remove|delete|correct|debug|patch|tweak)\b/i;

/**
 * An analysis/interrogative opener means the user is asking ABOUT something,
 * not asking for it to be produced: "what files should I create for X?" is a
 * question, "create the files for X" is a request.
 *
 * `can|could|would|do` are deliberately NOT here — "Can you create the
 * project?" is a polite REQUEST, and treating it as analysis would leave the
 * most common phrasing unauthorized.
 */
const ANALYSIS_OPENER_RE =
  /^\s*(?:how|why|what|when|which|who|whom|whose|explain|describe|summari[sz]e|compare|tell\s+me|walk\s+me|help\s+me\s+understand)\b/i;

/** "yes", "go ahead", "do it" — a confirmation of work already proposed. */
const SHORT_AFFIRMATIVE_RE =
  /^\s*(?:yes|yep|yeah|ok(?:ay)?|sure|please\s+do|go\s+ahead|proceed|continue|carry\s+on|do\s+it|go\s+for\s+it|make\s+it\s+so)\b/i;

/** Continuing in-flight work needs no new authorization — the ask was it. */
const CONTINUATION_RE =
  /\b(?:continue|carry\s+on|keep\s+going|go\s+ahead|proceed|finish|complete\s+(?:it|the|this|the\s+remaining)|do\s+the\s+remaining|resume)\b/i;

/** The ruling on whether the user's own request authorized file writes. */
export interface WriteAuthorization {
  authorized: boolean;
  /** Why — recorded so the judgment is auditable rather than a vibe. */
  reason: string;
}

/**
 * Does this request authorize the agent to CREATE files?
 *
 * This is the input the write gate was missing. The gate was binary — "confirm
 * or refuse" — with no notion of a request that had ALREADY authorized the
 * work, so an unattended run whose ask was literally "write a 12 page story"
 * stopped to ask "Do you want me to create the files?". That is not caution;
 * it is the manual cadence, and over a chat surface it is a round trip that
 * produces nothing.
 *
 * Evidence order: an explicit confirmation of proposed work, then a
 * continuation, then a named destination path, then a creation verb applied to
 * a file-shaped deliverable. An analysis/interrogative opener vetoes the last
 * two, so "explain how to write a story to a file" stays a question.
 *
 * Deliberately conservative: anything it does not recognise is NOT authorized,
 * which keeps today's confirm-or-refuse gate exactly as strict as it was.
 */
export function requestAuthorizesWrites(request: string): WriteAuthorization {
  const text = (request || '').trim();
  if (!text) return { authorized: false, reason: 'no request text to judge' };

  if (text.length <= 40 && SHORT_AFFIRMATIVE_RE.test(text)) {
    return { authorized: true, reason: 'the user confirmed the work already proposed' };
  }
  if (CONTINUATION_RE.test(text)) {
    return { authorized: true, reason: 'the request continues work that was already authorized' };
  }

  const analyzing = ANALYSIS_OPENER_RE.test(text);
  if (PATH_RE.test(text) && CREATE_VERB_RE.test(text) && !analyzing) {
    return { authorized: true, reason: 'the request names a destination path for the work' };
  }
  if (analyzing) {
    return { authorized: false, reason: 'the request asks ABOUT the work rather than for it to be produced' };
  }
  if (CREATE_VERB_RE.test(text) && DELIVERABLE_NOUN_RE.test(text)) {
    return { authorized: true, reason: 'the request asks for a file-shaped deliverable' };
  }
  // The noun list names ARTIFACT TYPES (file, app, story, script…), so it misses
  // the most common dev ask there is: "fix the calculator" names no artifact at
  // all, and this verdict came back NOT authorized — which meant the edit gate
  // would still stop to ask for permission to fix the thing the user asked to
  // have fixed. A directive verb is its own evidence: it asks for a change to
  // work that already exists.
  if (MAINTENANCE_VERB_RE.test(text)) {
    return { authorized: true, reason: 'the request directs a change to work that already exists' };
  }
  return { authorized: false, reason: 'the request does not ask for files to be created' };
}

/**
 * A request that asks for the work to be recorded in git history.
 *
 * `git commit` was gated behind `confirm:true` "after the user approved via
 * ask_user" — but when the user's ask IS "commit these changes", they have
 * already approved and the gate is a round trip in the most common dev flow.
 * Like every other rule here, the evidence has to come from the request text.
 *
 * A NEGATED commit ("don't commit yet") is explicitly not a request for one,
 * and an analysis opener ("how do I commit?") is asking ABOUT it.
 */
export function requestRequestsCommit(request: string): boolean {
  const text = (request || '').trim();
  if (!text) return false;
  if (ANALYSIS_OPENER_RE.test(text)) return false;
  if (/\b(?:don'?t|do\s+not|never|no|without)\s+(?:\w+\s+){0,2}commit\b/i.test(text)) return false;
  return /\b(?:commit|check[\s-]?in)\b/i.test(text);
}

/** Escape a literal for use inside a RegExp. */
function escapeRegexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does the request name THIS file?
 *
 * The evidence an edit gate needs: "fix calc.ts" names the file, "update the
 * README" names it. Compared on the BASENAME too, because a request says
 * `calc.ts` for `src/lib/calc.ts` — that is how people actually write, and
 * requiring the full path would make the rule dead on arrival.
 *
 * Deliberately literal (the basename or the path, as a whole word): a fuzzy
 * match would let "write a story" claim `story.md` and turn a create into an
 * unreviewed overwrite.
 */
export function requestNamesPath(request: string, path: string): boolean {
  const text = (request || '').trim();
  if (!text) return false;
  const base = path.split(/[\\/]/).pop() ?? '';
  const candidates = [base, path].filter((c) => c.length >= 3);
  return candidates.some(
    (c) => new RegExp(`(?:^|[^\\w.\\/-])${escapeRegexLiteral(c)}(?:$|[^\\w.\\/-])`, 'i').test(text),
  );
}

/**
 * Above this share of a file being rewritten, an edit is a REPLACEMENT rather
 * than a surgical change — and replacing most of what exists is the user's call,
 * for the same reason write_file's overwrite case is.
 */
export const EDIT_SURGICAL_MAX_FRACTION = 0.5;

/**
 * Is this edit surgical — does it preserve most of the file it touches?
 *
 * The measurable line between "a fix inside a file" and "a rewrite of the
 * file". A surgical edit is the iteration the verify loop is built around
 * (run → read the failure → edit → re-run); a rewrite is a judgment call.
 */
export function isSurgicalEdit(fileChars: number, oldChars: number, newChars: number): boolean {
  if (!Number.isFinite(fileChars) || fileChars <= 0) return false;
  const touched = Math.max(oldChars, newChars);
  return touched / fileChars <= EDIT_SURGICAL_MAX_FRACTION;
}

// ── Permission-seeking detection ────────────────────────────────────────────

/** Direct permission requests: "do you want me to …", "shall I …". */
const PERMISSION_ASK_RE =
  /\b(?:do\s+you\s+want\s+(?:me|for\s+me)\s+to|would\s+you\s+like\s+(?:me|for\s+me)\s+to|want\s+me\s+to|like\s+me\s+to|shall\s+i|should\s+i|may\s+i|am\s+i\s+allowed\s+to|is\s+it\s+ok(?:ay)?\s+(?:if|to)|do\s+you\s+want\s+me\s+to|ready\s+to\s+proceed|ok(?:ay)?\s+to\s+proceed)\b/i;

/** Awaiting-a-human phrasings: "awaiting your confirmation", "let me know if…". */
const PERMISSION_AWAIT_RE =
  /\b(?:awaiting|waiting\s+for|need)\s+(?:your|the\s+user'?s?)\s+(?:approval|confirmation|go-?ahead|permission|sign-?off|consent|green\s*light)\b|\b(?:your|the\s+user'?s?)\s+(?:approval|confirmation|go-?ahead|permission|sign-?off)\b|\b(?:if|once|when)\s+you\s+(?:approve|confirm|give\s+me\s+the\s+(?:go-?ahead|green\s*light|ok))\b|\blet\s+me\s+know\s+(?:if|whether)\s+you(?:'d|\s+would)?\s+(?:like|want)\b|\bplease\s+(?:confirm|approve)\b/i;

/**
 * A question that PROPOSES doing the work rather than asking about it —
 * "Create the Mahagatha interactive-book project with 20 chapter pages…?"
 * (the exact shape that ended a live unattended turn).
 */
const PROPOSAL_QUESTION_RE = /\?\s*$/;

/** Sentence split that keeps the shape of the original text for callers that
 * need to CUT rather than merely match. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Is this ONE sentence a request for permission / a proposal to do the work? */
export function isPermissionSeekingSentence(sentence: string): boolean {
  const s = (sentence || '').trim();
  if (!s) return false;
  if (PERMISSION_ASK_RE.test(s) || PERMISSION_AWAIT_RE.test(s)) return true;
  // A question that proposes CREATE_VERB + DELIVERABLE is asking WHETHER to do
  // the work, not asking about it (the "Create the Mahagatha project…?" shape).
  return PROPOSAL_QUESTION_RE.test(s) && CREATE_VERB_RE.test(s) && DELIVERABLE_NOUN_RE.test(s);
}

/**
 * True when the answer CLOSES by asking permission to do work, rather than
 * delivering it.
 *
 * The distinction that matters: "should I proceed?" is a stall, while "which
 * title do you prefer?" is a genuine question. This detector only claims the
 * permission-seeking half — callers AND it with an authorization verdict, so a
 * question about work that was never authorized is untouched.
 *
 * Only the closing sentences are judged: a question mid-answer followed by the
 * actual deliverable is narration, not a stall.
 */
export function detectPermissionSeeking(content: string): boolean {
  const text = (content || '').trim();
  if (!text) return false;
  return splitSentences(text).slice(-2).some(isPermissionSeekingSentence);
}

/**
 * Remove the trailing permission-seeking sentences from an answer, keeping
 * everything before them VERBATIM (deliverables are prose — re-joining split
 * sentences would reformat the work itself).
 *
 * Used when a turn is nudged to proceed: the real work in that step must stay
 * a candidate answer, but the question around it must not be what the user is
 * handed — otherwise a longer "…Do you want me to…?" outranks a shorter, real
 * follow-up answer under the loop's longest-substantive rule.
 */
export function stripTrailingPermissionSeek(content: string): string {
  let out = (content || '').trim();
  // Two sentences is the detection window — never cut deeper than it can see.
  for (let i = 0; i < 2; i += 1) {
    const sentences = splitSentences(out);
    const last = sentences[sentences.length - 1];
    if (!last || !isPermissionSeekingSentence(last)) break;
    const at = out.lastIndexOf(last);
    if (at <= 0) return '';
    out = out.slice(0, at).trim();
  }
  return out;
}

/**
 * Actions that cannot be undone by re-running the agent. A question that names
 * one of these is NEVER treated as reflexive permission-seeking, because the
 * user genuinely has to own it.
 */
export const IRREVERSIBLE_ACTION_RE =
  /\b(?:delete|remove|erase|overwrite|replace\s+(?:the\s+)?existing|publish|deploy|push|force|reset|drop|truncate|uninstall|wipe|send|email|charge|pay|bill|refund|order|purchase)\b/i;

/**
 * Should a state-changing write go ahead, or is it the user's call?
 *
 * The scoped rule (from the audit): creating a file the request asked for, at a
 * path where NOTHING EXISTS, cannot destroy anything and is undone by deleting
 * the file — so making the user confirm it is pure latency. Everything else
 * keeps the gate it has today:
 *
 *   - a request that never authorized file creation (gate stays as strict);
 *   - overwriting content that already exists (a re-run cannot recover it).
 *
 * Note the asymmetry is deliberate and load-bearing: the safety property the
 * original gate protected (never clobber existing work without a human) is
 * untouched, while the property it lacked (do not stall on work the user
 * already ordered) is added.
 */
export interface WriteConfirmationRequest {
  /** Tool being attempted (`write_file`, `edit_file`, …) — for the audit line. */
  tool: string;
  /** The target path, already workspace-relative for display. */
  path: string;
  /** Does content already exist at the target, so this write REPLACES it? */
  exists: boolean;
  /** The verdict from {@link requestAuthorizesWrites} for the current request. */
  authorizedByRequest: boolean;
}

/** The ruling on a state-changing write. */
export interface WriteConfirmationVerdict {
  action: 'proceed' | 'ask';
  reason: string;
}

/** Decide whether a state-changing write proceeds or asks the user. */
export function decideWriteConfirmation(request: WriteConfirmationRequest): WriteConfirmationVerdict {
  if (!request.authorizedByRequest) {
    return {
      action: 'ask',
      reason: 'the request did not ask for files to be created, so this write is not the user’s stated intent',
    };
  }
  if (request.exists) {
    return {
      action: 'ask',
      reason: `'${request.path}' already exists — replacing existing content cannot be undone by re-running, so it is the user’s call`,
    };
  }
  return {
    action: 'proceed',
    reason: 'the request asked for this file and nothing exists at that path yet — creating it destroys nothing and is undone by deleting it, so a round trip would be the manual cadence',
  };
}

// ── The generalized state-change gate ──────────────────────────────────────

/**
 * What kind of change an action makes to the world.
 *
 * Every confirmation-gated tool was asking the same question — "has the user
 * authorized this?" — with no way to answer it, so each one could only refuse
 * and route the model to `ask_user`. Naming the classes makes the rule table
 * explicit and keeps the two classes that must NEVER run autonomously in one
 * place instead of four.
 *
 *   - `create`      adds something that did not exist;
 *   - `modify`      changes content that already exists (a surgical edit, a
 *                   workspace mutation);
 *   - `local-state` this machine's repo/process/service state — recoverable by
 *                   re-running or by starting the service again;
 *   - `external`    leaves this machine, or is seen or billed by someone else;
 *   - `destructive` removes or irrecoverably replaces what already exists.
 */
export type StateChangeClass = 'create' | 'modify' | 'local-state' | 'external' | 'destructive';

/** One gated state change, with the evidence the acting tool could measure. */
export interface StateChangeRequest {
  /** Tool being attempted (`edit_file`, `run_terminal`, …) — for the audit line. */
  tool: string;
  /** One line describing what will happen, phrased for the refusal text. */
  action: string;
  /** Which kind of change this is. */
  changeClass: StateChangeClass;
  /**
   * Does the user's OWN REQUEST name this specific action or target (the file,
   * the command, the intent)? The strongest evidence short of a confirmation.
   */
  namedByRequest?: boolean;
  /**
   * A tool-MEASURED property that makes the change recoverable — a surgical
   * edit that preserves most of the file, a workspace-local install.
   */
  recoverable?: boolean;
  /**
   * Did the request authorize this class of work at all
   * ({@link requestAuthorizesWrites})? Absent evidence means NOT authorized.
   */
  authorizedByRequest?: boolean;
}

/**
 * Decide whether a state-changing action proceeds or asks the user.
 *
 * Order matters, and the two never-autonomous classes are settled first so no
 * later rule can turn them into an autonomous action:
 *
 *   1. DESTRUCTIVE -> ask. Permanent, so it stays the user's call even when
 *      they named it: one round trip is cheap, being wrong is not.
 *   2. EXTERNAL -> ask. Someone else sees it, or it is billed.
 *   3. NEITHER AUTHORIZED NOR NAMED -> ask. This is the original strictness
 *      (and the no-loop-context default) untouched.
 *   4. NAMED BY THE REQUEST -> proceed. The user's own words are the
 *      authorization; re-asking is a round trip with no new information.
 *   5. AUTHORIZED + RECOVERABLE -> proceed. The work was ordered and the change
 *      cannot strand the user.
 *   6. OTHERWISE -> ask. Authorized but neither named nor measurably
 *      recoverable is exactly the case where a surprise is possible.
 */
export function decideStateChange(request: StateChangeRequest): WriteConfirmationVerdict {
  if (request.changeClass === 'destructive') {
    return {
      action: 'ask',
      reason: `${request.action} removes or irrecoverably replaces content that already exists — that is permanent, so it stays the user’s call`,
    };
  }
  if (request.changeClass === 'external') {
    return {
      action: 'ask',
      reason: `${request.action} has an effect outside this machine (visible to others, billed, or unrecoverable) — the user owns that decision`,
    };
  }
  const named = request.namedByRequest === true;
  if (request.authorizedByRequest !== true && !named) {
    return {
      action: 'ask',
      reason: 'the request did not ask for this work, so carrying it out would be a surprise',
    };
  }
  if (named) {
    return {
      action: 'proceed',
      reason: 'the request itself names this action — asking again would be a round trip with no new information',
    };
  }
  if (request.recoverable === true) {
    return {
      action: 'proceed',
      reason: 'the request asked for this work and the change is recoverable, so deciding it is the agent’s job',
    };
  }
  return {
    action: 'ask',
    reason: `${request.action} replaces too much of what already exists to assume it — a re-run cannot recover it, so it is the user’s call`,
  };
}

// ── run_cli: which gated intents may be decided autonomously ───────────────

/**
 * Confirmation-gated CLI intents that cannot be undone by re-running the
 * agent: irreversible data loss, or an effect outside this machine.
 *
 * These keep their gate even when the request names them. One round trip is a
 * small price for a decision that cannot be taken back.
 */
export const IRREVERSIBLE_CLI_INTENTS: ReadonlySet<string> = new Set([
  'history.clear',
  'memory.prune',
  'stats.cost.clear',
  'publish',
]);

/**
 * Confirmation-gated CLI intents that ARE recoverable: a service that can be
 * started again, config that can be re-added, a cache that rebuilds, a skill
 * that reinstalls.
 *
 * These proceed when the user's own request resolves to the exact command. The
 * manifest flag exists because the ACTION is stateful, not because the user
 * needs to approve what they just asked for.
 */
export const RECOVERABLE_CLI_INTENTS: ReadonlySet<string> = new Set([
  'dashboard.stop',
  'gateway.stop',
  'health.selfheal',
  'memory.optimize',
  'cache.clear',
  'skills.uninstall',
  'contacts.remove',
  'permissions.disallow',
  'platform.remove',
  'cron.remove',
]);

/**
 * Decide a confirmation-gated CLI intent.
 *
 * Note what this does NOT consult: {@link requestAuthorizesWrites}. That verdict
 * answers "did the request ask for files to be created" — the wrong lens for a
 * system ask like "stop the dashboard", which would read as unauthorized and
 * defeat the whole rule. The evidence that matters here is whether the USER'S
 * OWN WORDS resolve to this exact command (the caller resolves them with the
 * same router, so the tool's ask and the user's ask are compared like for like).
 */
export function decideCliIntentConfirmation(request: {
  intent: string;
  /** Does the user's own request resolve to this exact command? */
  namedByRequest: boolean;
}): WriteConfirmationVerdict {
  if (IRREVERSIBLE_CLI_INTENTS.has(request.intent)) {
    return {
      action: 'ask',
      reason: `'${request.intent}' cannot be undone by re-running — one round trip is cheap, and being wrong is not`,
    };
  }
  if (RECOVERABLE_CLI_INTENTS.has(request.intent)) {
    return request.namedByRequest
      ? {
          action: 'proceed',
          reason: `the user's own request resolves to '${request.intent}' — asking them to confirm what they just asked for is the manual cadence`,
        }
      : {
          action: 'ask',
          reason: `'${request.intent}' was not what the user asked for — it is the agent's own initiative, so it is their call`,
        };
  }
  return {
    action: 'ask',
    reason: `'${request.intent}' is confirmation-gated and not classified as recoverable — asking`,
  };
}

/**
 * The line shown when the agent decides something on the user's behalf.
 *
 * Reported, never silent: the user must be able to see and reverse a judgment
 * call. A decision that is invisible is indistinguishable from a bug.
 */
export function autonomouslyDecidedLine(question: string, choice: string, reason: string): string {
  return `🤖 Decided without asking — ${question} → **${choice}** (${reason}). Say the word and I'll change it.`;
}

/**
 * The line shown when the agent genuinely cannot decide for the user.
 *
 * Deliberately shaped for a one-word reply: the recommendation and the
 * fallback are both named, so the user is confirming rather than composing.
 */
export function consultLine(request: DecisionRequest, verdict: DecisionVerdict): string {
  const options = (request.options ?? []).slice(0, 4);
  const parts = [`❓ I need your call on this: ${request.question}`, `_${verdict.reason}_`];
  if (options.length > 1) {
    parts.push('', 'Options:', ...options.map((o, i) => `${i + 1}. ${o}`));
  }
  if (request.defaultChoice) {
    parts.push('', `My recommendation: **${request.defaultChoice}** — say "go" and I'll take it.`);
  }
  return parts.join('\n');
}
