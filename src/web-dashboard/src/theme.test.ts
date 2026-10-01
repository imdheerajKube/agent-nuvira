/**
 * @vitest-environment jsdom
 *
 * The theme resolver decides what a user sees on every page load, and it runs
 * before React, outside any component test — so it needs its own.
 *
 * The rules worth pinning are the ones that are easy to get subtly wrong and
 * invisible when wrong:
 *
 *  - a stored value from an older release must not be trusted into a state that
 *    has no styles for it (validation, and validation PER FIELD so renaming one
 *    palette does not also wipe the user's mode and font size);
 *  - corrupt JSON must fall back rather than throw during boot;
 *  - the light default must stay OFF until the hardcoded-colour conversion is
 *    finished, because turning it on early renders white-on-white text.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  DEFAULT_THEME,
  FONT_SCALES,
  PALETTES,
  applyTheme,
  loadTheme,
  resolveTheme,
  saveTheme,
  systemDefaultTheme,
  type ThemeState,
} from './theme';

const STORAGE_KEY = 'nuvira.dashboard.theme';

/** A minimal, real localStorage stand-in, independent of the test environment. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    dump: () => Object.fromEntries(map),
  };
}

let storage: ReturnType<typeof fakeStorage>;
const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

beforeEach(() => {
  storage = fakeStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  if (realStorage) Object.defineProperty(globalThis, 'localStorage', realStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('theme — defaults', () => {
  it('ships all five palettes and the four font steps', () => {
    expect(PALETTES).toEqual(['enterprise', 'neutral', 'pastel', 'executive', 'contrast']);
    expect(FONT_SCALES).toEqual([100, 112, 125, 150]);
  });

  it('defaults to the reference palette, accessibility help OFF, font scale 100', () => {
    expect(DEFAULT_THEME.palette).toBe('enterprise');
    expect(DEFAULT_THEME.a11y).toBe(false);
    expect(DEFAULT_THEME.fontScale).toBe(100);
  });
});

/**
 * The first-run default is now the OS preference.
 *
 * Previously the dashboard forced dark regardless, because a light default would
 * have rendered the hardcoded near-white text colours as white-on-white. That
 * conversion is finished, so the flag flipped — and these tests exist so that
 * "finished" stays a claim with evidence behind it rather than an assertion in a
 * comment. They also cover the two ways a first-run default goes wrong silently:
 * a runtime without matchMedia, and a fallback that returns `undefined` instead
 * of a mode.
 */
describe('theme — the first-run default follows the OS', () => {
  const realMatchMedia = window.matchMedia;

  function stubPrefersDark(matches: boolean): void {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query.includes('dark') ? matches : !matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: realMatchMedia,
    });
  });

  it('gives a light machine the light palette', () => {
    stubPrefersDark(false);
    expect(systemDefaultTheme()).toEqual({ ...DEFAULT_THEME, mode: 'light' });
  });

  it('gives a dark machine the dark palette', () => {
    stubPrefersDark(true);
    expect(systemDefaultTheme()).toEqual({ ...DEFAULT_THEME, mode: 'dark' });
  });

  it('changes ONLY the mode — never the palette or the accessibility settings', () => {
    stubPrefersDark(false);
    const theme = systemDefaultTheme();
    expect(theme.palette).toBe(DEFAULT_THEME.palette);
    expect(theme.a11y).toBe(DEFAULT_THEME.a11y);
    expect(theme.fontScale).toBe(DEFAULT_THEME.fontScale);
  });

  it('falls back to the dark default where matchMedia is unavailable', () => {
    // A bare runtime, or one where matchMedia was removed. This must not throw,
    // and must not yield `mode: undefined` — which would leave <html> without a
    // data-mode and silently strand the dashboard on the :root fallback.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    expect(systemDefaultTheme().mode).toBe(DEFAULT_THEME.mode);
  });
});

describe('theme — persistence', () => {
  it('round-trips a saved theme', () => {
    const theme: ThemeState = { palette: 'pastel', mode: 'light', a11y: true, fontScale: 125 };
    saveTheme(theme);
    expect(loadTheme()).toEqual(theme);
  });

  it('falls back when nothing is stored', () => {
    expect(loadTheme()).toEqual(systemDefaultTheme());
  });

  it('falls back rather than throwing on corrupt JSON', () => {
    storage.setItem(STORAGE_KEY, '{not json');
    expect(() => loadTheme()).not.toThrow();
    expect(loadTheme()).toEqual(systemDefaultTheme());
  });

  it('rejects an unknown palette but KEEPS the other fields', () => {
    // The per-field rule: a release that renames a palette must not also reset
    // the user's mode and font size as collateral.
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ palette: 'neon', mode: 'light', a11y: true, fontScale: 150 }),
    );
    expect(loadTheme()).toEqual({
      palette: DEFAULT_THEME.palette,
      mode: 'light',
      a11y: true,
      fontScale: 150,
    });
  });

  it('rejects a font scale that is not one of the four steps', () => {
    storage.setItem(STORAGE_KEY, JSON.stringify({ palette: 'neutral', mode: 'dark', fontScale: 137 }));
    expect(loadTheme().fontScale).toBe(DEFAULT_THEME.fontScale);
  });

  it('ignores a non-boolean a11y flag', () => {
    storage.setItem(STORAGE_KEY, JSON.stringify({ palette: 'neutral', mode: 'dark', a11y: 'yes' }));
    expect(loadTheme().a11y).toBe(DEFAULT_THEME.a11y);
  });
});

describe('theme — resolveTheme', () => {
  const base: ThemeState = { palette: 'enterprise', mode: 'dark', a11y: false, fontScale: 100 };

  it('applies only the fields it is given', () => {
    expect(resolveTheme(base, { mode: 'light' })).toEqual({ ...base, mode: 'light' });
  });

  it('clamps an invalid patch instead of letting it through', () => {
    // Cast through unknown: the point is a value that arrives from outside the
    // type system (localStorage, a stale bundle, a script), not one TypeScript
    // would have rejected.
    const bad = { palette: 'neon', fontScale: 999 } as unknown as Partial<ThemeState>;
    expect(resolveTheme(base, bad)).toEqual(base);
  });

  it('clears a stale font scale when accessibility mode is turned off', () => {
    // Otherwise a 150% scale lies dormant and re-enlarges the UI the next time
    // a11y is switched on, with no input from the user.
    const scaled = resolveTheme(base, { a11y: true, fontScale: 150 });
    expect(scaled.fontScale).toBe(150);
    const off = resolveTheme(scaled, { a11y: false });
    expect(off.a11y).toBe(false);
    expect(off.fontScale).toBe(100);
  });
});

describe('theme — applyTheme', () => {
  it('puts every axis on the element as data attributes', () => {
    const el = document.createElement('div');
    applyTheme({ palette: 'contrast', mode: 'light', a11y: true, fontScale: 150 }, el);
    expect(el.getAttribute('data-palette')).toBe('contrast');
    expect(el.getAttribute('data-mode')).toBe('light');
    expect(el.getAttribute('data-a11y')).toBe('on');
    expect(el.getAttribute('data-font-scale')).toBe('150');
    // So native scrollbars and form controls follow the mode.
    expect(el.style.colorScheme).toBe('light');
  });

  it('writes off/on rather than true/false for the accessibility axis', () => {
    const el = document.createElement('div');
    applyTheme({ ...DEFAULT_THEME, a11y: false }, el);
    expect(el.getAttribute('data-a11y')).toBe('off');
  });
});
