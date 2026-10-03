/**
 * Image-generation provider registry (`src/tools/modality/image-providers.ts`).
 *
 * The single source of truth for every backend `generate_image` can reach —
 * mirroring the LLM `provider-catalog.ts` pattern so "add a provider" is data,
 * not a code path. This is what makes BYOK real for images: a user who sets
 * `GEMINI_API_KEY`, `OPENAI_API_KEY` or `STABILITY_API_KEY` gets that backend
 * automatically; with nothing configured the free Pollinations endpoint runs.
 *
 * Selection (`resolveImageProvider`):
 *   1. an explicit `provider` option / `modality.image.provider` config;
 *   2. otherwise the first AVAILABLE provider in `IMAGE_PROVIDER_PRIORITY`
 *      (Gemini → OpenAI → Stability → local ComfyUI → Pollinations).
 * A configured-but-failing backend falls back to Pollinations in `generate-image.ts`.
 *
 * Env vars are read dual-form (`NUVIRA_`/`BUFF_` prefixed OR plain) so both a
 * bare `export GEMINI_API_KEY=…` and the nuvira-style override work.
 */

import { envBuff } from '../../config/paths';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ImageProviderId = 'gemini' | 'openai' | 'stability' | 'comfyui' | 'pollinations';

export interface ImageGenerationRequest {
  prompt: string;
  width: number;
  height: number;
  /** Model override (provider-specific). */
  model?: string;
  /** Explicit local endpoint (overrides the IMAGE_API_URL env). */
  endpoint?: string;
}

export interface ImageGenerationResult {
  bytes: Buffer;
  /** File extension including the dot ('.png' | '.jpg'). */
  ext: '.png' | '.jpg';
}

export interface ImageProvider {
  id: ImageProviderId;
  label: string;
  /** Env vars that can supply the key (prefixed or plain; first set wins). */
  keyEnvVars: string[];
  /** Default model when none is configured. */
  defaultModel: string;
  /** Approximate USD per image (0 = free). */
  costPerUnit: number;
  /** Quality score 0–1 (used only for reporting/priority). */
  quality: number;
  /** True when this backend needs an API key / endpoint to run. */
  requiresConfig: boolean;
  /** Is the backend usable right now (key/endpoint present)? */
  available(): boolean;
  /** Generate the image bytes, or throw with a descriptive message. */
  generate(req: ImageGenerationRequest): Promise<ImageGenerationResult>;
}

// ─── Env helpers ────────────────────────────────────────────────────────────

/** Read the first non-empty value among names (prefixed + plain). */
function keyFromEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = (envBuff(name) ?? process.env[name])?.trim();
    if (value) return value;
  }
  return undefined;
}

/** The local ComfyUI / Stable Diffusion endpoint, if configured. */
export function localImageEndpoint(): string | undefined {
  return envBuff('IMAGE_API_URL') || process.env.IMAGE_API_URL;
}

// ─── Provider implementations ───────────────────────────────────────────────

const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt/';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Gemini / Imagen ("Nano Banana") image generation. */
async function geminiGenerate(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const key = keyFromEnv(['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
  if (!key) throw new Error('Gemini API key is not configured');
  const model = req.model || 'gemini-2.5-flash-image';

  if (/imagen/i.test(model)) {
    // Imagen models use the :predict endpoint.
    const res = await fetch(`${GEMINI_BASE}/${model}:predict?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instances: [{ prompt: req.prompt }], parameters: { sampleCount: 1 } }),
    });
    if (!res.ok) throw new Error(`Gemini Imagen HTTP ${res.status}`);
    const data = (await res.json()) as { predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> };
    const pred = data.predictions?.[0];
    if (!pred?.bytesBase64Encoded) throw new Error('Gemini Imagen returned no image');
    return { bytes: Buffer.from(pred.bytesBase64Encoded, 'base64'), ext: mimeToExt(pred.mimeType) };
  }

  // Gemini image models use :generateContent with IMAGE response modality.
  const res = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: req.prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'] },
    }),
  });
  if (!res.ok) throw new Error(`Gemini image HTTP ${res.status}`);
  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; inline_data?: { data?: string; mime_type?: string } }> };
    }>;
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const withImage = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
  const b64 = withImage?.inlineData?.data ?? withImage?.inline_data?.data;
  if (!b64) throw new Error('Gemini returned no image');
  const mime = withImage?.inlineData?.mimeType ?? withImage?.inline_data?.mime_type;
  return { bytes: Buffer.from(b64, 'base64'), ext: mimeToExt(mime) };
}

/** OpenAI image models: DALL·E (2/3) and gpt-image-1. */
async function openaiGenerate(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const key = keyFromEnv(['OPENAI_API_KEY']);
  if (!key) throw new Error('OpenAI API key is not configured');
  const model = req.model || 'gpt-image-1';
  const body: Record<string, unknown> = { model, prompt: req.prompt, n: 1 };
  // gpt-image-* always returns b64 and rejects response_format; dall-e-* needs it.
  if (!/gpt-image/i.test(model)) body.response_format = 'b64_json';
  const size = pickOpenAiSize(model, req.width, req.height);
  if (size) body.size = size;

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI image HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const first = data.data?.[0];
  if (first?.b64_json) return { bytes: Buffer.from(first.b64_json, 'base64'), ext: '.png' };
  if (first?.url) {
    const img = await fetch(first.url);
    if (!img.ok) throw new Error(`OpenAI image download HTTP ${img.status}`);
    return { bytes: Buffer.from(await img.arrayBuffer()), ext: '.png' };
  }
  throw new Error('OpenAI returned no image');
}

/** Stability AI (Stable Image Core / SD3). */
async function stabilityGenerate(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const key = keyFromEnv(['STABILITY_API_KEY']);
  if (!key) throw new Error('Stability API key is not configured');
  const form = new FormData();
  form.append('prompt', req.prompt);
  form.append('output_format', 'png');
  form.append('aspect_ratio', aspectRatio(req.width, req.height));
  if (req.model) form.append('model', req.model);

  const res = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, Accept: 'image/*' },
    body: form,
  });
  if (!res.ok) throw new Error(`Stability HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/')) throw new Error(`Stability returned ${contentType || 'a non-image response'}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('Stability returned an empty image');
  return { bytes, ext: contentType.includes('jpeg') ? '.jpg' : '.png' };
}

/** Local Stable Diffusion / ComfyUI — POST {prompt,width,height} → bytes. */
async function comfyuiGenerate(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const url = req.endpoint ?? localImageEndpoint();
  if (!url) throw new Error('local image endpoint (BUFF_IMAGE_API_URL) is not configured');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: req.prompt, width: req.width, height: req.height }),
  });
  if (!res.ok) throw new Error(`local backend HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') ?? '';
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('local backend returned an empty image');
  return { bytes, ext: contentType.includes('jpeg') ? '.jpg' : '.png' };
}

/** Pollinations.ai — free, keyless, `{prompt}.png` with size params. */
async function pollinationsGenerate(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const url = `${POLLINATIONS_BASE}${encodeURIComponent(req.prompt)}?width=${req.width}&height=${req.height}&nologo=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('image fetch returned empty body');
  return { bytes, ext: '.png' };
}

// ─── Catalog ────────────────────────────────────────────────────────────────

/** The registry — single source of image-backend metadata + generation. */
export const IMAGE_PROVIDERS: Record<ImageProviderId, ImageProvider> = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini / Imagen (Nano Banana)',
    keyEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    defaultModel: 'gemini-2.5-flash-image',
    costPerUnit: 0.039,
    quality: 0.9,
    requiresConfig: true,
    available: () => Boolean(keyFromEnv(['GEMINI_API_KEY', 'GOOGLE_API_KEY'])),
    generate: geminiGenerate,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI (DALL·E / gpt-image)',
    keyEnvVars: ['OPENAI_API_KEY'],
    defaultModel: 'gpt-image-1',
    costPerUnit: 0.04,
    quality: 0.95,
    requiresConfig: true,
    available: () => Boolean(keyFromEnv(['OPENAI_API_KEY'])),
    generate: openaiGenerate,
  },
  stability: {
    id: 'stability',
    label: 'Stability AI',
    keyEnvVars: ['STABILITY_API_KEY'],
    defaultModel: 'stable-image-core',
    costPerUnit: 0.002,
    quality: 0.85,
    requiresConfig: true,
    available: () => Boolean(keyFromEnv(['STABILITY_API_KEY'])),
    generate: stabilityGenerate,
  },
  comfyui: {
    id: 'comfyui',
    label: 'Local ComfyUI / Stable Diffusion',
    keyEnvVars: [],
    defaultModel: 'local',
    costPerUnit: 0,
    quality: 0.9,
    requiresConfig: true,
    available: () => Boolean(localImageEndpoint()),
    generate: comfyuiGenerate,
  },
  pollinations: {
    id: 'pollinations',
    label: 'Pollinations.ai (free)',
    keyEnvVars: [],
    defaultModel: 'pollinations',
    costPerUnit: 0,
    quality: 0.7,
    requiresConfig: false,
    available: () => true,
    generate: pollinationsGenerate,
  },
};

/**
 * Auto-selection order when nothing is configured explicitly. Cloud backends
 * the user paid for outrank the local/free ones; Pollinations is always the
 * last-resort fallback.
 */
export const IMAGE_PROVIDER_PRIORITY: readonly ImageProviderId[] = [
  'gemini',
  'openai',
  'stability',
  'comfyui',
  'pollinations',
];

// ─── Selection ──────────────────────────────────────────────────────────────

/** Is the provider a known registry id? */
export function isImageProviderId(value: string | undefined): value is ImageProviderId {
  return Boolean(value && Object.prototype.hasOwnProperty.call(IMAGE_PROVIDERS, value));
}

/** Provider ids currently usable (for CLI/dashboard diagnostics). */
export function availableImageProviders(): ImageProviderId[] {
  return IMAGE_PROVIDER_PRIORITY.filter((id) => IMAGE_PROVIDERS[id].available());
}

/**
 * Which backend will run. An explicit, known `provider` wins; else the first
 * available provider in priority order; else Pollinations.
 */
export function resolveImageProvider(requested?: string): ImageProviderId {
  if (isImageProviderId(requested)) return requested;
  for (const id of IMAGE_PROVIDER_PRIORITY) {
    if (IMAGE_PROVIDERS[id].available()) return id;
  }
  return 'pollinations';
}

// ─── Small helpers ──────────────────────────────────────────────────────────

function mimeToExt(mime: string | undefined): '.png' | '.jpg' {
  return (mime ?? '').includes('jpeg') || (mime ?? '').includes('jpg') ? '.jpg' : '.png';
}

/** Pick a size string OpenAI accepts for the given model. */
function pickOpenAiSize(model: string, width: number, height: number): string | undefined {
  const gpt = /gpt-image/i.test(model);
  if (width === height) return '1024x1024';
  if (gpt) return width > height ? '1536x1024' : '1024x1536';
  return width > height ? '1792x1024' : '1024x1792';
}

/** Stability wants an aspect ratio, not pixel dimensions. */
function aspectRatio(width: number, height: number): string {
  if (width === height) return '1:1';
  return width > height ? '16:9' : '9:16';
}
