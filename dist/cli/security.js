/**
 * Security command — Scan code, prompts, or files for security issues.
 *
 * Usage:
 *   buff security scan <text>        — Scan inline text for issues
 *   buff security scan --file <path> — Scan a file for issues
 *   buff security scan --stdin       — Read input from stdin (pipe)
 *   buff security scan --prompt      — Only check for prompt injection
 *   buff security scan --code        — Only check for dangerous code patterns
 *   buff security scan --pii         — Only check for PII
 *   buff security scan --generated   — Mark input as AI-generated (lower severity)
 *   buff security scan --json        — Output results as JSON
 *   buff security scan --strict      — Fail on medium+ severity (default: high+)
 *
 * The scanner detects:
 * - PII (emails, API keys, tokens, SSNs, credit cards, phones)
 * - Prompt injection patterns (jailbreaks, prompt leaking, token smuggling)
 * - Dangerous code patterns (eval, exec, shell injection, SQL injection, etc.)
 */
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
import { runAllScans, scanForPII, scanForInjections, scanForDangerousCode, } from '../security/scanner.js';
import { logger } from '../utils/logger.js';
export class SecurityCommand extends BaseCommand {
    create() {
        const command = new Command('security')
            .description('Scan code, prompts, or files for security issues');
        // ── scan ──────────────────────────────────────────────────────────────
        command
            .command('scan')
            .description('Scan for PII, injection attempts, or dangerous code patterns')
            .argument('[input]', 'Text to scan (omit for --file, --stdin, or interactive input)')
            .option('-f, --file <path>', 'Path to a file to scan')
            .option('--stdin', 'Read input from stdin')
            .option('--prompt', 'Only check for prompt injection patterns')
            .option('--code', 'Only check for dangerous code patterns')
            .option('--pii', 'Only check for PII (personally identifiable information)')
            .option('--generated', 'Mark input as AI-generated (lowers severity of some patterns)')
            .option('--json', 'Output findings as JSON')
            .option('--strict', 'Fail on medium severity findings too (default: fail on high+)')
            .action(async (input, options) => {
            await this.runScan(input, options || {});
        });
        return command;
    }
    async runScan(input, options) {
        // ── Resolve input source ────────────────────────────────────────────
        let text;
        if (options.file) {
            try {
                text = readFileSync(options.file, 'utf-8');
                logger.info(`📄 Scanning file: ${options.file}`);
            }
            catch (err) {
                logger.error(`Failed to read file: ${options.file}`);
                logger.error(String(err));
                process.exit(1);
            }
        }
        else if (options.stdin) {
            // Read from stdin
            const chunks = [];
            for await (const chunk of process.stdin) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            text = Buffer.concat(chunks).toString('utf-8');
        }
        else if (input) {
            text = input;
        }
        else {
            // No input provided — show usage hint instead of hanging on stdin
            logger.error('No input provided. Use one of these:');
            console.log('');
            console.log('  buff security scan "check this code for secrets"');
            console.log('  buff security scan --file ./script.js');
            console.log('  cat payload.txt | buff security scan --stdin');
            console.log('  buff security scan --prompt');
            console.log('');
            return;
        }
        if (!text || text.trim().length === 0) {
            logger.error('No input provided. Use --file, --stdin, or provide text as an argument.');
            console.log('');
            console.log('  Examples:');
            console.log('    buff security scan "Check this code"');
            console.log('    buff security scan --file ./script.js');
            console.log('    cat payload.txt | buff security scan --stdin');
            console.log('');
            return;
        }
        // ── Run the scan ────────────────────────────────────────────────────
        const filename = options.file || undefined;
        const scanOptions = { isGenerated: options.generated, filename };
        let findings = [];
        if (options.prompt) {
            findings = scanForInjections(text);
        }
        else if (options.code) {
            findings = scanForDangerousCode(text, scanOptions);
        }
        else if (options.pii) {
            findings = scanForPII(text);
        }
        else {
            // Full scan
            const result = runAllScans(text, scanOptions);
            findings = result.findings;
        }
        // ── Determine pass/fail ────────────────────────────────────────────
        const failSeverities = new Set(options.strict
            ? ['critical', 'high', 'medium']
            : ['critical', 'high']);
        const failedFindings = findings.filter((f) => failSeverities.has(f.severity));
        const passed = failedFindings.length === 0;
        // ── Output ──────────────────────────────────────────────────────────
        if (options.json) {
            const result = {
                passed,
                findings,
                summary: findings.length === 0
                    ? 'Security scan passed — no issues found'
                    : `Security scan found ${findings.length} issue(s)`,
            };
            console.log(JSON.stringify(result, null, 2));
            process.exit(passed ? 0 : 1);
            return;
        }
        console.log('');
        if (findings.length === 0) {
            logger.success('Security scan passed — no issues found');
            console.log('');
            return;
        }
        // ── Summary header ─────────────────────────────────────────────────
        const criticalCount = findings.filter((f) => f.severity === 'critical').length;
        const highCount = findings.filter((f) => f.severity === 'high').length;
        const mediumCount = findings.filter((f) => f.severity === 'medium').length;
        const lowCount = findings.filter((f) => f.severity === 'low' || f.severity === 'info').length;
        const summaryParts = [];
        if (criticalCount > 0)
            summaryParts.push(`🔴 ${criticalCount} critical`);
        if (highCount > 0)
            summaryParts.push(`🟠 ${highCount} high`);
        if (mediumCount > 0)
            summaryParts.push(`🟡 ${mediumCount} medium`);
        if (lowCount > 0)
            summaryParts.push(`🔵 ${lowCount} low`);
        const icon = passed ? '⚠️' : '❌';
        logger.highlight(`${icon} Security Scan Results (${findings.length} total)`);
        console.log(`     ${summaryParts.join(' | ')}`);
        console.log('');
        // ── Findings ───────────────────────────────────────────────────────
        for (const finding of findings) {
            const sevIcon = finding.severity === 'critical' ? '🔴' :
                finding.severity === 'high' ? '🟠' :
                    finding.severity === 'medium' ? '🟡' : '🔵';
            const lineStr = finding.line ? `:${finding.line}` : '';
            console.log(`  ${sevIcon} [${finding.severity}] ${finding.category}${lineStr}`);
            console.log(`     ${finding.match.slice(0, 80)}`);
            if (finding.recommendation) {
                console.log(`     💡 ${finding.recommendation}`);
            }
            console.log('');
        }
        // ── Exit code ──────────────────────────────────────────────────────
        if (!passed) {
            logger.error(`❌ Security scan FAILED — ${failedFindings.length} issue(s) above threshold`);
            console.log('');
            process.exit(1);
        }
    }
}
//# sourceMappingURL=security.js.map