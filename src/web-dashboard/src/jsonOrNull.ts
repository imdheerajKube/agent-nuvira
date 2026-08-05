/**
 * Shared defensive JSON parser for dashboard /api/* responses.
 *
 * Single source of truth for the guard against the "Failed to execute 'json'
 * on 'Response': Unexpected token '<'" crash: a STALE dashboard server (older
 * version missing newer routes) can answer an /api/* request with the SPA
 * index.html (HTTP 200, text/html). `res.ok` is true for that HTML-200, so a
 * bare `res.json()` throws on the `<` of `<!DOCTYPE`.
 *
 * Returns the parsed body ONLY when the response is actually JSON; otherwise
 * null so callers degrade (ModelsPanel hides optional sections, App waits for
 * the next SSE snapshot) instead of crashing.
 */
export async function parseJsonOrNull(res: Response): Promise<unknown | null> {
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json') && !type.includes('text/json')) {
    // Diagnosable in the browser console instead of looking like a random
    // empty dashboard.
    if (type.includes('text/html')) {
      console.warn(
        `[dashboard] GET ${res.url || '/api/*'} returned HTML (${res.status}) instead of JSON — ` +
        'the dashboard server may be an older version. Restart it (pkill -f "agent-nuvira dashboard").',
      );
    }
    return null;
  }
  try {
    return await res.json();
  } catch {
    return null;
  }
}
