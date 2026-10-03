/**
 * Service-provider catalog tests.
 *
 * The dashboard's Service Provider API Key Configuration section is honest only
 * if every env var it offers is the one the tool path actually reads. These
 * tests tie the catalog back to the image-generation and web-search registries,
 * so adding a backend (or renaming an env var) in the tool layer without
 * updating the catalog fails here instead of shipping a dead config field.
 */

import { describe, it, expect } from 'vitest';
import {
  SERVICE_CATALOG,
  SERVICE_CAPABILITY_ORDER,
  SERVICE_ENV_VARS,
  getServiceDefinition,
  servicesByCapability,
} from '../../src/config/service-catalog.js';
import { IMAGE_PROVIDERS } from '../../src/tools/modality/image-providers.js';
import { SEARCH_BACKENDS, resolveSearchProvider } from '../../src/tools/web-research.js';

describe('service catalog', () => {
  it('has unique ids and non-empty metadata', () => {
    const ids = SERVICE_CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SERVICE_CATALOG) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
      expect(SERVICE_CAPABILITY_ORDER).toContain(s.capability);
    }
  });

  it('groups by capability in render order and drops empty groups', () => {
    const groups = servicesByCapability();
    const caps = groups.map((g) => g.capability);
    // Order preserved relative to CAPABILITY_ORDER.
    expect(caps).toEqual([...SERVICE_CAPABILITY_ORDER].filter((c) => caps.includes(c)));
    const total = groups.reduce((n, g) => n + g.services.length, 0);
    expect(total).toBe(SERVICE_CATALOG.length);
  });

  it('getServiceDefinition resolves known ids and rejects unknown', () => {
    expect(getServiceDefinition('image-gemini')?.capability).toBe('image');
    expect(getServiceDefinition('nope')).toBeUndefined();
  });

  it('offers every image backend env var the image tool reads', () => {
    const catalogVars = new Set(
      SERVICE_CATALOG.filter((s) => s.capability === 'image').flatMap((s) => s.envVars.map((v) => v.varName)),
    );
    for (const provider of Object.values(IMAGE_PROVIDERS)) {
      for (const envVar of provider.keyEnvVars) {
        // The catalog lists the primary var; the tool also accepts GOOGLE_API_KEY
        // as an alias for Gemini, which the shared blocklist still covers.
        if (envVar === 'GOOGLE_API_KEY') continue;
        expect(catalogVars.has(envVar), `${provider.id} reads ${envVar}`).toBe(true);
      }
    }
    // The local endpoint the ComfyUI backend reads.
    expect(catalogVars.has('BUFF_IMAGE_API_URL')).toBe(true);
  });

  it('offers every search backend env var the search tool reads', () => {
    const catalogVars = SERVICE_ENV_VARS;
    for (const backend of Object.values(SEARCH_BACKENDS)) {
      for (const envVar of [...backend.keyEnvVars, ...(backend.extraEnvVars ?? [])]) {
        if (envVar === 'GOOGLE_API_KEY' || envVar === 'BRAVE_API_KEY' || envVar === 'GOOGLE_CSE_CX') continue; // aliases
        expect(catalogVars.has(envVar), `${backend.id} reads ${envVar}`).toBe(true);
      }
    }
    // Page reading is part of the search group.
    expect(catalogVars.has('JINA_API_KEY')).toBe(true);
  });

  it('keyless backends are always selectable (fallback never breaks)', () => {
    // The image + search tools must have a keyless fallback, and the catalog
    // must show it as ready with nothing configured.
    const ddg = getServiceDefinition('search-duckduckgo')!;
    expect(ddg.keyless).toBe(true);
    expect(ddg.envVars).toHaveLength(0);
    const poll = getServiceDefinition('image-pollinations')!;
    expect(poll.keyless).toBe(true);
    // resolveSearchProvider with no keys must still return a backend.
    expect(resolveSearchProvider({})).toBeTruthy();
  });
});
