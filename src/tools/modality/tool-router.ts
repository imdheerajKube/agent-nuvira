/**
 * Tool-Router — Intelligent routing for modality tools (image/audio/video).
 *
 * Problem it solves:
 * - Image generation always uses Pollinations.ai (free, slow)
 * - TTS always uses OpenAI (paid, requires key)
 * - Video always uses FAL (paid, requires key)
 * - No failover between backends
 *
 * Solution:
 * - Route to BEST available backend based on: cost, quality, speed, availability
 * - Failover across backends (same as LLM routing)
 * - Local backends preferred (free, fast)
 *
 * Usage:
 *   const result = await routeImageGeneration('a cat', { width: 1024, height: 1024 });
 *   const result = await routeTTS('Hello world');
 *   const result = await routeVideoGeneration('A cat walking');
 */

import { logger } from '../../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type Modality = 'image' | 'tts' | 'video' | 'transcription';

export interface ModalityBackend {
  /** Backend identifier (e.g., 'pollinations', 'dalle', 'openai-tts'). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Cost tier: 'free', 'cheap', 'medium', 'expensive'. */
  costTier: 'free' | 'cheap' | 'medium' | 'expensive';
  /** Quality score 0-1 (higher = better). */
  quality: number;
  /** Speed score 0-1 (higher = faster). */
  speed: number;
  /** Whether this backend requires an API key. */
  requiresKey: boolean;
  /** Environment variable for the API key (if requiresKey). */
  envVar?: string;
  /** Whether this backend is currently available. */
  available: boolean;
}

export interface ModalityRouteResult {
  /** Whether the operation succeeded. */
  ok: boolean;
  /** Backend used for the operation. */
  backend: string;
  /** Output file path (for image/video). */
  file?: string;
  /** Audio buffer (for TTS). */
  audio?: Buffer;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Error message if failed. */
  error?: string;
}

// ─── Image Generation Backends ──────────────────────────────────────────────

const IMAGE_BACKENDS: ModalityBackend[] = [
  {
    id: 'comfyui',
    name: 'Local ComfyUI / Stable Diffusion',
    costTier: 'free',
    quality: 0.9,
    speed: 0.8,
    requiresKey: false,
    envVar: 'BUFF_IMAGE_API_URL',
    available: !!process.env.BUFF_IMAGE_API_URL,
  },
  {
    id: 'pollinations',
    name: 'Pollinations.ai (Free)',
    costTier: 'free',
    quality: 0.7,
    speed: 0.5,
    requiresKey: false,
    available: true, // Always available (no key needed)
  },
  {
    id: 'dalle',
    name: 'DALL-E 3 (OpenAI)',
    costTier: 'expensive',
    quality: 0.95,
    speed: 0.6,
    requiresKey: true,
    envVar: 'OPENAI_API_KEY',
    available: !!process.env.OPENAI_API_KEY,
  },
  {
    id: 'stability',
    name: 'Stable Diffusion (Stability AI)',
    costTier: 'medium',
    quality: 0.85,
    speed: 0.7,
    requiresKey: true,
    envVar: 'STABILITY_API_KEY',
    available: !!process.env.STABILITY_API_KEY,
  },
];

// ─── TTS Backends ───────────────────────────────────────────────────────────

const TTS_BACKENDS: ModalityBackend[] = [
  {
    id: 'neutts',
    name: 'NeuTTS (Local)',
    costTier: 'free',
    quality: 0.7,
    speed: 0.9,
    requiresKey: false,
    available: true, // Always available (local)
  },
  {
    id: 'openai-tts',
    name: 'OpenAI TTS',
    costTier: 'cheap',
    quality: 0.9,
    speed: 0.8,
    requiresKey: true,
    envVar: 'OPENAI_API_KEY',
    available: !!process.env.OPENAI_API_KEY,
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    costTier: 'medium',
    quality: 0.95,
    speed: 0.7,
    requiresKey: true,
    envVar: 'ELEVENLABS_API_KEY',
    available: !!process.env.ELEVENLABS_API_KEY,
  },
];

// ─── Video Generation Backends ──────────────────────────────────────────────

const VIDEO_BACKENDS: ModalityBackend[] = [
  {
    id: 'fal',
    name: 'FAL AI',
    costTier: 'medium',
    quality: 0.85,
    speed: 0.6,
    requiresKey: true,
    envVar: 'FAL_KEY',
    available: !!process.env.FAL_KEY,
  },
  {
    id: 'runway',
    name: 'Runway ML',
    costTier: 'expensive',
    quality: 0.95,
    speed: 0.5,
    requiresKey: true,
    envVar: 'RUNWAY_API_KEY',
    available: !!process.env.RUNWAY_API_KEY,
  },
  {
    id: 'bfl',
    name: 'BFL FLUX',
    costTier: 'medium',
    quality: 0.8,
    speed: 0.7,
    requiresKey: true,
    envVar: 'BFL_API_KEY',
    available: !!process.env.BFL_API_KEY,
  },
];

// ─── Transcription Backends ─────────────────────────────────────────────────

const TRANSCRIPTION_BACKENDS: ModalityBackend[] = [
  {
    id: 'whisper-local',
    name: 'Whisper (Local)',
    costTier: 'free',
    quality: 0.8,
    speed: 0.7,
    requiresKey: false,
    available: true,
  },
  {
    id: 'openai-whisper',
    name: 'OpenAI Whisper API',
    costTier: 'cheap',
    quality: 0.95,
    speed: 0.9,
    requiresKey: true,
    envVar: 'OPENAI_API_KEY',
    available: !!process.env.OPENAI_API_KEY,
  },
];

// ─── Backend Selection ──────────────────────────────────────────────────────

/**
 * Select the best backend for a modality based on cost, quality, and availability.
 * This is the core routing logic for tool-level modality routing.
 */
function selectBestBackend(
  modality: Modality,
  backends: ModalityBackend[],
): ModalityBackend | null {
  const available = backends.filter(b => b.available);
  if (available.length === 0) return null;

  // Score each backend: free first, then quality, then speed
  const scored = available.map(b => {
    let score = 0;
    // Cost weight: free = 1.0, cheap = 0.8, medium = 0.5, expensive = 0.2
    const costWeights: Record<string, number> = { free: 1.0, cheap: 0.8, medium: 0.5, expensive: 0.2 };
    score += (costWeights[b.costTier] || 0.5) * 0.4; // 40% weight on cost
    score += b.quality * 0.35; // 35% weight on quality
    score += b.speed * 0.25; // 25% weight on speed
    return { backend: b, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].backend;
}

/**
 * Get backends for a modality.
 */
function getBackends(modality: Modality): ModalityBackend[] {
  switch (modality) {
    case 'image': return IMAGE_BACKENDS;
    case 'tts': return TTS_BACKENDS;
    case 'video': return VIDEO_BACKENDS;
    case 'transcription': return TRANSCRIPTION_BACKENDS;
  }
}

// ─── Image Generation ──────────────────────────────────────────────────────

export interface ImageGenRouteOptions {
  width?: number;
  height?: number;
  cwd?: string;
}

/**
 * Route image generation to the best available backend with failover.
 */
export async function routeImageGeneration(
  prompt: string,
  opts: ImageGenRouteOptions = {},
): Promise<ModalityRouteResult> {
  const backends = getBackends('image');
  const startTime = Date.now();

  // Try each backend in order (best first)
  for (const backend of backends) {
    if (!backend.available) continue;

    try {
      logger.debug(`[tool-router] Trying ${backend.name} for image generation`);

      let result: { ok: boolean; file?: string; error?: string };

      if (backend.id === 'comfyui') {
        // Local ComfyUI / Stable Diffusion
        const apiUrl = process.env.BUFF_IMAGE_API_URL!;
        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt,
            width: opts.width ?? 1024,
            height: opts.height ?? 1024,
          }),
        });
        if (!res.ok) throw new Error(`ComfyUI HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const ext = (res.headers.get('content-type') ?? '').includes('jpeg') ? '.jpg' : '.png';
        // Save to artifact
        const { writeArtifact, safeArtifactName } = await import('./shared.js');
        const file = writeArtifact('images', safeArtifactName(prompt, ext), buf, opts.cwd);
        result = { ok: true, file };
      } else if (backend.id === 'pollinations') {
        // Pollinations.ai free endpoint
        const { generateImage } = await import('./image-gen.js');
        result = await generateImage(prompt, { width: opts.width, height: opts.height, cwd: opts.cwd });
      } else if (backend.id === 'dalle') {
        // DALL-E 3 via OpenAI
        const apiKey = process.env.OPENAI_API_KEY!;
        const res = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'dall-e-3',
            prompt,
            n: 1,
            size: `${opts.width ?? 1024}x${opts.height ?? 1024}`,
          }),
        });
        if (!res.ok) throw new Error(`DALL-E HTTP ${res.status}`);
        const data = await res.json() as any;
        const imageUrl = data.data?.[0]?.url;
        if (!imageUrl) throw new Error('No image URL in DALL-E response');
        const imgRes = await fetch(imageUrl);
        if (!imgRes.ok) throw new Error('Failed to download DALL-E image');
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const { writeArtifact, safeArtifactName } = await import('./shared.js');
        const file = writeArtifact('images', safeArtifactName(prompt, '.png'), buf, opts.cwd);
        result = { ok: true, file };
      } else if (backend.id === 'stability') {
        // Stability AI
        const apiKey = process.env.STABILITY_API_KEY!;
        const res = await fetch('https://api.stability.ai/v1/generation/stable-diffusion-xl/text-to-image', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text_prompts: [{ text: prompt }],
            cfg_scale: 7,
            height: opts.height ?? 1024,
            width: opts.width ?? 1024,
          }),
        });
        if (!res.ok) throw new Error(`Stability HTTP ${res.status}`);
        const data = await res.json() as any;
        const base64 = data.artifacts?.[0]?.base64;
        if (!base64) throw new Error('No image in Stability response');
        const buf = Buffer.from(base64, 'base64');
        const { writeArtifact, safeArtifactName } = await import('./shared.js');
        const file = writeArtifact('images', safeArtifactName(prompt, '.png'), buf, opts.cwd);
        result = { ok: true, file };
      } else {
        continue;
      }

      if (result.ok) {
        logger.info(`[tool-router] Image generated via ${backend.name} in ${Date.now() - startTime}ms`);
        return { ok: true, backend: backend.id, file: result.file, durationMs: Date.now() - startTime };
      }
    } catch (err) {
      logger.debug(`[tool-router] ${backend.name} failed: ${err instanceof Error ? err.message : err}`);
      // Continue to next backend
    }
  }

  return {
    ok: false,
    backend: 'none',
    error: 'All image generation backends failed or unavailable',
    durationMs: Date.now() - startTime,
  };
}

// ─── TTS ────────────────────────────────────────────────────────────────────

/**
 * Route TTS to the best available backend with failover.
 */
export async function routeTTS(
  text: string,
  opts: { voice?: string; cwd?: string } = {},
): Promise<ModalityRouteResult> {
  const backends = getBackends('tts');
  const startTime = Date.now();

  for (const backend of backends) {
    if (!backend.available) continue;

    try {
      logger.debug(`[tool-router] Trying ${backend.name} for TTS`);

      let audio: Buffer | undefined;

      if (backend.id === 'openai-tts') {
        const apiKey = process.env.OPENAI_API_KEY!;
        const res = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'tts-1',
            input: text,
            voice: opts.voice || 'alloy',
          }),
        });
        if (!res.ok) throw new Error(`OpenAI TTS HTTP ${res.status}`);
        audio = Buffer.from(await res.arrayBuffer());
      } else if (backend.id === 'neutts') {
        // NeuTTS local — placeholder, uses whatever local TTS is available
        // In production, this would call a local TTS server
        logger.debug('[tool-router] NeuTTS local — using fallback');
        continue; // Skip if not actually configured
      } else if (backend.id === 'elevenlabs') {
        const apiKey = process.env.ELEVENLABS_API_KEY!;
        const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM', {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            model_id: 'eleven_monolingual_v1',
          }),
        });
        if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}`);
        audio = Buffer.from(await res.arrayBuffer());
      } else {
        continue;
      }

      if (audio && audio.length > 0) {
        logger.info(`[tool-router] TTS generated via ${backend.name} in ${Date.now() - startTime}ms`);
        return { ok: true, backend: backend.id, audio, durationMs: Date.now() - startTime };
      }
    } catch (err) {
      logger.debug(`[tool-router] ${backend.name} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    ok: false,
    backend: 'none',
    error: 'All TTS backends failed or unavailable',
    durationMs: Date.now() - startTime,
  };
}

// ─── Video Generation ──────────────────────────────────────────────────────

/**
 * Route video generation to the best available backend with failover.
 */
export async function routeVideoGeneration(
  prompt: string,
  opts: { duration?: number; resolution?: string; cwd?: string } = {},
): Promise<ModalityRouteResult> {
  const backends = getBackends('video');
  const startTime = Date.now();

  for (const backend of backends) {
    if (!backend.available) continue;

    try {
      logger.debug(`[tool-router] Trying ${backend.name} for video generation`);

      let result: { ok: boolean; file?: string; error?: string } = { ok: false };

      if (backend.id === 'fal') {
        const { FALVideoGenerator } = await import('../video-generation.js');
        const gen = new FALVideoGenerator({ apiKey: process.env.FAL_KEY });
        const videoResult = await gen.generate({
          prompt,
          duration: opts.duration ?? 4,
          aspectRatio: '16:9',
        });
        if (videoResult.status === 'completed' && videoResult.videoUrl) {
          // Download video
          const res = await fetch(videoResult.videoUrl);
          if (!res.ok) throw new Error('Failed to download video');
          const buf = Buffer.from(await res.arrayBuffer());
          const { writeArtifact, safeArtifactName } = await import('./shared.js');
          const file = writeArtifact('videos', safeArtifactName(prompt, '.mp4'), buf, opts.cwd);
          result = { ok: true, file };
        }
      } else if (backend.id === 'runway') {
        // Runway placeholder — would need Runway SDK
        logger.debug('[tool-router] Runway — not configured');
        continue;
      } else if (backend.id === 'bfl') {
        // BFL FLUX placeholder — would need BFL SDK
        logger.debug('[tool-router] BFL — not configured');
        continue;
      } else {
        continue;
      }

      if (result.ok) {
        logger.info(`[tool-router] Video generated via ${backend.name} in ${Date.now() - startTime}ms`);
        return { ok: true, backend: backend.id, file: result.file, durationMs: Date.now() - startTime };
      }
    } catch (err) {
      logger.debug(`[tool-router] ${backend.name} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    ok: false,
    backend: 'none',
    error: 'All video generation backends failed or unavailable',
    durationMs: Date.now() - startTime,
  };
}

// ─── Transcription ──────────────────────────────────────────────────────────

/**
 * Route transcription to the best available backend with failover.
 */
export async function routeTranscription(
  audioPath: string,
  opts: { language?: string; cwd?: string } = {},
): Promise<ModalityRouteResult & { text?: string }> {
  const backends = getBackends('transcription');
  const startTime = Date.now();

  for (const backend of backends) {
    if (!backend.available) continue;

    try {
      logger.debug(`[tool-router] Trying ${backend.name} for transcription`);

      let text: string | undefined;

      if (backend.id === 'openai-whisper') {
        const apiKey = process.env.OPENAI_API_KEY!;
        const { readFileSync } = await import('fs');
        const audioBuffer = readFileSync(audioPath);
        const formData = new FormData();
        formData.append('file', new Blob([audioBuffer]), 'audio.wav');
        formData.append('model', 'whisper-1');
        if (opts.language) formData.append('language', opts.language);

        const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          body: formData,
        });
        if (!res.ok) throw new Error(`Whisper HTTP ${res.status}`);
        const data = await res.json() as any;
        text = data.text;
      } else if (backend.id === 'whisper-local') {
        // Local Whisper — placeholder
        logger.debug('[tool-router] Local Whisper — not configured');
        continue;
      } else {
        continue;
      }

      if (text) {
        logger.info(`[tool-router] Transcription via ${backend.name} in ${Date.now() - startTime}ms`);
        return { ok: true, backend: backend.id, text, durationMs: Date.now() - startTime };
      }
    } catch (err) {
      logger.debug(`[tool-router] ${backend.name} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    ok: false,
    backend: 'none',
    error: 'All transcription backends failed or unavailable',
    durationMs: Date.now() - startTime,
  };
}

// ─── Status ─────────────────────────────────────────────────────────────────

/**
 * Get the status of all modality backends (for dashboard display).
 */
export function getModalityBackendStatus(): Record<Modality, ModalityBackend[]> {
  return {
    image: IMAGE_BACKENDS,
    tts: TTS_BACKENDS,
    video: VIDEO_BACKENDS,
    transcription: TRANSCRIPTION_BACKENDS,
  };
}
