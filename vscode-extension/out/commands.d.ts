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
     * Run an agent task with progress tracking and result handling.
     */
    private runAgentTask;
    /**
     * Clean up on deactivation.
     */
    dispose(): void;
}
//# sourceMappingURL=commands.d.ts.map