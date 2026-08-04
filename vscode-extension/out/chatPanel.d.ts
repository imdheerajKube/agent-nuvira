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
import { ChatHistoryProvider } from './chatProvider.js';
import { CLIManager } from './cliManager.js';
import type { ExtensionConfig } from './types.js';
export declare class ChatPanel {
    static readonly viewType = "agent-nuvira.chatPanel";
    private panel;
    private disposables;
    private historyProvider;
    private config;
    private cliManager;
    private onModelChanged?;
    private cliProcess;
    private abortController;
    private streamingMessageId;
    private workspaceRoot;
    private extensionUri;
    private loadedHtml;
    /** Monotonic token so stale model refreshes never clobber newer ones */
    private modelStateSeq;
    /** Track pipeline state for DAG visualization */
    private pipelineNodes;
    private pipelineActive;
    private pipelineName;
    private pipelineMessageId;
    private lastAgentType;
    constructor(context: vscode.ExtensionContext, historyProvider: ChatHistoryProvider, config: ExtensionConfig, cliManager: CLIManager);
    /**
     * Pre-load the HTML template from the extension directory.
     */
    private loadHtml;
    /**
     * Create or reveal the chat panel.
     */
    createOrShow(extensionUri: vscode.Uri): void;
    /**
     * Check if the panel is visible.
     */
    get isVisible(): boolean;
    /**
     * Update the extension config.
     */
    updateConfig(config: ExtensionConfig): void;
    /**
     * Swap the CLI manager when extension config changes
     * (so provider/model settings take effect immediately).
     */
    updateCliManager(cliManager: CLIManager): void;
    /**
     * Register a callback fired after a provider/model switch
     * (lets the extension refresh its status bar indicator).
     */
    setOnModelChanged(cb: () => void): void;
    private handleMessage;
    /**
     * Handle a user message: add to history, send to CLI, stream response.
     */
    private handleUserMessage;
    /**
     * Handle slash commands.
     */
    private handleSlashCommand;
    /**
     * Fetch the active provider/model and the available providers, then send
     * them to the webview so the header dropdown reflects the current state.
     */
    private refreshModelState;
    /**
     * Switch the active provider/model from the header dropdown
     * ('auto' enables Auto model routing), then refresh + notify.
     */
    private handleModelSwitch;
    /**
     * Reset the pipeline state for a new non-slash-command message.
     */
    private resetPipelineState;
    /**
     * Initialize the pipeline state for a slash command.
     * Sends the empty DAG container to the webview so it renders immediately.
     */
    private initPipelineState;
    /**
     * Detect agent pipeline events from a line of CLI output.
     * Returns whether a pipeline event was detected.
     */
    private detectPipelineEvent;
    /**
     * Build the current pipeline state and send it to the webview.
     */
    private sendDAGUpdate;
    /**
     * Build edges between pipeline nodes (sequential by default).
     */
    private buildEdges;
    /**
     * Finalize the pipeline state when streaming completes.
     */
    private finalizePipelineState;
    /**
     * Stream a response from the CLI to the chat panel.
     */
    private streamResponse;
    /**
     * Cancel the currently streaming response.
     */
    private cancelStreaming;
    /**
     * Apply a code block from the chat to a file.
     */
    private applyCodeBlock;
    /**
     * Get file context from the active editor.
     */
    private handleGetFileContext;
    /**
     * Get active file info for the webview.
     */
    private handleGetActiveFileInfo;
    /**
     * Open a file at a specific line.
     */
    private openFile;
    /**
     * Post a message to the webview.
     */
    private postMessage;
    /**
     * Send all sessions to the webview for the session list.
     */
    private refreshSessions;
    /**
     * Send all messages from the active session to the webview.
     */
    private sendSessionMessages;
    /**
     * Update the panel title based on the active session.
     */
    private updateTitle;
    /**
     * Get the help text for /help command.
     */
    private getHelpText;
    private dispose;
    private getWebviewContent;
}
//# sourceMappingURL=chatPanel.d.ts.map