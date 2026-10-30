/**
 * `nuvira stats cost bill` — the CLI surface of the live provider figure.
 *
 * Runs the REAL commander tree (so option parsing is the shipped one) against a
 * mocked ConfigManager and an injected HTTP client. What it pins:
 *   - the provider's figure reaches the output, labelled by what it IS;
 *   - the API key never appears in the output;
 *   - a typo'd provider id FAILS LOUDLY (a silent skip reads as "nothing billed");
 *   - a configured provider with no billing API is REPORTED as unsupported, not omitted;
 *   - `--days` reaches the window-scoped endpoints.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { Command } from 'commander';
import { StatsCommand } from '../../src/cli/stats.js';
import { setBillingFetchForTests, type BillingFetch } from '../../src/learning/provider-billing.js';
import type { BuffConfig } from '../../src/config/types.js';

const SECRET = 'sk-live-do-not-print-abcdef';

let stdout: string[];
let calls: string[];

/** A fetch that answers every URL from the given map, recording the URLs. */
function installFetch(routes: Record<string, unknown>): void {
  const fetchImpl: BillingFetch = async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((fragment) => url.includes(fragment));
    if (key === undefined) throw new Error(`unexpected request: ${url}`);
    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  setBillingFetchForTests(fetchImpl);
}

function runStats(argv: string[], providers: Record<string, { apiKey?: string; baseUrl?: string }>): void {
  const cmd = new StatsCommand();
  (cmd as unknown as { configManager: unknown }).configManager = {
    getAll: vi.fn(
      (): BuffConfig =>
        ({
          defaultProvider: 'local',
          providers,
        }) as unknown as BuffConfig,
    ),
    save: vi.fn(),
    attachVault: vi.fn(),
    hydrateVaultRefs: vi.fn(async () => 0),
  };
  const cli = new Command();
  cli.addCommand(cmd.create());
  cli.parse(['node', 'nuvira', 'stats', 'cost', 'bill', ...argv]);
}

const output = (): string => stdout.join('\n');

beforeEach(() => {
  stdout = [];
  calls = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  setBillingFetchForTests(null);
});

describe('stats cost bill', () => {
  it('prints the provider’s own balance, labelled as a balance', async () => {
    installFetch({
      '/user/balance': {
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00' }],
      },
    });
    runStats([], { deepseek: { apiKey: SECRET } });

    await vi.waitFor(() => expect(output()).toContain('Provider Billing'));
    expect(output()).toContain('DeepSeek');
    expect(output()).toContain('balance · snapshot');
    expect(output()).toContain('CNY 110.00');
    expect(output()).toContain('cannot be reconciled');
    expect(output()).not.toContain(SECRET);
  });

  it('emits the same report as JSON on --json', async () => {
    installFetch({ '/api/v1/key': { data: { usage: 12.5, usage_monthly: 2 } } });
    runStats(['--json'], { openrouter: { apiKey: SECRET } });

    await vi.waitFor(() => expect(output()).toContain('"statements"'));
    const parsed = JSON.parse(output()) as {
      statements: Array<{ provider: string; status: string; kind: string; amount?: { amount: number } }>;
    };
    expect(parsed.statements).toHaveLength(1);
    expect(parsed.statements[0]!.provider).toBe('openrouter');
    expect(parsed.statements[0]!.status).toBe('ok');
    expect(parsed.statements[0]!.kind).toBe('spend');
    expect(parsed.statements[0]!.amount?.amount).toBe(12.5);
  });

  it('rejects a typo’d provider id instead of silently asking nobody', async () => {
    runStats(['--provider', 'deepsek'], { deepseek: { apiKey: SECRET } });
    await vi.waitFor(() => expect(output()).toContain('Unknown provider'));
    expect(output()).toContain('deepseek');
    expect(calls).toHaveLength(0);
  });

  it('reports a configured provider with no billing API, with the reason', async () => {
    runStats(['--provider', 'gemini'], { gemini: { apiKey: SECRET } });
    await vi.waitFor(() => expect(output()).toContain('Google Gemini'));
    expect(output()).toContain('Cloud Billing');
    expect(calls).toHaveLength(0);
  });

  it('passes the --days window to a window-scoped report', async () => {
    installFetch({ '/v1/organization/costs': { data: [], has_more: false } });
    runStats(['--provider', 'openai', '--days', '7'], { openai: { apiKey: SECRET } });

    await vi.waitFor(() => expect(output()).toContain('OpenAI'));
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!);
    const start = Number(url.searchParams.get('start_time'));
    const end = Number(url.searchParams.get('end_time'));
    expect(Math.round((end - start) / 86_400)).toBe(7);
    expect(url.searchParams.get('bucket_width')).toBe('1d');
  });

  it('says when a key is missing instead of skipping the provider', async () => {
    runStats(['--provider', 'deepseek'], {});
    await vi.waitFor(() => expect(output()).toContain('no API key is configured'));
    expect(output()).toContain('DeepSeek');
    expect(calls).toHaveLength(0);
  });
});
