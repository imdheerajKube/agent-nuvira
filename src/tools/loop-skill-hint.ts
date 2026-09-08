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
 * Did the goal show REAL evidence for this skill — a name-word hit, a tag
 * hit, or two pattern-word hits (meta-words excluded)? Guards the compiled
 * store's intentionally loose threshold: findMatch adds a quality/usage bonus
 * to every skill, so a generic word like "goal" alone must never inject
 * methodology into a chat turn. Deterministic, no LLM.
 */
export function hasRealGoalEvidence(
  goal: string,
  skill: { name: string; tags: string[]; goalPattern: string },
): boolean {
  const q = goal.toLowerCase();
  if (!q) return false;

  let nameHits = 0;
  for (const word of skill.name.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length > 3 && q.includes(word)) nameHits++;
  }

  let tagHits = 0;
  for (const tag of skill.tags) {
    const t = tag.toLowerCase().trim();
    if (t.length > 3 && q.includes(t)) tagHits++;
  }

  let patternHits = 0;
  for (const word of skill.goalPattern.toLowerCase().split(/\s+/)) {
    const w = word.trim();
    if (w.length > 3 && !PATTERN_STOPWORDS.has(w) && q.includes(w)) patternHits++;
  }

  return nameHits >= 1 || tagHits >= 1 || patternHits >= 2;
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
    if (match && !isDisabled(match.id, cm) && hasRealGoalEvidence(q, match)) {
      // Activation gate: website-deploy methodology needs hosting intent.
      if (!(WEBSITE_DEPLOY_ID.test(match.id) || WEBSITE_DEPLOY_ID.test(match.name)) || HOSTING_INTENT.test(q)) {
        return { name: match.name, id: match.id, source: 'compiled' };
      }
    }
  } catch {
    // Fall through to the hub catalog — a store failure must not block it.
  }

  // 2. Hub catalog (installed SKILL.md skills — first-class runtime
  //    capabilities; a fresh `nuvira skills install` is matchable with zero
  //    recompilation, exactly like the orchestrator's fallback path). Its
  //    scoring is pure keyword evidence (score >= 1), no filter needed.
  try {
    const { findHubSkillMatch } = await import('../learning/hub-skill-catalog.js');
    const hub = findHubSkillMatch(q, cm);
    if (hub && !isDisabled(hub.id, cm)) {
      if (!(WEBSITE_DEPLOY_ID.test(hub.id) || WEBSITE_DEPLOY_ID.test(hub.name)) || HOSTING_INTENT.test(q)) {
        return { name: hub.name, id: hub.id, source: 'hub' };
      }
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
