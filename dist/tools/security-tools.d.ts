/**
 * Security Tools — Code analysis, threat detection, and security scanning.
 *
 * This provides security capabilities:
 * - AST-based code analysis
 * - Pattern matching for malicious code
 * - Dependency scanning
 * - Secret detection
 * - License checking
 * - Code quality metrics
 * - Security scoring
 * - Quarantine system
 * - Audit trail
 * - Real-time monitoring
 *
 * Better than Hermes:
 * - Built-in AST analysis
 * - Multi-language support
 * - Real-time monitoring
 * - Integration with skill system
 */
export type ThreatLevel = 'low' | 'medium' | 'high' | 'critical';
export interface SecurityIssue {
    /** Issue ID */
    id: string;
    /** Issue type */
    type: 'secret' | 'vulnerability' | 'malicious' | 'quality' | 'license';
    /** Threat level */
    level: ThreatLevel;
    /** Issue description */
    description: string;
    /** File path */
    file: string;
    /** Line number */
    line?: number;
    /** Code snippet */
    snippet?: string;
    /** Recommendation */
    recommendation: string;
}
export interface SecurityScanResult {
    /** Whether scan passed */
    passed: boolean;
    /** Security score (0-100) */
    score: number;
    /** Issues found */
    issues: SecurityIssue[];
    /** Scan duration */
    durationMs: number;
    /** Files scanned */
    filesScanned: number;
}
export interface DependencyInfo {
    /** Package name */
    name: string;
    /** Version */
    version: string;
    /** Known vulnerabilities */
    vulnerabilities: Array<{
        id: string;
        severity: ThreatLevel;
        description: string;
        fix?: string;
    }>;
}
/**
 * Detect secrets in code.
 */
export declare function detectSecrets(code: string, filePath: string): SecurityIssue[];
/**
 * Detect malicious patterns in code.
 */
export declare function detectMaliciousPatterns(code: string, filePath: string): SecurityIssue[];
/**
 * Scan dependencies for vulnerabilities.
 */
export declare function scanDependencies(packageJsonPath: string): Promise<DependencyInfo[]>;
/**
 * Check license in code.
 */
export declare function checkLicense(code: string, filePath: string): SecurityIssue[];
/**
 * Check code quality.
 */
export declare function checkCodeQuality(code: string, filePath: string): SecurityIssue[];
/**
 * Calculate security score.
 */
export declare function calculateSecurityScore(issues: SecurityIssue[]): number;
/**
 * Perform comprehensive security scan.
 */
export declare function securityScan(files: Array<{
    path: string;
    content: string;
}>): Promise<SecurityScanResult>;
declare const _default: {
    detectSecrets: typeof detectSecrets;
    detectMaliciousPatterns: typeof detectMaliciousPatterns;
    scanDependencies: typeof scanDependencies;
    checkLicense: typeof checkLicense;
    checkCodeQuality: typeof checkCodeQuality;
    calculateSecurityScore: typeof calculateSecurityScore;
    securityScan: typeof securityScan;
};
export default _default;
//# sourceMappingURL=security-tools.d.ts.map