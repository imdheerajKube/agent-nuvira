/**
 * QuotaPanel tests (Session 36 — user-declared daily budget).
 *
 * Covers: provider rows + the TPD callout, pre-fill of declared limits,
 * viewer read-only gating, admin save payload (routing.quota + cost cap),
 * and the operator partial permission (budget editable, cost cap locked).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import QuotaPanel from './QuotaPanel';
import { dashboardAPI } from '../api';
import type { AdminQuotaConfig } from '../types';

const QUOTA: AdminQuotaConfig = {
  ok: true,
  quota: { groq: { tokensPerWindow: 12000 } },
  costUsd: 0.1,
  providers: ['groq', 'gemini', 'local'],
};

function mockFetch(config: AdminQuotaConfig = QUOTA): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(dashboardAPI, 'fetchAdminQuota').mockResolvedValue(config);
}

describe('QuotaPanel', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders every provider row + the TPD callout', async () => {
    mockFetch();
    render(<QuotaPanel authed={false} role="viewer" />);
    expect(await screen.findByText(/Daily Budget/)).toBeTruthy();
    expect(screen.getByText('groq')).toBeTruthy();
    expect(screen.getByText('gemini')).toBeTruthy();
    expect(screen.getByText('local')).toBeTruthy();
    expect(screen.getByText(/tokens-per.*day/)).toBeTruthy();
  });

  it('pre-fills declared limits and the cost cap', async () => {
    mockFetch();
    render(<QuotaPanel authed={false} role="viewer" />);
    expect((await screen.findAllByDisplayValue('12000')).length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue('0.1')).toBeTruthy();
  });

  it('viewer sees read-only inputs and the read-only note', async () => {
    mockFetch();
    render(<QuotaPanel authed={true} role="viewer" />);
    const firstInput = (await screen.findAllByPlaceholderText('unset'))[0] as HTMLInputElement;
    expect(firstInput.disabled).toBe(true);
    expect(screen.getByText(/Read-only for/)).toBeTruthy();
    expect(screen.queryByText('💾 Save budget')).toBeNull();
  });

  it('admin can save — saveAdminQuota receives the declared budget', async () => {
    mockFetch();
    const save = vi.spyOn(dashboardAPI, 'saveAdminQuota').mockResolvedValue({ ok: true });
    render(<QuotaPanel authed={true} role="admin" />);
    fireEvent.change(await screen.findByDisplayValue('12000'), { target: { value: '20000' } });
    fireEvent.click(screen.getByText('💾 Save budget'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const payload = save.mock.calls[0][0] as { quota: Record<string, Record<string, number>>; costUsd: number };
    expect(payload.quota.groq.tokensPerWindow).toBe(20000);
    expect(payload.costUsd).toBe(0.1);
  });

  it('operator can edit budget fields but the cost cap input stays locked', async () => {
    mockFetch();
    render(<QuotaPanel authed={true} role="operator" />);
    await screen.findByDisplayValue('12000');
    expect(screen.getByText('💾 Save budget')).toBeTruthy();
    const costInput = screen.getByDisplayValue('0.1') as HTMLInputElement;
    expect(costInput.disabled).toBe(true);
  });

  it('operator save payload OMITS costUsd — the server gates it on policy.write (admin)', async () => {
    mockFetch();
    const save = vi.spyOn(dashboardAPI, 'saveAdminQuota').mockResolvedValue({ ok: true });
    render(<QuotaPanel authed={true} role="operator" />);
    fireEvent.change(await screen.findByDisplayValue('12000'), { target: { value: '9000' } });
    fireEvent.click(screen.getByText('💾 Save budget'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const payload = save.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.costUsd).toBeUndefined(); // operator must never send the cap
    const quota = payload.quota as Record<string, Record<string, number>>;
    expect(quota.groq.tokensPerWindow).toBe(9000);
  });
});
