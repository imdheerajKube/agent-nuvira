/**
 * M1 — Integration tests (Phase A1/A2/B1 foundation continuity).
 *
 * Proves the three foundation systems pass as ONE unit: the end-to-end
 * continuity story (vault → project row → memory) is verified, not assumed.
 *
 *   Vault:      setPassword → getPassword, surviving a fresh Vault instance.
 *   Workspace:  recordRun → reload, surviving a fresh WorkspaceStore.
 *   Memory:     addFact → listFacts, surviving a fresh FactStore.
 *
 * Everything runs in ONE hermetic BUFF_CONFIG_DIR + BUFF_MEMORY_DIR under a
 * temp dir — no network, no real ~/.buff, no native model downloads.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../../src/enterprise/vault.js';
import { getWorkspaceStore, resetWorkspaceStore } from '../../src/config/workspace.js';
import { FactStore, resetFactStore } from '../../src/memory/fact-store.js';
import { getVectorStore, resetVectorBackendSelection } from '../../src/memory/vector-store.js';
import { clearEmbeddingCache, setForceLLM, EMBEDDING_DIM } from '../../src/memory/embedder.js';

// ─── One hermetic harness for all three systems ────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'buff-integration-a1a2b1-'));
const cfgDir = join(root, '.buff');
const memDir = join(root, '.buff', 'memory');
const ORIG_CONFIG_DIR = process.env.BUFF_CONFIG_DIR;
const ORIG_MEMORY_DIR = process.env.BUFF_MEMORY_DIR;

beforeAll(() => {
  mkdirSync(cfgDir, { recursive: true });
  process.env.BUFF_CONFIG_DIR = cfgDir;
  process.env.BUFF_MEMORY_DIR = memDir;
  // Deterministic embeddings: no native model, no LLM — embed() returns the
  // zero-vector fallback. Facts still store/list via their metadata.
  resetVectorBackendSelection();
  setForceLLM(true);
});

afterAll(() => {
  setForceLLM(false);
  resetFactStore();
  resetWorkspaceStore();
  if (ORIG_CONFIG_DIR === undefined) delete process.env.BUFF_CONFIG_DIR;
  else process.env.BUFF_CONFIG_DIR = ORIG_CONFIG_DIR;
  if (ORIG_MEMORY_DIR === undefined) delete process.env.BUFF_MEMORY_DIR;
  else process.env.BUFF_MEMORY_DIR = ORIG_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  clearEmbeddingCache();
  resetVectorBackendSelection();
  resetWorkspaceStore();
  resetFactStore();
  await getVectorStore('facts').count(); // init the faiss/vector dir under memDir
});

/** Deterministic mock embedding LLM (mirrors tests/memory/fact-store.test.ts). */
const mockEmbedLLM: any = async (prompt: string) => {
  const text = prompt.replace(/^Search query for past agent trajectories: /, '');
  const vec = new Array(EMBEDDING_DIM).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[(text.charCodeAt(i) * 7 + i * 13) % EMBEDDING_DIM] += 1;
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return JSON.stringify(vec.map((v) => v / norm));
};

describe('A1 vault → A2 workspace → B1 memory continuity', () => {
  it('a secret, a run row, and a fact all survive fresh instances of each system', async () => {
    // ── Vault (A1): write with one instance …
    const v1 = Vault.open({ configDir: cfgDir, tier: 'aes-file', masterPassphrase: 'test-pass' });
    expect(v1.activeTier).toBe('aes-file');
    await v1.setPassword('groq.apiKey', 'gsk_secret-123');
    await v1.setPassword('gemini.apiKey', 'AIza-long-gemini-key');
    expect(await v1.getPassword('groq.apiKey')).toBe('gsk_secret-123');

    // ── Workspace (A2): write a run row …
    const cwd = join(root, 'project');
    const ws1 = getWorkspaceStore(cfgDir);
    const row = ws1.recordRun({ cwd, goal: 'Add auth to the API', summary: 'Implemented login', success: true });
    expect(row).not.toBeNull();
    expect(row!.lastGoal).toBe('Add auth to the API');
    expect(row!.runSummary).toContain('Implemented login');

    // ── Memory (B1): write a fact …
    const store1 = new FactStore();
    const factId = await store1.addFact('proj-auth', { text: 'The project uses JWT for auth', tags: ['auth'] }, mockEmbedLLM);
    expect(factId).toBeTruthy();
    const facts1 = await store1.listFacts('proj-auth');
    expect(facts1.some((f) => f.text.includes('JWT'))).toBe(true);

    // ── RELOAD leg: fresh instances of every system read the SAME data.
    const v2 = Vault.open({ configDir: cfgDir, tier: 'aes-file', masterPassphrase: 'test-pass' });
    expect(await v2.getPassword('groq.apiKey')).toBe('gsk_secret-123');
    expect(await v2.getPassword('gemini.apiKey')).toBe('AIza-long-gemini-key');

    resetWorkspaceStore(); // forces a fresh WorkspaceStore (reload from disk)
    const ws2 = getWorkspaceStore(cfgDir);
    expect(ws2).not.toBe(ws1);
    const reloaded = ws2.getProjectForCwd(cwd);
    expect(reloaded.lastGoal).toBe('Add auth to the API');
    expect(reloaded.runSummary).toContain('Implemented login');

    resetFactStore(); // forces a fresh FactStore (reload from disk)
    const store2 = new FactStore();
    const facts2 = await store2.listFacts('proj-auth');
    expect(facts2.some((f) => f.text.includes('JWT'))).toBe(true);
    expect(facts2.length).toBeGreaterThanOrEqual(facts1.length);
  });

  it('a failed run is recorded with an ❌ outcome (continuity of failures)', () => {
    const cwd = join(root, 'project');
    const ws = getWorkspaceStore(cfgDir);
    ws.recordRun({ cwd, goal: 'Ship release', success: false });
    const row = ws.getProjectForCwd(cwd);
    expect(row.lastGoal).toBe('Ship release');
    expect(row.runSummary.startsWith('❌')).toBe(true);
  });

  it('a vault value is never stored in plaintext on the aes-file tier', async () => {
    const v = Vault.open({ configDir: cfgDir, tier: 'aes-file', masterPassphrase: 'test-pass' });
    await v.setPassword('openai.apiKey', 'sk-plaintext-must-not-appear');
    const { readFileSync, readdirSync } = await import('node:fs');
    const files = readdirSync(cfgDir);
    const secretFile = files.find((f) => f === 'vault.enc');
    expect(secretFile).toBeTruthy();
    const raw = readFileSync(join(cfgDir, secretFile!), 'utf-8');
    expect(raw).not.toContain('sk-plaintext-must-not-appear');
    expect(await v.getPassword('openai.apiKey')).toBe('sk-plaintext-must-not-appear');
  });
});
