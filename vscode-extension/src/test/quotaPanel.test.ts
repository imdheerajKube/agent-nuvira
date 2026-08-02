/**
 * Unit tests for QuotaPanel.
 *
 * Verifies the panel lifecycle against the mocked VS Code API plus the live
 * file watcher:
 * - createOrShow creates a webview panel, wires message handling, and posts
 *   the quota payload once the webview signals readiness
 * - reveal path re-fetches instead of re-creating
 * - refresh posts a fresh payload; loader failures fall back to the empty
 *   shape (never crashes)
 * - isQuotaWatchFile() pure filter (null/full-path normalization)
 * - the live watcher auto-refreshes when quota files change on disk (real
 *   fs.watch against a temp dir), and ignores unrelated files
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock vscode module before importing the panel
vi.mock('vscode', () => {
  return import('./__mocks__/vscode.js');
});

import * as vscode from 'vscode';
import { QuotaPanel, isQuotaWatchFile } from '../quotaPanel.js';
import type { QuotaStatusInfo } from '../types.js';

const emptyStatus: QuotaStatusInfo = {
  enabled: false,
  entries: [],
  events: [],
  freeTokens: 0,
  freeRequests: 0,
  paidTokens: 0,
  paidRequests: 0,
  estimatedSavedUsd: 0,
};

function makeStatus(overrides?: Partial<QuotaStatusInfo>): QuotaStatusInfo {
  return { ...emptyStatus, ...overrides };
}

describe('isQuotaWatchFile', () => {
  it('treats null/undefined/empty filenames as triggers (platform safety)', () => {
    expect(isQuotaWatchFile(null)).toBe(true);
    expect(isQuotaWatchFile(undefined)).toBe(true);
    expect(isQuotaWatchFile('')).toBe(true);
  });

  it('matches the two quota files by basename', () => {
    expect(isQuotaWatchFile('quota-events.jsonl')).toBe(true);
    expect(isQuotaWatchFile('quota-ledger.json')).toBe(true);
  });

  it('normalizes full paths (macOS FSEvents reports absolute paths)', () => {
    expect(isQuotaWatchFile('/Users/me/.buff/memory/quota-ledger.json')).toBe(true);
    expect(isQuotaWatchFile('/tmp/whatever/quota-events.jsonl')).toBe(true);
  });

  it('rejects unrelated files', () => {
    expect(isQuotaWatchFile('router-bandit.json')).toBe(false);
    expect(isQuotaWatchFile('history.json')).toBe(false);
    expect(isQuotaWatchFile('active-model.json')).toBe(false);
  });
});

describe('QuotaPanel', () => {
  let tempDir: string;
  let panels: QuotaPanel[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'buff-quota-panel-'));
    panels = [];
  });

  afterEach(() => {
    // Dispose every panel (disarms its watcher) then remove the temp dir
    for (const p of panels) {
      (p as unknown as { dispose(): void }).dispose();
    }
    panels = [];
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makePanel(loader: ReturnType<typeof vi.fn>): QuotaPanel {
    const panel = new QuotaPanel({ loadStatus: loader, watchDir: tempDir });
    panels.push(panel);
    return panel;
  }

  it('creates a webview panel and posts the initial quota payload once the webview signals readiness', async () => {
    const status = makeStatus({
      enabled: true,
      entries: [{
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        tokensConsumed: 80_000,
        requests: 12,
        windowLengthMs: 86_400_000,
        resetsInMs: 3_600_000,
        parked: true,
        cooldownRemaining: 2_700_000,
      }],
      freeTokens: 120_000,
      paidTokens: 80_000,
    });
    const loader = vi.fn().mockResolvedValue(status);
    const panel = makePanel(loader);

    panel.createOrShow(vscode.Uri.file('/test/extension'));

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'agent-nuvira.quotaView',
      'Agent-Nuvira Quotas',
      vscode.ViewColumn.Beside,
      expect.anything(),
    );

    // Fresh create does NOT fetch eagerly — the webview signals readiness
    // first (guarantees the first postMessage lands after the webview loads).
    expect(loader).not.toHaveBeenCalled();

    // Simulate the webview's load-time readiness signal
    const webview = (vscode.window.createWebviewPanel as ReturnType<typeof vi.fn>).mock.results[0].value;
    const handler = webview.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: { type: string }) => void;
    handler({ type: 'refresh' });

    await vi.waitFor(() => {
      expect(webview.webview.postMessage).toHaveBeenCalledWith({
        type: 'quota',
        payload: status,
      });
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('reuses the existing panel on a second createOrShow (reveal + refetch)', async () => {
    const loader = vi.fn().mockResolvedValue(emptyStatus);
    const panel = makePanel(loader);

    panel.createOrShow(vscode.Uri.file('/test/extension'));
    expect(loader).not.toHaveBeenCalled();

    // Reveal path refetches directly (the webview script doesn't re-run)
    panel.createOrShow(vscode.Uri.file('/test/extension'));

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
  });

  it('posts a fresh payload on refresh()', async () => {
    const first = makeStatus({ enabled: true, entries: [], events: [] });
    const second = makeStatus({
      enabled: true,
      events: [{ type: 'failover', provider: 'gemini', timestamp: Date.now() }],
    });
    const loader = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const panel = makePanel(loader);

    panel.createOrShow(vscode.Uri.file('/test/extension'));
    const webview = (vscode.window.createWebviewPanel as ReturnType<typeof vi.fn>).mock.results[0].value;
    const handler = webview.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: { type: string }) => void;
    handler({ type: 'refresh' }); // initial load signal → first payload
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));

    (webview.webview.postMessage as ReturnType<typeof vi.fn>).mockClear();

    await panel.refresh();

    expect(loader).toHaveBeenCalledTimes(2);
    expect(webview.webview.postMessage).toHaveBeenCalledWith({ type: 'quota', payload: second });
  });

  it('falls back to the empty shape when the loader throws', async () => {
    const loader = vi.fn().mockRejectedValue(new Error('boom'));
    const panel = makePanel(loader);
    panel.createOrShow(vscode.Uri.file('/test/extension'));

    const webview = (vscode.window.createWebviewPanel as ReturnType<typeof vi.fn>).mock.results[0].value;
    const handler = webview.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: { type: string }) => void;
    handler({ type: 'refresh' });

    // The catch → empty-shape path must post a safe fallback payload,
    // never throw, and never surface the loader error.
    await vi.waitFor(() => {
      expect(webview.webview.postMessage).toHaveBeenCalledWith({
        type: 'quota',
        payload: expect.objectContaining({ enabled: false, entries: [] }),
      });
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('returns isVisible only when a panel exists and is visible', () => {
    const panel = makePanel(vi.fn());
    expect(panel.isVisible).toBe(false);

    panel.createOrShow(vscode.Uri.file('/test/extension'));
    expect(panel.isVisible).toBe(true);
  });

  it('handles a refresh message from the webview (manual Refresh button)', async () => {
    const loader = vi.fn().mockResolvedValue(emptyStatus);
    const panel = makePanel(loader);
    panel.createOrShow(vscode.Uri.file('/test/extension'));
    expect(loader).not.toHaveBeenCalled();

    const webview = (vscode.window.createWebviewPanel as ReturnType<typeof vi.fn>).mock.results[0].value;
    const handler = webview.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: { type: string }) => void;
    handler({ type: 'refresh' }); // load signal
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));

    handler({ type: 'refresh' }); // manual button click
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  });

  // ── Live watcher ─────────────────────────────────────────────────────────

  it('auto-refreshes when quota-events.jsonl changes on disk (live failover update)', async () => {
    const loader = vi.fn().mockResolvedValue(emptyStatus);
    const panel = makePanel(loader);
    panel.createOrShow(vscode.Uri.file('/test/extension'));

    // Load the initial payload
    const webview = (vscode.window.createWebviewPanel as ReturnType<typeof vi.fn>).mock.results[0].value;
    const handler = webview.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: { type: string }) => void;
    handler({ type: 'refresh' });
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));

    // Simulate a failover being written by the CLI (shares BUFF_MEMORY_DIR)
    writeFileSync(join(tempDir, 'quota-events.jsonl'), JSON.stringify({
      type: 'failover',
      provider: 'gemini',
      reason: 'switched to groq',
      timestamp: Date.now(),
    }) + '\n');

    // The watcher (debounced) should trigger a second refresh automatically
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2), { timeout: 5000 });
  });

  it('auto-refreshes when quota-ledger.json changes on disk', async () => {
    const loader = vi.fn().mockResolvedValue(emptyStatus);
    const panel = makePanel(loader);
    panel.createOrShow(vscode.Uri.file('/test/extension'));

    const webview = (vscode.window.createWebviewPanel as ReturnType<typeof vi.fn>).mock.results[0].value;
    const handler = webview.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: { type: string }) => void;
    handler({ type: 'refresh' });
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));

    writeFileSync(join(tempDir, 'quota-ledger.json'), JSON.stringify({
      version: 1,
      entries: {},
    }));

    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2), { timeout: 5000 });
  });

  // NOTE: no integration-level "unrelated file does not refresh" assertion —
  // the watcher deliberately treats NULL filenames as triggers (some platforms
  // report null on directory watches), so an unrelated write can legitimately
  // fire a refresh there. Rejection of unrelated files is covered
  // deterministically by the isQuotaWatchFile unit tests above.

  it('disarms the watcher on dispose (no refresh after disposal)', async () => {
    const loader = vi.fn().mockResolvedValue(emptyStatus);
    const panel = makePanel(loader);
    panel.createOrShow(vscode.Uri.file('/test/extension'));

    const webview = (vscode.window.createWebviewPanel as ReturnType<typeof vi.fn>).mock.results[0].value;
    const handler = webview.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: { type: string }) => void;
    handler({ type: 'refresh' });
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));

    (panel as unknown as { dispose(): void }).dispose();

    writeFileSync(join(tempDir, 'quota-events.jsonl'), '{}\n');
    await new Promise((r) => setTimeout(r, 600));
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('poll fallback auto-refreshes periodically even without file writes', async () => {
    const loader = vi.fn().mockResolvedValue(emptyStatus);
    // Tiny poll interval so the test doesn't wait 60s; the watcher debounce is
    // untouched — this exercises the safety-net poll path only.
    const panel = new QuotaPanel({ loadStatus: loader, watchDir: tempDir, pollMs: 40 });
    panels.push(panel);
    panel.createOrShow(vscode.Uri.file('/test/extension'));

    const webview = (vscode.window.createWebviewPanel as ReturnType<typeof vi.fn>).mock.results[0].value;
    const handler = webview.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: { type: string }) => void;
    handler({ type: 'refresh' });
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));

    // No file writes — the poll timer alone must drive further refreshes.
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(3), { timeout: 5000 });
  });

  it('stops the poll fallback on dispose', async () => {
    const loader = vi.fn().mockResolvedValue(emptyStatus);
    const panel = new QuotaPanel({ loadStatus: loader, watchDir: tempDir, pollMs: 40 });
    panels.push(panel);
    panel.createOrShow(vscode.Uri.file('/test/extension'));

    const webview = (vscode.window.createWebviewPanel as ReturnType<typeof vi.fn>).mock.results[0].value;
    const handler = webview.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: { type: string }) => void;
    handler({ type: 'refresh' });
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2), { timeout: 5000 });

    (panel as unknown as { dispose(): void }).dispose();
    const callsAfterDispose = loader.mock.calls.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(loader.mock.calls.length).toBe(callsAfterDispose);
  });
});
