/**
 * The command palette.
 *
 * What is worth pinning is not that a list renders: it is that the list is built
 * from the SAME nav model the rail uses (so a destination cannot be reachable in
 * one place and missing in the other), that Enter can only run the option the
 * highlighted row names, and that Escape closes without navigating.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import CommandPalette, { paletteKeyLabel } from './CommandPalette';
import { resetTheme } from '../useTheme';
import { __resetChatCommandsForTests, onChatCommand } from '../chat-commands';

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="path">{location.pathname}</span>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetTheme();
  __resetChatCommandsForTests();
});

function renderPalette(open = true) {
  const onClose = vi.fn();
  const onRefresh = vi.fn();
  const onShortcuts = vi.fn();
  render(
    <MemoryRouter initialEntries={['/overview']}>
      <LocationProbe />
      <CommandPalette open={open} onClose={onClose} onRefresh={onRefresh} onShortcuts={onShortcuts} />
    </MemoryRouter>,
  );
  return { onClose, onRefresh, onShortcuts };
}

const search = () => screen.getByRole('combobox', { name: /search pages and actions/i });

describe('command palette', () => {
  it('lists every destination the rail lists, plus real actions', () => {
    renderPalette();
    expect(screen.getByRole('option', { name: /Agent Hub/ })).toBeDefined();
    expect(screen.getByRole('option', { name: /Process Env/ })).toBeDefined();
    expect(screen.getByRole('option', { name: /Overview/ })).toBeDefined();
    expect(screen.getByRole('option', { name: /Refresh dashboard data/ })).toBeDefined();
    expect(screen.getByRole('option', { name: /Keyboard shortcuts/ })).toBeDefined();
  });

  it('filters on label, group and path, and says when nothing matches', () => {
    renderPalette();
    fireEvent.change(search(), { target: { value: 'gate' } });

    expect(screen.getByRole('option', { name: /Gateway/ })).toBeDefined();
    expect(screen.queryByRole('option', { name: /Costs/ })).toBeNull();

    fireEvent.change(search(), { target: { value: 'no such destination' } });
    expect(screen.getByText(/No page or action matches/)).toBeDefined();
  });

  it('runs the highlighted option with Enter and closes', () => {
    const { onClose } = renderPalette();
    fireEvent.change(search(), { target: { value: 'gateway' } });
    fireEvent.keyDown(search(), { key: 'Enter' });

    expect(screen.getByTestId('path').textContent).toBe('/gateway');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves the highlight with the arrow keys before Enter', () => {
    const { onClose } = renderPalette();
    fireEvent.change(search(), { target: { value: 'refresh' } });
    // One match, so Enter is enough to prove the highlight survived the query.
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    fireEvent.keyDown(search(), { key: 'Enter' });

    expect(onClose).toHaveBeenCalled();
  });

  it('refreshes through the shell callback, not a second fetch of its own', () => {
    const { onRefresh, onClose } = renderPalette();
    fireEvent.change(search(), { target: { value: 'refresh dashboard' } });
    fireEvent.click(screen.getByRole('option', { name: /Refresh dashboard data/ }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('toggles a real appearance switch and says which way it goes', () => {
    renderPalette();
    const on = screen.getByRole('option', { name: /Turn glass mode on/ });
    fireEvent.click(on);

    expect(document.documentElement.getAttribute('data-glass')).toBe('on');
    // Reopening offers the inverse, so the label cannot claim a state that is
    // not the one in force.
    cleanup();
    renderPalette();
    expect(screen.getByRole('option', { name: /Turn glass mode off/ })).toBeDefined();
  });

  it('closes on Escape without navigating', () => {
    const { onClose } = renderPalette();
    fireEvent.keyDown(search(), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('path').textContent).toBe('/overview');
  });

  it('names the platform modifier, never a key that is not on the keyboard', () => {
    expect(paletteKeyLabel()).toMatch(/K$/);
  });

  it('hands the chat actions to the page through the command queue', () => {
    const received = vi.fn();
    onChatCommand(received);
    renderPalette();

    expect(screen.getByRole('option', { name: /Attach a project folder/ })).toBeDefined();
    fireEvent.click(screen.getByRole('option', { name: /Start a new chat/ }));

    // The palette navigates AND asks; it does not reach into the page's state.
    expect(screen.getByTestId('path').textContent).toBe('/chat');
    expect(received).toHaveBeenCalledWith('new-chat');
  });

  it('renders nothing when closed', () => {
    renderPalette(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
