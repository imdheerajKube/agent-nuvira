/**
 * PhaseExecutionEngine — Phase-wise project scope execution.
 */
import { CredentialStore } from './credential-store.js';
export interface PhaseDefinition {
    id: string;
    goal: string;
    description: string;
    dependsOn?: string[];
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
}
export interface PhaseScopeState {
    name: string;
    createdAt: string;
    updatedAt: string;
    phases: PhaseState[];
    completed: boolean;
    currentPhaseIndex: number;
    credentialsCollected: boolean;
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
export declare class PhaseExecutionEngine {
    private credentialStore?;
    constructor(credentialStore?: CredentialStore);
    createScope(definition: PhaseScopeDefinition): PhaseScopeState;
    loadScope(scopeName: string): PhaseScopeState | null;
    saveScope(scope: PhaseScopeState): void;
    deleteScope(scopeName: string): void;
    listSavedScopes(): string[];
    getNextPhase(scope: PhaseScopeState): PhaseState | null;
    getProgress(scope: PhaseScopeState): string;
    collectCredentials(scope: PhaseScopeState): Promise<boolean>;
    executePhase(scope: PhaseScopeState, phaseIndex: number, executeFn: (goal: string, phaseId: string, phaseDescription: string) => Promise<{
        success: boolean;
        summary: string;
        error?: string;
    }>): Promise<PhaseResult>;
    executeScope(scope: PhaseScopeState, executeFn: (goal: string, phaseId: string, phaseDescription: string) => Promise<{
        success: boolean;
        summary: string;
        error?: string;
    }>, options?: {
        interactive?: boolean;
        autoCredentials?: boolean;
    }): Promise<void>;
}
//# sourceMappingURL=phase-engine.d.ts.map