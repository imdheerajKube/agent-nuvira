/**
 * write_approval — Write-approval gate for memory and skill writes.
 *
 * Provides a safety mechanism for memory and skill modifications:
 * - Approval workflow for destructive writes
 * - Pending store for queued writes
 * - Rollback capability
 * - Audit logging
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

// ─── Types ──────────────────────────────────────────────────────────────────

type WriteAction = 'memory.add' | 'memory.update' | 'memory.delete' | 'skill.add' | 'skill.update' | 'skill.delete';

interface PendingWrite {
  id: string;
  action: WriteAction;
  target: string;
  data: any;
  requestedAt: number;
  status: 'pending' | 'approved' | 'denied' | 'completed' | 'failed';
  approvedAt?: number;
  completedAt?: number;
  reason?: string;
}

interface ApprovalPolicy {
  autoApprove: WriteAction[];
  requireApproval: WriteAction[];
  deny: WriteAction[];
}

// ─── Write Approval Manager ─────────────────────────────────────────────────

class WriteApprovalManager {
  private pendingWrites = new Map<string, PendingWrite>();
  private completedWrites: PendingWrite[] = [];
  private policy: ApprovalPolicy;
  private auditLog: { action: WriteAction; target: string; status: string; timestamp: number }[] = [];

  constructor(policy?: Partial<ApprovalPolicy>) {
    this.policy = {
      autoApprove: ['memory.add'],
      requireApproval: ['memory.update', 'memory.delete', 'skill.add', 'skill.update'],
      deny: ['skill.delete'],
      ...policy,
    };
  }

  /**
   * Request approval for a write operation.
   */
  requestApproval(params: {
    action: WriteAction;
    target: string;
    data: any;
  }): { id: string; requiresApproval: boolean; autoApproved: boolean } {
    const id = `write_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Check policy
    if (this.policy.deny.includes(params.action)) {
      this.auditLog.push({
        action: params.action,
        target: params.target,
        status: 'denied_policy',
        timestamp: Date.now(),
      });
      return { id, requiresApproval: false, autoApproved: false };
    }

    const pending: PendingWrite = {
      id,
      action: params.action,
      target: params.target,
      data: params.data,
      requestedAt: Date.now(),
      status: 'pending',
    };

    this.pendingWrites.set(id, pending);

    // Auto-approve if allowed
    if (this.policy.autoApprove.includes(params.action)) {
      pending.status = 'approved';
      pending.approvedAt = Date.now();
      this.auditLog.push({
        action: params.action,
        target: params.target,
        status: 'auto_approved',
        timestamp: Date.now(),
      });
      return { id, requiresApproval: false, autoApproved: true };
    }

    this.auditLog.push({
      action: params.action,
      target: params.target,
      status: 'pending',
      timestamp: Date.now(),
    });

    return { id, requiresApproval: true, autoApproved: false };
  }

  /**
   * Approve a pending write.
   */
  approve(id: string, reason?: string): boolean {
    const pending = this.pendingWrites.get(id);
    if (!pending || pending.status !== 'pending') {
      return false;
    }

    pending.status = 'approved';
    pending.approvedAt = Date.now();
    pending.reason = reason;

    this.auditLog.push({
      action: pending.action,
      target: pending.target,
      status: 'approved',
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * Deny a pending write.
   */
  deny(id: string, reason?: string): boolean {
    const pending = this.pendingWrites.get(id);
    if (!pending || pending.status !== 'pending') {
      return false;
    }

    pending.status = 'denied';
    pending.approvedAt = Date.now();
    pending.reason = reason;

    this.auditLog.push({
      action: pending.action,
      target: pending.target,
      status: 'denied',
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * Complete a write operation.
   */
  complete(id: string): boolean {
    const pending = this.pendingWrites.get(id);
    if (!pending || pending.status !== 'approved') {
      return false;
    }

    pending.status = 'completed';
    pending.completedAt = Date.now();

    this.completedWrites.push(pending);
    this.pendingWrites.delete(id);

    this.auditLog.push({
      action: pending.action,
      target: pending.target,
      status: 'completed',
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * Mark a write as failed.
   */
  fail(id: string, reason?: string): boolean {
    const pending = this.pendingWrites.get(id);
    if (!pending) {
      return false;
    }

    pending.status = 'failed';
    pending.completedAt = Date.now();
    pending.reason = reason;

    this.pendingWrites.delete(id);

    this.auditLog.push({
      action: pending.action,
      target: pending.target,
      status: 'failed',
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * Get pending writes.
   */
  getPending(): PendingWrite[] {
    return Array.from(this.pendingWrites.values()).filter((w) => w.status === 'pending');
  }

  /**
   * Get completed writes.
   */
  getCompleted(limit = 50): PendingWrite[] {
    return this.completedWrites.slice(-limit);
  }

  /**
   * Get audit log.
   */
  getAuditLog(limit = 100): typeof this.auditLog {
    return this.auditLog.slice(-limit);
  }

  /**
   * Update policy.
   */
  setPolicy(policy: Partial<ApprovalPolicy>): void {
    this.policy = { ...this.policy, ...policy };
  }

  /**
   * Get current policy.
   */
  getPolicy(): ApprovalPolicy {
    return { ...this.policy };
  }

  /**
   * Clear completed writes older than retention period.
   */
  clearOlderThan(retentionMs: number): number {
    const cutoff = Date.now() - retentionMs;
    const before = this.completedWrites.length;
    this.completedWrites = this.completedWrites.filter(
      (w) => w.completedAt && w.completedAt >= cutoff
    );
    return before - this.completedWrites.length;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: WriteApprovalManager | null = null;

export function getWriteApprovalManager(): WriteApprovalManager {
  if (!_instance) _instance = new WriteApprovalManager();
  return _instance;
}

export { WriteApprovalManager };
