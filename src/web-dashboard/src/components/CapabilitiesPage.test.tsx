/**
 * CapabilitiesPage tests — the human view of the capability layer.
 *
 * Drives the three things the page exists to make visible: per-verb readiness
 * (a binary gap BLOCKS, a credential gap does NOT), the aggregated missing
 * executables, and the live session grants with their End action.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import CapabilitiesPage from './CapabilitiesPage';
import { dashboardAPI } from '../api';
import type { CapabilitiesData, SessionGrantInfo } from '../types';

const DATA: CapabilitiesData = {
  ok: true,
  readyCount: 2,
  blockedCount: 1,
  missingExecutables: [
    { forRefs: ['publish-package', 'publish-website'], anyOf: ['gh'], remedy: 'install one of: gh' },
  ],
  learnedCommands: [
    { verb: 'install java', os: 'macos', command: 'brew install openjdk', source: 'observed', learnedAt: 1 },
  ],
  verbs: [
    {
      id: 'action:install-package',
      ref: 'install-package',
      name: 'Install a project dependency',
      does: 'Install the packages a project already declares.',
      effect: 'local-state',
      reversible: true,
      grantable: 'terminal',
      ready: true,
      gaps: [],
      ask: [],
      onThisMachine: { command: 'npm install', binary: 'npm' },
    },
    {
      id: 'action:publish-package',
      ref: 'publish-package',
      name: 'Publish a package to a registry',
      does: 'Publish a release to npm/GitHub.',
      effect: 'external',
      reversible: false,
      grantable: 'external',
      ready: false,
      gaps: ['missing executable: gh — install one of: gh'],
      ask: ['bump type'],
    },
    {
      id: 'action:push-git',
      ref: 'push-git',
      name: 'Push to a git remote',
      does: 'Send commits to a remote.',
      effect: 'external',
      reversible: true,
      // A credential gap is reported but does NOT block — ready stays true.
      ready: true,
      gaps: ['credential not visible in the environment: GITHUB_TOKEN — or an SSH key'],
      ask: [],
    },
  ],
};

const GRANTS: SessionGrantInfo[] = [
  { sessionId: 'sess-1', categories: ['external'], grantedAt: 1, expiresAt: Date.now() + 60_000 },
];

function mockApi(role = 'admin') {
  vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({
    configured: true,
    authenticated: true,
    role,
    user: role,
    mustChangePassword: false,
  });
  vi.spyOn(dashboardAPI, 'fetchCapabilities').mockResolvedValue(structuredClone(DATA));
  vi.spyOn(dashboardAPI, 'fetchSessionGrants').mockResolvedValue(structuredClone(GRANTS));
  vi.spyOn(dashboardAPI, 'revokeSessionGrant').mockResolvedValue(true);
  vi.spyOn(dashboardAPI, 'saveLearnedCommand').mockResolvedValue({
    ok: true,
    commands: [{ verb: 'install java', os: 'macos', command: 'brew install openjdk', source: 'model', learnedAt: 2 }],
  });
  vi.spyOn(dashboardAPI, 'forgetLearnedCommand').mockResolvedValue({ ok: true, commands: [] });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CapabilitiesPage', () => {
  it('summarizes ready/blocked verbs, missing executables and live grants', async () => {
    mockApi();
    render(<CapabilitiesPage />);

    const summary = await screen.findByTestId('cap-summary');
    expect(summary).toBeDefined();
    expect(within(screen.getByTestId('cap-tile-ready')).getByText('2')).toBeDefined();
    expect(within(screen.getByTestId('cap-tile-blocked')).getByText('1')).toBeDefined();
    expect(within(screen.getByTestId('cap-tile-missing')).getByText(/missing executable/)).toBeDefined();
    expect(within(screen.getByTestId('cap-tile-grants')).getByText(/live session grant/)).toBeDefined();
  });

  it('lists the aggregated missing executables with the verbs that need them', async () => {
    mockApi();
    render(<CapabilitiesPage />);

    const missing = await screen.findByTestId('cap-missing');
    expect(within(missing).getByText('gh')).toBeDefined();
    expect(within(missing).getByText(/publish-package, publish-website/)).toBeDefined();
  });

  it('marks a binary gap as blocked and a credential gap as ready', async () => {
    mockApi();
    render(<CapabilitiesPage />);

    const blocked = await screen.findByTestId('cap-verb-publish-package');
    expect(within(blocked).getByText(/blocked/)).toBeDefined();
    expect(within(blocked).getByText(/missing executable: gh/)).toBeDefined();

    const cred = screen.getByTestId('cap-verb-push-git');
    expect(within(cred).getByText(/ready/)).toBeDefined();
    expect(within(cred).getByText(/credential not visible in the environment/)).toBeDefined();
  });

  it('shows the per-OS command where the OS decides it', async () => {
    mockApi();
    render(<CapabilitiesPage />);

    const verb = await screen.findByTestId('cap-verb-install-package');
    expect(within(verb).getByText('npm install')).toBeDefined();
  });

  it('ends a live session grant through the shared revoke endpoint', async () => {
    mockApi();
    render(<CapabilitiesPage />);

    const grant = await screen.findByTestId('cap-grant-sess-1');
    fireEvent.click(within(grant).getByRole('button', { name: /end/i }));

    await waitFor(() => expect(dashboardAPI.revokeSessionGrant).toHaveBeenCalledWith('sess-1'));
    await waitFor(() => expect(screen.queryByTestId('cap-grant-sess-1')).toBeNull());
  });

  it('shows the learned commands and forgets one through the endpoint', async () => {
    mockApi();
    render(<CapabilitiesPage />);

    const row = await screen.findByTestId('cap-learned-install java');
    expect(within(row).getByText('brew install openjdk')).toBeDefined();

    fireEvent.click(within(row).getByRole('button', { name: /forget/i }));
    await waitFor(() => expect(dashboardAPI.forgetLearnedCommand).toHaveBeenCalledWith('install java'));
    await waitFor(() => expect(screen.queryByTestId('cap-learned-install java')).toBeNull());
  });

  it('learns a command from the form (admin only)', async () => {
    mockApi();
    render(<CapabilitiesPage />);

    await screen.findByTestId('cap-learned');
    fireEvent.change(screen.getByLabelText('learned verb'), { target: { value: 'install java' } });
    fireEvent.change(screen.getByLabelText('learned command'), { target: { value: 'brew install openjdk' } });
    fireEvent.click(screen.getByRole('button', { name: /learn/i }));

    await waitFor(() =>
      expect(dashboardAPI.saveLearnedCommand).toHaveBeenCalledWith('install java', 'brew install openjdk', undefined),
    );
  });

  it('hides the learned-command form for a read-only role', async () => {
    mockApi('viewer');
    render(<CapabilitiesPage />);

    await screen.findByTestId('cap-learned');
    expect(screen.queryByLabelText('learned verb')).toBeNull();
    expect(screen.getByText(/Read-only/)).toBeDefined();
  });
});
