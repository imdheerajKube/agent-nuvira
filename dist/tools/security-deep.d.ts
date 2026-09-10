/**
 * Security Deep — Advanced security analysis tools.
 *
 * Hermes equivalents:
 * - skills_ast_audit.py (133 lines) — AST-based code audit
 * - threat_patterns.py (284 lines) — Threat pattern detection
 * - url_safety.py (874 lines) — URL safety checking
 * - path_security.py (43 lines) — Path traversal prevention
 * - tirith_security.py (872 lines) — Security scoring
 * - skills_guard.py (1,161 lines) — Skill guard/validation
 */
export interface ASTAuditResult {
    file: string;
    issues: ASTIssue[];
    score: number;
    suggestions: string[];
}
export interface ASTIssue {
    severity: 'critical' | 'high' | 'medium' | 'low';
    type: string;
    message: string;
    line?: number;
    column?: number;
    rule: string;
}
export declare class ASTAuditor {
    private rules;
    audit(filePath: string): ASTAuditResult;
}
export interface ThreatMatch {
    pattern: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    location: string;
}
export declare class ThreatDetector {
    private patterns;
    detect(filePath: string): ThreatMatch[];
}
export interface URLSafetyResult {
    url: string;
    safe: boolean;
    reasons: string[];
    category?: string;
}
export declare class URLSafetyChecker {
    private suspiciousTlds;
    private suspiciousPatterns;
    check(url: string): URLSafetyResult;
}
export declare class PathSecurityChecker {
    /**
     * Check if a path is safe (no traversal attacks).
     */
    checkPath(path: string, allowedDir?: string): {
        safe: boolean;
        reason?: string;
    };
}
export interface SecurityScore {
    overall: number;
    categories: {
        codeInjection: number;
        secrets: number;
        threats: number;
        pathTraversal: number;
    };
    recommendations: string[];
}
export declare class SecurityScorer {
    private astAuditor;
    private threatDetector;
    private pathChecker;
    score(filePath: string): SecurityScore;
}
export declare function getASTAuditor(): ASTAuditor;
export declare function getThreatDetector(): ThreatDetector;
export declare function getURLSafetyChecker(): URLSafetyChecker;
export declare function getPathSecurityChecker(): PathSecurityChecker;
export declare function getSecurityScorer(): SecurityScorer;
//# sourceMappingURL=security-deep.d.ts.map