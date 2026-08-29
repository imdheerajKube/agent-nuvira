/**
 * Security command — Scan code, prompts, or files for security issues.
 *
 * Usage:
 *   nuvira security scan <text>        — Scan inline text for issues
 *   nuvira security scan --file <path> — Scan a file for issues
 *   nuvira security scan --stdin       — Read input from stdin (pipe)
 *   nuvira security scan --prompt      — Only check for prompt injection
 *   nuvira security scan --code        — Only check for dangerous code patterns
 *   nuvira security scan --pii         — Only check for PII
 *   nuvira security scan --generated   — Mark input as AI-generated (lower severity)
 *   nuvira security scan --json        — Output results as JSON
 *   nuvira security scan --strict      — Fail on medium+ severity (default: high+)
 *
 * The scanner detects:
 * - PII (emails, API keys, tokens, SSNs, credit cards, phones)
 * - Prompt injection patterns (jailbreaks, prompt leaking, token smuggling)
 * - Dangerous code patterns (eval, exec, shell injection, SQL injection, etc.)
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class SecurityCommand extends BaseCommand {
    create(): Command;
    private runScan;
}
//# sourceMappingURL=security.d.ts.map