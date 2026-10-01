/**
 * Every theme must be readable, and that is a measurement, not an opinion.
 *
 * WHY THIS TEST EXISTS. Adding five palettes x light/dark turns "does this look
 * good?" into "are these ten colour sets legible?", which no reviewer can check
 * by eye — the pastel accent that passed on white is invisible on the pastel
 * canvas, and eyeballing ten themes x twelve pairings is exactly the kind of
 * work that silently stops being done. So the palettes are READ OUT OF THE
 * STYLESHEET and every pairing a user actually looks at is computed here.
 *
 * The alternative — trusting the numbers I typed — is what produces a light
 * theme that ships and then gets reported as "the grey text is unreadable".
 *
 * Contrast is computed from the WCAG 2.2 relative-luminance formula, so these
 * assertions are the standard itself, not a proxy for it.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Locate themes.css by walking up from the working directory.
 *
 * NOT `new URL('./themes.css', import.meta.url)`: under the jsdom environment
 * vitest rewrites import.meta.url to a non-file URL and readFileSync throws
 * "The URL must be of scheme file". Walking up also means this passes whether
 * the run started in `src/web-dashboard` or at the repository root.
 */
function findThemesCss(): string {
  let dir = process.cwd();
  for (let hop = 0; hop < 8; hop++) {
    const candidate = resolve(dir, 'src', 'styles', 'themes.css');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`themes.css not found walking up from ${process.cwd()}`);
}

const CSS = readFileSync(findThemesCss(), 'utf8');

// ─── WCAG 2.2 relative luminance + contrast ─────────────────────────────────

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const raw = hex.trim().replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`);
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG contrast ratio, 1..21. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ─── Read the palettes out of the stylesheet ────────────────────────────────

/** Only the palette section — the later at-rules redefine tokens contextually. */
const paletteSection = CSS.split('── 5. SYSTEM PREFERENCES')[0];

interface Theme {
  palette: string;
  mode: string;
  tokens: Record<string, string>;
}

function readThemes(): Theme[] {
  const themes: Theme[] = [];
  for (const match of paletteSection.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1];
    const body = match[2];
    const paletteMatch = selector.match(/data-palette='([a-z]+)'/);
    const modeMatch = selector.match(/data-mode='([a-z]+)'/);
    if (!paletteMatch || !modeMatch) continue;
    if (selector.includes('data-a11y') || selector.includes('data-font-scale')) continue;

    const tokens: Record<string, string> = {};
    for (const decl of body.matchAll(/(--p-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      tokens[decl[1]] = decl[2].trim();
    }
    themes.push({ palette: paletteMatch[1], mode: modeMatch[1], tokens });
  }
  return themes;
}

const THEMES = readThemes();

/** Pairings a user actually looks at, with the standard that applies to each. */
const TEXT_PAIRS: Array<[string, string, string]> = [
  ['--p-ink', '--p-surface', 'body text on a card'],
  ['--p-ink', '--p-canvas', 'body text on the page'],
  ['--p-ink', '--p-raised', 'body text on a raised surface'],
  ['--p-ink-2', '--p-surface', 'secondary text on a card'],
  ['--p-ink-2', '--p-canvas', 'secondary text on the page'],
  ['--p-ink-3', '--p-surface', 'muted text on a card'],
  ['--p-ink-3', '--p-canvas', 'muted text on the page'],
  ['--p-accent', '--p-surface', 'links and accent text'],
  ['--p-accent', '--p-canvas', 'accent text on the page'],
  // The sheet sets `color: var(--accent-blue)` (and cyan/purple) as TEXT in
  // dozens of places, so they belong in the text set rather than only appearing
  // as decoration. Adding them found one real miss: pastel/light's --p-info sat
  // at 4.44:1 on its canvas, which is under the standard and over the "looks
  // fine" line.
  ['--p-info', '--p-surface', 'accent-blue text'],
  ['--p-info', '--p-canvas', 'accent-blue text on the page'],
  ['--p-cyan', '--p-surface', 'accent-cyan text'],
  ['--p-cyan', '--p-canvas', 'accent-cyan text on the page'],
  ['--p-purple', '--p-surface', 'accent-purple text'],
  ['--p-purple', '--p-canvas', 'accent-purple text on the page'],
  ['--p-ok', '--p-surface', 'success text'],
  ['--p-warn', '--p-surface', 'warning text'],
  ['--p-danger', '--p-surface', 'error text'],
  ['--p-chrome-ink', '--p-chrome', 'sidebar nav text'],
  ['--p-chrome-ink-2', '--p-chrome', 'sidebar secondary text'],
  ['--p-on-accent', '--p-accent', 'button label on an accent button'],
];

/**
 * REQUIRED by WCAG 2.2 1.4.11 (non-text contrast, AA): a focus indicator, and
 * the boundary that identifies a control, must reach 3:1 against what is behind
 * them. A keyboard user who cannot see the ring cannot use the dashboard, so
 * these are hard failures.
 */
const REQUIRED_UI_PAIRS: Array<[string, string, string]> = [
  ['--p-focus', '--p-surface', 'focus ring on a card'],
  ['--p-focus', '--p-canvas', 'focus ring on the page'],
  ['--p-focus-chrome', '--p-chrome', 'focus ring in the sidebar'],
  ['--p-line-control', '--p-surface', 'control boundary (input / select edge)'],
  ['--p-line-control', '--p-canvas', 'control boundary on the page'],
];

/**
 * NOT required to reach 3:1, and asserting that they must would be a
 * misreading of the standard.
 *
 * 1.4.11 covers visual information needed to identify components and STATES. An
 * ornamental card hairline and a sidebar divider carry no information a user
 * needs in order to operate anything — demanding 3:1 of them would force the
 * heavy borders that make enterprise dashboards feel like forms, and would
 * fight the reference design for no accessibility gain.
 *
 * It is not a free pass either. A separator set to the same colour as its
 * background is a separator that has been silently deleted, and the cards stop
 * reading as cards — so they must at least be perceptible. THAT is the guard.
 */
const DECORATIVE_PAIRS: Array<[string, string, string]> = [
  ['--p-line', '--p-surface', 'card hairline'],
  ['--p-line', '--p-canvas', 'page divider'],
  ['--p-chrome-line', '--p-chrome', 'sidebar divider'],
];

const AA_TEXT = 4.5;
const AA_UI = 3;
const PERCEPTIBLE = 1.25;

/**
 * Composite a translucent accent over a background, the way a browser does.
 *
 * Alpha compositing happens in gamma-encoded sRGB, so this mixes the encoded
 * channels rather than the linearised ones.
 */
function composite(fg: string, bg: string, alpha: number): string {
  const channels = (hex: string) => {
    const raw = hex.trim().replace('#', '');
    const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
    return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16));
  };
  const [r1, g1, b1] = channels(fg);
  const [r2, g2, b2] = channels(bg);
  const mix = (a: number, b: number) => Math.round(a * alpha + b * (1 - alpha));
  return (
    '#' +
    [mix(r1, r2), mix(g1, g2), mix(b1, b2)]
      .map((c) => c.toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * State boundaries drawn as a translucent wash.
 *
 * WHY THIS EXISTS. A tinted border is the cheapest way to show "this one is
 * selected", and it is invisible to anyone who cannot tell the tint from the
 * surface behind it. So each of these is MEASURED after compositing rather than
 * trusted at its declared alpha.
 *
 * The measurement that produced this list: an accent wash over a surface only
 * reaches 3:1 from ~90% alpha upward. At 50% every one of the ten themes lands
 * between 1.6:1 and 3.1:1, and in the light modes even 60% fails. A wash is
 * therefore fine as a decoration or as reinforcement NEXT TO a text label, but
 * it cannot be the only thing carrying a state — which is what the first test
 * below pins, so nobody "fixes" a selection indicator by lowering an alpha.
 */
const STATE_BOUNDARY_WASHES: Array<[string, string, number, string]> = [
  ['--p-info', '--p-surface', 0.9, 'selected chip boundary (the state cue)'],
  ['--p-info', '--p-canvas', 0.9, 'selected chip boundary on the page'],
];

describe('theme contrast — WCAG 2.2 AA', () => {
  it('found every palette, and all five x both modes', () => {
    // A parse that silently returns nothing would make every assertion below
    // vacuous — the failure mode this guard exists for.
    expect(THEMES.length).toBe(10);
    const seen = THEMES.map((t) => `${t.palette}/${t.mode}`).sort();
    expect(seen).toEqual([
      'contrast/dark',
      'contrast/light',
      'enterprise/dark',
      'enterprise/light',
      'executive/dark',
      'executive/light',
      'neutral/dark',
      'neutral/light',
      'pastel/dark',
      'pastel/light',
    ]);
  });

  it('defines every primitive each theme needs', () => {
    const required = new Set([
      ...TEXT_PAIRS.flatMap(([a, b]) => [a, b]),
      ...REQUIRED_UI_PAIRS.flatMap(([a, b]) => [a, b]),
      ...DECORATIVE_PAIRS.flatMap(([a, b]) => [a, b]),
    ]);
    for (const theme of THEMES) {
      const missing = [...required].filter((token) => !theme.tokens[token]);
      expect(missing, `${theme.palette}/${theme.mode} is missing ${missing.join(', ')}`).toEqual([]);
    }
  });

  describe.each(THEMES.map((t) => [`${t.palette}/${t.mode}`, t] as const))('%s', (_name, theme) => {
    it.each(TEXT_PAIRS)('%s on %s (%s) meets 4.5:1', (fg, bg, label) => {
      const ratio = contrast(theme.tokens[fg], theme.tokens[bg]);
      expect(
        Number(ratio.toFixed(2)),
        `${label}: ${theme.tokens[fg]} on ${theme.tokens[bg]} = ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it.each(REQUIRED_UI_PAIRS)('%s on %s (%s) meets 3:1', (fg, bg, label) => {
      const ratio = contrast(theme.tokens[fg], theme.tokens[bg]);
      expect(
        Number(ratio.toFixed(2)),
        `${label}: ${theme.tokens[fg]} on ${theme.tokens[bg]} = ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_UI);
    });

    it.each(DECORATIVE_PAIRS)('%s on %s (%s) stays perceptible', (fg, bg, label) => {
      const ratio = contrast(theme.tokens[fg], theme.tokens[bg]);
      expect(
        Number(ratio.toFixed(2)),
        `${label}: ${theme.tokens[fg]} on ${theme.tokens[bg]} = ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(PERCEPTIBLE);
    });

    it.each(STATE_BOUNDARY_WASHES)('%s tinted over %s at %s alpha (%s) meets 3:1 once composited', (
      fg,
      bg,
      alpha,
      label,
    ) => {
      const washed = composite(theme.tokens[fg], theme.tokens[bg], alpha);
      const ratio = contrast(washed, theme.tokens[bg]);
      expect(
        Number(ratio.toFixed(2)),
        `${label}: ${washed} on ${theme.tokens[bg]} = ${ratio.toFixed(2)}:1 (declared ${alpha * 100}%)`,
      ).toBeGreaterThanOrEqual(AA_UI);
    });
  });

  it('pins the measured ceiling of a translucent state wash', () => {
    // The number that makes the rule above non-arbitrary. If someone lowers a
    // "selected" border to a half-opacity tint and it LOOKS fine to them, this is
    // the calculation that says otherwise: at 50% no palette reaches the 3:1
    // that WCAG 2.2 1.4.11 asks of a boundary that identifies a component's
    // state, so no theme passes on that alpha.
    const at = (alpha: number) =>
      THEMES.map((theme) => ({
        name: `${theme.palette}/${theme.mode}`,
        mode: theme.mode,
        ratio: contrast(
          composite(theme.tokens['--p-info'], theme.tokens['--p-surface'], alpha),
          theme.tokens['--p-surface'],
        ),
      }));

    const failing = (alpha: number, mode?: string) =>
      at(alpha)
        .filter((t) => (mode ? t.mode === mode : true) && t.ratio < AA_UI)
        .map((t) => `${t.name} ${t.ratio.toFixed(2)}:1`);

    // At half opacity EVERY light theme fails, and the worst of them misses 3:1
    // by a third — so a 50% "selected" ring on a light palette is a selection
    // nobody with low vision can see. (Four dark themes happen to pass here,
    // which is exactly why this has to be measured per theme rather than argued.)
    const lightAt50 = failing(0.5, 'light');
    expect(lightAt50.length).toBe(5);
    expect(Math.min(...at(0.5).map((t) => t.ratio))).toBeLessThan(2.5);

    // "Just tint it a bit harder" is not the fix: four of the five light themes
    // are still short at 60%.
    expect(failing(0.6, 'light').length).toBe(4);

    // 75% is where the whole set clears it, which is the number to reach for.
    expect(failing(0.75)).toEqual([]);

    // …and at the alpha the selected-state boundary actually uses, all ten pass
    // with room to spare (4.2:1 at worst, 9.3:1 at best).
    expect(failing(0.9)).toEqual([]);
  });
});
