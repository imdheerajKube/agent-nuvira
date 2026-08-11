import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FactStore,
  getFactStore,
  resetFactStore,
  FACT_TTL_MS,
} from '../../src/memory/fact-store.js';
import { getVectorStore, resetVectorBackendSelection } from '../../src/memory/vector-store.js';
import { clearEmbeddingCache, setForceLLM, EMBEDDING_DIM } from '../../src/memory/embedder.js';

// ─── Hermetic memory dir ────────────────────────────────────────────────────

let memDir: string;
const ORIGINAL_MEMORY_DIR = process.env.BUFF_MEMORY_DIR;

beforeAll(async () => {
  memDir = mkdtempSync(join(tmpdir(), 'fact-store-test-'));
  process.env.BUFF_MEMORY_DIR = memDir;
  resetVectorBackendSelection();
  await getVectorStore('facts').count();
  // Force the LLM embedding tier so tests are deterministic (no native model
  // download / python subprocess on CI).
  setForceLLM(true);
});

afterAll(() => {
  setForceLLM(false);
  if (ORIGINAL_MEMORY_DIR === undefined) delete process.env.BUFF_MEMORY_DIR;
  else process.env.BUFF_MEMORY_DIR = ORIGINAL_MEMORY_DIR;
  rmSync(memDir, { recursive: true, force: true });
});

describe('FactStore', () => {
  let store: FactStore;

  beforeEach(async () => {
    resetVectorBackendSelection();
    store = new FactStore();
    await store.clear();
    clearEmbeddingCache();
  });

  afterEach(async () => {
    await store.clear();
    resetFactStore();
    clearEmbeddingCache();
  });

  /**
   * Deterministic 384-dim mock embedding: identical text → identical vector
   * (cosine 1), different text → ~0 similarity. Lets dedupe + retrieval tests
   * assert real semantics without any network.
   */
  const mockEmbedLLM: any = async (prompt: string) => {
    const text = prompt.replace(/^Search query for past agent trajectories: /, '');
    const vec = new Array(EMBEDDING_DIM).fill(0);
    // Encode the text into a sparse signature vector.
    for (let i = 0; i < text.length; i++) {
      vec[(text.charCodeAt(i) * 7 + i * 13) % EMBEDDING_DIM] += 1;
    }
    const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
    return JSON.stringify(vec.map((v) => v / norm));
  };

  describe('addFact / listFacts', () => {
    it('stores and lists a fact with metadata', async () => {
      const id = await store.addFact('proj-a', {
        text: 'The project uses TypeScript',
        tags: ['typescript'],
        source: 'chat',
        agentRole: 'planner',
      }, mockEmbedLLM);
      expect(id).toBeTruthy();

      const facts = await store.listFacts('proj-a');
      expect(facts).toHaveLength(1);
      expect(facts[0].text).toBe('The project uses TypeScript');
      expect(facts[0].projectId).toBe('proj-a');
      expect(facts[0].tags).toContain('typescript');
      expect(facts[0].source).toBe('chat');
      expect(facts[0].agentRole).toBe('planner');
      expect(facts[0].timestamp).toBeGreaterThan(0);
    });

    it('isolates projects (list --project returns only that project)', async () => {
      await store.addFact('proj-a', { text: 'uses react' }, mockEmbedLLM);
      await store.addFact('proj-b', { text: 'uses vue' }, mockEmbedLLM);

      expect(await store.listFacts('proj-a')).toHaveLength(1);
      expect(await store.listFacts('proj-b')).toHaveLength(1);
      expect(await store.listFacts()).toHaveLength(2);
    });

    it('returns empty list when nothing is stored', async () => {
      expect(await store.listFacts('proj-a')).toEqual([]);
      const stats = await store.stats();
      expect(stats.total).toBe(0);
      expect(stats.byProject).toEqual({});
    });
  });

  describe('retrieveFacts', () => {
    it('returns facts for the matching project only (metadata filter)', async () => {
      await store.addFact('proj-a', { text: 'the user prefers pnpm' }, mockEmbedLLM);
      await store.addFact('proj-b', { text: 'the user prefers yarn' }, mockEmbedLLM);

      const hits = await store.retrieveFacts('proj-a', 'prefers pnpm', mockEmbedLLM, { k: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((f) => f.projectId === 'proj-a')).toBe(true);
    });

    it('honors the time range filter', async () => {
      await store.addFact('proj-a', { text: 'old fact' }, mockEmbedLLM);
      const now = Date.now();
      // A time range entirely in the past must exclude it.
      const hits = await store.retrieveFacts(
        'proj-a',
        'old fact',
        mockEmbedLLM,
        { k: 5, timeRange: { start: 1, end: now - 1000 } },
      );
      expect(hits).toEqual([]);
    });

    it('does not surface facts older than the default freshness window', async () => {
      const shortTtl = new FactStore({ ttlMs: 1 });
      await shortTtl.addFact('proj-a', { text: 'expired fact' }, mockEmbedLLM);
      await new Promise((r) => setTimeout(r, 10));
      const hits = await shortTtl.retrieveFacts('proj-a', 'expired fact', mockEmbedLLM, { k: 5 });
      expect(hits).toEqual([]);
    });

    it('returns at most k results', async () => {
      for (let i = 0; i < 5; i++) {
        await store.addFact('proj-a', { text: `fact number ${i}` }, mockEmbedLLM);
      }
      const hits = await store.retrieveFacts('proj-a', 'fact number', mockEmbedLLM, { k: 2 });
      expect(hits.length).toBeLessThanOrEqual(2);
    });
  });

  describe('dedupe by cosine', () => {
    it('does not re-add a near-duplicate fact', async () => {
      const id1 = await store.addFact('proj-a', { text: 'the user prefers TypeScript' }, mockEmbedLLM);
      expect(id1).toBeTruthy();
      const id2 = await store.addFact('proj-a', { text: 'the user prefers TypeScript' }, mockEmbedLLM);
      expect(id2).toBeNull(); // near-duplicate → not stored

      const facts = await store.listFacts('proj-a');
      expect(facts).toHaveLength(1);
    });
  });

  describe('per-project budget', () => {
    it('prunes the oldest facts when the budget is exceeded', async () => {
      const small = new FactStore({ maxPerProject: 3 });
      await small.addFact('proj-a', { text: 'fact zero' }, mockEmbedLLM);
      // Ensure ordering: different texts still map to distinct vectors.
      for (let i = 1; i <= 4; i++) {
        await small.addFact('proj-a', { text: `fact number ${i}` }, mockEmbedLLM);
      }
      const facts = await small.listFacts('proj-a');
      expect(facts.length).toBeLessThanOrEqual(3);
    });
  });

  describe('expiry', () => {
    it('expireFacts removes facts older than the TTL', async () => {
      const shortTtl = new FactStore({ ttlMs: 1 });
      await shortTtl.addFact('proj-a', { text: 'old fact' }, mockEmbedLLM);
      // Let a couple of ms pass so the 1ms TTL is genuinely exceeded.
      await new Promise((r) => setTimeout(r, 10));
      const removed = await shortTtl.expireFacts();
      expect(removed).toBeGreaterThan(0);
      expect(await shortTtl.listFacts('proj-a')).toHaveLength(0);
    });

    it('does not expire fresh facts', async () => {
      const store2 = new FactStore(); // default 180-day TTL
      await store2.addFact('proj-a', { text: 'fresh fact' }, mockEmbedLLM);
      const removed = await store2.expireFacts();
      expect(removed).toBe(0);
      expect(await store2.listFacts('proj-a')).toHaveLength(1);
    });
  });

  describe('formatAsPrompt', () => {
    it('returns empty string for no facts', () => {
      expect(store.formatAsPrompt([])).toBe('');
    });

    it('formats facts into an injectable prompt block', async () => {
      await store.addFact('proj-a', { text: 'uses vite', tags: ['frontend'] }, mockEmbedLLM);
      const facts = await store.listFacts('proj-a');
      const block = store.formatAsPrompt(facts);
      expect(block).toContain('uses vite');
      expect(block).toContain('frontend');
      expect(block).toContain('Here are facts and preferences');
    });
  });

  describe('ruleExtractFacts (deterministic fallback)', () => {
    it('extracts explicit remember/preference markers', () => {
      const facts = store.ruleExtractFacts('remember: I always commit with conventional commits', '');
      expect(facts).toContain('I always commit with conventional commits');
    });

    it('extracts "I prefer/use/like" declarations', () => {
      const facts = store.ruleExtractFacts('I prefer tabs over spaces', '');
      expect(facts.some((f) => f.includes('tabs over spaces'))).toBe(true);
    });

    it('extracts "the project uses" declarations', () => {
      const facts = store.ruleExtractFacts('The project uses Express and MongoDB', '');
      expect(facts.some((f) => f.includes('Express and MongoDB'))).toBe(true);
    });

    it('dedupes and caps the output', () => {
      const facts = store.ruleExtractFacts(
        'I prefer tabs over spaces. I prefer tabs over spaces.',
        '',
      );
      expect(facts.filter((f) => f.includes('tabs')).length).toBeLessThanOrEqual(1);
    });
  });

  /**
   * A single callLLM serves BOTH roles (extraction + embedding). This mock
   * branches on the prompt: embed prompts ask for a vector, extraction prompts
   * ask for facts — mirroring how the real router-selected LLM is used.
   */
  const smartLLM: any = async (prompt: string) => {
    if (prompt.includes('Text to embed:')) {
      const text = prompt.split('Text to embed:')[1] || '';
      const vec = new Array(EMBEDDING_DIM).fill(0);
      for (let i = 0; i < text.length; i++) {
        vec[(text.charCodeAt(i) * 7 + i * 13) % EMBEDDING_DIM] += 1;
      }
      const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
      return JSON.stringify(vec.map((v) => v / norm));
    }
    if (prompt.includes('memory curator')) {
      return JSON.stringify(['The user wants CI on every PR']);
    }
    return '{}';
  };

  describe('extractFactsFromTurn', () => {
    it('stores rule-extracted facts when the LLM returns unparseable output', async () => {
      const garbageLLM: any = async (prompt: string) => {
        // Embed prompts still return vectors; the extraction prompt returns
        // garbage so the rules must carry the extraction.
        if (prompt.includes('Text to embed:')) return smartLLM(prompt);
        return 'sorry, I cannot produce JSON right now';
      };
      const count = await store.extractFactsFromTurn('proj-a', {
        userText: 'remember: we use Vitest for tests',
        assistantText: 'Done.',
        source: 'chat',
      }, garbageLLM);
      expect(count).toBeGreaterThan(0);
      const facts = await store.listFacts('proj-a');
      expect(facts.some((f) => f.text.includes('Vitest'))).toBe(true);
    });

    it('merges LLM-extracted facts on top of the rules', async () => {
      const count = await store.extractFactsFromTurn('proj-a', {
        userText: 'remember: we use Vitest',
        assistantText: '',
      }, smartLLM);
      expect(count).toBeGreaterThan(0);
      const facts = await store.listFacts('proj-a');
      expect(facts.some((f) => f.text.includes('Vitest'))).toBe(true);
      expect(facts.some((f) => f.text.includes('CI on every PR'))).toBe(true);
    });

    it('never throws on empty input', async () => {
      const count = await store.extractFactsFromTurn('proj-a', { userText: '' }, smartLLM);
      expect(typeof count).toBe('number');
    });
  });

  describe('clear / removeFact', () => {
    it('removes a single fact', async () => {
      const id = await store.addFact('proj-a', { text: 'to remove' }, mockEmbedLLM);
      expect(id).toBeTruthy();
      const removed = await store.removeFact(id!);
      expect(removed).toBe(true);
      expect(await store.listFacts('proj-a')).toHaveLength(0);
    });

    it('clears all facts across projects', async () => {
      await store.addFact('proj-a', { text: 'a' }, mockEmbedLLM);
      await store.addFact('proj-b', { text: 'b' }, mockEmbedLLM);
      await store.clear();
      expect(await store.listFacts()).toHaveLength(0);
      expect((await store.stats()).total).toBe(0);
    });
  });
});
