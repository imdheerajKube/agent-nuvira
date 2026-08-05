/**
 * Chat Panel — A VS Code WebView panel providing a multi-turn chat interface
 * with Agent-Nuvira, featuring streaming responses, slash commands, file context,
 * code blocks with "Apply to File" buttons, conversation history,
 * and agent pipeline DAG visualization.
 *
 * Features:
 * - Multi-turn conversation with streaming LLM responses
 * - /fix, /review, /test, /explain, /workflow slash commands
 * - @file mentions for multi-file context
 * - Syntax-highlighted code blocks with "Apply to File" button
 * - Conversation history sidebar
 * - Session management (new, switch, delete)
 * - Agent pipeline visualization for multi-step commands — B6
 */

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatHistoryProvider, type ChatMessage, type ChatSession } from './chatProvider.js';
import { CLIManager } from './cliManager.js';
import type { ExtensionConfig, ProviderInfo } from './types.js';
import { renderDAG, renderEmptyDAG, buildPipelineState, type PipelineState, type PipelineNode } from './dagRenderer.js';

// ─── Pipeline Agent Event Patterns ─────────────────────────────────────────

/**
 * Patterns to detect agent pipeline events from CLI output.
 * Maps emoji prefixes to agent types for DAG visualization.
 */
const AGENT_PATTERNS: Array<{ pattern: RegExp; agentType: string; stage: 'start' | 'complete' | 'fail' }> = [
  { pattern: /^📋\s*(?:Planning|Plan)/i, agentType: 'planner', stage: 'start' },
  { pattern: /^📂\s*(?:Gathering|Context|Inspecting|Scanning)/i, agentType: 'context-gatherer', stage: 'start' },
  { pattern: /^✏️\s*(?:Writing|Editing|Creating|Generating|Implementing)/i, agentType: 'writer', stage: 'start' },
  { pattern: /^👁️\s*(?:Reviewing|Review)/i, agentType: 'reviewer', stage: 'start' },
  { pattern: /^🔍\s*(?:Checking|Verifying|Validating)/i, agentType: 'reviewer', stage: 'start' },
  { pattern: /^🧪\s*(?:Testing|Test)/i, agentType: 'tester', stage: 'start' },
  { pattern: /^🐛\s*(?:Debugging|Debug)/i, agentType: 'debugger', stage: 'start' },
  { pattern: /^▶️\s*(?:Running|Execute|Runner)/i, agentType: 'runner', stage: 'start' },
  { pattern: /^🔀\s*(?:Branching|Git)/i, agentType: 'git', stage: 'start' },
  { pattern: /^📦\s*(?:Packaging|Package)/i, agentType: 'package', stage: 'start' },
  { pattern: /^🏷️\s*(?:Release|GitHub)/i, agentType: 'github-release', stage: 'start' },
  { pattern: /^🔒\s*(?:Security)/i, agentType: 'security', stage: 'start' },
  { pattern: /^🎯\s*(?:Orchestrating|Orchestrator)/i, agentType: 'orchestrator', stage: 'start' },
  { pattern: /^(?:▶️\s*Running|🚀\s*Starting)/i, agentType: 'runner', stage: 'start' },
  // Completion / failure markers
  { pattern: /^✅\s*(?:Completed|Done|Finished|Succeeded)/i, agentType: '', stage: 'complete' },
  { pattern: /^❌\s*(?:Failed|Error|Aborted)/i, agentType: '', stage: 'fail' },
  // File change markers
  { pattern: /^📄\s+.+\(created|new\)/, agentType: 'writer', stage: 'complete' },
  { pattern: /^✏️\s+.+\(modified|updated\)/, agentType: 'writer', stage: 'complete' },
];

// ─── ChatPanel ──────────────────────────────────────────────────────────────

export class ChatPanel {
  public static readonly viewType = 'agent-nuvira.chatPanel';

  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  private historyProvider: ChatHistoryProvider;
  private config: ExtensionConfig;
  private cliManager: CLIManager;
  private onModelChanged?: () => void;
  private cliProcess: ChildProcess | null = null;
  private abortController: AbortController | null = null;
  private streamingMessageId: string | null = null;
  private workspaceRoot: string;
  private extensionUri: vscode.Uri;
  private loadedHtml: string | null = null;

  /** Monotonic token so stale model refreshes never clobber newer ones */
  private modelStateSeq = 0;

  /** Track pipeline state for DAG visualization */
  private pipelineNodes: PipelineNode[] = [];
  private pipelineActive = false;
  private pipelineName = '';
  private pipelineMessageId: string | null = null;
  private lastAgentType = '';

  constructor(
    context: vscode.ExtensionContext,
    historyProvider: ChatHistoryProvider,
    config: ExtensionConfig,
    cliManager: CLIManager,
  ) {
    this.historyProvider = historyProvider;
    this.config = config;
    this.cliManager = cliManager;
    this.extensionUri = context.extensionUri;
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd();
    this.loadHtml();
  }

  /**
   * Pre-load the HTML template from the extension directory.
   */
  private loadHtml(): void {
    try {
      // Try loading from src/ (development) or extension root (VSIX)
      const htmlUri = vscode.Uri.joinPath(this.extensionUri, 'src', 'chatPanel.html');
      const bytes = readFileSync(htmlUri.fsPath, 'utf-8');
      this.loadedHtml = bytes;
    } catch {
      try {
        // Fallback: try alongside the compiled JS
        const htmlPath = join(__dirname, 'chatPanel.html');
        this.loadedHtml = readFileSync(htmlPath, 'utf-8');
      } catch {
        this.loadedHtml = null;
      }
    }
  }

  /**
   * Create or reveal the chat panel.
   */
  createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : vscode.ViewColumn.Beside;

    if (this.panel) {
      this.panel.reveal(column);
      this.refreshSessions();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      'Agent-Nuvira Chat',
      column || vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'media'),
          vscode.Uri.joinPath(extensionUri, 'out'),
        ],
      },
    );

    this.panel.webview.html = this.getWebviewContent();

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables,
    );

    // Update title when session changes
    this.panel.onDidChangeViewState(() => {
      if (this.panel?.visible) {
        this.updateTitle();
      }
    });

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Send initial state
    this.refreshSessions();
    this.sendSessionMessages();
    void this.refreshModelState();
  }

  /**
   * Check if the panel is visible.
   */
  get isVisible(): boolean {
    return this.panel !== null && this.panel.visible;
  }

  /**
   * Update the extension config.
   */
  updateConfig(config: ExtensionConfig): void {
    this.config = config;
  }

  /**
   * Swap the CLI manager when extension config changes
   * (so provider/model settings take effect immediately).
   */
  updateCliManager(cliManager: CLIManager): void {
    this.cliManager = cliManager;
    void this.refreshModelState();
  }

  /**
   * Register a callback fired after a provider/model switch
   * (lets the extension refresh its status bar indicator).
   */
  setOnModelChanged(cb: () => void): void {
    this.onModelChanged = cb;
  }

  // ── Message Handlers ─────────────────────────────────────────────────────

  private async handleMessage(message: any): Promise<void> {
    switch (message.type) {
      case 'sendMessage':
        await this.handleUserMessage(message.text, message.fileContext);
        break;

      case 'cancelStreaming':
        this.cancelStreaming();
        break;

      case 'applyCodeBlock':
        await this.applyCodeBlock(message.code, message.language, message.filePath);
        break;

      case 'createSession':
        this.historyProvider.createSession();
        this.refreshSessions();
        this.sendSessionMessages();
        this.postMessage({ type: 'sessionCreated', sessionId: this.historyProvider.getActiveSessionId() });
        break;

      case 'switchSession':
        this.historyProvider.switchSession(message.sessionId);
        this.refreshSessions();
        this.sendSessionMessages();
        break;

      case 'deleteSession':
        this.historyProvider.deleteSession(message.sessionId);
        this.refreshSessions();
        this.sendSessionMessages();
        break;

      case 'getFileContext':
        await this.handleGetFileContext();
        break;

      case 'getActiveFileInfo':
        await this.handleGetActiveFileInfo();
        break;

      case 'deleteAllSessions':
        this.historyProvider.clearAllSessions();
        this.historyProvider.createSession();
        this.refreshSessions();
        this.sendSessionMessages();
        break;

      case 'requestInitialState':
        this.refreshSessions();
        this.sendSessionMessages();
        await this.refreshModelState();
        break;

      case 'switchModel':
        await this.handleModelSwitch(message.value);
        break;

      case 'openFile':
        await this.openFile(message.path, message.line);
        break;

      default:
        break;
    }
  }

  /**
   * Handle a user message: add to history, send to CLI, stream response.
   */
  private async handleUserMessage(
    text: string,
    fileContext?: { uri: string; language: string; content: string }[],
  ): Promise<void> {
    // Ensure there's an active session
    if (!this.historyProvider.getActiveSessionId()) {
      this.historyProvider.createSession();
      this.refreshSessions();
    }

    // Handle slash commands
    if (text.startsWith('/')) {
      await this.handleSlashCommand(text, fileContext);
      return;
    }

    // Add user message to history
    const userMsg = this.historyProvider.addMessage({
      role: 'user',
      content: text,
      fileContext,
    });

    if (!userMsg) return;

    // Render user message
    this.postMessage({
      type: 'addMessage',
      message: userMsg,
    });

    // Update session list (title may have changed)
    this.refreshSessions();

    // Reset pipeline state
    this.resetPipelineState();

    // Start streaming response
    await this.streamResponse(text, fileContext);
  }

  /**
   * Handle slash commands.
   */
  private async handleSlashCommand(
    text: string,
    fileContext?: { uri: string; language: string; content: string }[],
  ): Promise<void> {
    const [command, ...args] = text.split(' ');
    const goal = args.join(' ');
    const activeFile = vscode.window.activeTextEditor?.document;

    let prompt: string;
    let phaseLabel: string;

    switch (command.toLowerCase()) {
      case '/fix':
        prompt = goal
          ? `Fix any issues in the following code. Describe what was wrong and how you fixed it.\n\nContext: ${goal}`
          : `Review and fix any issues in the current file`;
        phaseLabel = '🔧 Fixing';
        break;

      case '/review':
        prompt = `Perform a thorough code review of the following. Check for bugs, security vulnerabilities, performance issues, and style problems. Provide a structured report.\n\n${goal ? `Context: ${goal}` : 'Review the current codebase context.'}`;
        phaseLabel = '🔍 Reviewing';
        break;

      case '/test':
        prompt = `Generate comprehensive unit tests with edge cases for the following:\n\n${goal || 'the current file'}`;
        phaseLabel = '🧪 Testing';
        break;

      case '/explain':
        prompt = `Explain the following code in detail, covering what it does, how it works, and any important patterns or gotchas:\n\n${goal || 'the current selection'}`;
        phaseLabel = '📖 Explaining';
        break;

      case '/workflow':
        prompt = `Run the following workflow. Describe the plan, execute the steps, and summarize the results:\n\n${goal || 'Run a standard development workflow'}`;
        phaseLabel = '🔄 Workflow';
        break;

      case '/help':
        const helpText = this.getHelpText();
        const helpMsg = this.historyProvider.addMessage({
          role: 'assistant',
          content: helpText,
        });
        if (helpMsg) {
          this.postMessage({ type: 'addMessage', message: helpMsg });
        }
        return;

      default:
        // Unknown command — treat as regular message
        const userMsg = this.historyProvider.addMessage({
          role: 'user',
          content: text,
          fileContext,
        });
        if (userMsg) {
          this.postMessage({ type: 'addMessage', message: userMsg });
        }
        this.resetPipelineState();
        await this.streamResponse(text, fileContext);
        return;
    }

    // Add user message showing the command
    const cmdMsg = this.historyProvider.addMessage({
      role: 'user',
      content: `${phaseLabel}: ${goal || 'Current file'}`,
    });
    if (cmdMsg) {
      this.postMessage({ type: 'addMessage', message: cmdMsg });
    }

    // Initialize pipeline state for DAG visualization
    this.initPipelineState(phaseLabel);

    // Add file context if available
    let fullPrompt = prompt;
    if (fileContext && fileContext.length > 0) {
      const contextStr = fileContext
        .map((f) => `\`\`\`${f.language}:${f.uri}\n${f.content}\n\`\`\``)
        .join('\n\n');
      fullPrompt = `${prompt}\n\n**File Context:**\n${contextStr}`;
    } else if (activeFile) {
      const content = activeFile.getText();
      const language = activeFile.languageId;
      fullPrompt = `${prompt}\n\n**Active File:**\n\`\`\`${language}:${activeFile.fileName}\n${content.slice(0, 5000)}\n\`\`\``;
    }

    await this.streamResponse(fullPrompt);
  }

  // ── Model Switcher ───────────────────────────────────────────────────────

  /**
   * Fetch the active provider/model and the available providers, then send
   * them to the webview so the header dropdown reflects the current state.
   */
  private async refreshModelState(): Promise<void> {
    if (!this.panel) return;

    // Drop this response if a newer refresh was started while we were awaiting
    const seq = ++this.modelStateSeq;

    let providers: ProviderInfo[] = [];
    try {
      providers = await this.cliManager.listModels();
    } catch {
      providers = [];
    }

    let active: { provider: string; model: string } | null = null;
    try {
      const activeModel = await this.cliManager.getActiveModel();
      if (activeModel) {
        active = { provider: activeModel.provider, model: activeModel.model };
      }
    } catch {
      active = null;
    }

    if (seq !== this.modelStateSeq) return; // stale — a newer refresh won

    this.postMessage({
      type: 'modelState',
      providers,
      active,
    });
  }

  /**
   * Switch the active provider/model from the header dropdown
   * ('auto' enables Auto model routing), then refresh + notify.
   */
  private async handleModelSwitch(value: string): Promise<void> {
    try {
      const result = await this.cliManager.switchModel(value);
      if (result.success) {
        this.onModelChanged?.();
        vscode.window.showInformationMessage(
          value === 'auto' ? '🤖 Auto routing enabled' : `✅ Switched to ${value}`,
        );
      } else {
        vscode.window.showErrorMessage(`Switch failed: ${result.stderr || 'Unknown error'}`);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Switch failed: ${err.message || 'Unknown error'}`);
    } finally {
      // Re-fetch so the dropdown reflects the (possibly unchanged) state
      await this.refreshModelState();
    }
  }

  // ── Pipeline DAG Visualization ────────────────────────────────────────────

  /**
   * Reset the pipeline state for a new non-slash-command message.
   */
  private resetPipelineState(): void {
    this.pipelineNodes = [];
    this.pipelineActive = false;
    this.pipelineName = '';
    this.pipelineMessageId = null;
    this.lastAgentType = '';
  }

  /**
   * Initialize the pipeline state for a slash command.
   * Sends the empty DAG container to the webview so it renders immediately.
   */
  private initPipelineState(pipelineName: string): void {
    this.resetPipelineState();
    this.pipelineName = pipelineName.replace(/[🔧🔍🧪📖🔄]\s*/, '').trim() || 'Pipeline';
    this.pipelineActive = true;

    // Create the DAG message in the assistant bubble
    // We'll send a dagUpdate immediately with the empty state
    this.sendDAGUpdate();
  }

  /**
   * Detect agent pipeline events from a line of CLI output.
   * Returns whether a pipeline event was detected.
   */
  private detectPipelineEvent(line: string, currentMs: number): boolean {
    // Strip ANSI and trim
    const cleanLine = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
    if (!cleanLine) return false;

    for (const p of AGENT_PATTERNS) {
      const match = cleanLine.match(p.pattern);
      if (!match) continue;

      if (p.stage === 'start' && p.agentType) {
        // Agent starting
        this.lastAgentType = p.agentType;
        const existing = this.pipelineNodes.find((n) => n.agentType === p.agentType && n.status === 'pending');
        if (existing) {
          existing.status = 'running';
          existing.startedAt = currentMs;
        } else {
          this.pipelineNodes.push({
            id: `agent-${this.pipelineNodes.length}`,
            agentType: p.agentType,
            status: 'running',
            description: cleanLine.replace(/^[^\s]+\s*/, '').slice(0, 40) || p.agentType,
            startedAt: currentMs,
          });
        }
        this.pipelineActive = true;
        this.sendDAGUpdate();
        return true;
      }

      if (p.stage === 'complete' || p.stage === 'fail') {
        // Mark the last running agent as complete/failed
        const running = this.pipelineNodes.find((n) => n.status === 'running');
        if (running) {
          running.status = p.stage === 'complete' ? 'completed' : 'failed';
          running.completedAt = currentMs;
          running.summary = cleanLine.slice(0, 60);
        }
        this.sendDAGUpdate();
        return true;
      }

      break;
    }

    // Also detect if the current running agent has a progress line
    const runningNode = this.pipelineNodes.find((n) => n.status === 'running');
    if (runningNode && cleanLine.includes(runningNode.agentType) && !cleanLine.match(/^```/)) {
      runningNode.description = cleanLine.replace(/^[^\s]+\s*/, '').slice(0, 40) || runningNode.agentType;
      return false; // Don't force re-render on every update
    }

    return false;
  }

  /**
   * Build the current pipeline state and send it to the webview.
   */
  private sendDAGUpdate(): void {
    const state: PipelineState = {
      pipeline: this.pipelineName,
      active: this.pipelineActive,
      nodes: [...this.pipelineNodes],
      edges: this.buildEdges(),
    };

    const dagHtml = state.nodes.length === 0
      ? renderEmptyDAG()
      : renderDAG(state);

    this.postMessage({
      type: 'dagUpdate',
      pipelineMessageId: this.pipelineMessageId,
      html: dagHtml,
    });
  }

  /**
   * Build edges between pipeline nodes (sequential by default).
   */
  private buildEdges(): Array<{ from: string; to: string }> {
    const edges: Array<{ from: string; to: string }> = [];
    for (let i = 0; i < this.pipelineNodes.length - 1; i++) {
      edges.push({ from: this.pipelineNodes[i].id, to: this.pipelineNodes[i + 1].id });
    }
    return edges;
  }

  /**
   * Finalize the pipeline state when streaming completes.
   */
  private finalizePipelineState(): void {
    this.pipelineActive = false;
    const now = Date.now();

    // Mark any remaining running/pending nodes as completed
    for (const node of this.pipelineNodes) {
      if (node.status === 'running' || node.status === 'pending') {
        node.status = 'completed';
        node.completedAt = now;
      }
    }

    this.sendDAGUpdate();
  }

  // ── Streaming ─────────────────────────────────────────────────────────────

  /**
   * Stream a response from the CLI to the chat panel.
   */
  private async streamResponse(
    prompt: string,
    fileContext?: { uri: string; language: string; content: string }[],
  ): Promise<void> {
    // Create a placeholder message for the response
    const assistantMsg = this.historyProvider.addMessage({
      role: 'assistant',
      content: '',
      streaming: true,
    });

    if (!assistantMsg) return;

    this.streamingMessageId = assistantMsg.id;
    this.pipelineMessageId = assistantMsg.id;

    // Send initial message with DAG container placeholder
    this.postMessage({
      type: 'addMessage',
      message: { ...assistantMsg, content: '▊', pipelineMessageId: this.pipelineMessageId },
    });

    // Build CLI arguments
    const args = ['chat', prompt, '--stream', '--no-color'];

    if (this.config.useAutoRouting) {
      // Auto model routing — the agent picks the best provider/model per task
      args.push('--model', 'auto');
    } else {
      if (this.config.defaultProvider) {
        args.push('--provider', this.config.defaultProvider);
      }
      if (this.config.defaultModel) {
        args.push('--model', this.config.defaultModel);
      }
    }

    // Add file context as extra arguments
    if (fileContext?.length) {
      for (const file of fileContext) {
        args.push('--file', file.uri);
      }
    }

    const cliCmd = this.config.cliPath || 'agent-nuvira';

    try {
      this.abortController = new AbortController();
      this.cliProcess = spawn(cliCmd, args, {
        cwd: this.workspaceRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: this.abortController.signal,
        // BUFF_TELEMETRY_ACTION: the CLI writes every real LLM call through to
        // the Model Availability Registry's "learned from real usage" log with
        // this tag, so IDE chat usage shows up as `ide-chat` in the dashboard
        // instead of blending into terminal-driven chat telemetry.
        env: { ...process.env, FORCE_COLOR: '0', BUFF_TELEMETRY_ACTION: 'ide-chat' },
      });

      let fullContent = '';
      let buffer = '';

      // Stream response
      this.cliProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        buffer += text;
        fullContent += text;

        // Process lines for streaming updates and DAG events
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim()) {
            // Detect pipeline events for DAG visualization
            this.detectPipelineEvent(line, Date.now());

            // Detect code blocks and phase markers
            const isCodeBlock = line.includes('```');
            const isPhase = line.match(/^[📋📂✏️🔍🧪📦🏗️📝🔄✅❌]\s+/);

            this.postMessage({
              type: 'streamChunk',
              messageId: assistantMsg.id,
              chunk: line + '\n',
              isCodeBlock,
              isPhase,
            });
          }
        }

        // Update stored message content periodically
        this.historyProvider.updateMessage(assistantMsg.id, {
          content: fullContent,
        });
      });

      // Handle stderr
      this.cliProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        if (text.includes('error') || text.includes('Error')) {
          this.postMessage({
            type: 'streamChunk',
            messageId: assistantMsg.id,
            chunk: `\n⚠️ ${text.trim()}\n`,
          });
        }
      });

      // Handle process exit
      await new Promise<void>((resolve, reject) => {
        this.cliProcess?.on('close', (exitCode) => {
          if (exitCode !== 0 && exitCode !== null) {
            // Non-zero exit — append error info
            const errorSuffix = `\n\n⚠️ Process exited with code ${exitCode}`;
            fullContent += errorSuffix;
          }
          resolve();
        });

        this.cliProcess?.on('error', (err) => {
          if (err.name === 'AbortError') {
            fullContent += '\n\n_✋ Generation cancelled._';
          } else {
            fullContent += `\n\n⚠️ Error: ${err.message}`;
          }
          resolve();
        });

        // Timeout after 5 minutes
        setTimeout(() => {
          if (this.cliProcess && !this.cliProcess.killed) {
            this.cliProcess.kill('SIGTERM');
            fullContent += '\n\n_⏱️ Response timed out._';
            resolve();
          }
        }, 300_000);
      });

      // Finalize pipeline state
      this.finalizePipelineState();

      // Finalize message
      this.historyProvider.updateMessage(assistantMsg.id, {
        content: fullContent,
        streaming: false,
      });

      this.postMessage({
        type: 'streamComplete',
        messageId: assistantMsg.id,
        content: fullContent,
        pipelineMessageId: this.pipelineMessageId,
      });

      this.streamingMessageId = null;
      this.cliProcess = null;

    } catch (err: any) {
      if (err.name === 'AbortError') {
        this.historyProvider.updateMessage(assistantMsg.id, {
          content: '\n\n_✋ Generation cancelled._',
          streaming: false,
        });
      } else {
        this.historyProvider.updateMessage(assistantMsg.id, {
          content: `\n\n⚠️ Error: ${err.message}`,
          streaming: false,
        });
      }

      this.postMessage({
        type: 'streamComplete',
        messageId: assistantMsg.id,
        content: this.historyProvider.getSession(
          this.historyProvider.getActiveSessionId() || '',
        )?.messages.find((m) => m.id === assistantMsg.id)?.content || '',
      });

      this.streamingMessageId = null;
      this.cliProcess = null;
    }
  }

  /**
   * Cancel the currently streaming response.
   */
  private cancelStreaming(): void {
    if (this.cliProcess && !this.cliProcess.killed) {
      this.cliProcess.kill('SIGTERM');
      setTimeout(() => {
        if (this.cliProcess && !this.cliProcess.killed) {
          this.cliProcess.kill('SIGKILL');
        }
      }, 3000);
    }
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Apply a code block from the chat to a file.
   */
  private async applyCodeBlock(
    code: string,
    language: string,
    filePath?: string,
  ): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;

    if (filePath && workspaceRoot) {
      // User specified a file path — apply directly
      const fullPath = filePath.startsWith('/')
        ? filePath
        : workspaceRoot + '/' + filePath;

      try {
        const uri = vscode.Uri.file(fullPath);
        const edit = new vscode.WorkspaceEdit();

        // Read existing file or create new
        let existingContent = '';
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          existingContent = doc.getText();
        } catch {
          // File doesn't exist — will create it
        }

        const fullRange = new vscode.Range(0, 0, existingContent.split('\n').length, 0);
        edit.replace(uri, fullRange, code);

        const applied = await vscode.workspace.applyEdit(edit);
        if (applied) {
          vscode.window.showInformationMessage(`✅ Applied code to ${filePath}`);
          // Reveal the file
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc);
        } else {
          vscode.window.showErrorMessage('Failed to apply code to file.');
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Error applying code: ${err.message}`);
      }
      return;
    }

    // No file path — show prompt to create new or apply to active
    const action = await vscode.window.showQuickPick(
      [
        { label: '📄 Apply to New File', description: 'Create a new file with this code' },
        { label: '📝 Apply to Active Editor', description: 'Replace active editor content' },
      ],
      { placeHolder: 'How would you like to apply this code?' },
    );

    if (!action) return;

    if (action.label.includes('New File')) {
      // Create a new untitled file
      const doc = await vscode.workspace.openTextDocument({
        content: code,
        language,
      });
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage('✅ New file created with code. Save it to persist.');
    } else {
      // Apply to active editor
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor to apply code to.');
        return;
      }

      const edit = new vscode.WorkspaceEdit();
      const doc = editor.document;
      const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
      edit.replace(doc.uri, fullRange, code);
      const applied = await vscode.workspace.applyEdit(edit);

      if (applied) {
        vscode.window.showInformationMessage('✅ Code applied to active editor.');
      } else {
        vscode.window.showErrorMessage('Failed to apply code to editor.');
      }
    }
  }

  /**
   * Get file context from the active editor.
   */
  private async handleGetFileContext(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.postMessage({ type: 'fileContext', context: null });
      return;
    }

    const doc = editor.document;
    const selection = editor.selection;
    let content: string;

    if (selection.isEmpty) {
      content = doc.getText();
    } else {
      content = doc.getText(selection);
    }

    // Truncate if too large
    const maxLen = 8000;
    if (content.length > maxLen) {
      content = content.slice(0, maxLen) + '\n// ... (truncated)';
    }

    this.postMessage({
      type: 'fileContext',
      context: {
        uri: doc.uri.fsPath,
        language: doc.languageId,
        content,
        fileName: doc.fileName.split('/').pop() || 'unknown',
      },
    });
  }

  /**
   * Get active file info for the webview.
   */
  private async handleGetActiveFileInfo(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.postMessage({ type: 'activeFileInfo', info: null });
      return;
    }

    this.postMessage({
      type: 'activeFileInfo',
      info: {
        fileName: editor.document.fileName.split('/').pop() || 'unknown',
        language: editor.document.languageId,
        path: editor.document.uri.fsPath,
        hasSelection: !editor.selection.isEmpty,
      },
    });
  }

  /**
   * Open a file at a specific line.
   */
  private async openFile(path: string, line?: number): Promise<void> {
    try {
      const uri = vscode.Uri.file(path);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);

      if (line !== undefined) {
        const position = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.AtTop,
        );
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Cannot open file: ${err.message}`);
    }
  }

  // ── Webview Communication ─────────────────────────────────────────────────

  /**
   * Post a message to the webview.
   */
  private postMessage(message: any): void {
    this.panel?.webview.postMessage(message);
  }

  /**
   * Send all sessions to the webview for the session list.
   */
  private refreshSessions(): void {
    const sessions = this.historyProvider.getSessions().map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages.length,
    }));

    this.postMessage({
      type: 'sessionList',
      sessions,
      activeId: this.historyProvider.getActiveSessionId(),
    });

    this.updateTitle();
  }

  /**
   * Send all messages from the active session to the webview.
   */
  private sendSessionMessages(): void {
    const session = this.historyProvider.getActiveSession();
    if (!session) return;

    this.postMessage({
      type: 'sessionMessages',
      messages: session.messages,
    });

    this.updateTitle();
  }

  /**
   * Update the panel title based on the active session.
   */
  private updateTitle(): void {
    const session = this.historyProvider.getActiveSession();
    if (this.panel) {
      this.panel.title = session
        ? `💬 ${session.title.slice(0, 30)}${session.title.length > 30 ? '…' : ''}`
        : '💬 Agent-Nuvira Chat';
    }
  }

  /**
   * Get the help text for /help command.
   */
  private getHelpText(): string {
    return `## 🤖 Agent-Nuvira Chat — Help

### Slash Commands

| Command | Description |
|---------|-------------|
| \`/fix\` | Fix issues in code |
| \`/review\` | Code review with structured report |
| \`/test\` | Generate unit tests |
| \`/explain\` | Explain code in detail |
| \`/workflow\` | Run a multi-step agent workflow |
| \`/help\` | Show this help message |

### Usage Tips

- **@file** — Mention files to include them as context: \`@file:src/app.ts\`
- **Select code** in the editor, then type your question
- **Code blocks** in responses have an "Apply" button
- **Slash commands** trigger multi-agent pipelines with live DAG visualization
- **Pipeline DAG** shows real-time agent progress (planning → context → writing → reviewing)

### Keybindings

- \`Ctrl+Shift+A C\` — Open this chat panel
- \`Ctrl+Shift+A E\` — Execute a goal (quick input)
- \`Ctrl+Shift+A Q\` — Quick fix current file
- \`Ctrl+Shift+A R\` — Review current file

### Examples

\`\`\`
/fix Add error handling to this function
/review Check this module for security issues
/test Generate tests for the user service
/explain What does this reducer do?
/workflow Set up CI/CD pipeline
\`\`\`
`;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  private dispose(): void {
    this.cancelStreaming();
    this.panel = null;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }

  // ── Webview HTML ──────────────────────────────────────────────────────────

  private getWebviewContent(): string {
    return this.loadedHtml || '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><style>body{background:#1e1e1e;color:#ccc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;padding:40px;text-align:center;line-height:1.6}</style></head><body><p>Chat panel template not found.<br>Try rebuilding the extension with <code>npm run compile</code>.</p></body></html>';
  }
}
