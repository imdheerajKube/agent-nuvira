/**
 * Vision Tools — Image analysis, OCR, and visual understanding.
 *
 * Hermes equivalent: vision_tools.py
 *
 * Provides:
 * - Image analysis and description
 * - OCR (Optical Character Recognition)
 * - UI element detection
 * - Screenshot analysis
 */
export interface ImageAnalysis {
    /** Image path */
    path: string;
    /** Image dimensions */
    dimensions: {
        width: number;
        height: number;
    };
    /** Image format */
    format: string;
    /** Detected elements */
    elements: DetectedElement[];
    /** OCR text */
    ocrText?: string;
    /** Description */
    description: string;
    /** Tags */
    tags: string[];
}
export interface DetectedElement {
    /** Element type */
    type: 'button' | 'text' | 'image' | 'link' | 'input' | 'icon' | 'container';
    /** Bounding box */
    bounds: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    /** Element text */
    text?: string;
    /** Confidence score */
    confidence: number;
}
export interface OCRResult {
    /** Extracted text */
    text: string;
    /** Confidence score */
    confidence: number;
    /** Text regions */
    regions: Array<{
        text: string;
        bounds: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        confidence: number;
    }>;
}
export interface UIElement {
    /** Element type */
    type: string;
    /** Element text */
    text?: string;
    /** Element ref (for automation) */
    ref?: string;
    /** Bounding box */
    bounds: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    /** Is interactive */
    interactive: boolean;
}
export declare class VisionAnalyzer {
    /**
     * Analyze an image.
     */
    analyze(imagePath: string): Promise<ImageAnalysis>;
    /**
     * Perform OCR on an image.
     */
    ocr(imagePath: string): Promise<OCRResult>;
    /**
     * Detect UI elements in a screenshot.
     */
    detectUIElements(imagePath: string): Promise<UIElement[]>;
    /**
     * Compare two images.
     */
    compare(imagePath1: string, imagePath2: string): Promise<{
        similarity: number;
        differences: Array<{
            x: number;
            y: number;
            width: number;
            height: number;
        }>;
    }>;
    /**
     * Extract text from a screenshot.
     */
    extractText(imagePath: string): Promise<string>;
    /**
     * Find element by text in screenshot.
     */
    findElementByText(imagePath: string, text: string): Promise<UIElement | null>;
    /**
     * Get image dimensions (basic detection for common formats).
     */
    private getImageDimensions;
}
export declare class ScreenshotAnalyzer {
    private analyzer;
    constructor();
    /**
     * Analyze a browser screenshot.
     */
    analyzeBrowserScreenshot(screenshotPath: string): Promise<{
        elements: UIElement[];
        text: string;
        layout: string;
    }>;
    /**
     * Find clickable elements.
     */
    findClickableElements(screenshotPath: string): Promise<UIElement[]>;
    /**
     * Generate automation instructions.
     */
    generateAutomationInstructions(screenshotPath: string, goal: string): Promise<string[]>;
    private inferLayout;
}
export declare function getVisionAnalyzer(): VisionAnalyzer;
export declare function getScreenshotAnalyzer(): ScreenshotAnalyzer;
//# sourceMappingURL=vision-tools.d.ts.map