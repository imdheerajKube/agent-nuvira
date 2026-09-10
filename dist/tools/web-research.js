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
import { getCache } from '../context/cache.js';
import { envBuff } from '../config/paths.js';
/** Default browser-ish UA so endpoints treat us like a real client. */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DEFAULT_SEARCH_TTL = 6 * 3600; // 6h — search results drift slowly
const DEFAULT_PAGE_TTL = 24 * 3600; // 24h — page text is stable
// ─── Fetch helper ───────────────────────────────────────────────────────────
/** fetch with timeout + browser UA. Aborts via AbortSignal.timeout when free. */
async function fetchWithTimeout(url, init, timeoutMs, fetchFn) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchFn(url, {
            ...init,
            signal: controller.signal,
            headers: {
                'User-Agent': BROWSER_UA,
                Accept: 'text/html,application/xhtml+xml,text/plain,*/*;q=0.8',
                ...(init.headers || {}),
            },
        });
    }
    finally {
        clearTimeout(timer);
    }
}
// ─── Availability ───────────────────────────────────────────────────────────
/** DDG needs no key → web search is available out of the box. */
export function isWebSearchAvailable() {
    return true;
}
// ─── DuckDuckGo HTML parsing ────────────────────────────────────────────────
/**
 * Parse DDG HTML search results. The HTML lite endpoint marks each hit with
 * `class="result__a"` (title/link) and `class="result__snippet"` (blurb).
 * Regex-based (no parser dep); fails soft → zero results rather than throw.
 */
export function parseDuckDuckGoHtml(html, maxResults) {
    const results = [];
    const resultRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    while ((match = resultRe.exec(html)) !== null && results.length < maxResults) {
        const rawUrl = match[1];
        const title = stripTags(decodeEntities(match[2])).trim();
        if (!rawUrl || !title)
            continue;
        // DDG wraps every external hit in a redirect URL
        // (`/l/?uddg=<url-encoded-target>&...`). Decode the real target so the
        // model can hand it straight to read_page.
        const url = decodeDdgTargetUrl(rawUrl);
        if (!url)
            continue;
        results.push({ title, url, snippet: '' });
    }
    // Attach snippets (separate `<a class="result__snippet">` blocks) by index.
    const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    let snippetMatch;
    let i = 0;
    while ((snippetMatch = snippetRe.exec(html)) !== null && i < results.length) {
        results[i].snippet = stripTags(decodeEntities(snippetMatch[1])).trim();
        i++;
    }
    return results;
}
/** SearXNG JSON → the same result shape (format=json returns `results[]`). */
export function parseSearxngJson(json, maxResults) {
    if (!json || typeof json !== 'object')
        return [];
    const arr = json.results;
    if (!Array.isArray(arr))
        return [];
    return arr
        .filter((r) => r && r.title && r.url)
        .slice(0, maxResults)
        .map((r) => ({ title: r.title, url: r.url, snippet: (r.content || '').trim() }));
}
// ─── searchWeb ──────────────────────────────────────────────────────────────
/**
 * Search the web. Preferred backend: SearXNG when `searxngUrl` is configured;
 * otherwise DuckDuckGo HTML (no key). Results cached in context/cache.ts
 * (provider=`web`) keyed by backend+query.
 */
export async function searchWeb(query, options = {}) {
    const fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis);
    const maxResults = options.maxResults ?? 5;
    const timeoutMs = options.timeoutMs ?? 15_000;
    const cache = getCache();
    const backend = options.searxngUrl ? 'searxng' : 'duckduckgo';
    const cacheKey = `${backend}:${query}`;
    const cached = await cache.get(cacheKey, 'web', backend);
    if (cached) {
        try {
            return JSON.parse(cached);
        }
        catch { /* stale cache — re-fetch */ }
    }
    let results = [];
    try {
        if (options.searxngUrl) {
            const url = `${options.searxngUrl.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
            const res = await fetchWithTimeout(url, {}, timeoutMs, fetchFn);
            if (res.ok) {
                const json = await res.json();
                results = parseSearxngJson(json, maxResults);
            }
        }
        if (results.length === 0) {
            const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            const res = await fetchWithTimeout(url, {}, timeoutMs, fetchFn);
            if (res.ok) {
                const html = await res.text();
                results = parseDuckDuckGoHtml(html, maxResults);
            }
        }
    }
    catch {
        return []; // network failure → empty, never throw into the tool loop
    }
    await cache.set(cacheKey, JSON.stringify(results), 'web', backend, DEFAULT_SEARCH_TTL);
    return results;
}
// ─── readWebPage ────────────────────────────────────────────────────────────
/**
 * Read a page's text. Preferred: Jina Reader free tier (`r.jina.ai/<url>`,
 * markdown out) when a JINA_API_KEY is set; otherwise a plain fetch + naive
 * HTML→text strip. Cached in context/cache.ts (provider=`web`).
 */
export async function readWebPage(url, options = {}) {
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
    if (cached)
        return cached.slice(0, maxChars);
    let text = '';
    const jinaKey = process.env.JINA_API_KEY;
    try {
        if (jinaKey) {
            const res = await fetchWithTimeout(`https://r.jina.ai/${url}`, { headers: { Authorization: `Bearer ${jinaKey}` } }, timeoutMs, fetchFn);
            if (res.ok)
                text = (await res.text()).trim();
        }
        if (!text) {
            const res = await fetchWithTimeout(url, {}, timeoutMs, fetchFn);
            if (res.ok) {
                const raw = await res.text();
                text = htmlToText(raw);
            }
        }
    }
    catch {
        return ''; // network failure → empty, never throw into the tool loop
    }
    if (!text)
        return '';
    await cache.set(url, text, 'web', 'read', DEFAULT_PAGE_TTL);
    return text.slice(0, maxChars);
}
// ─── URL helpers ────────────────────────────────────────────────────────────
/**
 * Decode a DDG redirect URL (`/l/?uddg=<encoded>&...`) to the real target.
 * Clean http(s) URLs pass through unchanged; anything else returns ''.
 */
function decodeDdgTargetUrl(rawUrl) {
    if (/^https?:\/\//i.test(rawUrl))
        return rawUrl;
    const uddg = rawUrl.match(/[?&]uddg=([^&]+)/i)?.[1];
    if (!uddg)
        return '';
    try {
        const decoded = decodeURIComponent(uddg);
        return /^https?:\/\//i.test(decoded) ? decoded : '';
    }
    catch {
        return '';
    }
}
/**
 * SSRF guard for read_page: only http/https, and (unless
 * BUFF_WEB_ALLOW_PRIVATE=1) no loopback / link-local / private-range hosts —
 * cloud metadata (169.254.169.254) and internal services are unreachable.
 */
export function isAllowedReadUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return false;
    if (envBuff('WEB_ALLOW_PRIVATE') === '1')
        return true;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '::1' || host.endsWith('.localhost'))
        return false;
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
    if (host.startsWith('fe80:'))
        return false;
    return true;
}
// ─── HTML→text (naive, no parser dep) ───────────────────────────────────────
function stripTags(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function decodeEntities(s) {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
}
function htmlToText(html) {
    // Drop scripts/styles/nav first, then tags → text, collapse whitespace.
    return stripTags(html);
}
//# sourceMappingURL=web-research.js.map