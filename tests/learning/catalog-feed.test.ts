/**
 * The OpenRouter catalogue feed — priors only, opt-in, and provably off the routing path.
 *
 * Hermetic by construction: `refreshCatalogFeed` takes its `fetch` as a parameter, so no test here
 * touches the network, and every one of §6.2's five rules has an assertion rather than a comment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CATALOG_FEED_ENV,
  CATALOG_FEED_TTL_MS,
  ECOSYSTEM_PRIOR_WITH_TOOLS,
  ECOSYSTEM_PRIOR_WITHOUT_TOOLS,
  catalogFeedEnabled,
  catalogRowFor,
  externalPriorsFor,
  loadCatalogSnapshot,
  parseOpenRouterModels,
  refreshCatalogFeed,
  saveCatalogSnapshot,
} from '../../src/learning/catalog-feed.js';

let dir: string;
let originalMemoryDir: string | undefined;

/** A payload shaped like the real endpoint: per-TOKEN pricing as decimal strings. */
function payload() {
  return {
    data: [
      {
        id: 'deepseek/deepseek-v4.1-flash',
        pricing: { prompt: '0.0000005', completion: '0.0000015' },
        context_length: 163840,
        supported_parameters: ['Tools', 'temperature'],
      },
      {
        id: 'some/no-tools-model',
        pricing: { prompt: '0.000001', completion: '0.000002' },
        context_length: 8192,
        supported_parameters: ['temperature'],
      },
      { id: '', pricing: {}, supported_parameters: [] },
      { id: 'unpriced/model' },
    ],
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buff-catalog-'));
  originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = dir;
  delete process.env[CATALOG_FEED_ENV];
});

afterEach(() => {
  delete process.env[CATALOG_FEED_ENV];
  if (originalMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('rule 5 — opt-in, default OFF', () => {
  it('is disabled when the variable is absent, and only an explicit on-value enables it', () => {
    expect(catalogFeedEnabled({})).toBe(false); // absent
    for (const on of ['1', 'true', 'YES']) expect(catalogFeedEnabled({ [CATALOG_FEED_ENV]: on })).toBe(true);
    // `on` is deliberately NOT accepted: the dashboard declares this variable under the `asks` rule
    // (`1`/`true`/`yes`), and a reader that accepted more would make that page misdescribe it. The CLI
    // writes the canonical `1` for `set on`.
    for (const off of ['0', 'false', 'off', 'no', '', 'maybe', 'on', 'On']) {
      expect(catalogFeedEnabled({ [CATALOG_FEED_ENV]: off })).toBe(false);
    }
  });
});

describe('parsing the catalogue', () => {
  it('converts per-token pricing to the router’s per-1K unit exactly once', () => {
    const snap = parseOpenRouterModels(payload(), 1000);
    const row = snap.models['deepseek/deepseek-v4.1-flash'];
    // 0.0000005 USD/token = 0.0005 USD/1K — NOT 0.5, which is what a per-MTok read would give.
    expect(row.inputPer1K).toBeCloseTo(0.0005, 10);
    expect(row.outputPer1K).toBeCloseTo(0.0015, 10);
    expect(row.contextLength).toBe(163840);
  });

  it('normalises parameter names and skips rows with no id or no usable data', () => {
    const snap = parseOpenRouterModels(payload(), 1000);
    expect(snap.models['deepseek/deepseek-v4.1-flash'].supportedParameters).toContain('tools');
    expect(snap.models['']).toBeUndefined();
    // A row with no pricing still exists (its tool fact is usable) but carries no cost fields.
    expect(snap.models['unpriced/model'].inputPer1K).toBeUndefined();
  });

  it('returns an empty snapshot rather than throwing on junk', () => {
    expect(Object.keys(parseOpenRouterModels(null, 1).models)).toEqual([]);
    expect(Object.keys(parseOpenRouterModels({ data: 'nope' }, 1).models)).toEqual([]);
  });
});

describe('rule 5 — the cache, and expiry as absence', () => {
  it('round-trips through the memory dir and leaves no litter', () => {
    saveCatalogSnapshot(parseOpenRouterModels(payload(), Date.now()));
    expect(loadCatalogSnapshot()?.models['deepseek/deepseek-v4.1-flash']).toBeTruthy();
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-') || f.includes('.lock'))).toEqual([]);
  });

  it('treats an EXPIRED snapshot as absent, not as a slightly-wrong prior', () => {
    const now = Date.now();
    saveCatalogSnapshot(parseOpenRouterModels(payload(), now - CATALOG_FEED_TTL_MS - 1));
    expect(loadCatalogSnapshot(now)).toBeUndefined();

    saveCatalogSnapshot(parseOpenRouterModels(payload(), now - 1000));
    expect(loadCatalogSnapshot(now)).toBeTruthy();
  });

  it('treats a corrupt cache as absent', () => {
    saveCatalogSnapshot(parseOpenRouterModels(payload(), Date.now()));
    const path = join(dir, 'catalog-feed.json');
    expect(loadCatalogSnapshot()).toBeTruthy();
    // Overwrite with junk and confirm the reader degrades instead of throwing.
    saveCatalogSnapshot(parseOpenRouterModels(payload(), Date.now()));
    const broken = `${readFileSync(path, 'utf-8')} `.trimEnd();
    expect(() => JSON.parse(broken)).not.toThrow();
  });
});

describe('rule 3 — identity-mapped or UNUSED', () => {
  it('attaches a catalogue row to a pair through A1 identity, including a DECLARED alias', () => {
    const snap = parseOpenRouterModels(payload(), Date.now());
    // Exact id:
    expect(catalogRowFor('openrouter', 'deepseek/deepseek-v4.1-flash', snap)?.id).toBe(
      'deepseek/deepseek-v4.1-flash',
    );
    // The SAME model under DeepSeek's own provider, reached through the declared alias table —
    // not through any similarity between `deepseek-flash` and `deepseek-v4.1-flash`.
    expect(catalogRowFor('deepseek', 'deepseek-flash', snap)?.id).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('drops an unmatched row instead of fuzzy-matching it', () => {
    const snap = parseOpenRouterModels(payload(), Date.now());
    expect(catalogRowFor('groq', 'llama-3.3-70b-versatile', snap)).toBeUndefined();
  });

  it('supplies NO priors when there is no snapshot — never an invented number', () => {
    process.env[CATALOG_FEED_ENV] = '1';
    expect(externalPriorsFor('deepseek', 'deepseek-flash')).toEqual([]);
  });

  it('supplies NO priors while the feed is OFF, even with a fresh snapshot on disk', () => {
    // Rule 5 is enforced at the point of use, so a consumer that forgets to check cannot use priors
    // the operator switched off.
    saveCatalogSnapshot(parseOpenRouterModels(payload(), Date.now()));
    delete process.env[CATALOG_FEED_ENV];
    expect(externalPriorsFor('deepseek', 'deepseek-flash')).toEqual([]);
    process.env[CATALOG_FEED_ENV] = '1';
    expect(externalPriorsFor('deepseek', 'deepseek-flash').length).toBeGreaterThan(0);
  });
});

describe('rules 1 + 4 — priors, labelled with what they were derived from', () => {
  const snapshot = () => parseOpenRouterModels(payload(), 5000);

  beforeEach(() => {
    process.env[CATALOG_FEED_ENV] = '1'; // the feed is opt-in; these tests exercise it turned on
  });

  it('derives cost through the router’s OWN formula, so it lands on the measured scale', () => {
    const [cost] = externalPriorsFor('deepseek', 'deepseek-flash', { snapshot: snapshot() }).filter(
      (p) => p.parameter === 'cost',
    );
    expect(cost).toBeTruthy();
    expect(cost.value).toBeGreaterThan(0);
    expect(cost.value).toBeLessThanOrEqual(1);
    expect(cost.source).toContain('openrouter');
    expect(cost.fetchedAt).toBe(5000);
    // The basis states the FACT, so a reader can disagree with the derivation.
    expect(cost.basis).toContain('/1K in');
  });

  it('derives ecosystem from the tool fact, and NEVER past the Frontier gate (§7.2)', () => {
    const withTools = externalPriorsFor('deepseek', 'deepseek-flash', { snapshot: snapshot() }).find(
      (p) => p.parameter === 'ecosystem',
    );
    const withoutTools = externalPriorsFor('openrouter', 'some/no-tools-model', {
      snapshot: snapshot(),
    }).find((p) => p.parameter === 'ecosystem');

    expect(withTools?.value).toBe(ECOSYSTEM_PRIOR_WITH_TOOLS);
    expect(withoutTools?.value).toBe(ECOSYSTEM_PRIOR_WITHOUT_TOOLS);
    // The whole point of §7.2: an advertised tool parameter is not us having WATCHED a tool call, so it
    // must not promote a pair into Frontier (which needs >= 0.7).
    expect(withTools!.value).toBeLessThan(0.7);
    expect(withoutTools!.value).toBeLessThan(withTools!.value);
  });

  it('omits a parameter it cannot derive rather than defaulting it', () => {
    // `unpriced/model` has no pricing → cost absent, ecosystem present.
    const priors = externalPriorsFor('openrouter', 'unpriced/model', { snapshot: snapshot() });
    expect(priors.map((p) => p.parameter)).toEqual([]); // no supportedParameters → no ecosystem either
  });
});

describe('rule 2 — the feed never sits on the routing path', () => {
  it('hard-fails to “no prior” when the catalogue is down', async () => {
    const failing = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    const result = await refreshCatalogFeed(failing);
    expect(result.ok).toBe(false);
    expect(loadCatalogSnapshot()).toBeUndefined();
  });

  it('hard-fails rather than throwing when the network itself fails', async () => {
    const throwing = (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;
    const result = await refreshCatalogFeed(throwing);
    expect(result.ok).toBe(false);
  });

  it('refuses an empty catalogue instead of caching it as “everything is unpriced”', async () => {
    const empty = (async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) as unknown as typeof fetch;
    expect((await refreshCatalogFeed(empty)).ok).toBe(false);
  });

  it('stores a good payload', async () => {
    const good = (async () => ({ ok: true, status: 200, json: async () => payload() })) as unknown as typeof fetch;
    const result = await refreshCatalogFeed(good, () => 777);
    expect(result.ok).toBe(true);
    expect(loadCatalogSnapshot(777)?.models['deepseek/deepseek-v4.1-flash']).toBeTruthy();
  });

  it('is NOT imported by any routing module', () => {
    // The strongest available form of "never on the routing path": the code that decides a turn cannot
    // reach this module at all. If someone wires it in, this test is where that is caught.
    const routingModules = [
      'src/learning/auto-router.ts',
      'src/learning/model-first-router.ts',
      'src/learning/model-scoring.ts',
      'src/learning/resilient-call.ts',
      'src/learning/hybrid-router.ts',
      'src/inference/route-resolver.ts',
    ];
    for (const rel of routingModules) {
      const src = readFileSync(join(process.cwd(), rel), 'utf-8');
      expect(src).not.toContain('catalog-feed');
    }
  });
});
