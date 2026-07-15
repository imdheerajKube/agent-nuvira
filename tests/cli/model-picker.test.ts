/**
 * Model Picker — Unit tests for the shared showModelPicker function.
 *
 * The function is heavily UI-driven (inquirer prompts, ora spinners, console.log).
 * These tests mock the I/O layer and verify the decision logic:
 * 1. No providers available → returns null
 * 2. No models from any provider → returns null
 * 3. Provider listModels error → warns and continues
 * 4. User cancels (inputs "0") → returns null
 * 5. User selects a valid model → returns { provider, model }
 * 6. Speech model selected → logger.warn called
 * 7. Logger spy verification for key messages
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import inquirer from 'inquirer';

import { showModelPicker } from '../../src/cli/model-picker.js';
import { logger } from '../../src/utils/logger.js';
import type { ConfigManager } from '../../src/config/manager.js';
import type { InferenceProvider, ModelDescriptor } from '../../src/inference/interface.js';
import type { ProviderType } from '../../src/config/types.js';

// ─── Mock helpers ───────────────────────────────────────────────────────────

/** Create a mock InferenceProvider with controllable behaviour */
function createMockProvider(overrides: Partial<InferenceProvider> = {}): InferenceProvider {
  return {
    name: overrides.name || 'MockProvider',
    isAvailable: overrides.isAvailable || vi.fn().mockResolvedValue(true),
    generate: overrides.generate || vi.fn(),
    generateStream: overrides.generateStream as any || undefined,
    listModels: overrides.listModels || vi.fn().mockResolvedValue([]),
    getInfo: overrides.getInfo || vi.fn().mockReturnValue('Mock info'),
    isStreamable: overrides.isStreamable || vi.fn().mockReturnValue(false),
  } as InferenceProvider;
}

/** Create a mock ModelDescriptor */
function makeModel(id: string, overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id,
    name: overrides.name || id,
    provider: overrides.provider || 'groq',
    owner: overrides.owner,
    tags: overrides.tags || [],
    ...overrides,
  };
}

// ─── Mock the router module so resolveProvider returns our mocks ─────────────

// vi.hoisted ensures the Map is initialized before vi.mock's hoisted factory runs
const mockResolveResults = vi.hoisted(() => new Map<string, { type: ProviderType; provider: InferenceProvider }>());

vi.mock('../../src/cli/router.js', () => ({
  resolveProvider: vi.fn((_configManager: ConfigManager, providerType: string) => {
    const result = mockResolveResults.get(providerType);
    if (!result) {
      // Return a default unavailable provider if not set up
      return {
        type: providerType as ProviderType,
        provider: createMockProvider({
          name: providerType,
          isAvailable: vi.fn().mockResolvedValue(false),
        }),
      };
    }
    return result;
  }),
}));

// ─── Suppress ora spinners in tests ─────────────────────────────────────────

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('showModelPicker', () => {
  let mockConfigManager: ConfigManager;

  beforeEach(() => {
    mockResolveResults.clear();
    mockConfigManager = {} as ConfigManager;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── No providers available ──────────────────────────────────────────────

  it('should return null when no providers are available', async () => {
    // All providers return unavailable
    for (const pt of ['local', 'nim', 'gemini', 'openrouter', 'groq']) {
      mockResolveResults.set(pt, {
        type: pt as ProviderType,
        provider: createMockProvider({
          name: pt,
          isAvailable: vi.fn().mockResolvedValue(false),
        }),
      });
    }

    const result = await showModelPicker(mockConfigManager);

    expect(result).toBeNull();
  });

  // ── Provider listModels error ───────────────────────────────────────────

  it('should log warning and continue when a provider listModels fails', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');

    // Set up one provider that fails and one that works
    const workingModels = [makeModel('llama-3.3-70b-versatile', { provider: 'groq' })];
    mockResolveResults.set('groq', {
      type: 'groq',
      provider: createMockProvider({
        name: 'Groq',
        isAvailable: vi.fn().mockResolvedValue(true),
        listModels: vi.fn().mockResolvedValue(workingModels),
      }),
    });
    mockResolveResults.set('openrouter', {
      type: 'openrouter',
      provider: createMockProvider({
        name: 'OpenRouter',
        isAvailable: vi.fn().mockResolvedValue(true),
        listModels: vi.fn().mockRejectedValue(new Error('Network error')),
      }),
    });

    // Cancel to avoid hanging on inquirer
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ selected: '0' });

    await showModelPicker(mockConfigManager);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load models from OpenRouter'));
  });

  // ── No models from any provider ─────────────────────────────────────────

  it('should return null when all providers return empty models', async () => {
    mockResolveResults.set('groq', {
      type: 'groq',
      provider: createMockProvider({
        name: 'Groq',
        isAvailable: vi.fn().mockResolvedValue(true),
        listModels: vi.fn().mockResolvedValue([]),
      }),
    });
    // All others unavailable
    for (const pt of ['local', 'nim', 'gemini', 'openrouter']) {
      mockResolveResults.set(pt, {
        type: pt as ProviderType,
        provider: createMockProvider({
          name: pt,
          isAvailable: vi.fn().mockResolvedValue(false),
        }),
      });
    }

    const result = await showModelPicker(mockConfigManager);

    expect(result).toBeNull();
  });

  // ── Provider is available but returns no models ─────────────────────────

  it('should log warning and treat empty model list as no models', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');

    mockResolveResults.set('groq', {
      type: 'groq',
      provider: createMockProvider({
        name: 'Groq',
        isAvailable: vi.fn().mockResolvedValue(true),
        listModels: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await showModelPicker(mockConfigManager);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No models found'));
    expect(result).toBeNull();
  });

  // ── User cancels ────────────────────────────────────────────────────────

  it('should return null when user cancels by entering 0', async () => {
    const chatModels = [makeModel('llama-3.3-70b-versatile', { provider: 'groq' })];

    mockResolveResults.set('groq', {
      type: 'groq',
      provider: createMockProvider({
        name: 'Groq',
        isAvailable: vi.fn().mockResolvedValue(true),
        listModels: vi.fn().mockResolvedValue(chatModels),
      }),
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ selected: '0' });

    const result = await showModelPicker(mockConfigManager);

    expect(result).toBeNull();
  });

  // ── User selects a valid model ──────────────────────────────────────────

  it('should return provider and model when user selects a valid model', async () => {
    const chatModels = [makeModel('llama-3.3-70b-versatile', { provider: 'groq' })];

    mockResolveResults.set('groq', {
      type: 'groq',
      provider: createMockProvider({
        name: 'Groq',
        isAvailable: vi.fn().mockResolvedValue(true),
        listModels: vi.fn().mockResolvedValue(chatModels),
      }),
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ selected: '1' });

    const result = await showModelPicker(mockConfigManager);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('groq');
    expect(result!.model).toBe('llama-3.3-70b-versatile');
  });

  // ── User selects second model from a list ───────────────────────────────

  it('should return the correct model when selecting from multiple', async () => {
    const models = [
      makeModel('llama-3.3-70b-versatile', { provider: 'groq' }),
      makeModel('gemini-2.0-flash-exp', { provider: 'gemini' }),
    ];

    mockResolveResults.set('groq', {
      type: 'groq',
      provider: createMockProvider({
        name: 'Groq',
        isAvailable: vi.fn().mockResolvedValue(true),
        listModels: vi.fn().mockResolvedValue(models),
      }),
    });
    // Gemini not available — model will be associated with groq provider via _providerType
    mockResolveResults.set('gemini', {
      type: 'gemini',
      provider: createMockProvider({
        name: 'Google Gemini',
        isAvailable: vi.fn().mockResolvedValue(false),
      }),
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ selected: '2' });

    const result = await showModelPicker(mockConfigManager);

    expect(result).not.toBeNull();
    expect(result!.model).toBe('gemini-2.0-flash-exp');
  });

  // ── Speech model warning ────────────────────────────────────────────────

  it('should show warning when user selects a speech model', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');

    const speechModels = [
      makeModel('whisper-large-v3', { provider: 'groq', tags: ['speech'] }),
    ];

    mockResolveResults.set('groq', {
      type: 'groq',
      provider: createMockProvider({
        name: 'Groq',
        isAvailable: vi.fn().mockResolvedValue(true),
        listModels: vi.fn().mockResolvedValue(speechModels),
      }),
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ selected: '1' });

    await showModelPicker(mockConfigManager);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('does NOT support text chat'));
  });

  // ── Non-speech model should not warn ────────────────────────────────────

  it('should NOT show speech warning for a regular chat model', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');

    const chatModels = [makeModel('llama-3.3-70b-versatile', { provider: 'groq' })];

    mockResolveResults.set('groq', {
      type: 'groq',
      provider: createMockProvider({
        name: 'Groq',
        isAvailable: vi.fn().mockResolvedValue(true),
        listModels: vi.fn().mockResolvedValue(chatModels),
      }),
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ selected: '1' });

    await showModelPicker(mockConfigManager);

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('does NOT support text chat'));
  });

  // ── Model from non-groq provider ────────────────────────────────────────

  it('should handle models coming from a provider other than the first', async () => {
    const nimModels = [makeModel('deepseek-ai/deepseek-coder-6.7b-instruct', { provider: 'nim', tags: ['code'] })];

    mockResolveResults.set('nim', {
      type: 'nim',
      provider: createMockProvider({
        name: 'NVIDIA NIM',
        isAvailable: vi.fn().mockResolvedValue(true),
        listModels: vi.fn().mockResolvedValue(nimModels),
      }),
    });
    // Make groq unavailable so nim is the only option
    mockResolveResults.set('groq', {
      type: 'groq',
      provider: createMockProvider({
        name: 'Groq',
        isAvailable: vi.fn().mockResolvedValue(false),
      }),
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ selected: '1' });

    const result = await showModelPicker(mockConfigManager);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('nim');
    expect(result!.model).toBe('deepseek-ai/deepseek-coder-6.7b-instruct');
  });

  // ── Provider name fallback ──────────────────────────────────────────────

  it('should log success for available providers', async () => {
    const successSpy = vi.spyOn(logger, 'success');

    const models = [makeModel('llama-3.3-70b-versatile', { provider: 'groq' })];
    mockResolveResults.set('groq', {
      type: 'groq',
      provider: createMockProvider({
        name: 'Groq',
        isAvailable: vi.fn().mockResolvedValue(true),
        listModels: vi.fn().mockResolvedValue(models),
      }),
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ selected: '0' });

    await showModelPicker(mockConfigManager);

    expect(successSpy).toHaveBeenCalledWith(expect.stringContaining('Groq'));
  });
});
