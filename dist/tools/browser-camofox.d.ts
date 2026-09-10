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
export declare class CamofoxStateManager {
    /**
     * Get the state directory for Camofox profiles.
     */
    getStateDir(): string;
    /**
     * Get or create a stable user identity for profile persistence.
     */
    getIdentity(profileName?: string): {
        userId: string;
        profileDir: string;
    };
    /**
     * List all stored profiles.
     */
    listProfiles(): string[];
}
export declare class CamofoxClient {
    private baseUrl;
    private timeoutMs;
    private rewriteLoopbackUrls;
    private stateManager;
    constructor(config?: CamofoxConfig);
    /**
     * Check if Camofox is available.
     */
    isAvailable(): Promise<{
        available: boolean;
        version?: string;
        error?: string;
    }>;
    /**
     * Open a new page/tab.
     */
    openPage(url: string, options?: {
        profileName?: string;
    }): Promise<{
        pageId: string;
        url: string;
    }>;
    /**
     * Get an accessibility snapshot of the current page.
     */
    snapshot(options?: {
        ref?: string;
        timeout?: number;
    }): Promise<CamofoxSnapshot>;
    /**
     * Click an element by ref.
     */
    click(ref: string, options?: {
        button?: 'left' | 'right' | 'middle';
        doubleClick?: boolean;
    }): Promise<void>;
    /**
     * Type text into an element.
     */
    type(ref: string, text: string, options?: {
        delay?: number;
        clear?: boolean;
    }): Promise<void>;
    /**
     * Scroll the page.
     */
    scroll(direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<void>;
    /**
     * Take a screenshot.
     */
    screenshot(options?: {
        fullPage?: boolean;
        format?: 'png' | 'jpeg';
        quality?: number;
    }): Promise<CamofoxScreenshot>;
    /**
     * Navigate to a URL.
     */
    navigate(url: string): Promise<void>;
    /**
     * Evaluate JavaScript in the page.
     */
    evaluate(expression: string): Promise<unknown>;
    /**
     * Get cookies.
     */
    getCookies(): Promise<Array<{
        name: string;
        value: string;
        domain: string;
        path: string;
    }>>;
    /**
     * Set cookies.
     */
    setCookies(cookies: Array<{
        name: string;
        value: string;
        domain?: string;
        path?: string;
    }>): Promise<void>;
    /**
     * Close the current page.
     */
    closePage(): Promise<void>;
    /**
     * Close all pages.
     */
    closeAll(): Promise<void>;
    private rewriteUrl;
    private post;
}
export declare function getCamofoxClient(config?: CamofoxConfig): CamofoxClient;
export declare function resetCamofoxClient(): void;
//# sourceMappingURL=browser-camofox.d.ts.map