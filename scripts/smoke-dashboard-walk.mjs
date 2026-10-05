#!/usr/bin/env node
/**
 * Walk the dashboard in a REAL browser, on every route, in several themes.
 *
 * WHY A BROWSER WALK, when there are already ~750 jsdom component tests.
 *
 * The component suite runs the SOURCE through jsdom and renders one component
 * at a time inside a MemoryRouter. It cannot see the things that only exist once
 * the shell, the router and a real engine are together:
 *
 *   - whether every route the shell LINKS TO actually mounts (a route added to
 *     the router but never linked is invisible to a component test);
 *   - whether a page ships exactly one <h1> and does not skip a heading level,
 *     which is the cue a screen-reader user navigates by;
 *   - whether the theme the user chose is the theme that paints — the earlier
 *     throwaway harness wrote the theme under the WRONG localStorage key
 *     (`nuvira-dashboard-theme`; the real key is `nuvira.dashboard.theme`), so
 *     every "theme" walk was silently running the default theme. This script
 *     asserts `data-palette`/`data-mode` on <html> before it trusts a page;
 *   - whether the shell's keyboard layer works end to end (a modal that traps
 *     focus, a `?` cheatsheet, a `g`-chord that navigates);
 *   - whether the rail is still its OWN surface. It must not be painted from the
 *     top bar's token, and its active pill must have a visible fill — the two
 *     ways a "tinted rail" change silently reverts to a flat slab.
 *
 * The page reports back over HTTP rather than being scraped from `--dump-dom`:
 * this dashboard polls its API forever, so Chrome never goes idle and the dump
 * hangs until it is killed.
 *
 * Usage:
 *   node scripts/smoke-dashboard-walk.mjs
 *   node scripts/smoke-dashboard-walk.mjs --themes enterprise:light,contrast:dark
 *   node scripts/smoke-dashboard-walk.mjs --width 800
 *   node scripts/smoke-dashboard-walk.mjs --require-chrome   # missing browser = failure
 *
 * Chrome is discovered from $CHROME_PATH, then the usual per-platform paths; a
 * machine without one SKIPS (exit 0) unless --require-chrome is given. Exit 1
 * means a real walk failure.
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { findChrome } from './lib/find-chrome.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const PUBLIC_DIR = join(REPO_ROOT, 'src', 'web-dashboard', 'public');

/** localStorage key the theme module actually reads. Keep in sync with theme.ts. */
const THEME_STORAGE_KEY = 'nuvira.dashboard.theme';

/** Palette/mode pairs walked by default — one light, one dark, plus two others. */
const DEFAULT_THEMES = ['enterprise:light', 'enterprise:dark', 'contrast:dark', 'pastel:light'];

/** A walk that finds fewer routes than this is broken, not "all clear". */
const MIN_ROUTES = 20;

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}

/**
 * The in-page harness.
 *
 * NO BACKTICKS inside: this whole block is itself a template literal, and a
 * backtick in it would end the string early. Placeholders are substituted after.
 */
const HARNESS = `
<script>
window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || e.type)));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  window.__errs.push('rejection: ' + ((r && r.message) || String(r)));
});

// The REAL key, so the app boots into the theme this walk claims to test.
try {
  localStorage.setItem('__STORAGE_KEY__', JSON.stringify({
    palette: '__THEME__', mode: '__MODE__', a11y: false, fontScale: 100,
  }));
} catch (e) {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function beacon(stage, data) {
  fetch('/__smoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ stage: stage }, data || {})),
  });
}

// ── Accessibility audit ────────────────────────────────────────────────────
// Run on EVERY route in a REAL engine, because the failures below are
// properties of the rendered DOM and the cascade, not of a component's props:
// a control can be named in jsdom and nameless once a decorative span swallows
// the text, and an aria-controls can point at an id that a conditional render
// removed. This is the subset of an axe-style audit that has no false positives
// worth arguing about, so a failure here is a bug rather than a judgement call.

function isVisible(el) {
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  if (el.closest('[hidden]')) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

function accessibleName(el) {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const joined = labelledby.split(/\s+/).map(function (id) {
      const target = document.getElementById(id);
      return target ? (target.textContent || '') : '';
    }).join(' ').trim();
    if (joined) return joined;
  }
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    const wrapping = el.closest('label');
    if (wrapping && (wrapping.textContent || '').trim()) return wrapping.textContent.trim();
    if (el.id) {
      const forLabel = document.querySelector('label[for="' + el.id + '"]');
      if (forLabel && (forLabel.textContent || '').trim()) return forLabel.textContent.trim();
    }
  }
  // A visible label wins over the title attribute: title is the last resort,
  // and it is usually what an icon-only control carries.
  const text = (el.textContent || '').trim();
  if (text) return text;
  const title = el.getAttribute('title');
  if (title && title.trim()) return title.trim();
  const img = el.querySelector('img[alt]');
  if (img) return (img.getAttribute('alt') || '').trim();
  return '';
}

function describe(el) {
  const cls = typeof el.className === 'string' && el.className ? '.' + el.className.split(/\s+/)[0] : '';
  return '<' + el.tagName.toLowerCase() + cls + '>';
}

function auditA11y() {
  const unnamed = [];
  for (const el of document.querySelectorAll('button, a[href], [role="button"], select, textarea')) {
    if (!isVisible(el)) continue;
    if (!accessibleName(el)) unnamed.push(describe(el));
  }

  const unlabelled = [];
  for (const el of document.querySelectorAll('input')) {
    if (el.type === 'hidden' || !isVisible(el)) continue;
    if (!accessibleName(el)) unlabelled.push(describe(el));
  }

  const missingAlt = [];
  for (const el of document.querySelectorAll('img')) {
    if (!el.hasAttribute('alt') && isVisible(el)) missingAlt.push(describe(el));
  }

  // A dangling reference is a promise the DOM does not keep: the control says
  // "I control X" and X is not there, so a screen reader announces nothing.
  const dangling = [];
  const refAttrs = ['aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-activedescendant'];
  for (const attr of refAttrs) {
    for (const el of document.querySelectorAll('[' + attr + ']')) {
      for (const id of (el.getAttribute(attr) || '').split(/\s+/)) {
        if (id && !document.getElementById(id)) dangling.push(attr + '→' + id + ' (' + describe(el) + ')');
      }
    }
  }

  // Duplicate ids break every id-based reference, including labels.
  const seen = {};
  const duplicateIds = [];
  for (const el of document.querySelectorAll('[id]')) {
    if (seen[el.id]) duplicateIds.push(el.id);
    else seen[el.id] = true;
  }

  // A positive tabindex reorders the whole page for keyboard users, so it is
  // never a local fix. Nothing in the dashboard should need one.
  let positiveTabindex = 0;
  for (const el of document.querySelectorAll('[tabindex]')) {
    if (Number(el.getAttribute('tabindex')) > 0) positiveTabindex += 1;
  }

  const focusable = document.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ).length;

  return {
    unnamed: unnamed.slice(0, 5),
    unlabelled: unlabelled.slice(0, 5),
    missingAlt: missingAlt.slice(0, 5),
    dangling: [...new Set(dangling)].slice(0, 5),
    duplicateIds: [...new Set(duplicateIds)].slice(0, 5),
    positiveTabindex: positiveTabindex,
    focusable: focusable,
    controls: document.querySelectorAll('button, a[href], input, select, textarea').length,
  };
}

function pageFacts() {
  const page = document.querySelector('.main') || document.body;
  // VISIBLE elements only. .main holds the persistently-mounted ChatPage even
  // while it is hidden with display:none (App keeps it mounted so a chat turn's
  // SSE stream survives navigation), and querySelectorAll matches hidden nodes,
  // so a raw scan counted the hidden chat header and saw a second h1 on every
  // route. A display:none subtree is not in the accessibility tree, so it must
  // not count toward the page's headings.
  const visible = (sel) => [...page.querySelectorAll(sel)].filter(isVisible);
  const h1s = visible('h1');
  // Scoped to .main on purpose: the rail's own group headings are h2 and come
  // BEFORE the page in the DOM, so a document-wide "first heading" reading says
  // h2 for a perfectly correct page.
  const levels = visible('h1,h2,h3,h4,h5,h6').map((h) => Number(h.tagName[1]));
  const distinct = [...new Set(levels)].sort((a, b) => a - b);
  let levelsSkipped = null;
  for (let i = 1; i < distinct.length; i++) {
    if (distinct[i] - distinct[i - 1] > 1) levelsSkipped = 'h' + distinct[i - 1] + ' -> h' + distinct[i];
  }
  const root = document.documentElement;
  const pageHeader = [...document.querySelectorAll('.page-header')].find(isVisible);
  const topbar = document.querySelector('.topbar');
  const rail = document.querySelector('.nav');
  const activeLink = document.querySelector('.nav-link.active');
  return {
    path: location.pathname,
    levelsSkipped,
    h1Count: h1s.length,
    h1: h1s[0] ? h1s[0].textContent.trim() : null,
    firstHeadingLevel: levels.length ? levels[0] : null,
    minHeadingLevel: levels.length ? Math.min.apply(null, levels) : null,
    hasPageHeader: !!pageHeader,
    headerBorder: pageHeader ? getComputedStyle(pageHeader).borderBottomStyle : null,
    mainChildren: document.querySelector('.main') ? document.querySelector('.main').children.length : -1,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    chromeBg: topbar ? getComputedStyle(topbar).backgroundColor : null,
    railBg: rail ? getComputedStyle(rail).backgroundColor : null,
    railActiveBg: activeLink ? getComputedStyle(activeLink).backgroundColor : null,
    railActiveWeight: activeLink ? getComputedStyle(activeLink).fontWeight : null,
    palette: root.getAttribute('data-palette'),
    mode: root.getAttribute('data-mode'),
    errors: window.__errs.slice(),
    a11y: auditA11y(),
  };
}

(async () => {
  await sleep(1800);

  // Start wherever the app landed, then visit every destination the rail and the
  // top bar link to — driven by the links themselves, so a page with no link is
  // a page this walk cannot miss.
  const routes = [...document.querySelectorAll('.nav-link, .primary-link')]
    .map((a) => a.getAttribute('href'))
    .filter((h, i, arr) => h && arr.indexOf(h) === i);
  const results = [];

  for (const route of routes) {
    const link = [...document.querySelectorAll('.nav-link, .primary-link')]
      .find((a) => a.getAttribute('href') === route);
    if (!link) continue;
    link.click();
    // Long enough for a failing fetch and its state to settle.
    await sleep(650);
    results.push(pageFacts());
  }

  // Keyboard layer, on whatever page we finished on.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
  await sleep(250);
  const dialog = document.querySelector('[role="dialog"]');
  const keyboard = {
    dialogOpened: !!dialog,
    ariaModal: dialog ? dialog.getAttribute('aria-modal') : null,
    focusInside: dialog ? dialog.contains(document.activeElement) : false,
    shortcutRows: document.querySelectorAll('.shortcuts-row').length,
    focusRingOnField: null,
    navAfterChord: null,
  };

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(200);
  keyboard.dialogClosedOnEsc = !document.querySelector('[role="dialog"]');

  // The global focus ring: a text field must show an outline, not just a border.
  const field = document.querySelector('.nav-search-input');
  if (field) {
    field.focus();
    const cs = getComputedStyle(field);
    keyboard.focusRingOnField = { style: cs.outlineStyle, width: cs.outlineWidth };
  }

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
  await sleep(400);
  keyboard.navAfterChord = location.pathname;

  beacon('done', { results: results, keyboard: keyboard, viewport: { w: innerWidth, h: innerHeight } });
})();
</script>
`;

/** Start a static server for `public/`, injecting the harness into index.html. */
function startServer(theme, mode) {
  const harness = HARNESS
    .replace(/__STORAGE_KEY__/g, THEME_STORAGE_KEY)
    .replace(/__THEME__/g, theme)
    .replace(/__MODE__/g, mode);

  let resolveSummary;
  const summaryPromise = new Promise((r) => {
    resolveSummary = r;
  });

  const server = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/__smoke') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        res.writeHead(204).end();
        try {
          const parsed = JSON.parse(body);
          if (parsed.stage === 'done') resolveSummary(parsed);
        } catch {
          // A malformed beacon is not a reason to crash the walk.
        }
      });
      return;
    }
    // SPA fallback: a path with no extension is a client route, served index.html.
    let file = join(PUBLIC_DIR, url === '/' ? 'index.html' : decodeURIComponent(url));
    if (!existsSync(file) || !extname(file)) file = join(PUBLIC_DIR, 'index.html');
    let body = readFileSync(file);
    if (file.endsWith('index.html')) {
      body = Buffer.from(body.toString('utf8').replace('</head>', harness + '</head>'));
    }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  });

  return { server, summaryPromise };
}

/** Walk one theme. Resolves the parsed page summary, or null on timeout. */
async function walkTheme({ theme, mode, chromePath, width }) {
  const { server, summaryPromise } = startServer(theme, mode);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const profileDir = mkdtempSync(join(tmpdir(), 'nuvira-smoke-'));
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      `--window-size=${width},900`,
      `--user-data-dir=${profileDir}`,
      // Keep the walk hermetic: the dashboard may try to reach a local API.
      '--disable-extensions',
      `http://127.0.0.1:${port}/`,
    ],
    { stdio: 'ignore' },
  );

  try {
    return await Promise.race([
      summaryPromise,
      new Promise((r) => setTimeout(() => r(null), 180_000)),
    ]);
  } finally {
    chrome.kill('SIGKILL');
    server.close();
    // Wait for Chrome to actually EXIT before deleting its profile. SIGKILL is
    // not instantaneous, and removing a profile Chrome still holds open races
    // it (observed as ENOTEMPTY on macOS). The timeout keeps a wedged browser
    // from hanging the run.
    await new Promise((r) => {
      if (chrome.exitCode !== null || chrome.signalCode !== null) return r();
      chrome.once('exit', r);
      setTimeout(r, 2000);
    });
    // A leftover temp dir is litter, not a test failure — never let cleanup
    // turn a green walk red.
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // The OS may still hold a file; the next mkdtemp makes a fresh dir anyway.
    }
  }
}

/**
 * Turn one theme's page summary into a list of failures (empty means pass).
 *
 * Every check names the route it failed on, because "heading level skipped" is
 * useless without knowing which page.
 */
export function judge(summary, theme, mode) {
  const bad = [];
  const label = `${theme}/${mode}`;

  if (summary.results.length < MIN_ROUTES) {
    bad.push(`${label}: only walked ${summary.results.length} routes (expected >= ${MIN_ROUTES})`);
  }

  // The theme actually applied. This is the check the old harness lacked.
  const offTheme = summary.results.filter((r) => r.palette !== theme || r.mode !== mode);
  for (const r of offTheme.slice(0, 3)) {
    bad.push(`${label}: ${r.path} rendered ${r.palette}/${r.mode}, not ${theme}/${mode}`);
  }

  for (const r of summary.results) {
    if (r.errors.length) bad.push(`${r.path}: ${r.errors.length} uncaught error(s) — ${r.errors[0]}`);
    if (r.h1Count !== 1) bad.push(`${r.path}: ${r.h1Count} h1 element(s) inside .main`);
    if (r.firstHeadingLevel !== 1) bad.push(`${r.path}: the page's first heading is h${r.firstHeadingLevel}`);
    // A skipped level (h1 then h3) is the defect: it is the cue a screen-reader
    // user follows, and no page may jump past it.
    if (r.minHeadingLevel !== 1) bad.push(`${r.path}: shallowest heading is h${r.minHeadingLevel}`);
    if (r.levelsSkipped) bad.push(`${r.path}: heading levels skip (${r.levelsSkipped})`);
    if (!r.hasPageHeader) bad.push(`${r.path}: no .page-header`);
    if (r.mainChildren === 0) bad.push(`${r.path}: rendered nothing`);

    // ─── accessibility, measured on the rendered page ───
    const a = r.a11y;
    if (a.unnamed.length) bad.push(`${r.path}: control(s) with no accessible name — ${a.unnamed.join(', ')}`);
    if (a.unlabelled.length) bad.push(`${r.path}: input(s) with no label — ${a.unlabelled.join(', ')}`);
    if (a.missingAlt.length) bad.push(`${r.path}: image(s) with no alt — ${a.missingAlt.join(', ')}`);
    if (a.dangling.length) bad.push(`${r.path}: aria reference(s) pointing at nothing — ${a.dangling.join(', ')}`);
    if (a.duplicateIds.length) bad.push(`${r.path}: duplicate id(s) — ${a.duplicateIds.join(', ')}`);
    if (a.positiveTabindex) bad.push(`${r.path}: ${a.positiveTabindex} element(s) with a positive tabindex`);
    // A page with controls but nothing focusable is a page a keyboard user
    // cannot operate at all — the failure this whole layer exists to prevent.
    if (a.controls > 0 && a.focusable === 0) bad.push(`${r.path}: ${a.controls} controls but nothing focusable`);
    if (r.headerBorder && r.headerBorder !== 'solid') bad.push(`${r.path}: page header border is ${r.headerBorder}`);
  }

  const k = summary.keyboard;
  if (!k.dialogOpened) bad.push(`${label}: ? did not open the shortcuts dialog`);
  if (k.ariaModal !== 'true') bad.push(`${label}: the shortcuts dialog is not aria-modal`);
  if (!k.focusInside) bad.push(`${label}: focus did not move into the shortcuts dialog`);
  if ((k.shortcutRows || 0) < 8) bad.push(`${label}: only ${k.shortcutRows} shortcut rows listed`);
  if (!k.dialogClosedOnEsc) bad.push(`${label}: Esc did not close the shortcuts dialog`);
  if (k.focusRingOnField && k.focusRingOnField.style === 'none') bad.push(`${label}: a focused text field has no focus ring`);
  if (k.navAfterChord !== '/tasks') bad.push(`${label}: g-t did not navigate: ${k.navAfterChord}`);

  // One canvas, one chrome and one rail colour for the whole app in a theme. A
  // page that forgets to inherit the surfaces shows up here as a second triple.
  const pairs = new Set(summary.results.map((r) => `${r.bodyBg}|${r.chromeBg}|${r.railBg}`));
  if (pairs.size !== 1) bad.push(`${label}: pages disagree about the theme surfaces: ${[...pairs].join(' / ')}`);

  // The rail is a SECOND surface, not the top bar repeated. Painting both from
  // the same token is the regression the dedicated --sidebar-* family exists to
  // prevent, and it is invisible to every jsdom test — only a real engine
  // resolves the cascade down to a computed colour.
  //
  // `contrast` is the ONE deliberate exception: that palette exists for maximum
  // legibility, so its rail stays pure black and is separated from the bar by
  // its border and its pills instead of by a tint. Exempting it here rather than
  // tinting it in the stylesheet keeps the exception in one visible place.
  if (theme !== 'contrast') {
    const sameAsBar = summary.results.filter((r) => r.railBg && r.railBg === r.chromeBg);
    if (sameAsBar.length) {
      bad.push(`${label}: the rail is painted the same as the top bar (${sameAsBar[0].railBg})`);
    }
  }

  // A nav pill the user cannot see is not a nav pill. Both the fill and the
  // weight change carry the "you are here" state, so both are checked.
  const pills = summary.results.map((r) => ({ path: r.path, bg: r.railActiveBg, weight: r.railActiveWeight }));
  const invisible = pills.filter((p) => p.bg && p.bg === summary.results[0].railBg);
  if (invisible.length) bad.push(`${label}: ${invisible[0].path} has an active pill with no fill`);
  if (!pills.some((p) => p.weight && Number(p.weight) >= 600)) {
    bad.push(`${label}: no active nav pill is emphasised`);
  }

  return bad;
}

async function main() {
  const themes = (arg('themes', DEFAULT_THEMES.join(',')) || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [palette, mode] = s.split(':');
      return { theme: palette, mode: mode || 'dark' };
    });
  const width = Number(arg('width', '1440'));
  const requireChrome = process.argv.includes('--require-chrome');

  if (!existsSync(join(PUBLIC_DIR, 'index.html'))) {
    console.error(`smoke: no built bundle at ${PUBLIC_DIR}. Run: npm run build:dashboard`);
    process.exit(1);
  }

  const chromePath = findChrome();
  if (!chromePath) {
    const message = 'no Chrome/Chromium found — set CHROME_PATH to run the browser walk';
    if (requireChrome) {
      console.error(`smoke: ✘ ${message}`);
      process.exit(1);
    }
    console.log(`smoke: ⚠ SKIPPED — ${message}`);
    process.exit(0);
  }

  const failures = [];
  for (const { theme, mode } of themes) {
    process.stdout.write(`smoke: walking ${theme}/${mode} …`);
    const summary = await walkTheme({ theme, mode, chromePath, width });
    if (!summary) {
      console.log(' no summary (page never reported)');
      failures.push(`${theme}/${mode}: the page never reported — no route rendered`);
      continue;
    }
    const bad = judge(summary, theme, mode);
    console.log(
      bad.length
        ? ` FAIL (${summary.results.length} routes)`
        : ` OK (${summary.results.length} routes, ${summary.viewport.w}x${summary.viewport.h})`,
    );
    failures.push(...bad);
  }

  if (failures.length) {
    console.error(`\nsmoke: ✘ ${failures.length} problem(s):\n - ${failures.join('\n - ')}`);
    process.exit(1);
  }
  console.log(`\nsmoke: ✔ ${themes.length} theme(s) walked clean`);
}

// Run only when invoked directly, so `judge` stays importable. The URL form is
// used (not a path comparison) because it is case-insensitive on Windows drives.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`smoke: ✘ ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
}
