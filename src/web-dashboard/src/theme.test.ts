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
  effectiveMode,
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
  it('ships all seven palettes and the four font steps', () => {
    expect(PALETTES).toEqual(['enterprise', 'neutral', 'pastel', 'executive', 'contrast', 'premium', 'premium-amoled']);
    expect(FONT_SCALES).toEqual([100, 112, 125, 150]);
  });

  it('defaults to the reference palette, accessibility help OFF, font scale 100', () => {
    expect(DEFAULT_THEME.palette).toBe('enterprise');
    expect(DEFAULT_THEME.a11y).toBe(false);
    expect(DEFAULT_THEME.fontScale).toBe(100);
  });

  it('defaults both LOOK switches off and motion on', () => {
    // Glass and compact are looks, so nobody gets them without asking. Motion is
    // the opposite: the designed dashboard animates, and switching it off is the
    // deviation — so the switch starts on.
    expect(DEFAULT_THEME.glass).toBe(false);
    expect(DEFAULT_THEME.compact).toBe(false);
    expect(DEFAULT_THEME.motion).toBe(true);
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

  it('asks for SYSTEM mode instead of freezing whatever the machine has right now', () => {
    // The choice is the intent, not a snapshot: a user who resets at dusk should
    // not be stuck in dark at breakfast. So the stored mode is `system` whatever
    // the OS says, and the RESOLUTION is what follows it.
    stubPrefersDark(false);
    expect(systemDefaultTheme().mode).toBe('system');
    expect(effectiveMode('system')).toBe('light');

    stubPrefersDark(true);
    expect(systemDefaultTheme().mode).toBe('system');
    expect(effectiveMode('system')).toBe('dark');
  });

  it('leaves a fixed choice alone when the OS asks for something else', () => {
    stubPrefersDark(true);
    expect(effectiveMode('light')).toBe('light');
    stubPrefersDark(false);
    expect(effectiveMode('dark')).toBe('dark');
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
    // `system` is still a valid choice; it just resolves to the fallback, because
    // absence of information is not a preference.
    expect(systemDefaultTheme().mode).toBe('system');
    expect(effectiveMode(systemDefaultTheme().mode)).toBe(DEFAULT_THEME.mode);
  });
});

describe('theme — persistence', () => {
  it('round-trips a saved theme', () => {
    const theme: ThemeState = {
      palette: 'pastel',
      mode: 'light',
      a11y: false,
      fontScale: 100,
      glass: true,
      compact: true,
      motion: false,
    };
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
      glass: DEFAULT_THEME.glass,
      compact: DEFAULT_THEME.compact,
      // Not the DEFAULT (true): a stored theme from before the switch existed
      // says a11y on, and accessibility mode removes motion.
      motion: false,
    });
  });

  it('migrates a stored theme from before the look switches existed', () => {
    // The real upgrade path: `{palette, mode, a11y, fontScale}` is exactly what
    // the previous release wrote. The missing fields must take defaults rather
    // than load as `undefined`, and the a11y/motion coupling must still hold.
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ palette: 'executive', mode: 'system', a11y: false, fontScale: 100 }),
    );
    expect(loadTheme()).toEqual({
      palette: 'executive',
      mode: 'system',
      a11y: false,
      fontScale: 100,
      glass: false,
      compact: false,
      motion: true,
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
  const base: ThemeState = {
    palette: 'enterprise',
    mode: 'dark',
    a11y: false,
    fontScale: 100,
    glass: false,
    compact: false,
    motion: true,
  };

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

  it('removes motion when accessibility mode is turned on', () => {
    // Accessibility mode promises "no motion" as part of what it is, so the two
    // switches cannot be left disagreeing: one of them has to win, and it is the
    // one the user turned on for accessibility reasons.
    const on = resolveTheme(base, { a11y: true });
    expect(on.motion).toBe(false);
    expect(resolveTheme(on, { motion: true }).motion).toBe(false);
  });

  it('leaves the look switches independent of each other', () => {
    const glass = resolveTheme(base, { glass: true });
    expect(glass.glass).toBe(true);
    expect(glass.compact).toBe(false);
    expect(resolveTheme(glass, { compact: true })).toMatchObject({
      glass: true,
      compact: true,
      motion: true,
    });
  });

  it('ignores a non-boolean look switch', () => {
    const bad = { glass: 'on', compact: 1, motion: null } as unknown as Partial<ThemeState>;
    expect(resolveTheme(base, bad)).toEqual(base);
  });
});

describe('theme — applyTheme', () => {
  it('puts every axis on the element as data attributes', () => {
    const el = document.createElement('div');
    applyTheme(
      {
        palette: 'contrast',
        mode: 'light',
        a11y: true,
        fontScale: 150,
        glass: true,
        compact: false,
        motion: false,
      },
      el,
    );
    expect(el.getAttribute('data-palette')).toBe('contrast');
    expect(el.getAttribute('data-mode')).toBe('light');
    expect(el.getAttribute('data-a11y')).toBe('on');
    expect(el.getAttribute('data-font-scale')).toBe('150');
    // The stylesheet keys glass, compact and motion off these three, so an
    // attribute that is missing (rather than "off") silently does nothing.
    expect(el.getAttribute('data-glass')).toBe('on');
    expect(el.getAttribute('data-compact')).toBe('off');
    expect(el.getAttribute('data-motion')).toBe('off');
    // So native scrollbars and form controls follow the mode.
    expect(el.style.colorScheme).toBe('light');
  });

  it('resolves a system choice before writing data-mode', () => {
    // `data-mode='system'` would match no palette block and no code-block block,
    // so the whole dashboard would paint the :root fallback while the switcher
    // reported the user's choice. The attribute is always a real colour scheme.
    const el = document.createElement('div');
    applyTheme({ ...DEFAULT_THEME, mode: 'system' }, el);
    const written = el.getAttribute('data-mode');
    expect(['light', 'dark']).toContain(written);
    expect(el.style.colorScheme).toBe(written);
    expect(el.getAttribute('data-motion')).toBe('on');
  });

  it('writes off/on rather than true/false for the accessibility axis', () => {
    const el = document.createElement('div');
    applyTheme({ ...DEFAULT_THEME, a11y: false }, el);
    expect(el.getAttribute('data-a11y')).toBe('off');
  });
});
