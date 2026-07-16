/**
 * PatternExtractor — Extracts reusable coding patterns from high-scoring
 * execution trajectories and stores them for future prompting.
 *
 * A "pattern" is a concise description of how a particular type of task
 * was successfully completed: which files were involved, what steps were
 * taken, what conventions were followed.
 *
 * These patterns are injected alongside trajectory few-shot examples
 * when the PlannerAgent decomposes a new goal.
 *
 * Patterns are stored in ~/.buff/memory/patterns.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { LLMCallFn } from '../agents/agent.js';
import type { Trajectory } from '../memory/trajectory-store.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A reusable coding pattern extracted from successful trajectories */
export interface CodingPattern {
  /** Unique identifier */
  id: string;
  /** Short descriptive title (e.g., "Adding CLI commands") */
  title: string;
  /** Which project types this applies to (e.g., "typescript, node") */
  applicableDomains: string[];
  /** The pattern description — steps, conventions, file structure */
  description: string;
  /** File paths commonly involved (pattern-based, not absolute) */
  commonFiles: string[];
  /** Agent types commonly used */
  commonAgentSequence: string[];
  /** How many trajectories this was distilled from */
  sourceCount: number;
  /** Average score of source trajectories */
  avgSourceScore: number;
  /** When this pattern was created */
  createdAt: number;
  /** When this pattern was last used (for decay scoring) */
  lastUsedAt: number;
  /** How many times this pattern has been used */
  usageCount: number;
}

/** On-disk format */
interface PatternData {
  patterns: CodingPattern[];
  version: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MEMORY_DIR = join(homedir(), '.buff', 'memory');
const PATTERNS_PATH = join(MEMORY_DIR, 'patterns.json');
const CURRENT_VERSION = 2;
const MAX_PATTERNS = 30;
const MIN_SCORE_FOR_EXTRACTION = 0.7; // Only extract from high-quality trajectories
const MAX_TRAJECTORIES_FOR_EXTRACTION = 5;

// Pattern decay: patterns lose relevance over time
const PATTERN_TTL_DAYS = 90;            // Expire after 90 days without use
const DECAY_DAYS_FOR_HALF_SCORE = 30;   // Score halves after 30 days of no use
const MIN_PATTERN_SCORE = 0.2;          // Prune patterns below this score

const EXTRACTION_PROMPT = `You are a senior software architect analyzing successful task executions. Given a set of execution trajectories, identify reusable patterns that would help complete similar tasks in the future.

For each distinct pattern you identify, provide:
1. A short title (max 60 chars)
2. Which tech stacks/domains it applies to (comma-separated)
3. A concise description of the approach/structure (2-4 sentences)
4. The file paths typically involved (as glob-like patterns)
5. The agent sequence that works well for this task type

Focus on structural patterns, not specific code. What matters is:
- Which files tend to be touched together?
- What's the right order of operations?
- What conventions should be followed?

Return a JSON array of patterns. Example:
[
  {
    "title": "Adding new CLI commands",
    "applicableDomains": ["typescript", "node", "cli"],
    "description": "When adding a new CLI command, first update the command registration in the router, then create the implementation module, then update help text and exports.",
    "commonFiles": ["src/cli/router.ts", "src/cli/*.ts", "src/index.ts"],
    "commonAgentSequence": ["context-gatherer", "writer", "reviewer"]
  }
]

Extract up to 3 patterns from the provided trajectories.`;

// ─── PatternStore ───────────────────────────────────────────────────────────

/**
 * Manages storage and retrieval of reusable coding patterns.
 * Patterns are extracted from high-scoring trajectories via LLM.
 */
export class PatternStore {
  private patterns: CodingPattern[] = [];

  constructor() {
    this.patterns = this.load();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Get all stored patterns, optionally filtered by minimum quality score.
   */
  getAll(minQualityScore?: number): CodingPattern[] {
    const patterns = [...this.patterns];
    if (minQualityScore !== undefined) {
      return patterns.filter((p) => this.computeDecayScore(p) >= minQualityScore);
    }
    return patterns;
  }

  /**
   * Get patterns relevant to a specific project domain.
   */
  getByDomain(domainTags: string[]): CodingPattern[] {
    if (domainTags.length === 0) return this.getAll().slice(0, 3);
    return this.patterns
      .filter((p) =>
        p.applicableDomains.some((d) =>
          domainTags.some((tag) => d.toLowerCase().includes(tag.toLowerCase())),
        ),
      )
      .slice(0, 3);
  }

  /**
   * Format patterns as a prompt string for agent injection.
   */
  formatAsPrompt(domainTags?: string[]): string {
    const relevant = domainTags ? this.getByDomain(domainTags) : this.getAll().slice(0, 3);
    if (relevant.length === 0) return '';

    const parts = relevant.map(
      (p, i) =>
        `## Pattern ${i + 1}: ${p.title}\n` +
        `Domains: ${p.applicableDomains.join(', ')}\n` +
        `Approach: ${p.description}\n` +
        `Common files: ${p.commonFiles.join(', ')}\n` +
        `Agent sequence: ${p.commonAgentSequence.join(' → ')}`,
    );

    return (
      `\n---\n` +
      `Here are reusable patterns learned from past successful executions similar to this project:\n\n` +
      parts.join('\n\n') +
      `\n---\n`
    );
  }

  /**
   * Extract patterns from high-scoring trajectories using the LLM.
   * Newly extracted patterns are merged with existing ones (keeping the best).
   */
  async extractFromTrajectories(
    trajectories: Trajectory[],
    callLLM: LLMCallFn,
  ): Promise<number> {
    const highScoring = trajectories
      .filter((t) => t.score >= MIN_SCORE_FOR_EXTRACTION)
      .slice(0, MAX_TRAJECTORIES_FOR_EXTRACTION);

    if (highScoring.length < 2) return 0; // Need at least 2 for pattern extraction

    const prompt = this.buildExtractionPrompt(highScoring);
    let response: string;

    try {
      response = await callLLM(prompt, {
        temperature: 0.3,
        maxTokens: 4096,
      });
    } catch (err) {
      logger.debug(`Pattern extraction failed: ${err}`);
      return 0;
    }

    const newPatterns = this.parsePatterns(response);
    if (newPatterns.length === 0) return 0;

    // Merge: replace existing patterns with same title, add new ones
    for (const pattern of newPatterns) {
      pattern.id = `pattern-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      pattern.sourceCount = highScoring.length;
      pattern.avgSourceScore =
        highScoring.reduce((sum, t) => sum + t.score, 0) / highScoring.length;
      pattern.createdAt = Date.now();
      pattern.lastUsedAt = Date.now();
      pattern.usageCount = 0;

      const existing = this.patterns.findIndex(
        (p) => p.title.toLowerCase() === pattern.title.toLowerCase(),
      );
      if (existing >= 0) {
        this.patterns[existing] = pattern;
      } else {
        this.patterns.push(pattern);
      }
    }

    // Keep only the best ones
    if (this.patterns.length > MAX_PATTERNS) {
      this.patterns.sort((a, b) => b.avgSourceScore - a.avgSourceScore);
      this.patterns = this.patterns.slice(0, MAX_PATTERNS);
    }

    this.save();
    return newPatterns.length;
  }

  /**
   * Mark a pattern as used (for decay tracking).
   */
  markUsed(patternId: string): void {
    const pattern = this.patterns.find((p) => p.id === patternId);
    if (pattern) {
      pattern.lastUsedAt = Date.now();
      pattern.usageCount++;
      this.save();
    }
  }

  /**
   * Compute a decay score for a pattern based on age and usage.
   * Returns a score from 0 (expired) to 1 (fresh).
   */
  computeDecayScore(pattern: CodingPattern): number {
    const now = Date.now();
    const ageMs = now - pattern.createdAt;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    // Hard expiry: pattern too old
    if (ageDays > PATTERN_TTL_DAYS) return 0;

    // Time-based decay: score halves after DECAY_DAYS_FOR_HALF_SCORE
    const timeScore = Math.pow(0.5, ageDays / DECAY_DAYS_FOR_HALF_SCORE);

    // Usage bonus: patterns used more often are worth keeping
    const usageBonus = Math.min(pattern.usageCount * 0.05, 0.3);

    // Last-used bonus: recently used patterns get a boost
    const daysSinceLastUse = (now - pattern.lastUsedAt) / (1000 * 60 * 60 * 24);
    const recencyBonus = Math.max(0, 0.2 - daysSinceLastUse * 0.01);

    return Math.min(1, timeScore + usageBonus + recencyBonus);
  }

  /**
   * Garbage collect low-quality patterns.
   * Returns the number of patterns removed.
   */
  garbageCollect(verbose: boolean = false): number {
    const before = this.patterns.length;

    // Remove patterns below minimum score
    this.patterns = this.patterns.filter((p) => {
      const score = this.computeDecayScore(p);
      if (score < MIN_PATTERN_SCORE) {
        if (verbose) {
          logger.debug(`Pruning pattern '${p.title}' (decay score: ${(score * 100).toFixed(0)}%)`);
        }
        return false;
      }
      return true;
    });

    // Also enforce max patterns
    if (this.patterns.length > MAX_PATTERNS) {
      this.patterns.sort((a, b) => this.computeDecayScore(b) - this.computeDecayScore(a));
      this.patterns = this.patterns.slice(0, MAX_PATTERNS);
    }

    const removed = before - this.patterns.length;
    if (removed > 0) this.save();
    return removed;
  }

  /**
   * Get decay quality statistics for all patterns.
   */
  getQualityReport(): Array<{ id: string; title: string; decayScore: number; usageCount: number; ageDays: number }> {
    const now = Date.now();
    return this.patterns.map((p) => ({
      id: p.id,
      title: p.title,
      decayScore: this.computeDecayScore(p),
      usageCount: p.usageCount,
      ageDays: Math.floor((now - p.createdAt) / (1000 * 60 * 60 * 24)),
    })).sort((a, b) => a.decayScore - b.decayScore); // Worst first
  }

  /**
   * Clear all patterns.
   */
  clear(): void {
    this.patterns = [];
    this.save();
  }

  // ── Private ────────────────────────────────────────────────────────────

  private load(): CodingPattern[] {
    try {
      ensureDir();
      if (!existsSync(PATTERNS_PATH)) return [];
      const raw = readFileSync(PATTERNS_PATH, 'utf-8');
      const data = JSON.parse(raw) as PatternData;

      // Migrate old-format patterns (version 1 → 2) that may lack lastUsedAt/usageCount
      const patterns = (data.patterns || []).map((p) => ({
        ...p,
        lastUsedAt: p.lastUsedAt ?? p.createdAt ?? Date.now(),
        usageCount: p.usageCount ?? 0,
      }));

      return patterns;
    } catch {
      return [];
    }
  }

  private save(): void {
    ensureDir();
    const data: PatternData = { patterns: this.patterns, version: CURRENT_VERSION };
    writeFileSync(PATTERNS_PATH, JSON.stringify(data, null, 2), 'utf-8');
  }

  private buildExtractionPrompt(trajectories: Trajectory[]): string {
    const trajText = trajectories
      .map(
        (t, i) =>
          `Trajectory ${i + 1} (score: ${t.score.toFixed(2)}):\n` +
          `Goal: ${t.goal}\n` +
          `Project: ${t.projectFingerprint}\n` +
          `Steps: ${t.taskPlan.map((s) => `[${s.agentType}] ${s.description}`).join('\n')}\n` +
          `Files: ${t.fileChanges.map((fc) => fc.path).join(', ')}\n`,
      )
      .join('\n---\n');

    return `${EXTRACTION_PROMPT}\n\n## Execution Trajectories\n\n${trajText}`;
  }

  private parsePatterns(response: string): CodingPattern[] {
    // Try direct JSON parse first
    try {
      const trimmed = response.trim();
      // Strip code block wrappers if present
      const jsonStr = trimmed.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (p) => p.title && p.description && Array.isArray(p.applicableDomains),
        );
      }
    } catch {
      // Fall through
    }

    // Try extracting JSON array from the response
    const arrayMatch = response.match(/\[[\s\S]*?\]/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsed)) {
          return parsed.filter(
            (p) => p.title && p.description && Array.isArray(p.applicableDomains),
          );
        }
      } catch {
        // Fall through
      }
    }

    return [];
  }
}

// Singleton
let storeInstance: PatternStore | null = null;

export function getPatternStore(): PatternStore {
  if (!storeInstance) {
    storeInstance = new PatternStore();
  }
  return storeInstance;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }
}
