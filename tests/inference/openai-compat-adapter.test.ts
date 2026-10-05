/**
 * The generic OpenAI-compatible adapter's availability probe.
 *
 * A keyless provider (a local runner, or a gateway such as OmniRoute) can be
 * serving chat while gating `/v1/models` behind a 401. Treating that 401 as
 * "down" made every eval/parity run refuse a server that demonstrably works, so
 * a keyless provider counts a 401/403 as reachable — while a provider WITH a
 * configured key still reads a 401 as a bad key.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderFactory } from '../../src/inference/factory.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const response = (status: number, body: unknown = {}): { ok: boolean; status: number; headers: Headers; json: () => Promise<unknown> } => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: async () => body,
});

describe('OpenAICompatAdapter.isAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelRegistry();
  });

  it('is available on a 200 models list', async () => {
    mockFetch.mockResolvedValueOnce(response(200, { data: [{ id: 'm' }] }));
    const provider = ProviderFactory.createProvider('omniroute', { model: 'auto/smart' } as never);
    expect(await provider.isAvailable()).toBe(true);
  });

  it('treats a 401 on a KEYLESS provider as reachable (server up, enumeration gated)', async () => {
    mockFetch.mockResolvedValueOnce(response(401, { error: { message: 'Authentication required' } }));
    const provider = ProviderFactory.createProvider('omniroute', { model: 'auto/smart' } as never);
    expect(await provider.isAvailable()).toBe(true);
  });

  it('treats a 401 on a KEYED provider as unavailable (a 401 there is a bad key)', async () => {
    mockFetch.mockResolvedValueOnce(response(401, { error: { message: 'Unauthorized' } }));
    const provider = ProviderFactory.createProvider('deepseek', { apiKey: 'sk-test', model: 'deepseek-flash' } as never);
    expect(await provider.isAvailable()).toBe(false);
  });

  it('is unavailable when the request throws (connection refused)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const provider = ProviderFactory.createProvider('omniroute', { model: 'auto/smart' } as never);
    expect(await provider.isAvailable()).toBe(false);
  });
});
