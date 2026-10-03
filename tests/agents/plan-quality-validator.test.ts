/**
 * G5 — the deterministic plan-quality assessor.
 *
 * Pure, LLM-free. Pins the two halves that matter:
 *   1. SAFE CORRECTIONS — a self-dependency is dropped (it would deadlock its own
 *      step), and nothing else is silently changed.
 *   2. ADVISORIES — dangling deps, cycles, duplicate steps and undeclared
 *      artifacts are REPORTED, never hidden, because each can also mean a
 *      genuinely missing step.
 */

import { describe, it, expect } from 'vitest';
import { assessPlanQuality, type PlanQualityStep } from '../../src/agents/plan-quality.js';

const step = (over: Partial<PlanQualityStep> & { id: string }): PlanQualityStep => ({
  id: over.id,
  description: over.description ?? 'do work',
  agentType: over.agentType ?? 'context-gatherer',
  dependsOn: over.dependsOn ?? [],
  expectedFiles: over.expectedFiles,
});

describe('assessPlanQuality', () => {
  it('returns a clean report for a healthy plan (no issues, no advisories)', () => {
    const report = assessPlanQuality([
      step({ id: 'a', description: 'gather context' }),
      step({ id: 'b', description: 'write the file', dependsOn: ['a'] }),
    ]);
    expect(report.issues).toEqual([]);
    expect(report.advisories).toEqual([]);
    expect(report.steps.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('DROPS a self-dependency (the only silent correction) and reports it', () => {
    const report = assessPlanQuality([step({ id: 'a', dependsOn: ['a'] })]);
    expect(report.steps[0].dependsOn).toEqual([]);
    expect(report.issues.some((i) => i.kind === 'self-dependency' && i.stepId === 'a')).toBe(true);
  });

  it('reports — but does NOT remove — a dangling dependency', () => {
    const report = assessPlanQuality([step({ id: 'a', dependsOn: ['ghost'] })]);
    expect(report.steps[0].dependsOn).toEqual(['ghost']); // untouched
    expect(report.issues.some((i) => i.kind === 'dangling-dependency')).toBe(true);
  });

  it('detects a dependency cycle', () => {
    const report = assessPlanQuality([
      step({ id: 'a', dependsOn: ['b'] }),
      step({ id: 'b', dependsOn: ['a'] }),
    ]);
    expect(report.issues.some((i) => i.kind === 'cycle')).toBe(true);
  });

  it('does not treat a self-loop as a cycle once it is corrected', () => {
    const report = assessPlanQuality([step({ id: 'a', dependsOn: ['a'] })]);
    expect(report.issues.some((i) => i.kind === 'cycle')).toBe(false);
  });

  it('reports duplicate step descriptions', () => {
    const report = assessPlanQuality([
      step({ id: 'a', description: 'Create manifest.ini' }),
      step({ id: 'b', description: 'create manifest.ini ' }),
    ]);
    expect(report.issues.some((i) => i.kind === 'duplicate-step' && i.stepId === 'b')).toBe(true);
  });

  it('flags a producing step that names a deliverable but declares no expectedFiles', () => {
    const report = assessPlanQuality([
      step({ id: 'a', agentType: 'writer', description: 'Create manifest.ini for the addon' }),
    ]);
    expect(report.issues.some((i) => i.kind === 'undeclared-artifact' && i.stepId === 'a')).toBe(true);
  });

  it('does NOT flag a producing step that declares its expectedFiles', () => {
    const report = assessPlanQuality([
      step({ id: 'a', agentType: 'writer', description: 'Create manifest.ini', expectedFiles: ['manifest.ini'] }),
    ]);
    expect(report.issues.some((i) => i.kind === 'undeclared-artifact')).toBe(false);
  });

  it('does NOT flag a non-producing step that mentions a file', () => {
    const report = assessPlanQuality([
      step({ id: 'a', agentType: 'reviewer', description: 'Review manifest.ini' }),
    ]);
    expect(report.issues.some((i) => i.kind === 'undeclared-artifact')).toBe(false);
  });

  it('never throws on malformed input and returns the steps unchanged', () => {
    const report = assessPlanQuality([null as unknown as PlanQualityStep, step({ id: 'a' })]);
    expect(report.steps).toHaveLength(2);
    expect(report.steps[1].id).toBe('a');
  });

  it('bounds the advisories it surfaces', () => {
    const many: PlanQualityStep[] = [];
    for (let i = 0; i < 20; i += 1) {
      many.push(step({ id: `s${i}`, agentType: 'writer', description: `Create file${i}.ts` }));
    }
    const report = assessPlanQuality(many);
    expect(report.advisories.length).toBeLessThanOrEqual(6);
    // Every advisory still names the plan so a reader knows the source.
    expect(report.advisories.every((a) => a.includes('plan:'))).toBe(true);
  });
});
