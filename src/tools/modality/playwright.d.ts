/**
 * Ambient declaration for the OPTIONAL playwright package (I2 browser tool).
 *
 * Playwright is deliberately NOT a dependency — it is an opt-in install
 * (`npm i playwright && npx playwright install chromium`). This declaration
 * lets the browser tool typecheck (and its dynamic `import('playwright')`
 * compile) even when the package is absent; availability is probed at RUNTIME
 * via isBrowserAvailable() and the tool degrades gracefully.
 */

declare module 'playwright' {
  export interface BrowserContextOptions {}
  export interface Browser {
    newPage(): Promise<Page>;
    close(): Promise<void>;
  }
  export interface Page {
    goto(url: string, opts?: { timeout?: number }): Promise<unknown>;
    click(selector: string, opts?: { timeout?: number }): Promise<unknown>;
    fill(selector: string, text: string, opts?: { timeout?: number }): Promise<unknown>;
    textContent(selector?: string, opts?: { timeout?: number }): Promise<string | null>;
    content(): Promise<string>;
    title(): Promise<string>;
    url(): string;
    screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
  }
  export const chromium: {
    launch(opts?: { headless?: boolean }): Promise<Browser>;
  };
}
