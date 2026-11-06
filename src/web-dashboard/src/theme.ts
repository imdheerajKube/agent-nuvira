/**
 * Theme state — which palette, which mode, and whether help was asked for.
 *
 * WHY THIS IS A SEPARATE MODULE. The theme has to be correct before React
 * renders (otherwise the dashboard paints the wrong colours and then flickers to
 * the right ones), and it has to be correct in tests that never mount the app.
 * So the resolution rules are plain functions over `document.documentElement`,
 * and the React hook is a thin subscription on top.
 *
 * THE RULES, and why each one:
 *
 *  - `mode` defaults to `system`, which FOLLOWS the operating system's
 *    `prefers-color-scheme` — not a snapshot of it taken on first visit. Someone
 *    who has told their OS they need dark should not have to tell us too, and
 *    should not have to re-tell us at dusk either.
 *  - `palette` defaults to `enterprise`, the reference design. It is NOT chosen
 *    from the OS because there is no OS setting for "which of seven enterprise
 *    palettes", and inventing one would be pretending.
 *  - `a11y` defaults to OFF, deliberately. The accessibility mode enlarges type
 *    and targets and removes motion; it is help, not the product. Defaulting it
 *    on would impose a reduced experience on the majority who do not need it.
 *    What is NOT behind the opt-in is respecting the OS: `prefers-reduced-motion`
 *    and `prefers-contrast` are honoured in CSS unconditionally, because those
 *    ARE the user telling us.
 *  - `glass`, `compact` and `motion` default to OFF, OFF and ON. Glass mode and
 *    a compact layout are LOOKS — they change how the same dashboard is drawn,
 *    so nobody gets a translucency or a tighter rhythm they did not ask for.
 *    Motion is the opposite: the designed interface animates, and switching it
 *    off is the deviation, so the switch reads "Animation effects" and starts on.
 *  - Everything persists per browser, and every stored value is RE-VALIDATED on
 *    read: a value from an older release must not be able to put the dashboard
 *    into a state that has no styles for it.
 */

export const PALETTES = ['enterprise', 'neutral', 'pastel', 'executive', 'contrast', 'premium', 'premium-amoled'] as const;
export type Palette = (typeof PALETTES)[number];

export const MODES = ['light', 'dark', 'system'] as const;
/**
 * The user's CHOICE: a fixed mode, or "follow the OS".
 *
 * Kept separate from the mode actually painted on `<html>` (`ResolvedMode`)
 * because "system" is not a colour scheme — a stylesheet has blocks for light
 * and dark and none for "system". `applyTheme` resolves it, and that is the only
 * place the two are allowed to be confused.
 */
export type Mode = (typeof MODES)[number];
/** What `data-mode` can actually be: a system choice is resolved to one of these. */
export type ResolvedMode = 'light' | 'dark';

export const FONT_SCALES = [100, 112, 125, 150] as const;
export type FontScale = (typeof FONT_SCALES)[number];

export interface ThemeState {
  palette: Palette;
  mode: Mode;
  /** The opt-in help layer: bigger targets, no motion, stronger borders. */
  a11y: boolean;
  /** Only meaningful while `a11y` is on; 100 is the identity. */
  fontScale: FontScale;
  /** Frosted-glass surfaces: semi-transparent panels over a blurred backdrop. */
  glass: boolean;
  /** Tighter spacing and smaller targets, for more rows on one screen. */
  compact: boolean;
  /** The designed animations. Off is the deviation, hence the default. */
  motion: boolean;
}

/** Human labels, so the switcher and the docs cannot drift from the list. */
export const PALETTE_LABELS: Record<Palette, string> = {
  enterprise: 'Enterprise',
  neutral: 'Neutral',
  pastel: 'Pastel',
  executive: 'Executive',
  contrast: 'High contrast',
  premium: 'Premium',
  'premium-amoled': 'Premium AMOLED',
};

const STORAGE_KEY = 'nuvira.dashboard.theme';

export const DEFAULT_THEME: ThemeState = {
  palette: 'enterprise',
  // The FALLBACK mode, not the default choice — `systemDefaultTheme` asks for
  // `system`. This is what a runtime with no `matchMedia` gets, where following
  // the OS is not an option because there is no OS preference to read.
  mode: 'dark',
  a11y: false,
  fontScale: 100,
  glass: false,
  compact: false,
  motion: true,
};

function includes<T extends readonly unknown[]>(list: T, value: unknown): value is T[number] {
  return (list as readonly unknown[]).includes(value);
}

/**
 * Report the OS colour preference, or `null` when the runtime cannot say.
 *
 * The `null` is the whole point. Expressed as a truthy chain this reads:
 *
 *   const prefersDark = typeof window !== 'undefined'
 *     && typeof window.matchMedia === 'function'
 *     && window.matchMedia('(prefers-color-scheme: dark)').matches;
 *
 * which returns `false` both for "the OS asks for light" and for "there is no
 * matchMedia here" — so the ternary below would hand a bare runtime LIGHT mode
 * by accident. Absence of information is not a preference, so it is kept apart.
 */
function prefersDarkScheme(): boolean | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * The palette and mode a first-time visitor gets.
 *
 * Follows the OS rather than forcing dark. That was gated for a long time on the
 * tokenization pass, for a good reason: `dashboard.css` held 334 literal hex
 * values and the components ~950 more, all written for a dark UI, so a light
 * palette rendered them white-on-white. They are all tokens now —
 * `token-coverage.test.ts` fails if one returns, and `theme-contrast.test.ts`
 * computes 4.5:1 / 3:1 against all fourteen themes.
 *
 * Deliberately NOT covered: the one frame before this module runs, which
 * themes.css's `:root` fallback serves and which is therefore always enterprise
 * dark. That reasoning is written out in themes.css rather than left implicit.
 */
export function systemDefaultTheme(): ThemeState {
  // `system`, not a snapshot of the OS at this instant. "Reset to system default"
  // used to freeze whichever mode the machine happened to have at that moment,
  // so a user who reset at dusk was stuck in dark at breakfast with no way to
  // say "keep following it". The stored choice is now the intent; the resolution
  // happens on every apply (`effectiveMode`) and again whenever the OS flips.
  return { ...DEFAULT_THEME, mode: 'system' };
}

/**
 * The mode to PAINT for a chosen mode.
 *
 * A fixed choice is itself. `system` asks the OS, and falls back to
 * `DEFAULT_THEME.mode` where the runtime cannot answer — absence of information
 * is not a preference, and `data-mode` must never be missing or `"system"`,
 * because neither has a block of colours and the dashboard would paint the
 * `:root` fallback while the switcher claimed something else.
 */
export function effectiveMode(mode: Mode): ResolvedMode {
  if (mode !== 'system') return mode;
  const prefersDark = prefersDarkScheme();
  if (prefersDark === null) return DEFAULT_THEME.mode as ResolvedMode;
  return prefersDark ? 'dark' : 'light';
}

/**
 * Read the stored theme, validating every field.
 *
 * Unknown values fall back ONE FIELD AT A TIME rather than discarding the whole
 * record: a release that renames a palette must not also reset the user's mode
 * and font size.
 */
export function loadTheme(): ThemeState {
  const fallback = systemDefaultTheme();
  if (typeof localStorage === 'undefined') return fallback;

  let raw: unknown;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return fallback;
    raw = JSON.parse(stored);
  } catch {
    // Corrupt JSON is a reason to use the default, not to throw on boot.
    return fallback;
  }

  if (typeof raw !== 'object' || raw === null) return fallback;
  const candidate = raw as Partial<Record<keyof ThemeState, unknown>>;

  const fontScale = includes(FONT_SCALES, candidate.fontScale) ? candidate.fontScale : fallback.fontScale;

  return normalizeTheme({
    palette: includes(PALETTES, candidate.palette) ? candidate.palette : fallback.palette,
    mode: includes(MODES, candidate.mode) ? candidate.mode : fallback.mode,
    a11y: typeof candidate.a11y === 'boolean' ? candidate.a11y : fallback.a11y,
    fontScale,
    glass: typeof candidate.glass === 'boolean' ? candidate.glass : fallback.glass,
    compact: typeof candidate.compact === 'boolean' ? candidate.compact : fallback.compact,
    motion: typeof candidate.motion === 'boolean' ? candidate.motion : fallback.motion,
  });
}

export function saveTheme(theme: ThemeState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
  } catch {
    // Private mode / quota. The theme still applies for this session, so this
    // is not worth interrupting the user over.
  }
}

/**
 * Put the theme on `<html>`.
 *
 * On `<html>`, not `<body>`: the attributes must be in place before first paint
 * and must apply to the `html` element's own background, otherwise a light
 * palette shows a dark strip behind a short page. `color-scheme` is set too, so
 * scrollbars and form controls follow the mode instead of staying stubbornly
 * light — a detail that otherwise looks like a bug in dark mode.
 */
export function applyTheme(theme: ThemeState, root?: HTMLElement): void {
  const el = root ?? (typeof document !== 'undefined' ? document.documentElement : undefined);
  if (!el) return;

  // `system` is resolved HERE and nowhere else, so `data-mode` is always a mode
  // the stylesheet has colours for and `color-scheme` is always a real one.
  const mode = effectiveMode(theme.mode);
  el.setAttribute('data-palette', theme.palette);
  el.setAttribute('data-mode', mode);
  el.setAttribute('data-a11y', theme.a11y ? 'on' : 'off');
  el.setAttribute('data-font-scale', String(theme.fontScale));
  el.setAttribute('data-glass', theme.glass ? 'on' : 'off');
  el.setAttribute('data-compact', theme.compact ? 'on' : 'off');
  el.setAttribute('data-motion', theme.motion ? 'on' : 'off');
  el.style.colorScheme = mode;
}

/**
 * The rules that make one field depend on another, in one place.
 *
 * Both `loadTheme` and `resolveTheme` end here rather than repeating them, so a
 * value restored from an older release gets the same treatment as one the user
 * just chose. That matters for the a11y/motion pair specifically: a stored theme
 * from before the motion switch existed has `a11y: true` and no `motion` field,
 * and would otherwise restore as "accessibility mode with all animations on".
 */
function normalizeTheme(next: ThemeState): ThemeState {
  // A font scale is help; it means nothing outside the help layer, and leaving a
  // stale 150% on the state would enlarge type the moment a11y was switched back
  // on without the user asking for it again.
  if (!next.a11y) next.fontScale = 100;
  // Accessibility mode removes motion as part of what it promises. The switch is
  // disabled in that state rather than hidden, so the coupling is visible.
  if (next.a11y) next.motion = false;
  return next;
}

/** Merge a partial change, clamp it, apply it and persist it. */
export function resolveTheme(current: ThemeState, patch: Partial<ThemeState>): ThemeState {
  return normalizeTheme({
    palette: includes(PALETTES, patch.palette) ? patch.palette : current.palette,
    mode: includes(MODES, patch.mode) ? patch.mode : current.mode,
    a11y: typeof patch.a11y === 'boolean' ? patch.a11y : current.a11y,
    fontScale: includes(FONT_SCALES, patch.fontScale) ? patch.fontScale : current.fontScale,
    glass: typeof patch.glass === 'boolean' ? patch.glass : current.glass,
    compact: typeof patch.compact === 'boolean' ? patch.compact : current.compact,
    motion: typeof patch.motion === 'boolean' ? patch.motion : current.motion,
  });
}
