/**
 * A build's breadth is set by the granularity of its plan.
 *
 * Measured 2026-10-27, one prompt, two arms: 69 endpoints against 51, with the whole
 * difference inside modules both of them built — refresh rotation, logout-all,
 * organization switching, unread counts, read-all, notification preferences, document
 * publish and versions, audit logs, admin user status. The ask never named those, so no
 * "does the word appear" check can find them; what produced them was a 15-phase,
 * ~150-task plan (T-080…T-229). The other arm's plan had ONE step reading "auth/JWT,
 * RBAC, projects, tasks, documents, notifications, AI assistant, admin" — eight named
 * requirements on one checkbox, closed as soon as the first module existed.
 *
 * So these tests pin the fact the loop can judge: does the plan give each named
 * requirement its own place? And they pin the two ways it must stay quiet — a small ask,
 * and a plan that is already mostly executed.
 */

import { describe, it, expect } from 'vitest';
import {
  featureKey,
  MAX_FEATURES_PER_STEP,
  namedRequirements,
  planDepthIssue,
  planDepthNudge,
} from '../../src/learning/plan-depth.js';

const ASK = [
  '# Task — SaaS platform',
  '',
  'Before writing any code:',
  '',
  '1. Analyse requirements.',
  '',
  'Requirements:',
  '',
  '- Next.js frontend',
  '- Node.js backend',
  '- PostgreSQL',
  '- JWT Authentication',
  '- RBAC',
  '- Projects',
  '- Tasks',
  '- Documents',
  '- AI Assistant',
  '- Notifications',
  '- Admin Dashboard',
  '',
  'Quality Requirements:',
  '',
  '- Unit tests',
  '- Integration tests',
  '- E2E tests',
  '- Complete documentation',
  '',
].join('\n');

describe('namedRequirements — the ask, not its technology or its quality bar', () => {
  it('reads the bullets under the requirements heading and drops tech/quality words', () => {
    expect(namedRequirements(ASK)).toEqual([
      'Projects',
      'Tasks',
      'Documents',
      'AI Assistant',
      'Notifications',
      'Admin Dashboard',
    ]);
  });

  it('reads the inline form too', () => {
    expect(namedRequirements('Build a CRM. Requirements: Leads, Deals, Reports, Billing.')).toEqual([
      'Leads',
      'Deals',
      'Reports',
      'Billing',
    ]);
  });

  it('ignores a bullet list that is not a requirements list', () => {
    const instructions = ['Build the release.', '', '- Maintain todo.md', '- Maintain changelog.md', ''].join('\n');
    expect(namedRequirements(instructions)).toEqual([]);
  });

  it('matches labels singular/plural-insensitively', () => {
    expect(featureKey('Documents')).toBe('document');
    expect(featureKey('AI Assistant')).toBe('ai assistant');
  });
});

describe('planDepthIssue — is the plan the work, or a summary of it?', () => {
  it('flags the measured failure: one step naming eight requirements', () => {
    const issue = planDepthIssue({
      ask: ASK,
      steps: [
        { id: 's1', description: 'Inspect the directory and toolchain', status: 'done' },
        { id: 's2', description: 'Write the planning documents', status: 'done' },
        {
          id: 's3',
          description: 'Implement backend: auth/JWT, RBAC, projects, tasks, documents, notifications, AI assistant, admin',
          status: 'in_progress',
        },
        { id: 's4', description: 'Write tests and a README', status: 'pending' },
      ],
    });
    expect(issue).not.toBeNull();
    expect(issue!.bundled).toHaveLength(1);
    expect(issue!.bundled[0].step).toBe('s3');
    expect(issue!.bundled[0].features.length).toBeGreaterThan(MAX_FEATURES_PER_STEP);
    // The message names the step and quotes what it swallows, so it is actionable.
    const text = planDepthNudge(issue!);
    expect(text).toContain('s3');
    expect(text).toContain('Implement backend');
    expect(text).toContain('marked done as soon as the first of them exists');
  });

  it('flags requirements with no step at all', () => {
    const issue = planDepthIssue({
      ask: ASK,
      steps: [
        { id: 's1', description: 'Scaffold the monorepo', status: 'in_progress' },
        { id: 's2', description: 'Implement projects and tasks', status: 'pending' },
        { id: 's3', description: 'Implement documents', status: 'pending' },
      ],
    });
    expect(issue!.missing).toEqual(['AI Assistant', 'Notifications', 'Admin Dashboard']);
    expect(planDepthNudge(issue!)).toContain('have no step of their own');
  });

  it('is silent for a plan that gives each requirement its own step', () => {
    const steps = namedRequirements(ASK).map((f, i) => ({
      id: `s${i}`,
      description: `Implement ${f}: create, read, update, delete`,
      status: 'pending',
    }));
    expect(planDepthIssue({ ask: ASK, steps })).toBeNull();
  });

  it('is silent for a small ask — two features in one step is proportionate', () => {
    expect(
      planDepthIssue({
        ask: 'Build a CLI. Requirements: parse args, print help.',
        steps: [{ id: 's1', description: 'Implement parsing and help', status: 'pending' }],
      }),
    ).toBeNull();
  });

  it('is silent once the plan is mostly executed — splitting it then is theatre', () => {
    const issue = planDepthIssue({
      ask: ASK,
      steps: [
        { id: 's1', description: 'auth, RBAC, projects, tasks, documents, notifications, AI, admin', status: 'done' },
        { id: 's2', description: 'tests', status: 'done' },
        { id: 's3', description: 'docs', status: 'done' },
      ],
    });
    expect(issue).toBeNull();
  });
});
