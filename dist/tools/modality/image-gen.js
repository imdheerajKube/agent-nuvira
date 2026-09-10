/**
 * I3 — Image generation (generate an image from a prompt via an optional backend).
 *
 * Backends (free-first): Pollinations.ai free endpoint by default (no key,
 * pure fetch), or a local ComfyUI / Stable Diffusion API when
 * BUFF_IMAGE_API_URL is set. Generated images are written to the sandbox
 * `images/` artifact dir. Availability is true by default (Pollinations needs
 * no key); the tool degrades gracefully when the endpoint is unreachable.
 */
import { writeArtifact, safeArtifactName } from './shared.js';
/** Pollinations free tier — `{prompt}.png` with size params. */
const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt/';
/** Always available by default (Pollinations needs no key). */
export function isImageGenAvailable() {
    return true;
}
/** Fetch image bytes (mocked in tests). Exported for testability. */
export async function fetchImageBytes(url) {
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`image fetch failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0)
        throw new Error('image fetch returned empty body');
    return buf;
}
/**
 * Generate an image from a prompt. Returns the artifact path on success, or a
 * descriptive error string. Never throws.
 */
export async function generateImage(prompt, opts = {}) {
    const width = opts.width ?? 1024;
    const height = opts.height ?? 1024;
    try {
        let buf;
        let ext = '.png';
        if (opts.apiUrl) {
            // Local Stable Diffusion / ComfyUI — POST {prompt,width,height} → bytes.
            const res = await fetch(opts.apiUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ prompt, width, height }),
            });
            if (!res.ok)
                throw new Error(`local backend HTTP ${res.status}`);
            buf = Buffer.from(await res.arrayBuffer());
            ext = (res.headers.get('content-type') ?? '').includes('jpeg') ? '.jpg' : '.png';
        }
        else {
            const url = `${POLLINATIONS_BASE}${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true`;
            buf = await fetchImageBytes(url);
        }
        const file = writeArtifact('images', safeArtifactName(prompt, ext), buf, opts.cwd);
        return { ok: true, file };
    }
    catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
//# sourceMappingURL=image-gen.js.map