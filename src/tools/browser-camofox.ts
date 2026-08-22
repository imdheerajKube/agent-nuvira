/**
 * Camofox Browser Backend — Local anti-detection browser via REST API.
 *
 * Camofox-browser is a self-hosted Node.js server wrapping Camoufox (Firefox
 * fork with C++ fingerprint spoofing). It exposes a REST API for:
 * - Accessibility snapshots with element refs
 * - Click/type/scroll by ref
 * - Screenshots
 * - Persistent browser profiles
 *
 * Hermes equivalent: browser_camofox.py + browser_camofox_state.py
 *
 * Setup:
 *   Option 1: npm
 *     git clone https://github.com/jo-inc/camofox-browser && cd camofox-browser
 *     npm install && npm start
 *
 *   Option 2: Docker
 *     docker run -p 9377:9377 -e CAMOFOX_PORT=9377 jo-inc/camofox-browser
 *
 * Then set CAMOFOX_URL=http://localhost:9377 in ~/.buff/.env
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface CamofoxConfig {
  /** Camofox REST API URL (default: http://localhost:9377) */
  url?: string;
  /** Request timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Whether to rewrite loopback URLs for Docker (default: false) */
  rewriteLoopbackUrls?: boolean;
  /** User ID for profile persistence */
  userId?: string;
  /** Profile name for persistence */
  profileName?: string;
}

export interface CamofoxSnapshot {
  /** Snapshot text with element refs */
  text: string;
  /** Parsed elements */
  elements: CamofoxElement[];
  /** Pending dialogs */
  pendingDialogs: CamofoxDialog[];
  /** Page URL */
  url: string;
  /** Page title */
  title: string;
  /** Timestamp */
  timestamp: number;
}

export interface CamofoxElement {
  /** Element ref (e.g., @e1) */
  ref: string;
  /** Element role */
  role: string;
  /** Element name */
  name?: string;
  /** Element value */
  value?: string;
  /** Is element disabled */
  disabled?: boolean;
  /** Is element focused */
  focused?: boolean;
  /** Is element selected */
  selected?: boolean;
}

export interface CamofoxDialog {
  /** Dialog type */
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  /** Dialog message */
  message: string;
  /** Dialog default value (for prompt) */
  defaultValue?: string;
  /** Dialog URL */
  url: string;
}

export interface CamofoxScreenshot {
  /** Base64 encoded image */
  data: string;
  /** Image format */
  format: 'png' | 'jpeg';
  /** Image width */
  width: number;
  /** Image height */
  height: number;
}

// ─── Camofox State Manager ────────────────────────────────────────────────

const CAMOFOX_STATE_DIR = join(homedir(), '.buff', 'browser_auth', 'camofox');

export class CamofoxStateManager {
  /**
   * Get the state directory for Camofox profiles.
   */
  getStateDir(): string {
    if (!existsSync(CAMOFOX_STATE_DIR)) {
      mkdirSync(CAMOFOX_STATE_DIR, { recursive: true });
    }
    return CAMOFOX_STATE_DIR;
  }

  /**
   * Get or create a stable user identity for profile persistence.
   */
  getIdentity(profileName: string = 'default'): { userId: string; profileDir: string } {
    const identityFile = join(this.getStateDir(), `${profileName}.identity.json`);

    if (existsSync(identityFile)) {
      try {
        const data = JSON.parse(readFileSync(identityFile, 'utf-8'));
        return { userId: data.userId, profileDir: join(this.getStateDir(), data.userId) };
      } catch { /* regenerate */ }
    }

    const userId = randomUUID();
    const identity = { userId, profileName, createdAt: Date.now() };
    writeFileSync(identityFile, JSON.stringify(identity, null, 2));

    return { userId, profileDir: join(this.getStateDir(), userId) };
  }

  /**
   * List all stored profiles.
   */
  listProfiles(): string[] {
    const dir = this.getStateDir();
    if (!existsSync(dir)) return [];

    const files = require('node:fs').readdirSync(dir) as string[];
    return files
      .filter((f) => f.endsWith('.identity.json'))
      .map((f) => f.replace('.identity.json', ''));
  }
}

// ─── Camofox Client ───────────────────────────────────────────────────────

export class CamofoxClient {
  private baseUrl: string;
  private timeoutMs: number;
  private rewriteLoopbackUrls: boolean;
  private stateManager: CamofoxStateManager;

  constructor(config: CamofoxConfig = {}) {
    this.baseUrl = config.url || process.env.CAMOFOX_URL || 'http://localhost:9377';
    this.timeoutMs = config.timeoutMs || 30_000;
    this.rewriteLoopbackUrls = config.rewriteLoopbackUrls || process.env.CAMOFOX_REWRITE_LOOPBACK_URLS === 'true';
    this.stateManager = new CamofoxStateManager();
  }

  /**
   * Check if Camofox is available.
   */
  async isAvailable(): Promise<{ available: boolean; version?: string; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const data = await response.json() as { version?: string };
        return { available: true, version: data.version };
      }
      return { available: false, error: `HTTP ${response.status}` };
    } catch (err) {
      return { available: false, error: String(err) };
    }
  }

  /**
   * Open a new page/tab.
   */
  async openPage(url: string, options: { profileName?: string } = {}): Promise<{ pageId: string; url: string }> {
    const identity = this.stateManager.getIdentity(options.profileName);

    const response = await this.post('/page/open', {
      url: this.rewriteUrl(url),
      userId: identity.userId,
      profileDir: identity.profileDir,
    });

    return { pageId: response.pageId, url: response.url };
  }

  /**
   * Get an accessibility snapshot of the current page.
   */
  async snapshot(options: { ref?: string; timeout?: number } = {}): Promise<CamofoxSnapshot> {
    const response = await this.post('/page/snapshot', {
      ref: options.ref,
      timeout: options.timeout || this.timeoutMs,
    });

    return {
      text: response.text || '',
      elements: response.elements || [],
      pendingDialogs: response.pendingDialogs || [],
      url: response.url || '',
      title: response.title || '',
      timestamp: Date.now(),
    };
  }

  /**
   * Click an element by ref.
   */
  async click(ref: string, options: { button?: 'left' | 'right' | 'middle'; doubleClick?: boolean } = {}): Promise<void> {
    await this.post('/page/click', {
      ref,
      button: options.button || 'left',
      doubleClick: options.doubleClick || false,
    });
  }

  /**
   * Type text into an element.
   */
  async type(ref: string, text: string, options: { delay?: number; clear?: boolean } = {}): Promise<void> {
    await this.post('/page/type', {
      ref,
      text,
      delay: options.delay || 50,
      clear: options.clear || false,
    });
  }

  /**
   * Scroll the page.
   */
  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<void> {
    await this.post('/page/scroll', { direction, amount: amount || 500 });
  }

  /**
   * Take a screenshot.
   */
  async screenshot(options: { fullPage?: boolean; format?: 'png' | 'jpeg'; quality?: number } = {}): Promise<CamofoxScreenshot> {
    const response = await this.post('/page/screenshot', {
      fullPage: options.fullPage || false,
      format: options.format || 'png',
      quality: options.quality || 80,
    });

    return {
      data: response.data,
      format: response.format || 'png',
      width: response.width || 0,
      height: response.height || 0,
    };
  }

  /**
   * Navigate to a URL.
   */
  async navigate(url: string): Promise<void> {
    await this.post('/page/navigate', { url: this.rewriteUrl(url) });
  }

  /**
   * Evaluate JavaScript in the page.
   */
  async evaluate(expression: string): Promise<unknown> {
    const response = await this.post('/page/evaluate', { expression });
    return response.result;
  }

  /**
   * Get cookies.
   */
  async getCookies(): Promise<Array<{ name: string; value: string; domain: string; path: string }>> {
    const response = await this.post('/page/cookies', { action: 'get' });
    return response.cookies || [];
  }

  /**
   * Set cookies.
   */
  async setCookies(cookies: Array<{ name: string; value: string; domain?: string; path?: string }>): Promise<void> {
    await this.post('/page/cookies', { action: 'set', cookies });
  }

  /**
   * Close the current page.
   */
  async closePage(): Promise<void> {
    await this.post('/page/close', {});
  }

  /**
   * Close all pages.
   */
  async closeAll(): Promise<void> {
    await this.post('/browser/close', {});
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private rewriteUrl(url: string): string {
    if (!this.rewriteLoopbackUrls) return url;
    return url.replace(/http:\/\/127\.0\.0\.1/g, 'http://host.docker.internal')
              .replace(/http:\/\/localhost/g, 'http://host.docker.internal');
  }

  private async post(endpoint: string, body: Record<string, unknown>): Promise<any> {
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Camofox API error: ${response.status} ${errorText}`);
      }

      return await response.json();
    } catch (err) {
      logger.error(`Camofox: API call failed: ${err}`);
      throw err;
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let _instance: CamofoxClient | null = null;

export function getCamofoxClient(config?: CamofoxConfig): CamofoxClient {
  if (!_instance || config) _instance = new CamofoxClient(config);
  return _instance;
}

export function resetCamofoxClient(): void {
  _instance = null;
}
