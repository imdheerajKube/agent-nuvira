/**
 * Service-provider catalog — the single source of truth for every THIRD-PARTY
 * SERVICE the agent consumes (as opposed to the LLM providers in
 * `inference/provider-catalog.ts`).
 *
 * The split matters:
 *   - **Providers** hand us models (chat/reasoning). Configured in the
 *     dashboard's Provider Configuration section + `.nuviraconfig.json`.
 *   - **Services** are capability backends the agent calls directly: image
 *     generation (Nano Banana / DALL·E / Stability), video (FAL), web search
 *     (Brave / Serper / Tavily / Google CSE / SearXNG), page reading (Jina),
 *     vision/interpretation and speech (ElevenLabs / OpenAI TTS).
 *
 * Every entry here is REAL: `envVars` are exactly the variables the tool
 * implementations read at call time (`tools/modality/image-providers.ts`,
 * `tools/web-research.ts`, `tools/video-generation.ts`, `tools/tts-streaming.ts`,
 * …). The dashboard writes them to the 0600 credential env file
 * (`~/.nuvira/.env`) that `loadEnv()` loads at startup — so configuring a
 * service here is what makes that backend available to the agent, and nothing
 * is advertised that no code path consumes.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** The capability a service provides — the dashboard groups by this. */
export type ServiceCapability = 'image' | 'video' | 'search' | 'vision' | 'speech';

/** One environment variable a service needs. */
export interface ServiceEnvVar {
  /** Exact variable name the tool reads. */
  varName: string;
  /** Short human prompt for the field. */
  prompt: string;
  /** Secret values are masked in the UI and redacted for non-admin readers. */
  secret: boolean;
}

/** A third-party service backend the agent can call. */
export interface ServiceDefinition {
  /** Stable id used by the dashboard + CLI (`image-gemini`, `search-brave`). */
  id: string;
  label: string;
  capability: ServiceCapability;
  icon: string;
  /** One-line description of what the agent uses it for. */
  description: string;
  /** The env vars that must/ may be set. Empty for keyless backends. */
  envVars: ServiceEnvVar[];
  /** True when every listed env var must be set to use the backend. */
  requiresAllVars: boolean;
  /** Keyless backends work with no configuration (free fallback). */
  keyless: boolean;
  /** Free to use (no paid account) — informational. */
  free: boolean;
  /** Where to obtain a key / set the service up (optional). */
  docsUrl?: string;
  /**
   * Other services sharing an env var — surfaced so the UI can explain why
   * editing one row changes another's badge (e.g. OPENAI_API_KEY powers image,
   * vision and speech).
   */
  sharedNote?: string;
}

/** Human label for each capability group (dashboard section headings). */
export const SERVICE_CAPABILITY_LABELS: Record<ServiceCapability, string> = {
  image: '🖼️ Image generation',
  video: '🎬 Video generation',
  search: '🔎 Web search & page reading',
  vision: '👁️ Vision / interpretation',
  speech: '🔊 Speech (TTS / STT)',
};

// ─── Catalog ────────────────────────────────────────────────────────────────

/**
 * The registry. Order within a capability is the display order; capability
 * order in {@link SERVICE_CAPABILITY_ORDER} is the render order.
 */
export const SERVICE_CATALOG: readonly ServiceDefinition[] = [
  // ── Image generation ────────────────────────────────────────────────────
  {
    id: 'image-gemini',
    label: 'Google Gemini / Imagen (Nano Banana)',
    capability: 'image',
    icon: '🔷',
    description: 'Gemini 2.5 Flash Image / Imagen — high-quality image generation.',
    envVars: [{ varName: 'GEMINI_API_KEY', prompt: 'Google AI Studio API key', secret: true }],
    requiresAllVars: true,
    keyless: false,
    free: false,
    docsUrl: 'https://aistudio.google.com/apikey',
    sharedNote: 'Also used for Gemini vision/interpretation.',
  },
  {
    id: 'image-openai',
    label: 'OpenAI (DALL·E / gpt-image-1)',
    capability: 'image',
    icon: '🟢',
    description: 'DALL·E 2/3 and gpt-image-1 image generation.',
    envVars: [{ varName: 'OPENAI_API_KEY', prompt: 'OpenAI API key', secret: true }],
    requiresAllVars: true,
    keyless: false,
    free: false,
    docsUrl: 'https://platform.openai.com/api-keys',
    sharedNote: 'Shared with OpenAI vision and TTS/STT.',
  },
  {
    id: 'image-stability',
    label: 'Stability AI',
    capability: 'image',
    icon: '🎨',
    description: 'Stable Image Core / SD3 — cheap, fast image generation.',
    envVars: [{ varName: 'STABILITY_API_KEY', prompt: 'Stability API key', secret: true }],
    requiresAllVars: true,
    keyless: false,
    free: false,
    docsUrl: 'https://platform.stability.ai/account/keys',
  },
  {
    id: 'image-comfyui',
    label: 'Local ComfyUI / Stable Diffusion',
    capability: 'image',
    icon: '🖥️',
    description: 'A local ComfyUI/A1111 endpoint (POST {prompt,width,height} → image bytes).',
    envVars: [{ varName: 'BUFF_IMAGE_API_URL', prompt: 'Local endpoint URL (e.g. http://127.0.0.1:8188/generate)', secret: false }],
    requiresAllVars: true,
    keyless: true,
    free: true,
  },
  {
    id: 'image-pollinations',
    label: 'Pollinations.ai',
    capability: 'image',
    icon: '🌸',
    description: 'Free, keyless image generation — the always-available fallback.',
    envVars: [],
    requiresAllVars: false,
    keyless: true,
    free: true,
  },

  // ── Video generation ────────────────────────────────────────────────────
  {
    id: 'video-fal',
    label: 'FAL.ai (video)',
    capability: 'video',
    icon: '🎬',
    description: 'Text-to-video / image-to-video (flux video models) via FAL.',
    envVars: [{ varName: 'FAL_KEY', prompt: 'FAL API key', secret: true }],
    requiresAllVars: true,
    keyless: false,
    free: false,
    docsUrl: 'https://fal.ai/dashboard/keys',
  },

  // ── Web search & page reading ───────────────────────────────────────────
  {
    id: 'search-brave',
    label: 'Brave Search',
    capability: 'search',
    icon: '🦁',
    description: 'Independent web index — paid, high quality, privacy-focused.',
    envVars: [{ varName: 'BRAVE_SEARCH_API_KEY', prompt: 'Brave Search subscription token', secret: true }],
    requiresAllVars: true,
    keyless: false,
    free: false,
    docsUrl: 'https://api-dashboard.search.brave.com/app/keys',
  },
  {
    id: 'search-serper',
    label: 'Serper.dev',
    capability: 'search',
    icon: '🔍',
    description: 'Google SERP proxy — cheap, fast Google results.',
    envVars: [{ varName: 'SERPER_API_KEY', prompt: 'Serper API key', secret: true }],
    requiresAllVars: true,
    keyless: false,
    free: false,
    docsUrl: 'https://serper.dev/api-key',
  },
  {
    id: 'search-tavily',
    label: 'Tavily',
    capability: 'search',
    icon: '🧭',
    description: 'LLM-optimised search API with clean snippets.',
    envVars: [{ varName: 'TAVILY_API_KEY', prompt: 'Tavily API key (tvly-…)', secret: true }],
    requiresAllVars: true,
    keyless: false,
    free: false,
    docsUrl: 'https://app.tavily.com/home',
  },
  {
    id: 'search-google-cse',
    label: 'Google Programmable Search',
    capability: 'search',
    icon: '🔵',
    description: 'Google Custom Search JSON API (needs both an API key and an engine id).',
    envVars: [
      { varName: 'GOOGLE_CSE_API_KEY', prompt: 'Google API key', secret: true },
      { varName: 'GOOGLE_CSE_ID', prompt: 'Search engine id (cx)', secret: false },
    ],
    requiresAllVars: true,
    keyless: false,
    free: false,
    docsUrl: 'https://programmablesearchengine.google.com/controlpanel/all',
  },
  {
    id: 'search-searxng',
    label: 'SearXNG (self-hosted)',
    capability: 'search',
    icon: '🧩',
    description: 'Self-hosted metasearch JSON endpoint (no key, you run it).',
    envVars: [{ varName: 'SEARXNG_URL', prompt: 'SearXNG base URL (e.g. http://localhost:8888)', secret: false }],
    requiresAllVars: true,
    keyless: true,
    free: true,
  },
  {
    id: 'search-duckduckgo',
    label: 'DuckDuckGo',
    capability: 'search',
    icon: '🦆',
    description: 'Keyless HTML search — the always-available fallback.',
    envVars: [],
    requiresAllVars: false,
    keyless: true,
    free: true,
  },
  {
    id: 'reader-jina',
    label: 'Jina Reader (page reading)',
    capability: 'search',
    icon: '📄',
    description: 'Page-to-markdown extraction. Optional — a plain HTTP fetch is used without it.',
    envVars: [{ varName: 'JINA_API_KEY', prompt: 'Jina Reader API key (optional)', secret: true }],
    requiresAllVars: false,
    keyless: true,
    free: true,
    docsUrl: 'https://jina.ai/reader/',
  },

  // ── Vision / interpretation ─────────────────────────────────────────────
  {
    id: 'vision-gemini',
    label: 'Google Gemini (vision)',
    capability: 'vision',
    icon: '👁️',
    description: 'Image understanding / screenshot interpretation.',
    envVars: [{ varName: 'GEMINI_API_KEY', prompt: 'Google AI Studio API key', secret: true }],
    requiresAllVars: true,
    keyless: false,
    free: false,
    docsUrl: 'https://aistudio.google.com/apikey',
    sharedNote: 'Shared with Gemini/Nano-Banana image generation.',
  },
  {
    id: 'vision-openai',
    label: 'OpenAI (vision)',
    capability: 'vision',
    icon: '👁️',
    description: 'Vision models for image interpretation.',
    envVars: [{ varName: 'OPENAI_API_KEY', prompt: 'OpenAI API key', secret: true }],
    requiresAllVars: true,
    keyless: false,
    free: false,
    docsUrl: 'https://platform.openai.com/api-keys',
    sharedNote: 'Shared with OpenAI image generation and TTS/STT.',
  },

  // ── Speech ──────────────────────────────────────────────────────────────
  {
    id: 'speech-elevenlabs',
    label: 'ElevenLabs',
    capability: 'speech',
    icon: '🔊',
    description: 'High-quality text-to-speech (streaming).',
    envVars: [{ varName: 'ELEVENLABS_API_KEY', prompt: 'ElevenLabs API key', secret: true }],
    requiresAllVars: true,
    keyless: false,
    free: false,
    docsUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },
  {
    id: 'speech-openai',
    label: 'OpenAI (TTS)',
    capability: 'speech',
    icon: '🔉',
    description: 'OpenAI text-to-speech fallback.',
    envVars: [{ varName: 'OPENAI_API_KEY', prompt: 'OpenAI API key', secret: true }],
    requiresAllVars: true,
    keyless: false,
    free: false,
    docsUrl: 'https://platform.openai.com/api-keys',
    sharedNote: 'Shared with OpenAI image and vision.',
  },
  {
    id: 'speech-neutts',
    label: 'NeuTTS (local)',
    capability: 'speech',
    icon: '🎙️',
    description: 'Local neural TTS sidecar (optional key if your server requires one).',
    envVars: [{ varName: 'NEUTTS_API_KEY', prompt: 'NeuTTS API key (optional)', secret: true }],
    requiresAllVars: false,
    keyless: true,
    free: true,
  },
] as const;

/** Render order for the capability groups. */
export const SERVICE_CAPABILITY_ORDER: readonly ServiceCapability[] = [
  'image',
  'video',
  'search',
  'vision',
  'speech',
];

/** Look up a service definition by id. */
export function getServiceDefinition(id: string): ServiceDefinition | undefined {
  return SERVICE_CATALOG.find((s) => s.id === id);
}

/** Every env var name any service can write (the dashboard's allowlist). */
export const SERVICE_ENV_VARS: ReadonlySet<string> = new Set(
  SERVICE_CATALOG.flatMap((s) => s.envVars.map((v) => v.varName)),
);

/**
 * Service definitions grouped by capability, in render order. Empty groups are
 * omitted so the dashboard never renders an empty section.
 */
export function servicesByCapability(): Array<{ capability: ServiceCapability; label: string; services: ServiceDefinition[] }> {
  return SERVICE_CAPABILITY_ORDER.map((capability) => ({
    capability,
    label: SERVICE_CAPABILITY_LABELS[capability],
    services: SERVICE_CATALOG.filter((s) => s.capability === capability),
  })).filter((g) => g.services.length > 0);
}
