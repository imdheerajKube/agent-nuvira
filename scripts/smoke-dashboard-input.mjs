#!/usr/bin/env node
/**
 * Drive the dashboard with REAL browser input, over the Chrome DevTools Protocol.
 *
 * WHY THIS EXISTS, given ~850 jsdom component tests and a browser WALK.
 *
 * Both of those drive the page with events the test harness creates itself, and
 * a synthetic event is a LIE about one specific thing: it has no default action.
 *
 * The bug that created this file: the Appearance panel's options are `<label>`
 * wrapping a visually-hidden `<input type="radio">`. Every jsdom test clicked
 * the INPUT directly, which fires React's onChange. A real user clicks the LABEL,
 * and it is the browser's trusted default action that forwards that click to the
 * input. On Chrome/macOS, clicking a control does not focus it either, so the
 * input the panel had auto-focused blurred to `<body>` with `relatedTarget: null`
 * — which the panel's blur handler read as "left the document" and closed. The
 * panel unmounted before mouse-up, so no click and no change ever fired: every
 * real mouse selection was silently swallowed, and the entire suite stayed green.
 *
 * Neither `page.click()`-style synthetic dispatch nor a computed-style walk can
 * catch that, because the defect is in the browser's DEFAULT ACTION. Only
 * Input.dispatchMouseEvent produces a trusted event, so this script sends real
 * mouse and key events and reads the resulting state out of the DOM.
 *
 * Usage:
 *   node scripts/smoke-dashboard-input.mjs
 *   node scripts/smoke-dashboard-input.mjs --require-chrome
 *   node scripts/smoke-dashboard-input.mjs --url http://localhost:3032   # drive a RUNNING dashboard
 *
 * `--url` skips the built-in static server and drives an already-running
 * instance instead. That matters because the built bundle and the served one can
 * differ (a stale server process serves an older hash), and the complaint that
 * produced this script was about the SERVED dashboard, not the built one.
 *
 * No Chrome/Chromium found = SKIP (exit 0) unless --require-chrome is given.
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import { findChrome } from './lib/find-chrome.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(SCRIPT_DIR, '..', 'src', 'web-dashboard', 'public');

/** Must match theme.ts — this is how the walk pins the theme it is testing. */
const THEME_STORAGE_KEY = 'nuvira.dashboard.theme';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── A minimal RFC 6455 client ──────────────────────────────────────────────
// Text frames only, which is all CDP sends and receives. A dependency would be
// the alternative; this is ~60 lines and keeps the smoke scripts install-free.

class WebSocketClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.onmessage = () => {};
  }

  static async connect(url) {
    const parsed = new URL(url);
    const socket = net.connect(Number(parsed.port), parsed.hostname);
    await new Promise((res, rej) => {
      socket.once('connect', res);
      socket.once('error', rej);
    });

    const key = crypto.randomBytes(16).toString('base64');
    socket.write(
      `GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\nHost: ${parsed.host}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );

    let head = Buffer.alloc(0);
    while (head.indexOf('\r\n\r\n') === -1) {
      head = Buffer.concat([head, await new Promise((r) => socket.once('data', r))]);
    }
    if (!/ 101 /.test(head.toString('latin1'))) {
      throw new Error(`websocket handshake failed: ${head.toString('latin1').slice(0, 200)}`);
    }

    const client = new WebSocketClient(socket);
    const rest = head.subarray(head.indexOf('\r\n\r\n') + 4);
    socket.on('data', (chunk) => client.feed(chunk));
    if (rest.length) client.feed(rest);
    return client;
  }

  send(text) {
    const payload = Buffer.from(text, 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0] & 0x0f;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x1) {
        try {
          this.onmessage(JSON.parse(payload.toString('utf8')));
        } catch {
          // A frame we cannot parse is not a reason to abort the run.
        }
      } else if (opcode === 0x8) {
        this.socket.end();
        return;
      }
    }
  }
}

/** Send a CDP command and await its reply. */
function rpc(client, method, params = {}) {
  const id = rpc.nextId = (rpc.nextId || 0) + 1;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`CDP timeout: ${method}`)), 30_000);
    const previous = client.onmessage;
    client.onmessage = (message) => {
      if (message.id === id) {
        clearTimeout(timer);
        client.onmessage = previous;
        if (message.error) rej(new Error(`${method}: ${JSON.stringify(message.error)}`));
        else res(message.result);
        return;
      }
      previous(message);
    };
    client.send(JSON.stringify({ id, method, params }));
  });
}

// ─── the run ────────────────────────────────────────────────────────────────

function startServer() {
  const server = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    let file = join(PUBLIC_DIR, url === '/' ? 'index.html' : decodeURIComponent(url));
    if (!existsSync(file) || !extname(file)) file = join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return server;
}

export async function drive({ chromePath, url }) {
  // `--url` drives a running dashboard; otherwise serve the committed bundle.
  let server = null;
  let port;
  let baseUrl = url;
  if (!baseUrl) {
    server = startServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}/`;
  }

  const debugPort = 9400 + Math.floor(Math.random() * 400);
  const profileDir = mkdtempSync(join(tmpdir(), 'nuvira-input-'));
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--window-size=1440,900',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${debugPort}`,
      baseUrl,
    ],
    { stdio: 'ignore' },
  );

  let client;
  try {
    let target = null;
    for (let i = 0; i < 80 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch {
        await sleep(250);
      }
    }
    if (!target) throw new Error('no DevTools page target appeared');
    client = await WebSocketClient.connect(target.webSocketDebuggerUrl);
    await rpc(client, 'Runtime.enable');
    await rpc(client, 'Page.enable');

    const evaluate = async (expression) => {
      const result = await rpc(client, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? 'unknown'}`);
      }
      return result.result.value;
    };

    /** A real, TRUSTED mouse click at viewport coordinates. */
    const clickAt = async (x, y) => {
      const shared = { x, y, button: 'left', clickCount: 1 };
      await rpc(client, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await rpc(client, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...shared });
      await rpc(client, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...shared });
      await sleep(220);
    };

    const key = async (keyName, code, vk) => {
      await rpc(client, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      });
      await rpc(client, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      });
      await sleep(220);
    };

    /**
     * Click the centre of the first element the expression finds.
     *
     * It scrolls the element into view FIRST, and that is not a convenience: the
     * Appearance panel is `max-height` + `overflow-y: auto`, so its last two
     * controls sit past the scroll edge. `getBoundingClientRect` still reports
     * their unclipped position, so clicking it blindly lands on the PAGE behind
     * the panel — which dismisses it via the outside-click handler and looks
     * exactly like "the switch does nothing".
     */
    const clickElement = async (expression) => {
      const box = await evaluate(
        `(() => { const el = ${expression};` +
          ` if (!el) return null;` +
          ` el.scrollIntoView({ block: 'center', inline: 'center' });` +
          ` return el; })() && (() => { const el = ${expression};` +
          ` if (!el) return null; const r = el.getBoundingClientRect();` +
          ` if (r.width === 0 || r.height === 0) return null;` +
          ` return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      if (!box) return false;
      await clickAt(box.x, box.y);
      return true;
    };

    const state = () => evaluate(
      `(() => { const root = document.documentElement;` +
        ` let stored = null;` +
        ` try { stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}); } catch (e) { stored = 'unavailable'; }` +
        ` const rail = document.querySelector('.nav');` +
        ` const active = document.querySelector('.nav-link.active');` +
        ` const search = document.querySelector('.nav-search-input');` +
        ` const link = document.querySelector('.nav-link');` +
        ` const panel = document.querySelector('.theme-panel');` +
        ` const dialog = document.querySelector('[role="dialog"]');` +
        ` const h1 = document.querySelector('.main h1');` +
        ` return {` +
        `   path: location.pathname,` +
        `   h1: h1 ? h1.textContent.trim() : null,` +
        `   dialogOpen: !!dialog,` +
        `   dialogAriaModal: dialog ? dialog.getAttribute('aria-modal') : null,` +
        `   dialogFocused: dialog ? dialog.contains(document.activeElement) : false,` +
        `   mode: root.getAttribute('data-mode'),` +
        `   palette: root.getAttribute('data-palette'),` +
        `   a11y: root.getAttribute('data-a11y'),` +
        `   stored: stored,` +
        `   panelOpen: !!panel,` +
        `   checked: panel ? [...panel.querySelectorAll('input:checked')].map((i) => i.value) : null,` +
        `   focusIn: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null,` +
        `   railBg: rail ? getComputedStyle(rail).backgroundColor : null,` +
        `   barBg: document.querySelector('.topbar') ? getComputedStyle(document.querySelector('.topbar')).backgroundColor : null,` +
        `   railOverflow: rail ? rail.scrollWidth - rail.clientWidth : null,` +
        `   activeBg: active ? getComputedStyle(active).backgroundColor : null,` +
        `   activeRadius: active ? getComputedStyle(active).borderTopLeftRadius : null,` +
        `   activeWeight: active ? getComputedStyle(active).fontWeight : null,` +
        `   linkHeight: link ? link.getBoundingClientRect().height : null,` +
        `   searchBorder: search ? getComputedStyle(search).borderTopColor : null,` +
        `   triggerExpanded: document.querySelector('.theme-trigger') ? document.querySelector('.theme-trigger').getAttribute('aria-expanded') : null,` +
        `   errors: (window.__errs || []).slice() }; })()`,
    );

    // Collect uncaught errors for the whole run.
    await evaluate(
      `(() => { window.__errs = [];` +
        ` window.addEventListener('error', (e) => window.__errs.push(String(e.message || e.type)));` +
        ` window.addEventListener('unhandledrejection', (e) => window.__errs.push(String((e.reason && e.reason.message) || e.reason)));` +
        ` return true; })()`,
    );

    const facts = {};

    // Boot in a known theme so the rail assertions are about a theme we chose.
    await evaluate(
      `(() => { try { localStorage.setItem(${JSON.stringify(THEME_STORAGE_KEY)},` +
        ` JSON.stringify({ palette: 'enterprise', mode: 'light', a11y: false, fontScale: 100 })); } catch (e) {}` +
        ` return true; })()`,
    );
    await rpc(client, 'Page.navigate', { url: baseUrl });
    await sleep(2600);

    facts.initial = await state();

    // 1. The rail is a surface of its own, and the pill is a real pill.
    facts.rail = {
      railBg: facts.initial.railBg,
      barBg: facts.initial.barBg,
      activeBg: facts.initial.activeBg,
      activeRadius: facts.initial.activeRadius,
      activeWeight: facts.initial.activeWeight,
      linkHeight: facts.initial.linkHeight,
      searchBorder: facts.initial.searchBorder,
      overflow: facts.initial.railOverflow,
    };

    // 2. Open Appearance with a real click.
    facts.opened = await clickElement(`document.querySelector('.theme-trigger')`);
    facts.afterOpen = await state();

    // Where the panel actually lands. A control below the fold is a control the
    // user cannot reach, so this is measured rather than assumed.
    facts.panelLayout = await evaluate(
      `(() => { const p = document.querySelector('.theme-panel'); if (!p) return null;` +
        ` const r = p.getBoundingClientRect(); const cs = getComputedStyle(p);` +
        ` const box = (sel) => { const e = p.querySelector(sel); if (!e) return null;` +
        `   const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; };` +
        ` return { viewport: innerHeight, panelTop: Math.round(r.top), panelBottom: Math.round(r.bottom),` +
        `   maxHeight: cs.maxHeight, overflowY: cs.overflowY,` +
        `   switch: box('.theme-switch'), reset: box('.theme-reset'), firstOption: box('.theme-option') }; })()`,
    );

    // 3. THE REGRESSION: a real click on the visible label must select the mode.
    facts.clickedModeLabel = await clickElement(
      `[...document.querySelectorAll('.theme-option')].find((el) => el.textContent.trim() === 'Dark')`,
    );
    facts.afterMode = await state();

    // 4. A real click on a PALETTE option, by input value (labels are the text).
    facts.clickedPalette = await clickElement(
      `[...document.querySelectorAll('.theme-panel .theme-option input')].find((i) => i.value === 'contrast')?.closest('label')`,
    );
    facts.afterPalette = await state();

    // 5. The accessibility switch, which also raises --target-min.
    facts.clickedA11y = await clickElement(
      `[...document.querySelectorAll('.theme-switch label, .theme-switch')].find((el) => el.textContent.includes('Accessibility mode'))`,
    );
    facts.afterA11y = await state();
    facts.a11yLinkHeight = await evaluate(
      `(() => { const l = document.querySelector('.nav-link'); return l ? l.getBoundingClientRect().height : null; })()`,
    );

    // 6. Escape closes and hands focus back to the trigger.
    await key('Escape', 'Escape', 27);
    facts.afterEscape = await state();

    // 7. Reset returns to the system default.
    facts.openedForReset = await clickElement(`document.querySelector('.theme-trigger')`);
    facts.clickedReset = await clickElement(
      `document.querySelector('.theme-reset')`,
    );
    facts.afterReset = await state();

    // 8. The keyboard layer, with TRUSTED key events. `event.key` only exists on
    // a real key event, and jsdom synthesises one from a string — so this is the
    // half of the shortcut contract a component test cannot check.
    await key('?', 'Slash', 191);
    facts.afterHelpKey = await state();
    await key('Escape', 'Escape', 27);
    facts.afterHelpEscape = await state();

    // F1 is the newer of the two: it opens the Help PAGE, not the cheatsheet.
    await key('F1', 'F1', 112);
    await sleep(400);
    facts.afterF1 = await state();

    // 9. The Overview metric tiles, which only exist when the instance has real
    // data — so this is meaningful on a `--url` run against a live dashboard and
    // is a no-op against the bare bundle. The tint is the claim being checked:
    // four tiles must not collapse into one colour, and a tile must not lose its
    // background entirely.
    await evaluate(`(() => { window.history.pushState({}, '', '/overview');` +
      ` window.dispatchEvent(new PopStateEvent('popstate')); return true; })()`);
    await sleep(2200);
    facts.tiles = await evaluate(
      `(() => { const tiles = [...document.querySelectorAll('.metric-tile')];` +
        ` return {` +
        `   count: tiles.length,` +
        `   backgrounds: tiles.map((el) => getComputedStyle(el).backgroundColor),` +
        `   chips: tiles.map((el) => { const c = el.querySelector('.metric-tile-icon');` +
        `     return c ? getComputedStyle(c).backgroundColor : null; }),` +
        `   values: tiles.map((el) => { const v = el.querySelector('.metric-tile-value');` +
        `     return v ? getComputedStyle(v).color : null; }) }; })()`,
    );

    return facts;
  } finally {
    try {
      client?.socket?.end();
    } catch {
      // Nothing useful to do if the socket is already gone.
    }
    chrome.kill('SIGKILL');
    server?.close();
    await new Promise((r) => {
      if (chrome.exitCode !== null || chrome.signalCode !== null) return r();
      chrome.once('exit', r);
      setTimeout(r, 2000);
    });
    // A leftover temp dir is litter, not a failure.
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // The OS may still hold a file.
    }
  }
}

/** Turn the collected facts into a list of failures. Empty means pass. */
export function judge(facts) {
  const bad = [];
  const { initial, rail, afterOpen, afterMode, afterPalette, afterA11y, afterEscape, afterReset } = facts;

  // ─── the rail ───
  if (!rail.railBg || !rail.barBg) bad.push('the rail or the top bar has no background');
  else if (rail.railBg === rail.barBg) bad.push(`rail and top bar share a surface (${rail.railBg})`);
  if (rail.activeBg === rail.railBg) bad.push('the active nav pill has no fill');
  // A pill, not a stripe: a rounded row is the whole point of the change.
  if (!rail.activeRadius || parseFloat(rail.activeRadius) <= 0) {
    bad.push(`the nav link has no corner radius (${rail.activeRadius})`);
  }
  if (!rail.activeWeight || Number(rail.activeWeight) < 600) {
    bad.push(`the active nav pill is not emphasised (weight ${rail.activeWeight})`);
  }
  if (!rail.linkHeight || rail.linkHeight < 32) bad.push(`nav links are ${rail.linkHeight}px tall`);
  if (rail.overflow > 0) bad.push(`the rail scrolls sideways by ${rail.overflow}px`);
  if (rail.searchBorder === rail.railBg) bad.push('the rail search field has no visible boundary');

  // ─── the Appearance panel, with real input ───
  if (!facts.opened || !afterOpen.panelOpen) bad.push('a real click on Appearance did not open the panel');

  if (!facts.clickedModeLabel) bad.push('the Dark mode option was not clickable');
  if (afterMode.mode !== 'dark') {
    bad.push(`a real click on the Dark label did not change the mode (still ${afterMode.mode})`);
  }
  if (!afterMode.panelOpen) bad.push('the panel closed when an option was clicked');
  if (!afterMode.checked?.includes('dark')) bad.push('the Dark radio never became checked');
  if (!afterMode.stored?.includes('"mode":"dark"')) bad.push('the choice was not persisted');

  if (!facts.clickedPalette) bad.push('the Contrast palette option was not clickable');
  if (afterPalette.palette !== 'contrast') {
    bad.push(`a real click on the Contrast option did not change the palette (still ${afterPalette.palette})`);
  }

  // A control below the scroll edge must still be REACHABLE: if the panel is
  // taller than the window it has to scroll, or the last options are simply gone.
  const layout = facts.panelLayout;
  if (layout && layout.panelBottom > layout.viewport + 1 && !['auto', 'scroll'].includes(layout.overflowY)) {
    bad.push(`the panel is ${layout.panelBottom - layout.viewport}px taller than the window and cannot scroll`);
  }

  if (!facts.clickedA11y) bad.push('the accessibility switch was not clickable');
  if (afterA11y.a11y !== 'on') bad.push(`the accessibility switch did not turn on (${afterA11y.a11y})`);
  // The switch is only real if the tokens it changes actually moved.
  if (!facts.a11yLinkHeight || facts.a11yLinkHeight < 44) {
    bad.push(`accessibility mode did not enlarge targets (nav link is ${facts.a11yLinkHeight}px)`);
  }

  if (afterEscape.panelOpen) bad.push('Escape did not close the panel');
  if (afterEscape.triggerExpanded !== 'false') bad.push('Escape left aria-expanded true');

  if (!facts.openedForReset || !facts.clickedReset) bad.push('the reset control was not clickable');
  else if (afterReset.mode === 'dark' && afterReset.palette === 'contrast') {
    bad.push('reset to system default did not change anything');
  }

  if (afterReset.errors?.length) bad.push(`uncaught error(s): ${afterReset.errors[0]}`);

  // ─── hotkeys, driven by real key events ───
  if (!facts.afterHelpKey.dialogOpen) bad.push('a real ? keypress did not open the shortcuts dialog');
  if (facts.afterHelpKey.dialogAriaModal !== 'true') bad.push('the shortcuts dialog is not aria-modal');
  if (!facts.afterHelpKey.dialogFocused) bad.push('focus did not move into the shortcuts dialog');
  if (facts.afterHelpEscape.dialogOpen) bad.push('Escape did not close the shortcuts dialog');

  if (facts.afterF1.path !== '/help') bad.push(`F1 did not open the Help page (at ${facts.afterF1.path})`);
  if (!facts.afterF1.h1 || !/Help/.test(facts.afterF1.h1)) {
    bad.push(`the Help page has no h1 (${facts.afterF1.h1})`);
  }
  if (facts.afterF1.dialogOpen) bad.push('F1 opened the cheatsheet instead of the Help page');

  // ─── metric tiles (only when the instance has data) ───
  const tiles = facts.tiles;
  if (tiles && tiles.count > 1) {
    const backgrounds = new Set(tiles.backgrounds);
    if (backgrounds.size !== tiles.count) {
      bad.push(
        `metric tiles share a background (${[...backgrounds].join(', ')}) — the per-tone tints are not applied`,
      );
    }
    if (tiles.backgrounds.some((colour) => !colour || colour === 'rgba(0, 0, 0, 0)')) {
      bad.push('a metric tile has no background');
    }
    // The chip is the card surface lifted onto the tint, so it must be distinct.
    if (tiles.chips.some((chip, i) => chip && chip === tiles.backgrounds[i])) {
      bad.push('a metric tile chip is painted the same as its own tile');
    }
    // Each value keeps its tone colour; four identical values means the tone
    // classes stopped reaching the CSS.
    if (new Set(tiles.values.filter(Boolean)).size !== tiles.count) {
      bad.push('metric tile values do not each carry their tone colour');
    }
  }

  return bad;
}

async function main() {
  const requireChrome = process.argv.includes('--require-chrome');

  if (!existsSync(join(PUBLIC_DIR, 'index.html'))) {
    console.error(`input-smoke: no built bundle at ${PUBLIC_DIR}. Run: npm run build:dashboard`);
    process.exit(1);
  }

  const urlFlag = process.argv.indexOf('--url');
  const url = urlFlag !== -1 && process.argv[urlFlag + 1] ? process.argv[urlFlag + 1] : undefined;

  const chromePath = findChrome();
  if (!chromePath) {
    const message = 'no Chrome/Chromium found — set CHROME_PATH to drive real input';
    if (requireChrome) {
      console.error(`input-smoke: ✘ ${message}`);
      process.exit(1);
    }
    console.log(`input-smoke: ⚠ SKIPPED — ${message}`);
    process.exit(0);
  }

  const facts = await drive({ chromePath, url });
  const bad = judge(facts);

  if (bad.length) {
    console.error(`input-smoke: ✘ ${bad.length} problem(s):\n - ${bad.join('\n - ')}`);
    process.exit(1);
  }
  const tilesNote = facts.tiles?.count ? ` · ${facts.tiles.count} metric tiles tinted` : '';
  console.log(
    `input-smoke: ✔ real clicks applied · rail ${facts.rail.railBg} vs bar ${facts.rail.barBg}` +
      ` · active pill ${facts.rail.activeBg}${tilesNote}${url ? ` · against ${url}` : ''}`,
  );
}

// Run only when invoked directly, so `drive`/`judge` stay importable for
// diagnostics. The URL form is used (not a path comparison) because it is
// case-insensitive on Windows drives.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`input-smoke: ✘ ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
}
