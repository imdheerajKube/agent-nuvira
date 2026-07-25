/**
 * InspectModule — Scans the codebase to discover relevant files, extract
 * structural context, and identify dependencies. Phase 6 adds LLM-based
 * file classification with keyword-scanning fallback.
 *
 * @see ARCHITECTURE.md §3.2 — Inspect Module specification
 */

import { join, relative } from 'node:path';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';

import { getEventBus, EventNames } from '../observability/event-bus.js';
import type { EventBus } from '../observability/event-bus.js';
import { buildProjectFileTree, truncateTree } from './utils/file-tree.js';
import type { LLMCallFn } from './agent.js';

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
  /**
   * Optional LLM call function for LLM-based file classification.
   * When provided, the module first asks the LLM to identify relevant
   * files. Falls back to keyword scanning if the LLM call fails.
   * When omitted, only keyword scanning is used.
   */
  callLLM?: LLMCallFn;
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
   * Phase 6: Uses LLM-based classification with keyword-scanning fallback.
   */
  async inspect(params: InspectParams): Promise<InspectionResult> {
    const { goal, workingDirectory, taskDescriptions, maxFiles = 10, callLLM } = params;

    // ── Emit: scanning started ───────────────────────────────────────
    this.eventBus.emit(EventNames.INSPECT_SCANNING, {
      directory: workingDirectory,
      goal,
    }, 'inspect-module');

    // 1. Build the project file tree
    const fileTree = await buildProjectFileTree(workingDirectory);
    const totalFiles = fileTree.split('\n').filter((l) => l.includes('📄')).length;

    // 2. Identify relevant paths — try LLM first, fall back to keywords
    let usedLlm = false;
    let relevantPaths: string[];

    if (callLLM) {
      try {
        relevantPaths = await this.classifyFiles({
          goal,
          workingDirectory,
          fileTree,
          callLLM,
          taskDescriptions,
        });
        usedLlm = true;

        // ── Emit: LLM classification completed ───────────────────────
        this.eventBus.emit(EventNames.INSPECT_LLM_CLASSIFY, {
          fileCount: relevantPaths.length,
          method: 'llm',
        }, 'inspect-module');
      } catch {
        // LLM call failed — fall back to keyword scanning
        relevantPaths = this.scanByKeywords(goal, workingDirectory);

        // ── Emit: LLM classification failed, using fallback ──────────
        this.eventBus.emit(EventNames.INSPECT_LLM_CLASSIFY, {
          fileCount: relevantPaths.length,
          method: 'keyword-fallback',
        }, 'inspect-module');
      }
    } else {
      // No callLLM provided — use keyword scanning directly
      relevantPaths = this.scanByKeywords(goal, workingDirectory);
    }

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
      // When callLLM was provided and succeeded, LLM was used (no fallback).
      // When callLLM was provided but failed, or when no callLLM was given,
      // keyword scanning was used (the fallback).
      llmFallbackUsed: !usedLlm,
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

  // ─── LLM-Based Classification ─────────────────────────────────────────

  /**
   * Use the LLM to identify files relevant to the goal.
   * Parses the LLM response as a JSON array of file paths.
   * Throws if parsing fails or file list is empty.
   */
  private async classifyFiles(params: {
    goal: string;
    workingDirectory: string;
    fileTree: string;
    callLLM: LLMCallFn;
    taskDescriptions?: string[];
  }): Promise<string[]> {
    const prompt = this.buildClassifyPrompt(params);
    const response = await params.callLLM(prompt);
    return this.parseClassifyResponse(response);
  }

  /** Build the prompt for LLM-based file classification */
  private buildClassifyPrompt(params: {
    goal: string;
    workingDirectory: string;
    fileTree: string;
    taskDescriptions?: string[];
  }): string {
    let prompt = `You are a codebase inspector. Given a project goal and its file tree, identify which files are most relevant to accomplish the goal.

Goal: ${params.goal}

Project file tree:
${params.fileTree.slice(0, 2000)}
`;

    if (params.taskDescriptions && params.taskDescriptions.length > 0) {
      prompt += `\nAdditional context — task plan steps:
${params.taskDescriptions.map((d, i) => `  ${i + 1}. ${d}`).join('\n')}
`;
    }

    prompt += `
Respond with ONLY a JSON array of file paths (relative to the project root) that are most relevant to this goal. Limit to 10 files. Use the exact paths as shown in the file tree.

Example: ["src/auth/login.ts", "src/auth/middleware.ts"]

JSON array:`;

    return prompt;
  }

  /** Parse the LLM response into an array of file paths. Throws on failure. */
  private parseClassifyResponse(response: string): string[] {
    // Try to extract a JSON array from the response
    const trimmed = response.trim();

    // Find the first `[` and last `]` to extract the JSON array
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');

    if (start === -1 || end === -1 || end <= start) {
      throw new Error('LLM response did not contain a JSON array');
    }

    const jsonStr = trimmed.slice(start, end + 1);
    const paths: unknown = JSON.parse(jsonStr);

    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error('LLM returned empty or invalid file list');
    }

    // Validate all entries are strings
    const filePaths = paths.filter((p): p is string => typeof p === 'string');
    if (filePaths.length === 0) {
      throw new Error('LLM returned no valid file paths');
    }

    return filePaths;
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
