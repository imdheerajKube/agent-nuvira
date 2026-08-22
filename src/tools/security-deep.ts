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

import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { logger } from '../utils/logger.js';

// ─── AST Audit ────────────────────────────────────────────────────────────

export interface ASTAuditResult {
  file: string;
  issues: ASTIssue[];
  score: number; // 0-100
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

export class ASTAuditor {
  private rules: Array<{ pattern: RegExp; severity: ASTIssue['severity']; type: string; message: string; rule: string }> = [
    // Critical: eval() usage
    { pattern: /\beval\s*\(/g, severity: 'critical', type: 'code-injection', message: 'eval() usage detected — potential code injection', rule: 'no-eval' },
    // Critical: Function constructor
    { pattern: /new\s+Function\s*\(/g, severity: 'critical', type: 'code-injection', message: 'Function constructor detected — potential code injection', rule: 'no-function-constructor' },
    // High: SQL injection patterns
    { pattern: /(?:SELECT|INSERT|UPDATE|DELETE)\s+.*\+\s*/gi, severity: 'high', type: 'sql-injection', message: 'String concatenation in SQL query', rule: 'no-sql-concat' },
    // High: Hardcoded secrets
    { pattern: /(?:password|secret|api_key|token)\s*[:=]\s*['"][^'"]+['"]/gi, severity: 'high', type: 'hardcoded-secret', message: 'Hardcoded secret detected', rule: 'no-hardcoded-secrets' },
    // Medium: console.log in production
    { pattern: /console\.(log|debug|info)\s*\(/g, severity: 'medium', type: 'debug-code', message: 'Console output in code', rule: 'no-console' },
    // Medium: TODO/FIXME
    { pattern: /(?:TODO|FIXME|HACK|XXX)\b/g, severity: 'low', type: 'incomplete', message: 'Incomplete code marker', rule: 'no-todo' },
    // Low: debugger statement
    { pattern: /\bdebugger\b/g, severity: 'medium', type: 'debug-code', message: 'Debugger statement detected', rule: 'no-debugger' },
  ];

  audit(filePath: string): ASTAuditResult {
    const issues: ASTIssue[] = [];
    const suggestions: string[] = [];

    if (!existsSync(filePath)) {
      return { file: filePath, issues: [], score: 100, suggestions: ['File not found'] };
    }

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const rule of this.rules) {
      const matches = content.matchAll(rule.pattern);
      for (const match of matches) {
        const index = match.index || 0;
        const lineNum = content.substring(0, index).split('\n').length;
        issues.push({
          severity: rule.severity,
          type: rule.type,
          message: rule.message,
          line: lineNum,
          rule: rule.rule,
        });
      }
    }

    // Calculate score
    const criticalCount = issues.filter((i) => i.severity === 'critical').length;
    const highCount = issues.filter((i) => i.severity === 'high').length;
    const mediumCount = issues.filter((i) => i.severity === 'medium').length;
    const score = Math.max(0, 100 - (criticalCount * 30) - (highCount * 15) - (mediumCount * 5));

    // Generate suggestions
    if (criticalCount > 0) suggestions.push('Remove eval() and Function constructor usage');
    if (highCount > 0) suggestions.push('Use parameterized queries and environment variables');
    if (mediumCount > 0) suggestions.push('Remove debug statements for production');

    return { file: filePath, issues, score, suggestions };
  }
}

// ─── Threat Patterns ──────────────────────────────────────────────────────

export interface ThreatMatch {
  pattern: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  location: string;
}

export class ThreatDetector {
  private patterns: Array<{ regex: RegExp; severity: ThreatMatch['severity']; description: string }> = [
    // Remote code execution
    { regex: /child_process\.exec\s*\(/g, severity: 'high', description: 'Shell command execution' },
    { regex: /spawn\s*\(\s*['"][^'"]*['"]/g, severity: 'medium', description: 'Process spawning' },
    // Data exfiltration
    { regex: /fetch\s*\(\s*['"]https?:\/\/[^'"]+['"]/g, severity: 'medium', description: 'External HTTP request' },
    { regex: /axios\.(get|post|put|delete)\s*\(\s*['"]https?:\/\//g, severity: 'medium', description: 'External API call' },
    // Privilege escalation
    { regex: /process\.env\./g, severity: 'low', description: 'Environment variable access' },
    { regex: /require\s*\(\s*['"]child_process['"]\s*\)/g, severity: 'medium', description: 'Child process import' },
    // Obfuscation
    { regex: /atob\s*\(/g, severity: 'medium', description: 'Base64 decoding (possible obfuscation)' },
    { regex: /String\.fromCharCode/g, severity: 'low', description: 'Character code conversion' },
  ];

  detect(filePath: string): ThreatMatch[] {
    const matches: ThreatMatch[] = [];
    if (!existsSync(filePath)) return matches;

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const pattern of this.patterns) {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match;
      while ((match = regex.exec(content)) !== null) {
        const index = match.index;
        const lineNum = content.substring(0, index).split('\n').length;
        matches.push({
          pattern: pattern.regex.source,
          severity: pattern.severity,
          description: pattern.description,
          location: `${filePath}:${lineNum}`,
        });
      }
    }

    return matches;
  }
}

// ─── URL Safety ───────────────────────────────────────────────────────────

export interface URLSafetyResult {
  url: string;
  safe: boolean;
  reasons: string[];
  category?: string;
}

export class URLSafetyChecker {
  private suspiciousTlds = ['.tk', '.ml', '.ga', '.cf', '.gq', '.xyz', '.top', '.buzz'];
  private suspiciousPatterns = [
    /phishing/i,
    /malware/i,
    /virus/i,
    /hack/i,
    /crack/i,
    /keylog/i,
  ];

  check(url: string): URLSafetyResult {
    const reasons: string[] = [];
    let safe = true;

    // Check for suspicious TLDs
    for (const tld of this.suspiciousTlds) {
      if (url.toLowerCase().endsWith(tld)) {
        reasons.push(`Suspicious TLD: ${tld}`);
        safe = false;
      }
    }

    // Check for suspicious patterns
    for (const pattern of this.suspiciousPatterns) {
      if (pattern.test(url)) {
        reasons.push(`Suspicious pattern: ${pattern.source}`);
        safe = false;
      }
    }

    // Check for IP address instead of domain
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(url)) {
      reasons.push('IP address used instead of domain');
    }

    // Check for very long URLs (possible obfuscation)
    if (url.length > 2000) {
      reasons.push('Unusually long URL');
      safe = false;
    }

    return { url, safe, reasons };
  }
}

// ─── Path Security ────────────────────────────────────────────────────────

export class PathSecurityChecker {
  /**
   * Check if a path is safe (no traversal attacks).
   */
  checkPath(path: string, allowedDir?: string): { safe: boolean; reason?: string } {
    // Check for path traversal
    if (path.includes('..')) {
      return { safe: false, reason: 'Path traversal detected (..)' };
    }

    // Check for null bytes
    if (path.includes('\0')) {
      return { safe: false, reason: 'Null byte in path' };
    }

    // Check for absolute path outside allowed dir
    if (allowedDir && isAbsolute(path)) {
      const resolved = resolve(path);
      const allowed = resolve(allowedDir);
      if (!resolved.startsWith(allowed)) {
        return { safe: false, reason: 'Path outside allowed directory' };
      }
    }

    return { safe: true };
  }
}

// ─── Security Score ───────────────────────────────────────────────────────

export interface SecurityScore {
  overall: number; // 0-100
  categories: {
    codeInjection: number;
    secrets: number;
    threats: number;
    pathTraversal: number;
  };
  recommendations: string[];
}

export class SecurityScorer {
  private astAuditor = new ASTAuditor();
  private threatDetector = new ThreatDetector();
  private pathChecker = new PathSecurityChecker();

  score(filePath: string): SecurityScore {
    const astResult = this.astAuditor.audit(filePath);
    const threats = this.threatDetector.detect(filePath);

    const codeInjectionScore = 100 - (astResult.issues.filter((i) => i.type === 'code-injection').length * 30);
    const secretsScore = 100 - (astResult.issues.filter((i) => i.type === 'hardcoded-secret').length * 25);
    const threatsScore = 100 - (threats.filter((t) => t.severity === 'high').length * 20);
    const pathScore = 100; // Would need actual path checks

    const overall = Math.round((codeInjectionScore + secretsScore + threatsScore + pathScore) / 4);

    const recommendations: string[] = [];
    if (codeInjectionScore < 80) recommendations.push('Remove eval() and dynamic code execution');
    if (secretsScore < 80) recommendations.push('Move secrets to environment variables');
    if (threatsScore < 80) recommendations.push('Review external HTTP calls and process spawning');

    return {
      overall: Math.max(0, overall),
      categories: {
        codeInjection: Math.max(0, codeInjectionScore),
        secrets: Math.max(0, secretsScore),
        threats: Math.max(0, threatsScore),
        pathTraversal: Math.max(0, pathScore),
      },
      recommendations,
    };
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────

export function getASTAuditor(): ASTAuditor { return new ASTAuditor(); }
export function getThreatDetector(): ThreatDetector { return new ThreatDetector(); }
export function getURLSafetyChecker(): URLSafetyChecker { return new URLSafetyChecker(); }
export function getPathSecurityChecker(): PathSecurityChecker { return new PathSecurityChecker(); }
export function getSecurityScorer(): SecurityScorer { return new SecurityScorer(); }
