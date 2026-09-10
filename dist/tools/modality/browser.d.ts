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
/**
 * Structural subset of playwright's Page used by the action executor.
 * Deliberately NOT imported from playwright so the module loads without the
 * optional package installed (availability gating stays truthful).
 */
export interface BrowserPageLike {
    goto(url: string, opts?: {
        timeout?: number;
    }): Promise<unknown>;
    click(selector: string, opts?: {
        timeout?: number;
    }): Promise<unknown>;
    fill(selector: string, text: string, opts?: {
        timeout?: number;
    }): Promise<unknown>;
    textContent(selector?: string, opts?: {
        timeout?: number;
    }): Promise<string | null>;
    content(): Promise<string>;
    title(): Promise<string>;
    url(): string;
    screenshot(opts?: {
        path?: string;
        fullPage?: boolean;
    }): Promise<Buffer>;
}
/** True when the optional playwright package resolves. */
export declare function isBrowserAvailable(): boolean;
/**
 * Test hook — force availability (true/false) without relying on whether
 * playwright is installed on the machine. Pass null to reset to probing.
 */
export declare function setBrowserAvailable(available: boolean | null): void;
/** Test hook — clear the cached availability probe. */
export declare function resetBrowserAvailability(): void;
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
export declare function executeBrowserAction(page: BrowserPageLike, action: BrowserAction, args: BrowserActionArgs): Promise<{
    text: string;
    file?: string;
}>;
/**
 * Run a browser action against a REAL playwright browser (launch → page →
 * action → close). Returns a friendly message when playwright is missing.
 */
export declare function runBrowserTool(action: BrowserAction, args: BrowserActionArgs): Promise<string>;
//# sourceMappingURL=browser.d.ts.map