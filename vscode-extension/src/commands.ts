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
import type { ExtensionConfig, FileChange, ProviderInfo, ProviderModelInfo } from './types.js';

// ─── CommandRegistrar ───────────────────────────────────────────────────────

/** A quick-pick entry in the model/provider switcher */
type ModelOption = vscode.QuickPickItem & {
  /** Provider type (e.g. 'groq', 'auto') */
  value: string;
  /** Model id, present only for specific-model options */
  model?: string;
};

export class CommandRegistrar {
  private cliManager: CLIManager;
  private agentPanel: AgentPanel;
  private diffViewer: DiffViewer;
  private config: ExtensionConfig;
  private currentChanges: FileChange[] = [];
  private disposables: vscode.Disposable[] = [];
  /** Fired after a provider/model switch so the status bar can refresh */
  private onModelChanged?: () => void;

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
      vscode.commands.registerCommand('agent-nuvira.switchModel', () => this.switchModel()),
      vscode.commands.registerCommand('agent-nuvira.modelHealth', () => this.modelHealth()),
    ];

    return this.disposables;
  }

  /**
   * Update the config when settings change.
   */
  updateConfig(config: ExtensionConfig): void {
    this.config = config;
  }

  /**
   * Register a callback fired after a provider/model switch.
   */
  setOnModelChanged(cb: () => void): void {
    this.onModelChanged = cb;
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

  /**
   * Switch the active provider/model — or enable Auto model routing.
   *
   * Two-step flow:
   * 1. Lists providers from `buff model list` and lets the user pick one
   * 2. For a non-auto provider, lists its actual models via `buff models`
   *    and lets the user pick a specific one (or keep the provider default)
   */
  private async switchModel(): Promise<void> {
    // Fetch providers from the CLI (best effort — fall back to Auto only)
    let providers: ProviderInfo[] = [];
    try {
      providers = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Agent-Nuvira: checking providers...',
          cancellable: false,
        },
        () => this.cliManager.listModels(),
      );
    } catch {
      providers = [];
    }

    const options: ModelOption[] = [
      {
        label: '$(sparkle) Auto routing',
        description: 'Agent picks the best provider/model for each task',
        value: 'auto',
      },
    ];

    for (const p of providers) {
      const statusIcon = p.available ? '✅' : p.configured ? '⚠️' : '⏳';
      const statusText = p.available ? 'Available' : p.configured ? 'Unreachable' : 'Needs key';
      const model = p.defaultModel ? ` — ${p.defaultModel}` : '';
      options.push({
        label: `${p.icon || '🔹'} ${p.label}${p.isActive ? ' (active)' : ''}`,
        description: `${statusIcon} ${statusText}${model}`,
        value: p.type,
      });
    }

    const selected = await vscode.window.showQuickPick(options, {
      placeHolder: 'Select a provider:',
    });
    if (!selected) return;

    // Drill into the provider's real models so users can pick a specific one
    let modelId: string | undefined;
    if (selected.value !== 'auto') {
      const providerInfo = providers.find((p) => p.type === selected.value);
      modelId = await this.pickProviderModel(selected.value, providerInfo);
    }

    // Warn when pinning a provider while auto-routing would override it
    if (this.config.useAutoRouting && selected.value !== 'auto') {
      const choice = await vscode.window.showWarningMessage(
        'Auto routing is enabled and will override this choice for chat/execute. Switch anyway?',
        'Switch anyway',
        'Cancel',
      );
      if (choice !== 'Switch anyway') return;
    }

    const display = selected.value === 'auto'
      ? 'Auto routing enabled'
      : modelId ? `${selected.value}/${modelId}` : selected.value;

    try {
      const result = modelId
        ? await this.cliManager.switchModel(selected.value, modelId)
        : await this.cliManager.switchModel(selected.value);
      if (result.success) {
        this.agentPanel.updateStatus(selected.value === 'auto' ? '🤖 Auto routing enabled' : `✅ Switched to ${display}`);
        this.onModelChanged?.();
        vscode.window.showInformationMessage(
          selected.value === 'auto' ? '🤖 Auto routing enabled' : `✅ Switched to ${display}`,
        );
      } else {
        vscode.window.showErrorMessage(`Switch failed: ${result.stderr || 'Unknown error'}`);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Switch failed: ${err.message || 'Unknown error'}`);
    }
  }

  /**
   * Fetch a provider's actual models (`buff models`) and let the user pick one.
   * The first option keeps the provider's configured default model.
   *
   * Returns the chosen model id, or undefined to keep the provider default.
   * Falls back to provider-only switching when the model list can't be loaded.
   */
  private async pickProviderModel(
    providerType: string,
    providerInfo?: ProviderInfo,
  ): Promise<string | undefined> {
    let models: ProviderModelInfo[] = [];
    try {
      models = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Agent-Nuvira: fetching ${providerInfo?.label || providerType} models...`,
          cancellable: false,
        },
        () => this.cliManager.listProviderModels(providerType),
      );
    } catch {
      models = [];
    }

    // If the CLI can't list models, just switch with the provider's default
    if (models.length === 0) return undefined;

    const providerLabel = providerInfo?.label || providerType;
    const defaultDescription = providerInfo?.defaultModel
      ? `Provider default — ${providerInfo.defaultModel}`
      : "Use the provider's configured default model";

    const options: ModelOption[] = [
      {
        label: '$(check) Use default model',
        description: defaultDescription,
        value: providerType,
      },
    ];

    for (const m of models) {
      const owner = m.owner ? ` [${m.owner}]` : '';
      const desc = m.description ? ` — ${m.description.slice(0, 60)}` : '';
      options.push({
        label: `🧠 ${m.name}`,
        description: `${m.id}${owner}${desc}`,
        value: providerType,
        model: m.id,
      });
    }

    const picked = await vscode.window.showQuickPick(options, {
      placeHolder: `Pick a model for ${providerLabel} (Esc keeps the default):`,
    });

    // Dismissing the picker (or picking the default option) keeps the default model
    return picked?.model;
  }

  /**
   * Run a health check for the active provider and show the report.
   */
  private async modelHealth(): Promise<void> {
    let provider: string | undefined;
    try {
      const active = await this.cliManager.getActiveModel();
      provider = active?.provider;
    } catch {
      provider = undefined;
    }

    try {
      const result = await this.cliManager.checkModelHealth(provider);
      const output = result.stdout || result.stderr || 'No health output.';

      const doc = await vscode.workspace.openTextDocument({
        content: output,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Health check failed: ${err.message || 'Unknown error'}`);
    }
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

    // Start streaming mode for real-time token display
    this.agentPanel.startStreaming();

    // Set up callbacks with streaming support
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
      onStreamChunk: (chunk: string, isCodeBlock: boolean) => {
        this.agentPanel.updateStreaming(chunk, isCodeBlock);
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

      // Signal streaming complete
      this.agentPanel.completeStreaming();

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
      this.agentPanel.completeStreaming();
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
