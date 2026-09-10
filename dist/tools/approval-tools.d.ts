/**
 * Approval Tools — Write approval and slash confirm workflows.
 *
 * Hermes equivalent: write_approval.py + slash_confirm.py
 */
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'timeout';
export interface ApprovalRequest {
    /** Request ID */
    id: string;
    /** Description of what needs approval */
    description: string;
    /** Target files/operations */
    targets: string[];
    /** Risk level */
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    /** Requester (agent/tool name) */
    requester: string;
    /** Status */
    status: ApprovalStatus;
    /** Decision reason */
    decisionReason?: string;
    /** Created at */
    createdAt: number;
    /** Decided at */
    decidedAt?: number;
    /** Expires at */
    expiresAt: number;
}
export interface ApprovalPolicy {
    /** Policy name */
    name: string;
    /** Pattern to match */
    pattern: RegExp;
    /** Auto-approve if matched */
    autoApprove: boolean;
    /** Risk level override */
    riskLevel?: 'low' | 'medium' | 'high' | 'critical';
    /** Description */
    description: string;
}
export declare class ApprovalManager {
    private requests;
    private policies;
    /**
     * Create an approval request.
     */
    request(options: {
        description: string;
        targets: string[];
        requester: string;
        timeoutMs?: number;
    }): ApprovalRequest;
    /**
     * Decide on an approval request.
     */
    decide(requestId: string, approved: boolean, reason?: string): boolean;
    /**
     * Get a request by ID.
     */
    get(requestId: string): ApprovalRequest | null;
    /**
     * Get pending requests.
     */
    getPending(): ApprovalRequest[];
    /**
     * Check if expired requests need cleanup.
     */
    cleanupExpired(): number;
}
export interface ConfirmPrompt {
    /** Prompt ID */
    id: string;
    /** Message to confirm */
    message: string;
    /** Options */
    options: string[];
    /** Default option */
    default?: string;
    /** Created at */
    createdAt: number;
}
export declare class SlashConfirm {
    private prompts;
    /**
     * Create a confirmation prompt.
     */
    create(message: string, options?: string[], defaultOption?: string): ConfirmPrompt;
    /**
     * Resolve a confirmation prompt.
     */
    resolve(promptId: string, selected: string): boolean;
    /**
     * Get a prompt by ID.
     */
    get(promptId: string): ConfirmPrompt | null;
}
export declare function getApprovalManager(): ApprovalManager;
export declare function getSlashConfirm(): SlashConfirm;
//# sourceMappingURL=approval-tools.d.ts.map