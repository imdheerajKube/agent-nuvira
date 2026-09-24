#!/usr/bin/env node
/**
 * Generate the documentation site's brand assets.
 *
 * Everything is authored as SVG and rasterized with sharp (already a project
 * dependency), so the assets are reproducible from source rather than
 * hand-exported PNGs that nobody can regenerate or upscale.
 *
 * The palette is copied from the product website's design tokens so the docs
 * site and the marketing site cannot drift apart:
 *
 *   accent-1 #6366f1 · accent-2 #8b5cf6 · accent-3 #a78bfa · cyan #06b6d4
 *   gradient-1: 135° #6366f1 → #8b5cf6 → #a78bfa
 *   bg-primary #06060e · bg-secondary #0b0b18 · text #f0f0f5
 *
 * The mark is the product's own: a rounded square filled with the gradient and
 * a white diamond glyph (the website uses ◆ in the same gradient square), so a
 * favicon and the wordmark read as one brand.
 *
 *   node scripts/generate-docs-brand.mjs
 *   node scripts/generate-docs-brand.mjs --check   # verify what is on disk
 *
 * Output (consumed by scripts/build-docs-repo.mjs):
 *   assets/docs-brand/logo.svg              header mark
 *   assets/docs-brand/favicon.svg           crisp at every size
 *   assets/docs-brand/favicon-32.png        classic tab icon
 *   assets/docs-brand/apple-touch-icon.png  180px home-screen icon
 *   assets/docs-brand/og-card.svg           source of the social card
 *   assets/docs-brand/og-card.png           1200×630 link preview
 */

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(repoRoot, 'assets', 'docs-brand');
const CHECK = process.argv.includes('--check');

// ─── palette (mirrors website/styles.css tokens) ─────────────────────────────

const C = {
  accent1: '#6366f1',
  accent2: '#8b5cf6',
  accent3: '#a78bfa',
  cyan: '#06b6d4',
  bgPrimary: '#06060e',
  bgSecondary: '#0b0b18',
  text: '#f0f0f5',
  textDim: '#a9a9c4',
  border: '#25254a',
};

/** The gradient, shared by every asset so the mark is identical everywhere. */
const GRADIENT = `<linearGradient id="nuvira" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="${C.accent1}"/>
    <stop offset="52%" stop-color="${C.accent2}"/>
    <stop offset="100%" stop-color="${C.accent3}"/>
  </linearGradient>`;

/** The glyph: an outer diamond with a dimmed inner facet. */
function diamond({ outer = '#ffffff', inner = null, opacity = 0.5 } = {}) {
  const facet = inner
    ? `\n  <path d="M32 21 L41 32 L32 43 L23 32 Z" fill="${inner}" fill-opacity="${opacity}"/>`
    : '';
  return `<path d="M32 11 L48 32 L32 53 L16 32 Z" fill="${outer}"/>${facet}`;
}

// ─── assets ─────────────────────────────────────────────────────────────────

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="Agent-Nuvira">
  <defs>${GRADIENT}</defs>
  <rect width="64" height="64" rx="15" fill="url(#nuvira)"/>
  ${diamond({ inner: C.accent1 })}
</svg>
`;

/** A plainer cut for 16–32px, where the inner facet would turn to mud. */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="Agent-Nuvira">
  <defs>${GRADIENT}</defs>
  <rect width="64" height="64" rx="14" fill="url(#nuvira)"/>
  ${diamond()}
</svg>
`;

/**
 * The 1200×630 card. Text uses a font stack librsvg can resolve on macOS and
 * Linux CI, so the rendered PNG matches the source instead of silently falling
 * back to a default face.
 */
const OG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <defs>
    ${GRADIENT}
    <radialGradient id="glowA" cx="18%" cy="26%" r="55%">
      <stop offset="0%" stop-color="${C.accent1}" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="${C.accent1}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="84%" cy="76%" r="52%">
      <stop offset="0%" stop-color="${C.cyan}" stop-opacity="0.20"/>
      <stop offset="100%" stop-color="${C.cyan}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="hairline" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${C.accent1}" stop-opacity="0"/>
      <stop offset="50%" stop-color="${C.accent2}" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="${C.accent3}" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="630" fill="${C.bgPrimary}"/>
  <rect width="1200" height="630" fill="url(#glowA)"/>
  <rect width="1200" height="630" fill="url(#glowB)"/>

  <!-- mark -->
  <g transform="translate(80, 74) scale(1.15)">
    <rect width="64" height="64" rx="15" fill="url(#nuvira)"/>
    ${diamond({ inner: C.accent1 })}
  </g>

  <!-- wordmark -->
  <text x="182" y="122" font-family="Helvetica, Arial, sans-serif" font-size="46" font-weight="400" fill="${C.text}">Agent-<tspan font-weight="700">Nuvira</tspan></text>

  <!-- tagline -->
  <text x="80" y="248" font-family="Helvetica, Arial, sans-serif" font-size="62" font-weight="700" fill="${C.text}">Multi-agent AI coding CLI</text>
  <text x="80" y="300" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="400" fill="${C.textDim}">Plan, write, review, test and publish — from a terminal, a dashboard,</text>
  <text x="80" y="338" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="400" fill="${C.textDim}">or any of 22 messaging platforms. Local models or cloud APIs.</text>

  <rect x="80" y="372" width="1040" height="2" fill="url(#hairline)"/>

  <!-- a real session, because a card that shows the product beats one that lists it -->
  <rect x="80" y="412" width="1040" height="150" rx="14" fill="${C.bgSecondary}" stroke="${C.border}" stroke-width="1"/>
  <circle cx="108" cy="438" r="6" fill="#ff5f57"/>
  <circle cx="130" cy="438" r="6" fill="#febc2e"/>
  <circle cx="152" cy="438" r="6" fill="#28c840"/>
  <g font-family="Menlo, Consolas, monospace" font-size="21">
    <text x="108" y="482" fill="${C.accent3}">$ nuvira doctor</text>
    <text x="108" y="514" fill="${C.textDim}">$ nuvira workflow run bug-hunt "login fails with a plus sign"</text>
    <text x="108" y="546" fill="${C.textDim}">$ nuvira skill run security-audit --dry-run</text>
  </g>

  <text x="80" y="606" font-family="Helvetica, Arial, sans-serif" font-size="21" font-weight="600" fill="${C.accent3}">No telemetry</text>
  <text x="238" y="606" font-family="Helvetica, Arial, sans-serif" font-size="21" fill="${C.border}">·</text>
  <text x="256" y="606" font-family="Helvetica, Arial, sans-serif" font-size="21" font-weight="600" fill="${C.accent3}">Bring your own keys</text>
  <text x="475" y="606" font-family="Helvetica, Arial, sans-serif" font-size="21" fill="${C.border}">·</text>
  <text x="493" y="606" font-family="Helvetica, Arial, sans-serif" font-size="21" font-weight="600" fill="${C.accent3}">MIT licensed</text>
</svg>
`;

// ─── write or check ─────────────────────────────────────────────────────────

const FILES = [
  ['logo.svg', LOGO_SVG],
  ['favicon.svg', FAVICON_SVG],
  ['og-card.svg', OG_SVG],
];

if (CHECK) {
  const missing = [
    ...FILES.map(([f]) => f),
    'favicon-32.png',
    'apple-touch-icon.png',
    'og-card.png',
    'github-social-preview.png',
  ].filter((f) => !existsSync(join(OUT, f)));
  if (missing.length) {
    console.error(`✗ brand assets missing: ${missing.join(', ')}`);
    console.error('  run: node scripts/generate-docs-brand.mjs');
    process.exit(1);
  }
  console.log(`✓ brand assets present in ${OUT}`);
  process.exit(0);
}

const sharp = (await import('sharp')).default;

mkdirSync(OUT, { recursive: true });

for (const [name, svg] of FILES) {
  writeFileSync(join(OUT, name), svg, 'utf8');
  console.log(`✓ ${name}`);
}

/** Rasterize and fail loudly if the result has no content (a silent blank). */
async function rasterize(svg, name, width, height, opts = {}) {
  const dest = join(OUT, name);
  const { fit = 'cover', background, ...pngOpts } = opts;
  // Sharp pads `contain` with OPAQUE BLACK unless told otherwise, so the
  // background has to go to resize itself — flattening afterwards never sees
  // transparency and does nothing.
  let pipeline = sharp(Buffer.from(svg), { density: 384 }).resize(width, height, {
    fit,
    background,
  });
  if (background) pipeline = pipeline.flatten({ background });
  await pipeline.png(pngOpts).toFile(dest);
  const meta = await sharp(dest).metadata();
  const { entropy } = await sharp(dest).stats().then((s) => s.channels[0]);
  if (meta.width !== width || meta.height !== height) {
    throw new Error(`${name}: expected ${width}×${height}, got ${meta.width}×${meta.height}`);
  }
  // A rendered card has gradients, glyphs and text — entropy well above a flat fill.
  if (entropy < 0.5) throw new Error(`${name}: looks blank (entropy ${entropy.toFixed(3)})`);
  console.log(`✓ ${name}  ${width}×${height}  ${(statSync(dest).size / 1024).toFixed(1)}KB`);
}

await rasterize(FAVICON_SVG, 'favicon-32.png', 32, 32, { compressionLevel: 9 });
await rasterize(FAVICON_SVG, 'apple-touch-icon.png', 180, 180, { compressionLevel: 9 });
await rasterize(OG_SVG, 'og-card.png', 1200, 630, { compressionLevel: 9 });

/**
 * GitHub's repository social preview is a UI-only setting (Settings → General →
 * Social preview) and it wants 1280×640 — there is no REST endpoint for it, so
 * this is exported for a manual upload. `contain` letterboxes by ~61px total
 * against the card's own background colour, so the padding is invisible.
 */
await rasterize(OG_SVG, 'github-social-preview.png', 1280, 640, {
  compressionLevel: 9,
  background: { r: 6, g: 6, b: 14, alpha: 1 },
  fit: 'contain',
});

console.log(`\n✓ brand assets written to ${OUT}`);
