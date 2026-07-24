/**
 * SkillCommand — CLI interface for managing and running compiled skills.
 *
 * Subcommands:
 *   buff skill list            — List all compiled skills
 *   buff skill show <name>     — Show detailed skill definition
 *   buff skill run <name>      — Run a skill (directly invokes Orchestrator)
 *   buff skill compile         — Force skill compilation from trajectories
 *   buff skill search <query>  — Search skills by name/tag/description
 *   buff skill gc              — Garbage-collect low-quality skills
 *   buff skill quality         — Show skill quality and decay metrics
 *   buff skill clear           — Remove all skills
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