/**
 * Skills Hub — Source adapters and hub state management.
 *
 * Hermes equivalent: skills_hub.py (4,432 lines)
 *
 * Provides:
 * - Skill source adapters (GitHub, local, optional)
 * - Skill installation and uninstallation
 * - Provenance tracking (lock file)
 * - Hub state directory management
 * - Index caching
 * - Quarantine system for untrusted skills
 */
export interface SkillSource {
    name: string;
    type: 'github' | 'local' | 'optional' | 'url';
    fetch(name: string): Promise<SkillManifest>;
    list?(): Promise<SkillManifest[]>;
}
export interface SkillManifest {
    name: string;
    version: string;
    description: string;
    author?: string;
    tags?: string[];
    source: string;
    sourceHash: string;
    installedAt?: number;
}
export interface LockEntry {
    name: string;
    source: string;
    sourceHash: string;
    installedAt: number;
    version: string;
}
export declare class GitHubSource implements SkillSource {
    name: string;
    type: "github";
    private owner;
    private repo;
    private path;
    constructor(owner: string, repo: string, path?: string);
    fetch(skillName: string): Promise<SkillManifest>;
    list(): Promise<SkillManifest[]>;
    private parseSkillMd;
}
export declare class LocalSource implements SkillSource {
    name: string;
    type: "local";
    private dir;
    constructor(dir: string);
    fetch(skillName: string): Promise<SkillManifest>;
    list(): Promise<SkillManifest[]>;
    private parseSkillMd;
}
export declare class SkillsHubManager {
    private hubDir;
    private lockFile;
    private quarantineDir;
    private auditLog;
    private indexCacheDir;
    private sources;
    constructor();
    private ensureDirs;
    /**
     * Register a skill source.
     */
    registerSource(source: SkillSource): void;
    /**
     * Install a skill from a source.
     */
    install(sourceName: string, skillName: string, targetDir: string): Promise<SkillManifest>;
    /**
     * Uninstall a skill.
     */
    uninstall(skillName: string, targetDir: string): Promise<boolean>;
    /**
     * List installed skills.
     */
    listInstalled(targetDir: string): Promise<LockEntry[]>;
    /**
     * List available skills from all sources.
     */
    listAvailable(): Promise<SkillManifest[]>;
    /**
     * Get skill info.
     */
    getInfo(skillName: string, targetDir: string): Promise<{
        manifest?: SkillManifest;
        lock?: LockEntry;
        installed: boolean;
    }>;
    private readLock;
    private writeLock;
    private audit;
}
export declare function getSkillsHubManager(): SkillsHubManager;
export declare function resetSkillsHubManager(): void;
//# sourceMappingURL=skills-hub.d.ts.map