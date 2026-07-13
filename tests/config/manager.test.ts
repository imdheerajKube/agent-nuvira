import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../../src/config/manager.js';

describe('ConfigManager', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'buff-config-test-'));
    // Ensure env vars don't leak between tests
    delete process.env.NVIDIA_NIM_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('constructor and defaults', () => {
    it('should create with default configuration', () => {
      const manager = new ConfigManager(join(testDir, 'test-a'));
      const config = manager.getAll();

      expect(config.defaultProvider).toBe('local');
      expect(config.providers.nim.model).toBe('meta/llama-3.1-70b-instruct');
      expect(config.providers.gemini.model).toBe('gemini-2.0-flash-exp');
      expect(config.providers.openrouter.model).toBe('mistralai/mistral-7b-instruct');
      expect(config.providers.local.runner).toBe('ollama');
      expect(config.providers.local.model).toBe('llama2');
    });

    it('should merge config file with defaults', () => {
      const configDir = join(testDir, 'test-b');
      mkdirSync(configDir, { recursive: true });

      writeFileSync(
        join(configDir, 'buffconfig.json'),
        JSON.stringify({
          defaultProvider: 'gemini',
          providers: {
            gemini: { model: 'gemini-pro' },
            nim: { apiKey: 'test-nim-key', model: 'custom-model', temperature: 0.5 },
          },
        }),
        'utf-8',
      );

      const manager = new ConfigManager(configDir);
      const config = manager.getAll();

      expect(config.defaultProvider).toBe('gemini');
      expect(config.providers.gemini.model).toBe('gemini-pro');
      expect(config.providers.nim.apiKey).toBe('test-nim-key');
      expect(config.providers.nim.model).toBe('custom-model');
      expect(config.providers.nim.temperature).toBe(0.5);
      expect(config.providers.local.runner).toBe('ollama');
    });

    it('should handle corrupted config file gracefully', () => {
      const configDir = join(testDir, 'test-c');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'buffconfig.json'),
        '{ invalid json }',
        'utf-8',
      );

      const manager = new ConfigManager(configDir);
      const config = manager.getAll();

      expect(config.defaultProvider).toBe('local');
      expect(config.providers.local.runner).toBe('ollama');
    });
  });

  describe('env variable override', () => {
    it('should override API keys from environment variables', () => {
      process.env.NVIDIA_NIM_API_KEY = 'nim-env-key';
      process.env.GEMINI_API_KEY = 'gemini-env-key';
      process.env.OPENROUTER_API_KEY = 'openrouter-env-key';

      const manager = new ConfigManager(join(testDir, 'test-d'));
      const config = manager.getAll();

      expect(config.providers.nim.apiKey).toBe('nim-env-key');
      expect(config.providers.gemini.apiKey).toBe('gemini-env-key');
      expect(config.providers.openrouter.apiKey).toBe('openrouter-env-key');
      expect(config.providers.local.apiKey).toBeUndefined();
    });

    it('should prefer env vars over config file values', () => {
      process.env.NVIDIA_NIM_API_KEY = 'env-key-override';
      const configDir = join(testDir, 'test-e');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'buffconfig.json'),
        JSON.stringify({ providers: { nim: { apiKey: 'file-key' } } }),
        'utf-8',
      );

      const manager = new ConfigManager(configDir);
      const config = manager.getAll();

      expect(config.providers.nim.apiKey).toBe('env-key-override');
    });
  });

  describe('getProviderConfig', () => {
    it('should return config for the specified provider', () => {
      const manager = new ConfigManager(join(testDir, 'test-f'));
      const { type, config } = manager.getProviderConfig('gemini');

      expect(type).toBe('gemini');
      expect(config.model).toBe('gemini-2.0-flash-exp');
    });

    it('should return default provider when none specified', () => {
      const manager = new ConfigManager(join(testDir, 'test-g'));
      const { type, config } = manager.getProviderConfig();

      expect(type).toBe('local');
      expect(config.runner).toBe('ollama');
    });

    it('should throw for unknown provider type', () => {
      const manager = new ConfigManager(join(testDir, 'test-h'));
      expect(() => manager.getProviderConfig('unknown' as any)).toThrow(
        /No configuration found/
      );
    });
  });

  describe('save', () => {
    it('should save config to file', () => {
      const configDir = join(testDir, 'test-i');
      const manager = new ConfigManager(configDir);
      manager.save({ defaultProvider: 'openrouter' });

      const savedContent = readFileSync(join(configDir, 'buffconfig.json'), 'utf-8');
      const savedConfig = JSON.parse(savedContent);
      expect(savedConfig.defaultProvider).toBe('openrouter');
    });

    it('should merge provider config on save', () => {
      const configDir = join(testDir, 'test-j');
      const manager = new ConfigManager(configDir);
      manager.save({
        providers: {
          nim: { model: 'new-nim-model', apiKey: 'new-key' },
        },
      });

      const savedContent = readFileSync(join(configDir, 'buffconfig.json'), 'utf-8');
      const savedConfig = JSON.parse(savedContent);
      expect(savedConfig.providers.nim.model).toBe('new-nim-model');
      expect(savedConfig.providers.nim.apiKey).toBe('new-key');
      expect(savedConfig.providers.nim.temperature).toBe(0.7);
      expect(savedConfig.providers.local.runner).toBe('ollama');
    });
  });

  describe('hasRequiredCredentials', () => {
    it('should return true for local provider without API key', () => {
      const manager = new ConfigManager(join(testDir, 'test-k'));
      expect(manager.hasRequiredCredentials('local')).toBe(true);
    });

    it('should return false for cloud providers without API key', () => {
      const manager = new ConfigManager(join(testDir, 'test-l'));
      expect(manager.hasRequiredCredentials('nim')).toBe(false);
      expect(manager.hasRequiredCredentials('gemini')).toBe(false);
      expect(manager.hasRequiredCredentials('openrouter')).toBe(false);
    });

    it('should return true for configured cloud providers', () => {
      process.env.GEMINI_API_KEY = 'test-key';
      const manager = new ConfigManager(join(testDir, 'test-m'));
      expect(manager.hasRequiredCredentials('gemini')).toBe(true);
    });
  });

  describe('getAll', () => {
    it('should return a copy of the config', () => {
      const manager = new ConfigManager(join(testDir, 'test-n'));
      const config = manager.getAll();

      config.defaultProvider = 'nim';

      expect(manager.getAll().defaultProvider).toBe('local');
    });
  });
});
