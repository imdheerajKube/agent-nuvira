/**
 * Tests for the cold-start gate (ensureRegistryWarmed / isRegistryInitialized / isRegistryCold).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveNuviraHome, envBuff } from '../../src/config/paths.js';

// Mock the config paths to use a temp directory
vi.mock('../../src/config/paths.js', () => ({
  resolveNuviraConfigDir: () => testConfigDir,
  resolveNuviraHome: () => testConfigDir,
  resolveBuffConfigDir: () => testConfigDir,
  envBuff: (key: string) => process.env[`NUVIRA_${key}`] ?? process.env[`BUFF_${key}`],
}));

// Mock the model registry
const mockGetUsableProviders = vi.fn<string[], []>();
const mockGetAllModelsForProvider = vi.fn<any[], [string]>();
vi.mock('../../src/learning/model-registry.js', () => ({
  getModelRegistry: () => ({
    getUsableProviders: mockGetUsableProviders,
    getAllModelsForProvider: mockGetAllModelsForProvider,
  }),
}));

// Mock refreshModelRegistry
const mockRefreshResult = {
  providersProbed: ['groq'],
  modelsListed: 5,
  verified: 3,
  unavailable: 1,
  skipped: 1,
  errors: 0,
  prunedLocal: 0,
};
vi.mock('../../src/inference/model-probe.js', () => ({
  refreshModelRegistry: vi.fn().mockResolvedValue(mockRefreshResult),
}));

let testConfigDir: string;
const FLAG_FILENAME = '.registry-initialized';

beforeEach(async () => {
  testConfigDir = join(tmpdir(), `cold-start-gate-test-${Date.now()}`);
  mkdirSync(testConfigDir, { recursive: true });
  mockGetUsableProviders.mockReturnValue([]);
  mockGetAllModelsForProvider.mockReturnValue([]);
  vi.clearAllMocks();
  // Re-import to reset internal state (coldStartProbeFired etc.)
  vi.resetModules();
});

afterEach(() => {
  rmSync(testConfigDir, { recursive: true, force: true });
});

describe('cold-start gate', () => {
  it('isRegistryInitialized returns false when flag file does not exist', async () => {
    const { isRegistryInitialized } = await import('../../src/learning/cold-start-gate.js');
    expect(isRegistryInitialized()).toBe(false);
  });

  it('isRegistryInitialized returns true when flag file exists', async () => {
    writeFileSync(join(testConfigDir, FLAG_FILENAME), '{}', 'utf-8');
    const { isRegistryInitialized } = await import('../../src/learning/cold-start-gate.js');
    expect(isRegistryInitialized()).toBe(true);
  });

  it('isRegistryCold returns true when registry has no data', async () => {
    const { isRegistryCold } = await import('../../src/learning/cold-start-gate.js');
    expect(isRegistryCold()).toBe(true);
  });

  it('isRegistryCold returns false when registry has usable providers', async () => {
    mockGetUsableProviders.mockReturnValue(['groq']);
    const { isRegistryCold } = await import('../../src/learning/cold-start-gate.js');
    expect(isRegistryCold()).toBe(false);
  });

  it('isRegistryCold returns false when registry has tracked models', async () => {
    mockGetAllModelsForProvider.mockReturnValue([{ provider: 'groq', model: 'test' }]);
    const { isRegistryCold } = await import('../../src/learning/cold-start-gate.js');
    expect(isRegistryCold()).toBe(false);
  });

  it('ensureRegistryWarmed returns null immediately on upgrade (flag exists)', async () => {
    writeFileSync(join(testConfigDir, FLAG_FILENAME), '{}', 'utf-8');
    const { ensureRegistryWarmed } = await import('../../src/learning/cold-start-gate.js');
    const result = await ensureRegistryWarmed({} as any);
    expect(result).toBeNull(); // No blocking probe — instant return
  });

  it('ensureRegistryWarmed skips probe when registry has usable providers', async () => {
    mockGetUsableProviders.mockReturnValue(['groq']);
    const { ensureRegistryWarmed } = await import('../../src/learning/cold-start-gate.js');
    const result = await ensureRegistryWarmed({} as any);
    expect(result).toBeNull(); // No blocking probe
    // Flag file should be created
    expect(existsSync(join(testConfigDir, FLAG_FILENAME))).toBe(true);
  });

  it('ensureRegistryWarmed runs synchronous probe on cold start', async () => {
    mockGetUsableProviders.mockReturnValue([]);
    mockGetAllModelsForProvider.mockReturnValue([]);
    const { ensureRegistryWarmed } = await import('../../src/learning/cold-start-gate.js');
    const result = await ensureRegistryWarmed({} as any);
    expect(result).toEqual(mockRefreshResult); // Probe ran and returned data
    // Flag file should be created
    expect(existsSync(join(testConfigDir, FLAG_FILENAME))).toBe(true);
  });

  it('ensureRegistryWarmed creates flag file even on probe failure', async () => {
    mockGetUsableProviders.mockReturnValue([]);
    const { ensureRegistryWarmed } = await import('../../src/learning/cold-start-gate.js');
    const { refreshModelRegistry } = await import('../../src/inference/model-probe.js');
    (refreshModelRegistry as any).mockRejectedValueOnce(new Error('network timeout'));
    const result = await ensureRegistryWarmed({} as any);
    expect(result).toBeNull();
    // Flag file should still be created (so we don't retry every startup)
    expect(existsSync(join(testConfigDir, FLAG_FILENAME))).toBe(true);
  });

  it('ensureRegistryWarmed reports progress via callback', async () => {
    mockGetUsableProviders.mockReturnValue([]);
    const { ensureRegistryWarmed } = await import('../../src/learning/cold-start-gate.js');
    const progressMessages: string[] = [];
    await ensureRegistryWarmed({} as any, {
      onProgress: (msg) => progressMessages.push(msg),
    });
    expect(progressMessages.some(m => m.includes('First run'))).toBe(true);
    expect(progressMessages.some(m => m.includes('Registry warmed'))).toBe(true);
  });

  it('ensureRegistryWarmed does NOT block on second call (flag exists)', async () => {
    // First call: cold start → runs probe → creates flag
    mockGetUsableProviders.mockReturnValue([]);
    const { ensureRegistryWarmed } = await import('../../src/learning/cold-start-gate.js');
    const result1 = await ensureRegistryWarmed({} as any);
    expect(result1).not.toBeNull(); // Ran the probe
    expect(existsSync(join(testConfigDir, FLAG_FILENAME))).toBe(true);

    // Second call: flag exists → returns null instantly (no blocking)
    const result2 = await ensureRegistryWarmed({} as any);
    expect(result2).toBeNull(); // No blocking probe
    // May fire background refresh if stale — that's by design (fire-and-forget)
  });
});
