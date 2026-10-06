/**
 * HooksPage — the dashboard face of the declarative hook contract.
 *
 * The page is the only place an operator can see what will fire and what it can
 * do, so these tests pin: the seam/action vocabulary is shown, declared hooks
 * render with a readable summary, a new hook is a DRAFT until Save (no silent
 * write), and a viewer cannot edit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

import { dashboardAPI } from '../api';
import HooksPage, { parseArgsMatch, describeHook } from './HooksPage';
import type { HookDeclaration, HooksData } from '../types';

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

function makeData(hooks: HookDeclaration[] = []): HooksData {
  return {
    file: '/home/u/.nuvira/hooks.json',
    hooks,
    events: ['before_tool_call', 'after_tool_call', 'failed_tool_call', 'on_session_end'],
    eventDescriptions: {
      before_tool_call: 'Runs BEFORE a tool call. The only seam that can DENY (stop) the call.',
      after_tool_call: 'Runs after a tool call SUCCEEDS, with the result text and duration.',
      failed_tool_call: 'Runs after a tool call FAILS (threw, or returned a failure), with the error.',
      on_session_end: 'Runs when a pipeline run finishes, with its success flag and summary.',
    },
    actionKinds: ['deny', 'notify', 'scan-args'],
    actionDescriptions: {
      deny: 'Stop the tool call. Only available on before_tool_call.',
      notify: 'Write a line to the log.',
      'scan-args': 'Scan the call arguments (or the tool result) for secret-shaped values.',
    },
  };
}

function mockAuth(role: 'admin' | 'operator' | 'viewer' = 'admin', authenticated = true) {
  vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({
    configured: true, authenticated, role, user: 'd', mustChangePassword: false,
  });
}

const BLOCK: HookDeclaration = {
  id: 'block-rm-rf', label: 'Block rm -rf', event: 'before_tool_call', enabled: true,
  when: { tool: 'run_terminal', argsMatch: { command: 'rm -rf*' } },
  action: { kind: 'deny', reason: 'destructive' },
};

describe('HooksPage — vocabulary and declaration rendering', () => {
  it('shows the four seams and what each means', async () => {
    mockAuth();
    vi.spyOn(dashboardAPI, 'fetchHooks').mockResolvedValue(makeData());
    render(<HooksPage />);
    await waitFor(() => expect(screen.getByText(/The only seam that can DENY/)).toBeTruthy());
    // The seam name appears in both the vocabulary table and the event picker.
    expect(screen.getAllByText('on_session_end').length).toBeGreaterThan(0);
    expect(screen.getAllByText('scan-args').length).toBeGreaterThan(0);
  });

  it('states the positioning: a hook cannot execute code', async () => {
    mockAuth();
    vi.spyOn(dashboardAPI, 'fetchHooks').mockResolvedValue(makeData());
    render(<HooksPage />);
    await waitFor(() => expect(screen.getByText(/no third-party script/i)).toBeTruthy());
  });

  it('renders a declared hook with a readable summary', async () => {
    mockAuth();
    vi.spyOn(dashboardAPI, 'fetchHooks').mockResolvedValue(makeData([BLOCK]));
    render(<HooksPage />);
    await waitFor(() => expect(screen.getByTestId('hook-row-block-rm-rf')).toBeTruthy());
    expect(screen.getByText(/tool run_terminal · command=rm -rf\*/)).toBeTruthy();
    expect(screen.getByText(/deny: destructive/)).toBeTruthy();
  });
});

describe('HooksPage — editing', () => {
  it('adds a hook as a DRAFT (no write until Save)', async () => {
    mockAuth();
    vi.spyOn(dashboardAPI, 'fetchHooks').mockResolvedValue(makeData());
    const save = vi.spyOn(dashboardAPI, 'saveHooks').mockResolvedValue({ ok: true, hooks: [] });
    render(<HooksPage />);
    // The add form renders only once the (async) auth check says admin/operator.
    await waitFor(() => expect(screen.getByLabelText('Hook id')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Hook id'), { target: { value: 'warn-writes' } });
    fireEvent.change(screen.getByLabelText('Hook label'), { target: { value: 'Warn on writes' } });
    fireEvent.change(screen.getByLabelText('Hook action'), { target: { value: 'notify' } });
    fireEvent.click(screen.getByText(/Add to draft/));

    await waitFor(() => expect(screen.getByTestId('hook-row-warn-writes')).toBeTruthy());
    // Adding must NOT have written anything yet.
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Save hooks/ }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0][0];
    expect(saved.map((h) => h.id)).toEqual(['warn-writes']);
    expect(saved[0].action.kind).toBe('notify');
  });

  it('reports a refused save instead of pretending it worked', async () => {
    mockAuth();
    vi.spyOn(dashboardAPI, 'fetchHooks').mockResolvedValue(makeData([BLOCK]));
    vi.spyOn(dashboardAPI, 'saveHooks').mockResolvedValue({ ok: false, error: 'Access denied.', forbidden: true });
    render(<HooksPage />);
    await waitFor(() => expect(screen.getByTestId('hook-row-block-rm-rf')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Save hooks/ }));
    await waitFor(() => expect(screen.getByText(/Access denied\./)).toBeTruthy());
  });

  it('is read-only for a viewer (no add form, no save)', async () => {
    mockAuth('viewer');
    vi.spyOn(dashboardAPI, 'fetchHooks').mockResolvedValue(makeData([BLOCK]));
    render(<HooksPage />);
    await waitFor(() => expect(screen.getByTestId('hook-row-block-rm-rf')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Save hooks/ })).toBeNull();
    expect(screen.queryByText(/Add to draft/)).toBeNull();
    expect(screen.getByText(/Read-only/)).toBeTruthy();
  });
});

describe('HooksPage helpers', () => {
  it('parseArgsMatch reads key=glob lines and ignores blanks', () => {
    expect(parseArgsMatch('command=rm -rf*\n\n  path=*secret*  ')).toEqual({ command: 'rm -rf*', path: '*secret*' });
    expect(parseArgsMatch('')).toBeUndefined();
    expect(parseArgsMatch('nonsense')).toBeUndefined();
  });

  it('describeHook covers every action kind', () => {
    expect(describeHook(BLOCK)).toMatch(/deny: destructive/);
    expect(describeHook({ ...BLOCK, action: { kind: 'notify', message: 'hi' }, when: undefined })).toBe('every call → notify: hi');
    expect(describeHook({ ...BLOCK, action: { kind: 'scan-args', denyOnHit: true } })).toMatch(/deny on hit/);
  });
});
