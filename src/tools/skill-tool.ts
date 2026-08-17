/**
 * P0.8 — Skill tool (load reusable capability packs in chat).
 *
 * The chat agent can now SAY "load the code-assessment skill" — the skill
 * store existed but was unreachable from the dashboard chat (round-3 finding,
 * matrix rows 16 + 27). This tool closes it: given a skill name/id (+
 * optional params), it loads the methodology from EITHER source the CLI
 * surfaces and hands it to the model:
 *
 *   - COMPILED skills (SkillStore, `buff skill list`) — returns the full
 *     methodology (parameters + ordered steps with agent types), resolves
 *     {{param}} placeholders in step prompts (SkillRunnerAgent parity), and
 *     marks the skill used.
 *   - HUB skills (`buff skills install` → SKILL.md under .agents/skills/ or
 *     ~/.buff/skills/) — returns name + description + the SKILL.md body
 *     (progressive disclosure Level 1: methodology to adapt, never literal
 *     commands).
 *
 * Unknown skill → lists what IS available (both sources), so the model
 * learns the catalog instead of guessing. A DISABLED skill (config
 * `skills.disabled[]`) is refused — the same match gate the orchestrator
 * honors, so the tool never silently injects a disabled capability.
 *
 * Best-effort by construction: store/catalog read failures return a helpful
 * error string, never a throw (a skill load must never kill the turn).
 */

import type { ToolContext } from './registry.js';
import type { Skill, SkillParameter } from '../learning/skill-types.js';
import { SkillCompiler } from '../learning/skill-compiler.js';

/** The tool's args (zod-validated in the registry). */
export interface SkillToolArgs {
  /** Skill name or id to load (e.g. "website-deploy" or "skill-website-deploy"). */
  skill?: string;
  /** Optional --param=value overrides resolved into {{param}} placeholders. */
  params?: Record<string, string>;
}

/** A resolved skill + its source (for listing / loading). */
interface ResolvedSkill {
  kind: 'compiled' | 'hub';
  /** Display name. */
  name: string;
  /** One-line description. */
  description: string;
  /** Id (store id or hub directory name). */
  id: string;
  /** Compiled skill (kind === 'compiled'). */
  skill?: Skill;
  /** Hub SKILL.md body (kind === 'hub'). */
  body?: string;
}

/**
 * Resolve a skill by name/id from both sources. Compiled store first (its id
 * is the deterministic seed id), then hub catalog by id or name. Returns null
 * when nothing matches.
 */
export async function resolveSkill(name: string): Promise<ResolvedSkill | null> {
  const { getSkillStore } = await import('../learning/skill-store.js');

  // 1. Compiled store: exact id, then name search.
  let store = getSkillStore();
  let compiled: Skill | null = null;
  try {
    compiled = store.get(name) ?? null;
    if (!compiled) {
      const matches = store.search(name);
      if (matches.length > 0) compiled = matches[0];
    }
  } catch {
    compiled = null;
  }
  if (compiled) {
    return {
      kind: 'compiled',
      name: compiled.name,
      description: compiled.description,
      id: compiled.id,
      skill: compiled,
    };
  }

  // 2. Hub catalog: SKILL.md under <project>/.agents/skills/ or ~/.buff/skills/.
  try {
    const { readHubCatalog } = await import('../learning/hub-skill-catalog.js');
    const catalog = readHubCatalog();
    const match =
      catalog.find((s) => s.id === name || s.name === name) ??
      catalog.find((s) => s.name.toLowerCase().includes(name.toLowerCase()));
    if (match) {
      return { kind: 'hub', name: match.name, description: match.description, id: match.id, body: match.body };
    }
  } catch {
    // best-effort — fall through to the listing path
  }

  return null;
}

/** Every known skill, both sources (deduped by id — compiled wins the name). */
export async function listAllSkills(): Promise<ResolvedSkill[]> {
  const out: ResolvedSkill[] = [];
  const seen = new Set<string>();
  try {
    const { getSkillStore } = await import('../learning/skill-store.js');
    const compiled = getSkillStore().getAll();
    for (const s of compiled) {
      seen.add(s.id);
      out.push({ kind: 'compiled', name: s.name, description: s.description, id: s.id, skill: s });
    }
  } catch {
    /* best-effort */
  }
  try {
    const { readHubCatalog } = await import('../learning/hub-skill-catalog.js');
    for (const s of readHubCatalog()) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({ kind: 'hub', name: s.name, description: s.description, id: s.id, body: s.body });
    }
  } catch {
    /* best-effort */
  }
  return out;
}

/** Is the skill disabled via config `skills.disabled[]`? (match-gate parity). */
function isSkillDisabled(id: string, name: string, ctx: ToolContext): boolean {
  try {
    const cm = ctx.configManager;
    const cfg = cm?.getAll?.();
    const disabled = cfg?.skills?.disabled;
    if (!Array.isArray(disabled)) return false;
    return disabled.includes(id) || disabled.includes(name);
  } catch {
    return false;
  }
}

/** Resolve {{param}} placeholders (SkillRunnerAgent parity) into a template. */
function resolvePlaceholders(template: string, params: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(params)) {
    out = out.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return out;
}

/** The methodology the model sees for a compiled skill (full detail). */
function compiledMethodology(skill: Skill, params: Record<string, string>): string {
  const paramLine =
    skill.parameters.length === 0
      ? '   Parameters: (none)'
      : skill.parameters
          .map((p: SkillParameter) => `   • ${p.name}: ${p.description}${p.required ? ' (required)' : ''}`)
          .join('\n');
  const steps = skill.steps
    .map((step, i) => {
      const deps = step.dependsOn.length > 0 ? ` (after: ${step.dependsOn.join(', ')})` : '';
      return `   ${i}. [${step.agentType}] ${resolvePlaceholders(step.description, params)}${deps}`;
    })
    .join('\n');
  return [
    `🧠 ${skill.name} v${skill.version} — ${skill.description}`,
    `   Goal: ${skill.goalPattern} | Quality: ${(skill.qualityScore * 100).toFixed(0)}% | Used: ${skill.usageCount}x`,
    paramLine,
    '',
    `   Steps (${skill.steps.length}):`,
    steps,
  ].join('\n');
}

/** The methodology the model sees for a hub (SKILL.md) skill. */
function hubMethodology(resolved: ResolvedSkill): string {
  return [
    `🧠 ${resolved.name} — ${resolved.description}`,
    `   (hub skill — SKILL.md methodology)`,
    '',
    resolved.body ?? '(no body)',
  ].join('\n');
}

/**
 * Run the skill tool: load a capability pack and return its methodology.
 * Never throws — every failure mode returns a helpful string.
 */
export async function runSkillTool(args: SkillToolArgs, ctx: ToolContext): Promise<string> {
  const name = (args?.skill ?? '').trim();
  const params = args?.params && typeof args.params === 'object' ? args.params : {};

  // Load requested skill.
  if (name) {
    const resolved = await resolveSkill(name);
    if (!resolved) {
      const available = await listAllSkills();
      if (available.length === 0) {
        return 'No skills found. Install one with `buff skills install <name>` — or ask the agent to run tasks with memory to compile one.';
      }
      const list = available
        .map((s) => `  • ${s.name} (${s.id}) — ${s.description}`)
        .join('\n');
      return `Skill not found: '${name}'. Available skills:\n${list}`;
    }

    // Disabled skills are refused (match-gate parity — never silently inject).
    if (isSkillDisabled(resolved.id, resolved.name, ctx)) {
      return `Error: skill '${resolved.name}' is disabled — enable it in the Agent Hub Skills tab (or remove it from skills.disabled in config).`;
    }

    if (resolved.kind === 'compiled' && resolved.skill) {
      // Mark used (best-effort — a store failure must never break the load).
      try {
        const { getSkillStore } = await import('../learning/skill-store.js');
        getSkillStore().markUsed(resolved.skill.id);
      } catch {
        /* best-effort */
      }
      return compiledMethodology(resolved.skill, params);
    }
    return hubMethodology(resolved);
  }

  // No name → list everything (both sources), so the model learns the catalog.
  const available = await listAllSkills();
  if (available.length === 0) {
    return 'No skills available. Install one with `buff skills install <name>` (hub), or run tasks with memory to compile one.';
  }
  const list = available
    .map((s) => `  • ${s.name} (${s.id}) — ${s.description}`)
    .join('\n');
  return `Available skills (${available.length}):\n${list}\n\nLoad one with the skill tool (skill: "<name>").`;
}

// Re-export the formatter for tests that need the CLI-parity formatting.
export { SkillCompiler };
