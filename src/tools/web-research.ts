/**
 * I1 — Web research tools (`src/tools/web-research.ts`).
 *
 * Research tools (web search + page reading) with an
 * `agent/web_search_registry.py`: the model can search the web and read a
 * page's text to ground its answers — the single biggest "understanding"
 * capability agent-nuvira was missing (capability gap #3, 🔴 MAJOR).
 *
 * Search backends — bring your own key (BYOK) or use the keyless default:
 * - **DuckDuckGo HTML** (no key) — the always-available fallback.
 * - **SearXNG** (self-host, OSS) — opt-in JSON endpoint (`SEARXNG_URL`).
 * - **Brave Search** (`BRAVE_SEARCH_API_KEY`) — paid, high quality.
 * - **Serper.dev** (`SERPER_API_KEY`) — paid Google SERP proxy.
 * - **Tavily** (`TAVILY_API_KEY`) — paid, LLM-optimised.
 * - **Google Custom Search** (`GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_ID`).
 *
 * Which backend runs is resolved by {@link resolveSearchProvider}: an explicit
 * `provider` option wins, then the first backend whose key is configured (in
 * {@link SEARCH_BACKEND_PRIORITY} order), then SearXNG, then DuckDuckGo. When a
 * keyed backend returns nothing (or errors) the call degrades to DuckDuckGo so
 * `web_search` never returns empty just because one provider is down.
 *
 * Page reading: **Jina Reader** (free tier, `JINA_API_KEY`) for page-to-markdown;
 * falls back to a plain fetch + naive HTML→text strip when unconfigured.
 *
 * Every fetch carries a timeout + a real browser UA (robots-aware); results are
 * cached in `context/cache.ts` (provider=`web`) so repeated queries never hit
 * the network twice. `fetchFn` is injectable for the mocked-fetch tests (no
 * network in tests).
 */

import { getCache } from '../context/cache.js';
import { envBuff } from '../config/paths';

// ─── Types ──────────────────────────────────────────────────────────────────

/** One search hit — the same {title,url,snippet} shape as web_search tools. */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** A concrete search backend id. */
export type SearchProvider =
  | 'brave'
  | 'serper'
  | 'tavily'
  | 'google-cse'
  | 'searxng'
  | 'duckduckgo';

export interface WebSearchOptions {
  /** Max hits to return (default 5). */
  maxResults?: number;
  /**
   * Explicit backend override. When omitted the first AVAILABLE backend in
   * {@link SEARCH_BACKEND_PRIORITY} order is used. Unknown values are ignored.
   */
  provider?: string;
  /** SearXNG self-hosted JSON endpoint, e.g. http://localhost:8888/search. */
  searxngUrl?: string;
  /** Injectable fetch (tests stub it; defaults to global fetch). */
  fetchFn?: typeof fetch;
  /** Fetch timeout in ms (default 15_000). */
  timeoutMs?: number;
}

export interface ReadPageOptions {
  /** Max characters of extracted text (default 20_000). */
  maxChars?: number;
  /** Injectable fetch (tests stub it; defaults to global fetch). */
  fetchFn?: typeof fetch;
  /** Fetch timeout in ms (default 20_000). */
  timeoutMs?: number;
}

/** Default browser-ish UA so endpoints treat us like a real client. */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const DEFAULT_SEARCH_TTL = 6 * 3600; // 6h — search results drift slowly
const DEFAULT_PAGE_TTL = 24 * 3600; // 24h — page text is stable

// ─── Backend catalog ────────────────────────────────────────────────────────

/**
 * A search backend descriptor. `keyEnvVars` lists every env var that can carry
 * the credential (first set wins); plain names are checked alongside the
 * `NUVIRA_`/`BUFF_` prefixed forms so both a bare export and the nuvira-style
 * override work.
 */
interface SearchBackend {
  id: SearchProvider;
  label: string;
  /** Env vars that can supply the key (empty = keyless). */
  keyEnvVars: string[];
  /** Extra required env var (e.g. Google CSE also needs the engine id). */
  extraEnvVars?: string[];
  /** True when an API key is required. */
  requiresKey: boolean;
  /** Cost note for diagnostics. */
  free: boolean;
}

/** The catalog — single source of backend metadata. */
export const SEARCH_BACKENDS: Record<SearchProvider, SearchBackend> = {
  brave: {
    id: 'brave',
    label: 'Brave Search',
    keyEnvVars: ['BRAVE_SEARCH_API_KEY', 'BRAVE_API_KEY'],
    requiresKey: true,
    free: false,
  },
  serper: {
    id: 'serper',
    label: 'Serper.dev',
    keyEnvVars: ['SERPER_API_KEY'],
    requiresKey: true,
    free: false,
  },
  tavily: {
    id: 'tavily',
    label: 'Tavily',
    keyEnvVars: ['TAVILY_API_KEY'],
    requiresKey: true,
    free: false,
  },
  'google-cse': {
    id: 'google-cse',
    label: 'Google Custom Search',
    keyEnvVars: ['GOOGLE_CSE_API_KEY', 'GOOGLE_API_KEY'],
    extraEnvVars: ['GOOGLE_CSE_ID', 'GOOGLE_CSE_CX'],
    requiresKey: true,
    free: false,
  },
  searxng: {
    id: 'searxng',
    label: 'SearXNG (self-hosted)',
    keyEnvVars: [],
    requiresKey: false,
    free: true,
  },
  duckduckgo: {
    id: 'duckduckgo',
    label: 'DuckDuckGo (keyless)',
    keyEnvVars: [],
    requiresKey: false,
    free: true,
  },
};

/**
 * Auto-selection order when no explicit provider is configured. A user who set
 * several keys gets the highest-quality one; `searxng` and `duckduckgo` are the
 * keyless tail so a search always works.
 */
export const SEARCH_BACKEND_PRIORITY: readonly SearchProvider[] = [
  'brave',
  'serper',
  'tavily',
  'google-cse',
  'searxng',
  'duckduckgo',
];

/** Read the first non-empty value among names (prefixed + plain). */
function keyFromEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = (envBuff(name) ?? process.env[name])?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Resolve the effective SearXNG endpoint (explicit option or env). */
function searxngEndpoint(options: WebSearchOptions): string | undefined {
  return options.searxngUrl || envBuff('SEARXNG_URL');
}

/** Is a specific backend usable right now (key/endpoint present)? */
export function isBackendAvailable(provider: SearchProvider, options: WebSearchOptions = {}): boolean {
  const backend = SEARCH_BACKENDS[provider];
  if (!backend) return false;
  if (provider === 'duckduckgo') return true;
  if (provider === 'searxng') return Boolean(searxngEndpoint(options));
  if (!keyFromEnv(backend.keyEnvVars)) return false;
  if (backend.extraEnvVars && !keyFromEnv(backend.extraEnvVars)) return false;
  return true;
}

/**
 * Which backend will actually run. Explicit `provider` (when known) wins, then
 * the first available backend in priority order. Never throws.
 */
export function resolveSearchProvider(options: WebSearchOptions = {}): SearchProvider {
  const explicit = options.provider as SearchProvider | undefined;
  if (explicit && SEARCH_BACKENDS[explicit]) return explicit;
  for (const id of SEARCH_BACKEND_PRIORITY) {
    if (isBackendAvailable(id, options)) return id;
  }
  return 'duckduckgo';
}

/** Every backend id with a configured key/endpoint (for CLI + dashboard). */
export function availableSearchBackends(options: WebSearchOptions = {}): SearchProvider[] {
  return SEARCH_BACKEND_PRIORITY.filter((id) => isBackendAvailable(id, options));
}

// ─── Fetch helper ───────────────────────────────────────────────────────────

/** fetch with timeout + browser UA. Aborts via AbortSignal.timeout when free. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8',
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Availability ───────────────────────────────────────────────────────────

/** DDG needs no key → web search is available out of the box. */
export function isWebSearchAvailable(): boolean {
  return true;
}

// ─── DuckDuckGo HTML parsing ────────────────────────────────────────────────

/**
 * Parse DDG HTML search results. The HTML lite endpoint marks each hit with
 * `class="result__a"` (title/link) and `class="result__snippet"` (blurb).
 * Regex-based (no parser dep); fails soft → zero results rather than throw.
 */
export function parseDuckDuckGoHtml(html: string, maxResults: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const resultRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = resultRe.exec(html)) !== null && results.length < maxResults) {
    const rawUrl = match[1];
    const title = stripTags(decodeEntities(match[2])).trim();
    if (!rawUrl || !title) continue;
    // DDG wraps every external hit in a redirect URL
    // (`/l/?uddg=<url-encoded-target>&...`). Decode the real target so the
    // model can hand it straight to read_page.
    const url = decodeDdgTargetUrl(rawUrl);
    if (!url) continue;
    results.push({ title, url, snippet: '' });
  }

  // Attach snippets (separate `<a class="result__snippet">` blocks) by index.
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let snippetMatch: RegExpExecArray | null;
  let i = 0;
  while ((snippetMatch = snippetRe.exec(html)) !== null && i < results.length) {
    results[i].snippet = stripTags(decodeEntities(snippetMatch[1])).trim();
    i++;
  }
  return results;
}

/** SearXNG JSON → the same result shape (format=json returns `results[]`). */
export function parseSearxngJson(json: unknown, maxResults: number): WebSearchResult[] {
  if (!json || typeof json !== 'object') return [];
  const arr = (json as { results?: Array<{ title?: string; url?: string; content?: string }> }).results;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((r) => r && r.title && r.url)
    .slice(0, maxResults)
    .map((r) => ({ title: r.title as string, url: r.url as string, snippet: (r.content || '').trim() }));
}

// ─── Hosted-backend JSON parsers (one per provider shape) ───────────────────

/** Shared cleanup: strip tags/entities from a provider snippet. */
function cleanSnippet(value: unknown): string {
  if (typeof value !== 'string') return '';
  return stripTags(decodeEntities(value)).trim();
}

/** Brave Search `{ web: { results: [{ title, url, description }] } }`. */
export function parseBraveJson(json: unknown, maxResults: number): WebSearchResult[] {
  const arr = (json as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } })?.web?.results;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((r) => r && r.title && r.url)
    .slice(0, maxResults)
    .map((r) => ({ title: cleanSnippet(r.title), url: r.url as string, snippet: cleanSnippet(r.description) }));
}

/** Serper.dev `{ organic: [{ title, link, snippet }] }`. */
export function parseSerperJson(json: unknown, maxResults: number): WebSearchResult[] {
  const arr = (json as { organic?: Array<{ title?: string; link?: string; snippet?: string }> })?.organic;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((r) => r && r.title && r.link)
    .slice(0, maxResults)
    .map((r) => ({ title: cleanSnippet(r.title), url: r.link as string, snippet: cleanSnippet(r.snippet) }));
}

/** Tavily `{ results: [{ title, url, content }] }`. */
export function parseTavilyJson(json: unknown, maxResults: number): WebSearchResult[] {
  const arr = (json as { results?: Array<{ title?: string; url?: string; content?: string }> })?.results;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((r) => r && r.title && r.url)
    .slice(0, maxResults)
    .map((r) => ({ title: cleanSnippet(r.title), url: r.url as string, snippet: cleanSnippet(r.content) }));
}

/** Google Custom Search `{ items: [{ title, link, snippet }] }`. */
export function parseGoogleCseJson(json: unknown, maxResults: number): WebSearchResult[] {
  const arr = (json as { items?: Array<{ title?: string; link?: string; snippet?: string }> })?.items;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((r) => r && r.title && r.link)
    .slice(0, maxResults)
    .map((r) => ({ title: cleanSnippet(r.title), url: r.link as string, snippet: cleanSnippet(r.snippet) }));
}

// ─── Backend runners ────────────────────────────────────────────────────────

/** DuckDuckGo HTML lite (no key). */
async function runDuckDuckGo(
  query: string,
  maxResults: number,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<WebSearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, {}, timeoutMs, fetchFn);
  if (!res.ok) return [];
  return parseDuckDuckGoHtml(await res.text(), maxResults);
}

/** SearXNG self-hosted JSON endpoint. */
async function runSearxng(
  query: string,
  maxResults: number,
  endpoint: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<WebSearchResult[]> {
  const url = `${endpoint.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetchWithTimeout(url, {}, timeoutMs, fetchFn);
  if (!res.ok) return [];
  return parseSearxngJson(await res.json(), maxResults);
}

/** Brave Search API (`X-Subscription-Token`). */
async function runBrave(
  query: string,
  maxResults: number,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<WebSearchResult[]> {
  const key = keyFromEnv(SEARCH_BACKENDS.brave.keyEnvVars);
  if (!key) return [];
  const count = Math.min(maxResults, 20);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetchWithTimeout(
    url,
    { headers: { 'X-Subscription-Token': key, Accept: 'application/json' } },
    timeoutMs,
    fetchFn,
  );
  if (!res.ok) return [];
  return parseBraveJson(await res.json(), maxResults);
}

/** Serper.dev Google SERP proxy (`X-API-KEY`, POST {q}). */
async function runSerper(
  query: string,
  maxResults: number,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<WebSearchResult[]> {
  const key = keyFromEnv(SEARCH_BACKENDS.serper.keyEnvVars);
  if (!key) return [];
  const res = await fetchWithTimeout(
    'https://google.serper.dev/search',
    {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
      body: JSON.stringify({ q: query, num: maxResults }),
    },
    timeoutMs,
    fetchFn,
  );
  if (!res.ok) return [];
  return parseSerperJson(await res.json(), maxResults);
}

/** Tavily (`Authorization: Bearer`, POST {query}). */
async function runTavily(
  query: string,
  maxResults: number,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<WebSearchResult[]> {
  const key = keyFromEnv(SEARCH_BACKENDS.tavily.keyEnvVars);
  if (!key) return [];
  const res = await fetchWithTimeout(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic' }),
    },
    timeoutMs,
    fetchFn,
  );
  if (!res.ok) return [];
  return parseTavilyJson(await res.json(), maxResults);
}

/** Google Custom Search JSON API (`key` + `cx`). */
async function runGoogleCse(
  query: string,
  maxResults: number,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<WebSearchResult[]> {
  const key = keyFromEnv(SEARCH_BACKENDS['google-cse'].keyEnvVars);
  const cx = keyFromEnv(SEARCH_BACKENDS['google-cse'].extraEnvVars ?? []);
  if (!key || !cx) return [];
  const num = Math.min(maxResults, 10);
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=${num}`;
  const res = await fetchWithTimeout(url, {}, timeoutMs, fetchFn);
  if (!res.ok) return [];
  return parseGoogleCseJson(await res.json(), maxResults);
}

/** Dispatch a query to one concrete backend. */
async function runBackend(
  provider: SearchProvider,
  query: string,
  options: WebSearchOptions,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<WebSearchResult[]> {
  const maxResults = options.maxResults ?? 5;
  switch (provider) {
    case 'brave':
      return runBrave(query, maxResults, timeoutMs, fetchFn);
    case 'serper':
      return runSerper(query, maxResults, timeoutMs, fetchFn);
    case 'tavily':
      return runTavily(query, maxResults, timeoutMs, fetchFn);
    case 'google-cse':
      return runGoogleCse(query, maxResults, timeoutMs, fetchFn);
    case 'searxng': {
      const endpoint = searxngEndpoint(options);
      if (!endpoint) return [];
      return runSearxng(query, maxResults, endpoint, timeoutMs, fetchFn);
    }
    case 'duckduckgo':
    default:
      return runDuckDuckGo(query, maxResults, timeoutMs, fetchFn);
  }
}

// ─── searchWeb ──────────────────────────────────────────────────────────────

/**
 * Search the web. Backend: an explicit `provider` option, else the first
 * AVAILABLE backend in priority order (Brave → Serper → Tavily → Google CSE →
 * SearXNG → DuckDuckGo). When a keyed backend yields nothing, the query is
 * retried once on the keyless DuckDuckGo fallback. Results cached in
 * context/cache.ts (provider=`web`) keyed by backend+query.
 */
export async function searchWeb(
  query: string,
  options: WebSearchOptions = {},
): Promise<WebSearchResult[]> {
  const fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const provider = resolveSearchProvider(options);

  const cache = getCache();
  const cacheKey = `${provider}:${query}`;
  const cached = await cache.get(cacheKey, 'web', provider);
  if (cached) {
    try {
      return JSON.parse(cached) as WebSearchResult[];
    } catch { /* stale cache — re-fetch */ }
  }

  let results: WebSearchResult[] = [];
  try {
    results = await runBackend(provider, query, options, fetchFn, timeoutMs);
    // Keyed backend down or empty → degrade to the keyless fallback so a
    // `web_search` never silently returns nothing because one provider failed.
    if (results.length === 0 && provider !== 'duckduckgo') {
      results = await runDuckDuckGo(query, options.maxResults ?? 5, timeoutMs, fetchFn);
    }
  } catch {
    return []; // network failure → empty, never throw into the tool loop
  }

  await cache.set(cacheKey, JSON.stringify(results), 'web', provider, DEFAULT_SEARCH_TTL);
  return results;
}

// ─── readWebPage ────────────────────────────────────────────────────────────

/**
 * Read a page's text. Preferred: Jina Reader free tier (`r.jina.ai/<url>`,
 * markdown out) when a JINA_API_KEY is set; otherwise a plain fetch + naive
 * HTML→text strip. Cached in context/cache.ts (provider=`web`).
 */
export async function readWebPage(url: string, options: ReadPageOptions = {}): Promise<string> {
  const fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis);
  const maxChars = options.maxChars ?? 20_000;
  const timeoutMs = options.timeoutMs ?? 20_000;

  // SSRF guard (reviewer catch): only http/https, and no private/link-local
  // hosts unless the user explicitly opts out with BUFF_WEB_ALLOW_PRIVATE=1.
  if (!isAllowedReadUrl(url)) {
    return 'Blocked by read_page safety guard: only public http(s) URLs are readable (set BUFF_WEB_ALLOW_PRIVATE=1 to allow private/link-local hosts).';
  }

  const cache = getCache();
  const cached = await cache.get(url, 'web', 'read');
  if (cached) return cached.slice(0, maxChars);

  let text = '';
  const jinaKey = process.env.JINA_API_KEY;
  try {
    if (jinaKey) {
      const res = await fetchWithTimeout(
        `https://r.jina.ai/${url}`,
        { headers: { Authorization: `Bearer ${jinaKey}` } },
        timeoutMs,
        fetchFn,
      );
      if (res.ok) text = (await res.text()).trim();
    }
    if (!text) {
      const res = await fetchWithTimeout(url, {}, timeoutMs, fetchFn);
      if (res.ok) {
        const raw = await res.text();
        text = htmlToText(raw);
      }
    }
  } catch {
    return ''; // network failure → empty, never throw into the tool loop
  }

  if (!text) return '';
  await cache.set(url, text, 'web', 'read', DEFAULT_PAGE_TTL);
  return text.slice(0, maxChars);
}

// ─── URL helpers ────────────────────────────────────────────────────────────

/**
 * Decode a DDG redirect URL (`/l/?uddg=<encoded>&...`) to the real target.
 * Clean http(s) URLs pass through unchanged; anything else returns ''.
 */
function decodeDdgTargetUrl(rawUrl: string): string {
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  const uddg = rawUrl.match(/[?&]uddg=([^&]+)/i)?.[1];
  if (!uddg) return '';
  try {
    const decoded = decodeURIComponent(uddg);
    return /^https?:\/\//i.test(decoded) ? decoded : '';
  } catch {
    return '';
  }
}

/**
 * SSRF guard for read_page: only http/https, and (unless
 * BUFF_WEB_ALLOW_PRIVATE=1) no loopback / link-local / private-range hosts —
 * cloud metadata (169.254.169.254) and internal services are unreachable.
 */
export function isAllowedReadUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (envBuff('WEB_ALLOW_PRIVATE') === '1') return true;
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return false;
  // IPv4: loopback 127/8, link-local 169.254/16, private 10/8, 172.16/12,
  // 192.168/16, and the 0.0.0.0/8 documentation block.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      return false;
    }
  }
  // IPv6: loopback ::1 handled above; reject the link-local fe80::/10 prefix.
  if (host.startsWith('fe80:')) return false;
  return true;
}

// ─── HTML→text (naive, no parser dep) ───────────────────────────────────────

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function htmlToText(html: string): string {
  // Drop scripts/styles/nav first, then tags → text, collapse whitespace.
  return stripTags(html);
}
