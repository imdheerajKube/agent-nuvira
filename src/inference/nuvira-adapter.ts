/**
 * Nuvira Gateway Adapter — OpenAI-compatible provider (Nuvira-Router P1 M1.1).
 *
 * Talks to ANY OpenAI-compatible /v1 endpoint — an enterprise gateway, a
 * self-hosted router, vLLM, LM Studio, LiteLLM, or a future `buff nuvira
 * serve` central mode (M6.4). Implemented as a thin specialization of the
 * generic OpenAICompatAdapter (Issue 001): the gateway is just the `nuvira`
 * entry of the provider catalog, so it shares the exact same adapter code —
 * and therefore the same failover/registry/telemetry contract — as every
 * other OpenAI-compatible catalog provider (OpenAI, Mistral, Together,
 * DeepInfra, Fireworks, Perplexity, Azure, LM Studio, Anyscale, vLLM, ...).
 *
 * Config (ProviderConfig, already has baseUrl):
 *   baseUrl   — gateway base, default http://127.0.0.1:20128/v1
 *   apiKey    — optional (many local gateways need none)
 *   model     — default model id
 *
 * Error mapping keeps the shared classification contract (the message text is
 * what classifyFallbackError buckets): 401/403→auth, 429→rate-limit,
 * 5xx→server, fetch/network→network, abort/timeout→timeout. A dead gateway
 * therefore learns through the SAME pipeline as any provider — it gets parked
 * or blocked predictively, never failed into repeatedly.
 */

import { ProviderConfig } from '../config/types.js';
import { OpenAICompatAdapter } from './openai-compat-adapter.js';

const NUVIRA_BASE_URL = 'http://127.0.0.1:20128/v1';

export class NuviraAdapter extends OpenAICompatAdapter {
  constructor(config: ProviderConfig) {
    super(config, {
      providerId: 'nuvira',
      label: 'Nuvira Gateway',
      defaultBaseUrl: NUVIRA_BASE_URL,
      keyless: true,
    });
  }
}
