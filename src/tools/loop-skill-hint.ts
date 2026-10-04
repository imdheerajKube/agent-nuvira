/**
 * Loop skill hint (`src/tools/loop-skill-hint.ts`) — AGENTIC_CAPABILITY_ASSESSMENT
 * Addendum v4 Phase 3.2: "The loop never hears about the orchestrator's skill
 * layer: the pipeline consults SkillStore.findMatch + the hub catalog before
 * planning and injects the matched methodology, but a chat/execute-loop goal
 * starts with zero knowledge that a first-party playbook exists."
 *
 * This module closes that parity gap DETERMINISTICALLY (no LLM call): given
 * the user's goal, it finds the best available skill the SAME way the
 * orchestrator does —
 *
 *   1. compiled SkillStore.findMatch (the first-party capability batch),
 *   2. the hub catalog (findHubSkillMatch — installed SKILL.md skills),
 *
 * then returns a system-prompt block that hands the model the skill's
 * methodology with an EXPLICIT escape hatch ("this is a recommendation —
 * ignore it when it does not fit") and the exact load syntax
 * (`skill` tool, {"skill":"<name>"}).
 *
 * Why an evidence filter on top of findMatch: the compiled store's threshold
 * is intentionally low (score >= 1, "manual discovery") and its scoring adds
 * a quality/usage bonus to EVERY skill — so a goal merely containing a generic
 * pattern word ("goal", "task") can false-positive. The chat loop runs on
 * EVERY message (not just pipeline goals), so the loop hint requires REAL
 * goal evidence: a name-word or tag hit, or two pattern-word hits. The
 * orchestrator does not need this (its planner only sees pipeline goals); the
 * hub catalog's own scoring is keyword-based and needs no filter.
 *
 * Safety rails (mirroring the orchestrator's injection contract):
 *   - skills.disabled[] gate — a dashboard/CLI-disabled skill is NEVER
 *     injected (the same "the toggle is never cosmetic" rule the match gates
 *     enforce elsewhere).
 *   - Website-deploy activation gate — the orchestrator requires
 *     hosting-specific intent before injecting website methodology; the loop
 *     hint applies the identical regex so "deploy the API" does not drag in
 *     static-site deployment steps.
 *   - Side-effect-free matching: the match itself marks nothing; usage is
 *     marked ONCE via markLoopSkillUsed by the caller (skillView()'s internal
 *     markUsed is deliberately avoided so the hint builder is idempotent).
 *   - Bounded injection: at most ONE methodology block per prompt, and the
 *     methodology text itself is capped (compiled: 8 steps; hub: 2000 chars)
 *     so a crowded catalog cannot balloon the system prompt.
 *   - Best-effort by construction: any store/catalog failure returns '' /
 *     null and the turn proceeds exactly as before (a hint must never break
 *     a turn).
 *
 * Consumers: chat's runChatAnswer (system prompt) and the execute loop's
 * runLoopExecutor — the two runToolLoop callers that had no skill knowledge.
 */

import type { ConfigManager } from '../config/manager.js';
import type { Skill } from '../learning/skill-types.js';

/**
 * The match the hint was built from (echoed to callers for telemetry/tests).
 * `null` = no match (no skill scored, or it was gated out).
 */
export interface LoopSkillHintMatch {
  name: string;
  id: string;
  source: 'compiled' | 'hub';
}

/**
 * Website-deploy activation gate — IDENTICAL to the orchestrator's
 * (src/agents/orchestrator.ts §3c): a website-deployment skill (bundled OR
 * hub-installed) is only injected when the goal carries hosting-specific
 * intent. A generic "deploy the API" goal does NOT get website methodology.
 */
const WEBSITE_DEPLOY_ID = /website[-_ ]?deploy/i;
const HOSTING_INTENT = /cloudflare|netlify|vercel|github\s*pages|hosting|pages\.dev|web\s*site|website|static\s*site|landing\s*page/i;

/**
 * Meta-words that appear in generic goalPatterns but carry NO goal evidence
 * ("compile a plan for this goal"). Excluded from pattern-word matching so a
 * goal containing only meta-vocabulary can never match a skill.
 */
const PATTERN_STOPWORDS = new Set([
  'goal', 'goals', 'task', 'tasks', 'skill', 'skills', 'step', 'steps',
  'plan', 'plans', 'planning', 'when', 'with', 'this', 'that', 'from',
  'into', 'user', 'users', 'want', 'wants', 'need', 'needs', 'request',
  'requests', 'help', 'make', 'using', 'used', 'work', 'works', 'some',
  'onto', 'over', 'your', 'their', 'them', 'then', 'also', 'each',
  // Generic document nouns/verbs — no domain evidence on their own.
  //
  // The docx skill's DESCRIPTION is long prose ("create, read, edit, or
  // manipulate Word **documents**… produce professional **documents** with
  // … **page** numbers"), so its generic words cleared the two-distinct-word
  // bar for any goal that merely mentioned a document. Measured live
  // (2026-10-03): the hub docx skill matched "Read the health report PDF …
  // produce a thorough assessment" on exactly `documents` + `produce` + `page`
  // — none of which names a document FORMAT.
  'document', 'documents', 'produce', 'produces', 'page', 'pages',
  // Generic document/analysis verbs — no domain evidence on their own.
  //
  // Measured live (2026-10-03): "read my health report - blood test report
  // and share me findings which are concerning and what changes i should do"
  // activated the **docx** skill and injected its whole "a .docx is a ZIP
  // archive of XML files / read with pandoc / unzip → edit word/document.xml"
  // methodology into a PDF lab-report turn — the model then reported the PDF
  // as a .docx with blank tables. The two "domain" words that cleared the
  // two-word bar were `read` (from the docx goalPattern) and `changes` (from
  // the description's "tracked changes"); neither names a document FORMAT.
  //
  // A FORMAT skill must match on its format NAME or a domain TAG, never on the
  // generic act of reading or on the noun "changes". Deliberately narrow: only
  // the two words observed in the false positive are excluded, so skills whose
  // real evidence is `create`/`build`/`edit`/`convert` are unaffected.
  'read', 'reads', 'reading', 'changes', 'changed', 'changing',
]);

/**
 * Skill-NAME words that are too generic to be evidence on their own.
 *
 * A skill's name is normally its strongest evidence — `wsl-setup` fires on
 * "wsl", `docker-config` on "docker". But a handful of skill names are built
 * from ordinary English words that carry a DIFFERENT meaning outside software:
 * `test` is also a medical/chemical noun (a blood test), a school noun, a
 * quality noun. Measured live (2026-10-03): the goal "read my health report -
 * blood test report and share me findings…" matched the **test-strategy**
 * skill on the single name word `test` and would have injected a
 * unit/integration/e2e software-testing methodology into a lab-report turn.
 *
 * A generic name word is NOT thrown away — it is DEMOTED: it counts as
 * evidence only when the goal uses it as the action (a leading/verb use, e.g.
 * "test the project") or when the skill's own domain vocabulary corroborates
 * it (see {@link isCompoundNounUse} and {@link hasRealGoalEvidence}).
 *
 * Deliberately tiny. Domain-ish names (`api`, `code`, `docx`, `docker`, `game`)
 * stay strong on their own: `REST API` and `code review` ARE the domain, so
 * excluding them would trade this false positive for a worse one. Only words
 * whose NON-software sense is common enough to appear in everyday requests
 * belong here.
 */
const GENERIC_SKILL_NAME_WORDS = new Set([
  'test', 'tests', 'testing',
]);

/**
 * Words that do NOT make a following token a compound-noun modifier.
 *
 * Used by {@link isCompoundNounUse} to tell `blood test report` (the generic
 * word is a noun modifier, so it names no domain) from `please test the build`
 * (the generic word is the verb, so it IS the action). Determiners, pronouns,
 * prepositions, conjunctions, politeness and auxiliaries — the words a verb
 * can legitimately follow.
 */
const VERB_PRECEDER_STOPWORDS = new Set([
  ...PATTERN_STOPWORDS,
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'by',
  'my', 'our', 'your', 'their', 'its', 'his', 'her', 'me', 'us', 'them', 'him',
  'please', 'can', 'could', 'would', 'will', 'should', 'do', 'does', 'did',
  'is', 'are', 'be', 'been', 'was', 'were', 'have', 'has', 'had', 'not',
  'no', 'if', 'as', 'it', 'i', 'you', 'we', 'they', 'so', 'up', 'out',
  'all', 'any', 'some', 'this', 'that', 'these', 'those', 'then', 'also',
  'just', 'now', 'new', 'again', 'here', 'there',
]);

/**
 * Is `word` used as a COMPOUND-NOUN modifier in the goal — i.e. immediately
 * preceded by another content word?
 *
 * "blood test report" → `test` follows the content word `blood`, so it is a
 * noun modifier and names no software domain. "test the project" / "please
 * test the build" → `test` follows nothing or a determiner/auxiliary, so it is
 * the verb and IS the action. Deterministic, no LLM.
 */
function isCompoundNounUse(goal: string, word: string): boolean {
  const tokens = (goal || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] !== word) continue;
    const prev = tokens[i - 1];
    if (prev.length > 3 && !VERB_PRECEDER_STOPWORDS.has(prev)) return true;
  }
  return false;
}

/**
 * Is this word, for THIS goal, a generic word being used as a compound-noun
 * modifier rather than as its own domain term?
 *
 * The single rule every evidence loop consults: a generic name word (`test`) is
 * dropped when the goal only uses it as a noun modifier ("blood test report"),
 * because there it names a different domain than the skill's. Applied to name,
 * tag and pattern evidence alike so the three can never disagree.
 */
function isDemotedGenericUse(goal: string, word: string): boolean {
  return GENERIC_SKILL_NAME_WORDS.has(word) && isCompoundNounUse(goal, word);
}

/**
 * Meta-vocabulary that is ALSO excluded from TAG hits.
 *
 * Why tag hits need this too (live, 2026-09-20): `technical-roadmap` carries the
 * tags `roadmap`/`planning`, so the prompt "…how should i plan…" matched on the
 * single generic tag word `planning` and injected the skill's whole phased-
 * migration methodology into a TRAVEL-ITINERARY turn — irrelevant context that
 * pushed the model toward planning meta-talk and grew the prompt. The evidence
 * filter already excluded these words from goalPattern matching for exactly this
 * reason; a tag hit is the same kind of evidence and gets the same treatment.
 *
 * Deliberately narrow — process/meta nouns that name how work is done rather
 * than a domain. Domain tags (`deploy`, `testing`, `search`, `payments`) still
 * match, and a name-word hit is unaffected.
 */
const GENERIC_SKILL_TAGS = new Set([
  'planning', 'roadmap', 'assessment', 'audit', 'quality', 'review',
  'analysis', 'process', 'workflow', 'recommendations', 'gaps', 'strategy',
  'methodology', 'checklist', 'template', 'guide', 'framework', 'report',
  // C4 — `packaging` is how work is DELIVERED, not a domain. Measured live
  // (2026-10-02): the goal "Fix the macOS hotkey permission and packaging
  // defects … changing app behavior" matched `electron-app` on its `packaging`
  // tag ALONE and injected Electron methodology into a PyQt6 bundle fix. The
  // skill's real domain (`electron`) is unaffected: a goal that actually names
  // Electron still matches on the name word.
  'packaging',
]);

/** Cap on hub SKILL.md body text injected into the prompt (chars). */
const HUB_BODY_CAP = 2000;
/** Cap on compiled methodology steps injected into the prompt. */
const COMPILED_STEP_CAP = 8;
/** Cap on any single description line (chars). */
const LINE_CAP = 400;

/** The skills.disabled[] gate: a disabled skill is never injected. */
function isDisabled(id: string, cm?: ConfigManager): boolean {
  try {
    const cfg = cm?.getAll?.() as { skills?: { disabled?: string[] } } | undefined;
    const disabled = cfg?.skills?.disabled;
    return Array.isArray(disabled) && disabled.includes(id);
  } catch {
    return false; // config failure must not block matching (the injection is advisory)
  }
}

/**
 * HOST/PLATFORM names — where something runs, not what the user wants done.
 *
 * Observed live (2026-09-21): the goal "…a multiple screen calculator and unit
 * converter, it should be GUI and cross platform for Windows and Linux"
 * activated `wsl-setup` (tags `wsl, windows, linux, development, gpu`) and
 * injected its WSL/Distro/GPU-passthrough methodology into a Flutter app plan.
 * Both tag hits and both pattern hits came from the platform names alone:
 * "Windows" and "Linux" were read as intent to configure the machine they run
 * on. A target platform is a CONSTRAINT on the work, never evidence for a
 * methodology, so these words contribute no evidence anywhere in this file.
 *
 * Deliberately narrow — only HOSTS. Tooling and cloud domains stay evidence
 * (`docker`, `kubernetes`, `aws`, `postgres`, `redis`, …): "deploy to AWS" IS
 * a request for deployment methodology, while "cross platform for Windows" is
 * not a request for WSL setup.
 */
const PLATFORM_HOST_NAMES = new Set([
  'windows', 'win32', 'win64', 'windows10', 'windows11',
  'linux', 'unix', 'gnu', 'ubuntu', 'debian', 'fedora', 'centos', 'rhel',
  'alpine', 'arch', 'suse', 'freebsd', 'openbsd',
  'macos', 'macosx', 'mac', 'osx', 'darwin', 'apple',
  'android', 'ios', 'ipados', 'watchos', 'tvos',
  'wsl', 'wsl2', 'cygwin', 'mingw', 'msys',
  'crossplatform', 'cross-platform',
  'x64', 'x86', 'arm64', 'aarch64', 'amd64',
]);

/** Is this token a host/platform name (never goal evidence)? */
export function isPlatformName(word: string): boolean {
  return PLATFORM_HOST_NAMES.has(word.trim().toLowerCase());
}

/**
 * Did the goal show REAL evidence for this skill — a name-word hit, a tag hit,
 * or two DISTINCT pattern/description words (meta-words and platform names
 * excluded)? Guards the compiled store's intentionally loose threshold:
 * findMatch adds a quality/usage bonus to every skill, so a generic word like
 * "goal" alone must never inject methodology into a chat turn.
 *
 * Also the HUB path's only filter: `findHubSkillMatch` scores name words and
 * DESCRIPTION keywords and returns the top scorer with no evidence gate at all,
 * so an installed skill whose description merely names the target platform
 * scored on that alone. A hub match carries no tags/goalPattern, so its
 * description words are the pattern-level evidence (the caller passes it here).
 *
 * MATCHING IS BY WHOLE WORD, never substring. `q.includes(word)` matched
 * "kill" inside "s**kill**" — measured: `feature-flags` (goalPattern “…kill
 * switch…”) matched "no **skill** covers alpaca husbandry whatsoever", and the
 * same class makes `mac` match "machine" and `arch` match "search". The goal is
 * tokenized once into a word set and skills are matched against tokens.
 *
 * Deterministic, no LLM.
 */
export function hasRealGoalEvidence(
  goal: string,
  skill: { name: string; tags?: string[]; goalPattern?: string; description?: string },
): boolean {
  const tokens = wordSet(goal);
  if (tokens.size === 0) return false;

  let nameHits = 0;
  for (const word of skill.name.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length <= 3 || isPlatformName(word) || !tokens.has(word)) continue;
    // A GENERIC name word (see GENERIC_SKILL_NAME_WORDS) is evidence only when
    // the goal uses it as the action, not as a compound-noun modifier. A
    // count alone did the wrong thing: the single word `test` in "blood test
    // report" cleared `nameHits >= 1` and activated the software-testing
    // skill on a lab-report turn. `please test the project` still counts (a
    // verb use), and `run the unit tests` counts below via its domain words.
    if (isDemotedGenericUse(goal, word)) continue;
    nameHits++;
  }

  let tagHits = 0;
  for (const tag of skill.tags ?? []) {
    const t = tag.toLowerCase().trim();
    // Generic process vocabulary is not goal evidence (see GENERIC_SKILL_TAGS),
    // and a generic word used only as a noun modifier is not either.
    if (t.length > 3 && !GENERIC_SKILL_TAGS.has(t) && !isPlatformName(t) && !isDemotedGenericUse(goal, t) && tokens.has(t)) tagHits++;
  }

  // Pattern-level evidence: the skill's own goalPattern words, plus (for a hub
  // skill, which has no goalPattern) its description keywords. Two DISTINCT
  // domain words are required — one shared word is not enough to inject a
  // whole methodology into a turn.
  //
  // DISTINCT is the whole point, and a plain counter got it wrong: the evidence
  // text is `goalPattern + description`, so ONE word that a skill repeats in
  // both fields counted twice and satisfied the "two words" rule on its own.
  // Measured live (2026-09-21): "Create a book which teaches math's division
  // for class 4 student" activated `game-development`, whose ONLY overlap is
  // the word `create` — present in its goalPattern (`game create build …`) and
  // again in its description ("Use when the goal asks to create, build, or
  // develop a game"). `create` is also a generic action verb, so the match was
  // noise in both senses.
  const patternHits = new Set<string>();
  const evidenceText = `${skill.goalPattern ?? ''} ${skill.description ?? ''}`;
  for (const word of evidenceText.toLowerCase().split(/[^a-z0-9]+/)) {
    const w = word.trim();
    if (w.length > 3 && !PATTERN_STOPWORDS.has(w) && !GENERIC_SKILL_TAGS.has(w) && !isPlatformName(w) && !isDemotedGenericUse(goal, w) && tokens.has(w)) {
      patternHits.add(w);
    }
  }

  return nameHits >= 1 || tagHits >= 1 || patternHits.size >= 2;
}

/** Whole-word token set for a goal (word-boundary matching, never substring). */
function wordSet(text: string): Set<string> {
  return new Set(
    (text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 0),
  );
}

/**
 * THE skill-activation gate — the single decision every injection path makes.
 *
 * Composes (1) the website-deploy activation rule: website methodology needs
 * HOSTING intent, so a generic "deploy the API" goal never gets it; and (2) the
 * evidence rule above.
 *
 * Before this existed the gate was implemented three times with different
 * strength: the chat/execute loop applied the evidence filter to COMPILED
 * matches but trusted hub matches raw, and the ORCHESTRATOR applied neither
 * (only the website-deploy rule) — so the pipeline was the most exposed
 * surface. One predicate, consumed by all of them.
 */
export function isSkillActivated(
  goal: string,
  skill: { id?: string; name: string; tags?: string[]; goalPattern?: string; description?: string },
): boolean {
  const label = `${skill.id ?? ''} ${skill.name}`;
  if (WEBSITE_DEPLOY_ID.test(label) && !HOSTING_INTENT.test(goal)) return false;
  return hasRealGoalEvidence(goal, skill);
}

/**
 * Find the best skill for the goal across BOTH sources the orchestrator
 * consults, honoring the disabled + website-deploy activation gates (+ the
 * compiled evidence filter). Compiled wins ties (its id is the deterministic
 * seed id). Returns null when nothing matches (never a forced match).
 */
export async function findLoopSkillMatch(
  goal: string,
  cm?: ConfigManager,
): Promise<LoopSkillHintMatch | null> {
  const q = (goal || '').trim();
  if (!q) return null;

  // 1. Compiled store (the first-party capability batch).
  try {
    const { getSkillStore } = await import('../learning/skill-store.js');
    const match = getSkillStore().findMatch(q);
    if (match && !isDisabled(match.id, cm) && isSkillActivated(q, match)) {
      return { name: match.name, id: match.id, source: 'compiled' };
    }
  } catch {
    // Fall through to the hub catalog — a store failure must not block it.
  }

  // 2. Hub catalog (installed SKILL.md skills — first-class runtime
  //    capabilities; a fresh `nuvira skills install` is matchable with zero
  //    recompilation, exactly like the orchestrator's fallback path).
  //
  //    Its scoring is NOT evidence: `findHubSkillMatch` counts name words and
  //    DESCRIPTION keywords and returns the top scorer, so a skill whose
  //    description merely names the target platform ("…a Linux development
  //    environment on Windows") scored on those two words alone. The same
  //    evidence gate the compiled path uses is applied here now.
  try {
    const { findHubSkillMatch } = await import('../learning/hub-skill-catalog.js');
    const hub = findHubSkillMatch(q, cm);
    // A hub match carries only id/name/description — its description words are
    // the pattern-level evidence — and the platform/word-boundary rules above
    // decide. A skill named `wsl-setup` therefore needs actual domain words
    // (networking, development, subsystem), not merely the platforms it targets.
    if (hub && !isDisabled(hub.id, cm) && isSkillActivated(q, hub)) {
      return { name: hub.name, id: hub.id, source: 'hub' };
    }
  } catch {
    // Best-effort — a catalog failure leaves no hint.
  }

  return null;
}

/**
 * Bounded, side-effect-free methodology text for a compiled skill (the full
 * Skill shape is fetched via the public get(); step descriptions carry the
 * Level-2 methodology). Deliberately NOT store.skillView() — that marks the
 * skill used as a side effect and renders reference-doc/quality sections the
 * prompt block does not need.
 */
function formatCompiledMethodology(skill: Skill): string {
  const lines: string[] = [];
  if (skill.description) lines.push(cap(skill.description));
  if (skill.parameters.length > 0) {
    lines.push(
      'Parameters: ' +
        skill.parameters
          .map((p) => `${p.name}${p.required ? '' : ' (optional)'}`)
          .join(', '),
    );
  }
  const steps = skill.steps.slice(0, COMPILED_STEP_CAP);
  steps.forEach((s, i) => {
    lines.push(`Step ${i + 1} [${s.agentType}]: ${cap(s.description)}`);
  });
  if (skill.steps.length > steps.length) {
    lines.push(`(+${skill.steps.length - steps.length} more steps — load the skill for the full methodology)`);
  }
  return lines.join('\n');
}

function cap(text: string, max: number = LINE_CAP): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Build the system-prompt block for a matched skill, or '' when there is no
 * match. The block follows the orchestrator's injection contract:
 *
 *   - the skill is a RECOMMENDATION, the model still owns the plan (the
 *     orchestrator's "model-selected activation" phrasing),
 *   - the methodology rides in as Level-2 content (progressive disclosure —
 *     the model sees the steps without paying a tool call for them),
 *   - the exact load syntax is included so the model can refresh/parameterize
 *     via the `skill` tool mid-turn,
 *   - ONE block max (bounded system-prompt growth).
 *
 * Marks nothing: usage tracking belongs to markLoopSkillUsed (the caller
 * decides when a match actually got USED — i.e. was injected).
 *
 * @param goal       the user's goal text (matched against skill triggers)
 * @param cm         ConfigManager for the disabled-skills gate (optional)
 * @param injected   out-param: when provided, receives the match that was
 *                   injected (null when none).
 */
export async function buildLoopSkillHint(
  goal: string,
  cm?: ConfigManager,
  injected?: { value: LoopSkillHintMatch | null },
): Promise<string> {
  const match = await findLoopSkillMatch(goal, cm).catch(() => null);
  if (injected) injected.value = match;
  if (!match) return '';

  // Full methodology (Level 2). Compiled: the stored Skill (steps carry the
  // methodology). Hub: the SKILL.md body.
  let methodology = '';
  if (match.source === 'hub') {
    try {
      const { findHubSkillMatch } = await import('../learning/hub-skill-catalog.js');
      methodology = cap(findHubSkillMatch(goal, cm)?.body ?? '', HUB_BODY_CAP);
    } catch {
      methodology = '';
    }
  } else {
    try {
      const { getSkillStore } = await import('../learning/skill-store.js');
      methodology = formatCompiledMethodology(getSkillStore().get(match.id) as Skill);
    } catch {
      methodology = '';
    }
  }

  const lines: string[] = [
    '',
    '## Matched skill',
    `A first-party skill matches this goal: **${match.name}** (${match.source} skill, id ${match.id}).`,
    'This is a RECOMMENDATION — follow it when it fits the request; ignore it when it does not (you still own the plan).',
  ];
  if (methodology) {
    lines.push('', 'Its methodology:', '', methodology);
  }
  lines.push(
    '',
    `To (re)load it with parameters mid-turn, call the skill tool with {"skill":"${match.name}"}.`,
  );
  return lines.join('\n');
}

/**
 * A bounded CATALOG of available skills for the system prompt — the model-facing
 * replacement for keyword auto-injection.
 *
 * WHY THIS REPLACES THE MATCHER: a word list cannot decide whether "blood test
 * report" is software testing, and every stopword added to force it right made
 * some real match wrong. The model can read the same catalog and judge instantly,
 * so the fix is to STOP deciding in code and hand the model the list: name + a
 * one-line description each, plus the exact `skill` tool syntax to load one. This
 * scales to infinite permutations with no maintenance and no false positives —
 * the model loads a skill only when it actually applies.
 *
 * Bounded deliberately: descriptions are capped and the list is capped, so a
 * crowded catalog cannot balloon the system prompt. Returns '' when there are no
 * skills (nothing to say) — never a forced recommendation.
 *
 * @param cm       ConfigManager (honors skills.disabled — a disabled skill is
 *                 never listed, the same gate the tool enforces)
 * @param opts     caps: maxSkills (default 200 — the full bundled+hub catalog,
 *                 so NO skill is dropped from the model's view; missing a skill
 *                 is the failure this design exists to avoid), descriptionChars
 *                 (default 140)
 */
export async function buildSkillCatalogHint(
  cm?: ConfigManager,
  opts: { maxSkills?: number; descriptionChars?: number } = {},
): Promise<string> {
  const maxSkills = opts.maxSkills ?? 200;
  const descChars = opts.descriptionChars ?? 140;
  const entries: Array<{ name: string; description: string }> = [];

  // Compiled first-party skills.
  try {
    const { getSkillStore } = await import('../learning/skill-store.js');
    for (const skill of getSkillStore().getAll()) {
      if (isDisabled(skill.id, cm)) continue;
      entries.push({ name: skill.name, description: skill.description ?? '' });
    }
  } catch {
    // Best-effort — a store failure must not remove the hub half.
  }

  // Hub (installed SKILL.md) skills.
  try {
    const { listMatchableHubSkills } = await import('../learning/hub-skill-catalog.js');
    for (const skill of listMatchableHubSkills(cm)) {
      if (isDisabled(skill.id, cm)) continue;
      if (entries.some((e) => e.name === skill.name)) continue;
      entries.push({ name: skill.name, description: skill.description ?? '' });
    }
  } catch {
    // Best-effort — a catalog failure leaves the compiled half.
  }

  if (entries.length === 0) return '';
  const shown = entries.slice(0, maxSkills);
  const lines = shown.map(
    (e) => `  - ${e.name}: ${cap(e.description, descChars)}`,
  );
  const more = entries.length > shown.length ? `\n  (+${entries.length - shown.length} more — call the skill tool with no name to list all)` : '';
  return [
    '',
    '## Available skills',
    'A first-party skill may fit this goal. Read the list and decide — load one with the skill tool ONLY when it genuinely applies (ignore the rest):',
    ...lines,
    more,
    '',
    'Load one with the skill tool, e.g. {"skill":"<name>"} (or call it with no name to list every skill).',
  ].filter((l) => l !== undefined).join('\n');
}

/**
 * Mark an injected skill as used (usage tracking parity with the orchestrator
 * — compiled skills only; hub skills have no compiled usage counter). The
 * SINGLE usage marker for the loop hint path (the hint builder never marks).
 * Best-effort, fire-and-forget: never throws, never awaited by callers on the
 * hot path.
 */
export async function markLoopSkillUsed(match: LoopSkillHintMatch | null): Promise<void> {
  if (!match || match.source !== 'compiled') return;
  try {
    const { getSkillStore } = await import('../learning/skill-store.js');
    getSkillStore().markUsed(match.id);
  } catch {
    // Best-effort.
  }
}
