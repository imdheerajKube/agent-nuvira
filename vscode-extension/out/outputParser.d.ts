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
/**
 * Parse CLI stdout into a structured AgentResult.
 * Extracts file changes from emoji-marked lines, text markers, and diff headers.
 *
 * @param stdout — Raw stdout from the CLI process
 * @returns A structured AgentResult with detected file changes
 */
export declare function parseCLIOutput(stdout: string): AgentResult;
/**
 * Generate a human-readable summary from detected file changes.
 * If there are changes, returns a count summary.
 * Otherwise, falls back to extracting the first meaningful line of output.
 *
 * @param changes — Detected file changes
 * @param output — Full CLI output text
 * @returns A concise summary string
 */
export declare function generateSummary(changes: FileChange[], output: string): string;
//# sourceMappingURL=outputParser.d.ts.map