/**
 * Utility Tools — Small utility tools from Hermes.
 *
 * Hermes equivalents:
 * - ansi_strip.py (79 lines)
 * - close_terminal_tool.py (70 lines)
 * - focus_pane_tool.py (70 lines)
 * - open_preview_tool.py (97 lines)
 * - read_terminal_tool.py (93 lines)
 * - osv_check.py (218 lines)
 * - website_policy.py (283 lines)
 * - patch_parser.py (729 lines)
 * - audio_container.py (97 lines)
 * - image_source.py (391 lines)
 */
export declare class ANSIStripper {
    /**
     * Strip ANSI escape codes from a string.
     */
    strip(text: string): string;
    /**
     * Check if a string contains ANSI codes.
     */
    hasAnsi(text: string): boolean;
}
export interface OSVulnerability {
    id: string;
    summary: string;
    severity: string;
    affected: string[];
    fixed?: string;
}
export declare class OSVChecker {
    /**
     * Check for known vulnerabilities in a package.
     */
    check(packageName: string, version: string): Promise<OSVulnerability[]>;
}
export interface PolicyCheck {
    url: string;
    allowed: boolean;
    reason?: string;
    category?: string;
}
export declare class WebsitePolicyChecker {
    private blockedDomains;
    private blockedPatterns;
    /**
     * Check if a URL is allowed.
     */
    check(url: string): PolicyCheck;
}
export interface PatchFile {
    path: string;
    additions: number;
    deletions: number;
    hunks: PatchHunk[];
}
export interface PatchHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    changes: PatchChange[];
}
export interface PatchChange {
    type: 'add' | 'remove' | 'context';
    line: string;
    lineNumber?: number;
}
export declare class PatchParser {
    /**
     * Parse a unified diff patch.
     */
    parse(patch: string): PatchFile[];
}
export interface ImageSourceInfo {
    path: string;
    format: string;
    size: number;
    isScreenshot: boolean;
    source?: string;
}
export declare class ImageSourceDetector {
    private screenshotPatterns;
    private screenshotExtensions;
    /**
     * Detect image source information.
     */
    detect(filePath: string): ImageSourceInfo;
}
export interface AudioInfo {
    path: string;
    format: string;
    isAudio: boolean;
}
export declare class AudioContainerDetector {
    private audioExtensions;
    /**
     * Detect audio container information.
     */
    detect(filePath: string): AudioInfo;
}
export declare function getANSIStripper(): ANSIStripper;
export declare function getOSVChecker(): OSVChecker;
export declare function getWebsitePolicyChecker(): WebsitePolicyChecker;
export declare function getPatchParser(): PatchParser;
export declare function getImageSourceDetector(): ImageSourceDetector;
export declare function getAudioContainerDetector(): AudioContainerDetector;
//# sourceMappingURL=utility-tools.d.ts.map