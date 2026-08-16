/**
 * Agent Hub panel tests (I4 + I5).
 *
 * - 4 tabs render from the /api/hub payload (Tools/Channels/Artifacts/Skills).
 * - An authenticated admin/operator can toggle a toolset — the switch calls
 *   setToolsetEnabled and the panel re-reads.
 * - An unauthenticated user is routed through the login gate, then the queued
 *   toggle is applied.
 * - Reads degrade to a friendly error, never a crash.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import AgentHub from './AgentHub';
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
      whatsapp: { allowedUsers: ['+918178504516', '919999999999'], silentDrop: true },
    },
    contacts: [{ name: 'Daddy', platform: 'whatsapp', id: '+918178504516', addedAt: Date.now() }],
    statusRecipients: [],
    statusRecipientDisplay: {},
    inbox: {
      total: 0,
      pipeline: 0,
      chat: 0,
      help: 0,
      refused: 0,
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
    compiled: [{ id: 'skill-fix-lint', name: 'Fix lint', description: 'Fixes lint errors', version: '1.0.0', origin: 'compiled', usageCount: 3 }],
    hub: [{ id: 'demo-fix', name: 'demo-fix', description: 'Fix a demo issue', origin: 'hub' }],
    total: 2,
  },
  adminConfigured: true,
  serverTime: 123,
};

/** The panel's mount-time fetches (hub + auth status). */
function mockReads(payload: HubData | null = HUB, auth: { configured: boolean; authenticated: boolean; role?: string } = { configured: true, authenticated: true, role: 'admin' }) {
  vi.spyOn(dashboardAPI, 'fetchHub').mockResolvedValue(payload);
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
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setAdminToken(null);
});

describe('AgentHub', () => {
  it('renders the 4 tabs with counts from the hub payload', async () => {
    mockReads();
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
    expect(screen.getByRole('tab', { name: /Channels/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Artifacts/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Skills/ })).toBeTruthy();
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

  /** The whatsapp card on the Permissions section (scoped — the label also renders in the transports list). */
  function whatsappCard(): HTMLElement {
    const card = screen
      .getAllByText('WhatsApp (Baileys bridge)')
      .map((el) => el.closest('.hub-card'))
      .find((c): c is HTMLElement => !!c);
    expect(card).toBeTruthy();
    return card as HTMLElement;
  }

  it('Permissions: adding a verified user as Name + Contact No shows a named chip', async () => {
    mockReads();
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /Channels/ }));
    await waitFor(() => expect(screen.getByText(/Saved contacts \(validated list\)/)).toBeTruthy());

    const card = whatsappCard();
    fireEvent.change(within(card).getByPlaceholderText('Name (e.g. Daddy) — optional'), { target: { value: 'Mom' } });
    fireEvent.change(within(card).getByPlaceholderText('Contact no / sender id, or Allow-All'), { target: { value: '+919818293808' } });
    fireEvent.click(within(card).getByRole('button', { name: /\+ User/ }));

    // Named chip on the verified list + a row in the Saved contacts table.
    expect(within(card).getByText(/Mom \(\+919818293808\).*pending/)).toBeTruthy();
    expect(screen.getByText('Mom')).toBeTruthy();
    expect(screen.getByText('+919818293808')).toBeTruthy();
    // The other saved users stay visible (saved ones have no pending marker).
    expect(within(card).getByText(/Daddy \(\+918178504516\)/)).toBeTruthy();
    expect(within(card).getByText('919999999999')).toBeTruthy();
  });

  it('Permissions: adding a user shows the UNSAVED banner until Save is pressed', async () => {
    mockReads();
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /Channels/ }));
    await waitFor(() => expect(screen.getByText(/Saved contacts \(validated list\)/)).toBeTruthy());

    // No unsaved banner before any edit.
    expect(screen.queryByText(/Unsaved changes/)).toBeNull();

    const card = whatsappCard();
    fireEvent.change(within(card).getByPlaceholderText('Name (e.g. Daddy) — optional'), { target: { value: 'Mom' } });
    fireEvent.change(within(card).getByPlaceholderText('Contact no / sender id, or Allow-All'), { target: { value: '+919818293808' } });
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

  it('Permissions: removing ONE verified user keeps the rest of the saved list', async () => {
    // Regression: the draft is seeded from the SAVED list, so removing one
    // entry must not blank (and on save, silently delete) the others.
    mockReads();
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /Channels/ }));
    await waitFor(() => expect(screen.getByText(/Saved contacts \(validated list\)/)).toBeTruthy());

    const card = whatsappCard();
    const row = within(card).getByText('919999999999').closest('.hub-alias-row') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '✕' }));

    // The removed id is gone; the other saved user is still visible.
    expect(within(card).queryByText('919999999999')).toBeNull();
    expect(within(card).getByText(/918178504516/)).toBeTruthy();
  });

  it('switches tabs — Channels shows the delivery ledger, Skills shows skills', async () => {
    mockReads();
    render(<AgentHub />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('tab', { name: /Channels/ }));
    await waitFor(() => expect(screen.getByText(/Delivery ledger/)).toBeTruthy());
    expect(screen.getByText('⏳ pending')).toBeTruthy();
    // Platform transports section shows the I6 adapters (the label also
    // appears as a chip on the Permissions cards below).
    expect(screen.getAllByText('Email (SMTP)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Signal (signal-cli-rest-api)').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: /Artifacts/ }));
    await waitFor(() => expect(screen.getByText(/deploy report/)).toBeTruthy());

    fireEvent.click(screen.getByRole('tab', { name: /Skills/ }));
    await waitFor(() => expect(screen.getByText('Fix lint')).toBeTruthy());
    // 'demo-fix' renders twice (skill name + id) — assert both are present.
    expect(screen.getAllByText('demo-fix')).toHaveLength(2);
  });
});
