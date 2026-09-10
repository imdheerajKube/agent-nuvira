/**
 * Execution Approval — User consent before running marketplace skills.
 *
 * This provides the same security model as Hermes' `skills_tool.py` approval:
 * - User must approve execution of untrusted skills
 * - Shows skill metadata before execution
 * - Records approval decision
 * - Supports session-scoped approval (approve once for the session)
 *
 * Flow:
 * 1. Agent requests skill execution
 * 2. System checks if skill is trusted (bundled vs marketplace)
 * 3. If untrusted, prompts user for approval
 * 4. User approves/rejects
 * 5. Decision is recorded for the session
 */
import { randomBytes } from 'node:crypto';
// ─── Approval Store ──────────────────────────────────────────────────────
/** Session-scoped approval decisions */
const sessionApprovals = new Map();
/** Trusted skill names (bundled skills) */
const TRUSTED_SKILLS = new Set([
    'website-deploy',
    'code-assessment',
    'technical-roadmap',
    'plan-create-track',
    'test-strategy',
    'docx',
    'security-audit',
    'api-design',
    'db-migration',
    'perf-profile',
    'doc-gen',
    'ci-cd-setup',
    'docker-config',
    'dep-update',
    'code-refactor',
    'env-setup',
    'data-analysis',
    'api-testing',
    'perf-test',
    'a11y-audit',
    'search-setup',
    'email-setup',
    'payment-setup',
    'auth-setup',
    'monitoring-setup',
    'backup-recovery',
    'schema-design',
    'i18n-setup',
    'graphql-api',
    'git-release',
    'design-system',
    'legal-compliance',
    'cron-setup',
    'image-optimize',
    'pdf-generate',
    'cache-setup',
    'queue-setup',
    'rate-limit',
    'cors-setup',
    'error-tracking',
    'feature-flags',
    'webhook-setup',
    'form-builder',
    'data-sync',
    'state-machine',
    'websocket-setup',
    'api-versioning',
    'multi-tenancy',
    'blob-storage',
    'notification-setup',
    // Sample skills
    'image-gen',
    'api-call',
    'system-check',
]);
// ─── Approval Functions ──────────────────────────────────────────────────
/**
 * Check if a skill is trusted (bundled).
 */
export function isSkillTrusted(skillName) {
    return TRUSTED_SKILLS.has(skillName);
}
/**
 * Check if a skill has been approved in this session.
 */
export function isSkillApproved(skillName, sessionId) {
    const decision = sessionApprovals.get(`${skillName}:${sessionId}`);
    return decision?.approved === true;
}
/**
 * Create an approval request for a skill.
 */
export function createApprovalRequest(skill, command) {
    return {
        id: randomBytes(8).toString('hex'),
        skill,
        command,
        timestamp: Date.now(),
    };
}
/**
 * Record an approval decision.
 */
export function recordApprovalDecision(skillName, sessionId, decision) {
    sessionApprovals.set(`${skillName}:${sessionId}`, decision);
}
/**
 * Check if execution should proceed (auto-approve trusted skills).
 */
export function shouldApproveExecution(skill, sessionId, autoApproveTrusted = true) {
    // Auto-approve trusted skills if enabled
    if (autoApproveTrusted && isSkillTrusted(skill.name)) {
        return { approved: true, reason: 'Trusted bundled skill' };
    }
    // Check session approval
    if (isSkillApproved(skill.name, sessionId)) {
        return { approved: true, reason: 'Previously approved in this session' };
    }
    // Check source
    if (skill.source === 'local') {
        return { approved: true, reason: 'Local skill (user-managed)' };
    }
    // Requires approval
    return {
        approved: false,
        reason: `Untrusted skill '${skill.name}' from ${skill.source} requires approval`,
    };
}
/**
 * Generate approval prompt for the user.
 */
export function generateApprovalPrompt(request) {
    const lines = [
        `🔐 Skill Execution Request`,
        ``,
        `Skill: ${request.skill.name}`,
        `Description: ${request.skill.description}`,
        `Runtime: ${request.skill.runtime}`,
        `Source: ${request.skill.source}`,
    ];
    if (request.skill.author) {
        lines.push(`Author: ${request.skill.author}`);
    }
    if (request.skill.version) {
        lines.push(`Version: ${request.skill.version}`);
    }
    if (request.skill.requiredEnvVars && request.skill.requiredEnvVars.length > 0) {
        lines.push(``, `Required Environment Variables:`);
        for (const envVar of request.skill.requiredEnvVars) {
            lines.push(`  • ${envVar}`);
        }
    }
    lines.push(``, `Command to execute:`, `  ${request.command}`, ``, `⚠️  This skill will execute code on your system.`, `Do you want to proceed?`, ``, `Reply with:`, `  • "yes" or "y" — Approve this execution`, `  • "no" or "n" — Reject this execution`, `  • "always" — Approve all executions of this skill in this session`);
    return lines.join('\n');
}
/**
 * Parse user response to approval prompt.
 */
export function parseApprovalResponse(response) {
    const normalized = response.toLowerCase().trim();
    if (normalized === 'yes' || normalized === 'y' || normalized === 'approve') {
        return { approved: true, always: false };
    }
    if (normalized === 'always' || normalized === 'always-approve') {
        return { approved: true, always: true };
    }
    return { approved: false, always: false };
}
/**
 * Clear session approvals.
 */
export function clearSessionApprovals(sessionId) {
    for (const key of sessionApprovals.keys()) {
        if (key.endsWith(`:${sessionId}`)) {
            sessionApprovals.delete(key);
        }
    }
}
/**
 * Get approval statistics for a session.
 */
export function getApprovalStats(sessionId) {
    let total = 0;
    let approved = 0;
    let rejected = 0;
    for (const [key, decision] of sessionApprovals.entries()) {
        if (key.endsWith(`:${sessionId}`)) {
            total++;
            if (decision.approved) {
                approved++;
            }
            else {
                rejected++;
            }
        }
    }
    return { total, approved, rejected };
}
//# sourceMappingURL=execution-approval.js.map