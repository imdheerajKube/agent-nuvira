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
 * Then set CAMOFOX_URL=http://localhost:9377 in ~/.nuvira/.env
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolveNuviraHome } from '../config/paths.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
// ─── Camofox State Manager ────────────────────────────────────────────────
const CAMOFOX_STATE_DIR = join(resolveNuviraHome(), 'browser_auth', 'camofox');
export class CamofoxStateManager {
    /**
     * Get the state directory for Camofox profiles.
     */
    getStateDir() {
        if (!existsSync(CAMOFOX_STATE_DIR)) {
            mkdirSync(CAMOFOX_STATE_DIR, { recursive: true });
        }
        return CAMOFOX_STATE_DIR;
    }
    /**
     * Get or create a stable user identity for profile persistence.
     */
    getIdentity(profileName = 'default') {
        const identityFile = join(this.getStateDir(), `${profileName}.identity.json`);
        if (existsSync(identityFile)) {
            try {
                const data = JSON.parse(readFileSync(identityFile, 'utf-8'));
                return { userId: data.userId, profileDir: join(this.getStateDir(), data.userId) };
            }
            catch { /* regenerate */ }
        }
        const userId = randomUUID();
        const identity = { userId, profileName, createdAt: Date.now() };
        writeFileSync(identityFile, JSON.stringify(identity, null, 2));
        return { userId, profileDir: join(this.getStateDir(), userId) };
    }
    /**
     * List all stored profiles.
     */
    listProfiles() {
        const dir = this.getStateDir();
        if (!existsSync(dir))
            return [];
        const files = require('node:fs').readdirSync(dir);
        return files
            .filter((f) => f.endsWith('.identity.json'))
            .map((f) => f.replace('.identity.json', ''));
    }
}
// ─── Camofox Client ───────────────────────────────────────────────────────
export class CamofoxClient {
    baseUrl;
    timeoutMs;
    rewriteLoopbackUrls;
    stateManager;
    constructor(config = {}) {
        this.baseUrl = config.url || process.env.CAMOFOX_URL || 'http://localhost:9377';
        this.timeoutMs = config.timeoutMs || 30_000;
        this.rewriteLoopbackUrls = config.rewriteLoopbackUrls || process.env.CAMOFOX_REWRITE_LOOPBACK_URLS === 'true';
        this.stateManager = new CamofoxStateManager();
    }
    /**
     * Check if Camofox is available.
     */
    async isAvailable() {
        try {
            const response = await fetch(`${this.baseUrl}/health`, {
                signal: AbortSignal.timeout(5_000),
            });
            if (response.ok) {
                const data = await response.json();
                return { available: true, version: data.version };
            }
            return { available: false, error: `HTTP ${response.status}` };
        }
        catch (err) {
            return { available: false, error: String(err) };
        }
    }
    /**
     * Open a new page/tab.
     */
    async openPage(url, options = {}) {
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
    async snapshot(options = {}) {
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
    async click(ref, options = {}) {
        await this.post('/page/click', {
            ref,
            button: options.button || 'left',
            doubleClick: options.doubleClick || false,
        });
    }
    /**
     * Type text into an element.
     */
    async type(ref, text, options = {}) {
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
    async scroll(direction, amount) {
        await this.post('/page/scroll', { direction, amount: amount || 500 });
    }
    /**
     * Take a screenshot.
     */
    async screenshot(options = {}) {
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
    async navigate(url) {
        await this.post('/page/navigate', { url: this.rewriteUrl(url) });
    }
    /**
     * Evaluate JavaScript in the page.
     */
    async evaluate(expression) {
        const response = await this.post('/page/evaluate', { expression });
        return response.result;
    }
    /**
     * Get cookies.
     */
    async getCookies() {
        const response = await this.post('/page/cookies', { action: 'get' });
        return response.cookies || [];
    }
    /**
     * Set cookies.
     */
    async setCookies(cookies) {
        await this.post('/page/cookies', { action: 'set', cookies });
    }
    /**
     * Close the current page.
     */
    async closePage() {
        await this.post('/page/close', {});
    }
    /**
     * Close all pages.
     */
    async closeAll() {
        await this.post('/browser/close', {});
    }
    // ─── Internal ────────────────────────────────────────────────────────
    rewriteUrl(url) {
        if (!this.rewriteLoopbackUrls)
            return url;
        return url.replace(/http:\/\/127\.0\.0\.1/g, 'http://host.docker.internal')
            .replace(/http:\/\/localhost/g, 'http://host.docker.internal');
    }
    async post(endpoint, body) {
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
        }
        catch (err) {
            logger.error(`Camofox: API call failed: ${err}`);
            throw err;
        }
    }
}
// ─── Singleton ────────────────────────────────────────────────────────────
let _instance = null;
export function getCamofoxClient(config) {
    if (!_instance || config)
        _instance = new CamofoxClient(config);
    return _instance;
}
export function resetCamofoxClient() {
    _instance = null;
}
//# sourceMappingURL=browser-camofox.js.map