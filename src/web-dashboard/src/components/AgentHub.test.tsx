/**
 * Agent Hub panel tests (I4 + I5).
 *
 * - Every tab renders from the /api/hub payload
 *   (Tools/Channels/Conversations/Artifacts/Skills/Subagents).
 * - An authenticated admin/operator can toggle a toolset — the switch calls
 *   setToolsetEnabled and the panel re-reads.
 * - An unauthenticated user is routed through the login gate, then the queued
 *   toggle is applied.
 * - Reads degrade to a friendly error, never a crash.
 * - The Subagents tab re-reads the hub while a run is in flight, updates the row
 *   in place, and stops polling once nothing is running.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import AgentHub, { buildConversationExportHtml, readConversationExportPalette } from './AgentHub';
import { dashboardAPI, setAdminToken } from '../api';
import type { HubData } from '../types';

const HUB: HubData = {
  toolsets: {
    toolsets: [
      { name: 'core', label: 'Core', description: 'Pipeline actions', enabled: true, tools: ['build', 'test'], toolCount: 2 },
      { name: 'web', label: 'Web research', description: 'Search + page reading', enabled: true, tools: ['web_search', 'read_page'], toolCount: 2 },
    ],
    enabled: 2,
    disabled: 0,
    totalTools: 4,
  },
  channels: {
    delivery: {
      total: 1,
      pending: 1,
      sent: 0,
      failed: 0,
      recent: [
        { id: 'e1', target: 'ops', platform: 'slack', channelId: 'C1', text: 'nightly done', status: 'pending', attempts: 2, nextAttemptAt: Date.now() + 30000, createdAt: Date.now() },
      ],
    },
    aliases: [{ alias: 'ops', platform: 'slack', channelId: 'C1', addedAt: Date.now() }],
    reachable: [],
    platforms: [
      { platform: 'email', label: 'Email (SMTP)', configured: false, envVars: ['BUFF_SMTP_HOST', 'BUFF_SMTP_USER'] },
      { platform: 'signal', label: 'Signal (signal-cli-rest-api)', configured: true, envVars: ['BUFF_SIGNAL_ACCOUNT'] },
      { platform: 'whatsapp', label: 'WhatsApp (Baileys bridge)', configured: true, envVars: ['BUFF_WHATSAPP_SESSION_DIR'] },
    ],
    policies: {
      whatsapp: { allowedUsers: ['+919876543210', '919999999999'], silentDrop: true },
    },
    contacts: [{ name: 'Alex', platform: 'whatsapp', id: '+919876543210', addedAt: Date.now() }],
    statusRecipients: [],
    statusRecipientDisplay: {},
    inbox: {
      total: 0,
      pipeline: 0,
      chat: 0,
      help: 0,
      refused: 0,
      duplicate: 0,
      attachmentFailed: 0,
      recent: [],
    },
  },
  artifacts: {
    totalSessions: 1,
    totalArtifacts: 2,
    sessions: [
      { sessionId: 's1', count: 2, latestAt: Date.now(), recent: [{ kind: 'doc', title: 'deploy report', preview: 'published ok' }] },
    ],
  },
  skills: {
    compiled: [
      { id: 'skill-fix-lint', name: 'Fix lint', description: 'Fixes lint errors', version: '1.0.0', origin: 'compiled', usageCount: 3, enabled: true, bundled: true },
      { id: 'skill-custom-x', name: 'Custom X', description: 'A user-added skill', version: '1.0.0', origin: 'compiled', usageCount: 0, enabled: false, bundled: false },
    ],
    hub: [{ id: 'demo-fix', name: 'demo-fix', description: 'Fix a demo issue', origin: 'hub', enabled: true }],
    total: 3,
    enabled: 2,
    disabled: 1,
  },
  // P4.1 — two runs: one that finished on a native-tool provider, one that
  // REFUSED (the local model was unreachable), so a row must show both the
  // transport it used and the typed code it stopped with.
  subagents: {
    total: 2,
    running: 0,
    failed: 1,
    recent: [
      {
        id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
        goal: 'summarise the deploy diff',
        status: 'completed',
        provider: 'openai',
        model: 'gpt-4o-mini',
        transport: 'native',
        llmCalls: 2,
        toolCalls: 1,
        startedAt: Date.now() - 4000,
        durationMs: 3200,
        resultPreview: 'The deploy adds two files.',
      },
      {
        id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
        goal: 'count the failing tests',
        status: 'failed',
        provider: 'local',
        transport: 'json',
        refusalCode: 'not_configured',
        error: "Provider 'local' is not reachable.",
        llmCalls: 0,
        toolCalls: 0,
        startedAt: Date.now() - 9000,
        durationMs: 120,
      },
    ],
  },
  conversations: {
    total: 0,
    recent: [],
    analytics: {
      totalMessages: 0,
      totalConversations: 0,
      avgMessagesPerConversation: 0,
      topContacts: [],
      hourlyDistribution: [],
      dailyDistribution: [],
      platformBreakdown: [],
      dailyVolume: [],
      avgUserMessageLength: 0,
      avgAssistantMessageLength: 0,
    },
  },
  adminConfigured: true,
  serverTime: 123,
};

/**
 * The panel's mount-time fetches (hub + auth status). Returns the hub spy so a
 * test can change what the server serves mid-flight — the Subagents poll test
 * lets a run finish between two ticks that way.
 */
function mockReads(payload: HubData | null = HUB, auth: { configured: boolean; authenticated: boolean; role?: string } = { configured: true, authenticated: true, role: 'admin' }) {
  const fetchHub = vi.spyOn(dashboardAPI, 'fetchHub').mockResolvedValue(payload);
  vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({
    configured: auth.configured,
    authenticated: auth.authenticated,
    user: auth.authenticated ? 'admin' : null,
    role: auth.authenticated ? (auth.role ?? 'admin') : null,
  });
  // The Channels tab mounts WhatsAppPanel (P2), whose SSE subscription needs
  // a browser EventSource — keep the hub tests hermetic.
  vi.spyOn(dashboardAPI, 'subscribeWhatsApp').mockReturnValue(() => {});
  // …and PlatformConfigSection (v1.69) fetches the transport list on mount.
  vi.spyOn(dashboardAPI, 'getPlatformConfigs').mockResolvedValue([]);
  vi.spyOn(dashboardAPI, 'getWhatsAppStatus').mockResolvedValue({
    status: {
      state: 'idle',
      paired: false,
      sessionDir: '/tmp/wa-session',
      qr: null,
      qrRaw: null,
      pairingCode: null,
      phone: null,
      error: null,
      startedAt: null,
    },
    contacts: {},
  });
  return { fetchHub };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setAdminToken(null);
});

describe('AgentHub', () => {
  it('renders every tab with counts from the hub payload', async () => {
    mockReads();
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
    expect(screen.getByRole('tab', { name: /Channels/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Artifacts/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Skills/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Subagents/ })).toBeTruthy();
    // Tab badges carry counts (2/2 toolsets, 1 channel, 1 session, 2 skills).
    expect(screen.getByText('2/2')).toBeTruthy();
  });

  it('shows a friendly error when the hub read fails', async () => {
    mockReads(null);
    render(<AgentHub />);
    await waitFor(() =>
      expect(screen.getByText(/Could not reach the dashboard server/)).toBeTruthy(),
    );
  });

  it('toggles a toolset when authed (admin)', async () => {
    mockReads();
    const setMock = vi.spyOn(dashboardAPI, 'setToolsetEnabled').mockResolvedValue({ ok: true });
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());

    const webSwitch = screen.getByRole('switch', { name: /Disable Web research/ });
    expect((webSwitch as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(webSwitch);

    await waitFor(() => expect(setMock).toHaveBeenCalledWith('web', false));
  });

  it('queues the toggle behind the login gate when not authed, then applies it', async () => {
    mockReads(HUB, { configured: true, authenticated: false });
    const loginMock = vi.spyOn(dashboardAPI, 'adminLogin').mockResolvedValue({ ok: true, user: 'admin', token: 't' });
    const setMock = vi.spyOn(dashboardAPI, 'setToolsetEnabled').mockResolvedValue({ ok: true });
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());

    // Switch is disabled without auth — clicking queues the toggle.
    const webSwitch = screen.getByRole('switch', { name: /Disable Web research/ });
    fireEvent.click(webSwitch);

    // Login form appears (queued toggle named in the prompt).
    await waitFor(() => expect(screen.getByText(/Log in to disable 'web'/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'secret-pass' } });
    fireEvent.click(screen.getByRole('button', { name: /Log in & apply/ }));

    await waitFor(() => expect(loginMock).toHaveBeenCalled());
    await waitFor(() => expect(setMock).toHaveBeenCalledWith('web', false));
  });

  it('I11: authed admin can send a test message from the Channels tab', async () => {
    mockReads();
    const sendMock = vi.spyOn(dashboardAPI, 'sendChannelMessage').mockResolvedValue({ ok: true, platform: 'slack', channelId: 'C1' });
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('tab', { name: /Channels/ }));
    await waitFor(() => expect(screen.getByText(/Test a channel/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('ops or slack:C0123 or email:team@example.com'), { target: { value: 'ops' } });
    fireEvent.change(screen.getByPlaceholderText('nightly build done 🎉'), { target: { value: 'hello hub' } });
    fireEvent.click(screen.getByRole('button', { name: /Send test message/ }));

    await waitFor(() => expect(sendMock).toHaveBeenCalledWith('ops', 'hello hub'));
    await waitFor(() => expect(screen.getByText(/Sent to ops/)).toBeTruthy());
  });

  it('I11: a viewer role cannot send — inline error, no API call', async () => {
    mockReads(HUB, { configured: true, authenticated: true, role: 'viewer' });
    const sendMock = vi.spyOn(dashboardAPI, 'sendChannelMessage');
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('tab', { name: /Channels/ }));
    await waitFor(() => expect(screen.getByText(/Test a channel/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('ops or slack:C0123 or email:team@example.com'), { target: { value: 'ops' } });
    fireEvent.change(screen.getByPlaceholderText('nightly build done 🎉'), { target: { value: 'hello hub' } });
    fireEvent.click(screen.getByRole('button', { name: /Send test message/ }));

    await waitFor(() => expect(screen.getByText(/cannot send channel messages/)).toBeTruthy());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('I11: an unauthenticated user is told to log in before sending', async () => {
    mockReads(HUB, { configured: true, authenticated: false });
    const sendMock = vi.spyOn(dashboardAPI, 'sendChannelMessage');
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('tab', { name: /Channels/ }));
    await waitFor(() => expect(screen.getByText(/Test a channel/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('ops or slack:C0123 or email:team@example.com'), { target: { value: 'ops' } });
    fireEvent.change(screen.getByPlaceholderText('nightly build done 🎉'), { target: { value: 'hello hub' } });
    fireEvent.click(screen.getByRole('button', { name: /Send test message/ }));

    await waitFor(() => expect(screen.getByText(/Log in .* to send test messages/)).toBeTruthy());
    expect(sendMock).not.toHaveBeenCalled();
  });

  /**
   * The Permissions section is COLLAPSED by default (the page carries several
   * long sections), so the per-platform cards — and the masked or full ids they
   * hold — only exist in the DOM once it is expanded. The heading that toggles
   * it is always rendered, which is what these tests wait on.
   */
  function expandPermissions(): void {
    fireEvent.click(screen.getByText(/Permissions — who can TRIGGER the agent/));
  }

  /** The whatsapp card on the Permissions section (scoped — the label also renders in the transports list). */
  function whatsappCard(): HTMLElement {
    const card = screen
      .getAllByText('WhatsApp (Baileys bridge)')
      .map((el) => el.closest('.hub-card'))
      .find((c): c is HTMLElement => !!c);
    expect(card).toBeTruthy();
    return card as HTMLElement;
  }

  it('Permissions: adding a verified user shows the MASKED id (no name, no full number)', async () => {
    mockReads();
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /Channels/ }));
    await waitFor(() => expect(screen.getByText(/Permissions — who can TRIGGER the agent/)).toBeTruthy());
    expandPermissions();

    const card = whatsappCard();
    fireEvent.change(within(card).getByPlaceholderText('Name (optional)'), { target: { value: 'Sam' } });
    fireEvent.change(within(card).getByPlaceholderText('Contact no / sender id, or Allow-All'), { target: { value: '+919999999999' } });
    fireEvent.click(within(card).getByRole('button', { name: /\+ User/ }));

    // The new chip shows the MASKED sender id with an UNSAVED marker (NOT
    // "pending" — that word is reserved for a Contact's approval status, and
    // reusing it here made unsaved edits look like a vanished approval) — the
    // personal name and the full number must NOT appear anywhere.
    expect(within(card).getByText(/\+91\*+.*· unsaved/)).toBeTruthy();
    expect(screen.queryByText('Sam')).toBeNull();
    expect(screen.queryByText('+919999999999')).toBeNull();
    expect(screen.queryByText('919999999999')).toBeNull();
    // The other saved users stay visible (masked too, no unsaved marker).
    expect(within(card).getAllByText(/91\*\*\*/).length).toBeGreaterThan(0);
  });

  it('Permissions: adding a user shows the UNSAVED banner until Save is pressed', async () => {
    mockReads();
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /Channels/ }));
    await waitFor(() => expect(screen.getByText(/Permissions — who can TRIGGER the agent/)).toBeTruthy());
    expandPermissions();

    // No unsaved banner before any edit.
    expect(screen.queryByText(/Unsaved changes/)).toBeNull();

    const card = whatsappCard();
    fireEvent.change(within(card).getByPlaceholderText('Name (optional)'), { target: { value: 'Sam' } });
    fireEvent.change(within(card).getByPlaceholderText('Contact no / sender id, or Allow-All'), { target: { value: '+919999999999' } });
    fireEvent.click(within(card).getByRole('button', { name: /\+ User/ }));

    // Draft edit → the banner appears, telling the user to press Save.
    expect(screen.getByText(/Unsaved changes/)).toBeTruthy();

    // Save persists and clears the banner (click the one INSIDE the banner).
    const save = vi.spyOn(dashboardAPI, 'saveGatewayPolicies').mockResolvedValue({ ok: true });
    const banner = screen.getByText(/Unsaved changes/).closest('.hub-unsaved-banner') as HTMLElement;
    fireEvent.click(within(banner).getByRole('button', { name: /Save permissions/ }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/Unsaved changes/)).toBeNull());
  });

  it('privacy: sender ids are masked by default; the admin toggle reveals full ids', async () => {
    mockReads();
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /Channels/ }));
    await waitFor(() => expect(screen.getByText(/Delivery ledger/)).toBeTruthy());
    // The fixture's numbers live in the permissions policies, which render
    // inside the collapsed section — expand it so masking is actually tested
    // (a collapsed panel would make "not found" pass vacuously).
    expandPermissions();

    // Masked by default — the full fixture number never appears.
    expect(screen.queryByText('+919876543210')).toBeNull();
    expect(screen.getAllByText(/\+91\*\*\*/).length).toBeGreaterThan(0);

    // Flip the admin-only toggle → full ids render (both fixture ids show).
    fireEvent.click(screen.getByRole('checkbox', { name: /Show full sender ids/ }));
    expect(screen.getAllByText('+919876543210').length).toBeGreaterThan(0);
    expect(screen.getAllByText('919999999999').length).toBeGreaterThan(0);
  });

  it('privacy: a viewer cannot toggle full sender ids', async () => {
    mockReads(HUB, { configured: true, authenticated: true, role: 'viewer' });
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /Channels/ }));
    await waitFor(() => expect(screen.getByText(/Delivery ledger/)).toBeTruthy());

    const toggle = screen.getByRole('checkbox', { name: /Show full sender ids/ }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
  });

  it('Permissions: removing ONE verified user keeps the rest of the saved list', async () => {
    // Regression: the draft is seeded from the SAVED list, so removing one
    // entry must not blank (and on save, silently delete) the others.
    mockReads();
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /Channels/ }));
    await waitFor(() => expect(screen.getByText(/Permissions — who can TRIGGER the agent/)).toBeTruthy());
    expandPermissions();

    const card = whatsappCard();
    // All ids render MASKED — remove the chip whose masked id is 91***.
    const maskedRows = within(card).getAllByText(/91\*\*\*/);
    const row = maskedRows[maskedRows.length - 1].closest('.hub-alias-row') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '✕' }));

    // The removed id is gone; at least one masked id remains.
    expect(within(card).queryByText(/\+91\*\*\*/)).toBeTruthy();
  });

  it('switches tabs — Channels shows the delivery ledger, Skills shows skills', async () => {
    mockReads();
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('tab', { name: /Channels/ }));
    await waitFor(() => expect(screen.getByText(/Delivery ledger/)).toBeTruthy());
    // Renders on both the ledger row and its stat tile, so assert presence.
    expect(screen.getAllByText('⏳ pending').length).toBeGreaterThan(0);
    // Every configured transport is surfaced. The hub payload's platform labels
    // render as chips on the Permissions cards, which are collapsed by default;
    // the transports TABLE is a separate component with its own suite.
    expandPermissions();
    expect(screen.getAllByText('Email (SMTP)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Signal (signal-cli-rest-api)').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: /Artifacts/ }));
    await waitFor(() => expect(screen.getByText(/deploy report/)).toBeTruthy());

    fireEvent.click(screen.getByRole('tab', { name: /Skills/ }));
    await waitFor(() => expect(screen.getByText('Fix lint')).toBeTruthy());
    // 'demo-fix' renders twice (skill name + id) — assert both are present.
    expect(screen.getAllByText('demo-fix')).toHaveLength(2);
  });

  it('Subagents: shows the provider, transport and refusal code each child reported', async () => {
    // P4.1 — a finished run is only explainable if the panel reports WHO served
    // it and HOW tool calls travelled; a refusal must show its typed code.
    mockReads();
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Subagents/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /Subagents/ }));

    await waitFor(() => expect(screen.getByText('summarise the deploy diff')).toBeTruthy());
    expect(screen.getByText(/openai · gpt-4o-mini/)).toBeTruthy();
    expect(screen.getByText('🛠 native transport')).toBeTruthy();
    expect(screen.getByText('The deploy adds two files.')).toBeTruthy();

    expect(screen.getByText('count the failing tests')).toBeTruthy();
    expect(screen.getByText('🛠 json transport')).toBeTruthy();
    expect(screen.getByText('not_configured')).toBeTruthy();
    expect(screen.getByText(/Refused before answering/)).toBeTruthy();
  });

  it('P6e — provenance badges: bundled skills get 🧠, user-added get community', async () => {
    mockReads();
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Skills/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /Skills/ }));
    await waitFor(() => expect(screen.getByText('🧠 bundled')).toBeTruthy());
    // Fix lint (bundled) → 🧠 badge; Custom X (user-added) → community badge.
    const bundledCards = screen.getAllByText('🧠 bundled');
    expect(bundledCards.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('community')).toBeTruthy();
  });

  it('P6d — marketplace: searches, shows results, and installs a skill', async () => {
    mockReads();
    const searchSpy = vi.spyOn(dashboardAPI, 'marketplaceSearch').mockResolvedValue([
      { name: 'code-assist', version: '1.2.0', description: 'Assist with code edits', author: 'nvidia', tags: ['code', 'assist'], source: 'git-repo:https://github.com/x/skills', sourceKind: 'git-repo' },
    ]);
    const installSpy = vi.spyOn(dashboardAPI, 'marketplaceInstall').mockResolvedValue({ ok: true });
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Skills/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /Skills/ }));
    await waitFor(() => expect(screen.getByPlaceholderText(/Search community skills/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Search community skills/), { target: { value: 'assist' } });
    fireEvent.submit(screen.getByPlaceholderText(/Search community skills/).closest('form')!);
    await waitFor(() => expect(searchSpy).toHaveBeenCalledWith('assist'));
    await waitFor(() => expect(screen.getByText('code-assist')).toBeTruthy());
    expect(screen.getByText(/v1\.2\.0 · git-repo/)).toBeTruthy();

    fireEvent.click(screen.getByText('⬇ Install'));
    await waitFor(() => expect(installSpy).toHaveBeenCalledWith('code-assist'));
    await waitFor(() => expect(screen.getByText(/Installed code-assist/)).toBeTruthy());
  });

  it('P6d — uninstalls a hub skill from the Skills list', async () => {
    mockReads();
    const uninstallSpy = vi.spyOn(dashboardAPI, 'marketplaceUninstall').mockResolvedValue({ ok: true });
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Skills/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /Skills/ }));
    await waitFor(() => expect(screen.getAllByText('demo-fix').length).toBeGreaterThanOrEqual(2));

    fireEvent.click(screen.getByText('🗑 Uninstall'));
    await waitFor(() => expect(uninstallSpy).toHaveBeenCalledWith('demo-fix'));
    await waitFor(() => expect(screen.getByText(/Uninstalled demo-fix/)).toBeTruthy());
  });
});

// ─── P4.1 — the Subagents tab is live while a run is in flight ────────────────
// A subagent reports `running` over IPC and only later `completed`/`failed`, so
// the panel re-reads the hub while something is running. Without that the row and
// the tab badge kept saying "running now" until the user pressed Refresh — the
// state a run is most useful in was the one that never updated.

describe('AgentHub — Subagents live refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A hub whose single run is still in flight. */
  const inFlight = (): HubData => ({
    ...HUB,
    subagents: {
      total: 1,
      running: 1,
      failed: 0,
      recent: [{
        id: 'cccccccc-3333-4333-8333-cccccccccccc',
        goal: 'summarise the deploy diff',
        status: 'running',
        provider: 'openai',
        model: 'gpt-4o-mini',
        transport: 'native',
        llmCalls: 1,
        toolCalls: 0,
        startedAt: Date.now(),
      }],
    },
  });

  /** The same hub, after the child reported its result. */
  const finished = (): HubData => ({
    ...HUB,
    subagents: {
      total: 1,
      running: 0,
      failed: 0,
      recent: [{
        ...inFlight().subagents.recent[0],
        status: 'completed',
        llmCalls: 2,
        toolCalls: 1,
        durationMs: 4000,
        resultPreview: 'The deploy adds two files.',
      }],
    },
  });

  it('re-reads while a run is in flight, shows the finished row, then stops polling', async () => {
    const { fetchHub } = mockReads(inFlight());
    render(<AgentHub />);
    // Let the mount fetch settle (the mock resolves on the microtask queue).
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // The tab badge counts runs, so it reports the live state without a click.
    expect(fetchHub).toHaveBeenCalledTimes(1);
    expect(screen.getByText('1/1')).toBeTruthy();

    // The child finishes between two ticks.
    fetchHub.mockResolvedValue(finished());
    await act(async () => { await vi.advanceTimersByTimeAsync(5000 + 50); });

    expect(fetchHub).toHaveBeenCalledTimes(2);
    expect(screen.getByText('0/1')).toBeTruthy();

    // The row itself is updated in place — the point of the poll.
    fireEvent.click(screen.getByRole('tab', { name: /Subagents/ }));
    expect(screen.getByText('✅ completed')).toBeTruthy();
    expect(screen.getByText('The deploy adds two files.')).toBeTruthy();

    // Nothing is running, so the interval is torn down rather than left ticking.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchHub).toHaveBeenCalledTimes(2);
  });
});

// ─── Standalone conversation export ──────────────────────────────────────────
// The export opens in a NEW window with no stylesheet. The bug this guards
// against is subtle: the document referenced the dashboard's tokens
// (`var(--bg-card)` and friends), which do not exist there, so every bubble
// painted transparent and the export looked unstyled. The document now bakes in
// concrete colours, and this suite fails if a token reference ever returns.

describe('AgentHub — standalone conversation export', () => {
  const PALETTE = {
    canvas: 'rgb(255, 255, 255)',
    text: 'rgb(17, 17, 17)',
    muted: 'rgb(85, 85, 85)',
    userBubble: 'rgb(0, 90, 200)',
    onUserBubble: 'rgb(255, 255, 255)',
    agentBubble: 'rgb(240, 240, 240)',
  };

  it('bakes the resolved palette in and references no dashboard token', () => {
    const html = buildConversationExportHtml(
      {
        displayName: 'Alex',
        platform: 'whatsapp',
        messageCount: 1,
        messages: [{ role: 'user', content: 'hello', ts: 0 }],
      },
      PALETTE,
      new Date(0),
    );

    // The whole point: a `var(--…)` here resolves to nothing in the blank window.
    expect(html).not.toMatch(/var\(--/);
    expect(html).toContain('background: rgb(0, 90, 200)');
    expect(html).toContain('background: rgb(240, 240, 240)');
    expect(html).toContain('color: rgb(255, 255, 255)');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<style>');
    expect(html).toContain('Conversation with Alex');
  });

  it('escapes message content and the contact name (no markup injection)', () => {
    const html = buildConversationExportHtml(
      {
        displayName: '<script>alert(1)</script>',
        platform: 'whatsapp',
        messageCount: 1,
        messages: [{ role: 'user', content: 'a < b & c > d', ts: 0 }],
      },
      PALETTE,
      new Date(0),
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &lt; b &amp; c &gt; d');
  });

  it('renders both roles with their own bubble class', () => {
    const html = buildConversationExportHtml(
      {
        displayName: 'Alex',
        platform: 'whatsapp',
        messageCount: 2,
        messages: [
          { role: 'user', content: 'ping', ts: 0 },
          { role: 'assistant', content: 'pong', ts: 0 },
        ],
      },
      PALETTE,
      new Date(0),
    );
    expect(html).toContain('class="msg msg-user"');
    expect(html).toContain('class="msg msg-assistant"');
    expect(html).toContain('class="bubble bubble-user"');
    expect(html).toContain('class="bubble bubble-assistant"');
  });

  it('falls back to CSS system colours when the theme tokens are absent', () => {
    // jsdom does not resolve custom properties, so this is exactly the "no
    // tokens" runtime — the case where the old code painted nothing at all.
    const palette = readConversationExportPalette(document.createElement('div'));
    expect(palette.canvas).toBe('Canvas');
    expect(palette.text).toBe('CanvasText');
    expect(palette.userBubble).toBe('Highlight');
    expect(palette.onUserBubble).toBe('HighlightText');
    expect(palette.agentBubble).toBe('ButtonFace');
  });
});
