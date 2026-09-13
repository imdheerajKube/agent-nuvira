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
/** Rule confidence above which the rule path is trusted (C2 only below this). */
export const RULE_TRUST_THRESHOLD = 0.8;
// ─── Pure rule matchers ─────────────────────────────────────────────────────
// Every rule is a pure function with a unit test; each returns a full match or
// null so `classifyIntent` is a plain priority walk — no shared state.
/** Explain/interrogative → chat ("explain caching", "how do I add JWT auth?"). */
export function matchExplainRule(text) {
    // Guard: "can you fix X" or "could you debug Y" is a FIX request, not a
    // question. The fix rule runs later in priority, but the explain rule's
    // When a coding verb appears in COMMAND position (start or after polite
    // prefix), it's a task request, not a question. "evaluate the test coverage"
    // has "test" as a NOUN — must not block. "can you deploy the api?" has
    // "deploy" in command position — must block (it's a task, not a question).
    const codingTaskVerb = /^(?:please\s+|can you\s+|could you\s+|would you\s+|i need you to\s+|help me\s+)?(?:fix|debug|repair|troubleshoot|resolve|patch|address|diagnose|correct|create|build|implement|generate|scaffold|bootstrap|develop|set up|deploy|test|run|publish|ship|launch|refactor|migrate|integrate|optimize|restructure|install)\b/i;
    const fixAsNoun = /(?:the|a|an|this|that|any)\s+fix\b/i.test(text);
    if (codingTaskVerb.test(text) && !fixAsNoun)
        return null;
    if (/\b(?:explain|describe|assess|evaluate|analyze|compare|walk me through|tell me about)\b/i.test(text) ||
        /^(?:what|how|why|when|where|which|can you|could you|would you)\b/i.test(text) ||
        /\b(?:vs\.?|versus|or|compared to|difference between)\b/i.test(text)) {
        return { intent: 'explain', confidence: 0.8, modeHint: 'chat' };
    }
    return null;
}
/**
 * Continue/resume → recall, with a temporal timeRange when the text carries one
 * ("continue last week's ecommerce plan" → timeRange for last week).
 * The reference date is injectable for deterministic tests.
 */
export function matchContinueRule(text, referenceDate = new Date()) {
    if (/\b(?:continue|resume|pick ?up|keep going|carry on|left off|start from where|go back to)\b/i.test(text)) {
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
export function matchFixRule(text) {
    if (/(?:^|[^\w-])(?:fix|debug|repair|troubleshoot|resolve|patch|address|diagnose|correct)(?:$|[^\w-])/i.test(text)) {
        return { intent: 'fix', confidence: 0.85, modeHint: 'execute' };
    }
    // "X is broken", "X keeps failing", "X stopped working" — implicit fix tasks.
    // "X failed" — standalone failure signal ("the build failed").
    // GUARD: "why is the test failing?" is a QUESTION, not a fix request.
    if (/^(?:what|how|why|when|where|which)\b/i.test(text))
        return null;
    if (/\b(?:is|are|was|were|keeps?|kept|stopped|has stopped)\s+(?:broken|failing|crashing|erroring|not working|working|dead)\b/i.test(text)) {
        return { intent: 'fix', confidence: 0.8, modeHint: 'execute' };
    }
    if (/\bfailed\b/i.test(text)) {
        return { intent: 'fix', confidence: 0.8, modeHint: 'execute' };
    }
    return null;
}
/** Configure → config ("configure the gemini api key", "switch provider"). */
export function matchConfigureRule(text) {
    // Guard: a CREATE request whose object happens to be a "config" ("create a
    // config file") must reach the create rule, not configure. Config wins only
    // when the sentence does NOT lead with a create verb.
    if (/^(?:please\s+)?(?:create|generate|write|build|make)\b/i.test(text))
        return null;
    if (/\b(?:configure|config(?:ure)?|settings?)\b/i.test(text) ||
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
 * Write/creative → chat (S4). "Write an essay/poem/story/letter/article/…" is
 * a CONTENT request — a direct chat answer, NEVER the coding pipeline (the
 * observed failure: "write an essay" was classified create → the no-model
 * fallback spun up the full multi-agent pipeline for a zero-code task). The
 * model still sees the build/analyze/… tools in the loop and can call them if
 * the request actually needs code — the action only governs the no-model
 * fallback + the routing hint. Runs BEFORE matchCreateRule so "write a test"
 * (test is not a writing artifact) still resolves to create.
 */
export function matchWriteRule(text) {
    // Songs/hymns/bha_jans/shayari were missing (observed live: "Write a song in
    // hindi … for my daughter" routed to the DEVELOPER pipeline). Keep the
    // explicit list (fast, precise) but treat it as an allowlist WITH a
    // fallback, not the only path.
    const writingObject = /\b(?:essay|poem|poetry|song|lyrics|hymn|anthem|shayari|ghazal|jingle|lullaby|rap|haiku|sonnet|ode|elegy|story|short story|fiction|fantasy|novel|biography|memoir|tale|fable|myth|legend|recipe|letter|article|blog(?: post)?|paragraph|composition|dialogue|screenplay|script|play|skit|monologue|speech|caption|advertisement|review|summary|prose|note|message|email|homework|assignment|poster|diagram|flowchart|flow.?chart|wireframe|mind.?map|chart|infographic|brochure|flyer|pamphlet|newsletter|report|presentation|slideshow|mockup|blueprint|layout|sketch|outline|mindmap)\b/i;
    // Coding nouns that must NOT match the write rule — "write a function for"
    // or "write a test for" are dev tasks, not creative content. These nouns
    // fall through to matchCreateRule so the coding pipeline runs. "class"
    // excluded: "class 4 student" is a grade level, not a coding class.
    const codingNoun = /\b(?:function|module|component|api|endpoint|route|server|database|cli|tool|service|program|script|app(?:lication)?|worker|daemon|plugin|package|library|project|schema)\b/i;
    // Guard: coding nouns must NOT match the write rule — "write a function for"
    // or "write a test for" are dev tasks, not creative content. These nouns
    // fall through to matchCreateRule so the coding pipeline runs.
    if (codingNoun.test(text))
        return null;
    // Verb + article + writing object: "write an essay on elephants for class 4",
    // "design a flow chart", "create a mind map".
    if (/^(?:please\s+)?(?:write|build|make|create|draft|compose|prepare|design|draw|sketch)\s+(?:a|an|the|new|my|our)\s+/i.test(text) &&
        writingObject.test(text)) {
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
export function matchCreateRule(text) {
    // GUARD FIRST: document/creative nouns must NOT match the create rule —
    // "create a mind map", "make a wireframe", "create a song" are DOCUMENT
    // creation tasks, not coding. These should route to write (chat mode) so
    // the LLM generates the document, not the coding pipeline.
    const documentNoun = /\b(?:poster|diagram|flowchart|flow.?chart|wireframe|mind.?map|mindmap|chart|infographic|brochure|flyer|pamphlet|newsletter|report|presentation|slideshow|mockup|blueprint|sketch|outline|song|poem|story|essay|letter|article|speech|caption|logo)\b/i;
    if (documentNoun.test(text))
        return null;
    // GUARD: "set up my groq key" is a configure task, not a create task.
    if (/\b(?:api ?key|auth key|secret key|access key|private key|encryption key)\b/i.test(text))
        return null;
    if (/\b(?:set(?:\s+up)?|update|change|switch)\s+(?:my|the)?\s*\w*\s*(?:key|token|credential)s?\b/i.test(text))
        return null;
    // Verb-initial, unambiguous commands: "create a CLI tool", "implement JWT auth",
    // "deploy the app", "test the API", "run the build".
    if (/^(?:please\s+|can you\s+|could you\s+|would you\s+|i need you to\s+|help me\s+)?(?:create|generate|implement|scaffold|bootstrap|develop|set up|deploy|test|run|publish|ship|launch|refactor|migrate|integrate|optimize|restructure|install|configure)\b/i.test(text)) {
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
        const creativeFrame = /\bfor (?:my|his|her|our)\b/i.test(text) ||
            /\babout (?:love|life|friendship|family|her|him|them|us|my|his)\b/i.test(text) ||
            /\bin (?:hindi|english|spanish|french|tamil|telugu|bengali|marathi|urdu|punjabi|gujarati|kannada|malayalam)\b/i.test(text);
        if (!creativeFrame) {
            return { intent: 'create', confidence: 0.85, modeHint: 'dev' };
        }
        return { intent: 'write', confidence: 0.8, modeHint: 'chat' };
    }
    // Verb + project-object noun anywhere: "I want to create a new module",
    // "write a test for the login function".
    const objectNoun = /\b(?:file|program|script|app(?:lication)?|function|class|module|component|page|screen|form|dialog|modal|banner|route|api|endpoint|service|cli|tool|package|library|project|plugin|addon|extension|website|server|client|database|schema|feature|daemon|worker|test|interface|handler|controller|middleware|migration|seed|fixture|config)\b/i;
    if ((/\b(?:create|generate|implement|scaffold|develop|add)\b/i.test(text) ||
        /\b(?:build|write|set up)\b/i.test(text)) &&
        objectNoun.test(text)) {
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
export function extractTimeRange(text, referenceDate = new Date()) {
    try {
        const matches = recognizeDateTime(text, Culture.English, undefined, referenceDate);
        const first = matches[0];
        if (!first)
            return undefined;
        const value = first.resolution?.values?.[0];
        const range = { text: first.text };
        if (value?.timex)
            range.timex = value.timex;
        if (value?.type === 'daterange' && value.start && value.end) {
            range.start = value.start;
            range.end = value.end;
        }
        else if (value?.value) {
            range.start = value.value;
        }
        else if (value?.start) {
            range.start = value.start;
        }
        return range;
    }
    catch {
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
export function classifyIntent(text, referenceDate = new Date()) {
    const trimmed = text.trim();
    if (!trimmed)
        return { intent: 'unknown', confidence: 0, modeHint: null };
    return (matchExplainRule(trimmed) ??
        matchContinueRule(trimmed, referenceDate) ??
        matchFixRule(trimmed) ??
        matchConfigureRule(trimmed) ??
        matchWriteRule(trimmed) ??
        matchCreateRule(trimmed) ??
        { intent: 'unknown', confidence: 0, modeHint: null });
}
//# sourceMappingURL=intent.js.map