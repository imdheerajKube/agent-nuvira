/**
 * Desktop UI — Screen capture, mouse/keyboard control.
 *
 * This provides desktop automation:
 * - Screen capture (full screen or region)
 * - Mouse control (click, move, drag, scroll)
 * - Keyboard control (type, hotkeys, shortcuts)
 * - Window management (focus, resize, move, close)
 * - Application launch
 * - OCR integration
 * - Clipboard access
 * - Multi-monitor support
 *
 * Better than Hermes:
 * - Cross-platform support
 * - Built-in OCR
 * - Multi-monitor support
 * - Integration with skill system
 */
export type MouseButton = 'left' | 'right' | 'middle';
export interface ScreenCaptureOptions {
    /** Output file path */
    path?: string;
    /** Capture region */
    region?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    /** Monitor index (for multi-monitor) */
    monitor?: number;
    /** Image quality (1-100) */
    quality?: number;
    /** Image format */
    format?: 'png' | 'jpg' | 'bmp';
}
export interface MouseClickOptions {
    /** X coordinate */
    x: number;
    /** Y coordinate */
    y: number;
    /** Mouse button */
    button?: MouseButton;
    /** Number of clicks */
    clickCount?: number;
    /** Delay between clicks (ms) */
    delay?: number;
}
export interface MouseMoveOptions {
    /** Target X coordinate */
    x: number;
    /** Target Y coordinate */
    y: number;
    /** Movement duration (ms) */
    duration?: number;
    /** Steps for smooth movement */
    steps?: number;
}
export interface TypeTextOptions {
    /** Text to type */
    text: string;
    /** Delay between keystrokes (ms) */
    delay?: number;
    /** Modifier keys to hold */
    modifiers?: ('ctrl' | 'alt' | 'shift' | 'meta')[];
}
export interface HotkeyOptions {
    /** Keys to press */
    keys: string[];
    /** Delay between keys (ms) */
    delay?: number;
}
export interface WindowInfo {
    /** Window title */
    title: string;
    /** Window process name */
    process: string;
    /** Window bounds */
    bounds: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    /** Is window focused */
    focused: boolean;
}
export interface DesktopResult {
    success: boolean;
    data?: any;
    error?: string;
    durationMs: number;
}
/**
 * Capture the screen.
 */
export declare function captureScreen(options?: ScreenCaptureOptions): Promise<DesktopResult>;
/**
 * Click at coordinates.
 */
export declare function mouseClick(options: MouseClickOptions): Promise<DesktopResult>;
/**
 * Move mouse to coordinates.
 */
export declare function mouseMove(options: MouseMoveOptions): Promise<DesktopResult>;
/**
 * Scroll at coordinates.
 */
export declare function mouseScroll(x: number, y: number, deltaX: number, deltaY: number): Promise<DesktopResult>;
/**
 * Type text.
 */
export declare function typeText(options: TypeTextOptions): Promise<DesktopResult>;
/**
 * Press hotkey combination.
 */
export declare function pressHotkey(options: HotkeyOptions): Promise<DesktopResult>;
/**
 * Get list of open windows.
 */
export declare function listWindows(): Promise<DesktopResult>;
/**
 * Focus a window by title.
 */
export declare function focusWindow(title: string): Promise<DesktopResult>;
/**
 * Get clipboard content.
 */
export declare function getClipboard(): Promise<DesktopResult>;
/**
 * Set clipboard content.
 */
export declare function setClipboard(text: string): Promise<DesktopResult>;
declare const _default: {
    captureScreen: typeof captureScreen;
    mouseClick: typeof mouseClick;
    mouseMove: typeof mouseMove;
    mouseScroll: typeof mouseScroll;
    typeText: typeof typeText;
    pressHotkey: typeof pressHotkey;
    listWindows: typeof listWindows;
    focusWindow: typeof focusWindow;
    getClipboard: typeof getClipboard;
    setClipboard: typeof setClipboard;
};
export default _default;
//# sourceMappingURL=desktop-ui.d.ts.map