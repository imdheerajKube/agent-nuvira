/**
 * SkillCommand — CLI interface for managing and running compiled skills.
 *
 * Subcommands:
 *   nuvira skill list            — List all compiled skills
 *   nuvira skill show <name>     — Show detailed skill definition
 *   nuvira skill run <name>      — Run a skill (directly invokes Orchestrator)
 *   nuvira skill compile         — Force skill compilation from trajectories
 *   nuvira skill search <query>  — Search skills by name/tag/description
 *   nuvira skill gc              — Garbage-collect low-quality skills
 *   nuvira skill quality         — Show skill quality and decay metrics
 *   nuvira skill clear           — Remove all skills
 */
import { Command } from 'commander';
import { ConfigManager } from '../config/manager.js';
export declare class SkillCommand {
    private configManager;
    constructor(configManager?: ConfigManager);
    create(): Command;
    private listSkills;
    private showSkill;
    private runSkill;
    private compileSkills;
    private searchSkills;
    private garbageCollect;
    private showQuality;
    private clearSkills;
}
//# sourceMappingURL=skill.d.ts.map