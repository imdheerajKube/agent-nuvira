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
]);

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
    if (word.length > 3 && !isPlatformName(word) && tokens.has(word)) nameHits++;
  }

  let tagHits = 0;
  for (const tag of skill.tags ?? []) {
    const t = tag.toLowerCase().trim();
    // Generic process vocabulary is not goal evidence (see GENERIC_SKILL_TAGS).
    if (t.length > 3 && !GENERIC_SKILL_TAGS.has(t) && !isPlatformName(t) && tokens.has(t)) tagHits++;
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
    if (w.length > 3 && !PATTERN_STOPWORDS.has(w) && !GENERIC_SKILL_TAGS.has(w) && !isPlatformName(w) && tokens.has(w)) {
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
