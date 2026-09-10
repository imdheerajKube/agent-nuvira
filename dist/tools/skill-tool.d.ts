/**
 * P0.8 — Skill tool (load reusable capability packs in chat).
 *
 * The chat agent can now SAY "load the code-assessment skill" — the skill
 * store existed but was unreachable from the dashboard chat (round-3 finding,
 * matrix rows 16 + 27). This tool closes it: given a skill name/id (+
 * optional params), it loads the methodology from EITHER source the CLI
 * surfaces and hands it to the model:
 *
 *   - COMPILED skills (SkillStore, `nuvira skill list`) — returns the full
 *     methodology (parameters + ordered steps with agent types), resolves
 *     {{param}} placeholders in step prompts (SkillRunnerAgent parity), and
 *     marks the skill used.
 *   - HUB skills (`nuvira skills install` → SKILL.md under .agents/skills/ or
 *     ~/.nuvira/skills/) — returns name + description + the SKILL.md body
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
import type { Skill } from '../learning/skill-types.js';
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
        action: 'create' | 'patch' | 'write_file' | 'delete' | 'learn';
        name: string;
        markdown?: string;
        oldText?: string;
        newText?: string;
        file?: string;
        content?: string;
        /** P6a — learn action: sources to learn from (URLs, file paths, or description text). */
        sources?: string[];
    };
    /** Execute a skill as a script (Python, JS, shell) — language-agnostic marketplace execution. */
    execute?: {
        /** Skill name or path to execute */
        skill: string;
        /** Runtime override (python, node, shell, auto) */
        runtime?: 'python' | 'node' | 'shell' | 'auto';
        /** Arguments to pass to the script */
        args?: string[];
        /** Additional env vars to inject */
        env?: Record<string, string>;
        /** Timeout in milliseconds (default: 30000) */
        timeoutMs?: number;
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
export declare function resolveSkill(name: string): Promise<ResolvedSkill | null>;
/** Every known skill, both sources (deduped by id — compiled wins the name). */
export declare function listAllSkills(): Promise<ResolvedSkill[]>;
export declare function runSkillTool(args: SkillToolArgs, ctx: ToolContext): Promise<string>;
export { SkillCompiler };
//# sourceMappingURL=skill-tool.d.ts.map