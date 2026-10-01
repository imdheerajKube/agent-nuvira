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
 *     focus, a `?` cheatsheet, a `g`-chord that navigates).
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
import { execFileSync, spawn } from 'node:child_process';

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
 * Find a Chrome/Chromium binary, or null.
 *
 * An explicit $CHROME_PATH always wins so CI can pin one. Otherwise the usual
 * per-platform locations are tried, then PATH lookup on Unix.
 */
function findChrome() {
  if (process.env.CHROME_PATH) {
    return existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  }

  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        // `where` on Windows emits CRLF, so split on either ending.
      }).split(/\r?\n/)[0].trim();
      if (found && existsSync(found)) return found;
    } catch {
      // Not on PATH — try the next.
    }
  }
  return null;
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

function pageFacts() {
  const page = document.querySelector('.main') || document.body;
  const h1s = [...page.querySelectorAll('h1')];
  // Scoped to .main on purpose: the rail's own group headings are h2 and come
  // BEFORE the page in the DOM, so a document-wide "first heading" reading says
  // h2 for a perfectly correct page.
  const levels = [...page.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1]));
  const distinct = [...new Set(levels)].sort((a, b) => a - b);
  let levelsSkipped = null;
  for (let i = 1; i < distinct.length; i++) {
    if (distinct[i] - distinct[i - 1] > 1) levelsSkipped = 'h' + distinct[i - 1] + ' -> h' + distinct[i];
  }
  const root = document.documentElement;
  const pageHeader = document.querySelector('.page-header');
  const topbar = document.querySelector('.topbar');
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
    palette: root.getAttribute('data-palette'),
    mode: root.getAttribute('data-mode'),
    errors: window.__errs.slice(),
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

  // One canvas and one chrome colour for the whole app in a theme. A page that
  // forgets to inherit the surfaces shows up here as a second pair.
  const pairs = new Set(summary.results.map((r) => `${r.bodyBg}|${r.chromeBg}`));
  if (pairs.size !== 1) bad.push(`${label}: pages disagree about the theme surfaces: ${[...pairs].join(' / ')}`);

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
