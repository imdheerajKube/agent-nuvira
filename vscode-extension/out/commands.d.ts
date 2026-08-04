/**
 * Commands — Registers all VS Code commands for the Agent-Nuvira extension.
 *
 * Commands:
 * - agent-nuvira.executeGoal    — Run a multi-agent pipeline
 * - agent-nuvira.quickFix       — Quick fix for the current file
 * - agent-nuvira.reviewFile     — Review the current file
 * - agent-nuvira.explainCode    — Explain selected code
 * - agent-nuvira.generateTest   — Generate tests
 * - agent-nuvira.showPanel      — Show the agent panel
 * - agent-nuvira.runWorkflow    — Run a workflow template
 * - agent-nuvira.acceptChanges  — Accept all proposed changes
 * - agent-nuvira.rejectChanges  — Reject all proposed changes
 */
import * as vscode from 'vscode';
import { CLIManager } from './cliManager.js';
import { AgentPanel } from './agentPanel.js';
import { DiffViewer } from './diffViewer.js';
import type { ExtensionConfig } from './types.js';
export declare class CommandRegistrar {
    private cliManager;
    private agentPanel;
    private diffViewer;
    private config;
    private currentChanges;
    private disposables;
    /** Fired after a provider/model switch so the status bar can refresh */
    private onModelChanged?;
    constructor(context: vscode.ExtensionContext, cliManager: CLIManager, agentPanel: AgentPanel, diffViewer: DiffViewer, config: ExtensionConfig);
    /**
     * Register all extension commands.
     * Commands invoked from context menus receive the resource URI as first argument.
     */
    registerAll(): vscode.Disposable[];
    /**
     * Update the config when settings change.
     */
    updateConfig(config: ExtensionConfig): void;
    /**
     * Register a callback fired after a provider/model switch.
     */
    setOnModelChanged(cb: () => void): void;
    /**
     * Execute a multi-agent pipeline goal.
     * Prompts the user for a goal, then runs it through the orchestrator.
     */
    private executeGoal;
    /**
     * Quick fix for the current file or a provided URI.
     */
    private quickFix;
    /**
     * Review the current or selected file.
     * Accepts an optional URI from the context menu.
     */
    private reviewFile;
    /**
     * Explain the selected code.
     */
    private explainCode;
    /**
     * Generate tests for the current file or a provided URI.
     */
    private generateTest;
    /**
     * Show the agent progress panel.
     */
    private showPanel;
    /**
     * Run a workflow template.
     */
    private runWorkflow;
    /**
     * Accept all proposed changes.
     */
    private acceptChanges;
    /**
     * Reject all proposed changes.
     */
    private rejectChanges;
    /**
     * Switch the active provider/model — or enable Auto model routing.
     *
     * Two-step flow:
     * 1. Lists providers from `buff model list` and lets the user pick one
     * 2. For a non-auto provider, lists its actual models via `buff models`
     *    and lets the user pick a specific one (or keep the provider default)
     */
    private switchModel;
    /**
     * Fetch a provider's actual models (`buff models`) and let the user pick one.
     * The first option keeps the provider's configured default model.
     *
     * Returns the chosen model id, or undefined to keep the provider default.
     * Falls back to provider-only switching when the model list can't be loaded.
     */
    private pickProviderModel;
    /**
     * Show a searchable quick-pick for long lists (e.g. OpenRouter's 100+ models).
     * Uses `createQuickPick` so the native search box filters items as the user
     * types, matching against both the label and the description (model id).
     *
     * Resolves with the picked item, or undefined when dismissed (Esc).
     */
    private showSearchableQuickPick;
    /**
     * Run a health check for the active provider and show the report.
     */
    private modelHealth;
    /**
     * Run an agent task with progress tracking and result handling.
     */
    private runAgentTask;
    /**
     * Clean up on deactivation.
     */
    dispose(): void;
}
//# sourceMappingURL=commands.d.ts.map