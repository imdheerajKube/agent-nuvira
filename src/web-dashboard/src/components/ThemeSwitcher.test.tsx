/**
 * ThemeSwitcher — behaviour AND accessibility.
 *
 * The accessibility half is not decoration here: the switcher is how a user
 * reaches the accessibility mode, so if its own groups are not announced or its
 * panel cannot be escaped from the keyboard, the feature is unreachable by
 * exactly the people it exists for. So these assert the semantics a screen
 * reader consumes — group legends, expanded state, the live announcement — and
 * the keyboard contract, not only that a click changes a colour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ThemeSwitcher from './ThemeSwitcher';
import { DEFAULT_THEME, PALETTE_LABELS, loadTheme } from '../theme';
import { setTheme } from '../useTheme';

/**
 * A minimal localStorage stand-in.
 *
 * NOT `localStorage.clear()`: this jsdom setup has no localStorage at all, so
 * "the choice persists" can only be asserted against storage we install. Same
 * approach as theme.test.ts, and it keeps the persistence assertion real rather
 * than skipped.
 */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: fakeStorage(),
    configurable: true,
    writable: true,
  });
  // The theme store is module-level, so it outlives an individual test's render.
  setTheme({ ...DEFAULT_THEME });
});

afterEach(() => {
  cleanup();
  if (realStorage) Object.defineProperty(globalThis, 'localStorage', realStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

const html = () => document.documentElement;
const trigger = () => screen.getByRole('button', { name: /appearance/i });
const openPanel = () => fireEvent.click(trigger());

describe('ThemeSwitcher — disclosure behaviour', () => {
  it('starts collapsed and reports that it is collapsed', () => {
    render(<ThemeSwitcher />);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group', { name: /palette/i })).toBeNull();
  });

  it('opens on click, reports expanded, and points aria-controls at the panel', () => {
    render(<ThemeSwitcher />);
    openPanel();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    const panelId = trigger().getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId!)).not.toBeNull();
  });

  it('is a disclosure, not a modal dialog', () => {
    // Pinned deliberately. A `role="dialog"` here would promise modality the
    // panel does not have — it needs no focus trap because the dashboard stays
    // usable behind it — and would leave a keyboard user hunting for the way out.
    render(<ThemeSwitcher />);
    openPanel();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes when a pointer lands outside it', () => {
    render(<ThemeSwitcher />);
    openPanel();
    fireEvent.pointerDown(document.body);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });
});

describe('ThemeSwitcher — group semantics', () => {
  it('wraps every option group in a fieldset with a legend', () => {
    // This is what makes NVDA/JAWS announce "Palette, Enterprise, radio button,
    // 1 of 5" instead of a bare list of unnamed radios.
    render(<ThemeSwitcher />);
    openPanel();
    for (const name of [/palette/i, /mode/i, /text size/i]) {
      expect(screen.getByRole('group', { name })).toBeTruthy();
    }
  });

  it('offers all five palettes as radios, with the current one checked', () => {
    render(<ThemeSwitcher />);
    openPanel();
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBeGreaterThanOrEqual(11); // 5 palettes + 2 modes + 4 scales
    const checked = radios.filter((r) => (r as HTMLInputElement).checked);
    expect(checked.length).toBe(3); // one per group
    expect((screen.getByRole('radio', { name: new RegExp(PALETTE_LABELS.enterprise) }) as HTMLInputElement).checked).toBe(true);
  });

  it('exposes accessibility mode as a switch-like checkbox, off by default', () => {
    render(<ThemeSwitcher />);
    openPanel();
    const toggle = screen.getByRole('checkbox', { name: /accessibility mode/i }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });
});

describe('ThemeSwitcher — applying and persisting a choice', () => {
  it('applies a palette to <html> and stores it', () => {
    render(<ThemeSwitcher />);
    openPanel();
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(PALETTE_LABELS.pastel) }));
    expect(html().getAttribute('data-palette')).toBe('pastel');
    expect(loadTheme().palette).toBe('pastel');
  });

  it('applies the mode', () => {
    render(<ThemeSwitcher />);
    openPanel();
    fireEvent.click(screen.getByRole('radio', { name: /^Light$/ }));
    expect(html().getAttribute('data-mode')).toBe('light');
  });

  it('applies the text size, turning on accessibility mode with it', () => {
    // Text size lives in the accessibility layer — resolveTheme pins it to 100%
    // while that layer is off. So choosing a larger size has to turn the layer
    // on, or the control would silently do nothing. Both halves are asserted
    // because either one alone passes while the feature is broken: the scale
    // could apply and then be wiped, or the switch could flip and the size stay
    // at 100%.
    render(<ThemeSwitcher />);
    openPanel();
    fireEvent.click(screen.getByRole('radio', { name: '150%' }));
    expect(html().getAttribute('data-font-scale')).toBe('150');
    expect(html().getAttribute('data-a11y')).toBe('on');
  });

  it('leaves accessibility mode alone when the untouched 100% is chosen', () => {
    render(<ThemeSwitcher />);
    openPanel();
    fireEvent.click(screen.getByRole('radio', { name: '100%' }));
    expect(html().getAttribute('data-a11y')).toBe('off');
  });

  it('turns accessibility mode on, and persists it', () => {
    render(<ThemeSwitcher />);
    openPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: /accessibility mode/i }));
    expect(html().getAttribute('data-a11y')).toBe('on');
    expect(loadTheme().a11y).toBe(true);
  });

  it('resets to the system default', () => {
    render(<ThemeSwitcher />);
    openPanel();
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(PALETTE_LABELS.contrast) }));
    expect(html().getAttribute('data-palette')).toBe('contrast');
    fireEvent.click(screen.getByRole('button', { name: /reset to system default/i }));
    expect(html().getAttribute('data-palette')).toBe(DEFAULT_THEME.palette);
    expect(loadTheme().a11y).toBe(false);
  });

  it('announces the resulting theme, not just the control that was pressed', () => {
    render(<ThemeSwitcher />);
    openPanel();
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(PALETTE_LABELS.executive) }));
    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(new RegExp(PALETTE_LABELS.executive, 'i'));
    expect(status.textContent).toMatch(/mode/i);
  });
});

describe('ThemeSwitcher — keyboard contract', () => {
  it('closes on Escape and returns focus to the trigger', () => {
    render(<ThemeSwitcher />);
    openPanel();
    const inPanel = screen.getAllByRole('radio')[0];
    inPanel.focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    // Without the focus restore, focus falls to <body> and the next Tab restarts
    // at the top of the document — the classic "where did my cursor go" bug.
    expect(document.activeElement).toBe(trigger());
  });

  it('moves focus into the panel when it opens', () => {
    render(<ThemeSwitcher />);
    openPanel();
    expect(document.activeElement).toBe(screen.getAllByRole('radio')[0]);
  });
});
