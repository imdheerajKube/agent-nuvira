/**
 * Does this ask need a workspace, and what does it need one FOR? — the rule,
 * shared by every surface.
 *
 * WHY IT LIVES IN `utils/`. The rule started in `web-dashboard/workspace-guard.ts`
 * because the dashboard was the first surface to refuse to guess a working
 * directory: a chat turn with no folder inherited the SERVER PROCESS's cwd, so a
 * service started from the home folder answered "assess this project" by
 * describing whatever unrelated checkout sat in `~` — reported as "it went to
 * kuttaaddon". Every surface now needs the same rule (the dashboard to resolve a
 * workspace, the CLI's tool context, the messaging gateway, `ask_user` adopting a
 * folder named in a reply), and `src/gateway`/`src/tools` must not depend on the
 * dashboard — the same reason `utils/workspace-path.ts` exists. The dashboard's
 * own module re-exports these, so its wording and its call sites are unchanged.
 *
 * The rule is deliberately NARROW. Chat is general-purpose: "write a haiku",
 * "what's a monad", "summarise this text I pasted" must all keep working with no
 * folder attached. Only asks that name a PROJECT, or that produce/consume files
 * on disk, are gated.
 *
 * A second half was added after a report (2026-10-06): an ask that merely
 * DESCRIBES work — a test scenario, a prompt, a spec, a project idea, "I want to
 * test an agent on X" — is TEXT, and is answered inline even though it is full of
 * development vocabulary. Gating it was the bug the user summarised as
 * "intelligence is completely missing" about when a folder is required.
 *
 * The third half is {@link workspaceNeedForMissingFolder}: deciding WHETHER a
 * folder is needed is not enough once a surface can resolve one. A produce ask
 * can be served by a TEMPORARY folder; a read ask cannot, and must still ask.
 */

/**
 * Asks that clearly target "the project/codebase" the reader is supposedly
 * looking at — the phrase that started this: "assess this project".
 */
const PROJECT_REFERENCE_RE =
  /\b(?:this|the|my|our|current)\s+(?:project|repo|repository|codebase|code\s?base|workspace|app|application|code|folder|directory|solution)\b/i;

/** Project work: assess / review / refactor / fix / debug / test / build / audit… */
const PROJECT_WORK_RE =
  /\b(?:assess|assessment|review|audit|analyse|analyze|evaluate|inspect|examine|explore|refactor|debug|diagnose|fix|repair|migrate|upgrade|optimi[sz]e|document|test|build|compile|lint|typecheck|type-?check|run\s+the\s+tests?|set\s?up|scaffold|bootstrap)\b/i;

/** A project-ish noun that pairs with {@link PROJECT_WORK_RE}. */
const PROJECT_NOUN_RE =
  /\b(?:project|repo|repository|codebase|code\s?base|workspace|source|backend|frontend|api|server|cli|app|application|service|package|monorepo|tests?|suite|branch|dependencies)\b/i;

/**
 * Filesystem deliverables: making or changing files on disk. These need a
 * directory to land in whether or not the ask says "project".
 *
 * NOTE the nouns are artifacts that exist ON DISK. `class` was removed after it
 * matched a school sense: "write an essay … for **class** 4" was read as
 * "write a code class" and gated behind a folder prompt it did not need. A bare
 * "class" is inherently ambiguous — code vs. school — so it is not evidence a
 * directory is required.
 */
const FILESYSTEM_TASK_RE =
  /\b(?:create|write|make|add|generate|produce|build|edit|modify|update|patch|rename|move|delete|remove|save|export|append)\b[^.!?\n]{0,60}\b(?:file|files|folder|folders|directory|directories|script|module|component|document|markdown|readme|report|image|picture|photo|logo|diagram|chart|plot|icon|screenshot|video|audio)\b/i;

/**
 * INLINE PROSE deliverables — an essay, a poem, a story, a letter. General
 * chat produces these in the reply with no workspace at all, so they must never
 * be gated, even when the request incidentally contains a code-ish word
 * ("an essay on elephants for a **class** 4 student") or a file-ish noun
 * ("write a **summary**").
 *
 * This is the user-reported false positive: after being asked to attach a folder
 * once, an essay question was refused for the same reason, which read as the
 * agent having stopped listening. Only an EXPLICIT file artifact (a named file,
 * `.md`, a folder, a directory) overrides this and keeps the ask gated.
 */
const INLINE_PROSE_RE =
  /\b(?:write|compose|draft|create|make|produce|prepare)\b[^.!?\n]{0,40}\b(?:essay|poem|story|haiku|paragraph|letter|email|article|speech|assignment|homework|answer|explanation|description|summary|short\s+note|blurb|bio|memo)\b/i;

/** An explicit on-disk artifact — the only thing that overrides INLINE_PROSE_RE. */
const EXPLICIT_FILE_RE =
  /\b(?:file|files|folder|folders|directory|directories|path|\.md\b|\.txt\b|\.json\b|\.csv\b|\.docx?\b|\.pdf\b|readme|document)\b/i;

/**
 * A producing verb aimed at an explicit on-disk artifact ("save it as poem.txt",
 * "write the essay to essay.md"). This is what makes a PROSE deliverable a
 * workspace task after all — the write target is a file, not the reply.
 */
const FILE_PRODUCING_RE =
  /\b(?:write|create|save|export|produce|generate|make|draft|compose|append)\b[^.!?\n]{0,40}\b(?:file|folder|directory|path|\.md\b|\.txt\b|\.json\b|\.csv\b|\.docx?\b|\.pdf\b)\b/i;

/** Media generation, phrased as a verb on the media itself ("generate an image"). */
const MEDIA_TASK_RE =
  /\b(?:generate|create|make|draw|render|design|produce)\b[^.!?\n]{0,40}\b(?:an?\s+)?(?:image|picture|photo|logo|diagram|chart|plot|icon|illustration|artwork|banner|thumbnail|video|audio|voiceover)\b/i;

// ─── META / INSTRUCTIONAL asks ──────────────────────────────────────────────
//
// The user is asking for a DESCRIPTION of work rather than the work itself: a
// test scenario, a prompt, a spec, a project idea, a capability challenge. The
// development vocabulary inside those asks names the SUBJECT, not the action,
// so no workspace is required — even when a producing verb appears ("…build the
// application…").
//
// THIS IS THE REPORTED BUG (2026-10-06). A user asked the dashboard chat to
// produce a project they could use to TEST an agent on a large, phased
// capability (planning → development → testing → docs → tool installs → build
// → git). The guard read "build the application" — a producing verb on a
// project noun — and refused with the folder prompt. The clarification "this
// is not a development ask - i need text" was refused IDENTICALLY, because the
// guard never looked at the FRAME of the request, only at the verbs and nouns
// buried inside it. The user's summary: "intelligence is completely missing"
// around when a folder is required and when it is not.

/**
 * "I want to test an agent on … capability" — the ask is about evaluating the
 * agent, which is answered with text (a scenario/spec), never by opening a
 * folder. Requires an intent-to-test frame so a bare "test my agent's code"
 * (which may well mean an attached checkout) is not swept up.
 */
const META_AGENT_TEST_RE =
  /\b(?:want|need|plan(?:ning)?|intend|would\s+like|trying|going|help(?:\s+me)?|how\s+to|how\s+do\s+i|i\s+am|i'?m)\b[^.!?\n]{0,40}\b(?:test|testing|evaluate|evaluating|benchmark(?:ing)?|assess(?:ing)?|challenge|validate|stress[- ]?test)\b[^.!?\n]{0,50}\b(?:an?|the|my|our|your)\s+(?:ai\s+|coding\s+|development\s+|software\s+|autonomous\s+)?agents?\b/i;

/** "give me a test scenario / a prompt / a spec / a project idea" — a content deliverable, answered inline. */
const REQUEST_FOR_SCENARIO_RE =
  /\b(?:give|provide|suggest|design|create|write|draft|generate|propose|come\s+up\s+with|share|need|want)\b[^.!?\n]{0,30}\b(?:prompt|scenario|test\s+case|test\s+plan|test\s+suite|benchmark|spec|specification|project\s+idea|project\s+spec|example\s+project|sample\s+project|use\s+case|exercise|task\s+description|evaluation\s+rubric|rubric)\b/i;

/** "a project which will require this" — an indefinite, hypothetical project, not a folder the user points at. */
const HYPOTHETICAL_PROJECT_RE =
  /\b(?:a|some|any)\s+(?:project|app|application|system|tool|service|repo(?:sitory)?|codebase)\b[^.!?\n]{0,40}\b(?:that|which)\b[^.!?\n]{0,40}\b(?:requires?|would\s+require|will\s+require|needs?|would\s+need|involves?|entails?|would\s+involve)\b/i;

/** An explicit statement that the user wants TEXT, not code — decisive on its own. */
const TEXT_ONLY_RE =
  /\b(?:i\s+(?:just\s+)?need(?:ed)?\s+(?:the\s+)?text|just\s+the\s+text|only\s+(?:the\s+)?text|text\s+only|no\s+code|without\s+(?:any\s+)?code|need\s+text|not\s+a\s+(?:development|coding|code|software|programming)\s+(?:ask|task|request|question|exercise|work)|this\s+is\s+not\s+a\s+development|no\s+development\s+needed|nothing\s+to\s+(?:build|code|develop|implement))\b/i;

/**
 * A reference to a REAL workspace the user points AT ("this project", "our
 * repo"). When present the ask is about a folder, so the meta rules stand down
 * — "test this project" is still a workspace ask.
 */
const DEICTIC_WORKSPACE_RE =
  /\b(?:this|my|our|the\s+current|current)\s+(?:project|repo|repository|codebase|code\s?base|workspace|solution)\b/i;

/**
 * True when this ask only DESCRIBES work — a scenario, spec, prompt, capability
 * challenge, or a plain request for text — rather than asking to perform it.
 *
 * Order matters: an explicit on-disk artifact always wins ("write the scenario
 * to scenario.md" is a workspace ask), then an explicit "I need text" wins over
 * a deictic mention (the user's own clarification said "this project" while
 * explicitly asking for text), then a deictic workspace reference otherwise
 * vetoes the meta rules.
 */
function isMetaOrTextAsk(text: string): boolean {
  if (EXPLICIT_FILE_RE.test(text)) return false;
  if (TEXT_ONLY_RE.test(text)) return true;
  if (DEICTIC_WORKSPACE_RE.test(text)) return false;
  return (
    META_AGENT_TEST_RE.test(text) ||
    REQUEST_FOR_SCENARIO_RE.test(text) ||
    HYPOTHETICAL_PROJECT_RE.test(text)
  );
}

/**
 * True when this ask needs a workspace it does not have.
 *
 * The single decision about WHETHER a folder is required, so the message and the
 * decision can never drift. {@link workspaceNeedForMissingFolder} builds on it to
 * say what the folder is for.
 */
export function needsProjectAttachment(message: string): boolean {
  const text = (message ?? '').trim();
  if (!text) return false;
  // A URL or an absolute path names its own subject — the user is being
  // specific, so asking them to "attach a folder" would be noise.
  if (/(?:^|[\s("'`])(?:\/|~\/|https?:\/\/|www\.)/.test(text)) return false;
  // A prose deliverable is answered inline; only an explicit file artifact in
  // the same message makes it a workspace task. Checked BEFORE the project/work
  // rules so an incidental code-ish noun cannot gate an essay or a poem.
  if (INLINE_PROSE_RE.test(text) && !EXPLICIT_FILE_RE.test(text)) return false;
  // A META ask describes work instead of doing it — a test scenario, a prompt,
  // a spec, a project idea, or plainly "I need text". The development words in
  // it name the SUBJECT, so answer inline rather than demanding a folder. This
  // is the fix for the reported "test an agent on <capability>" refusal.
  if (isMetaOrTextAsk(text)) return false;
  // A named file target means it lands on disk even if the content is prose.
  if (FILE_PRODUCING_RE.test(text)) return true;
  if (PROJECT_REFERENCE_RE.test(text)) return true;
  if (FILESYSTEM_TASK_RE.test(text)) return true;
  if (MEDIA_TASK_RE.test(text)) return true;
  // Project WORK plus a project-ish noun anywhere ("review the backend code").
  if (PROJECT_WORK_RE.test(text) && PROJECT_NOUN_RE.test(text)) return true;
  return false;
}

/**
 * What an ask that has no workspace actually NEEDS one for.
 *
 * `null`      — no folder is required at all (plain chat);
 * `'produce'` — a place to PUT new work. An empty temporary folder serves this,
 *               which is what makes "create a script" answerable without
 *               dead-ending on a folder prompt;
 * `'read'`    — an existing tree to read or change ("assess this project", "fix
 *               the bug in src/app.ts"). NO temporary folder can serve this, and
 *               pretending otherwise is the silent-wrong-tree defect this rule
 *               exists to prevent — so those asks keep their folder prompt.
 *
 * WHY THE TWO HALVES ARE SEPARATE. `needsProjectAttachment` answers "does this
 * ask need a workspace?" and its answer is used by a hard refusal. This one says
 * what the workspace is FOR, so the surface can resolve one instead of refusing:
 * a produce ask gets a scratch folder plus a notice "this is temporary, here is
 * the path, say where you want it", and only a read ask still asks the user. The
 * dashboard's reported misery ("agent keep going mad and confused when project
 * folder not attached") was both halves being treated alike.
 */
export type MissingWorkspaceNeed = 'read' | 'produce' | null;

/**
 * A creation verb aimed at an artifact the agent can CREATE from nothing.
 *
 * The verbs are the create half of {@link FILESYSTEM_TASK_RE} (nothing here is
 * an edit — "fix", "update" and "refactor" all require something to already
 * exist, so they belong to the read half). The nouns are the artifact kinds a
 * fresh folder can legitimately hold, including the project-shaped ones a user
 * asks for by name ("create a react app").
 */
const CREATE_ARTIFACT_RE =
  /\b(?:create|write|make|add|generate|produce|build|save|export|append|draw|render|design|draft|compose)\b[^.!?\n]{0,60}\b(?:file|files|folder|folders|directory|directories|script|program|module|component|document|doc|docs|markdown|readme|report|guide|note|notes|text|table|spreadsheet|json|csv|md|txt|pdf|html|css|image|picture|photo|logo|diagram|chart|plot|icon|screenshot|video|audio|poem|essay|story|letter|post|article|app|application|website|site|webpage|web\s?page|service|api|endpoint|server|cli|tool|game|bot)\b/i;

/**
 * Decide what this ask needs, for a turn that has no workspace.
 *
 * The order is the whole design, and it is conservative where it must be:
 *
 *   0. The VETOES come first, and they are the same ones `needsProjectAttachment`
 *      applies: a prose deliverable and a META ask ("I want to test an agent on
 *      build the application") are answered in TEXT and need no folder at all.
 *      Skipping this step is how "build the application" inside a capability
 *      description got a folder request — the reported "intelligence is
 *      completely missing" bug, in the first draft of this very function. → `null`.
 *   1. A reference to work that ALREADY EXISTS ("this project", "our repo", "the
 *      app") outranks a creation verb — "create the project structure for a
 *      booking app" still names a project, and answering it in a temporary
 *      folder is the kuttaaddon defect in a new costume. → `'read'`.
 *   2. Otherwise a create-shaped ask (a creation verb on an artifact noun, a
 *      producing verb aimed at an explicit file, or media generation) can be
 *      served by a temporary folder. → `'produce'`.
 *   3. Otherwise fall back to the guard's own verdict: if it needs a folder and
 *      no creation verb explains why, it needs the real tree. → `'read'`.
 *   4. Otherwise the ask needs nothing. → `null`, and the surface behaves exactly
 *      as it did before scratch existed.
 */
export function workspaceNeedForMissingFolder(message: string): MissingWorkspaceNeed {
  const text = (message ?? '').trim();
  if (!text) return null;
  // A URL or an absolute path names its own subject (and the caller resolves the
  // path itself — see `directoryFromMessage`), so this rule must not fire.
  if (/(?:^|[\s("'`])(?:\/|~\/|https?:\/\/|www\.)/.test(text)) return null;
  // 0 — the text/meta vetoes, BEFORE the project and create rules below, because a
  // description of work must never be answered with a folder request or a scratch
  // folder. These are `needsProjectAttachment`'s own first two checks, in its own
  // order, so the two functions cannot disagree about what is even eligible.
  if (INLINE_PROSE_RE.test(text) && !EXPLICIT_FILE_RE.test(text)) return null;
  if (isMetaOrTextAsk(text)) return null;
  if (PROJECT_REFERENCE_RE.test(text)) return 'read';
  if (FILE_PRODUCING_RE.test(text) || MEDIA_TASK_RE.test(text) || CREATE_ARTIFACT_RE.test(text)) {
    return 'produce';
  }
  return needsProjectAttachment(text) ? 'read' : null;
}
