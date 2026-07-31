"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatPanel = void 0;
const vscode = __importStar(require("vscode"));
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const dagRenderer_js_1 = require("./dagRenderer.js");
// ─── Pipeline Agent Event Patterns ─────────────────────────────────────────
/**
 * Patterns to detect agent pipeline events from CLI output.
 * Maps emoji prefixes to agent types for DAG visualization.
 */
const AGENT_PATTERNS = [
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
class ChatPanel {
    static viewType = 'agent-nuvira.chatPanel';
    panel = null;
    disposables = [];
    historyProvider;
    config;
    cliProcess = null;
    abortController = null;
    streamingMessageId = null;
    workspaceRoot;
    extensionUri;
    loadedHtml = null;
    /** Track pipeline state for DAG visualization */
    pipelineNodes = [];
    pipelineActive = false;
    pipelineName = '';
    pipelineMessageId = null;
    lastAgentType = '';
    constructor(context, historyProvider, config) {
        this.historyProvider = historyProvider;
        this.config = config;
        this.extensionUri = context.extensionUri;
        this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd();
        this.loadHtml();
    }
    /**
     * Pre-load the HTML template from the extension directory.
     */
    loadHtml() {
        try {
            // Try loading from src/ (development) or extension root (VSIX)
            const htmlUri = vscode.Uri.joinPath(this.extensionUri, 'src', 'chatPanel.html');
            const bytes = (0, node_fs_1.readFileSync)(htmlUri.fsPath, 'utf-8');
            this.loadedHtml = bytes;
        }
        catch {
            try {
                // Fallback: try alongside the compiled JS
                const htmlPath = (0, node_path_1.join)(__dirname, 'chatPanel.html');
                this.loadedHtml = (0, node_fs_1.readFileSync)(htmlPath, 'utf-8');
            }
            catch {
                this.loadedHtml = null;
            }
        }
    }
    /**
     * Create or reveal the chat panel.
     */
    createOrShow(extensionUri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : vscode.ViewColumn.Beside;
        if (this.panel) {
            this.panel.reveal(column);
            this.refreshSessions();
            return;
        }
        this.panel = vscode.window.createWebviewPanel(ChatPanel.viewType, 'Agent-Nuvira Chat', column || vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extensionUri, 'media'),
                vscode.Uri.joinPath(extensionUri, 'out'),
            ],
        });
        this.panel.webview.html = this.getWebviewContent();
        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message), null, this.disposables);
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
    }
    /**
     * Check if the panel is visible.
     */
    get isVisible() {
        return this.panel !== null && this.panel.visible;
    }
    /**
     * Update the extension config.
     */
    updateConfig(config) {
        this.config = config;
    }
    // ── Message Handlers ─────────────────────────────────────────────────────
    async handleMessage(message) {
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
    async handleUserMessage(text, fileContext) {
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
        if (!userMsg)
            return;
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
    async handleSlashCommand(text, fileContext) {
        const [command, ...args] = text.split(' ');
        const goal = args.join(' ');
        const activeFile = vscode.window.activeTextEditor?.document;
        let prompt;
        let phaseLabel;
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
        }
        else if (activeFile) {
            const content = activeFile.getText();
            const language = activeFile.languageId;
            fullPrompt = `${prompt}\n\n**Active File:**\n\`\`\`${language}:${activeFile.fileName}\n${content.slice(0, 5000)}\n\`\`\``;
        }
        await this.streamResponse(fullPrompt);
    }
    // ── Pipeline DAG Visualization ────────────────────────────────────────────
    /**
     * Reset the pipeline state for a new non-slash-command message.
     */
    resetPipelineState() {
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
    initPipelineState(pipelineName) {
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
    detectPipelineEvent(line, currentMs) {
        // Strip ANSI and trim
        const cleanLine = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
        if (!cleanLine)
            return false;
        for (const p of AGENT_PATTERNS) {
            const match = cleanLine.match(p.pattern);
            if (!match)
                continue;
            if (p.stage === 'start' && p.agentType) {
                // Agent starting
                this.lastAgentType = p.agentType;
                const existing = this.pipelineNodes.find((n) => n.agentType === p.agentType && n.status === 'pending');
                if (existing) {
                    existing.status = 'running';
                    existing.startedAt = currentMs;
                }
                else {
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
    sendDAGUpdate() {
        const state = {
            pipeline: this.pipelineName,
            active: this.pipelineActive,
            nodes: [...this.pipelineNodes],
            edges: this.buildEdges(),
        };
        const dagHtml = state.nodes.length === 0
            ? (0, dagRenderer_js_1.renderEmptyDAG)()
            : (0, dagRenderer_js_1.renderDAG)(state);
        this.postMessage({
            type: 'dagUpdate',
            pipelineMessageId: this.pipelineMessageId,
            html: dagHtml,
        });
    }
    /**
     * Build edges between pipeline nodes (sequential by default).
     */
    buildEdges() {
        const edges = [];
        for (let i = 0; i < this.pipelineNodes.length - 1; i++) {
            edges.push({ from: this.pipelineNodes[i].id, to: this.pipelineNodes[i + 1].id });
        }
        return edges;
    }
    /**
     * Finalize the pipeline state when streaming completes.
     */
    finalizePipelineState() {
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
    async streamResponse(prompt, fileContext) {
        // Create a placeholder message for the response
        const assistantMsg = this.historyProvider.addMessage({
            role: 'assistant',
            content: '',
            streaming: true,
        });
        if (!assistantMsg)
            return;
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
        }
        else {
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
            this.cliProcess = (0, node_child_process_1.spawn)(cliCmd, args, {
                cwd: this.workspaceRoot,
                stdio: ['pipe', 'pipe', 'pipe'],
                signal: this.abortController.signal,
                env: { ...process.env, FORCE_COLOR: '0' },
            });
            let fullContent = '';
            let buffer = '';
            // Stream response
            this.cliProcess.stdout?.on('data', (data) => {
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
            this.cliProcess.stderr?.on('data', (data) => {
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
            await new Promise((resolve, reject) => {
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
                    }
                    else {
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
        }
        catch (err) {
            if (err.name === 'AbortError') {
                this.historyProvider.updateMessage(assistantMsg.id, {
                    content: '\n\n_✋ Generation cancelled._',
                    streaming: false,
                });
            }
            else {
                this.historyProvider.updateMessage(assistantMsg.id, {
                    content: `\n\n⚠️ Error: ${err.message}`,
                    streaming: false,
                });
            }
            this.postMessage({
                type: 'streamComplete',
                messageId: assistantMsg.id,
                content: this.historyProvider.getSession(this.historyProvider.getActiveSessionId() || '')?.messages.find((m) => m.id === assistantMsg.id)?.content || '',
            });
            this.streamingMessageId = null;
            this.cliProcess = null;
        }
    }
    /**
     * Cancel the currently streaming response.
     */
    cancelStreaming() {
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
    async applyCodeBlock(code, language, filePath) {
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
                }
                catch {
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
                }
                else {
                    vscode.window.showErrorMessage('Failed to apply code to file.');
                }
            }
            catch (err) {
                vscode.window.showErrorMessage(`Error applying code: ${err.message}`);
            }
            return;
        }
        // No file path — show prompt to create new or apply to active
        const action = await vscode.window.showQuickPick([
            { label: '📄 Apply to New File', description: 'Create a new file with this code' },
            { label: '📝 Apply to Active Editor', description: 'Replace active editor content' },
        ], { placeHolder: 'How would you like to apply this code?' });
        if (!action)
            return;
        if (action.label.includes('New File')) {
            // Create a new untitled file
            const doc = await vscode.workspace.openTextDocument({
                content: code,
                language,
            });
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage('✅ New file created with code. Save it to persist.');
        }
        else {
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
            }
            else {
                vscode.window.showErrorMessage('Failed to apply code to editor.');
            }
        }
    }
    /**
     * Get file context from the active editor.
     */
    async handleGetFileContext() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            this.postMessage({ type: 'fileContext', context: null });
            return;
        }
        const doc = editor.document;
        const selection = editor.selection;
        let content;
        if (selection.isEmpty) {
            content = doc.getText();
        }
        else {
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
    async handleGetActiveFileInfo() {
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
    async openFile(path, line) {
        try {
            const uri = vscode.Uri.file(path);
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc);
            if (line !== undefined) {
                const position = new vscode.Position(Math.max(0, line - 1), 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop);
            }
        }
        catch (err) {
            vscode.window.showErrorMessage(`Cannot open file: ${err.message}`);
        }
    }
    // ── Webview Communication ─────────────────────────────────────────────────
    /**
     * Post a message to the webview.
     */
    postMessage(message) {
        this.panel?.webview.postMessage(message);
    }
    /**
     * Send all sessions to the webview for the session list.
     */
    refreshSessions() {
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
    sendSessionMessages() {
        const session = this.historyProvider.getActiveSession();
        if (!session)
            return;
        this.postMessage({
            type: 'sessionMessages',
            messages: session.messages,
        });
        this.updateTitle();
    }
    /**
     * Update the panel title based on the active session.
     */
    updateTitle() {
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
    getHelpText() {
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
    dispose() {
        this.cancelStreaming();
        this.panel = null;
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }
    // ── Webview HTML ──────────────────────────────────────────────────────────
    getWebviewContent() {
        return this.loadedHtml || '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><style>body{background:#1e1e1e;color:#ccc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;padding:40px;text-align:center;line-height:1.6}</style></head><body><p>Chat panel template not found.<br>Try rebuilding the extension with <code>npm run compile</code>.</p></body></html>';
    }
}
exports.ChatPanel = ChatPanel;
//# sourceMappingURL=chatPanel.js.map