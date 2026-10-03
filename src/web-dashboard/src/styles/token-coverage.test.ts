/**
 * `dashboard.css` must contain no literal colours.
 *
 * WHY THIS GUARD EXISTS. The file arrived with 318 raw hex values and 171 raw
 * rgb()/rgba() values written for one dark palette. Every one of them was a
 * place a theme could not reach, and the reason the dashboard could not have a
 * light mode was not a lack of design — it was that ~18 near-white text colours
 * would have rendered white-on-white the moment one was added.
 *
 * Converting them is a one-off; keeping them converted is a rule. Without this
 * test the next feature adds `color: #8b949e` because it is the quickest way to
 * match what is on screen, and the count creeps back to 50 one property at a
 * time — which is exactly how it got to 50 in the first place.
 *
 * ONE DELIBERATE EXEMPTION, with a reason rather than a shrug:
 *
 *  `var(--token, #fallback)` — a fallback only applies when the token is
 *    UNDEFINED, so it can never be the thing that breaks a theme; and rewriting
 *    it would hide a genuine definition bug instead of surfacing it.
 *
 * Shadows used to be a second exemption, on the reasoning that decoration does
 * not need to re-theme. That was wrong in three concrete places — a black
 * `text-shadow` smudged dark text on a light surface, a near-white glow
 * vanished into it, and a 50%-alpha selection ring fell to ~1.7:1 contrast —
 * and right in a fourth, where a glow encodes liveness. So shadows are judged
 * like everything else now.
 *
 * Anything else failing this test is a real gap, and the failure message names
 * the property so it can be mapped to a token in one step.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Walk up so this passes from `src/web-dashboard` or the repository root. */
function findStylesheet(name: string): string {
  let dir = process.cwd();
  for (let hop = 0; hop < 8; hop++) {
    const candidate = resolve(dir, 'src', 'styles', name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`${name} not found walking up from ${process.cwd()}`);
}

const RAW_CSS = readFileSync(findStylesheet('dashboard.css'), 'utf8');

/**
 * Comments are stripped before anything is measured.
 *
 * Not a nicety: the file's own header explains the token layer and therefore
 * CONTAINS the string `var(--token)`, which this suite promptly reported as an
 * undefined token. A guard that fails on its own documentation is a guard that
 * gets deleted — so prose is removed first, and then the code is judged.
 */
const CSS = RAW_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

interface Literal {
  property: string;
  value: string;
}

/** Ranges covered by a `var(...)`, so fallbacks inside them are skipped. */
function varRanges(value: string): Array<[number, number]> {
  // A balanced-paren scan, not `/var\([^()]*\)/`: a fallback may itself contain
  // parentheses — `var(--bg-input, rgba(0, 0, 0, 0.2))` is the case that exposed
  // this — and `[^()]*` stops at the first `(`, so the whole range went
  // unrecognised and its fallback was reported as a literal. That contradicted
  // the exemption documented above, which covers `var(--token, <fallback>)`
  // whatever the fallback is spelled like.
  const ranges: Array<[number, number]> = [];
  const re = /var\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const start = m.index;
    let depth = 0;
    let i = start + 3; // the opening '(' of `var(`
    for (; i < value.length; i++) {
      if (value[i] === '(') depth++;
      else if (value[i] === ')') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    ranges.push([start, i]);
    re.lastIndex = i;
  }
  return ranges;
}

function findLiterals(css: string): Literal[] {
  const found: Literal[] = [];
  for (const decl of css.matchAll(/(?<property>[a-zA-Z-]+)\s*:\s*(?<value>[^;{}]+);/g)) {
    const property = (decl.groups?.property ?? '').trim().toLowerCase();
    const value = decl.groups?.value ?? '';
    const ranges = varRanges(value);

    for (const hex of value.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      const at = hex.index;
      if (ranges.some(([from, to]) => at >= from && at < to)) continue;
      found.push({ property, value: hex[0] });
    }

    for (const rgb of value.matchAll(/rgba?\([^)]*\)/g)) {
      const at = rgb.index;
      if (ranges.some(([from, to]) => at >= from && at < to)) continue;
      found.push({ property, value: rgb[0] });
    }
  }
  return found;
}

describe('dashboard.css stays fully tokenized', () => {
  it('parsed a real stylesheet', () => {
    // A regex that silently matched nothing would make the assertion below
    // vacuous — the failure mode this whole file exists to prevent.
    expect(CSS.length).toBeGreaterThan(100_000);
    expect(CSS).toContain('.nav');
    // Proof the comment-stripping ran, rather than the source having no comments.
    expect(CSS.length).toBeLessThan(RAW_CSS.length);
  });

  it('contains no literal hex or rgb colours outside var() fallbacks', () => {
    const literals = findLiterals(CSS);
    const report = literals
      .slice(0, 25)
      .map((l) => `  ${l.property}: ${l.value}`)
      .join('\n');
    expect(
      literals.length,
      `${literals.length} literal colour(s) make a theme unreachable:\n${report}`,
    ).toBe(0);
  });

  it('every token it references is defined — in themes.css or by this sheet', () => {
    // The second half of the same problem: `--font-mono` was referenced 31 times
    // and defined nowhere, so 31 declarations were dropped by the browser and the
    // affected text silently fell back to the inherited font. A token NAME is not
    // a token; this checks the definition exists.
    const themes = readFileSync(findStylesheet('themes.css'), 'utf8');

    // A custom property may also be declared where it is used: `--metric-tone`
    // is SET by a tile modifier and READ by the tile, and has no business in the
    // theme layer. Those count as defined, so the rule stays "every reference
    // resolves" rather than tightening into "every reference comes from
    // themes.css", which is not the invariant anyone needs.
    const local = new Set([...CSS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const defined = new Set([
      ...[...themes.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
      ...local,
    ]);

    const referenced = new Set(
      [...CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]),
    );
    const missing = [...referenced].filter((token) => !defined.has(token)).sort();
    expect(missing, `referenced but never defined: ${missing.join(', ')}`).toEqual([]);

    // The leniency above is only safe while a local declaration is actually
    // read — an unread one is a property that can never take effect, which is
    // the same class of dead declaration this test exists to catch.
    const dead = [...local].filter((token) => !referenced.has(token)).sort();
    expect(dead, `declared here but never referenced: ${dead.join(', ')}`).toEqual([]);
  });

  it('keeps the QR background out of the theme on purpose', () => {
    // Pinned as a test because it looks like a bug and is not: a QR code is read
    // by a camera, which needs dark modules on a light background. "Fixing" this
    // by theming it would break WhatsApp pairing in dark mode.
    expect(CSS).toContain('var(--qr-background)');
    expect(readFileSync(findStylesheet('themes.css'), 'utf8')).toMatch(
      /--qr-background:\s*#ffffff/,
    );
  });
});

/* ── Metric tiles: a tone and its MATCHING tint ─────────────────────────────
   The tiles are the first surface painted with the soft status tints, so the
   pairing between a tile's tone and its tint became a contract between two CSS
   rules that nothing enforced. The failure modes are both silent: a tile with a
   tone but no tint looks like every other card, and a tone paired with the WRONG
   tint reads as a success card carrying a warning colour.

   This lives here rather than in a browser check on purpose — the tiles only
   render when the instance has live data, so a route walk sees an empty grid and
   would pass either way. */
describe('metric tiles carry a tone and its matching tint', () => {
  const TONES: Array<[string, string]> = [
    ['accent', '--accent-soft'],
    ['ok', '--ok-soft'],
    ['warn', '--warn-soft'],
    ['danger', '--danger-soft'],
  ];

  it('paints the tile from its tint, not from the plain card surface', () => {
    const rule = /\.metric-tile\s*\{([^}]*)\}/.exec(CSS);
    expect(rule, '.metric-tile rule not found').toBeTruthy();
    expect(rule![1]).toMatch(/background:\s*var\(--metric-soft\)/);
  });

  it.each(TONES)('maps the %s tone to its own tint (%s)', (tone, soft) => {
    const rule = new RegExp(`\\.metric-tile--${tone}\\s*\\{([^}]*)\\}`).exec(CSS);
    expect(rule, `.metric-tile--${tone} rule not found`).toBeTruthy();
    const body = rule![1];
    expect(body, `${tone} has no tone colour`).toMatch(/--metric-tone:\s*var\(--[a-z-]+\)/);
    expect(body, `${tone} is paired with the wrong tint`).toContain(`--metric-soft: var(${soft})`);
  });

  it('keeps every tint it references defined in the theme layer', () => {
    // The tints are asserted for text contrast by theme-contrast.test.ts, so a
    // tint that is not a theme primitive would sit outside the guard entirely.
    const themes = readFileSync(findStylesheet('themes.css'), 'utf8');
    const missing = TONES.map(([, soft]) => soft.replace('--', '--p-')).filter(
      (primitive) => !themes.includes(`${primitive}:`),
    );
    expect(missing, `tint(s) with no theme primitive: ${missing.join(', ')}`).toEqual([]);
  });
});

/* ── The same rule, applied to the components ───────────────────────────────
   Closing `dashboard.css` was only half the job: the components held ~950 more
   literal colours, so a theme could still be broken from `.tsx`. Those are now
   tokens too, and this block keeps them that way. */

const STYLES_DIR = dirname(findStylesheet('themes.css'));
const SRC_DIR = resolve(STYLES_DIR, '..');

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) walkTsx(path, out);
    else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) out.push(path);
  }
  return out;
}

/**
 * Comments are removed, and for a sharper reason than in the CSS case: the
 * conversion left explanatory notes naming the OLD literal ("was #8b949e"), and
 * counting those as live colours would fail the build over documentation.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/**
 * Colours that must NOT be themed.
 *
 * WhatsApp green and Telegram blue identify someone else's brand. Re-tinting
 * them per palette would make the product look wrong rather than accessible, so
 * they are pinned here as the one legitimate exception — the same reasoning that
 * keeps `--qr-background` fixed.
 */
const BRAND_LITERALS = new Set(['#25d366', '#0088cc']);

describe('dashboard components stay fully tokenized', () => {
  const files = walkTsx(SRC_DIR);

  it('scanned a real component tree', () => {
    // Guard against a walk that matches nothing and makes everything below pass.
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.endsWith('RoutingInsightsPanel.tsx'))).toBe(true);
  });

  it('contains no literal colours except pinned brand colours', () => {
    const offences: string[] = [];
    for (const file of files) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const line of src.split('\n')) {
        // A fallback inside var(--token, #fallback) can never break a theme.
        const withoutFallbacks = line.replace(/var\([^()]*\)/g, '');
        for (const match of withoutFallbacks.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/g)) {
          if (BRAND_LITERALS.has(match[0].toLowerCase())) continue;
          offences.push(`${file.slice(SRC_DIR.length + 1)}  ${match[0]}  ${line.trim().slice(0, 90)}`);
        }
      }
    }
    expect(
      offences.length,
      `${offences.length} literal colour(s) in components:\n${offences.slice(0, 25).join('\n')}`,
    ).toBe(0);
  });

  it('paints colours through a `style` prop, never a presentation attribute', () => {
    // A presentation attribute holds `var(--x)` as an opaque string that the
    // engine may or may not resolve, and the failure mode is silent BLACK rather
    // than an error — `fill="var(--x)"` on a shape whose var cannot be resolved
    // paints the initial colour. So any painted colour must travel via `style`,
    // which React emits as a real inline style where var() always resolves.
    //
    // This covers RAW SVG elements (rect, path, text, polyline, …) as well as the
    // Recharts ones. An earlier version of this check only looked at Recharts
    // components and therefore passed while `<polyline fill="var(--x)">` sat
    // right next to it — the guard has to match the risk, not the common case.
    const PAINT_TAGS = 'Bar|Line|Area|Scatter|Cell|rect|circle|ellipse|line|polyline|polygon|path|text|tspan|g|marker|use|stop';
    const attrOnly: string[] = [];
    for (const file of files) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const tag of src.matchAll(new RegExp(`<(${PAINT_TAGS})\\b[^>]*?>`, 'gs'))) {
        const text = tag[0];
        // The requirement is not "no style prop" — a series may legitimately
        // carry the colour as an attribute TOO, because Recharts reads it to
        // build the legend swatch. The requirement is that each painted property
        // also reaches a `style`, since that is the copy the engine is guaranteed
        // to resolve.
        const styleProp = /\bstyle=\{\{([^}]*)\}\}/.exec(text);
        const styled = new Set(
          [...(styleProp?.[1] ?? '').matchAll(/(?:^|,)\s*(fill|stroke)\s*:/g)].map((m) => m[1]),
        );
        for (const attr of text.matchAll(/\b(fill|stroke)=("var\(|\{)/g)) {
          if (!styled.has(attr[1])) {
            attrOnly.push(
              `${file.slice(SRC_DIR.length + 1)}  ${attr[1]} has no style equivalent: ${text.replace(/\s+/g, ' ').slice(0, 100)}`,
            );
          }
        }
      }
    }
    expect(
      attrOnly.length,
      `colour carried only by a presentation attribute:\n${attrOnly.join('\n')}`,
    ).toBe(0);
  });

  it('has a legend-swatch rule for every series fill colour', () => {
    // The legend swatch is the ONE thing Recharts will not let us style with the
    // `style` prop — it reads the series' `fill` (a presentation attribute), so
    // dashboard.css re-declares each series colour for it. That pairing is a
    // contract between two files, which is exactly the kind of thing that rots
    // silently when a sixth series colour is added. So it is asserted.
    const tokens = new Set<string>();
    for (const file of files) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/<(?:Bar|Line|Area|Scatter)\b[^>]*?\bfill="(var\([^)]+\))"/gs)) {
        tokens.add(m[1]);
      }
    }
    expect(tokens.size, 'expected at least one series fill to check').toBeGreaterThan(0);

    const missing = [...tokens]
      .filter((token) => !CSS.includes(`.recharts-legend-icon[fill='${token}']`))
      .sort();
    expect(
      missing,
      `series fill(s) with no legend-swatch rule in dashboard.css: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
