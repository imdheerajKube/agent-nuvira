/**
 * ProcessEnvPage tests — the curated switch page.
 *
 * Mocks the API and drives the parts that a generic NAME=VALUE editor could not
 * express: an on/off/unset control per switch, the canonical spelling sent to
 * the server, the shadowed badge when a shell value outranks the file, and the
 * read-only gate for a role the endpoint would refuse.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import ProcessEnvPage from './ProcessEnvPage';
import { dashboardAPI } from '../api';
import type { ProcessEnvVarRow } from '../types';

const ROWS: ProcessEnvVarRow[] = [
  {
    name: 'NUVIRA_ISOLATE',
    label: 'Isolate every turn',
    group: 'turn',
    kind: 'flag',
    rule: 'asks',
    description: 'Run each turn in its own git worktree of the project.',
    unsetMeans: 'A turn runs in the project directory itself.',
    cliEquivalent: 'nuvira chat --worktree',
    fileValue: null,
    processValue: null,
    state: 'unset',
    shadowed: false,
  },
  {
    name: 'NUVIRA_RESUME',
    label: 'Replay recorded steps',
    group: 'turn',
    kind: 'flag',
    rule: 'asks-or-names',
    acceptsValue: true,
    valueLabel: '…or a checkpoint id',
    placeholder: 'blank = this ask, in this directory',
    description: 'Replay the model calls of this ask whose input is unchanged.',
    unsetMeans: 'Nothing is replayed; every step is paid for.',
    fileValue: 'chat-abc123',
    processValue: 'chat-abc123',
    state: 'on',
    shadowed: false,
  },
  {
    name: 'NUVIRA_OTEL',
    label: 'Export OTLP spans',
    group: 'observability',
    kind: 'flag',
    rule: 'truthy',
    description: 'Export a span tree per turn over OTLP/HTTP.',
    unsetMeans: 'Nothing is built and the SDK is never imported.',
    fileValue: '0',
    processValue: '1',
    state: 'off',
    shadowed: true,
    warning: 'Export is on but no OTLP endpoint is set, so spans are built and then dropped.',
  },
  {
    name: 'NUVIRA_TOOL_HOOK_BEFORE',
    label: 'Before a tool call',
    group: 'hooks',
    kind: 'text',
    placeholder: 'node ~/deny-shell.mjs',
    description: 'A command run before each tool call.',
    unsetMeans: 'No before-hook.',
    fileValue: null,
    processValue: null,
    state: 'unset',
    shadowed: false,
  },
];

function mockApi(role = 'admin') {
  vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({
    configured: true,
    authenticated: true,
    role,
    user: role,
    mustChangePassword: false,
  });
  vi.spyOn(dashboardAPI, 'fetchProcessEnv').mockResolvedValue(ROWS.map((r) => ({ ...r })));
  vi.spyOn(dashboardAPI, 'saveProcessEnvVar').mockImplementation(async (name, value) => {
    const current = ROWS.find((r) => r.name === name)!;
    return { ok: true, row: { ...current, fileValue: value, processValue: value, state: 'on', shadowed: false } };
  });
  vi.spyOn(dashboardAPI, 'deleteProcessEnvVar').mockImplementation(async (name) => {
    const current = ROWS.find((r) => r.name === name)!;
    return { ok: true, removed: true, row: { ...current, fileValue: null, processValue: null, state: 'unset', shadowed: false } };
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ProcessEnvPage', () => {
  it('renders the curated switches with their state and what unset means', async () => {
    mockApi();
    render(<ProcessEnvPage />);

    expect(await screen.findByText('Turn behaviour')).toBeTruthy();
    expect(screen.getByText('Observability')).toBeTruthy();
    expect(screen.getByText('Tool hooks')).toBeTruthy();

    const isolate = within(screen.getByTestId('process-env-row-NUVIRA_ISOLATE'));
    expect(isolate.getByText('NUVIRA_ISOLATE')).toBeTruthy();
    expect(isolate.getByText('➖ Unset')).toBeTruthy();
    // A resume holding a record id is ON, and the stored id is shown rather than
    // hidden behind the word "on".
    expect(screen.getByText('✅ On (chat-abc123)')).toBeTruthy();
    expect(screen.getByText('Unset: A turn runs in the project directory itself.')).toBeTruthy();
    expect(screen.getByText(/nuvira chat --worktree/)).toBeTruthy();
  });

  it('turns a switch on by sending the canonical `1`, not the label', async () => {
    mockApi();
    render(<ProcessEnvPage />);
    await screen.findByText('NUVIRA_ISOLATE');

    fireEvent.click(screen.getAllByRole('button', { name: 'On' })[0]);

    await waitFor(() => expect(dashboardAPI.saveProcessEnvVar).toHaveBeenCalledWith('NUVIRA_ISOLATE', '1'));
    // The row the server sent back is adopted, so the page shows what was stored.
    expect(await screen.findByText('✅ On')).toBeTruthy();
  });

  it('sends `0` for off and unsets by deleting the line', async () => {
    mockApi();
    render(<ProcessEnvPage />);
    await screen.findByText('NUVIRA_ISOLATE');

    fireEvent.click(screen.getAllByRole('button', { name: 'Off' })[0]);
    await waitFor(() => expect(dashboardAPI.saveProcessEnvVar).toHaveBeenCalledWith('NUVIRA_ISOLATE', '0'));

    fireEvent.click(screen.getAllByRole('button', { name: 'Unset' })[0]);
    await waitFor(() => expect(dashboardAPI.deleteProcessEnvVar).toHaveBeenCalledWith('NUVIRA_ISOLATE'));
  });

  it('sends a typed hook command from its own Save button', async () => {
    mockApi();
    render(<ProcessEnvPage />);
    await screen.findByText('NUVIRA_TOOL_HOOK_BEFORE');

    fireEvent.change(screen.getByLabelText('NUVIRA_TOOL_HOOK_BEFORE value'), {
      target: { value: 'node ~/audit.mjs' },
    });
    fireEvent.click(screen.getByRole('button', { name: /💾 Save/ }));

    await waitFor(() =>
      expect(dashboardAPI.saveProcessEnvVar).toHaveBeenCalledWith('NUVIRA_TOOL_HOOK_BEFORE', 'node ~/audit.mjs'),
    );
  });

  it('says when a shell value outranks the file, and repeats a warning that is true', async () => {
    mockApi();
    render(<ProcessEnvPage />);

    expect(await screen.findByText('⚠️ shell value wins: 1')).toBeTruthy();
    expect(screen.getByText(/no OTLP endpoint is set/)).toBeTruthy();
    // The sentence is split by a <strong>, so match the emphasized half rather
    // than the whole: getByText matches one element's text, not a subtree's.
    expect(screen.getByText('wins over this file')).toBeTruthy();
  });

  it('gives a viewer the values and no way to change them', async () => {
    mockApi('viewer');
    render(<ProcessEnvPage />);
    await screen.findByText('NUVIRA_ISOLATE');

    expect(screen.getByText(/Read-only — admins and operators/)).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: 'On' })).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: 'Unset' })).toHaveLength(0);
    expect(screen.queryByLabelText('NUVIRA_TOOL_HOOK_BEFORE value')).toBeNull();
  });
});
