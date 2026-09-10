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
export interface SkillMetadata {
    /** Skill name */
    name: string;
    /** Skill description */
    description: string;
    /** Skill author (if known) */
    author?: string;
    /** Skill version (if known) */
    version?: string;
    /** Skill source (bundled, marketplace, local) */
    source: 'bundled' | 'marketplace' | 'local';
    /** Skill runtime (python, node, shell) */
    runtime: string;
    /** Required environment variables */
    requiredEnvVars?: string[];
    /** Skill file hash (for integrity verification) */
    hash?: string;
}
export interface ApprovalDecision {
    /** Whether execution was approved */
    approved: boolean;
    /** Timestamp of decision */
    timestamp: number;
    /** Session ID (for session-scoped approval) */
    sessionId: string;
    /** User note (optional) */
    note?: string;
}
export interface ApprovalRequest {
    /** Unique request ID */
    id: string;
    /** Skill metadata */
    skill: SkillMetadata;
    /** Requested execution command */
    command: string;
    /** Timestamp of request */
    timestamp: number;
}
/**
 * Check if a skill is trusted (bundled).
 */
export declare function isSkillTrusted(skillName: string): boolean;
/**
 * Check if a skill has been approved in this session.
 */
export declare function isSkillApproved(skillName: string, sessionId: string): boolean;
/**
 * Create an approval request for a skill.
 */
export declare function createApprovalRequest(skill: SkillMetadata, command: string): ApprovalRequest;
/**
 * Record an approval decision.
 */
export declare function recordApprovalDecision(skillName: string, sessionId: string, decision: ApprovalDecision): void;
/**
 * Check if execution should proceed (auto-approve trusted skills).
 */
export declare function shouldApproveExecution(skill: SkillMetadata, sessionId: string, autoApproveTrusted?: boolean): {
    approved: boolean;
    reason: string;
};
/**
 * Generate approval prompt for the user.
 */
export declare function generateApprovalPrompt(request: ApprovalRequest): string;
/**
 * Parse user response to approval prompt.
 */
export declare function parseApprovalResponse(response: string): {
    approved: boolean;
    always: boolean;
};
/**
 * Clear session approvals.
 */
export declare function clearSessionApprovals(sessionId: string): void;
/**
 * Get approval statistics for a session.
 */
export declare function getApprovalStats(sessionId: string): {
    total: number;
    approved: number;
    rejected: number;
};
//# sourceMappingURL=execution-approval.d.ts.map