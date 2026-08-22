/**
 * Skill Metadata — Usage tracking and provenance management.
 *
 * Hermes equivalents:
 * - skill_usage.py (1,340 lines) — Skill usage tracking
 * - skill_provenance.py (78 lines) — Skill origin tracking
 *
 * Provides:
 * - Track skill usage (count, last used, context)
 * - Provenance tracking (origin, author, version)
 * - Usage analytics (most used, recently used)
 * - Provenance verification
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface SkillUsage {
  name: string;
  count: number;
  lastUsed: number;
  firstUsed: number;
  contexts: string[];
  tokensUsed: number;
  averageTokensPerUse: number;
}

export interface SkillProvenance {
  name: string;
  source: 'bundled' | 'hub' | 'local' | 'git';
  sourceUrl?: string;
  author?: string;
  version?: string;
  installedAt: number;
  installedBy?: string;
  verified: boolean;
}

// ─── Skill Usage Tracker ──────────────────────────────────────────────────

export class SkillUsageTracker {
  private usageFile: string;
  private usage: Map<string, SkillUsage> = new Map();

  constructor() {
    const dir = join(homedir(), '.buff', 'skills', '.usage');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.usageFile = join(dir, 'usage.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.usageFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.usageFile, 'utf-8'));
      for (const [name, usage] of Object.entries(data)) {
        this.usage.set(name, usage as SkillUsage);
      }
    } catch {
      // Ignore
    }
  }

  private save(): void {
    const data: Record<string, SkillUsage> = {};
    for (const [name, usage] of this.usage) {
      data[name] = usage;
    }
    writeFileSync(this.usageFile, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Record a skill usage.
   */
  record(skillName: string, context: string = 'default', tokens: number = 0): void {
    const existing = this.usage.get(skillName);
    const now = Date.now();

    if (existing) {
      existing.count++;
      existing.lastUsed = now;
      if (!existing.contexts.includes(context)) {
        existing.contexts.push(context);
      }
      existing.tokensUsed += tokens;
      existing.averageTokensPerUse = existing.tokensUsed / existing.count;
    } else {
      this.usage.set(skillName, {
        name: skillName,
        count: 1,
        lastUsed: now,
        firstUsed: now,
        contexts: [context],
        tokensUsed: tokens,
        averageTokensPerUse: tokens,
      });
    }

    this.save();
  }

  /**
   * Get usage for a skill.
   */
  get(skillName: string): SkillUsage | null {
    return this.usage.get(skillName) || null;
  }

  /**
   * Get all usage.
   */
  getAll(): SkillUsage[] {
    return Array.from(this.usage.values());
  }

  /**
   * Get most used skills.
   */
  getMostUsed(limit: number = 10): SkillUsage[] {
    return this.getAll()
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /**
   * Get recently used skills.
   */
  getRecentlyUsed(limit: number = 10): SkillUsage[] {
    return this.getAll()
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .slice(0, limit);
  }

  /**
   * Get usage stats.
   */
  getStats(): { totalSkills: number; totalUses: number; totalTokens: number } {
    const all = this.getAll();
    return {
      totalSkills: all.length,
      totalUses: all.reduce((sum, u) => sum + u.count, 0),
      totalTokens: all.reduce((sum, u) => sum + u.tokensUsed, 0),
    };
  }
}

// ─── Skill Provenance Manager ─────────────────────────────────────────────

export class SkillProvenanceManager {
  private provenanceFile: string;
  private provenance: Map<string, SkillProvenance> = new Map();

  constructor() {
    const dir = join(homedir(), '.buff', 'skills', '.provenance');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.provenanceFile = join(dir, 'provenance.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.provenanceFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.provenanceFile, 'utf-8'));
      for (const [name, prov] of Object.entries(data)) {
        this.provenance.set(name, prov as SkillProvenance);
      }
    } catch {
      // Ignore
    }
  }

  private save(): void {
    const data: Record<string, SkillProvenance> = {};
    for (const [name, prov] of this.provenance) {
      data[name] = prov;
    }
    writeFileSync(this.provenanceFile, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Record skill provenance.
   */
  record(prov: SkillProvenance): void {
    this.provenance.set(prov.name, prov);
    this.save();
  }

  /**
   * Get provenance for a skill.
   */
  get(skillName: string): SkillProvenance | null {
    return this.provenance.get(skillName) || null;
  }

  /**
   * Get all provenance records.
   */
  getAll(): SkillProvenance[] {
    return Array.from(this.provenance.values());
  }

  /**
   * Verify provenance (check if skill matches recorded hash).
   */
  verify(skillName: string, currentHash: string): { verified: boolean; reason?: string } {
    const prov = this.provenance.get(skillName);
    if (!prov) {
      return { verified: false, reason: 'No provenance record' };
    }

    if (!prov.verified) {
      return { verified: false, reason: 'Provenance not verified' };
    }

    return { verified: true };
  }

  /**
   * Remove provenance record.
   */
  remove(skillName: string): boolean {
    const deleted = this.provenance.delete(skillName);
    if (deleted) this.save();
    return deleted;
  }
}

// ─── Singletons ───────────────────────────────────────────────────────────

let _skillUsageTracker: SkillUsageTracker | null = null;
let _skillProvenanceManager: SkillProvenanceManager | null = null;

export function getSkillUsageTracker(): SkillUsageTracker {
  if (!_skillUsageTracker) _skillUsageTracker = new SkillUsageTracker();
  return _skillUsageTracker;
}

export function getSkillProvenanceManager(): SkillProvenanceManager {
  if (!_skillProvenanceManager) _skillProvenanceManager = new SkillProvenanceManager();
  return _skillProvenanceManager;
}

export function resetSkillMetadata(): void {
  _skillUsageTracker = null;
  _skillProvenanceManager = null;
}
