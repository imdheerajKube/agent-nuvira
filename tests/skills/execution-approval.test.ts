/**
 * Tests for the Execution Approval system.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isSkillTrusted,
  isSkillApproved,
  createApprovalRequest,
  recordApprovalDecision,
  shouldApproveExecution,
  generateApprovalPrompt,
  parseApprovalResponse,
  clearSessionApprovals,
  getApprovalStats,
  SkillMetadata,
} from '../../src/skills/execution-approval.js';

describe('Execution Approval', () => {
  const sessionId = 'test-session-123';

  beforeEach(() => {
    clearSessionApprovals(sessionId);
  });

  describe('Skill Trust', () => {
    it('identifies bundled skills as trusted', () => {
      expect(isSkillTrusted('website-deploy')).toBe(true);
      expect(isSkillTrusted('code-assessment')).toBe(true);
      expect(isSkillTrusted('image-gen')).toBe(true);
    });

    it('identifies unknown skills as untrusted', () => {
      expect(isSkillTrusted('malicious-skill')).toBe(false);
      expect(isSkillTrusted('unknown-tool')).toBe(false);
    });
  });

  describe('Session Approval', () => {
    it('checks if skill is approved in session', () => {
      expect(isSkillApproved('test-skill', sessionId)).toBe(false);
    });

    it('records approval decision', () => {
      recordApprovalDecision('test-skill', sessionId, {
        approved: true,
        timestamp: Date.now(),
        sessionId,
      });

      expect(isSkillApproved('test-skill', sessionId)).toBe(true);
    });

    it('records rejection decision', () => {
      recordApprovalDecision('test-skill', sessionId, {
        approved: false,
        timestamp: Date.now(),
        sessionId,
      });

      expect(isSkillApproved('test-skill', sessionId)).toBe(false);
    });

    it('clears session approvals', () => {
      recordApprovalDecision('test-skill', sessionId, {
        approved: true,
        timestamp: Date.now(),
        sessionId,
      });

      clearSessionApprovals(sessionId);

      expect(isSkillApproved('test-skill', sessionId)).toBe(false);
    });
  });

  describe('Approval Logic', () => {
    it('auto-approves trusted skills', () => {
      const skill: SkillMetadata = {
        name: 'website-deploy',
        description: 'Deploy to various platforms',
        source: 'bundled',
        runtime: 'shell',
      };

      const result = shouldApproveExecution(skill, sessionId);
      expect(result.approved).toBe(true);
      expect(result.reason).toContain('Trusted bundled skill');
    });

    it('requires approval for untrusted skills', () => {
      const skill: SkillMetadata = {
        name: 'untrusted-skill',
        description: 'Some untrusted skill',
        source: 'marketplace',
        runtime: 'python',
      };

      const result = shouldApproveExecution(skill, sessionId);
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('requires approval');
    });

    it('auto-approves local skills', () => {
      const skill: SkillMetadata = {
        name: 'my-local-skill',
        description: 'My local skill',
        source: 'local',
        runtime: 'shell',
      };

      const result = shouldApproveExecution(skill, sessionId);
      expect(result.approved).toBe(true);
      expect(result.reason).toContain('Local skill');
    });

    it('approves previously approved skills', () => {
      const skill: SkillMetadata = {
        name: 'marketplace-skill',
        description: 'A marketplace skill',
        source: 'marketplace',
        runtime: 'node',
      };

      // First call requires approval
      const result1 = shouldApproveExecution(skill, sessionId);
      expect(result1.approved).toBe(false);

      // Record approval
      recordApprovalDecision('marketplace-skill', sessionId, {
        approved: true,
        timestamp: Date.now(),
        sessionId,
      });

      // Second call is approved
      const result2 = shouldApproveExecution(skill, sessionId);
      expect(result2.approved).toBe(true);
      expect(result2.reason).toContain('Previously approved');
    });
  });

  describe('Approval Request', () => {
    it('creates approval request', () => {
      const skill: SkillMetadata = {
        name: 'test-skill',
        description: 'Test skill',
        source: 'marketplace',
        runtime: 'python',
        requiredEnvVars: ['API_KEY'],
      };

      const request = createApprovalRequest(skill, 'python test.py');
      expect(request.id).toBeDefined();
      expect(request.skill).toBe(skill);
      expect(request.command).toBe('python test.py');
      expect(request.timestamp).toBeGreaterThan(0);
    });
  });

  describe('Approval Prompt', () => {
    it('generates approval prompt', () => {
      const request = createApprovalRequest(
        {
          name: 'test-skill',
          description: 'Test skill',
          source: 'marketplace',
          runtime: 'python',
          author: 'Test Author',
          version: '1.0.0',
          requiredEnvVars: ['API_KEY', 'SECRET'],
        },
        'python test.py'
      );

      const prompt = generateApprovalPrompt(request);
      expect(prompt).toContain('Skill Execution Request');
      expect(prompt).toContain('test-skill');
      expect(prompt).toContain('Test skill');
      expect(prompt).toContain('python');
      expect(prompt).toContain('Test Author');
      expect(prompt).toContain('1.0.0');
      expect(prompt).toContain('API_KEY');
      expect(prompt).toContain('SECRET');
      expect(prompt).toContain('python test.py');
      expect(prompt).toContain('yes');
      expect(prompt).toContain('no');
      expect(prompt).toContain('always');
    });
  });

  describe('Response Parsing', () => {
    it('parses yes response', () => {
      expect(parseApprovalResponse('yes')).toEqual({ approved: true, always: false });
      expect(parseApprovalResponse('y')).toEqual({ approved: true, always: false });
      expect(parseApprovalResponse('YES')).toEqual({ approved: true, always: false });
      expect(parseApprovalResponse('approve')).toEqual({ approved: true, always: false });
    });

    it('parses always response', () => {
      expect(parseApprovalResponse('always')).toEqual({ approved: true, always: true });
      expect(parseApprovalResponse('always-approve')).toEqual({ approved: true, always: true });
    });

    it('parses no response', () => {
      expect(parseApprovalResponse('no')).toEqual({ approved: false, always: false });
      expect(parseApprovalResponse('n')).toEqual({ approved: false, always: false });
      expect(parseApprovalResponse('NO')).toEqual({ approved: false, always: false });
      expect(parseApprovalResponse('reject')).toEqual({ approved: false, always: false });
    });

    it('handles invalid responses', () => {
      expect(parseApprovalResponse('')).toEqual({ approved: false, always: false });
      expect(parseApprovalResponse('maybe')).toEqual({ approved: false, always: false });
      expect(parseApprovalResponse('123')).toEqual({ approved: false, always: false });
    });
  });

  describe('Approval Stats', () => {
    it('tracks approval statistics', () => {
      // No approvals yet
      const stats1 = getApprovalStats(sessionId);
      expect(stats1.total).toBe(0);
      expect(stats1.approved).toBe(0);
      expect(stats1.rejected).toBe(0);

      // Add some approvals
      recordApprovalDecision('skill-1', sessionId, {
        approved: true,
        timestamp: Date.now(),
        sessionId,
      });

      recordApprovalDecision('skill-2', sessionId, {
        approved: false,
        timestamp: Date.now(),
        sessionId,
      });

      recordApprovalDecision('skill-3', sessionId, {
        approved: true,
        timestamp: Date.now(),
        sessionId,
      });

      const stats2 = getApprovalStats(sessionId);
      expect(stats2.total).toBe(3);
      expect(stats2.approved).toBe(2);
      expect(stats2.rejected).toBe(1);
    });
  });
});
