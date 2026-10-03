/**
 * I3 — Image generation (generate an image from a prompt via an optional backend).
 *
 * Backend selection is data-driven through the provider registry
 * (`./image-providers.ts`), so a user can bring their own key:
 *   - **Google Gemini / Imagen ("Nano Banana")** — `GEMINI_API_KEY` / `GOOGLE_API_KEY`
 *   - **OpenAI DALL·E / gpt-image** — `OPENAI_API_KEY`
 *   - **Stability AI** — `STABILITY_API_KEY`
 *   - **Local ComfyUI / Stable Diffusion** — `BUFF_IMAGE_API_URL`
 *   - **Pollinations.ai** — free, keyless default + fallback.
 *
 * Priority: an explicit provider (`opts.provider` or `modality.image.provider`)
 * wins, else the first AVAILABLE backend, else Pollinations. A configured
 * backend that fails at request time degrades to Pollinations rather than
 * failing the tool. Images are written to the sandbox `images/` artifact dir.
 */

import { writeArtifact, safeArtifactName } from './shared.js';
import {
  IMAGE_PROVIDERS,
  localImageEndpoint,
  resolveImageProvider,
  type ImageProviderId,
} from './image-providers.js';

export type { ImageProviderId } from './image-providers.js';
export { availableImageProviders } from './image-providers.js';

export interface ImageGenOptions {
  width?: number;
  height?: number;
  /** Explicit provider id (overrides key auto-detection). */
  provider?: string;
  /** Model override passed to the provider. */
  model?: string;
  /** Custom local endpoint (ComfyUI/SD). When set, forces the local backend. */
  apiUrl?: string;
  cwd?: string;
}

/** Always available by default (Pollinations needs no key). */
export function isImageGenAvailable(): boolean {
  return true;
}

/** Fetch image bytes (mocked in tests). Exported for testability. */
export async function fetchImageBytes(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('image fetch returned empty body');
  return buf;
}

/**
 * Which provider will generate. Exposed for the tool description / diagnostics.
 * An explicit `apiUrl` pins the local backend (backward-compatible behaviour).
 */
export function selectImageProvider(opts: ImageGenOptions = {}): ImageProviderId {
  const requested = opts.provider ?? (opts.apiUrl ? 'comfyui' : undefined);
  return resolveImageProvider(requested);
}

/**
 * Generate an image from a prompt. Returns the artifact path on success, or a
 * descriptive error string. Never throws.
 */
export async function generateImage(
  prompt: string,
  opts: ImageGenOptions = {},
): Promise<{ ok: boolean; file?: string; error?: string }> {
  const width = opts.width ?? 1024;
  const height = opts.height ?? 1024;
  // An explicit apiUrl forces the local backend; otherwise the endpoint env
  // (if any) still lets `comfyui` be auto-selected.
  const endpoint = opts.apiUrl ?? localImageEndpoint();
  const chosen = selectImageProvider(opts);

  try {
    const { bytes, ext } = await IMAGE_PROVIDERS[chosen].generate({
      prompt,
      width,
      height,
      model: opts.model,
      endpoint,
    });
    const file = writeArtifact('images', safeArtifactName(prompt, ext), bytes, opts.cwd);
    return { ok: true, file };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A configured backend that failed degrades to the free fallback so the
    // user still gets an image (unless Pollinations itself was the choice).
    if (chosen !== 'pollinations') {
      try {
        const { bytes, ext } = await IMAGE_PROVIDERS.pollinations.generate({ prompt, width, height });
        const file = writeArtifact('images', safeArtifactName(prompt, ext), bytes, opts.cwd);
        return { ok: true, file };
      } catch { /* fall through to the original error */ }
    }
    return { ok: false, error: message };
  }
}
