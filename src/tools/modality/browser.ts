/**
 * I2 — Browser automation (a Playwright-driven browser tool)
 * `browser_tool.py`).
 *
 * Playwright is OPTIONAL: `isBrowserAvailable()` is false until the package
 * resolves (no forced heavy download — `nuvira tools install browser` or `npm i
 * playwright` opt-in). The action executor is a PURE function over a
 * page-like object, so tests exercise navigation/click/type/extract with a
 * fake page and no browser binary.
 *
 * THE SESSION (2026-10-12). Page automation is a SEQUENCE — open a login form,
 * type the user, type the password, click submit, extract the result — and it
 * used to be impossible: every call launched a browser, ran one action, and
 * closed it, so `click` acted on a blank page and `extract` returned nothing the
 * model had just produced. The tool was "wired" and unusable for the exact tasks
 * its own description recommends (login flows, dynamic scraping). One browser +
 * one page is now kept between calls, closed on `close`, after an idle timeout,
 * or when an action throws (a wedged page must not poison the next call), and
 * actions are SERIALIZED so two parallel tool calls on one page cannot
 * interleave.
 *
 * The availability probe uses `createRequire(import.meta.url)` — the project's
 * convention for an optional package (see enterprise/vault.ts, config/
 * workspace.ts). The previous bare `require.resolve` only works on Node ≥23: on
 * the Node 18/20/22 the package declares support for, it throws and the probe
 * silently answered "not installed" for a package that was installed.
 *
 * Screenshots are written to the artifacts/screenshots sandbox dir.
 */

import { createRequire } from 'node:module';

import { envBuff } from '../../config/paths';
import { writeArtifact, safeArtifactName, resetProbeCache } from './shared.js';

/**
 * Structural subset of playwright's Page used by the action executor.
 * Deliberately NOT imported from playwright so the module loads without the
 * optional package installed (availability gating stays truthful).
 */
export interface BrowserPageLike {
  goto(url: string, opts?: { timeout?: number }): Promise<unknown>;
  click(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  fill(selector: string, text: string, opts?: { timeout?: number }): Promise<unknown>;
  textContent(selector?: string, opts?: { timeout?: number }): Promise<string | null>;
  content(): Promise<string>;
  title(): Promise<string>;
  url(): string;
  screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
}

// ─── Availability ───────────────────────────────────────────────────────────

let _available: boolean | null = null;
let _override: boolean | null = null;

/** True when the optional playwright package resolves. */
export function isBrowserAvailable(): boolean {
  if (_override !== null) return _override;
  if (_available !== null) return _available;
  try {
    // ESM-safe: a bare `require` is not a global here (and on Node 18/20/22 it
    // is not even defined), so the optional package is resolved through the
    // require the ONE way that works in every supported runtime.
    createRequire(import.meta.url).resolve('playwright');
    _available = true;
  } catch {
    _available = false;
  }
  return _available;
}

/**
 * Test hook — force availability (true/false) without relying on whether
 * playwright is installed on the machine. Pass null to reset to probing.
 */
export function setBrowserAvailable(available: boolean | null): void {
  _override = available;
}

/** Test hook — clear the cached availability probe. */
export function resetBrowserAvailability(): void {
  _available = null;
  _override = null;
  resetProbeCache();
}

// ─── Action executor (pure — fake-page testable) ───────────────────────────

export type BrowserAction = 'open' | 'click' | 'type' | 'extract' | 'screenshot' | 'close';

export interface BrowserActionArgs {
  url?: string;
  selector?: string;
  text?: string;
  timeoutMs?: number;
}

/**
 * Execute a browser action against a page-like object. Returns the tool-result
 * text (never throws for user-visible errors).
 */
export async function executeBrowserAction(
  page: BrowserPageLike,
  action: BrowserAction,
  args: BrowserActionArgs,
): Promise<{ text: string; file?: string }> {
  const timeout = args.timeoutMs ?? 15000;
  switch (action) {
    case 'open': {
      if (!args.url) return { text: 'browser_open: url is required' };
      // SSRF guard — reuse the read_page policy: block loopback/private/link-local/
      // metadata hosts unless BUFF_WEB_ALLOW_PRIVATE=1 (same guard, one policy).
      const { isAllowedReadUrl } = await import('../web-research.js');
      if (!isAllowedReadUrl(args.url)) {
        return { text: `browser_open: blocked private/loopback/metadata URL ${args.url} (set BUFF_WEB_ALLOW_PRIVATE=1 to allow)` };
      }
      await page.goto(args.url, { timeout });
      const title = await page.title().catch(() => '');
      const text = await page.textContent('body').catch(() => '');
      return {
        text: `browser_open: navigated to ${args.url}\ntitle: ${title}\ntext: ${(text ?? '').slice(0, 1500)}`,
      };
    }
    case 'click': {
      if (!args.selector) return { text: 'browser_click: selector is required' };
      await page.click(args.selector, { timeout });
      return { text: `browser_click: clicked ${args.selector}` };
    }
    case 'type': {
      if (!args.selector || args.text === undefined) {
        return { text: 'browser_type: selector and text are required' };
      }
      await page.fill(args.selector, args.text, { timeout });
      return { text: `browser_type: filled ${args.selector} with ${JSON.stringify(args.text.slice(0, 80))}` };
    }
    case 'extract': {
      const title = await page.title().catch(() => '');
      const text = args.selector
        ? await page.textContent(args.selector).catch(() => null)
        : await page.textContent('body').catch(() => null);
      return {
        text: `browser_extract: ${page.url()}${title ? `\ntitle: ${title}` : ''}\n${(text ?? '').slice(0, 3000)}`,
      };
    }
    case 'screenshot': {
      const buf = await page.screenshot({ fullPage: true });
      const file = writeArtifact('screenshots', safeArtifactName('shot', '.png'), buf);
      return { text: `browser_screenshot: saved to ${file}`, file };
    }
    default:
      return { text: `browser: unknown action '${action}'` };
  }
}

// ─── Persistent session ─────────────────────────────────────────────────────

/** Structural shape of the browser object we keep alive (not a playwright import). */
export interface BrowserLike {
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
}

interface BrowserSession {
  browser: BrowserLike;
  page: BrowserPageLike;
  timer: NodeJS.Timeout | null;
}

let _session: BrowserSession | null = null;

/** How long an idle session is kept before it is closed (5 min by default). */
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

function idleMs(): number {
  const raw = Number(envBuff('BROWSER_IDLE_MS'));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_MS;
}

/** Test seam: replace the real `chromium.launch()` with a fake browser. */
type BrowserLauncher = () => Promise<{ browser: BrowserLike; page: BrowserPageLike }>;
let _launcher: BrowserLauncher | null = null;

export function setBrowserLauncherForTests(launcher: BrowserLauncher | null): void {
  _launcher = launcher;
}

/** The real launcher: headless chromium, one page. */
async function launchChromium(): Promise<{ browser: BrowserLike; page: BrowserPageLike }> {
  const { chromium } = await import('playwright');
  const browser = (await chromium.launch({ headless: true })) as unknown as BrowserLike;
  const page = await browser.newPage();
  return { browser, page };
}

/**
 * Close the session (best-effort, never throws). Returns true when one was open.
 * Exported so a caller can end automation deterministically instead of waiting
 * for the idle timer.
 */
export async function closeBrowserSession(): Promise<boolean> {
  const session = _session;
  _session = null;
  if (!session) return false;
  if (session.timer) clearTimeout(session.timer);
  await session.browser.close().catch(() => undefined);
  return true;
}

/** (Re)arm the idle timer so a live session is not closed mid-flow. */
function touchSession(session: BrowserSession): void {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    void closeBrowserSession();
  }, idleMs());
  // Never hold the process open just for the idle timer.
  session.timer.unref?.();
}

/**
 * The page for this call: the live one, or a freshly launched browser. Also
 * used by `close` (which needs no page) to report whether one existed.
 */
async function acquirePage(): Promise<BrowserPageLike> {
  if (_session) {
    touchSession(_session);
    return _session.page;
  }
  const launched = await (_launcher ?? launchChromium)();
  const session: BrowserSession = { browser: launched.browser, page: launched.page, timer: null };
  _session = session;
  touchSession(session);
  return session.page;
}

/**
 * One action at a time. Two parallel tool calls must not interleave on one page
 * (a click landing between another call's type and its submit is a bug that
 * looks like a flaky site). The queue is a promise chain, so callers still get
 * their own result and a rejected action never stalls the chain.
 */
let _queue: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = _queue.then(fn, fn);
  _queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ─── Tool-facing run ────────────────────────────────────────────────────────

/**
 * Run a browser action against a REAL playwright browser, reusing ONE session
 * across calls so a multi-step flow (open → type → click → extract) works.
 * Returns a friendly message when playwright is missing.
 */
export async function runBrowserTool(action: BrowserAction, args: BrowserActionArgs): Promise<string> {
  if (!isBrowserAvailable() && !_launcher) {
    return 'browser: unavailable — install the optional playwright package (nuvira tools install browser, or npm i playwright && npx playwright install chromium).';
  }
  return serialize(async () => {
    if (action === 'close') {
      const closed = await closeBrowserSession();
      return closed
        ? 'browser_close: session closed'
        : 'browser_close: no session was open';
    }
    try {
      const page = await acquirePage();
      const result = await executeBrowserAction(page, action, args);
      touchSession(_session!);
      return result.text;
    } catch (err) {
      // A failed action can leave the page (or the browser) unusable — drop the
      // session so the next call starts clean instead of acting on a dead page.
      await closeBrowserSession();
      return `browser: ${action} failed — ${err instanceof Error ? err.message : String(err)}`;
    }
  });
}


