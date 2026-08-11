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

// Isolate the context cache from the real ~/.buff store: cache.ts computes its
// CACHE_DIR at module load, so homedir is mocked at hoist time (same pattern
// as eval-framework.test.ts). Without this, the cache-hit tests would write to
// and wipe the user's real ~/.buff/cache.json.
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
  searchWeb,
  readWebPage,
  isWebSearchAvailable,
  isAllowedReadUrl,
} from '../../src/tools/web-research.js';
import { getCache } from '../../src/context/cache.js';

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
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
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
    const prev = process.env.BUFF_WEB_ALLOW_PRIVATE;
    process.env.BUFF_WEB_ALLOW_PRIVATE = '1';
    try {
      expect(isAllowedReadUrl('http://localhost:3000')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.BUFF_WEB_ALLOW_PRIVATE;
      else process.env.BUFF_WEB_ALLOW_PRIVATE = prev;
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
