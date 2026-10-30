/**
 * Provider billing — asking the provider what IT says, instead of estimating.
 *
 * WHY THIS EXISTS. `cost-tracker.ts` records an ESTIMATE per call (list price ×
 * tokens, or the provider's own per-call cost when it reports one), and
 * `cost-reconcile.ts` can only compare that to a figure the operator typed in by
 * hand. Neither can see the account. The provider can — so this module asks it.
 *
 * WHAT EACH ENDPOINT ACTUALLY RETURNS (verified against the providers' docs on
 * 2026-10-17; do not "improve" one of these without re-checking it):
 *
 *   - deepseek  → GET /user/balance. A BALANCE (`total_balance`, plus granted and
 *     topped-up parts) in the account's own currency (CNY or USD). This is money
 *     LEFT, not money billed: top-ups and grants move it, so it is never a bill
 *     and cannot be reconciled against a window of ledger rows. It is still the
 *     provider's own number, which is exactly what the ledger cannot produce.
 *
 *   - openrouter → GET /api/v1/key. Per-KEY credit usage, all time and bucketed
 *     by UTC day/week/month, plus the key's remaining limit and free-tier flag.
 *     Works with an ordinary inference key. (`/api/v1/credits` gives purchased vs
 *     used across the ACCOUNT, but requires a MANAGEMENT key and answers 403 to
 *     the key that runs inference — so it is not used here.)
 *
 *   - openai    → GET /v1/organization/costs. Organization-wide spend per day.
 *     Requires an ADMIN key (`sk-admin-…`); a normal project key gets 403. The
 *     error path says so rather than reporting "no billing data".
 *
 *   - anthropic → GET /v1/organizations/cost_report. Organization-wide cost per
 *     day. Requires an admin key (`sk-ant-admin…`); a regular key gets 403.
 *
 * EVERYTHING ELSE has no documented balance/usage endpoint reachable with the
 * inference key the user gave us — Gemini bills through Google Cloud Billing (a
 * GCP IAM API), Bedrock through AWS Cost Explorer, Azure through Cost
 * Management, and Groq/Mistral/NIM/xAI publish nothing. Those are reported as
 * unsupported WITH the reason; a missing number is never rendered as $0.
 *
 * THE LABELS ARE THE POINT. Every statement carries `kind` (`spend` | `balance`),
 * `scope` (`window` | `all-time` | `snapshot`) and a `caveat`, because "$12" from
 * a provider can mean four different things and a dashboard that flattens them
 * into "cost" is the defect this module was written to avoid.
 */

import { getCatalogProvider } from '../inference/provider-catalog.js';

/** One day in ms — the unit the CLI's window flag speaks in. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The window used for the window-scoped endpoints when the caller names none. */
export const DEFAULT_BILLING_WINDOW_DAYS = 30;

/** What the number actually is. */
export type StatementKind = 'spend' | 'balance';

/** What slice of time it covers. */
export type StatementScope = 'window' | 'all-time' | 'snapshot';

/** True when the endpoint needs an ORG ADMIN key rather than the inference key. */
export type BillingKeyKind = 'inference' | 'admin';

/** A figure in the provider's own currency — never silently converted to USD. */
export interface Money {
  amount: number;
  /** ISO 4217 code as the provider stated it (`USD`, `CNY`, …). */
  currency: string;
}

export interface ProviderStatement {
  provider: string;
  label: string;
  /** `ok` = the provider answered; `error` = we asked and were refused; `unsupported` = nothing to ask. */
  status: 'ok' | 'error' | 'unsupported';
  kind: StatementKind;
  scope: StatementScope;
  /** The endpoint called, with no key and no query secrets. */
  endpoint?: string;
  since?: number;
  until?: number;
  /** The provider's own figure. Absent when `status !== 'ok'`. */
  amount?: Money;
  /** Other facts the provider volunteered (limits, free tier, granted credit). */
  details: string[];
  /** What this figure is NOT — printed alongside it. */
  caveat?: string;
  /** Why there is no figure. */
  error?: string;
  /** The one thing to change, when the failure is actionable. */
  hint?: string;
  fetchedAt: number;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

/** `$1,234.56` for USD, `CNY 110.00` otherwise — no invented FX conversion. */
export function formatMoney(money: Money): string {
  const formatted = money.amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
  return money.currency.toUpperCase() === 'USD' ? `$${formatted}` : `${money.currency.toUpperCase()} ${formatted}`;
}

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// ─── Parsers (pure, exported so the shapes are pinned by tests) ─────────────

export type ParseResult =
  | { ok: true; amount?: Money; details: string[]; caveat?: string }
  | { ok: false; error: string };

/**
 * DeepSeek `GET /user/balance`:
 * `{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }`
 *
 * USD is preferred when the account holds both currencies; otherwise the first
 * entry is reported as-is. The amount is NEVER converted.
 */
export function parseDeepSeekBalance(body: unknown): ParseResult {
  const root = asRecord(body);
  const infos = asArray(root.balance_infos);
  if (infos.length === 0) {
    return { ok: false, error: 'the response carried no balance_infos — the account reported no balance to show' };
  }
  const entries = infos.map(asRecord).filter((e) => typeof e.currency === 'string');
  const chosen = entries.find((e) => String(e.currency).toUpperCase() === 'USD') ?? entries[0];
  const total = asNumber(chosen?.total_balance);
  if (!chosen || total === null) {
    return { ok: false, error: 'total_balance was missing or not a number' };
  }

  const currency = String(chosen.currency).toUpperCase();
  const details: string[] = [
    `sufficient for API calls: ${root.is_available === true ? 'yes' : root.is_available === false ? 'no' : 'not stated'}`,
  ];
  const granted = asNumber(chosen.granted_balance);
  const toppedUp = asNumber(chosen.topped_up_balance);
  if (granted !== null || toppedUp !== null) {
    const parts: string[] = [];
    if (granted !== null) parts.push(`granted ${formatMoney({ amount: granted, currency })}`);
    if (toppedUp !== null) parts.push(`topped up ${formatMoney({ amount: toppedUp, currency })}`);
    details.push(parts.join(' · '));
  }
  for (const other of entries) {
    if (other === chosen) continue;
    const otherTotal = asNumber(other.total_balance);
    if (otherTotal === null) continue;
    details.push(
      `${String(other.currency).toUpperCase()} balance ${formatMoney({
        amount: otherTotal,
        currency: String(other.currency),
      })}`,
    );
  }

  return {
    ok: true,
    amount: { amount: total, currency },
    details,
    caveat:
      'A balance is what is LEFT on the account, not what was billed in a window — top-ups and grants move it, so it cannot be reconciled against this ledger',
  };
}

/**
 * OpenRouter `GET /api/v1/key`: `{ data: { usage, usage_daily, usage_weekly,
 * usage_monthly, limit_remaining, is_free_tier, ... } }`, where one credit is
 * one US dollar.
 */
export function parseOpenRouterKey(body: unknown): ParseResult {
  const data = asRecord(asRecord(body).data);
  const usage = asNumber(data.usage);
  if (usage === null) {
    return { ok: false, error: 'the response carried no `usage` for this key' };
  }
  const usd = (n: number): string => formatMoney({ amount: n, currency: 'USD' });
  const details: string[] = [];
  const daily = asNumber(data.usage_daily);
  const weekly = asNumber(data.usage_weekly);
  const monthly = asNumber(data.usage_monthly);
  if (daily !== null || weekly !== null || monthly !== null) {
    details.push(
      [
        daily !== null ? `today ${usd(daily)}` : null,
        weekly !== null ? `this week ${usd(weekly)}` : null,
        monthly !== null ? `this month ${usd(monthly)}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    );
  }
  const remaining = asNumber(data.limit_remaining);
  if (remaining !== null) details.push(`key credit limit remaining ${usd(remaining)}`);
  else if (data.limit_remaining === null) details.push('key credit limit remaining: unlimited');
  if (data.is_free_tier === true) details.push('free tier (no credits purchased)');
  // `label` is deliberately NOT printed: an unlabelled OpenRouter key carries an
  // auto-generated label derived from the key itself (measured live: it read
  // `sk-or-v1-879...18e`), and a report about money has no business echoing any
  // part of a credential.

  return {
    ok: true,
    amount: { amount: usage, currency: 'USD' },
    details,
    caveat:
      'Credit usage for THIS key (OpenRouter counts 1 credit = $1), not an invoice — the all-time figure has no window, so reconcile the month-to-date bucket if a window is what you need',
  };
}

/**
 * OpenAI `GET /v1/organization/costs`:
 * `{ data: [{ start_time, end_time, results: [{ amount: { value, currency } }] }], has_more }`
 *
 * Sums every bucket across every page that was fetched. Amounts in more than one
 * currency cannot be added together, so that case is refused rather than
 * silently reporting a mixed-unit total.
 */
export function parseOpenAICosts(body: unknown, opts: { pages?: number } = {}): ParseResult {
  const root = asRecord(body);
  const buckets = asArray(root.data).map(asRecord);
  let sum = 0;
  const currencies = new Set<string>();
  let results = 0;

  for (const bucket of buckets) {
    for (const raw of asArray(bucket.results)) {
      const result = asRecord(raw);
      const amount = asRecord(result.amount);
      const value = asNumber(amount.value);
      if (value === null) continue;
      const currency = String(amount.currency ?? 'USD').toUpperCase();
      currencies.add(currency);
      sum += value;
      results++;
    }
  }

  if (currencies.size > 1) {
    return {
      ok: false,
      error: `the cost report mixes currencies (${[...currencies].sort().join(', ')}) — they cannot be summed without an FX rate this tool will not invent`,
    };
  }
  const currency = [...currencies][0] ?? 'USD';
  const details = [`${buckets.length} daily bucket(s) · ${results} cost line(s)`];
  if (opts.pages && opts.pages > 1) details.push(`fetched across ${opts.pages} page(s)`);

  return {
    ok: true,
    amount: { amount: sum, currency },
    details,
    caveat:
      'An ORGANIZATION-wide figure from OpenAI, not this key — it may include projects and keys this ledger never saw, so reconcile only if this key is the organization’s only spend',
  };
}

/**
 * Anthropic `GET /v1/organizations/cost_report`: `{ data: [{ results: [{ amount:
 * "<decimal USD string>" }] }], has_more, next_page }`. The amount is a STRING
 * of dollars, so it is parsed as money rather than coerced from a token count.
 */
export function parseAnthropicCostReport(body: unknown, opts: { pages?: number } = {}): ParseResult {
  const root = asRecord(body);
  const buckets = asArray(root.data).map(asRecord);
  let sum = 0;
  let results = 0;
  for (const bucket of buckets) {
    for (const raw of asArray(bucket.results)) {
      const value = asNumber(asRecord(raw).amount);
      if (value === null) continue;
      sum += value;
      results++;
    }
  }
  const details = [`${buckets.length} daily bucket(s) · ${results} cost line(s)`];
  if (opts.pages && opts.pages > 1) details.push(`fetched across ${opts.pages} page(s)`);

  return {
    ok: true,
    amount: { amount: sum, currency: 'USD' },
    details,
    caveat:
      'An ORGANIZATION-wide figure from Anthropic, not this key — it may include workspaces this ledger never saw, and the report can lag the invoice',
  };
}

// ─── Which providers can be asked, and how ─────────────────────────────────

interface BillingSource {
  kind: StatementKind;
  scope: StatementScope;
  keyKind: BillingKeyKind;
  /** Short human description of the endpoint, used in the unsupported/error text. */
  api: string;
}

export const BILLING_SOURCES: Record<string, BillingSource> = {
  deepseek: {
    kind: 'balance',
    scope: 'snapshot',
    keyKind: 'inference',
    api: 'GET /user/balance',
  },
  openrouter: {
    kind: 'spend',
    scope: 'all-time',
    keyKind: 'inference',
    api: 'GET /api/v1/key',
  },
  openai: {
    kind: 'spend',
    scope: 'window',
    keyKind: 'admin',
    api: 'GET /v1/organization/costs',
  },
  anthropic: {
    kind: 'spend',
    scope: 'window',
    keyKind: 'admin',
    api: 'GET /v1/organizations/cost_report',
  },
};

/**
 * Why a provider cannot be asked. Kept to the providers people actually
 * configure; the generic reason covers the rest and is never a silent $0.
 */
const NO_BILLING_API: Record<string, string> = {
  gemini:
    'Google reports spend through Cloud Billing (a GCP IAM API), not through an AI Studio API key',
  bedrock:
    'AWS reports spend through Cost Explorer / the Billing API, not through a Bedrock inference key',
  azure:
    'Azure reports spend through Cost Management, not through an Azure OpenAI key',
  nuvira: 'a gateway: the upstream accounts hold the bill, and this endpoint holds no key of its own',
  omniroute: 'a gateway: the upstream accounts hold the bill, and this endpoint holds no key of its own',
  local: 'a local runtime bills nothing — there is no account to ask',
};

const GENERIC_NO_BILLING_API =
  'this provider publishes no balance or usage endpoint for an inference key — its console or invoice is the only source';

/** The human label for a provider id (falls back to the id itself). */
export function providerLabel(provider: string): string {
  return getCatalogProvider(provider)?.label ?? provider;
}

/** True when {@link fetchProviderStatement} knows how to ask this provider. */
export function hasBillingSource(provider: string): boolean {
  return Boolean(BILLING_SOURCES[provider]);
}

/** The reason an unsupported provider is unsupported (exported for the CLI help). */
export function noBillingApiReason(provider: string): string {
  return NO_BILLING_API[provider] ?? GENERIC_NO_BILLING_API;
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

/** The subset of `fetch` this module uses — injectable so tests never call out. */
export type BillingFetch = (url: string, init: RequestInit) => Promise<Response>;

let _fetch: BillingFetch | null = null;

/** Test seam: replace the HTTP client (no network in tests). */
export function setBillingFetchForTests(fetchImpl: BillingFetch | null): void {
  _fetch = fetchImpl;
}

const TIMEOUT_MS = 12_000;

interface HttpResult {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl?: BillingFetch,
): Promise<HttpResult> {
  const doFetch: BillingFetch = fetchImpl ?? _fetch ?? ((u, init) => fetch(u, init));
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: `could not reach the provider: ${message}` };
  }

  let text = '';
  try {
    text = await res.text();
  } catch {
    // A body that cannot be read is reported by status below.
  }
  if (!res.ok) {
    const snippet = text.trim().slice(0, 240);
    return {
      ok: false,
      status: res.status,
      error: `HTTP ${res.status}${snippet ? ` — ${snippet}` : ''}`,
    };
  }
  if (text.trim() === '') return { ok: true, status: res.status, body: {} };
  try {
    return { ok: true, status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      status: res.status,
      error: 'the endpoint answered with something that is not JSON (a proxy or login page?)',
    };
  }
}

/**
 * The auth header. OpenAI-compatible providers take `Authorization: Bearer`;
 * Anthropic takes `x-api-key` and an API version.
 */
function authHeaders(provider: string, apiKey: string): Record<string, string> {
  if (provider === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * The hint shown when the provider refuses the key. This is the actionable part:
 * "403" alone makes a user think their key is broken, when for OpenAI and
 * Anthropic the truth is that a DIFFERENT KIND of key is required.
 */
function refusalHint(provider: string, status: number): string | undefined {
  if (status !== 401 && status !== 403) return undefined;
  switch (provider) {
    case 'openai':
      return 'the Costs API requires an organization ADMIN key (sk-admin-…); a normal project key is refused — create one at platform.openai.com/settings/organization/admin-keys';
    case 'anthropic':
      return 'the Cost Report API requires an admin key (sk-ant-admin…); a regular API key is refused — create one in the Claude Console under Settings → Admin keys';
    case 'openrouter':
      return 'OpenRouter refused this key for its own metadata endpoint — check the key is active at openrouter.ai/settings/keys';
    case 'deepseek':
      return 'DeepSeek refused this key — check DEEPSEEK_API_KEY (or providers.deepseek.apiKey) is the live platform.deepseek.com key';
    default:
      return 'the provider refused the configured key';
  }
}

/** Origin of a configured base URL — the billing endpoints live at the root. */
function originOf(baseUrl: string | undefined, fallback: string): string {
  try {
    return new URL(baseUrl || fallback).origin;
  } catch {
    return fallback;
  }
}

const CATALOG_BASE: Record<string, string> = {
  deepseek: 'https://api.deepseek.com',
  openrouter: 'https://openrouter.ai',
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
};

// ─── Pagination ─────────────────────────────────────────────────────────────

/** Hard cap on pages: a bill is a checkpoint, not a scraping job. */
const MAX_PAGES = 24;

interface PagedBody {
  body: unknown;
  pages: number;
  truncated: boolean;
}

/**
 * Follow `next_page` for the org cost endpoints. A truncated report is REPORTED
 * (`truncated: true`) rather than passed off as the total — an under-counted
 * bill is worse than a refusal, because it looks authoritative.
 */
async function getPaginated(
  url: string,
  headers: Record<string, string>,
  pageParam: 'page',
  fetchImpl?: BillingFetch,
): Promise<PagedBody | { error: string; status: number }> {
  let body: unknown;
  let pages = 0;
  let page: string | undefined;
  for (;;) {
    const target = page ? `${url}${url.includes('?') ? '&' : '?'}${pageParam}=${encodeURIComponent(page)}` : url;
    const res = await getJson(target, headers, fetchImpl);
    if (!res.ok) return { error: res.error ?? 'the request failed', status: res.status };
    pages++;
    const current = asRecord(res.body);
    const previous = asArray(asRecord(body).data);
    body = body === undefined ? res.body : { ...current, data: [...previous, ...asArray(current.data)] };
    const next = current.next_page;
    if (asRecord(res.body).has_more !== true || typeof next !== 'string' || next === '') break;
    if (pages >= MAX_PAGES) return { body, pages, truncated: true };
    page = next;
  }
  return { body, pages, truncated: false };
}

// ─── The fetch ──────────────────────────────────────────────────────────────

export interface FetchStatementOptions {
  provider: string;
  apiKey: string;
  /** The configured base URL (a proxy is honoured by taking its origin). */
  baseUrl?: string;
  /** Window start, epoch ms. Defaults to {@link DEFAULT_BILLING_WINDOW_DAYS} ago. */
  since?: number;
  /** Window end, EXCLUSIVE, epoch ms. Defaults to now. */
  until?: number;
  /** Test seam; overrides {@link setBillingFetchForTests}. */
  fetchImpl?: BillingFetch;
  now?: number;
}

/**
 * Ask ONE provider for its own figure. Never throws: every failure is a
 * statement with `status: 'error'` and a reason, because a dashboard that
 * blanks a provider is indistinguishable from a provider that billed nothing.
 */
export async function fetchProviderStatement(opts: FetchStatementOptions): Promise<ProviderStatement> {
  const provider = opts.provider.trim().toLowerCase();
  const label = providerLabel(provider);
  const source = BILLING_SOURCES[provider];
  const now = opts.now ?? Date.now();
  const base: Pick<ProviderStatement, 'provider' | 'label' | 'fetchedAt'> = { provider, label, fetchedAt: now };

  if (!source) {
    return {
      ...base,
      status: 'unsupported',
      kind: 'spend',
      scope: 'snapshot',
      details: [],
      error: noBillingApiReason(provider),
    };
  }

  if (!opts.apiKey || opts.apiKey.trim() === '') {
    return {
      ...base,
      status: 'error',
      kind: source.kind,
      scope: source.scope,
      details: [],
      error: 'no API key is configured for this provider',
    };
  }

  {
    const until = opts.until ?? now;
    const since = opts.since ?? until - DEFAULT_BILLING_WINDOW_DAYS * DAY_MS;
    const origin = originOf(opts.baseUrl, CATALOG_BASE[provider] ?? '');
    const headers = authHeaders(provider, opts.apiKey);

    const finish = (
      result: ParseResult,
      endpoint: string,
      extra: Partial<ProviderStatement> = {},
    ): ProviderStatement => {
      if (!result.ok) {
        return {
          ...base,
          status: 'error',
          kind: source.kind,
          scope: source.scope,
          endpoint,
          details: [],
          error: result.error,
          ...extra,
        };
      }
      return {
        ...base,
        status: 'ok',
        kind: source.kind,
        scope: source.scope,
        endpoint,
        details: result.details,
        ...(result.caveat ? { caveat: result.caveat } : {}),
        ...(result.amount ? { amount: result.amount } : {}),
        ...extra,
      };
    };

    let endpoint: string;
    let res: HttpResult;

    switch (provider) {
      case 'deepseek': {
        endpoint = `${origin}/user/balance`;
        res = await getJson(endpoint, headers, opts.fetchImpl);
        break;
      }
      case 'openrouter': {
        endpoint = `${origin}/api/v1/key`;
        res = await getJson(endpoint, headers, opts.fetchImpl);
        break;
      }
      case 'openai': {
        const startSec = Math.floor(since / 1000);
        const endSec = Math.max(startSec + 1, Math.floor(until / 1000));
        endpoint =
          `${origin}/v1/organization/costs?start_time=${startSec}&end_time=${endSec}` +
          `&bucket_width=1d&limit=${Math.min(180, Math.max(1, Math.ceil((until - since) / DAY_MS)))}`;
        const paged = await getPaginated(endpoint, headers, 'page', opts.fetchImpl);
        if ('error' in paged) {
          return {
            ...base,
            status: 'error',
            kind: source.kind,
            scope: source.scope,
            endpoint,
            details: [],
            error: paged.error,
            ...(refusalHint(provider, paged.status) ? { hint: refusalHint(provider, paged.status) } : {}),
          };
        }
        const statement = finish(
          parseOpenAICosts(paged.body, { pages: paged.pages }),
          endpoint,
          { since, until },
        );
        if (paged.truncated) {
          statement.details = [
            ...statement.details,
            `⚠️ stopped after ${MAX_PAGES} pages — the figure below is a PARTIAL total`,
          ];
        }
        return statement;
      }
      case 'anthropic': {
        endpoint =
          `${origin}/v1/organizations/cost_report?starting_at=${encodeURIComponent(new Date(since).toISOString())}` +
          `&ending_at=${encodeURIComponent(new Date(until).toISOString())}&bucket_width=1d&limit=31`;
        const paged = await getPaginated(endpoint, headers, 'page', opts.fetchImpl);
        if ('error' in paged) {
          return {
            ...base,
            status: 'error',
            kind: source.kind,
            scope: source.scope,
            endpoint,
            details: [],
            error: paged.error,
            ...(refusalHint(provider, paged.status) ? { hint: refusalHint(provider, paged.status) } : {}),
          };
        }
        const statement = finish(
          parseAnthropicCostReport(paged.body, { pages: paged.pages }),
          endpoint,
          { since, until },
        );
        if (paged.truncated) {
          statement.details = [
            ...statement.details,
            `⚠️ stopped after ${MAX_PAGES} pages — the figure below is a PARTIAL total`,
          ];
        }
        return statement;
      }
      default: {
        // Unreachable: `source` exists and every key above is handled. Kept as an
        // honest refusal rather than a thrown error.
        return {
          ...base,
          status: 'unsupported',
          kind: source.kind,
          scope: source.scope,
          details: [],
          error: `${source.api} is declared but no request is implemented for it`,
        };
      }
    }

    if (!res.ok) {
      return {
        ...base,
        status: 'error',
        kind: source.kind,
        scope: source.scope,
        endpoint,
        details: [],
        error: res.error ?? 'the request failed',
        ...(refusalHint(provider, res.status) ? { hint: refusalHint(provider, res.status) } : {}),
      };
    }

    const parsed = provider === 'deepseek' ? parseDeepSeekBalance(res.body) : parseOpenRouterKey(res.body);
    // A balance and an all-time usage figure have NO window, so `since`/`until`
    // are deliberately not attached — printing a window next to an all-time
    // number is how a reader concludes the number is windowed.
    return finish(parsed, endpoint);
  }
}

// ─── Display ────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<StatementKind, string> = {
  spend: 'spend',
  balance: 'balance',
};

const SCOPE_LABEL: Record<StatementScope, string> = {
  window: 'window',
  'all-time': 'all time',
  snapshot: 'snapshot',
};

/** One statement, as text. Shared by the CLI and any other surface. */
export function formatStatement(statement: ProviderStatement): string {
  const lines: string[] = [];
  const icon = statement.status === 'ok' ? '•' : statement.status === 'error' ? '✖' : '—';
  const heading = `   ${icon} ${statement.label}  (${statement.provider})`;
  lines.push(heading);

  if (statement.status === 'ok') {
    lines.push(
      `      ${KIND_LABEL[statement.kind]} · ${SCOPE_LABEL[statement.scope]}` +
        `${statement.since !== undefined && statement.until !== undefined
          ? ` · ${new Date(statement.since).toISOString()} → ${new Date(statement.until).toISOString()}`
          : ''}`,
    );
    if (statement.amount) lines.push(`      ${formatMoney(statement.amount)}`);
    for (const detail of statement.details) lines.push(`        ${detail}`);
    if (statement.caveat) lines.push(`      ⚠️  ${statement.caveat}`);
  } else {
    lines.push(`      ${statement.error ?? 'no figure available'}`);
    if (statement.hint) lines.push(`        hint: ${statement.hint}`);
  }

  if (statement.endpoint) lines.push(`      ${statement.endpoint}`);
  return lines.join('\n');
}

/** The whole set, as text — headline, one block per provider, and the next step. */
export function formatStatements(statements: readonly ProviderStatement[], now = Date.now()): string {
  const lines: string[] = [
    '💳 Provider Billing — what the providers themselves report',
    '',
  ];
  if (statements.length === 0) {
    lines.push('   Nothing to ask: no provider with a key and a billing endpoint is configured.');
    lines.push('   Set a key for deepseek, openrouter, openai or anthropic, then run this again.');
    lines.push('');
    return lines.join('\n');
  }

  for (const statement of statements) {
    lines.push(formatStatement(statement), '');
  }

  const ok = statements.filter((s) => s.status === 'ok').length;
  const errored = statements.filter((s) => s.status === 'error').length;
  const unsupported = statements.filter((s) => s.status === 'unsupported').length;
  lines.push(
    `   ${statements.length} provider(s) · ${ok} reported a figure · ${errored} could not · ${unsupported} have no billing API`,
  );
  lines.push(`   Ask time: ${new Date(now).toISOString()}`);
  if (ok > 0) {
    lines.push('');
    lines.push('   A provider figure is the provider’s own number, not this ledger’s estimate. To');
    lines.push('   compare one against the ledger (same window, same provider):');
    lines.push('     nuvira stats cost reconcile --provider <id> --amount <usd> --days 30');
    lines.push('   A balance cannot be reconciled — it is what is left, not what was charged.');
  }
  lines.push('');
  return lines.join('\n');
}
