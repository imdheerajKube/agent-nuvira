/**
 * Deliverable classification — what KIND of thing did the user actually ask
 * for? (enterprise-grade hardening, G7.)
 *
 * WHY THIS EXISTS (the WhatsApp story audit):
 * A user asked, over WhatsApp, for a 100-page Harry-Potter-style story as a
 * PDF. Six orchestrator runs over 32 minutes ALL failed, and the reason was
 * not model availability (507 models were eligible). The reasoner — the
 * technical-decision layer that runs BEFORE the planner — read "write a story"
 * and emitted:
 *
 *   {"language":"python","framework":"none","deliverable":"markdown_file",
 *    "reasoning":"…a Python script is the most efficient way to read existing
 *                 chapters, process the outline, and update the target file…"}
 *
 * The planner then produced ZERO prose steps: step-02 was "Create a Python
 * script to append the story continuation", step-03 "Run the Python script".
 * The agent built a TOOL to write the story instead of writing the story, and
 * because the tool-creation step itself failed, nothing was written at all —
 * the target directory did not exist afterwards.
 *
 * The decision layer had no vocabulary for authored work: every branch of its
 * taxonomy (language/framework/buildCommand/architecture/deliverable) assumes
 * the deliverable is a PROGRAM. So a creative ask could only ever be expressed
 * as a program that emits the creative artifact.
 *
 * This module is the missing vocabulary. It is deliberately DETERMINISTIC and
 * LLM-free — the classifier is a safety net that the LLM's own decision is
 * checked against, so a weak model cannot reintroduce the category error. It
 * runs on the raw goal before planning, and for `document`/`creative` the
 * orchestrator plans SECTIONS instead of a program.
 */

import { requestAuthorizesWrites } from './autonomy-policy.js';
import { parseLongFormTarget } from './long-form.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * The five kinds of work the planner knows how to plan.
 *
 * `code` is the historical default and keeps every software ask on its
 * existing path — this module must never change how a code task is planned.
 */

export type DeliverableClass = 'code' | 'document' | 'creative' | 'data' | 'research';

/**
 * What a deliverable is physically MADE OF.
 *
 * Added for the hybrid asks: "develop a web based book which might require
 * Python for voice assistance or interactiveness" is not one thing — it is
 * prose + a web experience + (optionally) a Python narration service. A single
 * `class` cannot express that, and forcing a choice is how the original audit
 * produced a Python script instead of a story: the taxonomy only had room for
 * one answer, and it picked the program.
 */
export type Substrate = 'prose' | 'web' | 'python' | 'asset' | 'data';

/** The result of classifying a goal. */
export interface DeliverableVerdict {
  /** The winning class. */
  class: DeliverableClass;
  /** 0–1. Below `AUTHORED_CONFIDENCE_FLOOR` the caller should not override the LLM. */
  confidence: number;
  /** Which words drove the decision (auditable, shown in logs/traces). */
  signals: string[];
  /**
   * True when the deliverable IS authored content (prose), as opposed to a
   * program/library that manipulates it. This is the flag that switches the
   * pipeline from "plan code steps" to "plan sections".
   */
  authored: boolean;
  /**
   * Ordered materials, primary first. A plain story is `['prose']`; an
   * interactive web book is `['web', 'prose']` (+ `'python'` when a narration
   * service was asked for). Always at least one entry.
   */
  substrates: Substrate[];
  /**
   * True when the deliverable is MORE THAN ONE thing joined — a book AND the
   * site that presents it. Composite asks need a PHASED plan (scaffold first,
   * then the content, then the experience layer), not a single-mode plan.
   */
  composite: boolean;
  /**
   * True when the deliverable must be experienced, not just read: a site to
   * navigate, narration to play, chapters to flip through. Drives the
   * interactivity phase and the end-to-end verification step.
   */
  interactive: boolean;
}

/**
 * Below this the verdict is a hint, not a ruling: the caller keeps the LLM's
 * own decision. Set high enough that a passing mention ("write a report about
 * the API I built") cannot hijack a genuine engineering task.
 */
export const AUTHORED_CONFIDENCE_FLOOR = 0.55;

// ─── Signal tables ──────────────────────────────────────────────────────────

/**
 * Creative-authoring signals. These are nouns that name an authored artifact
 * or its parts. Deliberately includes Hindi/Hinglish spellings — the failing
 * session was conducted in Hindi over WhatsApp (कहानी / उपन्यास), and an
 * English-only detector would have missed the entire task.
 */
const CREATIVE_SIGNALS: Array<[RegExp, number]> = [
  [/\b(short\s+story|story|stories|kahani|kahaani)\b/i, 3],
  [/\b(novel|novella|fiction|fictional|tale|fairy\s+tale|saga|legend|myth)\b/i, 3],
  [/\b(book|pustak|पुस्तक|किताब)\b/i, 3],
  [/\b(chapter|chapters|prologue|epilogue|verse|stanza)\b/i, 3],
  [/\b(poem|poetry|poem|song|lyrics|sonnet|haiku|ghazal)\b/i, 3],
  [/\b(screenplay|teleplay|script\s+for\s+a|short\s+film\s+script|narrative)\b/i, 3],
  [/\b(protagonist|antagonist|plot|storyline|character\s+arc|world[- ]building)\b/i, 2],
  [/कहानी|उपन्यास|कविता|कथा|पात्र|अध्याय/, 3],
  [/\b(write|writes|writing|draft|author|compose|continue|expand)\b[^.]{0,40}\b(story|novel|book|chapter|poem|poetry|tale|saga|screenplay|कहानी|उपन्यास)\b/i, 2],
  [/\b(harry\s+potter|fantasy|magical|magic\s+and\s+suspense)\b/i, 1],
];

/** Long-form document signals (authored, but non-fiction). */
const DOCUMENT_SIGNALS: Array<[RegExp, number]> = [
  [/\b(report|whitepaper|white\s+paper|thesis|dissertation|essay|article|blog\s+post)\b/i, 3],
  [/\b(proposal|business\s+plan|case\s+study|literature\s+review|user\s+manual|handbook)\b/i, 3],
  [/\b(letter|cover\s+letter|resume|cv|memo|minutes|newsletter|speech|presentation\s+notes)\b/i, 3],
  [/\b(document|documentation|guide|tutorial|readme)\b[^.]{0,30}\b(write|draft|author|create|prepare|compose)\b/i, 3],
  [/\b(write|writes|writing|draft|author|compose|prepare)\b[^.]{0,30}\b(document|documentation|guide|tutorial|report|essay|article|blog\s+post|letter|chapter)\b/i, 2],
  [/\b(रिपोर्ट|निबंध|लेख|पत्र)\b/, 3],
  // A creation verb whose DOCUMENT noun is the HEAD of its object — the noun ends
  // the clause or is followed only by a destination/preposition. This is the
  // high-precision complement to the two proximity rules above, and it exists
  // because those two MISS the most ordinary phrasing of a document ask: the
  // proximity window is 30 characters, while "write a comprehensive technical
  // guide…" puts the noun 32 characters after the verb and "write a long detailed
  // technical design document to DESIGN.md" puts it 34 — measured, both classified
  // `code` (the F1 ask at confidence 0), so `wantsAuthoredArtifact` was false and
  // NEITHER the deliverable gate NOR `undeliveredArtifact` could apply. A live run
  // then wrote no file, claimed a "full ~5,000-word guide" on disk, and printed no
  // warning. Anchoring on what FOLLOWS the noun is what keeps this precise: "write
  // a test that validates the document parser" has `document` followed by `parser`,
  // and "write a user manual, then add a CLI flag" has `manual` followed by a
  // comma, so both stay off the authored path (the second is a genuinely mixed ask
  // whose code signal must win).
  [
    /\b(?:write|writes|writing|draft|author|compose|prepare|create)\b[^.;]{0,60}\b(?:document|documentation|guide|tutorial|report|essay|article|whitepaper|white\s+paper|manual|handbook|thesis|dissertation|specification)\b\s*(?:\([^)]*\)\s*)?(?:$|to\b|into\b|as\b|for\b|in\b|at\b|on\b|about\b|covering\b|describing\b)/i,
    3,
  ],
];

/** Data-analysis signals. */
const DATA_SIGNALS: Array<[RegExp, number]> = [
  [/\b(csv|xlsx|spreadsheet|dataset|dataframe|data\s+set)\b/i, 2],
  [/\b(analy[sz]e|aggregate|pivot|visuali[sz]e|plot|chart|dashboard)\b[^.]{0,30}\b(data|csv|numbers|sales|metrics)\b/i, 3],
  [/\b(correlation|regression|statistics|statistical|trend\s+analysis|forecast)\b/i, 3],
];

/** Research signals — a question to be answered, not an artifact to be built. */
const RESEARCH_SIGNALS: Array<[RegExp, number]> = [
  [/\b(research|survey|investigate|literature|state\s+of\s+the\s+art|compare|comparison)\b/i, 2],
  [/\b(compare|comparison|pros\s+and\s+cons|trade[- ]offs?)\b[^.]{0,60}\b(options|providers|tools|frameworks|libraries|approaches)\b/i, 3],
  [/\b(competitive\s+analysis|market\s+analysis|feasibility\s+study)\b/i, 3],
];

/**
 * Software signals. These are the strongest evidence available, because the
 * overwhelming majority of goals are engineering asks and a false positive
 * here would be a regression. Note the deliberate absence of bare "create" or
 * "build" — those are verbs that appear in EVERY goal ("build me a story") and
 * carry no class information on their own.
 */
const CODE_SIGNALS: Array<[RegExp, number]> = [
  [/\b(app|application|web\s?app|website|web\s+site|landing\s+page|frontend|front[- ]end)\b/i, 3],
  [/\b(api|endpoint|backend|back[- ]end|microservice|server|graphql|rest\s+api)\b/i, 3],
  // NOTE: bare `class` is deliberately NOT a signal — it is ordinary English
  // ("a book for a class 4 student") and reading it as a software noun flipped
  // an authored ask onto the code path. Real class declarations arrive with
  // language/file signals alongside them.
  [/\b(script|program|function|module|package|library|framework|sdk|cli|command[- ]line)\b/i, 3],
  [/\b(component|react|vue|angular|svelte|next\.?js|node|express|django|flask|fastapi|spring)\b/i, 3],
  [/\b(unit\s+test|test\s+suite|integration\s+test|e2e\s+test)\b/i, 3],
  [/\b(refactor|debug|fix\s+(the\s+)?(bug|error|issue|crash)|migrate|optimize\s+performance)\b/i, 3],
  [/\b(database|schema|sql|postgres|mysql|mongodb|query\s+optimization|dockerfile|kubernetes|terraform)\b/i, 3],
  [/\b(repo|repository|codebase|pull\s+request|commit|deploy|ci\/cd|pipeline)\b/i, 2],
  [/\b(\.ts|\.js|\.py|\.go|\.rs|\.java|\.cs|\.rb|\.html|\.css)\b/, 2],
  [/\b(python|typescript|javascript|golang|rust|c\+\+|c#|java|kotlin|swift|php|ruby|scala)\b/i, 3],
];

/**
 * Web/experience signals: the deliverable must be USED in a browser.
 *
 * Deliberately excludes the bare word "page" — the verbatim 100-page story
 * request says "page" and nothing about a site, and reading that as `web` would
 * have turned a book into a web app. "web page" is matched; "page" is not.
 */
const WEB_SIGNALS: RegExp[] = [
  /\b(web[- ]?based|web\s?app|website|web\s+site|webpage|web\s+page|inline\s+site|static\s+site)\b/i,
  /\b(interactive|interactivity|browser|in\s+the\s+browser|clickable|navigable|flip\s?book)\b/i,
  /\b(html|css|javascript|typescript|react|vue|svelte|next\.?js|frontend|front[- ]end|ui|reader|player)\b/i,
];

/** Signals that the ask wants a runtime/service layer (a script, a server). */
const PYTHON_SIGNALS: RegExp[] = [
  /\b(python|flask|fastapi|django|streamlit|jupyter|pip|venv)\b/i,
  /\b(text[- ]to[- ]speech|tts|speech\s+synthesis|narration|narrate|voice[- ]?over|audiobook|read\s+aloud)\b/i,
  /\b(gtts|pyttsx|elevenlabs|whisper|edge[- ]?tts|openai\s+tts|amazon\s+polly)\b/i,
];

/** Media the deliverable ships with (audio, illustrations, cover art). */
const ASSET_SIGNALS: RegExp[] = [
  /\b(audio|mp3|wav|narration|voice|sound|music|listen)\b/i,
  /\b(illustration|illustrations|image|images|artwork|cover\s+art|diagram|chart|infographic)\b/i,
];
// NOTE: `pdf|epub|docx` were REMOVED from this table on purpose. A PDF export is
// a FORMAT the same content is emitted in, not a second thing to build — and
// reading it as a substrate made the verbatim 100-page request ("…appreciate if
// a pdf is created…") classify as a composite deliverable, which would have
// planned a shell around a book that had not been written yet.

/**
 * Phrases that invert the class of the words around them: the goal is about a
 * program that MANIPULATES the named artifact, not the artifact itself.
 * e.g. "convert this PDF to text", "parse the story file", "a script that
 * writes PDFs". Without this, "create a PDF exporter" would read as authored.
 */
const CODE_INTENT_OVERRIDES: RegExp[] = [
  /\b(convert|parse|extract|scrape|index|upload|download|render|export|import)\b[^.]{0,40}\b(pdf|docx|csv|md|markdown|story|document)\b/i,
  /\b(pdf|docx|markdown|document)\b[^.]{0,30}\b(generator|exporter|parser|converter|to\s+(text|html|markdown))\b/i,
  /\b(script|program|tool|utility|function|pipeline)\b[^.]{0,30}\b(that|which|to)\b[^.]{0,30}\b(generat|writ|convert|parse|extract)/i,
];

// ─── Classification ─────────────────────────────────────────────────────────

/** Score one table against the goal, collecting the matched signals. */
function scoreTable(goal: string, table: Array<[RegExp, number]>, label: string, signals: string[]): number {
  let score = 0;
  for (const [re, weight] of table) {
    const m = goal.match(re);
    if (m) {
      score += weight;
      signals.push(`${label}:${m[0].trim().slice(0, 40)}`);
    }
  }
  return score;
}

/**
 * Classify a goal into a deliverable class.
 *
 * Scoring is additive with per-signal weights rather than first-match, so a
 * goal that mixes signals ("write a story AND package it as a CLI") resolves
 * on the balance of evidence. Confidence is derived from the winning margin,
 * so a clear call scores high and a coin-flip stays low — which is exactly
 * what the caller needs to decide whether to override the LLM.
 *
 * Defaults to `code` when nothing matches: that preserves today's behaviour
 * for every goal this module does not understand.
 */
export function classifyDeliverable(goal: string): DeliverableVerdict {
  const g = (goal || '').trim();
  if (!g) return emptyVerdict();

  const signals: string[] = [];
  const scores: Record<DeliverableClass, number> = {
    creative: scoreTable(g, CREATIVE_SIGNALS, 'creative', signals),
    document: scoreTable(g, DOCUMENT_SIGNALS, 'document', signals),
    data: scoreTable(g, DATA_SIGNALS, 'data', signals),
    research: scoreTable(g, RESEARCH_SIGNALS, 'research', signals),
    code: scoreTable(g, CODE_SIGNALS, 'code', signals),
  };

  // A code-intent phrase means the software signal describes TOOLING around an
  // artifact, not an authored deliverable: strengthen `code` accordingly.
  const override = CODE_INTENT_OVERRIDES.find((re) => re.test(g));
  if (override) {
    scores.code += 4;
    signals.push(`code-intent-override:${override.source.slice(0, 30)}`);
  }

  // Authored content is ONE deliverable, so the two authored tables reinforce
  // each other rather than competing: a goal that says "story ... chapters"
  // scores creative 6+, and "report ... write" scores document 5+.
  const authoredScore = scores.creative + scores.document;

  // Ordered by score, then by a fixed priority so ties are deterministic.
  const priority: DeliverableClass[] = ['code', 'creative', 'document', 'data', 'research'];
  let winner: DeliverableClass = 'code';
  let best = -1;
  for (const cls of priority) {
    if (scores[cls] > best) {
      best = scores[cls];
      winner = cls;
    }
  }

  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  if (best <= 0 || total === 0) {
    return { ...emptyVerdict(), signals };
  }

  // Margin-based confidence: a dominant winner approaches 1, a tie sits near
  // 0.5. The authored bonus nudges a strongly-authored goal over the floor.
  const second = Math.max(
    ...priority.filter((c) => c !== winner).map((c) => scores[c]),
    0,
  );
  const margin = (best - second) / Math.max(best, 1);
  let confidence = 0.5 + margin / 2;
  if (authoredScore >= 5 && (winner === 'creative' || winner === 'document')) {
    confidence = Math.max(confidence, 0.7);
  }
  confidence = Math.min(1, Math.round(confidence * 100) / 100);

  // Two independent ways to be an authored deliverable:
  //
  //  1. the CLASS is authored (strong authored margin, confidence over the
  //     floor);
  //  2. the ARTIFACT is named and the ask wants a presentation layer for it.
  //     This second path exists because a hybrid ask scores on BOTH tables —
  //     "an interactive website with a 50-page story and a python narration
  //     script" scores creative 8 and code 9 (website 3 + script 3 + python 3),
  //     so the class lands on `code` even though the user named a story as the
  //     deliverable. A named authored artifact outranks generic implementation
  //     nouns; the presentation layer is HOW they want it delivered.
  const authoredByClass =
    (winner === 'creative' || winner === 'document') &&
    authoredScore >= 3 &&
    confidence >= AUTHORED_CONFIDENCE_FLOOR;
  const flags = substrateFlags(g);
  const hybridArtifact =
    authoredScore >= 6 && (flags.web || flags.python) && !override && winner === 'code';
  const authored = authoredByClass || hybridArtifact;

  const { substrates, composite, interactive } = classifySubstrates(g, {
    authored,
    winner,
    codeIntent: !!override,
    flags,
  });
  if (composite) signals.push(`composite:${substrates.join('+')}`);
  if (interactive) signals.push('interactive');

  return { class: winner, confidence, signals, authored, substrates, composite, interactive };
}

/** The "nothing matched" verdict — one shape, built in one place. */
function emptyVerdict(): DeliverableVerdict {
  return { class: 'code', confidence: 0, signals: [], authored: false, substrates: ['web'], composite: false, interactive: false };
}

/** Which secondary materials the ask names (computed once, reused). */
function substrateFlags(goal: string): { web: boolean; python: boolean; asset: boolean } {
  return {
    web: WEB_SIGNALS.some((re) => re.test(goal)),
    python: PYTHON_SIGNALS.some((re) => re.test(goal)),
    asset: ASSET_SIGNALS.some((re) => re.test(goal)),
  };
}

/**
 * Work out WHAT the deliverable is made of, and whether that is plural.
 *
 * The rules, in order, because the ordering is the whole design:
 *
 *  1. The class verdict is the spine. Authored work is `prose`; software is
 *     reported by what it runs on (`web` for anything browser-facing, else
 *     `python` when the ask names a Python runtime, else `web` as the neutral
 *     default for a program with no stated runtime).
 *  2. Authored work ADDS substrates rather than replacing them: a goal that is
 *     both prose and web is `['web', 'prose']`. This is what makes "a web-based
 *     book" a hybrid instead of a coin flip.
 *  3. `python` is recorded as its own substrate when a runtime/service was
 *     named, so the plan can create the script AND check that the site still
 *     works without it. A Python narration service must never be the only path
 *     to listening — a page that needs `pip install` before it does anything is
 *     not an enterprise deliverable.
 *  4. A CODE-INTENT override means the code signals describe tooling AROUND an
 *     artifact ("a script that writes PDFs"): the artifacts are inputs, not
 *     substrates, so no authored substrate is added.
 */
function classifySubstrates(
  goal: string,
  ctx: {
    authored: boolean;
    winner: DeliverableClass;
    codeIntent: boolean;
    flags: { web: boolean; python: boolean; asset: boolean };
  },
): { substrates: Substrate[]; composite: boolean; interactive: boolean } {
  const wantsWeb = ctx.flags.web;
  const wantsPython = ctx.flags.python;
  const wantsAsset = ctx.flags.asset;
  const wantsData = ctx.winner === 'data';

  const substrates: Substrate[] = [];
  const push = (s: Substrate) => {
    if (!substrates.includes(s)) substrates.push(s);
  };

  // The primary substrate, from the class verdict.
  if (ctx.authored) push('prose');
  else if (wantsData) push('data');
  else if (ctx.winner === 'research') push('web');
  else if (wantsPython && !wantsWeb) push('python');
  else push('web');

  // Secondary materials. Only authored work gets these as ADDITIONS — for a
  // pure software ask they merely refine the single primary substrate.
  if (ctx.authored && !ctx.codeIntent) {
    if (wantsWeb) push('web');
    if (wantsPython) push('python');
    if (wantsAsset) push('asset');
  } else if (!ctx.authored) {
    if (wantsWeb) push('web');
    if (wantsPython) push('python');
  }

  if (substrates.length === 0) substrates.push('web');

  // COMPOSITE means "authored content AND a way to experience it" — NOT merely
  // "two runtimes". A React front-end over a Python API is multi-substrate but
  // it is an application, and the ordinary code planner plans those correctly;
  // treating it as composite would route it into the phase planner, which is
  // only there for content-plus-presentation work.
  const composite = ctx.authored && substrates.length > 1;
  // "Experienced, not just read": a site to navigate or narration to play.
  // MERELY shipping a PDF is not interactive — it is a document.
  const audioAsked = /\b(audio|mp3|wav|narration|narrate|voice[- ]?over|listen|read\s+aloud|text[- ]to[- ]speech|tts)\b/i.test(goal);
  const interactive = substrates.includes('web') || audioAsked;

  return { substrates, composite, interactive };
}

/**
 * Convenience: is this goal asking for authored content (prose) rather than a
 * program? The orchestrator uses this one predicate to switch planning modes.
 */
export function isAuthoredGoal(goal: string): boolean {
  return classifyDeliverable(goal).authored;
}

/**
 * Is this goal an authored deliverable too large to fit ONE generation?
 *
 * The single source of truth for "needs the unit-planning engine": an explicit
 * magnitude that resolves to more than one bounded unit, or a book/novel with an
 * EXPLICIT count. A DEFAULT magnitude for an unnumbered book ("write a book")
 * is deliberately excluded — a default is not something the user asked for, so
 * it must not re-route the ask. `isLongFormDeliverable` in the conversation gate
 * delegates here so the rule can never be defined twice and drift.
 */
export function isLongFormAuthoredGoal(goal: string): boolean {
  const g = (goal || '').trim();
  if (!g) return false;
  const target = parseLongFormTarget(g);
  if (!target || target.unitCount <= 1) return false;
  if (/^default\b/.test(target.source)) return false;
  return isAuthoredGoal(g);
}

/**
 * Is this goal an authored deliverable whose size argues for the ASSEMBLY
 * engine — either a magnitude that needs more than one unit ("a 200 page
 * book"), or a NAMED DESTINATION ("write a 2 page story to /path/x.md")?
 *
 * This is the narrow half of G13b, for the surfaces that must decide between a
 * chat answer and a produced artifact (`conversation-gate.ts`). It is narrow on
 * purpose: for "write a poem about rain" the text IS the deliverable, and turning
 * every short creative ask into a multi-agent pipeline run would be the original
 * category error in reverse. Pinned chat asks: a poem, a song, an essay, a 1-page
 * summary, and a bare "a book" (a DEFAULT magnitude is not something the user
 * asked for).
 */
export function asksForAuthoredFile(goal: string): boolean {
  if (!isAuthoredGoal(goal)) return false;
  if (isLongFormAuthoredGoal(goal)) return true;
  // The verdict is the SAME one the write gate uses, so "the user named a
  // destination" can never mean two different things in two places.
  return requestAuthorizesWrites(goal).requestedPath !== undefined;
}

/**
 * Is this goal an authored deliverable the user asked to be PRODUCED?
 *
 * G13b. `isAuthoredGoal` says WHAT the deliverable is; this says the user asked
 * for the ARTIFACT rather than merely for the text. The gap it closes was found
 * live: `write a 12 page story at /path/Mahagatha.md` and `tell me a story`
 * looked the same to the engine router, so the loop engine answered the first
 * one in chat — a complete, genuinely good story in the reply and NOTHING at the
 * path the user named.
 *
 * This is the BROAD half, and its callers are the ones that run only AFTER the
 * ask is already known to be a task rather than a chat answer:
 *
 *   - the engine ROUTER (`engine-router.ts`) — among tasks, an authored
 *     deliverable belongs to the pipeline, which plans units and ASSEMBLES the
 *     document, including the hybrid "web-based book" shape;
 *   - the loop engine's DELIVERABLE GATE (`tool-loop.ts`) — the backstop for an
 *     explicit `--engine loop` run, where the right outcome is still the file.
 *
 * The two halves differ by exactly that context, so `conversation-gate.ts` uses
 * {@link asksForAuthoredFile} and these two use this one.
 */
export function wantsAuthoredArtifact(goal: string): boolean {
  if (!isAuthoredGoal(goal)) return false;
  return requestAuthorizesWrites(goal).authorized;
}

/**
 * Is this a HYBRID deliverable — content plus a way to experience it?
 *
 * The orchestrator uses this one predicate to switch from "plan the content" to
 * "plan the phases" (scaffold → content → experience → assets → verify). Kept
 * here rather than in the planner so the intent vocabulary lives in one place.
 */
export function isCompositeGoal(goal: string): boolean {
  return classifyDeliverable(goal).composite;
}

/** Human-readable substrate list, for logs, traces and prompts. */
export function describeSubstrates(verdict: DeliverableVerdict): string {
  return verdict.substrates.join(' + ');
}

/** Human-readable label for logs, traces and prompts. */
export function deliverableClassLabel(cls: DeliverableClass): string {
  switch (cls) {
    case 'creative':
      return 'creative writing (an authored work)';
    case 'document':
      return 'an authored document (non-fiction)';
    case 'data':
      return 'data analysis';
    case 'research':
      return 'research / comparison';
    default:
      return 'software';
  }
}

/**
 * The instruction handed to the reasoner so its technical-decision document
 * stops pretending an authored ask is a program.
 *
 * This is the fix for the exact reasoning string the audit captured
 * ("a Python script is the most efficient way to…"): the reasoner is told, in
 * its own JSON vocabulary, that `language` must NOT be a programming language
 * for these classes, and that building a generator is the wrong deliverable.
 */
export function authoredDeliverableGuidance(cls: DeliverableClass, substrates?: Substrate[]): string {
  if (cls !== 'creative' && cls !== 'document') return '';
  const noun = cls === 'creative' ? 'story/novel/poem' : 'report/essay/document';
  return [
    '',
    `## ⚠️ DELIVERABLE CLASS: ${deliverableClassLabel(cls)}`,
    `The user is asking for the CONTENT ITSELF — a ${noun} — not a program that`,
    'produces it. This is already decided and is NOT yours to renegotiate.',
    '',
    'Consequences for your JSON decision:',
    '- `language`: "none" (there is no programming language involved)',
    '- `framework`: "none"',
    '- `platform`: "document"',
    '- `architecture`: "sections"',
    '- `dependencies`: []',
    '- `buildCommand`: omit it',
    '- `deliverable`: the artifact the user named (e.g. "markdown_file", "pdf")',
    '',
    'You MUST NOT plan a script, tool, or generator that would write the content.',
    'Writing the content IS the task. A script that calls an LLM to write it is a',
    'non-delivery: the user asked for the work, not for a machine that could do it.',
    '',
    'Constraints should cover: target length (pages/words/chapters), continuity',
    'with any existing content, and the destination path.',
    ...(substrates && substrates.length > 1 ? compositeGuidance(substrates) : []),
  ].join('\n');
}

/**
 * The extra instructions for a HYBRID authored ask.
 *
 * The two failure modes this closes are opposites, and both were live:
 *   - building the PRESENTATION and forgetting the CONTENT (a beautiful empty
 *     reader — the same non-delivery as the Python script, one layer up);
 *   - shipping the content with no way to experience it (a markdown file for an
 *     ask that said "web-based" and "interactive").
 * The guidance therefore names BOTH, and pins the ordering: content first.
 */
function compositeGuidance(substrates: Substrate[]): string[] {
  const lines = [
    '',
    '## ⚠️ THIS IS A HYBRID DELIVERABLE',
    `It is made of MORE THAN ONE thing: ${substrates.join(' + ')}. All of it is`,
    'required. A site with no content, or content with no site, is a NON-DELIVERY.',
    '',
    'How the pieces relate (do not invert this):',
  ];
  if (substrates.includes('prose')) {
    lines.push('- The WRITTEN WORK is the deliverable. Everything else presents it.');
  }
  if (substrates.includes('web')) {
    lines.push(
      '- The web layer must work by opening a local file — no install, no build',
      '  step, no server required. Anything that needs `npm install` before it',
      '  shows a single word is not the deliverable the user asked for.',
    );
  }
  if (substrates.includes('python')) {
    lines.push(
      '- A Python/service component is an OPTIONAL ENHANCEMENT, never the only',
      '  path. The deliverable must be complete and usable without it (e.g. a',
      '  browser-based speech path alongside an optional high-quality TTS script).',
    );
  }
  if (substrates.includes('asset')) {
    lines.push('- Any media the ask names must be generated or produced, not merely referenced.');
  }
  lines.push(
    '',
    'Plan the phases in dependency order: shape first, content second, the',
    'experience layer third, optional services last, a verification step at the end.',
  );
  return lines;
}
