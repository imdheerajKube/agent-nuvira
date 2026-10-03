/**
 * I1 — Web research tool tests (`src/tools/web-research.ts`).
 *
 * All fetch calls are mocked — no network in tests (plan acceptance). Covers:
 * - parseDuckDuckGoHtml — parses DDG HTML lite results into {title,url,snippet}
 * - parseSearxngJson — maps SearXNG JSON to the same shape
 * - searchWeb — DDG default, SearXNG preferred when configured, cache hit
 * - readWebPage — Jina Reader path (JINA_API_KEY), plain-fetch fallback,
 *   HTML→text stripping, cache hit, error → ''
 * - isWebSearchAvailable — true by default (DDG needs no key)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Isolate the context cache from the real ~/.nuvira store: cache.ts computes its
// CACHE_DIR at module load, so homedir is mocked at hoist time (same pattern
// as eval-framework.test.ts). Without this, the cache-hit tests would write to
// and wipe the user's real ~/.nuvira/cache.json.
const testDirHolder = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs');
  const { join } = require('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { value: mkdtempSync(join(base, 'buff-webresearch-')) };
});

vi.mock('node:os', () => ({
  homedir: () => testDirHolder.value,
  tmpdir: () => process.env.TMPDIR || process.env.TEMP || '/tmp',
}));

import {
  parseDuckDuckGoHtml,
  parseSearxngJson,
  parseBraveJson,
  parseSerperJson,
  parseTavilyJson,
  parseGoogleCseJson,
  searchWeb,
  readWebPage,
  isWebSearchAvailable,
  isAllowedReadUrl,
  resolveSearchProvider,
  availableSearchBackends,
  isBackendAvailable,
} from '../../src/tools/web-research.js';
import { getCache } from '../../src/context/cache.js';

// Every env var a search backend can read (prefixed + plain). Cleared between
// tests so a developer's real keys never change the default-backend result.
const SEARCH_KEY_ENVS = [
  'NUVIRA_BRAVE_SEARCH_API_KEY', 'BUFF_BRAVE_SEARCH_API_KEY', 'BRAVE_SEARCH_API_KEY', 'BRAVE_API_KEY',
  'NUVIRA_SERPER_API_KEY', 'BUFF_SERPER_API_KEY', 'SERPER_API_KEY',
  'NUVIRA_TAVILY_API_KEY', 'BUFF_TAVILY_API_KEY', 'TAVILY_API_KEY',
  'NUVIRA_GOOGLE_CSE_API_KEY', 'BUFF_GOOGLE_CSE_API_KEY', 'GOOGLE_CSE_API_KEY', 'GOOGLE_API_KEY',
  'NUVIRA_GOOGLE_CSE_ID', 'BUFF_GOOGLE_CSE_ID', 'GOOGLE_CSE_ID', 'GOOGLE_CSE_CX',
  'NUVIRA_SEARXNG_URL', 'BUFF_SEARXNG_URL', 'SEARXNG_URL',
];
function clearSearchEnv(): void {
  for (const k of SEARCH_KEY_ENVS) delete process.env[k];
}

const DDG_HTML = `
<html><body>
<div class="result">
  <a class="result__a" href="https://example.com/1">Example <b>One</b> &amp; More</a>
  <a class="result__snippet">First snippet text.</a>
</div>
<div class="result">
  <a class="result__a" href="https://example.com/2">Example Two</a>
  <a class="result__snippet">Second snippet.</a>
</div>
</body></html>
`;

const SEARXNG_JSON = {
  results: [
    { title: 'Alpha', url: 'https://alpha.dev', content: 'Alpha content' },
    { title: 'Beta', url: 'https://beta.dev', content: 'Beta content' },
    { title: '', url: 'https://skip.me' }, // no title → filtered
  ],
};

/** Build a fake Response object with the given text. */
function fakeResponse(body: string, ok = true, contentType = 'text/html'): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    text: async () => body,
    json: async () => JSON.parse(body),
    headers: new Headers({ 'content-type': contentType }),
  } as unknown as Response;
}

describe('web-research — parsing', () => {
  it('parses DuckDuckGo HTML lite results into {title,url,snippet}', () => {
    const results = parseDuckDuckGoHtml(DDG_HTML, 5);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Example One & More'); // tags stripped + entities decoded
    expect(results[0].url).toBe('https://example.com/1');
    expect(results[0].snippet).toBe('First snippet text.');
    expect(results[1].snippet).toBe('Second snippet.');
  });

  it('respects maxResults when parsing DDG HTML', () => {
    const results = parseDuckDuckGoHtml(DDG_HTML, 1);
    expect(results).toHaveLength(1);
  });

  it('decodes DDG redirect URLs (uddg param) to the real target', () => {
    const html =
      '<a class="result__a" href="/l/?kh=-1&uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fa%3D1">Doc</a>';
    const results = parseDuckDuckGoHtml(html, 5);
    expect(results[0].url).toBe('https://example.com/docs?a=1');
  });

  it('drops DDG hits whose redirect target is not http(s)', () => {
    const html = '<a class="result__a" href="/l/?uddg=javascript%3Aalert(1)">Bad</a>';
    expect(parseDuckDuckGoHtml(html, 5)).toHaveLength(0);
  });

  it('maps SearXNG JSON results to the same shape and filters entries without titles', () => {
    const results = parseSearxngJson(SEARXNG_JSON, 5);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ title: 'Alpha', url: 'https://alpha.dev', snippet: 'Alpha content' });
  });
});

describe('web-research — availability', () => {
  it('is available out of the box (DuckDuckGo needs no key)', () => {
    expect(isWebSearchAvailable()).toBe(true);
  });
});

describe('web-research — searchWeb (mocked fetch)', () => {
  const fetchMock = vi.fn();
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    clearSearchEnv();
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    clearSearchEnv();
    vi.restoreAllMocks();
  });

  it('searches DuckDuckGo HTML by default', async () => {
    fetchMock.mockResolvedValue(fakeResponse(DDG_HTML));
    const results = await searchWeb('agent-nuvira', { fetchFn: fetchMock });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('html.duckduckgo.com/html/?q='),
      expect.objectContaining({ headers: expect.anything() }),
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].url).toContain('example.com');
  });

  it('prefers a configured SearXNG endpoint', async () => {
    fetchMock.mockResolvedValue(fakeResponse(JSON.stringify(SEARXNG_JSON)));
    const results = await searchWeb('alpha', {
      searxngUrl: 'http://localhost:8888',
      fetchFn: fetchMock,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('localhost:8888/search?q=alpha&format=json'),
      expect.anything(),
    );
    expect(results[0].title).toBe('Alpha');
  });

  it('returns empty (never throws) on network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const results = await searchWeb('anything', { fetchFn: fetchMock });
    expect(results).toEqual([]);
  });

  it('serves a repeat query from the context cache without a second fetch', async () => {
    fetchMock.mockResolvedValue(fakeResponse(DDG_HTML));
    const first = await searchWeb('cached-query', { fetchFn: fetchMock });
    expect(first.length).toBeGreaterThan(0);
    const callsAfterFirst = fetchMock.mock.calls.length;

    const second = await searchWeb('cached-query', { fetchFn: fetchMock });
    expect(second).toEqual(first);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // no new fetch
    await getCache().clear();
  });
});

describe('web-research — hosted backends (BYOK)', () => {
  const fetchMock = vi.fn();
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    clearSearchEnv();
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    clearSearchEnv();
    vi.restoreAllMocks();
    await getCache().clear();
  });

  it('parses Brave web results', () => {
    const results = parseBraveJson(
      { web: { results: [{ title: 'Brave <b>Hit</b>', url: 'https://b.dev', description: 'a snippet' }, { url: 'https://no-title' }] } },
      5,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ title: 'Brave Hit', url: 'https://b.dev', snippet: 'a snippet' });
  });

  it('parses Serper organic results', () => {
    const results = parseSerperJson({ organic: [{ title: 'S', link: 'https://s.dev', snippet: 'snip' }] }, 5);
    expect(results[0]).toEqual({ title: 'S', url: 'https://s.dev', snippet: 'snip' });
  });

  it('parses Tavily results', () => {
    const results = parseTavilyJson({ results: [{ title: 'T', url: 'https://t.dev', content: 'body' }] }, 5);
    expect(results[0]).toEqual({ title: 'T', url: 'https://t.dev', snippet: 'body' });
  });

  it('parses Google Custom Search items', () => {
    const results = parseGoogleCseJson({ items: [{ title: 'G', link: 'https://g.dev', snippet: 'gs' }] }, 5);
    expect(results[0]).toEqual({ title: 'G', url: 'https://g.dev', snippet: 'gs' });
  });

  it('auto-selects Brave and sends X-Subscription-Token', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'brave-key';
    expect(resolveSearchProvider()).toBe('brave');
    fetchMock.mockResolvedValue(
      fakeResponse(JSON.stringify({ web: { results: [{ title: 'Hit', url: 'https://hit.dev', description: 'd' }] } }), true, 'application/json'),
    );
    const results = await searchWeb('brave-query', { fetchFn: fetchMock });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('api.search.brave.com/res/v1/web/search'),
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Subscription-Token': 'brave-key' }) }),
    );
    expect(results[0].url).toBe('https://hit.dev');
  });

  it('selects Serper / Tavily / Google CSE by their own key', () => {
    process.env.SERPER_API_KEY = 's';
    expect(resolveSearchProvider()).toBe('serper');
    clearSearchEnv();
    process.env.TAVILY_API_KEY = 't';
    expect(resolveSearchProvider()).toBe('tavily');
    clearSearchEnv();
    process.env.GOOGLE_CSE_API_KEY = 'g';
    process.env.GOOGLE_CSE_ID = 'cx';
    expect(resolveSearchProvider()).toBe('google-cse');
  });

  it('Google CSE needs BOTH the key and the engine id', () => {
    process.env.GOOGLE_CSE_API_KEY = 'g';
    expect(isBackendAvailable('google-cse')).toBe(false);
  });

  it('an explicit provider option overrides auto-selection', () => {
    process.env.BRAVE_SEARCH_API_KEY = 'brave-key';
    expect(resolveSearchProvider({ provider: 'duckduckgo' })).toBe('duckduckgo');
    expect(resolveSearchProvider({ provider: 'not-a-backend' })).toBe('brave');
  });

  it('falls back to DuckDuckGo when a keyed backend returns nothing', async () => {
    process.env.SERPER_API_KEY = 's';
    fetchMock
      .mockResolvedValueOnce(fakeResponse(JSON.stringify({ organic: [] }), true, 'application/json'))
      .mockResolvedValueOnce(fakeResponse(DDG_HTML));
    const results = await searchWeb('fallback-q', { fetchFn: fetchMock });
    expect(results.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls[1][0]).toContain('html.duckduckgo.com');
  });

  it('availableSearchBackends lists keyed providers plus the keyless tail', () => {
    process.env.TAVILY_API_KEY = 't';
    const list = availableSearchBackends();
    expect(list).toContain('tavily');
    expect(list).toContain('duckduckgo');
    expect(list).not.toContain('brave');
  });
});

describe('web-research — readWebPage (mocked fetch)', () => {
  const fetchMock = vi.fn();
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('uses Jina Reader when JINA_API_KEY is set', async () => {
    const prev = process.env.JINA_API_KEY;
    process.env.JINA_API_KEY = 'test-key';
    try {
      fetchMock.mockResolvedValue(fakeResponse('# Title\n\nBody text from jina.'));
      const text = await readWebPage('https://docs.example.org/page', { fetchFn: fetchMock });
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('r.jina.ai/https://docs.example.org/page'),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-key' }) }),
      );
      expect(text).toContain('Body text from jina.');
    } finally {
      if (prev === undefined) delete process.env.JINA_API_KEY;
      else process.env.JINA_API_KEY = prev;
      await getCache().clear();
    }
  });

  it('falls back to a plain fetch and strips HTML to text without a key', async () => {
    const prev = process.env.JINA_API_KEY;
    delete process.env.JINA_API_KEY;
    try {
      fetchMock.mockResolvedValue(
        fakeResponse('<html><body><h1>Hello</h1><p>World <b>bold</b> text</p><script>bad()</script></body></html>'),
      );
      const text = await readWebPage('https://plain.example.com', { fetchFn: fetchMock });
      expect(fetchMock).toHaveBeenCalledWith('https://plain.example.com', expect.anything());
      expect(text).toContain('Hello');
      expect(text).toContain('World bold text');
      expect(text).not.toContain('bad()');
    } finally {
      if (prev !== undefined) process.env.JINA_API_KEY = prev;
      await getCache().clear();
    }
  });

  it('returns empty (never throws) on fetch failure', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));
    const text = await readWebPage('https://down.example.com', { fetchFn: fetchMock });
    expect(text).toBe('');
  });

  it('blocks private / link-local / metadata hosts (SSRF guard)', async () => {
    const blocked = [
      'http://169.254.169.254/latest/meta-data',
      'http://127.0.0.1:8000/admin',
      'http://localhost:3000',
      'http://10.0.0.5/secret',
      'http://192.168.1.1/config',
      'http://172.16.0.1/internal',
      'file:///etc/passwd',
      'ftp://example.com/file',
    ];
    for (const url of blocked) {
      expect(isAllowedReadUrl(url), url).toBe(false);
      const out = await readWebPage(url, { fetchFn: fetchMock });
      expect(out).toContain('Blocked by read_page safety guard');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows public http(s) URLs through the guard', () => {
    expect(isAllowedReadUrl('https://example.com/page?q=1')).toBe(true);
    expect(isAllowedReadUrl('http://example.org')).toBe(true);
  });

  it('honors BUFF_WEB_ALLOW_PRIVATE=1 as an explicit escape hatch', async () => {
    const prev = process.env.NUVIRA_WEB_ALLOW_PRIVATE;
    process.env.NUVIRA_WEB_ALLOW_PRIVATE = '1';
    try {
      expect(isAllowedReadUrl('http://localhost:3000')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.NUVIRA_WEB_ALLOW_PRIVATE;
      else process.env.NUVIRA_WEB_ALLOW_PRIVATE = prev;
    }
  });

  it('respects maxChars', async () => {
    fetchMock.mockResolvedValue(fakeResponse('<p>' + 'x'.repeat(5000) + '</p>'));
    const text = await readWebPage('https://long.example.com', { fetchFn: fetchMock, maxChars: 1000 });
    expect(text.length).toBeLessThanOrEqual(1000);
    await getCache().clear();
  });

  it('serves a repeat page from the cache without a second fetch', async () => {
    fetchMock.mockResolvedValue(fakeResponse('<p>stable page body</p>'));
    const first = await readWebPage('https://stable.example.com', { fetchFn: fetchMock });
    expect(first).toContain('stable page body');
    const callsAfterFirst = fetchMock.mock.calls.length;

    const second = await readWebPage('https://stable.example.com', { fetchFn: fetchMock });
    expect(second).toEqual(first);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    await getCache().clear();
  });
});
