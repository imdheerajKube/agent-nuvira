/**
 * Approval Tools — Write approval and slash confirm workflows.
 *
 * Hermes equivalent: write_approval.py + slash_confirm.py
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
// ─── Approval Manager ─────────────────────────────────────────────────────
export class ApprovalManager {
    requests = new Map();
    policies = [
        { name: 'read-only', pattern: /^read_file|^list_dir|^glob|^code_search/i, autoApprove: true, riskLevel: 'low', description: 'Read-only operations' },
        { name: 'git-read', pattern: /^git (status|log|diff|show)/i, autoApprove: true, riskLevel: 'low', description: 'Git read operations' },
        { name: 'npm-test', pattern: /^npm test|^npx vitest|^jest/i, autoApprove: true, riskLevel: 'low', description: 'Test execution' },
        { name: 'write-file', pattern: /^write_file|^edit_file|^str_replace/i, autoApprove: false, riskLevel: 'medium', description: 'File modifications' },
        { name: 'git-write', pattern: /^git (commit|push|merge|rebase|reset)/i, autoApprove: false, riskLevel: 'high', description: 'Git write operations' },
        { name: 'destructive', pattern: /^rm -rf|^drop |^delete |^DROP /i, autoApprove: false, riskLevel: 'critical', description: 'Destructive operations' },
    ];
    /**
     * Create an approval request.
     */
    request(options) {
        // Check policies
        const matchedPolicy = this.policies.find((p) => options.targets.some((t) => p.pattern.test(t)));
        const riskLevel = matchedPolicy?.riskLevel || 'medium';
        const autoApprove = matchedPolicy?.autoApprove || false;
        const request = {
            id: randomUUID(),
            description: options.description,
            targets: options.targets,
            riskLevel,
            requester: options.requester,
            status: autoApprove ? 'approved' : 'pending',
            createdAt: Date.now(),
            expiresAt: Date.now() + (options.timeoutMs || 300_000),
        };
        if (autoApprove) {
            request.decidedAt = Date.now();
            request.decisionReason = `Auto-approved by policy: ${matchedPolicy?.name}`;
            logger.debug(`Approval: Auto-approved '${options.description}' (policy: ${matchedPolicy?.name})`);
        }
        else {
            logger.info(`Approval: Requesting approval for '${options.description}' (risk: ${riskLevel})`);
        }
        this.requests.set(request.id, request);
        return request;
    }
    /**
     * Decide on an approval request.
     */
    decide(requestId, approved, reason) {
        const request = this.requests.get(requestId);
        if (!request || request.status !== 'pending')
            return false;
        request.status = approved ? 'approved' : 'denied';
        request.decisionReason = reason;
        request.decidedAt = Date.now();
        return true;
    }
    /**
     * Get a request by ID.
     */
    get(requestId) {
        return this.requests.get(requestId) || null;
    }
    /**
     * Get pending requests.
     */
    getPending() {
        return [...this.requests.values()].filter((r) => r.status === 'pending');
    }
    /**
     * Check if expired requests need cleanup.
     */
    cleanupExpired() {
        let count = 0;
        for (const request of this.requests.values()) {
            if (request.status === 'pending' && request.expiresAt < Date.now()) {
                request.status = 'expired';
                count++;
            }
        }
        return count;
    }
}
export class SlashConfirm {
    prompts = new Map();
    /**
     * Create a confirmation prompt.
     */
    create(message, options = ['Yes', 'No'], defaultOption) {
        const prompt = {
            id: randomUUID(),
            message,
            options,
            default: defaultOption || options[0],
            createdAt: Date.now(),
        };
        this.prompts.set(prompt.id, prompt);
        return prompt;
    }
    /**
     * Resolve a confirmation prompt.
     */
    resolve(promptId, selected) {
        const prompt = this.prompts.get(promptId);
        if (!prompt)
            return false;
        this.prompts.delete(promptId);
        return selected === prompt.options[0]; // First option is "Yes"
    }
    /**
     * Get a prompt by ID.
     */
    get(promptId) {
        return this.prompts.get(promptId) || null;
    }
}
// ─── Singletons ───────────────────────────────────────────────────────────
let _approvalManager = null;
let _slashConfirm = null;
export function getApprovalManager() {
    if (!_approvalManager)
        _approvalManager = new ApprovalManager();
    return _approvalManager;
}
export function getSlashConfirm() {
    if (!_slashConfirm)
        _slashConfirm = new SlashConfirm();
    return _slashConfirm;
}
//# sourceMappingURL=approval-tools.js.map