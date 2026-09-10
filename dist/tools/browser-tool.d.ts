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
export interface BrowserConfig {
    /** Browser executable path */
    executablePath?: string;
    /** Headless mode (default: true) */
    headless?: boolean;
    /** Window size */
    viewport?: {
        width: number;
        height: number;
    };
    /** Proxy configuration */
    proxy?: {
        server: string;
        username?: string;
        password?: string;
    };
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
    clip?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    /** Image quality (1-100) */
    quality?: number;
}
export interface BrowserResult {
    success: boolean;
    data?: any;
    error?: string;
    durationMs: number;
}
export declare class BrowserTool {
    private process;
    private config;
    private cdpPort;
    private sessionId;
    constructor(config?: BrowserConfig);
    /**
     * Launch browser instance.
     */
    launch(): Promise<BrowserResult>;
    /**
     * Navigate to a URL.
     */
    navigate(options: NavigateOptions): Promise<BrowserResult>;
    /**
     * Click an element.
     */
    click(options: ClickOptions): Promise<BrowserResult>;
    /**
     * Type text into an element.
     */
    type(options: TypeOptions): Promise<BrowserResult>;
    /**
     * Execute JavaScript in the page.
     */
    evaluate(expression: string): Promise<BrowserResult>;
    /**
     * Take a screenshot.
     */
    screenshot(options?: ScreenshotOptions): Promise<BrowserResult>;
    /**
     * Get page content.
     */
    getContent(): Promise<BrowserResult>;
    /**
     * Get page title.
     */
    getTitle(): Promise<BrowserResult>;
    /**
     * Get current URL.
     */
    getUrl(): Promise<BrowserResult>;
    /**
     * Set cookie.
     */
    setCookie(cookie: {
        name: string;
        value: string;
        domain?: string;
        path?: string;
        expires?: number;
        httpOnly?: boolean;
        secure?: boolean;
        sameSite?: 'Strict' | 'Lax' | 'None';
    }): Promise<BrowserResult>;
    /**
     * Get cookies.
     */
    getCookies(): Promise<BrowserResult>;
    /**
     * Delete cookie.
     */
    deleteCookie(name: string, domain?: string, path?: string): Promise<BrowserResult>;
    /**
     * Get local storage.
     */
    getLocalStorage(): Promise<BrowserResult>;
    /**
     * Set local storage item.
     */
    setLocalStorage(key: string, value: string): Promise<BrowserResult>;
    /**
     * Wait for element to appear.
     */
    waitForSelector(selector: string, timeout?: number): Promise<BrowserResult>;
    /**
     * Close browser.
     */
    close(): Promise<void>;
    private findChrome;
    private buildArgs;
    private waitForCdp;
    private cdpCommand;
    private querySelector;
    private getBoundingBox;
    private focus;
    private waitForLoad;
    private waitForNetworkIdle;
    private sleep;
}
/**
 * Get or create browser instance.
 */
export declare function getBrowser(config?: BrowserConfig): Promise<BrowserTool>;
/**
 * Close browser instance.
 */
export declare function closeBrowser(): Promise<void>;
/**
 * Execute a browser-based skill.
 */
export declare function executeBrowserSkill(skillContent: string, options?: {
    url?: string;
    actions?: Array<{
        type: string;
        params: any;
    }>;
}): Promise<BrowserResult>;
//# sourceMappingURL=browser-tool.d.ts.map