/**
 * I1 — Web research tools (`src/tools/web-research.ts`).
 *
 * Research tools (web search + page reading) with an
 * `agent/web_search_registry.py`: the model can search the web and read a
 * page's text to ground its answers — the single biggest "understanding"
 * capability agent-nuvira was missing (capability gap #3, 🔴 MAJOR).
 *
 * Backends (all OSS/free, zero cost to the user — the I-series rule):
 * - **DuckDuckGo HTML** (no key) — default `searchWeb` backend.
 * - **SearXNG** (self-host, OSS) — opt-in JSON endpoint when the user has one.
 * - **Jina Reader** (free tier) — page-to-markdown for `readWebPage`; falls
 *   back to a plain fetch + naive HTML→text strip when unconfigured.
 *
 * Availability gating: DDG needs no config so
 * `isWebSearchAvailable()` is true by default; SearXNG/Jina are opt-in via
 * env. Every fetch carries a timeout + a real browser UA (robots-aware);
 * results are cached in `context/cache.ts` (provider=`web`) so repeated
 * queries never hit the network twice. `fetchFn` is injectable for the
 * mocked-fetch tests (no network in tests).
 */
/** One search hit — the same {title,url,snippet} shape as web_search tools. */
export interface WebSearchResult {
    title: string;
    url: string;
    snippet: string;
}
export interface WebSearchOptions {
    /** Max hits to return (default 5). */
    maxResults?: number;
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
/** DDG needs no key → web search is available out of the box. */
export declare function isWebSearchAvailable(): boolean;
/**
 * Parse DDG HTML search results. The HTML lite endpoint marks each hit with
 * `class="result__a"` (title/link) and `class="result__snippet"` (blurb).
 * Regex-based (no parser dep); fails soft → zero results rather than throw.
 */
export declare function parseDuckDuckGoHtml(html: string, maxResults: number): WebSearchResult[];
/** SearXNG JSON → the same result shape (format=json returns `results[]`). */
export declare function parseSearxngJson(json: unknown, maxResults: number): WebSearchResult[];
/**
 * Search the web. Preferred backend: SearXNG when `searxngUrl` is configured;
 * otherwise DuckDuckGo HTML (no key). Results cached in context/cache.ts
 * (provider=`web`) keyed by backend+query.
 */
export declare function searchWeb(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]>;
/**
 * Read a page's text. Preferred: Jina Reader free tier (`r.jina.ai/<url>`,
 * markdown out) when a JINA_API_KEY is set; otherwise a plain fetch + naive
 * HTML→text strip. Cached in context/cache.ts (provider=`web`).
 */
export declare function readWebPage(url: string, options?: ReadPageOptions): Promise<string>;
/**
 * SSRF guard for read_page: only http/https, and (unless
 * BUFF_WEB_ALLOW_PRIVATE=1) no loopback / link-local / private-range hosts —
 * cloud metadata (169.254.169.254) and internal services are unreachable.
 */
export declare function isAllowedReadUrl(url: string): boolean;
//# sourceMappingURL=web-research.d.ts.map