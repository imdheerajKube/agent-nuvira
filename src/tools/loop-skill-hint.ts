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
 * guesses; it hands the model the discovery path and gets out of the way:
 *
 *   - default (`pointer`) — a few lines saying skills exist and HOW to find one:
 *     the `skill` tool (list / load) and the capability search (`tool_search`,
 *     whose hits include `kind:"skill"` capabilities). Near-zero prompt cost,
 *     no false positives, no maintenance.
 *   - `catalog` / `names` (OPT-IN) — the full name+description catalog, or the
 *     names-only list, for a user who wants everything in-context.
 *   - `off` — inject nothing.
 *
 * The old default was the ~24.5K-char catalog, which buried the task on every
 * turn (3.3.11 regression, see tests/release/agent-contracts.test.ts); the
 * pointer keeps the small-prompt property while still being model-driven.
 *
 * The pipeline arm consumes the SAME catalog builder (see the orchestrator's
 * `skillCatalog` injection): the planner is a model too, so it is handed the
 * list instead of a keyword-selected skill.
 *
 * Best-effort by construction: any store/catalog failure returns '' and the turn
 * proceeds byte-identically (a hint must never break a turn).
 */

import type { ConfigManager } from '../config/manager.js';

/** Cap on any single description line (chars). */
const LINE_CAP = 400;

function cap(text: string, max: number = LINE_CAP): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** The skills.disabled[] gate: a disabled skill is never listed. */
function isDisabled(id: string, cm?: ConfigManager): boolean {
  try {
    const cfg = cm?.getAll?.() as { skills?: { disabled?: string[] } } | undefined;
    const disabled = cfg?.skills?.disabled;
    return Array.isArray(disabled) && disabled.includes(id);
  } catch {
    return false; // config failure must not block discovery (the hint is advisory)
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
export async function collectSkillEntries(cm?: ConfigManager): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  try {
    const { getSkillStore } = await import('../learning/skill-store.js');
    for (const skill of getSkillStore().getAll()) {
      if (isDisabled(skill.id, cm)) continue;
      entries.push({ name: skill.name, description: skill.description ?? '' });
    }
  } catch {
    // Best-effort — a store failure must not remove the hub half.
  }
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
  return entries;
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
 *   - `pointer` — the small discovery pointer (names the skill tool + capability
 *                 search). The DEFAULT.
 *   - `catalog` — the FULL name+description catalog (opt-in).
 *   - `names`   — the catalog WITHOUT descriptions (names only; far smaller).
 *   - `off`     — never inject a skill hint.
 */
export type SkillHintMode = 'pointer' | 'catalog' | 'names' | 'off';

/** The default. The catalog is ~24K chars — it must never be the default. */
export const DEFAULT_SKILL_HINT_MODE: SkillHintMode = 'pointer';

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
  if (v === 'pointer' || v === 'match' || v === 'keyword' || v === 'auto' || v === 'small' || v === 'default') return 'pointer';
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
  return buildSkillPointerHint(cm, loadHint);
}
