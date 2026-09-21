/**
 * C1 — NLU rule fast-path.
 *
 * Deterministic intent classification for developer requests. Pure rules only:
 * zero network, zero model calls, <5ms typical. Unknown inputs return
 * `confidence: 0` (never a guess) so the C2 LLM-verify path takes over.
 *
 * A single dispatch loop, no user-facing
 * mode picker): the intent + modeHint resolved here is the vocabulary the C3
 * action map and the orchestrator pipeline consume, so intent resolution and
 * tool dispatch share one source of truth.
 *
 * Temporal references ("last week", "yesterday", "2 days ago") are extracted
 * via `@microsoft/recognizers-text-date-time` — MIT, pure JS, no model call —
 * which alone covers the headline "continue last week's plan" case.
 */

import { recognizeDateTime, Culture } from '@microsoft/recognizers-text-date-time';

// ─── Types ──────────────────────────────────────────────────────────────────

/** The intents C1 can resolve deterministically. */
export type NluIntent = 'create' | 'continue' | 'fix' | 'explain' | 'configure' | 'write' | 'unknown';

/** The pipeline a resolved intent should run (C3 action-map key). */
export type ModeHint = 'dev' | 'recall' | 'execute' | 'chat' | 'config';

/** A temporal reference normalized from the recognizer. */
export interface TimeRange {
  /** The matched surface text, e.g. "last week". */
  text: string;
  /** ISO start (ranges) or point (dates). */
  start?: string;
  /** ISO end (present for ranges). */
  end?: string;
  /** TIMEX expression when available. */
  timex?: string;
}

/** The deterministic classification result. */
export interface IntentResult {
  intent: NluIntent;
  /** 0–1. 0 means unknown — C2 must verify. */
  confidence: number;
  /** The pipeline hint, or null for unknown. */
  modeHint: ModeHint | null;
  /** Present only for continue/resume with a temporal reference. */
  timeRange?: TimeRange;
}

/** Rule confidence above which the rule path is trusted (C2 only below this). */
export const RULE_TRUST_THRESHOLD = 0.8;

// ─── Pure rule matchers ─────────────────────────────────────────────────────
// Every rule is a pure function with a unit test; each returns a full match or
// null so `classifyIntent` is a plain priority walk — no shared state.

/** Explain/interrogative → chat ("explain caching", "how do I add JWT auth?"). */
export function matchExplainRule(text: string): IntentResult | null {
  // Guard: "can you fix X" or "could you debug Y" is a FIX request, not a
  // question. The fix rule runs later in priority, but the explain rule's
  // When a coding verb appears in COMMAND position (start or after polite
  // prefix), it's a task request, not a question. "evaluate the test coverage"
  // has "test" as a NOUN — must not block. "can you deploy the api?" has
  // "deploy" in command position — must block (it's a task, not a question).
  const codingTaskVerb = /^(?:please\s+|can you\s+|could you\s+|would you\s+|i need you to\s+|help me\s+)?(?:fix|debug|repair|troubleshoot|resolve|patch|address|diagnose|correct|create|build|implement|generate|scaffold|bootstrap|develop|set up|deploy|test|run|publish|ship|launch|refactor|migrate|integrate|optimize|restructure|install)\b/i;
  const fixAsNoun = /(?:the|a|an|this|that|any)\s+fix\b/i.test(text);
  if (codingTaskVerb.test(text) && !fixAsNoun) return null;
  if (
    /\b(?:explain|describe|assess|evaluate|analyze|compare|walk me through|tell me about)\b/i.test(
      text,
    ) ||
    /^(?:what|how|why|when|where|which|can you|could you|would you)\b/i.test(text) ||
    /\b(?:vs\.?|versus|or|compared to|difference between)\b/i.test(text)
  ) {
    return { intent: 'explain', confidence: 0.8, modeHint: 'chat' };
  }
  return null;
}

/**
 * Continue/resume → recall, with a temporal timeRange when the text carries one
 * ("continue last week's ecommerce plan" → timeRange for last week).
 * The reference date is injectable for deterministic tests.
 */
export function matchContinueRule(text: string, referenceDate: Date = new Date()): IntentResult | null {
  if (
    /\b(?:continue|resume|pick ?up|keep going|carry on|left off|start from where|go back to)\b/i.test(
      text,
    )
  ) {
    const timeRange = extractTimeRange(text, referenceDate);
    return {
      intent: 'continue',
      confidence: timeRange ? 0.95 : 0.9,
      modeHint: 'recall',
      ...(timeRange ? { timeRange } : {}),
    };
  }
  return null;
}

/**
 * Fix/debug → execute ("fix the login bug", "debug the failing test").
 *
 * The keywords must be WHOLE words: a hyphen or underscore on either side means
 * the token is part of an identifier (e.g. the project name `nuvira-fix-validation`
 * or a branch `fix-123`) — a request mentioning it is not a fix request. \b
 * alone is insufficient: it treats `-` and `_` as word boundaries, so
 * "deploy the project nuvira-fix-validation" would false-positive into fix.
 */
export function matchFixRule(text: string): IntentResult | null {
  // OBJECT-AWARE GUARD: "fix my diet plan" / "correct my child's worksheet" is
  // content repair, not debugging — the fix verb must not send a life/school
  // artifact to the developer pipeline (whose planner emits a program).
  if (isContentArtifactAsk(text)) return null;
  // QUESTION GUARD — it must come BEFORE the verb test, because that test is a
  // bare keyword match and "the fix for" is the verb used as a NOUN. Measured
  // live: "so, what is the fix for this error?" classified as a fix TASK and
  // ran the developer pipeline, purely because the verb test matched first and
  // the old question guard (below, at character 0 only) never ran. The marker
  // prefix matters for the same reason: the sentence opens with "so,".
  //
  // A task phrased as a question is unaffected: the conversation gate's
  // coding-action override ("how do I fix …", "can you fix …") still routes it
  // to the pipeline, which is the surface that decision actually belongs on.
  if (/^(?:(?:so|now|then|ok|okay|and|but|please)\s*,?\s*)*(?:what|how|why|when|where|which)\b/i.test(text)) {
    return null;
  }
  if (/(?:^|[^\w-])(?:fix|debug|repair|troubleshoot|resolve|patch|address|diagnose|correct)(?:$|[^\w-])/i.test(text)) {
    return { intent: 'fix', confidence: 0.85, modeHint: 'execute' };
  }
  // "X is broken", "X keeps failing", "X stopped working" — implicit fix tasks.
  // "X failed" — standalone failure signal ("the build failed").
  if (/\b(?:is|are|was|were|keeps?|kept|stopped|has stopped)\s+(?:broken|failing|crashing|erroring|not working|working|dead)\b/i.test(text)) {
    return { intent: 'fix', confidence: 0.8, modeHint: 'execute' };
  }
  if (/\bfailed\b/i.test(text)) {
    return { intent: 'fix', confidence: 0.8, modeHint: 'execute' };
  }
  return null;
}

/** Configure → config ("configure the gemini api key", "switch provider"). */
export function matchConfigureRule(text: string): IntentResult | null {
  // Guard: a CREATE request whose object happens to be a "config" ("create a
  // config file") must reach the create rule, not configure. Config wins only
  // when the sentence does NOT lead with a create verb.
  if (/^(?:please\s+)?(?:create|generate|write|build|make)\b/i.test(text)) return null;
  if (
    /\b(?:configure|config(?:ure)?|settings?)\b/i.test(text) ||
    /\bapi ?key\b/i.test(text) ||
    /\b\.env\b/i.test(text) ||
    /\b(?:switch|change|set(?:\s+up)?|update)\s+(?:my|the|a|an)?\s*(?:\w+\s+)?(?:model|provider|key|token|credential)s?\b/i.test(text) ||
    /\b(?:switch|change)\s+.*\bto\s+\w/i.test(text) // "change X to Y" pattern
  ) {
    return { intent: 'configure', confidence: 0.85, modeHint: 'config' };
  }
  return null;
}

/**
 * Non-coding planning/lifestyle artifacts. "Create a plan/routine/schedule for
 * my child" is a CONTENT request (teach me, give me a routine) — it is NOT a
 * software deliverable. Observed live: the WhatsApp ask "Can you create plan to
 * enable my child learn spoken English" ran the DEVELOPER pipeline, whose
 * planner (a "senior software architect") answered with a Python program using
 * SpeechRecognition/gTTS. Guarded by CODING_OBJECT_RE so a plan FOR code
 * ("create a plan for the ecommerce app") still reaches the create rule.
 */
const NON_CODE_ARTIFACT_RE =
  /\b(?:plans?|routines?|schedules?|timetables?|time[- ]?tables?|curricul(?:um|a)|syllab(?:us|i)|diets?|meal plans?|workouts?|exercise plans?|fitness plans?|budgets?|itinerar(?:y|ies)|reading lists?|study plans?|revision plans?|lesson plans?|habit trackers?|chore charts?|worksheets?|quiz(?:zes)?|exams?|examinations?|question papers?|test papers?|question banks?|answer keys?|mock tests?)\b/i;

/**
 * Prose/document/book deliverables — the same object-blindness one step
 * further out. A book/guide/course/report is CONTENT, but the bare create verb
 * still sent it to the developer pipeline (observed live: "create a book which
 * teaches maths division for class 4 student" → create/dev → pipeline, planner
 * as a "senior software architect").
 *
 * Deliberately EXCLUDES code-shaped nouns — "script", "program", "tool" —
 * even though the write rule's own object list carries some of them: that list
 * is guarded by a *writing verb*, while this one is consulted by the
 * verb-agnostic guard, so "create a script to back up files" must stay coding.
 */
const CONTENT_DOCUMENT_RE =
  /\b(?:books?|e ?books?|text ?books?|work ?books?|story ?books?|comic books?|graphic novels?|novels?|guides?|hand ?books?|manuals?|tutorials?|courses?|articles?|essays?|blog posts?|newsletters?|reports?|summaries?|cheat ?sheets?|flash ?cards?|mind ?maps?|presentations?|slideshows?|slide decks?|poems?|poetry|songs?|lyrics|rhymes?|stories|short stories|fables?|myths?|legends?|letters?|cover letters?|e ?mails?|resumes?|biographies?|memoirs?|speeches?|recipes?|cook ?books?|shopping lists?|grocery lists?|check ?lists?|outlines?|tables? of contents?|appendi(?:x|ces)|glossar(?:y|ies)|prefaces?|forewords?|road ?maps?|posters?|flyers?|brochures?|pamphlets?|invitations?|puzzles?|crosswords?|riddles?)\b/i;

/**
 * Nouns naming a SOFTWARE deliverable. When one is present the ask stays a
 * coding task even if it also says "plan"/"schedule" — the artifact guard must
 * not starve a real dev request just because it is phrased as a plan.
 */
const CODING_OBJECT_RE =
  /\b(?:functions?|modules?|components?|apis?|endpoints?|routes?|handlers?|controllers?|resolvers?|middleware|hooks?|wrappers?|servers?|databases?|dbs?|clis?|tools?|services?|programs?|scripts?|apps?|applications?|workers?|daemons?|plugins?|packages?|librar(?:y|ies)|projects?|repos?(?:itories)?|schemas?|features?|websites?|web ?apps?|dashboards?|backends?|frontends?|code|codebase|microservices?|dockerfiles?|docker|kubernetes|k8s|sdks?|addons?|extensions?|pipelines?|workflows?|bots?|specs?|migrations?)\b/i;

/**
 * The artifact phrase a create-style verb asks for — "project plan" in "create
 * a project plan to develop X".
 */
const CREATE_VERB_RE =
  /\b(?:create|make|write|draft|compose|prepare|design|give|provide|suggest|build|generate)\b\s+(?:me\s+)?(?:(?:a|an|the|some|another|new|my|our)\s+)?/i;

/** Where the requested artifact phrase ends and the purpose clause begins. */
const ARTIFACT_PHRASE_END_RE =
  /\s+(?:to|for|with|that|which|who|and|or|about|on|in|from|so|but|then|covering|including|listing|using|based)\b|[,.!?;:]/i;

/**
 * Remove the requested artifact phrase — but ONLY when its HEAD noun is a
 * plan/document noun. Otherwise the artifact IS software ("create a course
 * website") and the coding-object veto must stand.
 *
 * This separates a coding noun that MODIFIES the artifact from one that IS the
 * deliverable. "project plan" asks for a plan ABOUT a project: its head noun is
 * `plan`, and the bare word `project` used to veto the content guard on its
 * own. Observed live 2026-09-21 — "Create a project plan to develop a multiple
 * screen calculator and unit converter…" ran the developer pipeline and failed
 * 0/7 steps, when the sender was asking for a plan. Compare "create a plan FOR
 * the ecommerce app", where the software noun sits in a PURPOSE clause rather
 * than in the artifact phrase: that is still a dev plan, and still reaches the
 * create rule.
 */
function stripRequestedArtifactPhrase(text: string): string {
  const m = CREATE_VERB_RE.exec(text);
  if (!m) return text;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const end = rest.search(ARTIFACT_PHRASE_END_RE);
  const phrase = end >= 0 ? rest.slice(0, end) : rest;
  const words = phrase.split(/[^A-Za-z0-9-]+/).filter(Boolean);
  const head = words[words.length - 1] ?? '';
  if (!head || !(NON_CODE_ARTIFACT_RE.test(head) || CONTENT_DOCUMENT_RE.test(head))) return text;
  return text.slice(0, start) + rest.slice(phrase.length);
}

/**
 * A BACKWARD REFERENCE to an artifact that already exists — "as per the plan
 * you created", "based on my design", "following the schedule".
 *
 * THE SAME OBJECT-BLINDNESS, MIRRORED. The guards above fixed a coding noun
 * used as a *modifier* of the requested artifact ("create a PROJECT PLAN").
 * This one is the opposite direction: the plan/document noun is not the
 * requested artifact at all — it names something from an EARLIER turn. So
 * immediately after the fix that made "create a project plan to develop X"
 * answer in chat, the obvious follow-up — *"Develop the calculator as per the
 * plan created by agent-nuvira"* — was answered in CHAT: `plan` matched the
 * artifact list, no software noun vetoed it, and the user's genuine develop
 * request never reached the pipeline. The requested deliverable there is the
 * calculator; `the plan` is context.
 *
 * The marker alone is not enough to strip — that would eat whole sentences
 * ("using the plan, create a worksheet" is a content ask, and its verb would
 * vanish). The clause is therefore bounded to marker + a short noun phrase
 * whose head is a KNOWN plan/document/spec noun, which is what keeps it
 * precise: "generate a report from the data" simply does not match.
 */
const ARTIFACT_REFERENCE_RE = new RegExp(
  '\\b(?:as\\s+per|per|according\\s+to|based\\s+on|in\\s+line\\s+with|consistent\\s+with|following|referring\\s+to|as\\s+(?:described|outlined|detailed|specified|stated|mentioned|defined)\\s+in)' +
    '\\s+(?:the|my|our|your|that|this|above|previous|earlier|same|a|an)?\\s*' +
    '(?:[a-z][a-z-]*\\s+){0,2}?' +
    '(?:plans?|documents?|specs?|specifications?|designs?|proposals?|blueprints?|briefs?|outlines?|roadmaps?|instructions?|schedules?)\\b',
  'gi',
);

/**
 * Drop backward-reference clauses so a guard judges the REQUESTED artifact.
 * Exported because the conversation gate needs the same view of the sentence:
 * "Following the plan, develop the calculator" must still read as a coding
 * action even though it does not literally start with the verb.
 */
export function stripArtifactReferences(text: string): string {
  return String(text ?? '').replace(ARTIFACT_REFERENCE_RE, ' ');
}

/**
 * True when an ask is about a NON-CODING artifact (a plan/routine/schedule for
 * life, teaching, fitness, diet …) and names no software deliverable. Such an
 * ask must be ANSWERED, never dispatched to the coding pipeline.
 */
export function isNonCodeArtifactAsk(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  // The artifact word must be in the REQUEST itself, not in a backward
  // reference to an earlier artifact (see ARTIFACT_REFERENCE_RE). The coding
  // veto below still reads the FULL text: a software object named anywhere —
  // including inside the reference clause — still makes this a dev ask.
  const requested = stripArtifactReferences(t).trim();
  if (!(NON_CODE_ARTIFACT_RE.test(requested) || CONTENT_DOCUMENT_RE.test(requested))) return false;
  if (!CODING_OBJECT_RE.test(t)) return true;
  // A software noun vetoes only when it is NOT merely a modifier inside the
  // requested artifact phrase (see stripRequestedArtifactPhrase).
  return !CODING_OBJECT_RE.test(stripRequestedArtifactPhrase(t));
}

/**
 * An EDUCATIONAL frame — a class/grade, a school/exam context. Without one, a
 * "test"/"worksheet" is the software kind (`create a test for the login
 * function`); with one it is schoolwork (`create a test for class 4`).
 */
const EDUCATION_FRAME_RE =
  /\b(?:class|grade|std|standard)\s*\d+\b|\b(?:school|exam(?:ination)?s?|mcq|worksheets?|question papers?|question banks?|syllabus|semesters?|homework|tuition|pupils?|students?|teacher|curriculum|revision)\b/i;

/** Artifacts produced for a CLASS: a school test/quiz/worksheet/exam paper. */
const ACADEMIC_ARTIFACT_RE = /\b(?:tests?|assignments?|homeworks?|notes?)\b/i;

/**
 * True when the ask names an ACADEMIC artifact (a class test/quiz/worksheet/
 * exam paper) rather than a software one.
 *
 * Observed live: the same object-blindness that sent a teaching PLAN to the
 * developer pipeline also sent school work there — "create a test for class 4"
 * and "make a worksheet for grade 3" are CONTENT, not code. The education frame
 * plus the absence of a coding object is what separates them from the software
 * test/worksheet (`create a test for the login function`).
 */
export function isAcademicArtifactAsk(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return ACADEMIC_ARTIFACT_RE.test(t) && EDUCATION_FRAME_RE.test(t) && !CODING_OBJECT_RE.test(t);
}

/**
 * True when the ask is for CONTENT rather than a software deliverable — a
 * life/teaching plan or routine, an academic test/worksheet, etc.
 *
 * THE single guard the verb-driven rules consult. Every rule that keys off a
 * verb (`create`/`build`/`fix`/`make`/`write`/`test`) is blind to the verb's
 * OBJECT on its own, so "create plan …", "build a routine", "fix my diet
 * plan" and "create a test for class 4" all read as coding tasks. Consulting
 * one shared predicate keeps the CLI, dashboard and gateway in agreement.
 */
export function isContentArtifactAsk(text: string): boolean {
  return isNonCodeArtifactAsk(text) || isAcademicArtifactAsk(text);
}

/**
 * Write/creative → chat (S4). "Write an essay/poem/story/letter/article/…" is
 * a CONTENT request — a direct chat answer, NEVER the coding pipeline (the
 * observed failure: "write an essay" was classified create → the no-model
 * fallback spun up the full multi-agent pipeline for a zero-code task). The
 * model still sees the build/analyze/… tools in the loop and can call them if
 * the request actually needs code — the action only governs the no-model
 * fallback + the routing hint. Runs BEFORE matchCreateRule so "write a test"
 * (test is not a writing artifact) still resolves to create.
 */
export function matchWriteRule(text: string): IntentResult | null {
  // Songs/hymns/bha_jans/shayari were missing (observed live: "Write a song in
  // hindi … for my daughter" routed to the DEVELOPER pipeline). Keep the
  // explicit list (fast, precise) but treat it as an allowlist WITH a
  // fallback, not the only path.
  const writingObject =
    /\b(?:essay|poem|poetry|song|lyrics|hymn|anthem|shayari|ghazal|jingle|lullaby|rap|haiku|sonnet|ode|elegy|story|short story|fiction|fantasy|novel|biography|memoir|tale|fable|myth|legend|recipe|letter|article|blog(?: post)?|paragraph|composition|dialogue|screenplay|script|play|skit|monologue|speech|caption|advertisement|review|summary|prose|note|message|email|homework|assignment|poster|diagram|flowchart|flow.?chart|wireframe|mind.?map|chart|infographic|brochure|flyer|pamphlet|newsletter|report|presentation|slideshow|mockup|blueprint|layout|sketch|outline|mindmap)\b/i;
  // Coding nouns that must NOT match the write rule — "write a function for"
  // or "write a test for" are dev tasks, not creative content. These nouns
  // fall through to matchCreateRule so the coding pipeline runs. "class"
  // excluded: "class 4 student" is a grade level, not a coding class.
  const codingNoun =
    /\b(?:function|module|component|api|endpoint|route|server|database|cli|tool|service|program|script|app(?:lication)?|worker|daemon|plugin|package|library|project|schema)\b/i;
  // Content artifacts (plan/routine/schedule/curriculum/diet/… for life or
  // teaching; class test/worksheet/exam for school) name no software
  // deliverable — they are CONTENT. Answer directly; never spin up the
  // developer pipeline (whose planner would emit a program). Guarded by
  // `isContentArtifactAsk`, so "create a plan for the ecommerce app" and
  // "create a test for the login function" (both name a coding object) still
  // fall through to the create rule below.
  if (isContentArtifactAsk(text) && /\b(?:write|draft|compose|create|build|make|prepare|design|give|provide|suggest|fix|correct)\b/i.test(text)) {
    return { intent: 'write', confidence: 0.85, modeHint: 'chat' };
  }
  // Guard: coding nouns must NOT match the write rule — "write a function for"
  // or "write a test for" are dev tasks, not creative content. These nouns
  // fall through to matchCreateRule so the coding pipeline runs.
  if (codingNoun.test(text)) return null;
  // Verb + article + writing object: "write an essay on elephants for class 4",
  // "design a flow chart", "create a mind map".
  if (
    /^(?:please\s+)?(?:write|build|make|create|draft|compose|prepare|design|draw|sketch)\s+(?:a|an|the|new|my|our)\s+/i.test(
      text,
    ) &&
    writingObject.test(text)
  ) {
    return { intent: 'write', confidence: 0.85, modeHint: 'chat' };
  }
  // Writing verb + writing object anywhere: "please write a poem for my daughter",
  // "design a poster for the event".
  if (/\b(?:write|draft|compose|design|draw|sketch)\b/i.test(text) && writingObject.test(text)) {
    return { intent: 'write', confidence: 0.8, modeHint: 'chat' };
  }
  return null;
}

/**
 * Create/build → dev. Requires a verb-initial command or a project-object noun
 * so "the build failed" (build as noun) and "make sure tests pass" never
 * false-positive into developer mode.
 */
export function matchCreateRule(text: string): IntentResult | null {
  // GUARD FIRST: document/creative nouns must NOT match the create rule —
  // "create a mind map", "make a wireframe", "create a song" are DOCUMENT
  // creation tasks, not coding. These should route to write (chat mode) so
  // the LLM generates the document, not the coding pipeline.
  const documentNoun =
    /\b(?:poster|diagram|flowchart|flow.?chart|wireframe|mind.?map|mindmap|chart|infographic|brochure|flyer|pamphlet|newsletter|report|presentation|slideshow|mockup|blueprint|sketch|outline|song|poem|story|essay|letter|article|speech|caption|logo)\b/i;
  if (documentNoun.test(text)) return null;
  // Content artifacts (a teaching/fitness/diet plan, a routine, a schedule, a
  // class test/worksheet) are never a software deliverable — the write rule
  // answers them first; this is the belt-and-braces guard for an ask with no
  // explicit write verb.
  if (isContentArtifactAsk(text)) return null;
  // GUARD: "set up my groq key" is a configure task, not a create task.
  if (/\b(?:api ?key|auth key|secret key|access key|private key|encryption key)\b/i.test(text)) return null;
  if (/\b(?:set(?:\s+up)?|update|change|switch)\s+(?:my|the)?\s*\w*\s*(?:key|token|credential)s?\b/i.test(text)) return null;
  // Verb-initial, unambiguous commands: "create a CLI tool", "implement JWT auth",
  // "deploy the app", "test the API", "run the build".
  if (
    /^(?:please\s+|can you\s+|could you\s+|would you\s+|i need you to\s+|help me\s+)?(?:create|generate|implement|scaffold|bootstrap|develop|set up|deploy|test|run|publish|ship|launch|refactor|migrate|integrate|optimize|restructure|install|configure)\b/i.test(
      text,
    )
  ) {
    return { intent: 'create', confidence: 0.9, modeHint: 'dev' };
  }
  // Verb + article: "write a test", "build an api", "add a route". "add" is
  // here (and in the object-noun branch below) — NOT in the verb-initial list
  // — so the common developer phrasing "add auth to the app" routes to dev
  // mode while "add 2 + 2" (no article, no project noun) never false-positives.
  // GUARD (observed live: "Write a song in hindi … for my daughter" hit this
  // branch and spun up the developer pipeline): when the OBJECT is explicitly
  // creative (a person-centric/creative frame — "for my daughter", "about
  // love", a language of expression), the ask is content, not code. The
  // pipeline must never run for it — matchWriteRule's artifact list can never
  // cover every creative noun (song, lullaby, rap, …).
  const articleMatch = /^(?:please\s+)?(?:build|write|make|add)\s+(?:a|an|the|new)\s+/i.exec(text);
  if (articleMatch) {
    const creativeFrame =
      /\bfor (?:my|his|her|our)\b/i.test(text) ||
      /\babout (?:love|life|friendship|family|her|him|them|us|my|his)\b/i.test(text) ||
      /\bin (?:hindi|english|spanish|french|tamil|telugu|bengali|marathi|urdu|punjabi|gujarati|kannada|malayalam)\b/i.test(text);
    if (!creativeFrame) {
      return { intent: 'create', confidence: 0.85, modeHint: 'dev' };
    }
    return { intent: 'write', confidence: 0.8, modeHint: 'chat' };
  }
  // Verb + project-object noun anywhere: "I want to create a new module",
  // "write a test for the login function".
  const objectNoun =
    /\b(?:file|program|script|app(?:lication)?|function|class|module|component|page|screen|form|dialog|modal|banner|route|api|endpoint|service|cli|tool|package|library|project|plugin|addon|extension|website|server|client|database|schema|feature|daemon|worker|test|interface|handler|controller|middleware|migration|seed|fixture|config)\b/i;
  if (
    (/\b(?:create|generate|implement|scaffold|develop|add)\b/i.test(text) ||
      /\b(?:build|write|set up)\b/i.test(text)) &&
    objectNoun.test(text)
  ) {
    return { intent: 'create', confidence: 0.85, modeHint: 'dev' };
  }
  return null;
}

// ─── Temporal extraction ────────────────────────────────────────────────────

/**
 * Extract the first temporal reference from text via the Microsoft recognizer
 * (MIT, pure JS, no network). Returns undefined when none is found.
 * The reference date is injectable for deterministic tests.
 */
export function extractTimeRange(text: string, referenceDate: Date = new Date()): TimeRange | undefined {
  try {
    const matches = recognizeDateTime(text, Culture.English, undefined, referenceDate);
    const first = matches[0];
    if (!first) return undefined;
    const value = first.resolution?.values?.[0];
    const range: TimeRange = { text: first.text };
    if (value?.timex) range.timex = value.timex;
    if (value?.type === 'daterange' && value.start && value.end) {
      range.start = value.start;
      range.end = value.end;
    } else if (value?.value) {
      range.start = value.value;
    } else if (value?.start) {
      range.start = value.start;
    }
    return range;
  } catch {
    // The recognizer must never break classification — C2 will verify.
    return undefined;
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Classify a user request deterministically.
 *
 * Priority order: explain → continue → fix → configure → write → create.
 * Interrogatives win first so "explain how to build X" is a chat question, not
 * a dev command; "continue" wins over "build" so "continue building the app"
 * resumes recall; writing artifacts (essay/poem/story/…) route to chat, never
 * the coding pipeline (S4). Unknown inputs return `{ intent: 'unknown',
 * confidence: 0 }` — never a guess.
 */
export function classifyIntent(text: string, referenceDate: Date = new Date()): IntentResult {
  const trimmed = text.trim();
  if (!trimmed) return { intent: 'unknown', confidence: 0, modeHint: null };

  return (
    matchExplainRule(trimmed) ??
    matchContinueRule(trimmed, referenceDate) ??
    matchFixRule(trimmed) ??
    matchConfigureRule(trimmed) ??
    matchWriteRule(trimmed) ??
    matchCreateRule(trimmed) ??
    { intent: 'unknown', confidence: 0, modeHint: null }
  );
}
