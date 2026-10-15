/**
 * Runtime Tools panel tests.
 *
 * The panel is the place a user copies an install command from, so the
 * assertions that matter are the honest ones: an installed tool shows no
 * command, a missing one shows the command for THIS machine, a missing tool with
 * no one-liner says so instead of inventing one, a tool that needs a password is
 * named as such rather than offered as a button, and a server that did not
 * report the list says that instead of rendering an empty panel.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import RuntimeToolsPanel from './RuntimeToolsPanel';
import type { RuntimeTool } from '../types';

function tool(over: Partial<RuntimeTool> & Pick<RuntimeTool, 'id' | 'label'>): RuntimeTool {
  return {
    need: 'recommended',
    present: false,
    enables: 'Encode frames and edit video.',
    neededBy: ['motion_render'],
    installCommand: 'brew install ffmpeg-full',
    needsHumanInput: false,
    ...over,
  };
}

const tools: RuntimeTool[] = [
  tool({ id: 'ffmpeg', label: 'FFmpeg' }),
  tool({
    id: 'chromium',
    label: 'Chromium (Playwright)',
    present: true,
    installCommand: 'npx playwright install chromium',
  }),
  tool({
    id: 'edge-tts',
    label: 'edge-tts',
    need: 'optional',
    installCommand: 'pip3 install --user edge-tts',
  }),
  // A tool with no recipe on this OS — the case that must never be silent.
  tool({ id: 'poppler', label: 'Poppler (PDF rasteriser)', need: 'optional', installCommand: null }),
  // A tool whose install needs a password the server cannot supply.
  tool({
    id: 'sudo-tool',
    label: 'Needs Sudo',
    installCommand: 'sudo apt-get install -y ffmpeg',
    needsHumanInput: true,
  }),
];

describe('RuntimeToolsPanel', () => {
  it('lists every tool with its status, and shows the command only when it is missing', () => {
    render(<RuntimeToolsPanel tools={tools} summary="3 of 5 optional tools installed" />);

    expect(screen.getByTestId('runtime-tools-summary').textContent).toContain(
      '3 of 5 optional tools installed',
    );
    expect(screen.getByTestId('runtime-tool-ffmpeg').dataset.status).toBe('warn');
    expect(screen.getByTestId('runtime-tool-chromium').dataset.status).toBe('pass');

    // The missing one carries its command…
    expect(screen.getByTestId('install-ffmpeg').textContent).toContain('brew install ffmpeg-full');
    // …an installed one carries none (there is nothing to install).
    expect(screen.queryByTestId('install-chromium')).toBeNull();
    expect(screen.getByTestId('runtime-tool-chromium').textContent).toContain('Needed by: motion_render');
  });

  it('says so when no one-line installer applies, instead of inventing one', () => {
    render(<RuntimeToolsPanel tools={tools} summary="s" />);
    const row = screen.getByTestId('install-poppler').textContent ?? '';
    expect(row).toContain('No one-line installer on this OS');
    expect(row).toContain('DEPENDENCIES.md');
  });

  it('hands a password-requiring install to the user rather than offering it', () => {
    render(<RuntimeToolsPanel tools={tools} summary="s" />);
    const row = screen.getByTestId('install-sudo-tool').textContent ?? '';
    expect(row).toContain('sudo apt-get install -y ffmpeg');
    expect(row).toContain('Needs your password');
    // A tool the server CAN drive offers the command that does it.
    expect(screen.getByTestId('install-ffmpeg').textContent).toContain('nuvira doctor --fix');
  });

  it('counts the recommended tools separately, because those are the ones that matter', () => {
    render(<RuntimeToolsPanel tools={tools} summary="s" />);
    const hint = screen.getByTestId('runtime-tools-hint').textContent ?? '';
    expect(hint).toContain('2 recommended tools missing');
    expect(hint).toContain('FFmpeg');
    expect(hint).toContain('Needs Sudo');
  });

  it('states that the server did not report the list (an empty panel would read as "all installed")', () => {
    render(<RuntimeToolsPanel tools={undefined} summary={undefined} />);
    expect(screen.queryByTestId('runtime-tools-summary')).toBeNull();
    expect(screen.getByTestId('runtime-tools').textContent).toContain('did not report the runtime tools');
  });

  it('marks every tool installed with no hint line when nothing is missing', () => {
    const all = tools.map((t) => ({ ...t, present: true }));
    render(<RuntimeToolsPanel tools={all} summary="5 of 5 optional tools installed" />);
    expect(screen.getByTestId('runtime-tools-summary').textContent).toContain('5 of 5');
    expect(screen.queryByTestId('runtime-tools-hint')).toBeNull();
  });

  describe('copy button', () => {
    let writeText: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    });

    it('copies the exact command the row shows', async () => {
      render(<RuntimeToolsPanel tools={tools} summary="s" />);
      const copy = screen.getByTestId('copy-brew install');
      fireEvent.click(copy);
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('brew install ffmpeg-full'));
      await waitFor(() => expect(copy.textContent).toContain('Copied'));
    });

    it('claims NOTHING when the clipboard is unavailable (non-secure context)', async () => {
      // `navigator.clipboard?.writeText(...)` resolves to undefined where the API
      // is absent, which is not a copy — so the label must stay on "Copy".
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      render(<RuntimeToolsPanel tools={tools} summary="s" />);
      await act(async () => {
        fireEvent.click(screen.getByTestId('copy-brew install'));
      });
      expect(screen.getByTestId('copy-brew install').textContent).toContain('Copy');
      expect(screen.getByTestId('copy-brew install').textContent).not.toContain('Copied');
    });
  });
});
