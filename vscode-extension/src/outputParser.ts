/**
 * Output Parser — Standalone utilities for parsing CLI output into structured results.
 *
 * Extracted from CommandRegistrar for better testability and reusability.
 *
 * parseCLIOutput() — Parses CLI stdout into a structured AgentResult
 *                    by extracting file changes from emoji markers,
 *                    text markers, and diff headers.
 *
 * generateSummary() — Generates a human-readable summary from detected file changes
 *                     or falls back to extracting the first meaningful line of output.
 */

import type { AgentResult, FileChange } from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Regex patterns for detecting file changes in CLI output */
const CHANGE_PATTERNS: RegExp[] = [
  // Pattern: 📄 path/to/file (created/new)
  /^📄\s+(.+?)\s+\((created|new)\)/,
  // Pattern: ✏️ path/to/file (modified/updated/changed)
  /^✏️\s+(.+?)\s+\((modified|updated|changed)\)/,
  // Pattern: 🗑️ path/to/file (deleted/removed)
  /^🗑️\s+(.+?)\s+\((deleted|removed)\)/,
  // Pattern: Created: path/to/file
  /^(?:Created|New):\s+(.+)/i,
  // Pattern: Modified: path/to/file
  /^(?:Modified|Updated|Changed):\s+(.+)/i,
  // Pattern: Deleted: path/to/file
  /^(?:Deleted|Removed):\s+(.+)/i,
  // Pattern: +++ or --- style diff headers
  /^\+\+\+\s+(?:b\/)?(.+)/,
];

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse CLI stdout into a structured AgentResult.
 * Extracts file changes from emoji-marked lines, text markers, and diff headers.
 *
 * @param stdout — Raw stdout from the CLI process
 * @returns A structured AgentResult with detected file changes
 */
export function parseCLIOutput(stdout: string): AgentResult {
  const changes: FileChange[] = [];
  const lines = stdout.split('\n');

  for (const line of lines) {
    for (const pattern of CHANGE_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        const path = match[1].trim();
        const typeLine = line;

        let type: FileChange['type'] = 'modified';
        if (typeLine.includes('📄') || typeLine.match(/created|new/i)) {
          type = 'created';
        } else if (typeLine.includes('🗑️') || typeLine.match(/deleted|removed/i)) {
          type = 'deleted';
        } else if (typeLine.match(/^\+\+\+/)) {
          type = 'modified';
        }

        // Avoid duplicates
        if (!changes.some((c) => c.path === path)) {
          changes.push({ path, type, applied: false });
        }
        break;
      }
    }
  }

  return {
    success: true,
    summary: generateSummary(changes, stdout),
    changes,
    durationMs: 0,
    output: stdout,
  };
}

/**
 * Generate a human-readable summary from detected file changes.
 * If there are changes, returns a count summary.
 * Otherwise, falls back to extracting the first meaningful line of output.
 *
 * @param changes — Detected file changes
 * @param output — Full CLI output text
 * @returns A concise summary string
 */
export function generateSummary(changes: FileChange[], output: string): string {
  if (changes.length > 0) {
    const created = changes.filter((c) => c.type === 'created').length;
    const modified = changes.filter((c) => c.type === 'modified').length;
    const deleted = changes.filter((c) => c.type === 'deleted').length;

    const parts: string[] = [];
    if (created > 0) parts.push(`${created} created`);
    if (modified > 0) parts.push(`${modified} modified`);
    if (deleted > 0) parts.push(`${deleted} deleted`);

    return `Changes: ${parts.join(', ')}`;
  }

  // Fall back to extracting first meaningful line
  const firstLine = output.split('\n').find(
    (l) => l.length > 20 && !l.startsWith('[') && !l.startsWith('ℹ') && !l.startsWith('✔'),
  );
  return firstLine?.trim().slice(0, 150) || 'Task completed.';
}
