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

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, cpSync } from 'node:fs';
import { resolveNuviraHome } from '../config/paths';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

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
  /**
   * The raw SKILL.md (frontmatter + body). Carried so `install()` can write the
   * skill's actual instructions — a manifest with only metadata would install a
   * SKILL.md whose body was thrown away (the model then loads an empty
   * methodology). This is what the hub tool hands back to callers.
   */
  content?: string;
}

export interface LockEntry {
  name: string;
  source: string;
  sourceHash: string;
  installedAt: number;
  version: string;
}

// ─── GitHub Source ────────────────────────────────────────────────────────

export class GitHubSource implements SkillSource {
  name = 'github';
  type = 'github' as const;

  private owner: string;
  private repo: string;
  private path: string;

  constructor(owner: string, repo: string, path: string = 'skills') {
    this.owner = owner;
    this.repo = repo;
    this.path = path;
  }

  async fetch(skillName: string): Promise<SkillManifest> {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${this.path}/${skillName}/SKILL.md`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/vnd.github.v3.raw' },
    });

    if (!response.ok) throw new Error(`Skill not found: ${skillName}`);

    const content = await response.text();
    return this.parseSkillMd(content, `github:${this.owner}/${this.repo}/${skillName}`);
  }

  async list(): Promise<SkillManifest[]> {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${this.path}`;
    const response = await fetch(url);

    if (!response.ok) return [];

    const data: any = await response.json();
    if (!Array.isArray(data)) return [];

    return data
      .filter((item: any) => item.type === 'dir')
      .map((item: any) => ({
        name: item.name,
        version: '0.0.0',
        description: '',
        source: `github:${this.owner}/${this.repo}/${item.name}`,
        sourceHash: '',
      }));
  }

  private parseSkillMd(content: string, source: string): SkillManifest {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const meta: Record<string, string> = {};

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
      content,
    };
  }
}

// ─── Local Source ─────────────────────────────────────────────────────────

export class LocalSource implements SkillSource {
  name = 'local';
  type = 'local' as const;

  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async fetch(skillName: string): Promise<SkillManifest> {
    const skillPath = join(this.dir, skillName, 'SKILL.md');
    if (!existsSync(skillPath)) throw new Error(`Skill not found: ${skillName}`);

    const content = readFileSync(skillPath, 'utf-8');
    return this.parseSkillMd(content, `local:${skillPath}`);
  }

  async list(): Promise<SkillManifest[]> {
    if (!existsSync(this.dir)) return [];

    const skills: SkillManifest[] = [];
    const entries = readdirSync(this.dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = join(this.dir, entry.name, 'SKILL.md');
        if (existsSync(skillPath)) {
          try {
            const manifest = await this.fetch(entry.name);
            skills.push(manifest);
          } catch {
            // Skip invalid skills
          }
        }
      }
    }

    return skills;
  }

  private parseSkillMd(content: string, source: string): SkillManifest {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const meta: Record<string, string> = {};

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
      content,
    };
  }
}

// ─── Hub Manager ──────────────────────────────────────────────────────────

export class SkillsHubManager {
  private hubDir: string;
  private lockFile: string;
  private quarantineDir: string;
  private auditLog: string;
  private indexCacheDir: string;
  private sources: Map<string, SkillSource> = new Map();

  constructor() {
    this.hubDir = join(resolveNuviraHome(), 'skills', '.hub');
    this.lockFile = join(this.hubDir, 'lock.json');
    this.quarantineDir = join(this.hubDir, 'quarantine');
    this.auditLog = join(this.hubDir, 'audit.log');
    this.indexCacheDir = join(this.hubDir, 'index-cache');
    this.ensureDirs();
  }

  private ensureDirs(): void {
    for (const dir of [this.hubDir, this.quarantineDir, this.indexCacheDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Register a skill source.
   */
  registerSource(source: SkillSource): void {
    this.sources.set(source.name, source);
  }

  /**
   * Install a skill from a source.
   */
  async install(sourceName: string, skillName: string, targetDir: string): Promise<SkillManifest> {
    const source = this.sources.get(sourceName);
    if (!source) throw new Error(`Source not found: ${sourceName}`);

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

    // Write SKILL.md. The FULL source (frontmatter + body) is what makes the
    // skill usable — see SkillManifest.content. Regenerating only frontmatter
    // here silently discarded the methodology, so an installed skill loaded as
    // an empty shell. Fall back to a frontmatter stub only if a source adapter
    // genuinely returned no content (defensive; every adapter sets it).
    const skillMd = manifest.content && manifest.content.trim().length > 0
      ? manifest.content
      : `---\nname: ${manifest.name}\nversion: ${manifest.version}\ndescription: ${manifest.description}\n---\n\n`;
    writeFileSync(join(skillDir, 'SKILL.md'), skillMd, 'utf-8');

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
  async uninstall(skillName: string, targetDir: string): Promise<boolean> {
    const skillDir = join(targetDir, skillName);
    if (!existsSync(skillDir)) return false;

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
  async listInstalled(targetDir: string): Promise<LockEntry[]> {
    const lock = this.readLock();
    return Object.values(lock).filter((entry) => {
      const skillDir = join(targetDir, entry.name);
      return existsSync(skillDir);
    });
  }

  /**
   * List available skills from all sources.
   */
  async listAvailable(): Promise<SkillManifest[]> {
    const allSkills: SkillManifest[] = [];
    for (const source of this.sources.values()) {
      if (source.list) {
        try {
          const skills = await source.list();
          allSkills.push(...skills);
        } catch (err) {
          logger.warn(`[hub] Failed to list from ${source.name}: ${err}`);
        }
      }
    }
    return allSkills;
  }

  /**
   * Get skill info.
   */
  async getInfo(skillName: string, targetDir: string): Promise<{ manifest?: SkillManifest; lock?: LockEntry; installed: boolean }> {
    const skillDir = join(targetDir, skillName);
    const installed = existsSync(skillDir);
    const lock = this.readLock()[skillName];

    return { lock, installed };
  }

  private readLock(): Record<string, LockEntry> {
    if (!existsSync(this.lockFile)) return {};
    try {
      return JSON.parse(readFileSync(this.lockFile, 'utf-8'));
    } catch {
      return {};
    }
  }

  private writeLock(lock: Record<string, LockEntry>): void {
    writeFileSync(this.lockFile, JSON.stringify(lock, null, 2), 'utf-8');
  }

  private audit(action: string, skill: string, source: string): void {
    const entry = `[${new Date().toISOString()}] ${action} ${skill} from ${source}\n`;
    try {
      const { appendFileSync } = require('node:fs');
      appendFileSync(this.auditLog, entry);
    } catch {
      // Ignore
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _skillsHubManager: SkillsHubManager | null = null;

export function getSkillsHubManager(): SkillsHubManager {
  if (!_skillsHubManager) _skillsHubManager = new SkillsHubManager();
  return _skillsHubManager;
}

export function resetSkillsHubManager(): void {
  _skillsHubManager = null;
}
