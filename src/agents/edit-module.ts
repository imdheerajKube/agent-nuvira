/**
 * EditModule — Generates code changes from task descriptions and file context.
 * Phase 7 of the architecture migration: extract from WriterAgent into
 * a pluggable module with EventBus integration.
 *
 * The module reads relevant files, calls an LLM to generate modified versions,
 * parses file changes from the response, validates syntax via AST analysis,
 * and returns structured FileChange objects — without writing to disk.
 *
 * @see ARCHITECTURE.md §3.3 — Edit Module specification
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { getEventBus, EventNames } from '../observability/event-bus.js';
import type { EventBus } from '../observability/event-bus.js';
import type { LLMCallFn, FileChange, Artifact } from './agent.js';
import { detectLanguage } from '../editing/types.js';
import { validateSyntax } from '../editing/ast.js';
import { buildStructuralContext } from '../editing/edit.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const EDIT_SYSTEM_PROMPT = `You are an expert software engineer implementing changes to a codebase.

Given file contents and an implementation task, you will:
1. Read the current file content carefully
2. Implement the requested changes
3. Return the COMPLETE updated file content for EACH modified file

## Output Format (MANDATORY)

Wrap EACH file you modify in its own code block. The file path MUST go right after the opening backticks with the prefix "filepath:".

CORRECT (use this format):
\`\`\`filepath:path/to/file.ts
// FULL updated file content here
\`\`\`

INCORRECT (do NOT use these):
- ❌ \`\`\`typescript\n...\n\`\`\` (missing filepath)
- ❌ \`\`\`\n...\n\`\`\` (missing language and filepath)
- ❌ Just describing the changes instead of returning the file

## Rules
- Return the FULL file content, not just the changed parts
- Preserve existing code style and conventions
- Add appropriate error handling
- Write clean, well-documented code
- If you modify multiple files, return ONE code block per file
`;

/** Maximum files to include in a single edit prompt */
const MAX_CONTEXT_FILES = 10;

/** Maximum total characters across all files sent to the LLM */
const MAX_CONTEXT_CHARS = 16_000;

/** Overhead per file in characters for formatting/path prefix */
const OVERHEAD_PER_FILE = 50;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Parameters for the EditModule.edit() method */
export interface EditParams {
  /** The original user goal / task description */
  goal: string;
  /** Absolute path to the working directory */
  workingDirectory: string;
  /** File artifacts discovered during the inspection phase */
  artifacts: Artifact[];
  /** The LLM call function */
  callLLM: LLMCallFn;
  /** Optional structured context overrides */
  taskDescription?: string;
  /** Optional MCP tools description for the LLM */
  mcpToolsFormatted?: string;
  /** Optional rate limit callback */
  onRateLimit?: (info: { retryAfterMs: number; modelName?: string; agentName: string; errorMessage: string }) => Promise<{ action: 'retry' | 'skip' | 'abort' | 'switch-model'; callLLM?: LLMCallFn }>;
  /** Whether this is a retry attempt (stricter prompt) */
  isRetry?: boolean;
}

/** Output of the edit phase */
export interface EditOutput {
  /** File changes generated */
  changes: FileChange[];
  /** Human-readable summary */
  summary: string;
  /** How many files were changed */
  changeCount: number;
  /** Syntax warnings, if any */
  warnings?: string[];
}

// ─── EditModule Interface ───────────────────────────────────────────────────

/**
 * EditModule — Generate code changes from task descriptions and file context.
 *
 * The module reads files, calls the LLM to generate modified versions, parses
 * the response, validates syntax, and returns structured FileChange objects.
 *
 * @example
 * ```typescript
 * const module = new DefaultEditModule();
 * const result = await module.edit({
 *   goal: 'Add JWT auth',
 *   workingDirectory: '/project',
 *   artifacts: inspectedFiles,
 *   callLLM,
 * });
 * console.log(`Changed ${result.changeCount} files`);
 * ```
 */
export interface EditModule {
  /**
   * Generate file changes from the given task and file context.
   */
  edit(params: EditParams): Promise<EditOutput>;
}

// ─── Default EditModule ─────────────────────────────────────────────────────

/**
 * DefaultEditModule — Built-in edit module implementation.
 *
 * Builds a prompt from file artifacts and task description; calls the LLM;
 * parses file changes from the response; validates syntax via AST analysis;
 * and returns structured FileChange objects without writing to disk.
 */
export class DefaultEditModule implements EditModule {
  /** The event bus for emitting observability events */
  private eventBus: EventBus;

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus ?? getEventBus();
  }

  /**
   * Generate file changes from the given task and file context.
   */
  async edit(params: EditParams): Promise<EditOutput> {
    const { goal, workingDirectory, artifacts, callLLM: initialCallLLM, taskDescription, mcpToolsFormatted, onRateLimit, isRetry } = params;
    let currentCallLLM = initialCallLLM;

    // ── Emit: edit generating ──────────────────────────────────────────
    this.eventBus.emit(EventNames.EDIT_GENERATING, {
      goal,
      artifactCount: artifacts.length,
      isRetry: isRetry ?? false,
    }, 'edit-module');

    // Try up to 2 API attempts
    let lastError: string | undefined;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const effectiveIsRetry = attempt > 0 ? true : (isRetry ?? false);
        const prompt = this.buildPrompt(goal, workingDirectory, artifacts, taskDescription, mcpToolsFormatted, effectiveIsRetry);

        const response = await currentCallLLM(prompt, {
          temperature: effectiveIsRetry ? 0.1 : 0.3,
          maxTokens: 4096,
        });

        const fileChanges = this.parseFileChanges(response, workingDirectory);
        const warnings = this.validateChanges(fileChanges);

        // Emit: per-file written events
        for (const change of fileChanges) {
          if (change.newContent) {
            this.eventBus.emit(EventNames.EDIT_WRITTEN, {
              path: change.path,
              status: change.status,
              bytes: change.newContent.length,
            }, 'edit-module');
          } else {
            this.eventBus.emit(EventNames.EDIT_SKIPPED, {
              path: change.path,
              reason: 'no new content',
            }, 'edit-module');
          }
        }

        const count = fileChanges.length;
        if (count === 0) {
          // Emit empty result
          const excerpt = response.slice(0, 300).replace(/\n/g, '\\n');

          // If first attempt returned empty, retry with stricter prompt
          if (attempt === 0) {
            this.eventBus.emit(EventNames.EDIT_GENERATING, {
              goal,
              artifactCount: artifacts.length,
              isRetry: true,
              reason: 'empty-parse-retry',
            }, 'edit-module');
            continue;
          }

          return {
            changes: [],
            summary: 'No files needed changes',
            changeCount: 0,
            warnings: ['LLM produced no parseable file changes'],
          };
        }

        return { changes: fileChanges, summary: `Proposed changes to ${count} file${count !== 1 ? 's' : ''}`, changeCount: count, warnings: warnings.length > 0 ? warnings : undefined };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);

        // Handle rate limit
        if (onRateLimit && this.isRateLimitError(lastError)) {
          const retryAfterMs = this.parseRetryAfterHint(lastError) || 5000;
          const action = await onRateLimit({
            retryAfterMs,
            agentName: 'EditModule',
            errorMessage: lastError.slice(0, 300),
          });

          if (action.action === 'abort') {
            return {
              changes: [],
              summary: 'Edit aborted by user due to rate limit',
              changeCount: 0,
              warnings: [lastError],
            };
          }

          if (action.action === 'skip') {
            return {
              changes: [],
              summary: 'Skipped by user (rate limit)',
              changeCount: 0,
            };
          }

          if (action.action === 'switch-model' && action.callLLM) {
            // Retry with new callLLM
            currentCallLLM = action.callLLM;
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }

          // 'retry': wait and retry
          await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
          continue;
        }

        if (attempt === 0) {
          // Transient error — retry once
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }

        // All attempts exhausted
        return {
          changes: [],
          summary: 'Edit failed to generate changes',
          changeCount: 0,
          warnings: [lastError],
        };
      }
    }

    return {
      changes: [],
      summary: 'Edit failed after retries',
      changeCount: 0,
      warnings: lastError ? [lastError] : undefined,
    };
  }

  // ─── Prompt Building ─────────────────────────────────────────────────

  /**
   * Build the LLM prompt from file artifacts and task description.
   */
  private buildPrompt(
    goal: string,
    workingDirectory: string,
    artifacts: Artifact[],
    taskDescription?: string,
    mcpToolsFormatted?: string,
    isRetry: boolean = false,
  ): string {
    const taskDesc = taskDescription || goal;

    // Select files within the character budget
    const filesToSend = this.selectFilesWithinBudget(artifacts, MAX_CONTEXT_CHARS);

    const fileContext = filesToSend.length > 0
      ? filesToSend
          .map(({ artifact, truncated }) =>
            `--- ${artifact.path} ---${truncated ? ` (truncated, ${artifact.content.length}\u2192${truncated.length} chars)` : ''}\n${truncated || artifact.content}`,
          )
          .join('\n\n') +
        (artifacts.length > filesToSend.length
          ? `\n\n... and ${artifacts.length - filesToSend.length} more files in the project (excluded to fit token budget)`
          : '')
      : '(No files found in context — you may need to create new files)';

    // Build structural context for AST-aware editing
    const structuralContexts = artifacts
      .filter((a) => a.content)
      .slice(0, 5)
      .map((a) => buildStructuralContext(a.content, a.path))
      .filter((s) => s.length > 0);

    const structureSection = structuralContexts.length > 0
      ? `\n## File Structure Overview\n\nHere is the structural layout of the files you need to modify.\nUse these line ranges to understand where each function/class lives.\n\n${structuralContexts.join('\n\n')}\n`
      : '';

    const mcpSection = mcpToolsFormatted ? `\n${mcpToolsFormatted}\n` : '';

    const instructions = isRetry
      ? `\n## CRITICAL — Read This Carefully\nThe previous response could not be parsed because the files were not wrapped in correctly formatted code blocks.\n\nYou MUST follow this format EXACTLY for EACH file you modify:\n\n\`\`\`filepath:src/example.ts\n// THE COMPLETE UPDATED FILE CONTENT GOES HERE (every line, full file)\n\`\`\`\n\nIMPORTANT:\n- The filepath: prefix is REQUIRED after the opening backticks\n- Return the FULL file, not a diff or snippet\n- If you modify 2 files, return 2 separate code blocks in this format`
      : `\n## Instructions\nImplement the changes described in the task. Return the complete updated file content for each file you modify. Remember: each file must be wrapped in \`\`\`filepath:...\n\`\`\` format.`;

    return `${EDIT_SYSTEM_PROMPT}\n\n## Task Description\n${taskDesc}\n\n## Working Directory\n${workingDirectory}\n\n## Current File Content\n${fileContext}${structureSection}${mcpSection}\n${instructions}`;
  }

  /**
   * Select files within the character budget, prioritizing smaller files.
   */
  private selectFilesWithinBudget(
    artifacts: Artifact[],
    budget: number,
  ): Array<{ artifact: Artifact; truncated: string | null }> {
    const sorted = [...artifacts]
      .map((a) => ({ artifact: a, size: a.content.length }))
      .sort((a, b) => a.size - b.size);

    const result: Array<{ artifact: Artifact; truncated: string | null }> = [];
    let used = 0;

    for (const { artifact, size } of sorted) {
      if (result.length >= MAX_CONTEXT_FILES) break;

      const totalNeeded = size + OVERHEAD_PER_FILE;

      if (used + totalNeeded <= budget) {
        result.push({ artifact, truncated: null });
        used += totalNeeded;
      } else if (used + OVERHEAD_PER_FILE < budget) {
        const remaining = budget - used - OVERHEAD_PER_FILE;
        if (remaining > 200) {
          const truncated = artifact.content.slice(0, remaining);
          result.push({ artifact, truncated });
          used = budget;
        }
        break;
      } else {
        break;
      }
    }

    return result;
  }

  // ─── File Change Parsing ─────────────────────────────────────────────

  /**
   * Parse the LLM response to extract file changes.
   */
  private parseFileChanges(response: string, workingDir: string): FileChange[] {
    const changes: FileChange[] = [];

    // Match code blocks containing a real file path
    const blockRegex = /```(?:[a-zA-Z0-9+#]*\s+)?(?:filepath:)?([^\n`]+(?:\.[a-zA-Z0-9]+|\/[^\n`]+))\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = blockRegex.exec(response)) !== null) {
      let filePath = match[1].trim();
      const content = match[2].trim();

      // Clean up the file path
      filePath = filePath.replace(/^['"]|['"]$/g, '').trim();

      if (!filePath || !content) continue;

      this.addFileChange(changes, filePath, content, workingDir);
    }

    return changes;
  }

  /**
   * Add a file change entry, comparing with existing content if the file exists.
   */
  private addFileChange(
    changes: FileChange[],
    filePath: string,
    content: string,
    workingDir: string,
  ): void {
    const absolutePath = isAbsolute(filePath) ? filePath : join(workingDir, filePath);

    if (existsSync(absolutePath)) {
      const originalContent = readFileSync(absolutePath, 'utf-8');
      if (originalContent.trim() !== content.trim()) {
        changes.push({
          path: filePath,
          originalContent,
          newContent: content,
          status: 'modified',
        });
      }
    } else {
      changes.push({
        path: filePath,
        newContent: content,
        status: 'created',
      });
    }
  }

  // ─── Validation ──────────────────────────────────────────────────────

  /**
   * Validate file changes via AST syntax checking.
   * Returns warning messages for any files with unbalanced syntax.
   */
  private validateChanges(changes: FileChange[]): string[] {
    const warnings: string[] = [];

    for (const change of changes) {
      if (change.newContent) {
        const lang = detectLanguage(change.path);
        if (lang !== 'unknown') {
          const isValid = validateSyntax(change.newContent, lang);
          if (!isValid) {
            warnings.push(`Syntax warning: ${change.path} has unbalanced brackets`);
          }
        }
      }
    }

    return warnings;
  }

  // ─── Rate Limit Helpers ──────────────────────────────────────────────

  /**
   * Check if an error message indicates a rate-limit (429) error.
   */
  private isRateLimitError(errorMessage: string): boolean {
    return /rate\s*limit|429|too many requests|try again in/i.test(errorMessage);
  }

  /**
   * Parse the "try again in Xs" hint from a rate-limit error response.
   */
  private parseRetryAfterHint(errorMessage: string): number | null {
    const secondMatch = errorMessage.match(/try again in ([\d.]+)s/i);
    if (secondMatch) {
      const seconds = parseFloat(secondMatch[1]);
      if (!isNaN(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
    }

    const msMatch = errorMessage.match(/try again in (\d+)ms/i);
    if (msMatch) {
      const ms = parseInt(msMatch[1], 10);
      if (!isNaN(ms) && ms > 0) return ms;
    }

    return null;
  }
}
