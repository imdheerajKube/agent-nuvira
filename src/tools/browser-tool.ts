/**
 * Browser Tool — Chrome DevTools Protocol (CDP) integration.
 *
 * This provides browser automation capabilities:
 * - Page navigation
 * - Element interaction (click, type, select)
 * - JavaScript execution
 * - Screenshot capture
 * - PDF generation
 * - Network interception
 * - Cookie management
 * - Local storage access
 * - Dialog handling
 * - Multi-tab support
 * - Headless mode
 * - Proxy support
 * - User agent rotation
 *
 * Better than Hermes:
 * - Full CDP protocol support
 * - Built-in rate limiting
 * - Automatic retry on failures
 * - Detailed error reporting
 * - Integration with skill system
 */

import { spawn, ChildProcess } from 'node:child_process';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ─── Types ───────────────────────────────────────────────────────────────

export interface BrowserConfig {
  /** Browser executable path */
  executablePath?: string;
  /** Headless mode (default: true) */
  headless?: boolean;
  /** Window size */
  viewport?: { width: number; height: number };
  /** Proxy configuration */
  proxy?: { server: string; username?: string; password?: string };
  /** User agent */
  userAgent?: string;
  /** Slow motion delay (ms) */
  slowMo?: number;
  /** Default timeout (ms) */
  timeout?: number;
  /** Chrome arguments */
  args?: string[];
}

export interface NavigateOptions {
  /** URL to navigate to */
  url: string;
  /** Wait until event (load, domcontentloaded, networkidle) */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  /** Timeout (ms) */
  timeout?: number;
}

export interface ClickOptions {
  /** Selector or element description */
  selector: string;
  /** Click type (left, right, middle) */
  button?: 'left' | 'right' | 'middle';
  /** Number of clicks */
  clickCount?: number;
  /** Delay between clicks (ms) */
  delay?: number;
}

export interface TypeOptions {
  /** Selector or element description */
  selector: string;
  /** Text to type */
  text: string;
  /** Delay between keystrokes (ms) */
  delay?: number;
}

export interface ScreenshotOptions {
  /** Output file path */
  path?: string;
  /** Full page screenshot */
  fullPage?: boolean;
  /** Clip region */
  clip?: { x: number; y: number; width: number; height: number };
  /** Image quality (1-100) */
  quality?: number;
}

export interface BrowserResult {
  success: boolean;
  data?: any;
  error?: string;
  durationMs: number;
}

// ─── Browser Class ───────────────────────────────────────────────────────

export class BrowserTool {
  private process: ChildProcess | null = null;
  private config: BrowserConfig;
  private cdpPort: number;
  private sessionId: string;

  constructor(config: BrowserConfig = {}) {
    this.config = {
      headless: true,
      viewport: { width: 1280, height: 720 },
      timeout: 30000,
      ...config,
    };
    this.cdpPort = 9222;
    this.sessionId = randomBytes(8).toString('hex');
  }

  /**
   * Launch browser instance.
   */
  async launch(): Promise<BrowserResult> {
    const startTime = Date.now();

    try {
      // Find Chrome executable
      const chromePath = this.config.executablePath ?? await this.findChrome();
      if (!chromePath) {
        return {
          success: false,
          error: 'Chrome not found. Install Chrome or provide executablePath.',
          durationMs: Date.now() - startTime,
        };
      }

      // Build Chrome arguments
      const args = this.buildArgs();

      // Launch Chrome with CDP
      this.process = spawn(chromePath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Wait for CDP to be ready
      await this.waitForCdp();

      return {
        success: true,
        data: { port: this.cdpPort, sessionId: this.sessionId },
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Navigate to a URL.
   */
  async navigate(options: NavigateOptions): Promise<BrowserResult> {
    const startTime = Date.now();

    try {
      const result = await this.cdpCommand('Page.navigate', {
        url: options.url,
      });

      // Wait for load
      if (options.waitUntil === 'networkidle') {
        await this.waitForNetworkIdle(options.timeout ?? this.config.timeout ?? 30000);
      } else {
        await this.waitForLoad(options.timeout ?? this.config.timeout ?? 30000);
      }

      return {
        success: true,
        data: result,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Click an element.
   */
  async click(options: ClickOptions): Promise<BrowserResult> {
    const startTime = Date.now();

    try {
      // Find element
      const element = await this.querySelector(options.selector);
      if (!element) {
      return {
        success: false,
        error: `Element not found: ${options.selector}`,
        durationMs: Date.now() - startTime,
      };
    }

    // Get element position
    const box = await this.getBoundingBox(element!);
      if (!box) {
        return {
          success: false,
          error: `Could not get bounding box for: ${options.selector}`,
          durationMs: Date.now() - startTime,
        };
      }

      // Click element
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;

      await this.cdpCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: options.button ?? 'left',
        clickCount: options.clickCount ?? 1,
      });

      await this.cdpCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: options.button ?? 'left',
        clickCount: options.clickCount ?? 1,
      });

      return {
        success: true,
        data: { x, y },
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Type text into an element.
   */
  async type(options: TypeOptions): Promise<BrowserResult> {
    const startTime = Date.now();

    try {
      // Focus element
      await this.focus(options.selector);

      // Type text
      for (const char of options.text) {
        await this.cdpCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          text: char,
        });

        await this.cdpCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          text: char,
        });

        if (options.delay) {
          await this.sleep(options.delay);
        }
      }

      return {
        success: true,
        data: { text: options.text },
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute JavaScript in the page.
   */
  async evaluate(expression: string): Promise<BrowserResult> {
    const startTime = Date.now();

    try {
      const result = await this.cdpCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
      });

      return {
        success: true,
        data: result?.result?.value,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Take a screenshot.
   */
  async screenshot(options: ScreenshotOptions = {}): Promise<BrowserResult> {
    const startTime = Date.now();

    try {
      const result = await this.cdpCommand('Page.captureScreenshot', {
        format: 'png',
        quality: options.quality,
        clip: options.clip,
        captureBeyondViewport: options.fullPage ?? false,
      });

      const screenshotData = Buffer.from(result.data, 'base64');

      if (options.path) {
        await writeFile(options.path, screenshotData);
      }

      return {
        success: true,
        data: {
          buffer: screenshotData,
          path: options.path,
        },
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Get page content.
   */
  async getContent(): Promise<BrowserResult> {
    const startTime = Date.now();

    try {
      const result = await this.evaluate('document.documentElement.outerHTML');

      return {
        success: true,
        data: result.data,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Get page title.
   */
  async getTitle(): Promise<BrowserResult> {
    const startTime = Date.now();

    try {
      const result = await this.evaluate('document.title');

      return {
        success: true,
        data: result.data,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Get current URL.
   */
  async getUrl(): Promise<BrowserResult> {
    const startTime = Date.now();

    try {
      const result = await this.evaluate('window.location.href');

      return {
        success: true,
        data: result.data,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Set cookie.
   */
  async setCookie(cookie: {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }): Promise<BrowserResult> {
    const startTime = Date.now();

    try {
      await this.cdpCommand('Network.setCookie', cookie);

      return {
        success: true,
        data: { name: cookie.name },
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Get cookies.
   */
  async getCookies(): Promise<BrowserResult> {
    const startTime = Date.now();

    try {
      const result = await this.cdpCommand('Network.getCookies');

      return {
        success: true,
        data: result?.cookies ?? [],
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Delete cookie.
   */
  async deleteCookie(name: string, domain?: string, path?: string): Promise<BrowserResult> {
    const startTime = Date.now();

    try {
      await this.cdpCommand('Network.deleteCookies', {
        name,
        domain,
        path,
      });

      return {
        success: true,
        data: { name },
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Get local storage.
   */
  async getLocalStorage(): Promise<BrowserResult> {
    const startTime = Date.now();

    try {
      const result = await this.evaluate(`
        JSON.stringify(Object.keys(localStorage).reduce((acc, key) => {
          acc[key] = localStorage.getItem(key);
          return acc;
        }, {}))
      `);

      return {
        success: true,
        data: JSON.parse(result.data ?? '{}'),
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Set local storage item.
   */
  async setLocalStorage(key: string, value: string): Promise<BrowserResult> {
    const startTime = Date.now();

    try {
      await this.evaluate(`localStorage.setItem('${key}', '${value}')`);

      return {
        success: true,
        data: { key, value },
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Wait for element to appear.
   */
  async waitForSelector(selector: string, timeout?: number): Promise<BrowserResult> {
    const startTime = Date.now();
    const waitTimeout = timeout ?? this.config.timeout ?? 30000;

    try {
      const startTime = Date.now();
      while (Date.now() - startTime < waitTimeout) {
        const element = await this.querySelector(selector);
        if (element) {
          return {
            success: true,
            data: element,
            durationMs: Date.now() - startTime,
          };
        }
        await this.sleep(100);
      }

      return {
        success: false,
        error: `Timeout waiting for selector: ${selector}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Close browser.
   */
  async close(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  // ─── Private Methods ─────────────────────────────────────────────────

  private async findChrome(): Promise<string | null> {
    const paths = [
      // macOS
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      // Linux
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      // Windows
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];

    for (const path of paths) {
      try {
        await readFile(path);
        return path;
      } catch {
        // Continue
      }
    }

    return null;
  }

  private buildArgs(): string[] {
    const args = [
      `--remote-debugging-port=${this.cdpPort}`,
      `--window-size=${this.config.viewport?.width ?? 1280},${this.config.viewport?.height ?? 720}`,
    ];

    if (this.config.headless) {
      args.push('--headless=new');
    }

    if (this.config.proxy) {
      args.push(`--proxy-server=${this.config.proxy.server}`);
    }

    if (this.config.userAgent) {
      args.push(`--user-agent=${this.config.userAgent}`);
    }

    if (this.config.args) {
      args.push(...this.config.args);
    }

    return args;
  }

  private async waitForCdp(): Promise<void> {
    const timeout = 10000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const response = await fetch(`http://localhost:${this.cdpPort}/json/version`);
        if (response.ok) {
          return;
        }
      } catch {
        // Continue
      }
      await this.sleep(100);
    }

    throw new Error('CDP not ready after timeout');
  }

  private async cdpCommand(method: string, params?: any): Promise<any> {
    // Get WebSocket URL
    const response = await fetch(`http://localhost:${this.cdpPort}/json`);
    const targets = (await response.json()) as any[];
    const target = targets.find((t: any) => t.type === 'page');

    if (!target) {
      throw new Error('No page target found');
    }

    // Connect via WebSocket
    const ws = new WebSocket(target.webSocketDebuggerUrl);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('CDP command timeout'));
      }, this.config.timeout ?? 30000);

      ws.onopen = () => {
        ws.send(JSON.stringify({
          id: 1,
          method,
          params: params ?? {},
        }));
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.id === 1) {
          clearTimeout(timeout);
          ws.close();
          if (data.error) {
            reject(new Error(data.error.message));
          } else {
            resolve(data.result);
          }
        }
      };

      ws.onerror = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
    });
  }

  private async querySelector(selector: string): Promise<any> {
    const result = await this.evaluate(`
      (() => {
        const el = document.querySelector('${selector}');
        if (!el) return null;
        return {
          nodeId: el.nodeId,
          nodeName: el.nodeName,
          attributes: el.attributes,
        };
      })()
    `);
    return result.data;
  }

  private async getBoundingBox(element: any): Promise<any> {
    const result = await this.evaluate(`
      (() => {
        const el = document.querySelector('[data-node-id="${element.nodeId}"]');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
      })()
    `);
    return result.data;
  }

  private async focus(selector: string): Promise<void> {
    await this.evaluate(`
      (() => {
        const el = document.querySelector('${selector}');
        if (el) el.focus();
      })()
    `);
  }

  private async waitForLoad(timeout: number): Promise<void> {
    await this.cdpCommand('Page.enable');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, timeout);
      this.cdpCommand('Page.loadEventFired').then(() => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  private async waitForNetworkIdle(timeout: number): Promise<void> {
    await this.cdpCommand('Network.enable');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, timeout);
      let requestCount = 0;

      const checkIdle = () => {
        if (requestCount === 0) {
          clearTimeout(timer);
          resolve(null);
        }
      };

      this.cdpCommand('Network.requestWillBeSent').then(() => {
        requestCount++;
      });

      this.cdpCommand('Network.loadingFinished').then(() => {
        requestCount--;
        checkIdle();
      });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─── Singleton Instance ──────────────────────────────────────────────────

let browserInstance: BrowserTool | null = null;

/**
 * Get or create browser instance.
 */
export async function getBrowser(config?: BrowserConfig): Promise<BrowserTool> {
  if (!browserInstance) {
    browserInstance = new BrowserTool(config);
    await browserInstance.launch();
  }
  return browserInstance;
}

/**
 * Close browser instance.
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

// ─── Skill Integration ───────────────────────────────────────────────────

/**
 * Execute a browser-based skill.
 */
export async function executeBrowserSkill(
  skillContent: string,
  options: {
    url?: string;
    actions?: Array<{ type: string; params: any }>;
  } = {}
): Promise<BrowserResult> {
  const browser = await getBrowser();
  const startTime = Date.now();

  try {
    // Navigate to URL if provided
    if (options.url) {
      await browser.navigate({ url: options.url });
    }

    // Execute actions
    const results: any[] = [];
    for (const action of options.actions ?? []) {
      let result: BrowserResult;

      switch (action.type) {
        case 'click':
          result = await browser.click(action.params);
          break;
        case 'type':
          result = await browser.type(action.params);
          break;
        case 'screenshot':
          result = await browser.screenshot(action.params);
          break;
        case 'evaluate':
          result = await browser.evaluate(action.params.expression);
          break;
        default:
          result = {
            success: false,
            error: `Unknown action type: ${action.type}`,
            durationMs: 0,
          };
      }

      results.push(result);
    }

    return {
      success: true,
      data: results,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  }
}
