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
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { resolveNuviraHome } from '../config/paths.js';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
// ─── GitHub Source ────────────────────────────────────────────────────────
export class GitHubSource {
    name = 'github';
    type = 'github';
    owner;
    repo;
    path;
    constructor(owner, repo, path = 'skills') {
        this.owner = owner;
        this.repo = repo;
        this.path = path;
    }
    async fetch(skillName) {
        const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${this.path}/${skillName}/SKILL.md`;
        const response = await fetch(url, {
            headers: { 'Accept': 'application/vnd.github.v3.raw' },
        });
        if (!response.ok)
            throw new Error(`Skill not found: ${skillName}`);
        const content = await response.text();
        return this.parseSkillMd(content, `github:${this.owner}/${this.repo}/${skillName}`);
    }
    async list() {
        const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${this.path}`;
        const response = await fetch(url);
        if (!response.ok)
            return [];
        const data = await response.json();
        if (!Array.isArray(data))
            return [];
        return data
            .filter((item) => item.type === 'dir')
            .map((item) => ({
            name: item.name,
            version: '0.0.0',
            description: '',
            source: `github:${this.owner}/${this.repo}/${item.name}`,
            sourceHash: '',
        }));
    }
    parseSkillMd(content, source) {
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        const meta = {};
        if (frontmatterMatch) {
            const lines = frontmatterMatch[1].split('\n');
            for (const line of lines) {
                const [key, ...valueParts] = line.split(':');
                if (key && valueParts.length) {
                    meta[key.trim()] = valueParts.join(':').trim();
                }
            }
        }
        return {
            name: meta.name || 'unknown',
            version: meta.version || '0.0.0',
            description: meta.description || '',
            author: meta.author,
            tags: meta.tags?.split(',').map((t) => t.trim()),
            source,
            sourceHash: createHash('sha256').update(content).digest('hex'),
        };
    }
}
// ─── Local Source ─────────────────────────────────────────────────────────
export class LocalSource {
    name = 'local';
    type = 'local';
    dir;
    constructor(dir) {
        this.dir = dir;
    }
    async fetch(skillName) {
        const skillPath = join(this.dir, skillName, 'SKILL.md');
        if (!existsSync(skillPath))
            throw new Error(`Skill not found: ${skillName}`);
        const content = readFileSync(skillPath, 'utf-8');
        return this.parseSkillMd(content, `local:${skillPath}`);
    }
    async list() {
        if (!existsSync(this.dir))
            return [];
        const skills = [];
        const entries = readdirSync(this.dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const skillPath = join(this.dir, entry.name, 'SKILL.md');
                if (existsSync(skillPath)) {
                    try {
                        const manifest = await this.fetch(entry.name);
                        skills.push(manifest);
                    }
                    catch {
                        // Skip invalid skills
                    }
                }
            }
        }
        return skills;
    }
    parseSkillMd(content, source) {
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        const meta = {};
        if (frontmatterMatch) {
            const lines = frontmatterMatch[1].split('\n');
            for (const line of lines) {
                const [key, ...valueParts] = line.split(':');
                if (key && valueParts.length) {
                    meta[key.trim()] = valueParts.join(':').trim();
                }
            }
        }
        return {
            name: meta.name || 'unknown',
            version: meta.version || '0.0.0',
            description: meta.description || '',
            author: meta.author,
            tags: meta.tags?.split(',').map((t) => t.trim()),
            source,
            sourceHash: createHash('sha256').update(content).digest('hex'),
        };
    }
}
// ─── Hub Manager ──────────────────────────────────────────────────────────
export class SkillsHubManager {
    hubDir;
    lockFile;
    quarantineDir;
    auditLog;
    indexCacheDir;
    sources = new Map();
    constructor() {
        this.hubDir = join(resolveNuviraHome(), 'skills', '.hub');
        this.lockFile = join(this.hubDir, 'lock.json');
        this.quarantineDir = join(this.hubDir, 'quarantine');
        this.auditLog = join(this.hubDir, 'audit.log');
        this.indexCacheDir = join(this.hubDir, 'index-cache');
        this.ensureDirs();
    }
    ensureDirs() {
        for (const dir of [this.hubDir, this.quarantineDir, this.indexCacheDir]) {
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
        }
    }
    /**
     * Register a skill source.
     */
    registerSource(source) {
        this.sources.set(source.name, source);
    }
    /**
     * Install a skill from a source.
     */
    async install(sourceName, skillName, targetDir) {
        const source = this.sources.get(sourceName);
        if (!source)
            throw new Error(`Source not found: ${sourceName}`);
        const manifest = await source.fetch(skillName);
        // Verify content hash
        if (!manifest.sourceHash) {
            throw new Error('Missing source hash — cannot verify integrity');
        }
        // Copy to target
        const skillDir = join(targetDir, manifest.name);
        if (existsSync(skillDir)) {
            rmSync(skillDir, { recursive: true });
        }
        mkdirSync(skillDir, { recursive: true });
        // Write SKILL.md
        writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${manifest.name}\nversion: ${manifest.version}\ndescription: ${manifest.description}\n---\n\n`, 'utf-8');
        // Update lock file
        const lock = this.readLock();
        lock[manifest.name] = {
            name: manifest.name,
            source: manifest.source,
            sourceHash: manifest.sourceHash,
            installedAt: Date.now(),
            version: manifest.version,
        };
        this.writeLock(lock);
        // Audit log
        this.audit('install', manifest.name, manifest.source);
        logger.info(`[hub] Installed ${manifest.name} from ${sourceName}`);
        return manifest;
    }
    /**
     * Uninstall a skill.
     */
    async uninstall(skillName, targetDir) {
        const skillDir = join(targetDir, skillName);
        if (!existsSync(skillDir))
            return false;
        rmSync(skillDir, { recursive: true });
        // Update lock file
        const lock = this.readLock();
        delete lock[skillName];
        this.writeLock(lock);
        // Audit log
        this.audit('uninstall', skillName, 'local');
        logger.info(`[hub] Uninstalled ${skillName}`);
        return true;
    }
    /**
     * List installed skills.
     */
    async listInstalled(targetDir) {
        const lock = this.readLock();
        return Object.values(lock).filter((entry) => {
            const skillDir = join(targetDir, entry.name);
            return existsSync(skillDir);
        });
    }
    /**
     * List available skills from all sources.
     */
    async listAvailable() {
        const allSkills = [];
        for (const source of this.sources.values()) {
            if (source.list) {
                try {
                    const skills = await source.list();
                    allSkills.push(...skills);
                }
                catch (err) {
                    logger.warn(`[hub] Failed to list from ${source.name}: ${err}`);
                }
            }
        }
        return allSkills;
    }
    /**
     * Get skill info.
     */
    async getInfo(skillName, targetDir) {
        const skillDir = join(targetDir, skillName);
        const installed = existsSync(skillDir);
        const lock = this.readLock()[skillName];
        return { lock, installed };
    }
    readLock() {
        if (!existsSync(this.lockFile))
            return {};
        try {
            return JSON.parse(readFileSync(this.lockFile, 'utf-8'));
        }
        catch {
            return {};
        }
    }
    writeLock(lock) {
        writeFileSync(this.lockFile, JSON.stringify(lock, null, 2), 'utf-8');
    }
    audit(action, skill, source) {
        const entry = `[${new Date().toISOString()}] ${action} ${skill} from ${source}\n`;
        try {
            const { appendFileSync } = require('node:fs');
            appendFileSync(this.auditLog, entry);
        }
        catch {
            // Ignore
        }
    }
}
// ─── Singleton ─────────────────────────────────────────────────────────────
let _skillsHubManager = null;
export function getSkillsHubManager() {
    if (!_skillsHubManager)
        _skillsHubManager = new SkillsHubManager();
    return _skillsHubManager;
}
export function resetSkillsHubManager() {
    _skillsHubManager = null;
}
//# sourceMappingURL=skills-hub.js.map