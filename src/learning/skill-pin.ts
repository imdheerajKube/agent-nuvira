/**
 * Pinned skills (`src/learning/skill-pin.ts`) — the user NAMING a skill.
 *
 * WHY THIS EXISTS. Skill selection is model-driven (see `loop-skill-hint.ts`):
 * the index names when each skill applies and the model decides whether to load
 * one. That is right for discovery, and it is also why a user who says "use the
 * api-design skill" is only making a REQUEST — measured on the bench, a weak
 * model given the index made zero `skill` tool calls for a turn like that, so
 * "I asked for a skill" and "the skill was applied" were different things with
 * nothing on screen to tell them apart.
 *
 * A PIN is the other direction: the user names the skill, the HARNESS puts its
 * methodology in the turn before the model speaks. It is:
 *   - explicit — `--skill` (CLI), `skills: []` (dashboard/API), or an exact
 *     catalog name the user directly asks to use ("use the rag-pipeline skill");
 *     no semantic scorer is back, and a plain mention is not a pin;
 *   - opt-in — a turn with no pin is byte-identical to before this module;
 *   - visible — the block says the skill is pinned, so a model that ignores it
 *     is contradicting a stated instruction rather than an advisory hint;
 *   - honest — an unknown or disabled name is REPORTED to the caller instead of
 *     being silently dropped, and never becomes a fake load.
 *
 * Resolution goes through the `skill` tool's own `resolveSkill`, so a pinned
 * name and a loaded name can never disagree about what a skill IS (same
 * precedence: project `.agents/skills` → `.claude/skills` → `~/.nuvira/skills`,
 * with the compiled store as the fallback). The import is dynamic because
 * `tools/` depends on `learning/`, and this module must not close that cycle.
 *
 * NOT enforcement. A pin does not run anything and does not flip the obligation
 * gate (`obligationsEnforced()` stays opt-in): it records the load exactly as
 * the skill tool would, so obligations are reported the same way.
 */

import { readSkillPolicy, skillPolicyAllows, type SkillPolicy } from './hub-skill-catalog.js';
import { recordSkillLoad, type SkillObligations } from './skill-obligations.js';

/** Cap per methodology — one hostile/huge SKILL.md must not own the prompt. */
const MAX_METHODOLOGY_CHARS = 8_000;
/** Cap on the whole pinned block. */
const MAX_BLOCK_CHARS = 24_000;
/** Sandbox rule shared by installs and the catalog. */
const SKILL_NAME_RE = /^[a-z0-9-]+$/i;

/** One skill the user pinned, resolved and ready to render. */
export interface PinnedSkill {
  /** Store id / directory name (what the obligation ledger keys on). */
  id: string;
  name: string;
  description: string;
  /** SKILL.md body, or the compiled skill's steps — the methodology itself. */
  methodology: string;
  /** Skill directory when it is an installed package (for `read_file`). */
  dir?: string;
  /** Files that shipped with the package (progressive disclosure). */
  files?: string[];
  /** What "used" means for this skill, when authored. */
  obligations?: SkillObligations;
}

/** What a pin request resolved to. */
export interface PinnedSkillResolution {
  pins: PinnedSkill[];
  /** Names that matched nothing (typos, or not installed). */
  unknown: string[];
  /** Names that matched but are excluded by `skills.disabled[]`. */
  disabled: string[];
}

/**
 * Normalise a caller's skill names.
 *
 * Accepts the two shapes the surfaces actually produce: an array (commander's
 * variadic `--skill a --skill b`, or a JSON `skills: []`) and a comma/space
 * separated string (a config value, a dashboard composer line). Validation is
 * the same allowlist the install path uses, so nothing here can read a path.
 */
export function parsePinnedSkillNames(raw: unknown): string[] {
  const list: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== 'string') return;
    for (const piece of value.split(/[,\s]+/)) {
      const name = piece.trim().toLowerCase();
      if (!name || !SKILL_NAME_RE.test(name)) continue;
      if (!list.includes(name)) list.push(name);
    }
  };
  if (Array.isArray(raw)) for (const value of raw) push(value);
  else push(raw);
  return list;
}

/** Render a compiled skill's steps as the methodology text. */
function compiledMethodology(skill: unknown): string {
  const s = skill as
    | { steps?: Array<{ agentType?: string; description?: string; expectedOutput?: string }>; whenToUse?: string[]; whenNotToUse?: string[] }
    | undefined;
  if (!s) return '';
  const lines: string[] = [];
  if (s.whenToUse?.length) lines.push('Use when:', ...s.whenToUse.map((w) => `- ${w}`), '');
  if (s.whenNotToUse?.length) lines.push('Do NOT use when:', ...s.whenNotToUse.map((w) => `- ${w}`), '');
  const steps = s.steps ?? [];
  steps.forEach((step, i) => {
    lines.push(`${i + 1}. [${step.agentType ?? 'runner'}] ${step.description ?? ''}`.trim());
    if (step.expectedOutput) lines.push(`   expected output: ${step.expectedOutput}`);
  });
  return lines.join('\n').trim();
}

function capText(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * Resolve names to skills, sorting them into usable / unknown / disabled.
 *
 * Best-effort by construction: a store or catalog failure makes the whole
 * request `unknown` rather than throwing into a turn. A disabled name is NOT
 * loaded — `skills.disabled[]` is an operator gate, and a pin cannot be a way
 * around it (the `skill` tool refuses the same names).
 */
export async function resolvePinnedSkills(
  raw: unknown,
  opts: { cwd?: string; home?: string; disabled?: string[] } = {},
): Promise<PinnedSkillResolution> {
  const names = parsePinnedSkillNames(raw);
  const result: PinnedSkillResolution = { pins: [], unknown: [], disabled: [] };
  if (names.length === 0) return result;

  // The policy (machine-wide + this project's own lists) is the gate. An
  // explicit `disabled` list lets a caller/test pin the decision.
  const policy: SkillPolicy | null = opts.disabled
    ? { disabled: opts.disabled.map((d) => d.toLowerCase()), enabled: [] }
    : readSkillPolicy(undefined, opts.cwd);
  const blocked = (id: string): boolean => (policy ? !skillPolicyAllows(id, policy) : false);
  type Resolver = (name: string, roots?: { projectRoot?: string; home?: string }) => Promise<unknown>;
  let resolveSkill: Resolver | null = null;
  try {
    const mod = await import('../tools/skill-tool.js');
    resolveSkill = mod.resolveSkill as unknown as Resolver;
  } catch {
    resolveSkill = null;
  }
  // Resolve against the TURN's workspace when the caller knows it (the
  // dashboard's attached project), never the server's own cwd.
  const roots = opts.cwd ? { projectRoot: opts.cwd, ...(opts.home ? { home: opts.home } : {}) } : {};
  if (!resolveSkill) {
    result.unknown.push(...names);
    return result;
  }

  for (const name of names) {
    if (blocked(name)) {
      result.disabled.push(name);
      continue;
    }
    try {
      const resolved = (await resolveSkill(name, roots)) as
        | {
            id?: string;
            name?: string;
            description?: string;
            body?: string;
            dir?: string;
            files?: string[];
            obligations?: SkillObligations;
            skill?: unknown;
          }
        | null;
      if (!resolved) {
        result.unknown.push(name);
        continue;
      }
      const id = (resolved.id ?? resolved.name ?? name).toLowerCase();
      // A skill can be disabled under its COMPILED id (`skill-api-design`) while
      // the pin named the hub id (`api-design`); `skillPolicyAllows` checks both
      // spellings.
      if (blocked(id)) {
        result.disabled.push(name);
        continue;
      }
      const methodology =
        resolved.body?.trim() || compiledMethodology(resolved.skill) || resolved.description?.trim() || '';
      result.pins.push({
        id,
        name: resolved.name ?? name,
        description: resolved.description ?? '',
        methodology,
        ...(resolved.dir ? { dir: resolved.dir } : {}),
        ...(resolved.files && resolved.files.length > 0 ? { files: resolved.files } : {}),
        ...(resolved.obligations ? { obligations: resolved.obligations } : {}),
      });
    } catch {
      result.unknown.push(name);
    }
  }
  return result;
}

/** Record every pinned skill as LOADED, so obligations/ledgers see it. */
export function recordPinnedSkillLoads(pins: PinnedSkill[]): void {
  for (const pin of pins) {
    try {
      recordSkillLoad({
        id: pin.id,
        name: pin.name,
        ...(pin.dir ? { dir: pin.dir } : {}),
        ...(pin.obligations ? { obligations: pin.obligations } : {}),
      });
    } catch {
      /* best-effort — evidence must never break a turn */
    }
  }
}

/** One line for the surface ("pinned: a, b — unknown: c"). */
export function describePinnedResolution(r: PinnedSkillResolution): string {
  const parts: string[] = [];
  if (r.pins.length > 0) parts.push(`pinned ${r.pins.map((p) => p.name).join(', ')}`);
  if (r.disabled.length > 0) parts.push(`disabled (enable in the Agent Hub) ${r.disabled.join(', ')}`);
  if (r.unknown.length > 0) parts.push(`not found ${r.unknown.join(', ')}`);
  return parts.join(' · ');
}

/**
 * The turn block for pinned skills.
 *
 * Deliberately imperative: the index hint is advisory ("load one ONLY when…"),
 * and this is its opposite — the USER named the skill, so the methodology is in
 * the turn and ignoring it is a visible contradiction. It also carries the
 * escape hatch, because a pin can be wrong: the model may say the skill does not
 * apply, it just may not do that silently.
 */
export function buildPinnedSkillsBlock(pins: PinnedSkill[]): string {
  if (pins.length === 0) return '';
  const parts: string[] = [
    '',
    '## Skills PINNED by the user for this task',
    'The user named these skills explicitly. This is an instruction, not a suggestion: follow',
    'each methodology below as written, and do not swap it for another skill or skip it because',
    'the task looks small. Before applying one, check relevance: if it genuinely does not apply',
    'or would not add value here, say so in one line and continue without its steps — do not force',
    'an irrelevant skill, and never drop a relevant one silently.',
  ];
  let spent = 0;
  let rendered = 0;
  for (const pin of pins) {
    const budget = Math.min(MAX_METHODOLOGY_CHARS, Math.max(0, MAX_BLOCK_CHARS - spent));
    if (budget < 200) break;
    rendered += 1;
    const body = capText(pin.methodology || pin.description || '(no methodology text)', budget);
    spent += body.length;
    parts.push('', `### ${pin.name}${pin.description ? ` — ${capText(pin.description, 300)}` : ''}`, body);
    if (pin.dir) parts.push('', `Skill root: ${pin.dir}`);
    if (pin.files && pin.files.length > 0) {
      parts.push(`Files shipped with it (read with read_file when the methodology says to): ${pin.files.slice(0, 25).join(', ')}`);
    }
    if (pin.obligations) {
      const o = pin.obligations;
      const lines: string[] = [];
      if (o.mustRead.length) lines.push(`must read: ${o.mustRead.join(', ')}`);
      if (o.mustRun.length) lines.push(`must run: ${o.mustRun.join(', ')}`);
      if (o.mustProduce.length) lines.push(`must produce: ${o.mustProduce.join(', ')}`);
      if (o.mustVerify.length) lines.push(`must verify: ${o.mustVerify.join(', ')}`);
      if (lines.length) parts.push('', ...lines.map((l) => `- ${l}`));
    }
  }
  // A cap must never silently DROP a pin — the user named every one of these.
  // Name what did not fit and where it lives, so the model can read it instead
  // of concluding the turn only had the skills printed above.
  const omitted = pins.slice(rendered);
  if (omitted.length > 0) {
    parts.push(
      '',
      'Also pinned in this turn, methodology not shown here for size — read each one before finishing:',
      ...omitted.map((p) => `- ${p.name}${p.dir ? ` (${p.dir}/SKILL.md)` : ''}`),
    );
  }
  return parts.join('\n');
}

/**
 * Resolve + record in one call — the shape every surface needs.
 * Returns the block ('' when nothing usable was pinned) and the resolution so
 * the caller can report unknown/disabled names instead of hiding them.
 */
export async function buildPinnedSkillsForTurn(
  raw: unknown,
  opts: { cwd?: string; home?: string } = {},
): Promise<{ block: string; resolution: PinnedSkillResolution }> {
  const resolution = await resolvePinnedSkills(raw, opts);
  recordPinnedSkillLoads(resolution.pins);
  return { block: buildPinnedSkillsBlock(resolution.pins), resolution };
}
