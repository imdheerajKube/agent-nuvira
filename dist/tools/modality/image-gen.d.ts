/**
 * I3 — Image generation (generate an image from a prompt via an optional backend).
 *
 * Backends (free-first): Pollinations.ai free endpoint by default (no key,
 * pure fetch), or a local ComfyUI / Stable Diffusion API when
 * BUFF_IMAGE_API_URL is set. Generated images are written to the sandbox
 * `images/` artifact dir. Availability is true by default (Pollinations needs
 * no key); the tool degrades gracefully when the endpoint is unreachable.
 */
export interface ImageGenOptions {
    width?: number;
    height?: number;
    /** Custom local endpoint (ComfyUI/SD). When set, used INSTEAD of Pollinations. */
    apiUrl?: string;
    cwd?: string;
}
/** Always available by default (Pollinations needs no key). */
export declare function isImageGenAvailable(): boolean;
/** Fetch image bytes (mocked in tests). Exported for testability. */
export declare function fetchImageBytes(url: string): Promise<Buffer>;
/**
 * Generate an image from a prompt. Returns the artifact path on success, or a
 * descriptive error string. Never throws.
 */
export declare function generateImage(prompt: string, opts?: ImageGenOptions): Promise<{
    ok: boolean;
    file?: string;
    error?: string;
}>;
//# sourceMappingURL=image-gen.d.ts.map