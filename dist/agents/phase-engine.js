/**
 * PhaseExecutionEngine — Phase-wise project scope execution.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import { CredentialStore } from './credential-store.js';
/** Terminal statuses that indicate a phase is done */
const DONE_STATUSES = ['completed', 'failed', 'skipped'];
const NOT_RUNNABLE_STATUSES = ['completed', 'skipped'];
function getStatePath(scopeName) {
    const buffDir = join(homedir(), '.buff', 'phases');
    if (!existsSync(buffDir)) {
        try {
            mkdirSync(buffDir, { recursive: true });
        }
        catch { /* best-effort */ }
    }
    const sanitized = scopeName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    return join(buffDir, `${sanitized}.json`);
}
// ─── PhaseExecutionEngine ────────────────────────────────────────────────────
export class PhaseExecutionEngine {
    credentialStore;
    constructor(credentialStore) {
        this.credentialStore = credentialStore;
    }
    createScope(definition) {
        const now = new Date().toISOString();
        return {
            name: definition.name,
            createdAt: now,
            updatedAt: now,
            phases: definition.phases.map((p) => ({
                id: p.id,
                goal: p.goal,
                description: p.description,
                status: 'pending',
            })),
            completed: false,
            currentPhaseIndex: -1,
            credentialsCollected: false,
        };
    }
    loadScope(scopeName) {
        const path = getStatePath(scopeName);
        try {
            if (!existsSync(path))
                return null;
            const raw = readFileSync(path, 'utf-8');
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    saveScope(scope) {
        scope.updatedAt = new Date().toISOString();
        const path = getStatePath(scope.name);
        try {
            const dir = join(homedir(), '.buff', 'phases');
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
            writeFileSync(path, JSON.stringify(scope, null, 2), 'utf-8');
        }
        catch (err) {
            logger.debug(`Failed to save phase scope: ${err}`);
        }
    }
    deleteScope(scopeName) {
        const path = getStatePath(scopeName);
        try {
            if (existsSync(path)) {
                unlinkSync(path);
            }
        }
        catch { /* best-effort */ }
    }
    listSavedScopes() {
        const dir = join(homedir(), '.buff', 'phases');
        try {
            if (!existsSync(dir))
                return [];
            return readdirSync(dir)
                .filter((f) => f.endsWith('.json'))
                .map((f) => f.replace('.json', '').replace(/_/g, ' '))
                .filter(Boolean);
        }
        catch {
            return [];
        }
    }
    getNextPhase(scope) {
        for (const phase of scope.phases) {
            if (phase.status !== 'pending')
                continue;
            return phase;
        }
        return null;
    }
    getProgress(scope) {
        const total = scope.phases.length;
        const completed = scope.phases.filter((p) => p.status === 'completed').length;
        const failed = scope.phases.filter((p) => p.status === 'failed').length;
        const running = scope.phases.filter((p) => p.status === 'running').length;
        const lines = [];
        lines.push(`  Scope: ${scope.name}`);
        lines.push(`  Progress: ${completed}/${total} phases completed`);
        if (failed > 0)
            lines.push(`  Failed: ${failed}`);
        if (running > 0)
            lines.push(`  Running: ${running}`);
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
    async collectCredentials(scope) {
        const hasPublishPhase = scope.phases.some((p) => p.goal.toLowerCase().includes('publish') ||
            p.goal.toLowerCase().includes('release') ||
            p.goal.toLowerCase().includes('deploy') ||
            p.goal.toLowerCase().includes('push'));
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
        }
        catch (err) {
            logger.error(`  ❌ Credential collection failed: ${err}`);
            return false;
        }
    }
    async executePhase(scope, phaseIndex, executeFn) {
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
            if (result.error)
                phase.error = result.error;
            if (result.success) {
                logger.success(`\n  ✅ Phase ${phaseIndex + 1} completed: ${phase.description}`);
            }
            else {
                logger.error(`\n  ❌ Phase ${phaseIndex + 1} failed: ${phase.description}`);
                if (result.error) {
                    logger.error(`     ${result.error.slice(0, 300)}`);
                }
            }
        }
        catch (err) {
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
    async executeScope(scope, executeFn, options) {
        const interactive = options?.interactive !== false;
        const autoCredentials = options?.autoCredentials !== false;
        const startIndex = scope.phases.findIndex((p) => p.status === 'pending' || p.status === 'failed');
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
            if (NOT_RUNNABLE_STATUSES.includes(phase.status))
                continue;
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
                    logger.info(`\n  💡 Phase scope saved. Resume with: buff phase resume "${scope.name}"`);
                    logger.info(`     Or check progress: buff phase status "${scope.name}"`);
                    return;
                }
                else {
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
                logger.info(`  Run: buff phase resume "${scope.name}"`);
                logger.info(`  Or:  buff phase status "${scope.name}"`);
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
        if (failed > 0)
            logger.error(`  ❌ ${failed} phase(s) failed`);
        console.log('');
        logger.info(this.getProgress(scope));
        if (this.credentialStore) {
            this.credentialStore.cleanup();
        }
    }
}
//# sourceMappingURL=phase-engine.js.map