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
import { parseCLIOutput } from './outputParser.js';
import type { ExtensionConfig, FileChange } from './types.js';

// ─── CommandRegistrar ───────────────────────────────────────────────────────

export class CommandRegistrar {
  private cliManager: CLIManager;
  private agentPanel: AgentPanel;
  private diffViewer: DiffViewer;
  private config: ExtensionConfig;
  private currentChanges: FileChange[] = [];
  private disposables: vscode.Disposable[] = [];

  constructor(
    context: vscode.ExtensionContext,
    cliManager: CLIManager,
    agentPanel: AgentPanel,
    diffViewer: DiffViewer,
    config: ExtensionConfig,
  ) {
    this.cliManager = cliManager;
    this.agentPanel = agentPanel;
    this.diffViewer = diffViewer;
    this.config = config;
  }

  /**
   * Register all extension commands.
   * Commands invoked from context menus receive the resource URI as first argument.
   */
  registerAll(): vscode.Disposable[] {
    this.disposables = [
      vscode.commands.registerCommand('agent-nuvira.executeGoal', () => this.executeGoal()),
      vscode.commands.registerCommand('agent-nuvira.quickFix', (uri?: vscode.Uri) => this.quickFix(uri)),
      vscode.commands.registerCommand('agent-nuvira.reviewFile', (uri?: vscode.Uri) => this.reviewFile(uri)),
      vscode.commands.registerCommand('agent-nuvira.explainCode', () => this.explainCode()),
      vscode.commands.registerCommand('agent-nuvira.generateTest', (uri?: vscode.Uri) => this.generateTest(uri)),
      vscode.commands.registerCommand('agent-nuvira.showPanel', () => this.showPanel()),
      vscode.commands.registerCommand('agent-nuvira.runWorkflow', () => this.runWorkflow()),
      vscode.commands.registerCommand('agent-nuvira.acceptChanges', () => this.acceptChanges()),
      vscode.commands.registerCommand('agent-nuvira.rejectChanges', () => this.rejectChanges()),
    ];

    return this.disposables;
  }

  /**
   * Update the config when settings change.
   */
  updateConfig(config: ExtensionConfig): void {
    this.config = config;
  }

  // ── Command Handlers ─────────────────────────────────────────────────────

  /**
   * Execute a multi-agent pipeline goal.
   * Prompts the user for a goal, then runs it through the orchestrator.
   */
  private async executeGoal(): Promise<void> {
    const goal = await vscode.window.showInputBox({
      prompt: 'What goal should the agents accomplish?',
      placeHolder: 'e.g., "Add JWT authentication to the Express app"',
      validateInput: (value: string) => {
        if (!value.trim()) return 'Please enter a goal';
        if (value.length < 3) return 'Goal is too short';
        return undefined;
      },
    });

    if (!goal) return;

    await this.runAgentTask(
      `🎯 Executing: ${goal.slice(0, 60)}${goal.length > 60 ? '...' : ''}`,
      () => this.cliManager.executeGoal(goal),
    );
  }

  /**
   * Quick fix for the current file or a provided URI.
   */
  private async quickFix(uri?: vscode.Uri): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    // Determine file path: use provided URI (from context menu) or active editor
    let filePath: string | undefined;
    if (uri?.fsPath) {
      filePath = uri.fsPath;
    } else if (editor) {
      filePath = editor.document.uri.fsPath;
    }

    if (!filePath) {
      vscode.window.showWarningMessage('No file selected. Open a file or right-click one in the explorer.');
      return;
    }

    // If there's a selection in the active editor matching this file, use selection as context
    if (editor && editor.document.uri.fsPath === filePath && !editor.selection.isEmpty) {
      const code = editor.document.getText(editor.selection);
      await this.runAgentTask(
        `🔧 Quick fixing selection`,
        () => this.cliManager.executeGoal(
          `Fix any issues in this code:\n\n${code}`,
        ),
      );
      return;
    }

    await this.runAgentTask(
      `🔧 Quick fixing: ${filePath.split('/').pop() || filePath}`,
      () => this.cliManager.quickFix(filePath),
    );
  }

  /**
   * Review the current or selected file.
   * Accepts an optional URI from the context menu.
   */
  private async reviewFile(uri?: vscode.Uri): Promise<void> {
    // Determine file path: use provided URI (from context menu) or active editor
    let filePath: string | undefined;
    if (uri?.fsPath) {
      filePath = uri.fsPath;
    } else {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        filePath = editor.document.uri.fsPath;
      }
    }

    if (!filePath) {
      vscode.window.showWarningMessage('No file selected. Open a file or right-click one in the explorer.');
      return;
    }

    await this.runAgentTask(
      `📋 Reviewing: ${filePath.split('/').pop() || filePath}`,
      () => this.cliManager.reviewFile(filePath),
    );
  }

  /**
   * Explain the selected code.
   */
  private async explainCode(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor. Select code to explain.');
      return;
    }

    const selection = editor.selection;
    if (selection.isEmpty) {
      vscode.window.showWarningMessage('Select code to explain first.');
      return;
    }

    const code = editor.document.getText(selection);
    const fileExtension = editor.document.fileName.split('.').pop();

    await this.runAgentTask(
      `📖 Explaining selected code`,
      () => this.cliManager.explainCode(code, fileExtension),
      { showResultInline: true }, // Show explanation in a new editor tab
    );
  }

  /**
   * Generate tests for the current file or a provided URI.
   */
  private async generateTest(uri?: vscode.Uri): Promise<void> {
    // Determine file path: use provided URI (from context menu) or active editor
    let filePath: string | undefined;
    if (uri?.fsPath) {
      filePath = uri.fsPath;
    } else {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        filePath = editor.document.uri.fsPath;
      }
    }

    if (!filePath) {
      vscode.window.showWarningMessage('No file selected. Open a file or right-click one in the explorer.');
      return;
    }

    await this.runAgentTask(
      `🧪 Generating tests for: ${filePath.split('/').pop() || filePath}`,
      () => this.cliManager.generateTests(filePath),
    );
  }

  /**
   * Show the agent progress panel.
   */
  private async showPanel(): Promise<void> {
    this.agentPanel.createOrShow(vscode.Uri.file(__dirname));
    this.agentPanel.updateStatus('Ready');
  }

  /**
   * Run a workflow template.
   */
  private async runWorkflow(): Promise<void> {
    // Get available workflow templates from the CLI
    type WorkflowOption = vscode.QuickPickItem & { template: string };
    const templates: WorkflowOption[] = [
      { label: 'Quick Fix', description: 'Gather context → Edit → Review', template: 'quick-fix' },
      { label: 'Feature Implementation', description: 'Plan → Gather → Write → Test → Review → Commit', template: 'feature-implement' },
      { label: 'Security Audit', description: 'Scan codebase for vulnerabilities', template: 'security-audit' },
    ];

    const selected = await vscode.window.showQuickPick(templates, {
      placeHolder: 'Select a workflow template:',
    });

    if (!selected) return;

    const goal = await vscode.window.showInputBox({
      prompt: `Enter the goal for the "${selected.label}" workflow:`,
      placeHolder: 'e.g., "Add input validation to the login form"',
    });

    if (!goal) return;

    await this.runAgentTask(
      `🔄 Running workflow "${selected.label}": ${goal.slice(0, 50)}${goal.length > 50 ? '...' : ''}`,
      () => this.cliManager.runWorkflow(selected.template, goal),
    );
  }

  /**
   * Accept all proposed changes.
   */
  private async acceptChanges(): Promise<void> {
    if (this.currentChanges.length === 0) {
      vscode.window.showWarningMessage('No pending changes to accept.');
      return;
    }

    const applied = await this.diffViewer.applyChanges(this.currentChanges);
    this.currentChanges = [];

    // Clear the hasChanges context so accept/reject keybindings deactivate
    vscode.commands.executeCommand('setContext', 'agent-nuvira.hasChanges', false);

    if (applied > 0) {
      this.agentPanel.updateStatus('✅ Changes applied');
    }
  }

  /**
   * Reject all proposed changes.
   */
  private async rejectChanges(): Promise<void> {
    if (this.currentChanges.length === 0) {
      vscode.window.showWarningMessage('No pending changes to reject.');
      return;
    }

    this.diffViewer.rejectChanges();
    this.currentChanges = [];
    this.agentPanel.clear();
    this.agentPanel.updateStatus('Changes rejected');

    // Clear the hasChanges context so keybindings deactivate
    vscode.commands.executeCommand('setContext', 'agent-nuvira.hasChanges', false);
  }

  // ── Task Runner ───────────────────────────────────────────────────────────

  /**
   * Run an agent task with progress tracking and result handling.
   */
  private async runAgentTask(
    title: string,
    task: () => Promise<import('./types.js').CLIResult>,
    options?: { showResultInline?: boolean },
  ): Promise<void> {
    // Show the panel
    if (this.config.showProgressPanel) {
      this.agentPanel.createOrShow(vscode.Uri.file(__dirname));
    }

    // Clear previous state
    this.agentPanel.clear();
    this.currentChanges = [];

    // Set up callbacks
    this.cliManager.setCallbacks({
      onProgress: (phase: string, detail?: string) => {
        this.agentPanel.updateProgress({
          phase,
          progress: -1, // Indeterminate
          detail,
          completed: false,
          log: [],
        });
      },
      onLog: (line: string) => {
        this.agentPanel.updateProgress({
          phase: title,
          progress: -1,
          detail: line.slice(0, 120),
          completed: false,
          log: [line],
        });
      },
    });

    this.agentPanel.updateProgress({
      phase: title,
      progress: 0,
      detail: 'Starting...',
      completed: false,
      log: [],
    });

    // Set up cancel handler
    this.agentPanel.setCallbacks({
      onCancelTask: () => {
        this.cliManager.cancel();
        this.agentPanel.updateStatus('Cancelled');
      },
      onAcceptChanges: async (changes: FileChange[]) => {
        this.currentChanges = changes;
        await this.acceptChanges();
      },
      onRejectChanges: (changes: FileChange[]) => {
        this.currentChanges = changes;
        this.rejectChanges();
      },
    });

    // Run the task
    try {
      const result = await task();

      if (result.success) {
        // Parse the result to extract file changes
        const parsedResult = parseCLIOutput(result.stdout);

        // Show diff previews unless auto-apply is on
        if (parsedResult.changes.length > 0 && !this.config.autoApplyChanges) {
          this.currentChanges = parsedResult.changes;
          // Set context so accept/reject keybindings activate
          vscode.commands.executeCommand('setContext', 'agent-nuvira.hasChanges', true);
          await this.diffViewer.showChanges(parsedResult.changes);
          this.agentPanel.showDiffs(parsedResult.changes);
        } else if (parsedResult.changes.length > 0 && this.config.autoApplyChanges) {
          // Auto-apply
          const applied = await this.diffViewer.applyChanges(parsedResult.changes);
          parsedResult.changes.forEach((c) => (c.applied = true));
          this.currentChanges = [];
        }

        // Show result in panel
        this.agentPanel.showResult(parsedResult);

        // Show inline result if requested (e.g., for explanations)
        if (options?.showResultInline && parsedResult.output) {
          const doc = await vscode.workspace.openTextDocument({
            content: parsedResult.output,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        }
      } else {
        // Partial success or failure
        this.agentPanel.showError(result.stderr || 'Task completed with warnings.');

        // Still try to show any partial output
        if (result.stdout) {
          const parsedResult = parseCLIOutput(result.stdout);
          if (parsedResult.changes.length > 0) {
            this.currentChanges = parsedResult.changes;
            this.agentPanel.showDiffs(parsedResult.changes);
          }
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.agentPanel.showError(errorMsg);
    }
  }

  /**
   * Clean up on deactivation.
   */
  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
