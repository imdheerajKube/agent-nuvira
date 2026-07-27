/**
 * Unit tests for PhaseExecutionEngine — phase-wise project scope execution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

import { PhaseExecutionEngine } from '../../src/agents/phase-engine.js';
import type { PhaseDefinition, PhaseScopeState, PhaseState, PhaseStatus } from '../../src/agents/phase-engine.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePhase(id: string, goal: string): PhaseDefinition {
  return { id, goal, description: `Phase: ${goal.slice(0, 40)}` };
}

function makeScope(engine: PhaseExecutionEngine, name: string, phases: PhaseDefinition[]): PhaseScopeState {
  return engine.createScope({ name, phases });
}

/** A mock executeFn that succeeds immediately */
function mockExecuteSuccess(summary?: string) {
  return vi.fn().mockResolvedValue({
    success: true,
    summary: summary || 'Phase completed successfully',
  });
}

/** A mock executeFn that fails immediately */
function mockExecuteFailure(error?: string) {
  return vi.fn().mockResolvedValue({
    success: false,
    summary: 'Phase failed',
    error: error || 'Test failure',
  });
}

/** A mock executeFn that throws */
function mockExecuteThrow() {
  return vi.fn().mockRejectedValue(new Error('Unexpected crash'));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PhaseExecutionEngine', () => {
  let engine: PhaseExecutionEngine;
  let buffPhasesDir: string;

  beforeEach(() => {
    engine = new PhaseExecutionEngine();
    // Override homedir location for test isolation
    buffPhasesDir = join(homedir(), '.buff', 'phases');
    try { mkdirSync(buffPhasesDir, { recursive: true }); } catch { /* ignore */ }
  });

  afterEach(() => {
    // Clean up any saved phase files
    try {
      if (existsSync(buffPhasesDir)) {
        const files = readdirSync(buffPhasesDir);
        for (const f of files.filter((x: string) => x.endsWith('.json'))) {
          rmSync(join(buffPhasesDir, f), { force: true });
        }
      }
    } catch { /* best-effort */ }
  });

  // ── createScope ──────────────────────────────────────────────────────

  describe('createScope()', () => {
    it('should create a scope with the given name', () => {
      const scope = makeScope(engine, 'Test Release', [makePhase('p1', 'Add auth')]);
      expect(scope.name).toBe('Test Release');
    });

    it('should set all phases to pending status', () => {
      const scope = makeScope(engine, 'Test', [
        makePhase('p1', 'Add auth'),
        makePhase('p2', 'Add API'),
      ]);
      expect(scope.phases).toHaveLength(2);
      for (const phase of scope.phases) {
        expect(phase.status).toBe('pending');
      }
    });

    it('should set completed to false', () => {
      const scope = makeScope(engine, 'Test', [makePhase('p1', 'Goal')]);
      expect(scope.completed).toBe(false);
    });

    it('should set currentPhaseIndex to -1', () => {
      const scope = makeScope(engine, 'Test', [makePhase('p1', 'Goal')]);
      expect(scope.currentPhaseIndex).toBe(-1);
    });

    it('should set credentialsCollected to false', () => {
      const scope = makeScope(engine, 'Test', [makePhase('p1', 'Goal')]);
      expect(scope.credentialsCollected).toBe(false);
    });

    it('should set createdAt and updatedAt timestamps', () => {
      const scope = makeScope(engine, 'Test', [makePhase('p1', 'Goal')]);
      expect(scope.createdAt).toBeTruthy();
      expect(scope.updatedAt).toBeTruthy();
    });

    it('should handle empty phases array', () => {
      const scope = makeScope(engine, 'Empty', []);
      expect(scope.phases).toHaveLength(0);
    });
  });

  // ── getNextPhase ─────────────────────────────────────────────────────

  describe('getNextPhase()', () => {
    it('should return the first pending phase', () => {
      const scope = makeScope(engine, 'Test', [
        makePhase('p1', 'First'),
        makePhase('p2', 'Second'),
      ]);
      const next = engine.getNextPhase(scope);
      expect(next).not.toBeNull();
      expect(next!.id).toBe('p1');
    });

    it('should return null when all phases are completed', () => {
      const scope = makeScope(engine, 'Test', [
        makePhase('p1', 'First'),
        makePhase('p2', 'Second'),
      ]);
      scope.phases.forEach(p => p.status = 'completed');
      expect(engine.getNextPhase(scope)).toBeNull();
    });

    it('should skip completed phases and find pending ones', () => {
      const scope = makeScope(engine, 'Test', [
        makePhase('p1', 'First'),
        makePhase('p2', 'Second'),
        makePhase('p3', 'Third'),
      ]);
      scope.phases[0].status = 'completed';
      const next = engine.getNextPhase(scope);
      expect(next!.id).toBe('p2');
    });

    it('should skip failed phases too', () => {
      const scope = makeScope(engine, 'Test', [
        makePhase('p1', 'First'),
        makePhase('p2', 'Second'),
      ]);
      scope.phases[0].status = 'failed';
      const next = engine.getNextPhase(scope);
      expect(next!.id).toBe('p2');
    });

    it('should return null for empty scope', () => {
      const scope = makeScope(engine, 'Empty', []);
      expect(engine.getNextPhase(scope)).toBeNull();
    });
  });

  // ── getProgress ──────────────────────────────────────────────────────

  describe('getProgress()', () => {
    it('should show 0/n progress for fresh scope', () => {
      const scope = makeScope(engine, 'Test', [
        makePhase('p1', 'First'),
        makePhase('p2', 'Second'),
      ]);
      const progress = engine.getProgress(scope);
      expect(progress).toContain('Test');
      expect(progress).toContain('0/2');
    });

    it('should show completed count when phases are done', () => {
      const scope = makeScope(engine, 'Test', [
        makePhase('p1', 'First'),
        makePhase('p2', 'Second'),
      ]);
      scope.phases[0].status = 'completed';
      const progress = engine.getProgress(scope);
      expect(progress).toContain('1/2');
    });

    it('should show failed count when phases fail', () => {
      const scope = makeScope(engine, 'Test', [
        makePhase('p1', 'First'),
        makePhase('p2', 'Second'),
      ]);
      scope.phases[0].status = 'failed';
      const progress = engine.getProgress(scope);
      expect(progress).toContain('Failed: 1');
    });

    it('should show running count when a phase is running', () => {
      const scope = makeScope(engine, 'Test', [
        makePhase('p1', 'Running'),
      ]);
      scope.phases[0].status = 'running';
      const progress = engine.getProgress(scope);
      expect(progress).toContain('Running: 1');
    });

    it('should display phase descriptions with status icons', () => {
      const scope = makeScope(engine, 'Test', [
        makePhase('p1', 'Auth'),
      ]);
      const progress = engine.getProgress(scope);
      expect(progress).toContain('Auth');
      expect(progress).toContain('⏳'); // pending icon
    });

    it('should show summary text when available', () => {
      const scope = makeScope(engine, 'Test', [
        makePhase('p1', 'Auth'),
      ]);
      scope.phases[0].status = 'completed';
      scope.phases[0].summary = 'Added JWT auth successfully';
      const progress = engine.getProgress(scope);
      expect(progress).toContain('Added JWT auth');
    });
  });

  // ── saveScope / loadScope ────────────────────────────────────────────

  describe('saveScope() / loadScope()', () => {
    it('should save and load a scope', () => {
      const scope = makeScope(engine, 'My Release', [
        makePhase('p1', 'Add auth'),
        makePhase('p2', 'Publish'),
      ]);
      engine.saveScope(scope);

      const loaded = engine.loadScope('My Release');
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('My Release');
      expect(loaded!.phases).toHaveLength(2);
    });

    it('should return null for non-existent scope', () => {
      const loaded = engine.loadScope('NonExistent');
      expect(loaded).toBeNull();
    });

    it('should persist phase status changes', () => {
      const scope = makeScope(engine, 'Status Test', [
        makePhase('p1', 'First'),
        makePhase('p2', 'Second'),
      ]);
      scope.phases[0].status = 'completed';
      scope.phases[0].summary = 'Done!';
      engine.saveScope(scope);

      const loaded = engine.loadScope('Status Test');
      expect(loaded!.phases[0].status).toBe('completed');
      expect(loaded!.phases[0].summary).toBe('Done!');
    });

    it('should persist credentialsCollected flag', () => {
      const scope = makeScope(engine, 'Creds Test', [makePhase('p1', 'Goal')]);
      scope.credentialsCollected = true;
      engine.saveScope(scope);

      const loaded = engine.loadScope('Creds Test');
      expect(loaded!.credentialsCollected).toBe(true);
    });

    it('should update updatedAt on save', async () => {
      const scope = makeScope(engine, 'Time Test', [makePhase('p1', 'Goal')]);
      const before = scope.updatedAt;
      // Ensure timestamp ticks by awaiting
      await new Promise(r => setTimeout(r, 5));
      scope.credentialsCollected = true;
      engine.saveScope(scope);
      expect(scope.updatedAt).not.toBe(before);
    });

    it('should load different scopes independently', () => {
      const s1 = makeScope(engine, 'Scope One', [makePhase('p1', 'Goal 1')]);
      const s2 = makeScope(engine, 'Scope Two', [makePhase('p1', 'Goal 2')]);
      engine.saveScope(s1);
      engine.saveScope(s2);

      const loaded1 = engine.loadScope('Scope One');
      const loaded2 = engine.loadScope('Scope Two');
      expect(loaded1!.phases[0].goal).toBe('Goal 1');
      expect(loaded2!.phases[0].goal).toBe('Goal 2');
    });
  });

  // ── listSavedScopes / deleteScope ─────────────────────────────────────

  describe('listSavedScopes() / deleteScope()', () => {
    it('should list saved scopes', () => {
      const s1 = makeScope(engine, 'Scope A', [makePhase('p1', 'A')]);
      const s2 = makeScope(engine, 'Scope B', [makePhase('p1', 'B')]);
      engine.saveScope(s1);
      engine.saveScope(s2);

      const list = engine.listSavedScopes();
      expect(list).toContain('Scope A');
      expect(list).toContain('Scope B');
    });

    it('should return empty array when no scopes saved', () => {
      const list = engine.listSavedScopes();
      expect(Array.isArray(list)).toBe(true);
    });

    it('should delete a saved scope', () => {
      const scope = makeScope(engine, 'Delete Me', [makePhase('p1', 'Goal')]);
      engine.saveScope(scope);
      expect(engine.loadScope('Delete Me')).not.toBeNull();

      engine.deleteScope('Delete Me');
      expect(engine.loadScope('Delete Me')).toBeNull();
    });

    it('should not throw when deleting non-existent scope', () => {
      expect(() => engine.deleteScope('NonExistent')).not.toThrow();
    });
  });

  // ── executePhase ─────────────────────────────────────────────────────

  describe('executePhase()', () => {
    it('should mark phase as running when execution starts', async () => {
      const scope = makeScope(engine, 'Test', [makePhase('p1', 'Goal')]);
      const executeFn = mockExecuteSuccess('Completed');

      await engine.executePhase(scope, 0, executeFn);
      // After execution, phase should be completed
      expect(scope.phases[0].status).toBe('completed');
    });

    it('should mark phase as completed on success', async () => {
      const scope = makeScope(engine, 'Test', [makePhase('p1', 'Goal')]);
      const executeFn = mockExecuteSuccess('All good');

      const result = await engine.executePhase(scope, 0, executeFn);
      expect(result.phase.status).toBe('completed');
      expect(result.continueExecution).toBe(true);
    });

    it('should mark phase as failed on failure', async () => {
      const scope = makeScope(engine, 'Test', [makePhase('p1', 'Goal')]);
      const executeFn = mockExecuteFailure('Something broke');

      const result = await engine.executePhase(scope, 0, executeFn);
      expect(result.phase.status).toBe('failed');
      expect(result.continueExecution).toBe(false);
    });

    it('should mark phase as failed on exception', async () => {
      const scope = makeScope(engine, 'Test', [makePhase('p1', 'Goal')]);
      const executeFn = mockExecuteThrow();

      const result = await engine.executePhase(scope, 0, executeFn);
      expect(result.phase.status).toBe('failed');
      expect(result.continueExecution).toBe(false);
    });

    it('should set startedAt and completedAt timestamps', async () => {
      const scope = makeScope(engine, 'Test', [makePhase('p1', 'Goal')]);
      const executeFn = mockExecuteSuccess();

      await engine.executePhase(scope, 0, executeFn);
      expect(scope.phases[0].startedAt).toBeTruthy();
      expect(scope.phases[0].completedAt).toBeTruthy();
    });

    it('should set summary from executeFn result', async () => {
      const scope = makeScope(engine, 'Test', [makePhase('p1', 'Goal')]);
      const executeFn = mockExecuteSuccess('Custom summary');

      await engine.executePhase(scope, 0, executeFn);
      expect(scope.phases[0].summary).toContain('Custom summary');
    });

    it('should set currentPhaseIndex to -2 (completed marker) when scope finishes', async () => {
      const scope = makeScope(engine, 'Test', [makePhase('p1', 'Goal')]);
      const executeFn = mockExecuteSuccess();

      await engine.executePhase(scope, 0, executeFn);
      // Single-phase scope completes immediately → sets currentPhaseIndex to -2
      expect(scope.currentPhaseIndex).toBe(-2);
    });

    it('should mark scope as completed when all phases done', async () => {
      const scope = makeScope(engine, 'Test', [makePhase('p1', 'Goal')]);
      const executeFn = mockExecuteSuccess();

      await engine.executePhase(scope, 0, executeFn);
      expect(scope.completed).toBe(true);
      expect(scope.currentPhaseIndex).toBe(-2);
    });

    it('should handle invalid phase index gracefully', async () => {
      const scope = makeScope(engine, 'Test', [makePhase('p1', 'Goal')]);
      const executeFn = mockExecuteSuccess();

      const result = await engine.executePhase(scope, 999, executeFn);
      expect(result.phase.status).toBe('failed');
      expect(result.continueExecution).toBe(false);
    });

    it('should pass goal, phaseId, and description to executeFn', async () => {
      const scope = makeScope(engine, 'Test', [makePhase('p-my-phase', 'My custom goal')]);
      const executeFn = vi.fn().mockResolvedValue({ success: true, summary: 'ok' });

      await engine.executePhase(scope, 0, executeFn);
      expect(executeFn).toHaveBeenCalledWith('My custom goal', 'p-my-phase', expect.any(String));
    });

    it('should save scope after phase execution', async () => {
      const scope = makeScope(engine, 'Save Test', [makePhase('p1', 'Goal')]);
      const executeFn = mockExecuteSuccess();

      const saveSpy = vi.spyOn(engine, 'saveScope');
      await engine.executePhase(scope, 0, executeFn);
      expect(saveSpy).toHaveBeenCalled();
    });
  });

  // ── executeScope ─────────────────────────────────────────────────────

  describe('executeScope()', () => {
    it('should execute all phases in order on success', async () => {
      const scope = makeScope(engine, 'Test', [
        makePhase('p1', 'First'),
        makePhase('p2', 'Second'),
        makePhase('p3', 'Third'),
      ]);
      const executeFn = mockExecuteSuccess();

      await engine.executeScope(scope, executeFn, { interactive: false });

      expect(scope.phases[0].status).toBe('completed');
      expect(scope.phases[1].status).toBe('completed');
      expect(scope.phases[2].status).toBe('completed');
      expect(scope.completed).toBe(true);
    });

    it('should stop on failure in non-interactive mode', async () => {
      const scope = makeScope(engine, 'Test', [
        makePhase('p1', 'First'),
        makePhase('p2', 'Second'),
        makePhase('p3', 'Third'),
      ]);

      // First succeeds, second fails
      const executeFn = vi.fn()
        .mockResolvedValueOnce({ success: true, summary: 'ok' })
        .mockResolvedValueOnce({ success: false, summary: 'fail', error: 'Broke' })
        .mockResolvedValueOnce({ success: true, summary: 'should not run' });

      await engine.executeScope(scope, executeFn, { interactive: false });

      expect(scope.phases[0].status).toBe('completed');
      expect(scope.phases[1].status).toBe('failed');
      // Phase 3 was never executed because phase 2 failed
      expect(scope.phases[2].status).toBe('pending');
    });

    it('should call executeFn once per phase', async () => {
      const scope = makeScope(engine, 'Test', [
        makePhase('p1', 'First'),
        makePhase('p2', 'Second'),
      ]);
      const executeFn = mockExecuteSuccess();

      await engine.executeScope(scope, executeFn, { interactive: false });
      expect(executeFn).toHaveBeenCalledTimes(2);
    });

    it('should mark scope complete when all phases done', async () => {
      const scope = makeScope(engine, 'Test', [
        makePhase('p1', 'First'),
        makePhase('p2', 'Second'),
      ]);
      const executeFn = mockExecuteSuccess();

      await engine.executeScope(scope, executeFn, { interactive: false });
      expect(scope.completed).toBe(true);
      expect(scope.currentPhaseIndex).toBe(-2);
    });

    it('should handle single-phase scope', async () => {
      const scope = makeScope(engine, 'Single', [makePhase('p1', 'Only')]);
      const executeFn = mockExecuteSuccess();

      await engine.executeScope(scope, executeFn, { interactive: false });
      expect(scope.phases[0].status).toBe('completed');
      expect(scope.completed).toBe(true);
    });

    it('should skip already completed phases when resuming', async () => {
      const scope = makeScope(engine, 'Resume', [
        makePhase('p1', 'Done'),
        makePhase('p2', 'Pending'),
      ]);
      scope.phases[0].status = 'completed';

      const executeFn = mockExecuteSuccess();
      await engine.executeScope(scope, executeFn, { interactive: false });

      expect(executeFn).toHaveBeenCalledTimes(1);
      expect(executeFn).toHaveBeenCalledWith('Pending', 'p2', expect.any(String));
    });

    it('should not re-execute already completed phases on resume', async () => {
      const scope = makeScope(engine, 'Resume2', [
        makePhase('p1', 'Done'),
        makePhase('p2', 'Also Done'),
        makePhase('p3', 'Pending'),
      ]);
      scope.phases[0].status = 'completed';
      scope.phases[1].status = 'completed';

      const executeFn = mockExecuteSuccess();
      await engine.executeScope(scope, executeFn, { interactive: false });

      expect(executeFn).toHaveBeenCalledTimes(1);
      expect(scope.phases[2].status).toBe('completed');
    });

    it('should save scope after each phase', async () => {
      const scope = makeScope(engine, 'Save Test', [
        makePhase('p1', 'First'),
        makePhase('p2', 'Second'),
      ]);

      const saveSpy = vi.spyOn(engine, 'saveScope');
      const executeFn = mockExecuteSuccess();

      await engine.executeScope(scope, executeFn, { interactive: false });
      // saveScope is called at least once per phase
      expect(saveSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('should set credentialsCollected via env vars when autoCredentials is enabled', async () => {
      process.env.GITHUB_TOKEN = 'ghp_test';
      process.env.NPM_TOKEN = 'npm_test';

      try {
        const scope = makeScope(engine, 'Creds Test', [
          makePhase('p1', 'Publish release'),
        ]);
        const executeFn = mockExecuteSuccess();

        await engine.executeScope(scope, executeFn, { interactive: false });
        expect(scope.credentialsCollected).toBe(true);
      } finally {
        delete process.env.GITHUB_TOKEN;
        delete process.env.NPM_TOKEN;
      }
    });
  });
});
