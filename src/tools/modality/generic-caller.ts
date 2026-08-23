/**
 * GenericCaller — handles API calls to modality providers.
 *
 * Instead of provider-specific code, this module:
 *   1. Uses provider's requestBuilder to construct the request
 *   2. Makes the API call with proper auth, timeouts, retries
 *   3. Uses provider's responseParser to parse the response
 *   4. Handles errors generically
 *
 * This allows adding new providers without writing new API calling code.
 */

import type { ModalityProvider, ModalityOptions, ModalityResponse } from './modality-catalog.js';
import { logger } from '../../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export class ModalityError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly statusCode: number,
    public readonly details: string,
  ) {
    super(`[${providerId}] HTTP ${statusCode}: ${details}`);
    this.name = 'ModalityError';
  }
}

// ─── API Key Resolution ─────────────────────────────────────────────────────

/**
 * Get the API key for a provider.
 * Checks: config > envVar > hardcoded
 */
function getApiKey(provider: ModalityProvider, config?: Record<string, unknown>): string | undefined {
  // Check config first
  if (config) {
    const modalityConfig = config.modality as Record<string, Record<string, unknown>> | undefined;
    if (modalityConfig) {
      const providerConfig = modalityConfig[provider.modality]?.[provider.id] as Record<string, unknown> | undefined;
      if (providerConfig?.apiKey) {
        return providerConfig.apiKey as string;
      }
    }
  }

  // Check env var
  if (provider.envVar) {
    return process.env[provider.envVar];
  }

  return undefined;
}

// ─── Generic API Caller ─────────────────────────────────────────────────────

/**
 * Call a modality provider with generic API handling.
 *
 * Flow:
 *   1. Build request using provider's requestBuilder
 *   2. Resolve auth (API key from config or env)
 *   3. Make HTTP request with timeout
 *   4. Parse response using provider's responseParser
 *   5. Return standardized result
 */
export async function callModalityProvider(
  provider: ModalityProvider,
  prompt: string,
  opts: ModalityOptions = {},
  config?: Record<string, unknown>,
): Promise<ModalityResponse> {
  const startTime = Date.now();
  const apiKey = getApiKey(provider, config);

  // Determine endpoint
  const endpoint = provider.endpoint || getDefaultEndpoint(provider.modality);

  // Build request
  const requestBody = provider.requestBuilder(prompt, opts);

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...provider.headers,
  };

  // Add auth
  if (apiKey) {
    if (provider.apiType === 'openai') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else {
      // Generic API key header
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
  }

  // Handle file uploads (for transcription)
  let body: string | FormData;
  if (provider.modality === 'transcription' && typeof requestBody.file === 'string') {
    // For transcription, we need to send a file
    const { readFileSync } = await import('fs');
    const fileBuffer = readFileSync(requestBody.file as string);
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer]), 'audio.wav');
    if (requestBody.model) formData.append('model', requestBody.model as string);
    if (requestBody.language) formData.append('language', requestBody.language as string);
    body = formData;
    delete headers['Content-Type']; // Let browser set multipart boundary
  } else {
    body = JSON.stringify(requestBody);
  }

  // Handle Pollinations (special case: GET request)
  if (provider.apiType === 'pollinations') {
    const { writeArtifact, safeArtifactName } = await import('./shared.js');
    const { fetchImageBytes } = await import('./image-gen.js');

    const width = opts.width ?? 1024;
    const height = opts.height ?? 1024;
    const url = `${provider.baseUrl}/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true`;

    const buffer = await fetchImageBytes(url);
    const file = writeArtifact('images', safeArtifactName(prompt, '.png'), buffer, opts.cwd);

    return {
      ok: true,
      file,
      durationMs: Date.now() - startTime,
    };
  }

  // Make HTTP request
  const response = await fetch(provider.baseUrl + endpoint, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(provider.timeoutMs || 30000),
  });

  // Handle errors
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new ModalityError(provider.id, response.status, errorText.slice(0, 200));
  }

  // Parse response
  let data: unknown;
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    data = await response.json();
  } else if (contentType.includes('image/') || contentType.includes('audio/') || contentType.includes('video/')) {
    // Binary response (image, audio, video)
    const buffer = Buffer.from(await response.arrayBuffer());
    data = { buffer, contentType };
  } else {
    // Text response
    const text = await response.text();
    data = { text };
  }

  // Use provider's response parser
  const result = provider.responseParser(data);

  // Handle file saving if data is a buffer
  if (result.ok && result.data instanceof Buffer) {
    const { writeArtifact, safeArtifactName } = await import('./shared.js');
    const ext = getExtension(contentType);
    const file = writeArtifact(
      getOutputDir(provider.modality),
      safeArtifactName(prompt, ext),
      result.data,
      opts.cwd,
    );
    result.file = file;
  }

  // Handle URL download if data is a string (URL)
  if (result.ok && typeof result.data === 'string' && result.data.startsWith('http')) {
    const { writeArtifact, safeArtifactName } = await import('./shared.js');
    const fetchResponse = await fetch(result.data);
    if (fetchResponse.ok) {
      const buffer = Buffer.from(await fetchResponse.arrayBuffer());
      const ext = getExtension(fetchResponse.headers.get('content-type') || '');
      const file = writeArtifact(
        getOutputDir(provider.modality),
        safeArtifactName(prompt, ext),
        buffer,
        opts.cwd,
      );
      result.file = file;
    }
  }

  result.durationMs = Date.now() - startTime;
  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getDefaultEndpoint(modality: string): string {
  switch (modality) {
    case 'image': return '/images/generations';
    case 'tts': return '/audio/speech';
    case 'video': return '/generation';
    case 'transcription': return '/audio/transcriptions';
    default: return '/';
  }
}

function getExtension(contentType: string): string {
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg';
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('gif')) return '.gif';
  if (contentType.includes('mp4')) return '.mp4';
  if (contentType.includes('webm')) return '.webm';
  if (contentType.includes('mp3')) return '.mp3';
  if (contentType.includes('wav')) return '.wav';
  if (contentType.includes('ogg')) return '.ogg';
  return '.bin';
}

function getOutputDir(modality: string): string {
  switch (modality) {
    case 'image': return 'images';
    case 'tts': return 'audio';
    case 'video': return 'videos';
    case 'transcription': return 'transcriptions';
    default: return 'output';
  }
}

// ─── Failover Caller ────────────────────────────────────────────────────────

/**
 * Call modality with failover across providers.
 *
 * Flow:
 *   1. Get all available providers for the modality
 *   2. Score each provider
 *   3. Try best provider first
 *   4. On failure, try next best
 *   5. Continue until success or all providers exhausted
 */
export async function callModalityWithFailover(
  modality: string,
  prompt: string,
  opts: ModalityOptions = {},
  config?: Record<string, unknown>,
): Promise<ModalityResponse & { provider: string }> {
  const { getAvailableModalityProviders, scoreModalityProvider } = await import('./modality-catalog.js');

  const providers = getAvailableModalityProviders(modality as any);
  if (providers.length === 0) {
    return {
      ok: false,
      error: `No ${modality} providers available`,
      durationMs: 0,
      provider: 'none',
    };
  }

  // Score and sort providers
  const scored = providers.map(p => ({
    provider: p,
    score: scoreModalityProvider(p),
  })).sort((a, b) => b.score - a.score);

  // Try each provider
  for (const { provider } of scored) {
    try {
      logger.debug(`[generic-caller] Trying ${provider.name} for ${modality}`);
      const result = await callModalityProvider(provider, prompt, opts, config);

      if (result.ok) {
        logger.info(`[generic-caller] ${modality} generated via ${provider.name} in ${result.durationMs}ms`);
        return { ...result, provider: provider.id };
      }
    } catch (err) {
      logger.debug(`[generic-caller] ${provider.name} failed: ${err instanceof Error ? err.message : err}`);
      // Continue to next provider
    }
  }

  return {
    ok: false,
    error: `All ${modality} providers failed`,
    durationMs: 0,
    provider: 'none',
  };
}
