/**
 * Security Scanner — Reusable utilities for detecting security issues.
 *
 * Capabilities:
 * - PII detection (emails, API keys, tokens, SSNs, etc.)
 * - Prompt injection pattern detection
 * - Dangerous code pattern detection (eval, exec, shell injection, etc.)
 * - File permission checks
 *
 * Used by SecurityAgent and can be imported directly for custom use.
 */
export interface SecurityFinding {
    type: 'pii' | 'injection' | 'dangerous-code';
    severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
    category: string;
    match: string;
    context?: string;
    line?: number;
    recommendation?: string;
}
export interface ScanResult {
    passed: boolean;
    findings: SecurityFinding[];
    summary: string;
}
/**
 * Scan text for PII (personally identifiable information).
 */
export declare function scanForPII(text: string): SecurityFinding[];
/**
 * Scan text for prompt injection attempts.
 */
export declare function scanForInjections(text: string): SecurityFinding[];
/**
 * Scan code for dangerous patterns.
 */
export declare function scanForDangerousCode(code: string, contextInfo?: {
    isGenerated?: boolean;
    filename?: string;
}): SecurityFinding[];
/**
 * Run all security scans on a given text.
 * Convenience function that combines PII, injection, and code scans.
 */
export declare function runAllScans(text: string, options?: {
    isGenerated?: boolean;
    filename?: string;
}): ScanResult;
/**
 * Format findings as a readable report string.
 */
export declare function formatScanReport(result: ScanResult): string;
//# sourceMappingURL=scanner.d.ts.map