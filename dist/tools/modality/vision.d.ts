/**
 * I5 — Vision (describe an image via an optional local/Gemini backend).
 *
 * `describe_image(path, prompt?)` describes an image using:
 *   1. Local **llava / llama3.2-vision** via Ollama (the existing local
 *      adapter's HTTP API — `/api/generate` with base64 images), or
 *   2. The free **Gemini vision** tier when BUFF_GEMINI_API_KEY is set.
 *
 * Availability: true when Ollama answers the `/api/tags` probe OR a Gemini key
 * is present. The Ollama probe is injectable so tests run without a server.
 */
export interface VisionOptions {
    /** Ollama vision model (default llava). */
    ollamaModel?: string;
    ollamaBase?: string;
    /** Injectable Ollama availability probe. */
    probe?: () => Promise<boolean>;
}
/** True when Ollama serves a vision model OR a Gemini key is present. */
export declare function isVisionAvailable(opts?: VisionOptions): Promise<boolean>;
/**
 * Describe an image. Returns the description text or a descriptive error.
 * Never throws.
 */
export declare function describeImage(imagePath: string, prompt?: string, opts?: VisionOptions): Promise<{
    ok: boolean;
    description?: string;
    error?: string;
}>;
//# sourceMappingURL=vision.d.ts.map