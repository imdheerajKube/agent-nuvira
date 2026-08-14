/**
 * PlatformConfigSection tests — the Channels-tab transport config forms
 * (GUI parity with `buff config gateway`). Mocks the API, drives the expand →
 * edit → save → refresh flow, the remove flow, and the viewer gate.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { PlatformConfigSection } from './PlatformConfigSection';
import { dashboardAPI } from '../api';
import type { PlatformConfigEntry } from '../types';

const FIXTURES: PlatformConfigEntry[] = [
  {
    platform: 'telegram',
    label: 'Telegram',
    configured: true,
    envVars: [{ varName: 'BUFF_TELEGRAM_TOKEN', set: true, value: '123:ABC', prompt: 'Telegram bot token', secret: true }],
  },
  {
    platform: 'matrix',
    label: 'Matrix (homeserver API)',
    configured: false,
    envVars: [
      { varName: 'BUFF_MATRIX_HOMESERVER', set: false, value: '', prompt: 'Matrix homeserver base URL', secret: false },
      { varName: 'BUFF_MATRIX_ACCESS_TOKEN', set: false, value: '', prompt: 'Matrix access token', secret: true },
    ],
  },
];

function mockApi(overrides: { setResult?: { ok: boolean; error?: string } } = {}) {
  vi.spyOn(dashboardAPI, 'getPlatformConfigs').mockResolvedValue(FIXTURES);
  vi.spyOn(dashboardAPI, 'setPlatformConfig').mockResolvedValue(overrides.setResult ?? { ok: true });
  vi.spyOn(dashboardAPI, 'removePlatformConfig').mockResolvedValue({ ok: true });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.stubGlobal('confirm', undefined);
});

describe('PlatformConfigSection', () => {
  it('lists platforms with status and unset hints', async () => {
    mockApi();
    render(<PlatformConfigSection canWrite sessionExpired={() => {}} />);
    expect(await screen.findByText('Telegram')).toBeTruthy();
    expect(await screen.findByText('Matrix (homeserver API)')).toBeTruthy();
    expect(await screen.findByText('BUFF_TELEGRAM_TOKEN')).toBeTruthy();
  });

  it('expands a platform, saves edited values, and refreshes', async () => {
    mockApi();
    const sessionExpired = vi.fn();
    render(<PlatformConfigSection canWrite sessionExpired={sessionExpired} />);
    const configure = await screen.findAllByRole('button', { name: /⚙ Configure/ });
    fireEvent.click(configure[0]); // matrix (unconfigured)
    const urlInput = await screen.findByPlaceholderText('value');
    fireEvent.change(urlInput, { target: { value: 'https://matrix.org' } });
    fireEvent.click(screen.getByRole('button', { name: /💾 Save/ }));

    await waitFor(() => {
      expect(dashboardAPI.setPlatformConfig).toHaveBeenCalledWith('matrix', {
        BUFF_MATRIX_HOMESERVER: 'https://matrix.org',
        BUFF_MATRIX_ACCESS_TOKEN: '',
      });
    });
    expect(dashboardAPI.getPlatformConfigs).toHaveBeenCalledTimes(2); // initial + after save
    expect(sessionExpired).not.toHaveBeenCalled();
  });

  it('removes a configured platform after confirmation', async () => {
    vi.stubGlobal('confirm', () => true);
    mockApi();
    render(<PlatformConfigSection canWrite sessionExpired={() => {}} />);
    const edit = await screen.findAllByRole('button', { name: /✎ Edit/ });
    fireEvent.click(edit[0]); // telegram (configured)
    fireEvent.click(screen.getByRole('button', { name: /🗑 Remove/ }));
    await waitFor(() => {
      expect(dashboardAPI.removePlatformConfig).toHaveBeenCalledWith('telegram');
    });
  });

  it('disables configure/edit for viewers (no write access)', async () => {
    mockApi();
    render(<PlatformConfigSection canWrite={false} sessionExpired={() => {}} />);
    await screen.findByText('Telegram');
    const buttons = screen.getAllByRole('button');
    for (const b of buttons) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('surfaces save errors', async () => {
    mockApi({ setResult: { ok: false, error: 'Save failed.' } });
    render(<PlatformConfigSection canWrite sessionExpired={() => {}} />);
    const configure = await screen.findAllByRole('button', { name: /⚙ Configure/ });
    fireEvent.click(configure[0]);
    fireEvent.click(screen.getByRole('button', { name: /💾 Save/ }));
    expect(await screen.findByText(/Save failed/)).toBeTruthy();
  });

  it('triggers sessionExpired on an auth failure from save', async () => {
    mockApi();
    const authSpy = vi
      .spyOn(dashboardAPI, 'setPlatformConfig')
      .mockResolvedValue({ ok: false, error: 'Not authenticated.', unauthorized: true });
    const sessionExpired = vi.fn();
    render(<PlatformConfigSection canWrite sessionExpired={sessionExpired} />);
    const configure = await screen.findAllByRole('button', { name: /⚙ Configure/ });
    fireEvent.click(configure[0]);
    fireEvent.click(screen.getByRole('button', { name: /💾 Save/ }));
    await waitFor(() => expect(authSpy).toHaveBeenCalled());
    expect(sessionExpired).toHaveBeenCalled();
  });
});
