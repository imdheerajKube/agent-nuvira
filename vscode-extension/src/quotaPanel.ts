/**
 * Quota Panel — A VS Code WebView panel that visualizes the central quota
 * ledger (`~/.buff/memory/quota-ledger.json` + `quota-events.jsonl`).
 *
 * Mirrors the dashboard's Quota card so the extension view matches the CLI
 * transparency story:
 * - Summary cards (free/local savings vs paid spend, estimated $ saved)
 * - Ledger entries table (tokens consumed, reset window, parked state)
 * - Failover timeline (parked → failover → re-enabled)
 *
 * The panel is purely read-only — it renders whatever CLIManager.getQuotaStatus()
 * returns, offers a manual "Refresh" action, AND auto-refreshes live when the
 * ledger/timeline files change (fs.watch on the memory dir, mirroring the
 * dashboard's SSE quota watcher) so parked/failover events appear instantly
 * without clicking.
 */

import { existsSync, mkdirSync, watch } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import type { QuotaStatusInfo } from './types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Debounce window for the file watcher (ms) — fs.watch can fire multiple
 * events per write; re-read once per burst. Mirrors the dashboard's 150ms. */
const WATCH_DEBOUNCE_MS = 150;

/**
 * True when a watch event filename refers to a quota file we care about.
 * A null/empty filename is treated as a trigger too (some platforms report
 * null on directory watches); macOS FSEvents can report FULL PATHS, so
 * normalize with basename() before comparing — exactly like the dashboard's
 * armQuotaWatcher.
 */
export function isQuotaWatchFile(filename: string | null | undefined): boolean {
  const name = basename(String(filename || ''));
  return !name || name === 'quota-events.jsonl' || name === 'quota-ledger.json';
}

// ─── QuotaPanel ─────────────────────────────────────────────────────────────

export class QuotaPanel {
  public static readonly viewType = 'agent-nuvira.quotaView';

  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  private loadStatus: () => Promise<QuotaStatusInfo>;
  /** Memory dir watched for live quota updates (BUFF_MEMORY_DIR-aware). */
  private watchDir: string;
  private watcher: ReturnType<typeof watch> | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    loadStatus: () => Promise<QuotaStatusInfo>;
    /** Override the watched memory dir (defaults to BUFF_MEMORY_DIR || ~/.buff/memory). */
    watchDir?: string;
  }) {
    this.loadStatus = options.loadStatus;
    this.watchDir = options.watchDir || process.env.BUFF_MEMORY_DIR || join(homedir(), '.buff', 'memory');
  }

  /**
   * Create or reveal the quota panel.
   */
  createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Beside;

    if (this.panel) {
      this.panel.reveal(column);
      // Re-fetch on reveal — the webview keeps its context (retainContextWhenHidden)
      // but the data may have changed while hidden.
      this.refresh();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      QuotaPanel.viewType,
      'Agent-Nuvira Quotas',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );

    this.panel.webview.html = this.getWebviewContent();

    // Handle refresh requests from the webview
    this.panel.webview.onDidReceiveMessage(
      (message: { type: string }) => {
        if (message.type === 'refresh') {
          this.refresh();
        }
      },
      null,
      this.disposables,
    );

    // Clean up on dispose
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // NOTE: no direct refresh() on fresh create. The webview script signals
    // readiness with { type: 'refresh' } once loaded, and the handler above
    // responds with the payload — this guarantees the first postMessage lands
    // after the webview is ready (avoids a lost-initial-payload race). The
    // reveal path above fetches directly since the script doesn't re-run.

    // Arm the live watcher for the panel's lifetime (disarmed in dispose).
    this.armWatcher();
  }

  /**
   * (Re)load the quota status from the CLI memory dir and render it.
   * Best-effort — a failed read renders the empty state.
   */
  async refresh(): Promise<void> {
    if (!this.panel) return;

    let status: QuotaStatusInfo;
    try {
      status = await this.loadStatus();
    } catch {
      status = {
        enabled: false,
        entries: [],
        events: [],
        freeTokens: 0,
        freeRequests: 0,
        paidTokens: 0,
        paidRequests: 0,
        estimatedSavedUsd: 0,
      };
    }

    // The panel may have been disposed while the loader was in flight —
    // never post to a closed webview.
    if (!this.panel) return;

    this.panel.webview.postMessage({
      type: 'quota',
      payload: status,
    });
  }

  /**
   * Check if the panel is visible.
   */
  get isVisible(): boolean {
    return this.panel !== null && this.panel.visible;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Watch the memory dir and auto-refresh when quota files change, so a
   * failover/park/window-reset written by ANY process sharing BUFF_MEMORY_DIR
   * (CLI, chat, dashboard) shows up instantly without clicking Refresh.
   * Best-effort — a failed watcher must never break the panel.
   */
  private armWatcher(): void {
    if (this.watcher) return;
    try {
      // The memory dir may not exist yet (panel opened before any CLI run) —
      // create it first so watch() doesn't throw ENOENT (mirrors the dashboard).
      if (!existsSync(this.watchDir)) {
        mkdirSync(this.watchDir, { recursive: true });
      }
      this.watcher = watch(this.watchDir, (_eventType, filename) => {
        if (!isQuotaWatchFile(filename)) return;
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          void this.refresh();
        }, WATCH_DEBOUNCE_MS);
      });
    } catch {
      // Best-effort — fall back to manual Refresh only.
      this.watcher = null;
    }
  }

  private disarmWatcher(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // ignore — already closed
      }
      this.watcher = null;
    }
  }

  private dispose(): void {
    this.disarmWatcher();
    this.panel = null;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }

  // ── Webview HTML ─────────────────────────────────────────────────────────

  private getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Agent-Nuvira Quotas</title>
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
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }

    .header h1 { font-size: 16px; font-weight: 600; flex: 1; }

    .refresh-btn {
      padding: 4px 12px;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .refresh-btn:hover { opacity: 0.85; }

    /* ── Summary cards ─────────────────────────────────────────────── */
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 10px;
      margin-bottom: 20px;
    }

    .card {
      padding: 12px 14px;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 6px;
      transition: border-color 0.2s;
    }
    .card:hover { border-color: var(--text-link); }

    .card .label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-secondary);
      margin-bottom: 6px;
    }
    .card .value { font-size: 20px; font-weight: 600; }
    .card .sub { font-size: 11px; color: var(--text-secondary); margin-top: 2px; }
    .card .value.green { color: var(--green); }
    .card .value.yellow { color: var(--yellow); }
    .card .value.orange { color: var(--orange); }
    .card .value.blue { color: var(--blue); }

    /* ── Sections ──────────────────────────────────────────────────── */
    .section { margin-bottom: 20px; }
    .section h2 {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th {
      text-align: left;
      color: var(--text-secondary);
      font-weight: 500;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 7px 8px;
      border-bottom: 1px solid rgba(60, 60, 60, 0.5);
      vertical-align: top;
    }
    tr:hover td { background: var(--bg-tertiary); }

    .badge {
      display: inline-block;
      padding: 1px 8px;
      border-radius: 10px;
      font-size: 10px;
      font-weight: 600;
    }
    .badge.parked { background: rgba(244, 71, 71, 0.15); color: var(--red); }
    .badge.active { background: rgba(78, 201, 176, 0.15); color: var(--green); }

    /* ── Timeline ──────────────────────────────────────────────────── */
    .timeline { position: relative; padding-left: 20px; }
    .timeline::before {
      content: '';
      position: absolute;
      left: 6px;
      top: 4px;
      bottom: 4px;
      width: 2px;
      background: var(--border);
    }

    .timeline-item {
      position: relative;
      padding: 6px 0 6px 8px;
    }
    .timeline-item::before {
      content: '';
      position: absolute;
      left: -18px;
      top: 12px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--bg-tertiary);
      border: 2px solid var(--blue);
    }
    .timeline-item.failover::before { border-color: var(--orange); }
    .timeline-item.parked::before { border-color: var(--red); }
    .timeline-item.re-enabled::before, .timeline-item.released::before { border-color: var(--green); }

    .timeline-item .event-text { font-size: 12px; }
    .timeline-item .event-provider { color: var(--text-link); font-weight: 500; }
    .timeline-item .event-time { font-size: 11px; color: var(--text-secondary); margin-top: 1px; }
    .timeline-item .event-reason { font-size: 11px; color: var(--text-secondary); margin-top: 1px; }

    /* ── Empty state ───────────────────────────────────────────────── */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 48px 20px;
      color: var(--text-secondary);
      text-align: center;
    }
    .empty-state .icon { font-size: 48px; margin-bottom: 16px; }
    .empty-state p { font-size: 13px; max-width: 360px; line-height: 1.6; }
    .empty-state code {
      background: var(--bg-tertiary);
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 12px;
    }

    .error-banner {
      padding: 10px 12px;
      background: rgba(244, 71, 71, 0.1);
      border: 1px solid var(--red);
      border-radius: 6px;
      color: var(--red);
      margin-bottom: 16px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🧾 Quota Ledger</h1>
    <button class="refresh-btn" onclick="requestRefresh()">↻ Refresh</button>
  </div>

  <div id="content">
    <div id="emptyState" class="empty-state">
      <div class="icon">🧾</div>
      <p>No quota activity yet.<br><br>
      Run <code>buff execute</code> or <code>buff chat</code> with Auto routing
      enabled and quota-based failover to populate the ledger. The ledger lives
      at <code>~/.buff/memory/quota-ledger.json</code>.</p>
    </div>
  </div>

  <script>
    (function () {
      const vscode = acquireVsCodeApi();
      const contentEl = document.getElementById('content');

      window.requestRefresh = function () {
        vscode.postMessage({ type: 'refresh' });
      };

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type !== 'quota') return;
        render(message.payload);
      });

      function render(status) {
        if (!status || (!status.enabled && (!status.entries || status.entries.length === 0))) {
          contentEl.innerHTML = '<div id="emptyState" class="empty-state">' +
            '<div class="icon">🧾</div>' +
            '<p>No quota activity yet.<br><br>' +
            'Run <code>buff execute</code> or <code>buff chat</code> with Auto routing ' +
            'enabled and quota-based failover to populate the ledger. The ledger lives ' +
            'at <code>~/.buff/memory/quota-ledger.json</code>.</p></div>';
          return;
        }

        let html = '';

        // ── Summary cards ─────────────────────────────────────────────
        html += '<div class="cards">';

        const freeTokens = formatTokens(status.freeTokens || 0);
        const paidTokens = formatTokens(status.paidTokens || 0);
        const savedUsd = formatUsd(status.estimatedSavedUsd || 0);
        const freeReq = (status.freeRequests || 0).toLocaleString();
        const paidReq = (status.paidRequests || 0).toLocaleString();
        const parkedCount = (status.entries || []).filter(function (e) { return e.parked; }).length;

        html += card('Free / local tokens', freeTokens, 'green', freeReq + ' requests — savings');
        html += card('Paid tokens', paidTokens, 'yellow', paidReq + ' requests — spend');
        html += card('Estimated saved', '$' + savedUsd, 'green', 'at typical paid rates');
        html += card('Parked providers', String(parkedCount), parkedCount > 0 ? 'orange' : 'blue',
          parkedCount > 0 ? 'waiting for window reset' : 'none — all healthy');

        html += '</div>';

        // ── Ledger entries ─────────────────────────────────────────────
        html += '<div class="section"><h2>Provider windows</h2><table>' +
          '<thead><tr><th>Provider</th><th>Model</th><th>Tokens</th><th>Requests</th><th>Resets in</th><th>Status</th></tr></thead><tbody>';

        const entries = (status.entries || []).slice().sort(function (a, b) {
          return a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
        });

        for (const e of entries) {
          const badge = e.parked
            ? '<span class="badge parked">⏸ parked</span>'
            : '<span class="badge active">● active</span>';
          html += '<tr>' +
            '<td>' + escapeHtml(e.provider) + '</td>' +
            '<td>' + escapeHtml(e.model) + '</td>' +
            '<td>' + formatTokens(e.tokensConsumed) + '</td>' +
            '<td>' + (e.requests || 0).toLocaleString() + '</td>' +
            '<td>' + formatDuration(e.resetsInMs || 0) + '</td>' +
            '<td>' + badge + '</td>' +
            '</tr>';
        }

        html += '</tbody></table></div>';

        // ── Failover timeline ──────────────────────────────────────────
        const events = (status.events || []).slice().reverse();
        if (events.length > 0) {
          html += '<div class="section"><h2>Failover timeline</h2><div class="timeline">';
          for (const ev of events) {
            const cls = (ev.type === 'failover' ? 'failover' :
              ev.type === 'parked' ? 'parked' : 're-enabled');
            const icon = ev.type === 'failover' ? '🔁' : ev.type === 'parked' ? '⏸' : '✅';
            const reason = ev.reason ? '<div class="event-reason">' + escapeHtml(ev.reason) + '</div>' : '';
            html += '<div class="timeline-item ' + cls + '">' +
              '<div class="event-text">' + icon + ' <span class="event-provider">' + escapeHtml(ev.provider) + '</span> ' +
              escapeHtml(ev.type.replace('-', ' ')) + '</div>' +
              '<div class="event-time">' + formatTime(ev.timestamp) + '</div>' + reason +
              '</div>';
          }
          html += '</div></div>';
        }

        contentEl.innerHTML = html;
      }

      // ── Helpers ─────────────────────────────────────────────────────
      function card(label, value, colorClass, sub) {
        return '<div class="card"><div class="label">' + label + '</div>' +
          '<div class="value ' + colorClass + '">' + value + '</div>' +
          '<div class="sub">' + sub + '</div></div>';
      }

      function formatTokens(n) {
        if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return String(n);
      }

      function formatUsd(n) {
        if (n >= 1000) return n.toFixed(0);
        if (n >= 1) return n.toFixed(2);
        if (n === 0) return '0.00';
        return n.toFixed(4);
      }

      function formatDuration(ms) {
        if (ms <= 0) return 'now';
        const mins = Math.floor(ms / 60000);
        if (mins < 60) return mins + 'm';
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return hrs + 'h ' + (mins % 60) + 'm';
        const days = Math.floor(hrs / 24);
        return days + 'd ' + (hrs % 24) + 'h';
      }

      function formatTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
          ' · ' + d.toLocaleDateString();
      }

      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
      }

      // Ask the host for the initial payload once the webview is ready.
      // The host's message handler is registered before this script runs, so
      // this signal is always received (guaranteed first-load delivery).
      vscode.postMessage({ type: 'refresh' });
    })();
  </script>
</body>
</html>`;
  }
}
