/**
 * G11 — the autonomy policy: when may the agent decide, and when must it ask?
 *
 * The user's requirement, verbatim: "agent must consult if it needs a decision
 * input but when decision is clear it should judge and deliver". These tests
 * pin BOTH halves — the consultation that is correct, and the far larger set of
 * cases where asking is a bottleneck dressed up as diligence.
 */

import { describe, it, expect } from 'vitest';
import {
  REWORK_CONSULT_THRESHOLD_MINUTES,
  autonomouslyDecidedLine,
  consultLine,
  decideAutonomously,
} from '../../src/learning/autonomy-policy.js';

describe('decideAutonomously — proceed by default', () => {
  it('proceeds on a non-blocking preference instead of burning a round trip', () => {
    const v = decideAutonomously({
      question: 'Should the reader use serif or sans-serif type?',
      options: ['serif', 'sans-serif'],
      defaultChoice: 'serif',
      impact: 'low',
    });
    expect(v.action).toBe('proceed');
    expect(v.choice).toBe('serif');
  });

  it('proceeds when the ask itself already answered the question', () => {
    // "a web-based book with voice narration" has already decided both the
    // platform and the audio — re-asking is a non-delivery dressed as care.
    const v = decideAutonomously({
      question: 'Should this be a website or a PDF?',
      options: ['website', 'pdf'],
      defaultChoice: 'website',
      impact: 'high',
      blocking: true,
      reversible: false,
      impliedByAsk: true,
    });
    expect(v.action).toBe('proceed');
    expect(v.reason).toMatch(/already specifies/);
  });

  it('proceeds on a blocking decision that has a sensible default', () => {
    const v = decideAutonomously({
      question: 'Which file should I write the book to?',
      defaultChoice: 'Mahagatha.md',
      blocking: true,
      impact: 'medium',
    });
    expect(v.action).toBe('proceed');
    expect(v.choice).toBe('Mahagatha.md');
  });

  it('proceeds even at high impact when the user already stated a preference', () => {
    const v = decideAutonomously({
      question: 'Should I overwrite the existing draft?',
      defaultChoice: 'keep a .bak copy and overwrite',
      blocking: true,
      impact: 'high',
      reversible: false,
    });
    expect(v.action).toBe('proceed');
    expect(v.choice).toMatch(/bak/);
  });
});

describe('decideAutonomously — consult only when it is genuinely the user’s call', () => {
  it('consults on a blocking, high-impact, irreversible decision with no default', () => {
    const v = decideAutonomously({
      question: 'The target directory already contains a different book. Replace it?',
      blocking: true,
      impact: 'high',
      reversible: false,
    });
    expect(v.action).toBe('consult');
    expect(v.reason).toMatch(/irreversible/);
  });

  it('consults when a wrong pick would cost a lot of rework and there is no default', () => {
    const v = decideAutonomously({
      question: 'Which of two mutually exclusive architectures should I build?',
      blocking: true,
      impact: 'medium',
      reworkMinutes: REWORK_CONSULT_THRESHOLD_MINUTES + 30,
    });
    expect(v.action).toBe('consult');
    expect(v.reason).toMatch(/minutes/);
  });

  it('consults when blocking with nothing to fall back on', () => {
    const v = decideAutonomously({
      question: 'What should I name the exported package?',
      blocking: true,
    });
    expect(v.action).toBe('consult');
  });
});

describe('reporting lines', () => {
  it('states an autonomous decision so the user can reverse it', () => {
    const line = autonomouslyDecidedLine('which layout?', 'two-column', 'a sensible default exists');
    expect(line).toMatch(/Decided without asking/);
    expect(line).toMatch(/two-column/);
    expect(line).toMatch(/change it/);
  });

  it('shapes a consultation for a one-word reply', () => {
    const request = {
      question: 'Replace the existing book?',
      options: ['replace', 'keep both'],
      defaultChoice: 'keep both',
      blocking: true,
      impact: 'high' as const,
      reversible: false,
    };
    const verdict = decideAutonomously(request);
    const line = consultLine(request, verdict);
    expect(line).toMatch(/need your call/);
    expect(line).toMatch(/1\. replace/);
    expect(line).toMatch(/recommendation/);
    expect(line).toMatch(/"go"/);
  });
});
