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
 * Screenshots are written to the artifacts/screenshots sandbox dir.
 */

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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require.resolve('playwright');
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

export type BrowserAction = 'open' | 'click' | 'type' | 'extract' | 'screenshot';

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

// ─── Tool-facing run ────────────────────────────────────────────────────────

/**
 * Run a browser action against a REAL playwright browser (launch → page →
 * action → close). Returns a friendly message when playwright is missing.
 */
export async function runBrowserTool(action: BrowserAction, args: BrowserActionArgs): Promise<string> {
  if (!isBrowserAvailable()) {
    return 'browser: unavailable — install the optional playwright package (npm i playwright && npx playwright install chromium) to use browser tools.';
  }
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const result = await executeBrowserAction(page, action, args);
      return result.text;
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch (err) {
    return `browser: failed — ${err instanceof Error ? err.message : String(err)}`;
  }
}


