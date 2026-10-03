/**
 * Service reachability probes — backs the dashboard's per-service
 * "Test connection" button and keeps it honest.
 *
 * A saved key is not the same as a WORKING key: a typo'd or revoked credential
 * looks configured and then fails on first use. Each probe makes the smallest
 * real request the backend allows and classifies the response — 2xx = reachable,
 * 401/403 = key rejected by the provider, anything else = the provider answered
 * but not as expected. Probes never throw; a network failure is reported as a
 * failed probe with the reason.
 *
 * The fetch is injectable so tests can stub it (no network in tests).
 */

import type { ServiceDefinition } from './service-catalog.js';

export interface ServiceProbeResult {
  ok: boolean;
  /** Human-readable outcome, e.g. "Reachable (HTTP 200)" or "Key rejected (HTTP 401)". */
  detail: string;
}

const PROBE_TIMEOUT_MS = 8_000;

type FetchFn = typeof fetch;

/** fetch with an abort timeout; the caller classifies the response. */
async function request(url: string, init: RequestInit, fetchFn: FetchFn): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Strict probe: a 2xx proves the key works; 401/403 means it was rejected. */
function classifyStrict(res: Response): ServiceProbeResult {
  if (res.ok) return { ok: true, detail: `Reachable (HTTP ${res.status})` };
  if (res.status === 401 || res.status === 403) return { ok: false, detail: `Key rejected (HTTP ${res.status})` };
  return { ok: false, detail: `Unexpected response (HTTP ${res.status})` };
}

/**
 * Reachability probe for backends with no cheap read endpoint (a local server,
 * FAL's POST-only API): any non-auth, non-5xx answer proves the network path and
 * the credentials were at least accepted far enough to route.
 */
function classifyReachable(res: Response): ServiceProbeResult {
  if (res.status === 401 || res.status === 403) return { ok: false, detail: `Key rejected (HTTP ${res.status})` };
  if (res.status >= 500) return { ok: false, detail: `Backend error (HTTP ${res.status})` };
  return { ok: true, detail: `Reachable (HTTP ${res.status})` };
}

function fail(err: unknown): ServiceProbeResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { ok: false, detail: msg.includes('abort') ? 'Timed out' : `Connection failed: ${msg}` };
}

/**
 * Probe one service. `values` maps env-var name → value (from the credential
 * env file / process env); missing optional vars are simply undefined.
 */
export async function probeService(
  def: ServiceDefinition,
  values: Record<string, string>,
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
): Promise<ServiceProbeResult> {
  // Keyless backends need nothing to be verifiable.
  if (def.envVars.length === 0) {
    return { ok: true, detail: 'No key needed — this backend is always available.' };
  }

  try {
    switch (def.id) {
      // ── Image ────────────────────────────────────────────────────────────
      case 'image-gemini':
      case 'vision-gemini':
        return classifyStrict(
          await request(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(values.GEMINI_API_KEY ?? '')}`,
            {},
            fetchFn,
          ),
        );
      case 'image-openai':
      case 'vision-openai':
      case 'speech-openai':
        return classifyStrict(
          await request('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${values.OPENAI_API_KEY ?? ''}` } }, fetchFn),
        );
      case 'image-stability':
        return classifyStrict(
          await request('https://api.stability.ai/v1/user/account', { headers: { Authorization: `Bearer ${values.STABILITY_API_KEY ?? ''}` } }, fetchFn),
        );
      case 'image-comfyui':
        return classifyReachable(await request(values.BUFF_IMAGE_API_URL ?? '', { method: 'GET' }, fetchFn));

      // ── Video ────────────────────────────────────────────────────────────
      case 'video-fal':
        // FAL's REST API is POST-only; a GET to the host proves reachability and
        // surfaces an auth rejection, which is what a connection test needs.
        return classifyReachable(
          await request('https://fal.run/', { method: 'GET', headers: { Authorization: `Key ${values.FAL_KEY ?? ''}` } }, fetchFn),
        );

      // ── Web search & reading ─────────────────────────────────────────────
      case 'search-brave':
        return classifyStrict(
          await request(
            'https://api.search.brave.com/res/v1/web/search?q=nuvira&count=1',
            { headers: { 'X-Subscription-Token': values.BRAVE_SEARCH_API_KEY ?? '', Accept: 'application/json' } },
            fetchFn,
          ),
        );
      case 'search-serper':
        return classifyStrict(
          await request(
            'https://google.serper.dev/search',
            { method: 'POST', headers: { 'X-API-KEY': values.SERPER_API_KEY ?? '', 'content-type': 'application/json' }, body: JSON.stringify({ q: 'nuvira', num: 1 }) },
            fetchFn,
          ),
        );
      case 'search-tavily':
        return classifyStrict(
          await request(
            'https://api.tavily.com/search',
            { method: 'POST', headers: { Authorization: `Bearer ${values.TAVILY_API_KEY ?? ''}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'nuvira', max_results: 1 }) },
            fetchFn,
          ),
        );
      case 'search-google-cse':
        return classifyStrict(
          await request(
            `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(values.GOOGLE_CSE_API_KEY ?? '')}&cx=${encodeURIComponent(values.GOOGLE_CSE_ID ?? '')}&q=nuvira&num=1`,
            {},
            fetchFn,
          ),
        );
      case 'search-searxng':
        return classifyReachable(
          await request(`${(values.SEARXNG_URL ?? '').replace(/\/$/, '')}/search?q=nuvira&format=json`, { method: 'GET' }, fetchFn),
        );
      case 'reader-jina':
        return classifyStrict(
          await request(
            'https://r.jina.ai/https://example.com',
            { headers: values.JINA_API_KEY ? { Authorization: `Bearer ${values.JINA_API_KEY}` } : {} },
            fetchFn,
          ),
        );

      // ── Speech ───────────────────────────────────────────────────────────
      case 'speech-elevenlabs':
        return classifyStrict(
          await request('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': values.ELEVENLABS_API_KEY ?? '' } }, fetchFn),
        );
      case 'speech-neutts':
        return { ok: true, detail: 'Local sidecar — no remote reachability check.' };
      default:
        return { ok: false, detail: 'No probe is defined for this service.' };
    }
  } catch (err) {
    return fail(err);
  }
}
