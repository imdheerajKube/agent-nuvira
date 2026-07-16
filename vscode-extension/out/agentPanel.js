"use strict";
/**
 * Agent Panel — A VS Code WebView panel that displays real-time
 * agent execution progress, logs, diffs, and results.
 *
 * Features:
 * - Real-time progress updates with phase indicators
 * - Expandable log viewer
 * - File changes list with accept/reject controls
 * - Inline diff preview
 * - Status bar updates
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
exports.AgentPanel = void 0;
const vscode = __importStar(require("vscode"));
// ─── AgentPanel ─────────────────────────────────────────────────────────────
class AgentPanel {
    static viewType = 'agent-baba-d.agentProgress';
    panel = null;
    disposables = [];
    currentResult = null;
    onAcceptChanges;
    onRejectChanges;
    onCancelTask;
    /**
     * Create or reveal the agent progress panel.
     */
    createOrShow(extensionUri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : vscode.ViewColumn.Beside;
        if (this.panel) {
            this.panel.reveal(column);
            return;
        }
        // Create a new panel
        this.panel = vscode.window.createWebviewPanel(AgentPanel.viewType, 'Agent-Baba-D Progress', column || vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        });
        // Set initial HTML
        this.panel.webview.html = this.getWebviewContent();
        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message), null, this.disposables);
        // Clean up on dispose
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }
    /**
     * Set callbacks for webview actions.
     */
    setCallbacks(opts) {
        this.onAcceptChanges = opts.onAcceptChanges;
        this.onRejectChanges = opts.onRejectChanges;
        this.onCancelTask = opts.onCancelTask;
    }
    /**
     * Update the progress display with the latest state.
     */
    updateProgress(progress) {
        if (!this.panel)
            return;
        const message = {
            type: 'progress',
            payload: progress,
        };
        this.panel.webview.postMessage(message);
    }
    /**
     * Show the final result of an agent task.
     */
    showResult(result) {
        this.currentResult = result;
        if (!this.panel)
            return;
        const message = {
            type: 'result',
            payload: result,
        };
        this.panel.webview.postMessage(message);
        // Also show in VS Code notification
        if (result.success) {
            const numChanges = result.changes.length;
            vscode.window.showInformationMessage(`✅ Agent completed: ${result.summary.slice(0, 100)}${numChanges > 0 ? ` (${numChanges} file change${numChanges !== 1 ? 's' : ''})` : ''}`);
        }
        else {
            vscode.window.showErrorMessage(`❌ Agent task failed: ${result.error || 'Unknown error'}`);
        }
        // Scroll to result
        if (this.panel) {
            this.panel.reveal();
        }
    }
    /**
     * Show an error message in the panel.
     */
    showError(error) {
        if (!this.panel)
            return;
        const message = {
            type: 'error',
            payload: { error },
        };
        this.panel.webview.postMessage(message);
        vscode.window.showErrorMessage(`Agent error: ${error}`);
    }
    /**
     * Update the status message.
     */
    updateStatus(status) {
        if (!this.panel)
            return;
        const message = {
            type: 'status',
            payload: { status },
        };
        this.panel.webview.postMessage(message);
    }
    /**
     * Show file diffs for proposed changes.
     */
    showDiffs(changes) {
        if (!this.panel)
            return;
        const message = {
            type: 'diff',
            payload: { changes },
        };
        this.panel.webview.postMessage(message);
    }
    /**
     * Reset the panel to its initial state.
     */
    clear() {
        this.currentResult = null;
        if (!this.panel)
            return;
        const message = { type: 'clear' };
        this.panel.webview.postMessage(message);
    }
    /**
     * Check if the panel is visible.
     */
    get isVisible() {
        return this.panel !== null && this.panel.visible;
    }
    // ── Private ──────────────────────────────────────────────────────────────
    handleMessage(message) {
        switch (message.type) {
            case 'acceptChanges':
                if (this.currentResult && this.onAcceptChanges) {
                    this.onAcceptChanges(this.currentResult.changes);
                }
                break;
            case 'rejectChanges':
                if (this.currentResult && this.onRejectChanges) {
                    this.onRejectChanges(this.currentResult.changes);
                }
                break;
            case 'cancelTask':
                this.onCancelTask?.();
                break;
            case 'toggleDiff':
                // The webview handles diff toggling locally
                break;
            case 'requestConfig':
                // Send config info back
                this.panel?.webview.postMessage({
                    type: 'config',
                    payload: vscode.workspace.getConfiguration('agent-baba-d'),
                });
                break;
            default:
                break;
        }
    }
    dispose() {
        this.panel = null;
        this.currentResult = null;
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }
    // ── Webview HTML ─────────────────────────────────────────────────────────
    getWebviewContent() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Agent-Baba-D Progress</title>
  <style>
    :root {
      --bg-primary: #1e1e1e;
      --bg-secondary: #252526;
      --bg-tertiary: #2d2d2d;
      --text-primary: #cccccc;
      --text-secondary: #969696;
      --text-link: #3794ff;
      --border: #3c3c3c;
      --green: #4ec9b0;
      --yellow: #dcdcaa;
      --red: #f44747;
      --blue: #569cd6;
      --orange: #ce9178;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: 16px;
      font-size: 13px;
      line-height: 1.5;
    }

    .header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }

    .header h1 {
      font-size: 16px;
      font-weight: 600;
      flex: 1;
    }

    .status-badge {
      padding: 3px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 500;
    }

    .status-badge.running {
      background: var(--blue);
      color: white;
      animation: pulse 1.5s ease-in-out infinite;
    }

    .status-badge.success {
      background: var(--green);
      color: #1e1e1e;
    }

    .status-badge.error {
      background: var(--red);
      color: white;
    }

    .status-badge.idle {
      background: var(--bg-tertiary);
      color: var(--text-secondary);
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    .phase-container {
      margin-bottom: 16px;
    }

    .phase-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 8px 12px;
      border-radius: 6px;
      background: var(--bg-secondary);
      margin-bottom: 6px;
      transition: background 0.2s;
    }

    .phase-item.active {
      background: var(--bg-tertiary);
      border-left: 3px solid var(--blue);
    }

    .phase-item.completed {
      border-left: 3px solid var(--green);
    }

    .phase-item.error {
      border-left: 3px solid var(--red);
    }

    .phase-icon {
      font-size: 16px;
      width: 24px;
      text-align: center;
      flex-shrink: 0;
    }

    .phase-content {
      flex: 1;
      min-width: 0;
    }

    .phase-title {
      font-weight: 500;
      font-size: 13px;
    }

    .phase-detail {
      color: var(--text-secondary);
      font-size: 11px;
      margin-top: 2px;
      word-break: break-word;
    }

    .phase-log {
      margin-top: 6px;
      padding: 6px 8px;
      background: var(--bg-primary);
      border-radius: 4px;
      font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
      font-size: 11px;
      color: var(--text-secondary);
      max-height: 120px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      display: none;
    }

    .phase-log.visible {
      display: block;
    }

    .log-toggle {
      color: var(--text-link);
      cursor: pointer;
      font-size: 11px;
      margin-top: 4px;
      display: inline-block;
    }

    .log-toggle:hover {
      text-decoration: underline;
    }

    .progress-bar {
      width: 100%;
      height: 3px;
      background: var(--bg-tertiary);
      border-radius: 2px;
      margin: 12px 0;
      overflow: hidden;
    }

    .progress-bar-fill {
      height: 100%;
      background: var(--blue);
      border-radius: 2px;
      transition: width 0.3s ease;
      width: 0%;
    }

    .progress-bar-fill.indeterminate {
      width: 30%;
      animation: indeterminate 1.5s ease-in-out infinite;
    }

    @keyframes indeterminate {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(400%); }
    }

    .result-section {
      margin-top: 16px;
      padding: 12px;
      background: var(--bg-secondary);
      border-radius: 6px;
    }

    .result-section h3 {
      font-size: 14px;
      margin-bottom: 8px;
    }

    .result-summary {
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.6;
    }

    .changes-list {
      margin-top: 12px;
    }

    .change-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 4px;
      background: var(--bg-tertiary);
      margin-bottom: 4px;
      font-size: 12px;
    }

    .change-icon.created { color: var(--green); }
    .change-icon.modified { color: var(--yellow); }
    .change-icon.deleted { color: var(--red); }

    .change-path {
      flex: 1;
      color: var(--text-link);
      cursor: pointer;
    }

    .change-path:hover {
      text-decoration: underline;
    }

    .action-buttons {
      display: flex;
      gap: 8px;
      margin-top: 16px;
    }

    .action-btn {
      padding: 6px 16px;
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .action-btn:hover {
      opacity: 0.9;
    }

    .action-btn.primary {
      background: var(--green);
      color: #1e1e1e;
      border-color: var(--green);
    }

    .action-btn.secondary {
      background: var(--bg-secondary);
      color: var(--text-primary);
    }

    .action-btn.danger {
      background: var(--red);
      color: white;
      border-color: var(--red);
    }

    .action-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .error-message {
      padding: 12px;
      background: rgba(244, 71, 71, 0.1);
      border: 1px solid var(--red);
      border-radius: 6px;
      color: var(--red);
      margin-top: 12px;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
      color: var(--text-secondary);
      text-align: center;
    }

    .empty-state .icon {
      font-size: 48px;
      margin-bottom: 16px;
    }

    .empty-state p {
      font-size: 13px;
      max-width: 300px;
    }

    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid var(--bg-tertiary);
      border-top-color: var(--blue);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🤖 Agent Progress</h1>
    <span id="statusBadge" class="status-badge idle">Idle</span>
  </div>

  <div id="progressBar" class="progress-bar" style="display:none;">
    <div id="progressFill" class="progress-bar-fill indeterminate"></div>
  </div>

  <div id="phases" class="phase-container">
    <!-- Phases rendered dynamically -->
  </div>

  <div id="result" class="result-section" style="display:none;">
    <h3>📋 Results</h3>
    <div id="resultSummary" class="result-summary"></div>
    <div id="changesList" class="changes-list"></div>
    <div id="actionButtons" class="action-buttons"></div>
  </div>

  <div id="errorDisplay" class="error-message" style="display:none;"></div>

  <div id="emptyState" class="empty-state">
    <div class="icon">🤖</div>
    <p>Run an agent task to see progress here.<br>
    Use <code>Ctrl+Shift+A E</code> to execute a goal.</p>
  </div>

  <script>
    (function () {
      const vscode = acquireVsCodeApi();

      // DOM references
      const phasesEl = document.getElementById('phases');
      const resultSection = document.getElementById('result');
      const resultSummary = document.getElementById('resultSummary');
      const changesList = document.getElementById('changesList');
      const actionButtons = document.getElementById('actionButtons');
      const errorDisplay = document.getElementById('errorDisplay');
      const emptyState = document.getElementById('emptyState');
      const statusBadge = document.getElementById('statusBadge');
      const progressBar = document.getElementById('progressBar');
      const progressFill = document.getElementById('progressFill');

      let currentResult = null;
      let logVisibility = {};

      // Handle messages from extension
      window.addEventListener('message', (event) => {
        const message = event.data;
        const { type, payload } = message;

        switch (type) {
          case 'init':
            clearAll();
            updateStatus('idle');
            break;

          case 'progress':
            handleProgress(payload);
            break;

          case 'result':
            handleResult(payload);
            break;

          case 'error':
            handleError(payload.error);
            break;

          case 'diff':
            // Diff display handled in result section
            break;

          case 'status':
            updateStatus(payload.status);
            break;

          case 'clear':
            clearAll();
            break;

          default:
            break;
        }
      });

      function handleProgress(progress) {
        emptyState.style.display = 'none';
        resultSection.style.display = 'none';
        errorDisplay.style.display = 'none';
        progressBar.style.display = 'block';
        progressFill.className = progress.progress === -1
          ? 'progress-bar-fill indeterminate'
          : 'progress-bar-fill';

        if (progress.progress > 0) {
          progressFill.style.width = progress.progress + '%';
        }

        updateStatus('running');

        // Find or create phase item
        let phaseItem = document.getElementById('phase-' + slugify(progress.phase));

        if (!phaseItem) {
          const div = document.createElement('div');
          div.id = 'phase-' + slugify(progress.phase);
          div.className = 'phase-item active';
          div.innerHTML = \`
            <div class="phase-icon"><span class="spinner"></span></div>
            <div class="phase-content">
              <div class="phase-title">\${escapeHtml(progress.phase)}</div>
              <div class="phase-detail"></div>
              <span class="log-toggle" onclick="toggleLog('\${slugify(progress.phase)}')">Show log</span>
              <div id="log-\${slugify(progress.phase)}" class="phase-log"></div>
            </div>
          \`;
          phasesEl.appendChild(div);
          phaseItem = div;
        }

        // Update phase content
        phaseItem.className = progress.completed
          ? 'phase-item completed'
          : 'phase-item active';

        phaseItem.querySelector('.phase-icon').textContent = progress.completed
          ? '✅'
          : '<span class="spinner"></span>';

        const detailEl = phaseItem.querySelector('.phase-detail');
        if (progress.detail) {
          detailEl.textContent = progress.detail;
        }

        // Append log entries
        const logEl = phaseItem.querySelector('.phase-log');
        for (const entry of progress.log) {
          const line = document.createElement('div');
          line.textContent = entry;
          logEl.appendChild(line);
        }

        // Scroll log to bottom
        logEl.scrollTop = logEl.scrollHeight;
      }

      function handleResult(result) {
        currentResult = result;
        progressBar.style.display = 'none';
        resultSection.style.display = 'block';
        errorDisplay.style.display = 'none';

        updateStatus(result.success ? 'success' : 'error');

        // Mark all active phases as completed
        document.querySelectorAll('.phase-item.active').forEach((el) => {
          el.className = 'phase-item completed';
          el.querySelector('.phase-icon').textContent = '✅';
        });

        resultSummary.textContent = result.summary;

        // Render changes
        changesList.innerHTML = '<div class="changes-list">';
        if (result.changes && result.changes.length > 0) {
          for (const change of result.changes) {
            const div = document.createElement('div');
            div.className = 'change-item';
            div.innerHTML = \`
              <span class="change-icon \${change.type}">\${change.type === 'created' ? '📄' : change.type === 'modified' ? '✏️' : '🗑️'}</span>
              <span class="change-path" title="Click to view diff">\${escapeHtml(change.path)}</span>
              <span style="color: var(--text-secondary); font-size: 11px;">\${change.type}</span>
            \`;
            changesList.appendChild(div);
          }
        } else {
          changesList.innerHTML = '<div style="color: var(--text-secondary); font-size: 12px;">No file changes proposed.</div>';
        }

        // Render action buttons
        if (result.changes && result.changes.length > 0) {
          actionButtons.innerHTML = \`
            <button class="action-btn primary" onclick="acceptChanges()">✅ Accept Changes</button>
            <button class="action-btn danger" onclick="rejectChanges()">❌ Reject Changes</button>
          \`;
        } else {
          actionButtons.innerHTML = '<button class="action-btn secondary" onclick="cancelTask()">Close</button>';
        }
      }

      function handleError(error) {
        progressBar.style.display = 'none';
        errorDisplay.style.display = 'block';
        errorDisplay.textContent = '❌ ' + error;
        updateStatus('error');

        // Mark active phases as errored
        document.querySelectorAll('.phase-item.active').forEach((el) => {
          el.className = 'phase-item error';
          el.querySelector('.phase-icon').textContent = '❌';
        });
      }

      function clearAll() {
        phasesEl.innerHTML = '';
        resultSection.style.display = 'none';
        errorDisplay.style.display = 'none';
        emptyState.style.display = 'flex';
        progressBar.style.display = 'none';
        currentResult = null;
        updateStatus('idle');
      }

      function updateStatus(status) {
        statusBadge.className = 'status-badge ' + status;
        const labels = {
          running: 'Running',
          success: 'Completed',
          error: 'Failed',
          idle: 'Idle',
        };
        statusBadge.textContent = labels[status] || status;
      }

      // Globals for inline onclick handlers
      window.acceptChanges = function () {
        vscode.postMessage({ type: 'acceptChanges' });
      };

      window.rejectChanges = function () {
        vscode.postMessage({ type: 'rejectChanges' });
      };

      window.cancelTask = function () {
        vscode.postMessage({ type: 'cancelTask' });
      };

      window.toggleLog = function (id) {
        const logEl = document.getElementById('log-' + id);
        if (logEl) {
          logEl.classList.toggle('visible');
        }
      };

      // Helpers
      function slugify(text) {
        return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'unknown';
      }

      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      // Signal readiness
      vscode.postMessage({ type: 'requestConfig' });
    })();
  </script>
</body>
</html>`;
    }
}
exports.AgentPanel = AgentPanel;
//# sourceMappingURL=agentPanel.js.map