/**
 * Provider billing: every figure here is the PROVIDER's, and every failure is a
 * stated reason rather than a zero.
 *
 * These pin the four documented response shapes (DeepSeek `/user/balance`,
 * OpenRouter `/api/v1/key`, OpenAI `/v1/organization/costs`, Anthropic
 * `/v1/organizations/cost_report`), the currency rule (never add mixed units,
 * never convert CNY to USD), and the two refusals that matter in practice: an
 * org-admin-only endpoint answering 403, and a provider with no billing API at
 * all. The HTTP client is injected, so nothing here reaches a provider.
 */

import { describe, it, expect, afterEach } from 'vitest';

import {
  fetchProviderStatement,
  formatStatements,
  hasBillingSource,
  noBillingApiReason,
  parseAnthropicCostReport,
  parseDeepSeekBalance,
  parseOpenAICosts,
  parseOpenRouterKey,
  setBillingFetchForTests,
  type BillingFetch,
} from '../../src/learning/provider-billing.js';

const SECRET = 'sk-live-do-not-print-1234567890';

/** A fetch that records every call and answers with the given JSON. */
function fakeFetch(
  body: unknown,
  status = 200,
): { fetch: BillingFetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: BillingFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetchImpl, calls };
}

afterEach(() => setBillingFetchForTests(null));

describe('parseDeepSeekBalance', () => {
  it('reports a balance in the account currency, with its parts', () => {
    const result = parseDeepSeekBalance({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.amount).toEqual({ amount: 110, currency: 'CNY' });
    expect(result.details.join(' ')).toContain('sufficient for API calls: yes');
    expect(result.details.join(' ')).toContain('granted CNY 10.00');
    expect(result.details.join(' ')).toContain('topped up CNY 100.00');
    // The point of the caveat: a balance is not a bill.
    expect(result.caveat).toContain('not what was billed');
  });

  it('prefers the USD balance when the account holds both, and never converts', () => {
    const result = parseDeepSeekBalance({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '700.00' },
        { currency: 'USD', total_balance: '100.00' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.amount).toEqual({ amount: 100, currency: 'USD' });
    // The other currency appears as a FACT, not as an invented USD total.
    expect(result.details.join(' ')).toContain('CNY balance CNY 700.00');
  });

  it('refuses an empty balance list instead of reporting $0', () => {
    const result = parseDeepSeekBalance({ is_available: true, balance_infos: [] });
    expect(result.ok).toBe(false);
  });
});

describe('parseOpenRouterKey', () => {
  it('reads per-key credit usage and the window buckets', () => {
    const result = parseOpenRouterKey({
      data: {
        label: 'nuvira laptop',
        usage: 25.75,
        usage_daily: 0.1,
        usage_weekly: 1.2,
        usage_monthly: 4.4,
        limit_remaining: 74.25,
        is_free_tier: false,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.amount).toEqual({ amount: 25.75, currency: 'USD' });
    const details = result.details.join(' ');
    expect(details).toContain('today $0.10');
    expect(details).toContain('this month $4.40');
    expect(details).toContain('key credit limit remaining $74.25');
    // An unlabelled key's auto-label is a key fragment — never echoed.
    expect(details).not.toContain('nuvira laptop');
    expect(result.caveat).toContain('not an invoice');
  });

  it('says a null limit is unlimited rather than zero', () => {
    const result = parseOpenRouterKey({ data: { usage: 1, limit_remaining: null } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.details.join(' ')).toContain('unlimited');
  });

  it('refuses a body with no usage figure', () => {
    expect(parseOpenRouterKey({ data: {} }).ok).toBe(false);
  });
});

describe('parseOpenAICosts', () => {
  it('sums every bucket and reports the currency it saw', () => {
    const result = parseOpenAICosts({
      data: [
        {
          start_time: 1,
          end_time: 2,
          results: [{ amount: { value: 1.25, currency: 'usd' } }],
        },
        {
          start_time: 2,
          end_time: 3,
          results: [
            { amount: { value: 0.75, currency: 'usd' } },
            { amount: { value: 0.5, currency: 'usd' } },
          ],
        },
      ],
      has_more: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.amount).toEqual({ amount: 2.5, currency: 'USD' });
    expect(result.details.join(' ')).toContain('2 daily bucket(s)');
    expect(result.details.join(' ')).toContain('3 cost line(s)');
  });

  it('refuses to add mixed currencies', () => {
    const result = parseOpenAICosts({
      data: [
        { results: [{ amount: { value: 1, currency: 'usd' } }] },
        { results: [{ amount: { value: 1, currency: 'eur' } }] },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('mixes currencies');
  });
});

describe('parseAnthropicCostReport', () => {
  it('sums the decimal-string amounts as money', () => {
    const result = parseAnthropicCostReport({
      data: [
        {
          starting_at: '2026-10-01T00:00:00Z',
          ending_at: '2026-10-02T00:00:00Z',
          results: [{ amount: '1.50' }, { amount: '0.25' }],
        },
        {
          starting_at: '2026-10-02T00:00:00Z',
          ending_at: '2026-10-03T00:00:00Z',
          results: [{ amount: '0.75' }],
        },
      ],
      has_more: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.amount).toEqual({ amount: 2.5, currency: 'USD' });
    expect(result.details.join(' ')).toContain('3 cost line(s)');
  });
});

describe('fetchProviderStatement', () => {
  it('asks DeepSeek at the origin of the configured base URL and sends the key', async () => {
    const { fetch, calls } = fakeFetch({
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '42.50' }],
    });
    const statement = await fetchProviderStatement({
      provider: 'deepseek',
      apiKey: SECRET,
      // A configured proxy/v1 base URL must not turn into /v1/user/balance.
      baseUrl: 'https://api.deepseek.com/v1',
      fetchImpl: fetch,
      now: 1_760_000_000_000,
    });
    expect(statement.status).toBe('ok');
    expect(statement.kind).toBe('balance');
    expect(statement.scope).toBe('snapshot');
    expect(statement.amount).toEqual({ amount: 42.5, currency: 'USD' });
    expect(statement.endpoint).toBe('https://api.deepseek.com/user/balance');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.deepseek.com/user/balance');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    // A snapshot has no window to print.
    expect(statement.since).toBeUndefined();
  });

  it('names the org-admin requirement when OpenAI refuses a project key', async () => {
    const { fetch } = fakeFetch({ error: { message: 'You have insufficient permissions' } }, 403);
    const statement = await fetchProviderStatement({
      provider: 'openai',
      apiKey: SECRET,
      fetchImpl: fetch,
    });
    expect(statement.status).toBe('error');
    expect(statement.kind).toBe('spend');
    expect(statement.scope).toBe('window');
    expect(statement.error).toContain('HTTP 403');
    expect(statement.hint).toContain('ADMIN key');
    expect(statement.hint).toContain('sk-admin');
  });

  it('never prints the API key, even when the provider echoes the request', async () => {
    const { fetch } = fakeFetch({ error: { message: 'invalid key' } }, 401);
    const statement = await fetchProviderStatement({
      provider: 'anthropic',
      apiKey: SECRET,
      fetchImpl: fetch,
    });
    expect(JSON.stringify(statement)).not.toContain(SECRET);
    expect(statement.hint).toContain('admin key');
  });

  it('follows next_page so a multi-page cost report is not under-counted', async () => {
    const bodies = [
      {
        data: [{ results: [{ amount: { value: 1, currency: 'usd' } }] }],
        has_more: true,
        next_page: 'page_2',
      },
      {
        data: [{ results: [{ amount: { value: 2, currency: 'usd' } }] }],
        has_more: false,
      },
    ];
    const urls: string[] = [];
    const fetchImpl: BillingFetch = async (url) => {
      urls.push(url);
      return new Response(JSON.stringify(bodies[urls.length - 1]), { status: 200 });
    };
    const statement = await fetchProviderStatement({
      provider: 'openai',
      apiKey: SECRET,
      fetchImpl,
      now: 1_760_000_000_000,
      since: 1_760_000_000_000 - 2 * 24 * 60 * 60 * 1000,
    });
    expect(statement.status).toBe('ok');
    expect(statement.amount).toEqual({ amount: 3, currency: 'USD' });
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('page=page_2');
    expect(statement.details.join(' ')).toContain('2 page(s)');
    expect(statement.since).toBeDefined();
    expect(statement.until).toBeDefined();
  });

  it('reports a network failure as a statement, not a thrown error', async () => {
    const statement = await fetchProviderStatement({
      provider: 'deepseek',
      apiKey: SECRET,
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.deepseek.com');
      },
    });
    expect(statement.status).toBe('error');
    expect(statement.error).toContain('could not reach the provider');
  });

  it('reports a provider with no billing API as unsupported, with the reason', async () => {
    const statement = await fetchProviderStatement({
      provider: 'gemini',
      apiKey: SECRET,
      fetchImpl: async () => {
        throw new Error('must not be called');
      },
    });
    expect(statement.status).toBe('unsupported');
    expect(statement.error).toContain('Cloud Billing');
    expect(hasBillingSource('gemini')).toBe(false);
    expect(noBillingApiReason('groq')).toContain('no balance or usage endpoint');
  });

  it('refuses an empty key before it calls out', async () => {
    let called = false;
    const statement = await fetchProviderStatement({
      provider: 'openrouter',
      apiKey: '   ',
      fetchImpl: async () => {
        called = true;
        return new Response('{}');
      },
    });
    expect(statement.status).toBe('error');
    expect(statement.error).toContain('no API key');
    expect(called).toBe(false);
  });
});

describe('formatStatements', () => {
  it('labels a balance as a balance and prints the next step', async () => {
    const { fetch } = fakeFetch({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '110.00' }],
    });
    const statement = await fetchProviderStatement({
      provider: 'deepseek',
      apiKey: SECRET,
      fetchImpl: fetch,
    });
    const text = formatStatements([statement]);
    expect(text).toContain('Provider Billing');
    expect(text).toContain('balance · snapshot');
    expect(text).toContain('CNY 110.00');
    expect(text).toContain('A balance cannot be reconciled');
    expect(text).toContain('nuvira stats cost reconcile');
  });
});
