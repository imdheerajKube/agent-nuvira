/**
 * Unit tests for QuotaPanel.
 *
 * Verifies the panel lifecycle against the mocked VS Code API:
 * - createOrShow creates a webview panel, wires message handling, and posts
 *   the initial quota payload from the injected loader
 * - reveal path re-fetches instead of re-creating
 * - refresh posts a fresh payload; loader failures fall back to the empty
 *   shape (never crashes)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock vscode module before importing the panel
vi.mock('vscode', () => {
  return import('./__mocks__/vscode.js');
});

import * as vscode from 'vscode';
import { QuotaPanel } from '../quotaPanel.js';
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

describe('QuotaPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    const panel = new QuotaPanel(loader);

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
    const panel = new QuotaPanel(loader);

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
    const panel = new QuotaPanel(loader);

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
    const panel = new QuotaPanel(loader);
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
    const panel = new QuotaPanel(vi.fn());
    expect(panel.isVisible).toBe(false);

    panel.createOrShow(vscode.Uri.file('/test/extension'));
    expect(panel.isVisible).toBe(true);
  });

  it('handles a refresh message from the webview (manual Refresh button)', async () => {
    const loader = vi.fn().mockResolvedValue(emptyStatus);
    const panel = new QuotaPanel(loader);
    panel.createOrShow(vscode.Uri.file('/test/extension'));
    expect(loader).not.toHaveBeenCalled();

    const webview = (vscode.window.createWebviewPanel as ReturnType<typeof vi.fn>).mock.results[0].value;
    const handler = webview.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: { type: string }) => void;
    handler({ type: 'refresh' }); // load signal
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));

    handler({ type: 'refresh' }); // manual button click
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  });
});
