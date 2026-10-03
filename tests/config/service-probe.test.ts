/**
 * Service reachability probes — the logic behind the dashboard's per-service
 * "Test connection" button. Fetch is injected so no network is touched.
 */

import { describe, it, expect } from 'vitest';
import { probeService } from '../../src/config/service-probe.js';
import { getServiceDefinition } from '../../src/config/service-catalog.js';

function res(status: number): Response {
  return new Response('{}', { status });
}

const gemini = getServiceDefinition('image-gemini')!;
const pollinations = getServiceDefinition('image-pollinations')!;
const comfyui = getServiceDefinition('image-comfyui')!;
const brave = getServiceDefinition('search-brave')!;

describe('probeService', () => {
  it('reports a keyless backend as available without any fetch', async () => {
    let called = false;
    const fetchFn = (async () => { called = true; return res(200); }) as unknown as typeof fetch;
    const out = await probeService(pollinations, {}, fetchFn);
    expect(out.ok).toBe(true);
    expect(called).toBe(false);
  });

  it('classifies a 2xx as reachable', async () => {
    const fetchFn = (async () => res(200)) as unknown as typeof fetch;
    const out = await probeService(gemini, { GEMINI_API_KEY: 'k' }, fetchFn);
    expect(out.ok).toBe(true);
    expect(out.detail).toContain('200');
  });

  it('classifies 401/403 as a rejected key', async () => {
    for (const status of [401, 403]) {
      const fetchFn = (async () => res(status)) as unknown as typeof fetch;
      const out = await probeService(brave, { BRAVE_SEARCH_API_KEY: 'bad' }, fetchFn);
      expect(out.ok).toBe(false);
      expect(out.detail).toContain('Key rejected');
    }
  });

  it('treats a local endpoint 4xx as reachable (it answered)', async () => {
    const fetchFn = (async () => res(405)) as unknown as typeof fetch;
    const out = await probeService(comfyui, { BUFF_IMAGE_API_URL: 'http://127.0.0.1:8188' }, fetchFn);
    expect(out.ok).toBe(true);
  });

  it('reports a network failure instead of throwing', async () => {
    const fetchFn = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const out = await probeService(gemini, { GEMINI_API_KEY: 'k' }, fetchFn);
    expect(out.ok).toBe(false);
    expect(out.detail).toContain('Connection failed');
  });

  it('sends the Google CSE probe with both key and engine id', async () => {
    let url = '';
    const fetchFn = (async (u: string) => { url = String(u); return res(200); }) as unknown as typeof fetch;
    const out = await probeService(getServiceDefinition('search-google-cse')!, { GOOGLE_CSE_API_KEY: 'k', GOOGLE_CSE_ID: 'cx' }, fetchFn);
    expect(out.ok).toBe(true);
    expect(url).toContain('key=k');
    expect(url).toContain('cx=cx');
  });
});
