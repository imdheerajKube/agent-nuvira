/**
 * Hub export — render bundled skills into the `.agents/skills/` registry
 * layout (P5c #3: "populate repo .agents/skills/ with the bundled skills").
 *
 * The configured default registry is
 *   https://raw.githubusercontent.com/imdheerajKube/agent-nuvira/main/.agents/skills
 * which 404s today because the repo has no `.agents/skills/` dir. Shipping
 * the bundled skills in that layout makes the default registry RESOLVE —
 * `nuvira skills search` / `nuvira skills install` then find the first-party
 * batch from the same sources the store seeds.
 *
 * The generation is deliberately pure (fixture-testable): `hubIndexFor`
 * renders the HubIndex contract, `skillMdFor` renders a SKILL.md with
 * frontmatter + the full methodology (parameters + ordered steps with agent
 * types and dependencies) — the same depth bar the skill-compiler displays.
 *
 * Wired from scripts/sync-hub-skills.mjs (runs against the built dist); the
 * generated files are COMMITTED so the registry resolves without a build.
 */
import type { Skill } from './skill-types.js';
/** The index entry contract the registry expects (skills-hub HubSkillEntry). */
export interface HubExportEntry {
    name: string;
    description: string;
    version: string;
    author: string;
    tags: string[];
    source: string;
    updatedAt: string;
}
/** Render the registry index.json for a set of bundled skills. */
export declare function hubIndexFor(skills: Skill[], updatedAt?: string): {
    version: number;
    updatedAt: string;
    skills: HubExportEntry[];
};
/**
 * Render a SKILL.md for one bundled skill: frontmatter (name must match the
 * index entry — install validates that) + the full methodology body.
 */
export declare function skillMdFor(skill: Skill): string;
/**
 * Write the `.agents/skills/` layout for a set of bundled skills: index.json
 * + `<name>/SKILL.md` per skill. Returns the written file paths.
 */
export declare function writeHubSkills(skills: Skill[], outDir: string): string[];
//# sourceMappingURL=hub-export.d.ts.map