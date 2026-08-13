/**
 * P2 — WhatsAppPanel tests (in-page pairing UI).
 *
 * The panel renders the bridge pairing state, gates pair/cancel/unpair behind
 * the admin session + routing.operate, and shows the live QR / pairing code
 * while a session is active. API calls are mocked — no server, no network.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import WhatsAppPanel from './WhatsAppPanel';
import { dashboardAPI, setAdminToken } from '../api';
import type { WhatsAppPairStatus } from '../types';

const IDLE: WhatsAppPairStatus = {
  state: 'idle',
  paired: false,
  sessionDir: '/tmp/wa-session',
  qr: null,
  qrRaw: null,
  pairingCode: null,
  phone: null,
  error: null,
  startedAt: null,
};

const PAIRED: WhatsAppPairStatus = { ...IDLE, state: 'paired', paired: true };

const PAIRING_QR: WhatsAppPairStatus = {
  ...IDLE,
  state: 'pairing',
  qr: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
  qrRaw: '2@payload',
  startedAt: Date.now(),
};

function mockStatus(status: WhatsAppPairStatus | null) {
  vi.spyOn(dashboardAPI, 'getWhatsAppStatus').mockResolvedValue(status);
  vi.spyOn(dashboardAPI, 'subscribeWhatsApp').mockReturnValue(() => {});
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setAdminToken(null);
});

describe('WhatsAppPanel', () => {
  it('shows the idle state with a pair button for an admin', async () => {
    mockStatus(IDLE);
    render(<WhatsAppPanel authed canWrite sessionExpired={() => {}} />);
    await waitFor(() => expect(screen.getByText('Not paired')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Pair with a QR/ })).toBeTruthy();
    expect(screen.getByPlaceholderText(/918800663237/)).toBeTruthy();
    // The pair-by-number button is disabled until a number is typed.
    expect(screen.getByRole('button', { name: 'Pair by number' })).toHaveProperty('disabled', true);
  });

  it('gates writes behind the admin session', async () => {
    mockStatus(IDLE);
    render(<WhatsAppPanel authed={false} canWrite={false} sessionExpired={() => {}} />);
    await waitFor(() => expect(screen.getByText('Not paired')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Pair with a QR/ })).toBeNull();
    expect(screen.getByText(/Log in \(admin or operator\)/)).toBeTruthy();
  });

  it('lets a viewer read status but not change it', async () => {
    mockStatus(PAIRED);
    render(<WhatsAppPanel authed canWrite={false} sessionExpired={() => {}} />);
    await waitFor(() => expect(screen.getByText('✅ Paired')).toBeTruthy());
    expect(screen.getByText(/can view pairing status but not change it/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Unpair/ })).toBeNull();
  });

  it('renders the live QR image during a pairing session', async () => {
    mockStatus(PAIRING_QR);
    render(<WhatsAppPanel authed canWrite sessionExpired={() => {}} />);
    await waitFor(() => expect(screen.getByAltText('WhatsApp pairing QR code')).toBeTruthy());
    const img = screen.getByAltText('WhatsApp pairing QR code') as HTMLImageElement;
    expect(img.src).toContain('data:image/png;base64');
    expect(screen.getByRole('button', { name: /Cancel pairing/ })).toBeTruthy();
  });

  it('starts a QR pairing on button click', async () => {
    mockStatus(IDLE);
    const start = vi.spyOn(dashboardAPI, 'startWhatsAppPair').mockResolvedValue({ ok: true });
    render(<WhatsAppPanel authed canWrite sessionExpired={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Pair with a QR/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Pair with a QR/ }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(undefined));
  });

  it('starts a phone pairing with the typed number', async () => {
    mockStatus(IDLE);
    const start = vi.spyOn(dashboardAPI, 'startWhatsAppPair').mockResolvedValue({ ok: true });
    render(<WhatsAppPanel authed canWrite sessionExpired={() => {}} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/918800663237/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/918800663237/), { target: { value: '918800663237' } });
    const btn = screen.getByRole('button', { name: 'Pair by number' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(start).toHaveBeenCalledWith('918800663237'));
  });

  it('offers unpair when paired', async () => {
    mockStatus(PAIRED);
    const unpair = vi.spyOn(dashboardAPI, 'unpairWhatsApp').mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<WhatsAppPanel authed canWrite sessionExpired={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Unpair/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Unpair/ }));
    await waitFor(() => expect(unpair).toHaveBeenCalled());
  });
});
