/**
 * Workspace guard — refuse to guess a working directory.
 *
 * The dashboard's chat turns run against a DIRECTORY. When the user attaches a
 * project the turn is scoped to it. When they do NOT, the turn used to inherit
 * the dashboard server process's own working directory — so on a service started
 * from the home folder, "assess this project" listed `~`, found some unrelated
 * checkout sitting there, and assessed THAT. The user saw it as "it went to
 * kuttaaddon": a real, conversational-sounding answer about a project they never
 * mentioned, which is worse than an error.
 *
 * This module answers ONE question — "does this ask need a workspace?" — so the
 * server can ask the user to attach a folder instead of silently picking one.
 *
 * The check is deliberately NARROW. Chat is general-purpose: "write a haiku",
 * "what's a monad", "summarise this text I pasted" must all keep working with no
 * folder attached. Only asks that name a PROJECT, or that produce/consume files
 * on disk, are gated.
 *
 * A second, equally important half was added after a report (2026-10-06): an
 * ask that merely DESCRIBES work — a test scenario, a prompt, a spec, a project
 * idea, "I want to test an agent on X" — is TEXT, and is answered inline even
 * though it is full of development vocabulary. Gating it was the bug the user
 * summarised as "intelligence is completely missing" about when a folder is
 * required. See {@link isMetaOrTextAsk}.
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
 * Exported for the tests and for the server's single call site — the rule lives
 * in one place so the message and the decision can never drift.
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
  if (
    PROJECT_WORK_RE.test(text) &&
    /\b(?:project|repo|repository|codebase|code\s?base|workspace|source|backend|frontend|api|server|cli|app|application|service|package|monorepo|tests?|suite|branch|dependencies)\b/i.test(text)
  ) {
    return true;
  }
  return false;
}

/**
 * What the user sees instead of a wrong answer.
 *
 * It names the specific failure ("I picked a folder you didn't ask about") and
 * the two ways forward, and it offers suggestions that are actual next actions —
 * a refusal with no way out just looks like the agent broke.
 */
export function projectAttachmentPrompt(): string {
  return [
    "📁 **I need a project folder before I can do that.**",
    '',
    'No folder is attached to this chat, so I have no workspace to look at — and I will not',
    'guess one. Guessing is how "assess this project" ends up describing whatever unrelated',
    'folder sits in my own working directory.',
    '',
    '**Attach the folder you mean, then send the message again:**',
    '1. In the chat composer, find the **Select Project Folder** box (above the message box).',
    '2. Click **🗂️ Browse** and navigate to your project, then click **Attach** — or paste the',
    '   folder\'s absolute path (e.g. `/Users/you/Documents/my-app`) into that box and click **Attach**.',
    '',
    'On some systems your browser then shows a permission prompt for that folder — click **Allow**,',
    'and the folder is attached to this chat. (You can **✕ detach** it any time.)',
    '',
    'Once a folder is attached, every turn in this chat is scoped to it.',
    '',
    '_Tip for operators: set a default working directory in **Admin → Provider Configuration →',
    'Workspace** so unattached turns run somewhere you chose instead of the server\'s own cwd._',
  ].join('\n');
}

/** The followups offered with the refusal — real next actions, not filler. */
export function projectAttachmentFollowups(): Array<{ label: string; prompt: string }> {
  return [
    { label: 'How do I attach a folder?', prompt: 'How do I attach a project folder?' },
    { label: 'Browse the picker for me', prompt: 'Open the project folder picker.' },
  ];
}
