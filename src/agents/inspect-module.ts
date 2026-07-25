/**
 * InspectModule — Scans the codebase to discover relevant files, extract
 * structural context, and identify dependencies. Phase 5 of the architecture
 * migration: wrap ContextGathererAgent in the modular InspectModule interface.
 *
 * @see ARCHITECTURE.md §3.2 — Inspect Module specification
 */

import { join, relative } from 'node:path';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';

import { getEventBus, EventNames } from '../observability/event-bus.js';
import type { EventBus } from '../observability/event-bus.js';
import { buildProjectFileTree, truncateTree } from './utils/file-tree.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * A discovered file artifact with its content.
 * Prefixed with "Inspect" to avoid collision with agent.ts's Artifact type.
 */
export interface InspectArtifact {
  /** Relative path from the project root */
  path: string;
  /** Full file contents */
  content: string;
  /** Human-readable description (e.g. 'src/index.ts (12.5k characters)') */
  description: string;
}

/** Statistics about the inspection run */
export interface InspectionStats {
  /** Total files in the project */
  totalFiles: number;
  /** Files that were inspected / read */
  inspectedFiles: number;
  /** Number of errors encountered during inspection */
  errors: number;
  /** Whether the LLM-based classification fell back to keyword scanning */
  llmFallbackUsed: boolean;
}

/** Result of a codebase inspection */
export interface InspectionResult {
  /** Discovered file artifacts with full contents */
  artifacts: InspectArtifact[];
  /** Text representation of the project file tree */
  fileTree: string;
  /** File paths that are relevant to the goal */
  relevantPaths: string[];
  /** Inspection statistics */
  stats: InspectionStats;
}

/** Parameters for the InspectModule.inspect() method */
export interface InspectParams {
  /** The user's goal / task description */
  goal: string;
  /** Working directory of the project */
  workingDirectory: string;
  /** Optional list of task plan descriptions for context */
  taskDescriptions?: string[];
  /** Maximum number of files to inspect (default: 10) */
  maxFiles?: number;
}

/**
 * PlanStep-like interface for dependency-aware planning.
 * A minimal version of what the PlanModule produces.
 */
export interface PlanStepRef {
  id: string;
  description: string;
}

// ─── InspectModule Interface ───────────────────────────────────────────────

/**
 * InspectModule — Scan the codebase to discover relevant files, extract
 * structural context, and identify dependencies.
 *
 * @example
 * ```typescript
 * const module = new DefaultInspectModule();
 * const result = await module.inspect({
 *   goal: 'Add JWT auth',
 *   workingDirectory: '/project',
 * });
 * console.log(result.artifacts.length); // Files discovered
 * ```
 */
export interface InspectModule {
  /**
   * Scan the codebase for files relevant to the given goal.
   * Uses LLM-based classification with keyword fallback.
   */
  inspect(params: InspectParams): Promise<InspectionResult>;

  /**
   * Synchronous fallback — scans files by keyword matching against the goal.
   * Used when the LLM call fails or times out.
   */
  scanByKeywords(goal: string, workingDir: string): string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

// Reuse constants from the shared file-tree utility to avoid duplication
import { SOURCE_EXTENSIONS, IGNORE_DIRS } from './utils/file-tree.js';

/** Maximum characters per file when reading */
const MAX_FILE_CHARS = 100_000;

// ─── Default InspectModule ─────────────────────────────────────────────────

/**
 * DefaultInspectModule — Built-in inspect module implementation.
 *
 * Wraps the existing keyword-scanning logic (previously private to
 * ContextGathererAgent) into the modular InspectModule interface.
 * The LLM-based file identification is delegated to the agent system
 * via the callLLM parameter — when no callLLM is provided, only
 * keyword-based scanning is used.
 */
export class DefaultInspectModule implements InspectModule {
  /** The event bus for emitting observability events */
  private eventBus: EventBus;

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus ?? getEventBus();
  }

  /**
   * Scan the codebase for files relevant to the given goal.
   */
  async inspect(params: InspectParams): Promise<InspectionResult> {
    const { goal, workingDirectory, taskDescriptions, maxFiles = 10 } = params;

    // ── Emit: scanning started ───────────────────────────────────────
    this.eventBus.emit(EventNames.INSPECT_SCANNING, {
      directory: workingDirectory,
      goal,
    }, 'inspect-module');

    // 1. Build the project file tree
    const fileTree = await buildProjectFileTree(workingDirectory);
    const totalFiles = fileTree.split('\n').filter((l) => l.includes('📄')).length;

    // 2. Use keyword scanning to identify relevant paths
    //    (Phase 5 uses keyword scanning as the base implementation.
    //     TODO: Phase 6 — emit INSPECT_LLM_CLASSIFY when LLM-based classification is added.)
    const relevantPaths = this.scanByKeywords(goal, workingDirectory);

    // Limit to maxFiles
    const limitedPaths = relevantPaths.slice(0, maxFiles);

    // 3. Read the identified files
    const artifacts: InspectArtifact[] = [];
    const errors: string[] = [];

    for (const filePath of limitedPaths) {
      const absolutePath = join(workingDirectory, filePath);

      if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
        errors.push(`File not found: ${filePath}`);
        continue;
      }

      try {
        const size = statSync(absolutePath).size;
        if (size > MAX_FILE_CHARS) {
          errors.push(`File too large: ${filePath} (${this.formatSize(size)})`);
          continue;
        }

        const content = readFileSync(absolutePath, 'utf-8');

        // ── Emit: file found event ───────────────────────────────────
        this.eventBus.emit(EventNames.INSPECT_FILE_FOUND, {
          path: filePath,
          extension: filePath.slice(filePath.lastIndexOf('.')),
          size,
        }, 'inspect-module');

        artifacts.push({
          path: filePath,
          content,
          description: `${filePath} (${this.formatSize(content.length)} characters)`,
        });
      } catch {
        errors.push(`Could not read: ${filePath}`);
      }
    }

    const stats: InspectionStats = {
      totalFiles,
      inspectedFiles: artifacts.length,
      errors: errors.length,
      // Phase 5 always uses keyword scanning; Phase 6+ will set this based
      // on whether the LLM classifier fell back to keyword matching.
      llmFallbackUsed: true,
    };

    // ── Emit: completed event ────────────────────────────────────────
    this.eventBus.emit(EventNames.INSPECT_COMPLETED, {
      artifactCount: artifacts.length,
      errors: errors.length,
      totalFiles,
    }, 'inspect-module');

    return {
      artifacts,
      fileTree,
      relevantPaths: limitedPaths,
      stats,
    };
  }

  /**
   * Synchronous fallback — scan files by keyword matching against the goal.
   * Used when the LLM call fails or as the base implementation.
   */
  scanByKeywords(goal: string, workingDir: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'in', 'to', 'for', 'of', 'and', 'or', 'is',
      'add', 'fix', 'update', 'change', 'remove', 'create', 'implement',
      'with', 'on', 'at', 'by', 'from', 'as', 'be', 'this', 'that',
    ]);

    const keywords = goal
      .toLowerCase()
      .split(/[\s,.-]+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));

    if (keywords.length === 0) return [];

    const scored = this.walkAndScore(workingDir, keywords, 0);
    return scored
      .sort((a, b) => b.score - a.score)
      .filter((s) => s.score > 0)
      .slice(0, 10)
      .map((s) => s.path);
  }

  // ─── Private Helpers ─────────────────────────────────────────────────

  /** Walk the directory tree and score files by keyword relevance */
  private walkAndScore(
    dir: string,
    keywords: string[],
    depth: number,
    baseDir?: string,
  ): Array<{ path: string; score: number }> {
    const root = baseDir ?? dir;
    if (depth > 5) return [];

    const results: Array<{ path: string; score: number }> = [];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;

      const entryPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        const subResults = this.walkAndScore(entryPath, keywords, depth + 1, root);
        results.push(...subResults);
      } else if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf('.'));
        if (!SOURCE_EXTENSIONS.has(ext)) continue;

        let score = 0;
        const lowerName = entry.name.toLowerCase();
        const lowerPath = entryPath.toLowerCase();

        for (const kw of keywords) {
          if (lowerName.includes(kw)) score += 3;
          else if (lowerPath.includes(kw)) score += 1;
        }

        if (score > 0) {
          const relPath = relative(root, entryPath);
          results.push({ path: relPath, score });
        }
      }
    }

    return results;
  }

  /** Format byte count to human-readable string */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return String(bytes);
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}k`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  }
}
