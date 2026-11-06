/**
 * Skill hint (`src/tools/loop-skill-hint.ts`) — model-driven skill selection.
 *
 * HISTORY (why the keyword scorer is gone). This module used to decide, in code,
 * WHICH skill a goal wanted: `findLoopSkillMatch` scored the compiled store and
 * the hub catalog, then a hand-written evidence filter (`hasRealGoalEvidence`)
 * pulled back the false positives with stopword lists, generic-name-word lists,
 * generic-tag lists and platform-host lists. Every one of those lists was a bug
 * report: "blood test report" matched the software `test-strategy` skill,
 * "Windows and Linux" matched `wsl-setup`, "packaging" matched `electron-app`.
 * A word list cannot decide what a goal MEANS, and each word added to force one
 * case right made some real match wrong.
 *
 * THE REPLACEMENT. Selection is the MODEL's job now. The harness no longer
 * guesses; it hands the model enough to CHOOSE and gets out of the way:
 *
 *   - default (`index`) — every skill by name plus its TRIGGER clause, bounded
 *     (`buildSkillIndex`, src/learning/skill-index.ts). This is the surface that
 *     answers "how does it know which skill to use": the model can read WHEN
 *     each skill applies without a 24K catalog and without a scorer deciding.
 *   - `pointer` — the previous default: skills exist, here is how to look. It
 *     named no skill, so hop one of discovery was uninformed. Kept as an opt-out.
 *   - `catalog` / `names` (OPT-IN) — the full name+description catalog, or the
 *     names-only list, for a user who wants everything in-context.
 *   - `off` — inject nothing.
 *
 * The old default was the ~24.5K-char catalog, which buried the task on every
 * turn (3.3.11 regression, see tests/release/agent-contracts.test.ts); the index
 * keeps the bounded-prompt property while still being model-driven. Measured:
 * 132/156 bundled descriptions exceed the 140-char catalog cap and 55 lose their
 * trigger clause there, so the index derives the trigger explicitly.
 *
 * The pipeline arm consumes the SAME catalog builder (see the orchestrator's
 * `skillCatalog` injection): the planner is a model too, so it is handed the
 * list instead of a keyword-selected skill.
 *
 * Best-effort by construction: any store/catalog failure returns '' and the turn
 * proceeds byte-identically (a hint must never break a turn).
 */

import type { ConfigManager } from '../config/manager.js';
import { buildSkillIndex } from '../learning/skill-index.js';
import { readSkillPolicy, skillPolicyAllows } from '../learning/hub-skill-catalog.js';
import { orderByOutcome } from '../learning/skill-outcomes.js';

/** Cap on any single description line (chars). */
const LINE_CAP = 400;

function cap(text: string, max: number = LINE_CAP): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * The gate: a skill excluded by the effective policy is never listed.
 *
 * Read through `readSkillPolicy`, not `skills.disabled[]` directly, so the
 * project's own allow/deny list (`.nuviraconfig.json`) applies to the index too
 * — otherwise the model is still told a skill exists in a repo that forbade it.
 * Config failure must not block discovery (the hint is advisory).
 */
function isDisabled(id: string, cm?: ConfigManager, cwd?: string): boolean {
  try {
    return !skillPolicyAllows(id, readSkillPolicy(cm, cwd));
  } catch {
    return false;
  }
}

/** One catalog entry the model can read and pick from. */
interface SkillEntry {
  name: string;
  description: string;
}

/**
 * Every skill the model may pick from — compiled first-party + installed hub
 * (SKILL.md) skills, deduped by name, with the disabled gate applied. Best-effort:
 * a store/catalog failure contributes nothing rather than throwing.
 */
export async function collectSkillEntries(
  cm?: ConfigManager,
  opts: { projectRoot?: string; home?: string } = {},
): Promise<SkillEntry[]> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const entries: SkillEntry[] = [];
  try {
    const { getSkillStore } = await import('../learning/skill-store.js');
    for (const skill of getSkillStore().getAll()) {
      if (isDisabled(skill.id, cm, projectRoot)) continue;
      entries.push({ name: skill.name, description: skill.description ?? '' });
    }
  } catch {
    // Best-effort — a store failure must not remove the hub half.
  }
  try {
    const { listMatchableHubSkills } = await import('../learning/hub-skill-catalog.js');
    const hubSkills = opts.home
      ? listMatchableHubSkills(cm, projectRoot, opts.home)
      : listMatchableHubSkills(cm, projectRoot);
    for (const skill of hubSkills) {
      if (isDisabled(skill.id, cm, projectRoot)) continue;
      if (entries.some((e) => e.name === skill.name)) continue;
      entries.push({ name: skill.name, description: skill.description ?? '' });
    }
  } catch {
    // Best-effort — a catalog failure leaves the compiled half.
  }
  // Rank by what each skill has actually DELIVERED here, not by name order or
  // keyword overlap. Unseen skills keep the neutral score, so this reorders
  // experience without burying a new skill.
  return orderByOutcome(entries);
}

/** Where the "load one" tail should point: the loop's skill tool, or the pipeline's skill_view. */
export type SkillLoadHint = 'skill-tool' | 'skill-view';

function loadTail(loadHint: SkillLoadHint): string {
  return loadHint === 'skill-view'
    ? 'Name the skill in the step that needs it; the writer agent can call skill_view(name) to load its full methodology.'
    : 'Load one with the skill tool, e.g. {"skill":"<name>"} (or call it with no name to list every skill).';
}

/**
 * The DEFAULT hint — a bounded discovery pointer, not a recommendation.
 *
 * It names the two model-driven paths to a skill (the `skill` tool and the
 * capability search) and leaves the decision with the model. Returns '' when
 * there are no skills to discover (nothing to say — never a forced hint).
 */
export async function buildSkillPointerHint(cm?: ConfigManager, loadHint: SkillLoadHint = 'skill-tool'): Promise<string> {
  const entries = await collectSkillEntries(cm);
  if (entries.length === 0) return '';
  return [
    '',
    '## Skills',
    `${entries.length} reusable capability packs (skills) are available. Decide from the task itself whether one applies — do not guess:`,
    '  - call the skill tool with no name to list every skill, or',
    '  - call tool_search with a query describing this task; skills come back as capabilities (kind "skill").',
    loadTail(loadHint),
    'If none applies, ignore this and proceed.',
  ].join('\n');
}

/**
 * The bounded CATALOG of available skills for the system prompt — the model-facing
 * discovery surface, read straight through.
 *
 * Bounded deliberately: descriptions are capped and the list is capped, so a
 * crowded catalog cannot balloon the prompt. Returns '' when there are no skills.
 *
 * @param cm       ConfigManager (honors skills.disabled — a disabled skill is
 *                 never listed, the same gate the tool enforces)
 * @param opts     caps: maxSkills (default 200 — the full bundled+hub catalog,
 *                 so NO skill is dropped from the model's view; missing a skill
 *                 is the failure this design exists to avoid), descriptionChars
 *                 (default 140), namesOnly (default false), loadHint
 */
export async function buildSkillCatalogHint(
  cm?: ConfigManager,
  opts: {
    maxSkills?: number;
    descriptionChars?: number;
    namesOnly?: boolean;
    loadHint?: SkillLoadHint;
  } = {},
): Promise<string> {
  const maxSkills = opts.maxSkills ?? 200;
  const descChars = opts.descriptionChars ?? 140;
  const namesOnly = opts.namesOnly === true;
  const loadHint = opts.loadHint ?? 'skill-tool';
  const entries = await collectSkillEntries(cm);
  if (entries.length === 0) return '';

  const shown = entries.slice(0, maxSkills);
  // `namesOnly` (mode `names`) drops the per-skill description: the model still
  // sees the whole catalog and can `skill` with no name to read the details, but
  // the prompt pays a fraction of the full description catalog.
  const lines = shown.map(
    (e) => (namesOnly ? `  - ${e.name}` : `  - ${e.name}: ${cap(e.description, descChars)}`),
  );
  const more = entries.length > shown.length ? `\n  (+${entries.length - shown.length} more — call the skill tool with no name to list all)` : '';
  return [
    '',
    '## Available skills',
    namesOnly
      ? 'A first-party skill may fit this goal. These are NAMES only — call the skill tool with no name to read a skill\u2019s description, then load one ONLY when it genuinely applies (ignore the rest):'
      : 'A first-party skill may fit this goal. Read the list and decide — load one ONLY when it genuinely applies (ignore the rest):',
    ...lines,
    more,
    '',
    loadTail(loadHint),
  ].filter((l) => l !== undefined).join('\n');
}

/**
 * Which skill hint the system prompt carries. See {@link resolveSkillHintMode}.
 *   - `index`   — every skill by name with its TRIGGER clause (bounded, ~12K
 *                 chars, adaptive per line). The DEFAULT — this is the surface
 *                 that makes routing possible without a 24K catalog.
 *   - `pointer` — the small discovery pointer (names the skill tool + capability
 *                 search), with NO skill names. Kept as an explicit opt-out.
 *   - `catalog` — the FULL name+description catalog (opt-in, ~24K chars).
 *   - `names`   — the catalog WITHOUT descriptions (names only; far smaller).
 *   - `off`     — never inject a skill hint.
 */
export type SkillHintMode = 'index' | 'pointer' | 'catalog' | 'names' | 'off';

/**
 * The default. Previously `pointer`, which told the model that 156 skills
 * existed without naming one of them — the measured failure this change fixes
 * (55/156 descriptions also lost their trigger clause in `catalog` mode, so
 * neither old surface could route reliably). `pointer` is still supported.
 */
export const DEFAULT_SKILL_HINT_MODE: SkillHintMode = 'index';

/**
 * The bounded, always-on skill INDEX: `name: when to use it` for every skill.
 *
 * Bounded by construction (see `buildSkillIndex`): the per-line width adapts to
 * the budget, so adding a skill shortens lines rather than hiding the tail of
 * the catalog. Falls back to names only when even a short trigger would not
 * fit — an invisible skill is the one failure this surface must not have.
 */
export async function buildSkillIndexHint(
  cm?: ConfigManager,
  opts: { loadHint?: SkillLoadHint; budgetChars?: number } = {},
): Promise<string> {
  const loadHint = opts.loadHint ?? 'skill-tool';
  const entries = await collectSkillEntries(cm);
  if (entries.length === 0) return '';
  const index = buildSkillIndex(entries, opts.budgetChars ? { budgetChars: opts.budgetChars } : {});
  return [
    '',
    index.text,
    index.nameOnly > 0
      ? `${index.withTrigger} skill(s) carry a trigger line; ${index.nameOnly} are name-only (budget). Call the skill tool with no name for the full descriptions.`
      : '',
    'Each line says WHEN the skill applies. Load one ONLY when the current task genuinely matches (skill tool, {"skill":"<name>"}); otherwise ignore this block and proceed.',
    loadTail(loadHint),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Env names, `NUVIRA_*` first with the legacy `BUFF_*` alias accepted. */
const SKILL_HINT_ENV_NAMES = ['NUVIRA_SKILL_CATALOG', 'BUFF_SKILL_CATALOG'];

/**
 * Parse a raw value into a mode. Synonyms accepted so a typo cannot silently
 * change behaviour; null (unrecognized) falls through to the next source.
 *   - pointer / match / keyword / auto / small / default → 'pointer'
 *   - catalog / full / all / on / true / 1               → 'catalog'
 *   - names / names-only / list / bare / titles          → 'names'
 *   - off / none / never / false / 0                     → 'off'
 *
 * `match`/`keyword` are kept as ACCEPTED SYNONYMS for back-compat (an existing
 * `NUVIRA_SKILL_CATALOG=match` or `skills.catalogHint: "match"` still works) —
 * they now mean the pointer, since there is no keyword matcher any more.
 */
export function parseSkillHintMode(raw: string | undefined | null): SkillHintMode | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'index' || v === 'trigger' || v === 'triggers' || v === 'compact' || v === 'default') return 'index';
  if (v === 'pointer' || v === 'match' || v === 'keyword' || v === 'auto' || v === 'small') return 'pointer';
  if (v === 'catalog' || v === 'full' || v === 'all' || v === 'on' || v === 'true' || v === '1') return 'catalog';
  if (v === 'names' || v === 'names-only' || v === 'list' || v === 'bare' || v === 'titles') return 'names';
  if (v === 'off' || v === 'none' || v === 'never' || v === 'false' || v === '0') return 'off';
  return null;
}

/**
 * The effective skill-hint mode. Env first (`NUVIRA_SKILL_CATALOG`, then the
 * legacy `BUFF_*`), then `skills.catalogHint` in the config file, then the
 * default (`pointer`). Pure and never throws.
 */
export function resolveSkillHintMode(cm?: ConfigManager): SkillHintMode {
  for (const name of SKILL_HINT_ENV_NAMES) {
    const parsed = parseSkillHintMode(process.env[name]);
    if (parsed) return parsed;
  }
  try {
    const cfg = cm?.getAll?.() as { skills?: { catalogHint?: unknown } } | undefined;
    const parsed = parseSkillHintMode(typeof cfg?.skills?.catalogHint === 'string' ? cfg.skills.catalogHint : undefined);
    if (parsed) return parsed;
  } catch {
    // Best-effort — a config failure must not break a turn.
  }
  return DEFAULT_SKILL_HINT_MODE;
}

/**
 * The skill hint, resolved through the configured mode — the ONE entry point
 * both the chat/execute loop and the pipeline call, so a surface can never drift
 * from the policy:
 *   - `off`     → ''
 *   - `catalog` → the full name+description catalog ({@link buildSkillCatalogHint})
 *   - `names`   → the names-only catalog (no descriptions)
 *   - `pointer` → the discovery pointer ({@link buildSkillPointerHint})
 *
 * `loadHint` lets the pipeline point its tail at skill_view (the writer's load
 * path) instead of the loop's skill tool; it is ignored in the catalog modes'
 * default wording and only affects the tail line.
 */
export async function buildConfiguredSkillHint(
  cm?: ConfigManager,
  opts: { loadHint?: SkillLoadHint } = {},
): Promise<string> {
  const mode = resolveSkillHintMode(cm);
  const loadHint = opts.loadHint ?? 'skill-tool';
  if (mode === 'off') return '';
  if (mode === 'catalog') return buildSkillCatalogHint(cm, { loadHint });
  if (mode === 'names') return buildSkillCatalogHint(cm, { namesOnly: true, loadHint });
  if (mode === 'pointer') return buildSkillPointerHint(cm, loadHint);
  return buildSkillIndexHint(cm, { loadHint });
}
