import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getMemoryManager,
  resetMemoryManager,
  MemoryManager,
} from '../../src/memory/manager.js';
import {
  LocalMemoryProvider,
  isTrivialPrompt,
  resetMemoryProvider,
  setMemoryProvider,
  type MemoryProvider,
  type MemoryPrefetchResult,
} from '../../src/memory/provider.js';
import { getFactStore, resetFactStore } from '../../src/memory/fact-store.js';
import { getVectorStore, resetVectorBackendSelection } from '../../src/memory/vector-store.js';
import { clearEmbeddingCache, setForceLLM, EMBEDDING_DIM } from '../../src/memory/embedder.js';

// ─── Hermetic memory dir ────────────────────────────────────────────────────

let memDir: string;
const ORIGINAL_MEMORY_DIR = process.env.BUFF_MEMORY_DIR;

beforeAll(async () => {
  memDir = mkdtempSync(join(tmpdir(), 'manager-test-'));
  process.env.BUFF_MEMORY_DIR = memDir;
  resetVectorBackendSelection();
  await getVectorStore('facts').count();
  setForceLLM(true);
});

afterAll(() => {
  setForceLLM(false);
  if (ORIGINAL_MEMORY_DIR === undefined) delete process.env.BUFF_MEMORY_DIR;
  else process.env.BUFF_MEMORY_DIR = ORIGINAL_MEMORY_DIR;
  rmSync(memDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetMemoryManager();
  resetMemoryProvider();
  resetVectorBackendSelection();
  clearEmbeddingCache();
});

afterEach(async () => {
  await getFactStore().clear();
  resetFactStore();
  resetMemoryManager();
  resetMemoryProvider();
  clearEmbeddingCache();
});

/**
 * Deterministic 384-dim mock embedding: identical text → identical vector
 * (cosine 1), different text → ~0 similarity. Mirrors fact-store.test.ts.
 */
const mockEmbedLLM: any = async (prompt: string) => {
  const text = prompt.replace(/^Search query for past agent trajectories: /, '');
  const vec = new Array(EMBEDDING_DIM).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[(text.charCodeAt(i) * 7 + i * 13) % EMBEDDING_DIM] += 1;
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return JSON.stringify(vec.map((v) => v / norm));
};

/** Single callLLM serving BOTH roles (embedding + fact extraction). */
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

describe('isTrivialPrompt (Hermes is_trivial_prompt gate)', () => {
  it('treats empty / whitespace-only input as trivial', () => {
    expect(isTrivialPrompt('')).toBe(true);
    expect(isTrivialPrompt('   ')).toBe(true);
    expect(isTrivialPrompt(null)).toBe(true);
    expect(isTrivialPrompt(undefined)).toBe(true);
  });

  it('treats slash commands as trivial', () => {
    expect(isTrivialPrompt('/exit')).toBe(true);
    expect(isTrivialPrompt('/model')).toBe(true);
  });

  it('treats bare greetings / acknowledgements as trivial', () => {
    for (const t of ['hi', 'hello', 'hey!', 'thanks', 'ok', 'okay?', 'yes.', 'no', 'done', 'lgtm', 'continue', 'go ahead', 'great :)']) {
      expect(isTrivialPrompt(t)).toBe(true);
    }
  });

  it('does NOT match words that merely START with a trivial word', () => {
    expect(isTrivialPrompt('k8s deploy the cluster')).toBe(false);
    expect(isTrivialPrompt('continue last week\'s ecommerce plan')).toBe(false);
    expect(isTrivialPrompt('note the api key rotation')).toBe(false);
    expect(isTrivialPrompt('yolo merge')).toBe(false);
  });

  it('treats real task prompts as non-trivial', () => {
    for (const t of [
      'create an NVDA addon',
      'fix the failing test in auth.ts',
      'remember: I prefer tabs over spaces',
      'explain how the router picks a model',
    ]) {
      expect(isTrivialPrompt(t)).toBe(false);
    }
  });
});

describe('MemoryManager lifecycle', () => {
  it('startSession initializes the provider and tracks the session', async () => {
    const mgr = getMemoryManager();
    expect(mgr.inSession).toBe(false);

    await mgr.startSession('sess-1');
    expect(mgr.inSession).toBe(true);
    expect(mgr.activeProvider.name).toBe('local');
  });

  it('recordTurn buffers turns and endSession returns the session id', async () => {
    const mgr = getMemoryManager();
    await mgr.startSession('sess-2');
    await mgr.recordTurn('remember: we use Vitest for tests', 'Done.');

    const ended = await mgr.endSession();
    expect(ended).toBe('sess-2');
    expect(mgr.inSession).toBe(false);
  });

  it('endSession with no active session is a no-op (returns null)', async () => {
    const mgr = getMemoryManager();
    expect(await mgr.endSession()).toBeNull();
  });

  it('setProvider swaps the backend (Phase F1 register point)', () => {
    const mgr = new MemoryManager();
    expect(mgr.activeProvider.name).toBe('local');

    const fake: MemoryProvider = {
      name: 'mem0',
      isAvailable: () => false,
      initialize: vi.fn(async () => {}),
      systemPromptBlock: () => '',
      prefetch: vi.fn(async (): Promise<MemoryPrefetchResult> => ({
        block: '', trajectories: [], fewShotContext: '', patternContext: '', failureLessonContext: '', factContext: '',
      })),
      syncTurn: vi.fn(async () => {}),
      onSessionEnd: vi.fn(async () => {}),
    };
    mgr.setProvider(fake);
    expect(mgr.activeProvider.name).toBe('mem0');
  });
});

describe('LocalMemoryProvider.prefetch', () => {
  it('returns an empty block for a trivial query (no store access)', async () => {
    const provider = new LocalMemoryProvider();
    const result = await provider.prefetch('hi', 'sess', mockEmbedLLM);
    expect(result.block).toBe('');
    expect(result.trajectories).toEqual([]);
    expect(result.factContext).toBe('');
  });

  it('returns an empty block when no memory exists for a real query', async () => {
    const provider = new LocalMemoryProvider();
    const result = await provider.prefetch('fix the failing test', 'sess', mockEmbedLLM);
    expect(result.block).toBe('');
    expect(result.trajectories).toEqual([]);
  });

  it('composes the persistent-memory block from stored facts (Phase B1 integration)', async () => {
    // Store a fact for the CURRENT project (same derivation the provider uses)
    const { deriveProjectId } = await import('../../src/config/workspace.js');
    const { id: projectId } = deriveProjectId(process.cwd());
    const factId = await getFactStore().addFact(
      projectId,
      { text: 'The user prefers pnpm', source: 'manual' },
      smartLLM,
    );
    expect(factId).toBeTruthy();

    const provider = new LocalMemoryProvider();
    // Query shares words with the stored fact so the mock signature-vector
    // cosine clears the retrieval threshold (same pattern as fact-store tests).
    const result = await provider.prefetch('the user prefers pnpm package manager', 'sess', smartLLM);
    expect(result.block).toContain('Persistent memory for this project');
    expect(result.factContext).toContain('The user prefers pnpm');
    // The block is composed from the fact context (few-shot/pattern empty).
    expect(result.block).toContain('The user prefers pnpm');
  });
});

describe('LocalMemoryProvider turn → session-end extraction', () => {
  it('distills buffered turns into project facts at session end', async () => {
    const provider = new LocalMemoryProvider();
    await provider.initialize('sess-3');

    // Greetings are NOT buffered (trivial gate inside syncTurn).
    await provider.syncTurn('hi', 'hello!', smartLLM);
    // Durable preference IS buffered.
    await provider.syncTurn('remember: we use Vitest for tests', 'Great, done.', smartLLM);

    await provider.onSessionEnd('sess-3', smartLLM);

    const { deriveProjectId } = await import('../../src/config/workspace.js');
    const { id: projectId } = deriveProjectId(process.cwd());
    const facts = await getFactStore().listFacts(projectId);
    expect(facts.some((f) => f.text.includes('Vitest'))).toBe(true);
    // Trivial turn never produced a fact.
    expect(facts.some((f) => f.text.includes('hello'))).toBe(false);
  });

  it('extraction never throws even with no callLLM (rules fallback)', async () => {
    const provider = new LocalMemoryProvider();
    await provider.initialize('sess-4');
    await provider.syncTurn('remember: I prefer tabs over spaces', '');

    // No callLLM → deterministic rules-only extraction path. Under the test's
    // forced-LLM embedding tier (native tiers disabled) a zero vector means
    // facts may not persist — the contract is: never throws, buffer consumed,
    // and a repeated end is a harmless no-op.
    await expect(provider.onSessionEnd('sess-4')).resolves.toBeUndefined();
    await expect(provider.onSessionEnd('sess-4')).resolves.toBeUndefined();
  });

  it('onSessionEnd with no buffered turns is a no-op', async () => {
    const provider = new LocalMemoryProvider();
    await provider.initialize('sess-5');
    await provider.syncTurn('hi there', 'hey', smartLLM); // trivial → not buffered
    await expect(provider.onSessionEnd('sess-5', smartLLM)).resolves.toBeUndefined();
  });
});

describe('MemoryManager end-to-end (chat-style flow)', () => {
  it('startSession → recordTurn×n → endSession stores facts', async () => {
    const mgr = getMemoryManager();
    await mgr.startSession('sess-e2e');

    await mgr.recordTurn('remember: the team uses conventional commits', 'Noted.');
    await mgr.recordTurn('I prefer pnpm over npm', 'Got it.');
    await mgr.recordTurn('thanks', 'You\'re welcome!'); // trivial — skipped

    await mgr.endSession(smartLLM);

    const { deriveProjectId } = await import('../../src/config/workspace.js');
    const { id: projectId } = deriveProjectId(process.cwd());
    const facts = await getFactStore().listFacts(projectId);
    expect(facts.some((f) => f.text.includes('conventional commits'))).toBe(true);
    expect(facts.some((f) => f.text.includes('pnpm'))).toBe(true);
  });

  it('setMemoryProvider singleton swap + reset restores local', async () => {
    const fake: MemoryProvider = {
      name: 'mem0',
      isAvailable: () => false,
      initialize: vi.fn(async () => {}),
      systemPromptBlock: () => '',
      prefetch: vi.fn(async (): Promise<MemoryPrefetchResult> => ({
        block: '', trajectories: [], fewShotContext: '', patternContext: '', failureLessonContext: '', factContext: '',
      })),
      syncTurn: vi.fn(async () => {}),
      onSessionEnd: vi.fn(async () => {}),
    };
    setMemoryProvider(fake);
    expect(getMemoryManager().activeProvider.name).toBe('mem0');

    resetMemoryManager();
    expect(getMemoryManager().activeProvider.name).toBe('local');
  });
});
