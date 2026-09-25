/**
 * PhaseExecutionEngine — Phase-wise project scope execution.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { resolveNuviraHome } from '../config/paths';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import { CredentialStore } from './credential-store.js';
import type { ReleasePhaseRunner } from './release-runner.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PhaseDefinition {
  id: string;
  goal: string;
  description: string;
  dependsOn?: string[];
  /**
   * Deterministic implementation, when the phase is a known mechanical step.
   *
   * A phase WITHOUT a runner goes to the orchestrator (the LLM plans it). The
   * publish pipeline attaches one to every phase, because a release run should
   * not depend on plan quality or provider health — a live 3.3.2 attempt planned
   * "add standard-version + write scripts/release.ts" for a goal that says
   * "Bump version (patch)", then failed under a rate-limited provider.
   *
   * Deliberately NOT part of `PhaseState`: state is serialized to disk for
   * resume, and a function cannot round-trip through JSON.
   */
  runner?: ReleasePhaseRunner;
}

export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface PhaseState {
  id: string;
  goal: string;
  description: string;
  status: PhaseStatus;
  summary?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PhaseScopeDefinition {
  name: string;
  phases: PhaseDefinition[];
  options?: PhaseScopeOptions;
  /**
   * The version a publish scope is creating (`3.3.2`). Persisted so a resumed
   * run can tell "this release already bumped to the version it is aiming at"
   * from "a previous release left a different version behind" — the difference
   * between continuing a release and bumping it a second time.
   */
  targetVersion?: string;
}

export interface PhaseScopeState {
  name: string;
  createdAt: string;
  updatedAt: string;
  phases: PhaseState[];
  completed: boolean;
  currentPhaseIndex: number;
  credentialsCollected: boolean;
  /** See {@link PhaseScopeDefinition.targetVersion}. */
  targetVersion?: string;
}

export interface PhaseScopeOptions {
  provider?: string;
  model?: string;
  verbose?: boolean;
  dryRun?: boolean;
  useMemory?: boolean;
  skipTests?: boolean;
  autoCredentials?: boolean;
}

export interface PhaseResult {
  phase: PhaseState;
  continueExecution: boolean;
}

/** Terminal statuses that indicate a phase is done */
const DONE_STATUSES: PhaseStatus[] = ['completed', 'failed', 'skipped'];
const NOT_RUNNABLE_STATUSES: PhaseStatus[] = ['completed', 'skipped'];

function getStatePath(scopeName: string): string {
  const buffDir = join(resolveNuviraHome(), 'phases');
  if (!existsSync(buffDir)) {
    try { mkdirSync(buffDir, { recursive: true }); } catch { /* best-effort */ }
  }
  const sanitized = scopeName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return join(buffDir, `${sanitized}.json`);
}

/**
 * Adopt the progress of an unfinished run into a freshly built scope.
 *
 * Returns the index to resume from, or -1 when there is nothing to resume.
 *
 * This is deliberately a pure function: it is the decision that separates
 * "continue a release" from "bump the version again", and a live run got it
 * wrong by not making the decision at all — a killed release left a pushed
 * commit and tag, and the next run would have cut 3.3.3 on top of it.
 *
 * The rules, each for a specific reason:
 * - A scope with a DIFFERENT (or missing) target version is not this release.
 *   Resuming it would mix two versions in one scope; a fresh run is announced
 *   by the caller instead.
 * - A COMPLETED scope is a finished release, not an interrupted one.
 * - Statuses are carried BY PHASE ID, because the phase list can grow between
 *   releases (a new phase must run even when everything else is done).
 * - `running` is NOT carried: it is the mark a process leaves when it dies
 *   mid-phase, and the only safe reading of it is "this phase did not finish".
 */
export function adoptSavedProgress(
  scope: PhaseScopeState,
  saved: PhaseScopeState | null,
): number {
  if (!saved || saved.completed) return -1;
  if (!scope.targetVersion || saved.targetVersion !== scope.targetVersion) return -1;

  const previous = new Map(saved.phases.map((p) => [p.id, p.status]));
  for (const phase of scope.phases) {
    const status = previous.get(phase.id);
    if (status === 'completed' || status === 'skipped') phase.status = status;
  }

  const index = scope.phases.findIndex((p) => p.status === 'pending');
  if (index <= 0) return -1; // nothing done yet — this is a fresh run
  scope.currentPhaseIndex = index - 1;
  return index;
}

/**
 * Mark every phase before `from` as skipped, and return the index of `from`.
 *
 * `from` matches a phase id or its human description, because an operator
 * reading the pipeline's own output has the description in hand, not the id
 * (`--from "npm Build & Publish"` must work). Returns -1 when nothing matches,
 * so a typo cannot silently run the whole pipeline from the start.
 */
export function skipPhasesBefore(scope: PhaseScopeState, from: string): number {
  const index = scope.phases.findIndex((p) => p.id === from || p.description === from);
  if (index === -1) return -1;
  for (let i = 0; i < index; i++) {
    if (scope.phases[i].status === 'pending') scope.phases[i].status = 'skipped';
  }
  return index;
}

// ─── PhaseExecutionEngine ────────────────────────────────────────────────────

export class PhaseExecutionEngine {
  private credentialStore?: CredentialStore;

  constructor(credentialStore?: CredentialStore) {
    this.credentialStore = credentialStore;
  }

  createScope(definition: PhaseScopeDefinition): PhaseScopeState {
    const now = new Date().toISOString();
    return {
      name: definition.name,
      createdAt: now,
      updatedAt: now,
      phases: definition.phases.map((p) => ({
        id: p.id,
        goal: p.goal,
        description: p.description,
        status: 'pending' as PhaseStatus,
      })),
      completed: false,
      currentPhaseIndex: -1,
      credentialsCollected: false,
      ...(definition.targetVersion ? { targetVersion: definition.targetVersion } : {}),
    };
  }

  loadScope(scopeName: string): PhaseScopeState | null {
    const path = getStatePath(scopeName);
    try {
      if (!existsSync(path)) return null;
      const raw = readFileSync(path, 'utf-8');
      return JSON.parse(raw) as PhaseScopeState;
    } catch {
      return null;
    }
  }

  saveScope(scope: PhaseScopeState): void {
    scope.updatedAt = new Date().toISOString();
    const path = getStatePath(scope.name);
    try {
      const dir = join(resolveNuviraHome(), 'phases');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(path, JSON.stringify(scope, null, 2), 'utf-8');
    } catch (err) {
      logger.debug(`Failed to save phase scope: ${err}`);
    }
  }

  deleteScope(scopeName: string): void {
    const path = getStatePath(scopeName);
    try {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    } catch { /* best-effort */ }
  }

  listSavedScopes(): string[] {
    const dir = join(resolveNuviraHome(), 'phases');
    try {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f: string) => f.endsWith('.json'))
        .map((f: string) => f.replace('.json', '').replace(/_/g, ' '))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * The first phase that still needs running.
   *
   * `running` counts as INCOMPLETE. A phase is marked `running` and only then
   * written to disk, so a process killed mid-phase leaves exactly that state —
   * and skipping it is how a resumed release jumped straight to the GitHub
   * release while its npm publish had never happened.
   */
  getNextPhase(scope: PhaseScopeState): PhaseState | null {
    for (const phase of scope.phases) {
      if (phase.status === 'completed' || phase.status === 'skipped') continue;
      return phase;
    }
    return null;
  }

  getProgress(scope: PhaseScopeState): string {
    const total = scope.phases.length;
    const completed = scope.phases.filter((p) => p.status === 'completed').length;
    const failed = scope.phases.filter((p) => p.status === 'failed').length;
    const running = scope.phases.filter((p) => p.status === 'running').length;

    const lines: string[] = [];
    lines.push(`  Scope: ${scope.name}`);
    lines.push(`  Progress: ${completed}/${total} phases completed`);
    if (failed > 0) lines.push(`  Failed: ${failed}`);
    if (running > 0) lines.push(`  Running: ${running}`);
    lines.push('');

    for (let i = 0; i < scope.phases.length; i++) {
      const p = scope.phases[i];
      const statusIcon = p.status === 'completed' ? '✅' :
                         p.status === 'failed' ? '❌' :
                         p.status === 'running' ? '🔄' :
                         p.status === 'skipped' ? '⏭️' :
                         '⏳';
      lines.push(`  ${statusIcon} [${i + 1}/${total}] ${p.description}`);
      if (p.summary) {
        lines.push(`       ${p.summary.slice(0, 80)}`);
      }
    }

    return lines.join('\n');
  }

  async collectCredentials(scope: PhaseScopeState): Promise<boolean> {
    const hasPublishPhase = scope.phases.some((p) =>
      p.goal.toLowerCase().includes('publish') ||
      p.goal.toLowerCase().includes('release') ||
      p.goal.toLowerCase().includes('deploy') ||
      p.goal.toLowerCase().includes('push')
    );

    if (!hasPublishPhase) {
      scope.credentialsCollected = true;
      return true;
    }

    const hasGitCreds = !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
    const hasNpmCreds = !!(process.env.NPM_TOKEN);

    if (hasGitCreds && hasNpmCreds) {
      logger.info('  🔑 Publishing credentials detected from environment variables');
      scope.credentialsCollected = true;
      return true;
    }

    try {
      if (!this.credentialStore) {
        this.credentialStore = new CredentialStore();
      }
      await this.credentialStore.collectAll();
      this.credentialStore.setupGitCredentials();
      this.credentialStore.setupNpmAuth();
      scope.credentialsCollected = true;
      return true;
    } catch (err) {
      logger.error(`  ❌ Credential collection failed: ${err}`);
      return false;
    }
  }

  async executePhase(
    scope: PhaseScopeState,
    phaseIndex: number,
    executeFn: (goal: string, phaseId: string, phaseDescription: string) => Promise<{ success: boolean; summary: string; error?: string }>,
  ): Promise<PhaseResult> {
    const phase = scope.phases[phaseIndex];
    if (!phase) {
      return {
        phase: { id: 'unknown', goal: '', description: 'Phase not found', status: 'failed', error: 'Invalid phase index' },
        continueExecution: false,
      };
    }

    phase.status = 'running';
    phase.startedAt = new Date().toISOString();
    scope.currentPhaseIndex = phaseIndex;
    this.saveScope(scope);

    logger.highlight(`\n${'═'.repeat(50)}`);
    logger.highlight(`  Phase ${phaseIndex + 1}/${scope.phases.length}: ${phase.description}`);
    logger.highlight(`${'═'.repeat(50)}`);
    logger.info(`  Goal: ${phase.goal}`);
    console.log('');

    try {
      const result = await executeFn(phase.goal, phase.id, phase.description);

      phase.status = result.success ? 'completed' : 'failed';
      phase.completedAt = new Date().toISOString();
      phase.summary = result.summary;
      if (result.error) phase.error = result.error;

      if (result.success) {
        logger.success(`\n  ✅ Phase ${phaseIndex + 1} completed: ${phase.description}`);
      } else {
        logger.error(`\n  ❌ Phase ${phaseIndex + 1} failed: ${phase.description}`);
        if (result.error) {
          logger.error(`     ${result.error.slice(0, 300)}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      phase.status = 'failed';
      phase.completedAt = new Date().toISOString();
      phase.error = msg;
      phase.summary = `Phase errored: ${msg.slice(0, 100)}`;
      logger.error(`\n  ❌ Phase ${phaseIndex + 1} errored: ${msg.slice(0, 300)}`);
    }

    this.saveScope(scope);

    const allDone = scope.phases.every((p) => DONE_STATUSES.includes(p.status));
    if (allDone) {
      scope.completed = true;
      scope.currentPhaseIndex = -2;
      this.saveScope(scope);
    }

    const continueExecution = NOT_RUNNABLE_STATUSES.includes(phase.status);
    return {
      phase: { ...phase },
      continueExecution,
    };
  }

  async executeScope(
    scope: PhaseScopeState,
    executeFn: (goal: string, phaseId: string, phaseDescription: string) => Promise<{ success: boolean; summary: string; error?: string }>,
    options?: {
      interactive?: boolean;
      autoCredentials?: boolean;
    },
  ): Promise<void> {
    const interactive = options?.interactive !== false;
    const autoCredentials = options?.autoCredentials !== false;

    // `running` is included deliberately: a scope saved by a process that died
    // mid-phase must re-run that phase, not step over it (see getNextPhase).
    const startIndex = scope.phases.findIndex(
      (p) => p.status === 'pending' || p.status === 'failed' || p.status === 'running',
    );

    if (startIndex === -1) {
      logger.success('\n  ✅ All phases are already completed!');
      logger.info(this.getProgress(scope));
      return;
    }

    if (startIndex > 0) {
      const completed = scope.phases.filter((p) => p.status === 'completed').length;
      logger.info(`  Resuming from phase ${startIndex + 1}/${scope.phases.length} (${completed} already completed)`);
    }

    for (let i = startIndex; i < scope.phases.length; i++) {
      const phase = scope.phases[i];
      if (NOT_RUNNABLE_STATUSES.includes(phase.status)) continue;

      if (autoCredentials && !scope.credentialsCollected) {
        const needsCreds = phase.goal.toLowerCase().includes('publish') ||
          phase.goal.toLowerCase().includes('release') ||
          phase.goal.toLowerCase().includes('deploy') ||
          phase.goal.toLowerCase().includes('push');

        if (needsCreds) {
          await this.collectCredentials(scope);
        }
      }

      const result = await this.executePhase(scope, i, executeFn);

      if (!result.continueExecution) {
        if (interactive) {
          logger.info(`\n  Phase failed: ${result.phase.summary}`);
          this.saveScope(scope);
          logger.info(`\n  💡 Phase scope saved. Resume with: nuvira phase resume "${scope.name}"`);
          logger.info(`     Or check progress: nuvira phase status "${scope.name}"`);
          return;
        } else {
          return;
        }
      }

      if (interactive && i < scope.phases.length - 1) {
        console.log('');
        logger.highlight(`${'─'.repeat(50)}`);
        logger.info(this.getProgress(scope));
        logger.highlight(`${'─'.repeat(50)}`);
        console.log('');

        this.saveScope(scope);
        logger.success(`  ✅ Phase ${i + 1}/${scope.phases.length} complete.`);
        logger.info(`  Next phase: ${scope.phases[i + 1].description}`);
        logger.info('');
        logger.info(`  Run: nuvira phase resume "${scope.name}"`);
        logger.info(`  Or:  nuvira phase status "${scope.name}"`);
        return;
      }
    }

    scope.completed = true;
    scope.currentPhaseIndex = -2;
    this.saveScope(scope);

    console.log('');
    logger.highlight(`${'═'.repeat(50)}`);
    logger.highlight(`  🎉  Scope Complete: ${scope.name}`);
    logger.highlight(`${'═'.repeat(50)}`);

    const completed = scope.phases.filter((p) => p.status === 'completed').length;
    const failed = scope.phases.filter((p) => p.status === 'failed').length;

    logger.success(`  ✅ ${completed} phase(s) completed`);
    if (failed > 0) logger.error(`  ❌ ${failed} phase(s) failed`);
    console.log('');
    logger.info(this.getProgress(scope));

    if (this.credentialStore) {
      this.credentialStore.cleanup();
    }
  }
}
