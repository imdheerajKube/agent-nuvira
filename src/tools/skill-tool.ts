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
  /** P6b — bundle slug to load (loads every member skill in one result). */
  bundle?: string;
  /** P6a — /learn-style authoring: manage a skill DRAFT. */
  manage?: {
    action: 'create' | 'patch' | 'write_file' | 'delete';
    name: string;
    markdown?: string;
    oldText?: string;
    newText?: string;
    file?: string;
    content?: string;
  };
}

/**
 * P6a — the structured draft payload the GUI renders as a preview card
 * (accept / edit / reject). Emitted via ctx.emit('skill:draft') — the same
 * channel the git tool uses for diff cards.
 */
export interface SkillDraftPayload {
  name: string;
  description: string;
  markdown: string;
  updatedAt: number;
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
  /** P6c — hub frontmatter depth (surfaced as setup hints, values never read). */
  platforms?: string[];
  requiresToolsets?: string[];
  fallbackForToolsets?: string[];
  config?: Record<string, string>;
  requiredEnvVars?: string[];
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
  //    P6c — the MATCHABLE catalog applies the platform + toolset gates, so a
  //    skill for another OS (or one whose required toolset is off) is never
  //    injected. The env-var/config declarations ride along for setup hints.
  try {
    const { listMatchableHubSkills } = await import('../learning/hub-skill-catalog.js');
    const catalog = listMatchableHubSkills();
    const match =
      catalog.find((s) => s.id === name || s.name === name) ??
      catalog.find((s) => s.name.toLowerCase().includes(name.toLowerCase()));
    if (match) {
      return {
        kind: 'hub',
        name: match.name,
        description: match.description,
        id: match.id,
        body: match.body,
        platforms: match.platforms,
        requiresToolsets: match.requiresToolsets,
        fallbackForToolsets: match.fallbackForToolsets,
        config: match.config,
        requiredEnvVars: match.requiredEnvVars,
      };
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
    const { listMatchableHubSkills } = await import('../learning/hub-skill-catalog.js');
    for (const s of listMatchableHubSkills()) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({
        kind: 'hub',
        name: s.name,
        description: s.description,
        id: s.id,
        body: s.body,
        platforms: s.platforms,
        requiresToolsets: s.requiresToolsets,
        fallbackForToolsets: s.fallbackForToolsets,
        config: s.config,
        requiredEnvVars: s.requiredEnvVars,
      });
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

/**
 * The methodology the model sees for a hub (SKILL.md) skill. P6c — declared
 * env vars / config / toolset deps are surfaced as SETUP HINTS (names only,
 * values are never read or printed — secure setup on load).
 */
function hubMethodology(resolved: ResolvedSkill): string {
  const hints: string[] = [];
  if (resolved.requiredEnvVars && resolved.requiredEnvVars.length > 0) {
    hints.push(`   Requires env vars (set before running): ${resolved.requiredEnvVars.join(', ')}`);
  }
  if (resolved.config && Object.keys(resolved.config).length > 0) {
    hints.push(`   Declared config keys: ${Object.keys(resolved.config).join(', ')}`);
  }
  if (resolved.requiresToolsets && resolved.requiresToolsets.length > 0) {
    hints.push(`   Needs toolsets: ${resolved.requiresToolsets.join(', ')}`);
  }
  if (resolved.fallbackForToolsets && resolved.fallbackForToolsets.length > 0) {
    hints.push(`   Fallback for (active when absent): ${resolved.fallbackForToolsets.join(', ')}`);
  }
  return [
    `🧠 ${resolved.name} — ${resolved.description}`,
    `   (hub skill — SKILL.md methodology)`,
    ...hints,
    '',
    resolved.body ?? '(no body)',
  ].join('\n');
}

/**
 * P6b — load a bundle: every member skill's methodology in ONE result.
 * Missing members are skipped (Hermes parity) with a visible note, never
 * fatal — a bundle referencing a not-yet-installed skill still delivers the
 * skills that DO exist. Returns a helpful string on any failure (never
 * throws), listing bundles when the slug is unknown or "list".
 */
async function runBundleLoad(bundleSlug: string): Promise<string> {
  const { listBundles, getBundle } = await import('../learning/skill-bundles.js');
  if (bundleSlug === 'list') {
    const bundles = listBundles();
    if (bundles.length === 0) {
      return 'No bundles yet. Create one with `buff skills bundle create <slug> --skills a,b,c` (or ask the agent to compose one).';
    }
    const list = bundles
      .map((b) => `  • ${b.name} (${b.slug}) — ${b.description}\n      skills: ${b.skills.join(', ')}`)
      .join('\n');
    return `Available bundles (${bundles.length}):\n${list}\n\nLoad one with the skill tool (bundle: "<slug>").`;
  }

  const bundle = getBundle(bundleSlug);
  if (!bundle) {
    const { listBundles: listAll } = await import('../learning/skill-bundles.js');
    const bundles = listAll();
    if (bundles.length === 0) {
      return `Bundle '${bundleSlug}' not found and no bundles exist. Create one with \`buff skills bundle create <slug> --skills a,b,c\`.`;
    }
    const list = bundles.map((b) => `  • ${b.name} (${b.slug})`).join('\n');
    return `Bundle '${bundleSlug}' not found. Available bundles:\n${list}`;
  }

  const parts: string[] = [];
  const missing: string[] = [];
  for (const member of bundle.skills) {
    const resolved = await resolveSkill(member);
    if (!resolved) {
      missing.push(member);
      continue;
    }
    if (resolved.kind === 'compiled' && resolved.skill) {
      try {
        const { getSkillStore } = await import('../learning/skill-store.js');
        getSkillStore().markUsed(resolved.skill.id);
      } catch {
        /* best-effort */
      }
      parts.push(compiledMethodology(resolved.skill, {}));
    } else {
      parts.push(hubMethodology(resolved));
    }
  }

  if (parts.length === 0) {
    return `Bundle '${bundleSlug}' has no loadable members (none of: ${bundle.skills.join(', ')} are installed). Install or compile them first.`;
  }

  const header = `🧩 Bundle: ${bundle.name} (${bundle.slug}) — ${bundle.description}\n`;
  const missingNote =
    missing.length > 0
      ? `\n⚠️ Skipped (not installed): ${missing.join(', ')} — install them with \`buff skills install <name>\` to include them.`
      : '';
  return `${header}${parts.join('\n\n')}${missingNote}`;
}

/**
 * Run the skill tool: load a capability pack and return its methodology.
 * Never throws — every failure mode returns a helpful string.
 */
/**
 * P6a — run a skill_manage action against the draft store. Every write goes
 * through the DRAFT (the preview card is the gate); accept happens on the
 * dashboard server (POST /api/skills/drafts/:name/accept). Never throws —
 * each failure mode returns a helpful string. On create/patch, emits the
 * structured draft payload for the GUI preview card (best-effort).
 */
async function runSkillManage(manage: NonNullable<SkillToolArgs['manage']>, ctx: ToolContext): Promise<string> {
  const { writeDraft, getDraft, writeDraftFile, deleteDraft } = await import('../learning/skill-drafts.js');
  const action = manage.action;
  const name = (manage.name ?? '').trim();

  if (!name) {
    return 'Error: skill_manage needs a name (the draft id, ^[a-z0-9-]+$).';
  }

  if (action === 'create') {
    const markdown = manage.markdown ?? '';
    const result = writeDraft(name, markdown);
    if (!result.ok) {
      return `Error: ${result.reason}`;
    }
    const draft = getDraft(name);
    if (draft) {
      const payload: SkillDraftPayload = {
        name: draft.name,
        description: draft.description,
        markdown: draft.markdown,
        updatedAt: draft.updatedAt,
      };
      try {
        ctx.emit?.('skill:draft', payload);
      } catch {
        /* best-effort — the model still sees the text below */
      }
    }
    return [
      `✅ Draft skill '${name}' created — it is PENDING (not saved as a real skill yet).`,
      `   The user sees a preview card now: ✅ accept (saves it), ✏️ edit (you revise it), ↩ reject (discards it).`,
      `   Description: ${draft?.description ?? ''}`,
      `   Wait for the user's decision before proceeding. If they ask for changes, revise with action: create again (overwrites the draft) or action: patch.`,
    ].join('\n');
  }

  if (action === 'patch') {
    const oldText = manage.oldText ?? '';
    const newText = manage.newText ?? '';
    if (!oldText) {
      return 'Error: skill_manage patch needs oldText (the exact text to replace).';
    }
    const draft = getDraft(name);
    if (!draft) {
      return `Error: no draft '${name}' to patch — create one first (action: create).`;
    }
    if (!draft.markdown.includes(oldText)) {
      return `Error: the old text was not found in draft '${name}' — use exact text from the draft.`;
    }
    const updated = draft.markdown.split(oldText).join(newText);
    const result = writeDraft(name, updated);
    if (!result.ok) {
      return `Error: ${result.reason}`;
    }
    const after = getDraft(name);
    if (after) {
      try {
        ctx.emit?.('skill:draft', {
          name: after.name,
          description: after.description,
          markdown: after.markdown,
          updatedAt: after.updatedAt,
        } as SkillDraftPayload);
      } catch {
        /* best-effort */
      }
    }
    return `✅ Patched draft '${name}' (old→new applied). The preview card updates — wait for the user's decision.`;
  }

  if (action === 'write_file') {
    const file = (manage.file ?? '').trim();
    if (!file) {
      return 'Error: skill_manage write_file needs a file path (relative to the draft dir).';
    }
    const result = writeDraftFile(name, file, manage.content ?? '');
    if (!result.ok) return `Error: ${result.reason}`;
    return `✅ Added reference file '${file}' to draft '${name}'.`;
  }

  // action === 'delete' (the preview card's reject, or an explicit abort).
  const removed = deleteDraft(name);
  return removed
    ? `🗑️  Deleted draft '${name}' — nothing was saved.`
    : `No draft '${name}' found — nothing to delete.`;
}

export async function runSkillTool(args: SkillToolArgs, ctx: ToolContext): Promise<string> {
  const name = (args?.skill ?? '').trim();
  const params = args?.params && typeof args.params === 'object' ? args.params : {};

  // P6a — skill_manage actions run FIRST (authoring takes precedence over
  // loading — the model cannot accidentally load while managing).
  if (args?.manage) {
    return runSkillManage(args.manage, ctx);
  }

  // P6b — bundle load takes precedence: one call, every member methodology.
  const bundleSlug = (args?.bundle ?? '').trim();
  if (bundleSlug) {
    return runBundleLoad(bundleSlug);
  }

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
