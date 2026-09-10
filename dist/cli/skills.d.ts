/**
 * SkillsCommand — J3 skills hub + sync (`skills_hub.py` +
 * `npx skills add`).
 *
 * Subcommands:
 *   nuvira skills search <query>                — Search the skills registry
 *   nuvira skills install <name>                — Install a skill from the registry
 *   nuvira skills update                        — Update installed skills to newer versions
 *   nuvira skills list [--origin registry|local] — List installed skills with provenance
 *
 * Distinct from `nuvira skill` (singular): that manages INTERNAL skills compiled
 * from trajectories; `nuvira skills` manages EXTERNAL community skills installed
 * into `<project>/.agents/skills/` (sandboxed, provenance + checksum recorded).
 */
import { Command } from 'commander';
export declare class SkillsCommand {
    create(): Command;
}
/** Kept for clarity in the command help (the source-kind vocabulary). */
export declare const SKILL_SOURCE_KINDS: readonly ["github-raw", "local-dir", "browse-sh", "git-repo"];
//# sourceMappingURL=skills.d.ts.map