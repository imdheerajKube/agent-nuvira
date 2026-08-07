import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
    delete process.env.GROQ_API_KEY;
    // Isolate from the real ~/.buff/.env (may hold real keys after the M7.4
    // secrets migration): point the home .env lookup at a non-existent path.
    delete process.env.BUFF_ENV_FILE;
    process.env.BUFF_ENV_FILE = join(testDir, 'home-env-does-not-exist.env');
    // Isolate from any BUFF_CONFIG_DIR a developer may export in their shell —
    // the ConfigManager must never read/write the real ~/.buff config in tests.
    delete process.env.BUFF_CONFIG_DIR;
  });

  afterEach(() => {
    delete process.env.BUFF_ENV_FILE;
    delete process.env.BUFF_CONFIG_DIR;
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('constructor and defaults', () => {
    it('should create with default configuration', () => {
      const manager = new ConfigManager(join(testDir, 'test-a'));
      const config = manager.getAll();

      expect(config.defaultProvider).toBe('local');
      expect(config.providers.nim.model).toBe('meta/llama-3.1-8b-instruct');
      expect(config.providers.gemini.model).toBe('gemini-2.5-flash');
      expect(config.providers.openrouter.model).toBe('mistralai/mistral-7b-instruct');
      expect(config.providers.groq.model).toBe('llama-3.3-70b-versatile');
      expect(config.providers.local.runner).toBe('ollama');
      expect(config.providers.local.model).toBe('llama2');
    });

    it('should load routing config from the file (bandit/quota/governance/nuviraSidecar survive reload)', () => {
      const configDir = join(testDir, 'test-routing');
      mkdirSync(configDir, { recursive: true });

      writeFileSync(
        join(configDir, 'buffconfig.json'),
        JSON.stringify({
          routing: {
            bandit: true,
            quota: { gemini: { requestsPerWindow: 1500 } },
            governance: { allowProviders: ['groq', 'local'] },
            nuviraSidecar: { enabled: true, image: 'ghcr.io/berriai/litellm:main-stable' },
          },
        }),
        'utf-8',
      );

      const manager = new ConfigManager(configDir);
      const config = manager.getAll();
      expect(config.routing?.bandit).toBe(true);
      expect(config.routing?.quota?.gemini?.requestsPerWindow).toBe(1500);
      expect(config.routing?.governance?.allowProviders).toEqual(['groq', 'local']);
      expect(config.routing?.nuviraSidecar?.enabled).toBe(true);
      expect(config.routing?.nuviraSidecar?.image).toBe('ghcr.io/berriai/litellm:main-stable');
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

  describe('BUFF_CONFIG_DIR override', () => {
    it('honors BUFF_CONFIG_DIR when no explicit dir is passed (reads there)', () => {
      // The RBAC role file / credential store already honor BUFF_CONFIG_DIR; the
      // config manager must too, so a hermetic run pointed at BUFF_CONFIG_DIR
      // can never read or write the real ~/.buff/buffconfig.json.
      const altDir = join(testDir, 'alt-config');
      mkdirSync(altDir, { recursive: true });
      writeFileSync(
        join(altDir, 'buffconfig.json'),
        JSON.stringify({ defaultProvider: 'groq', providers: { groq: { model: 'alt-model' } } }),
        'utf-8',
      );
      process.env.BUFF_CONFIG_DIR = altDir;

      const manager = new ConfigManager(); // no explicit dir
      const config = manager.getAll();
      expect(config.defaultProvider).toBe('groq');
      expect(config.providers.groq.model).toBe('alt-model');
    });

    it('writes to the BUFF_CONFIG_DIR path on save (no leakage into ~/.buff)', () => {
      const altDir = join(testDir, 'alt-config-save');
      mkdirSync(altDir, { recursive: true });
      process.env.BUFF_CONFIG_DIR = altDir;

      const manager = new ConfigManager();
      manager.save({ defaultProvider: 'openrouter' });

      const saved = JSON.parse(readFileSync(join(altDir, 'buffconfig.json'), 'utf-8'));
      expect(saved.defaultProvider).toBe('openrouter');
      // The write landed inside the override dir — that's the proof the env
      // was honored (a fallback would have targeted the real ~/.buff, which
      // tests must never touch).
    });

    it('explicit dir argument wins over BUFF_CONFIG_DIR', () => {
      const altDir = join(testDir, 'alt-config-explicit');
      mkdirSync(altDir, { recursive: true });
      writeFileSync(
        join(altDir, 'buffconfig.json'),
        JSON.stringify({ defaultProvider: 'nim' }),
        'utf-8',
      );
      const explicitDir = join(testDir, 'explicit-dir');
      mkdirSync(explicitDir, { recursive: true });
      process.env.BUFF_CONFIG_DIR = altDir;

      const manager = new ConfigManager(explicitDir);
      expect(manager.getAll().defaultProvider).toBe('local'); // explicit dir has no file → defaults
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
      expect(config.model).toBe('gemini-2.5-flash');
    });

    it('should return default provider when none specified', () => {
      const manager = new ConfigManager(join(testDir, 'test-g'));
      const { type, config } = manager.getProviderConfig();

      expect(type).toBe('local');
      expect(config.runner).toBe('ollama');
    });

    it('should return empty config for unknown provider types', () => {
      const manager = new ConfigManager(join(testDir, 'test-h'));
      const { type, config } = manager.getProviderConfig('unknown');

      expect(type).toBe('unknown');
      expect(config).toEqual({});
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
      expect(manager.hasRequiredCredentials('groq')).toBe(false);
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

  describe('history config', () => {
    it('should have default retentionDays of 30', () => {
      const manager = new ConfigManager(join(testDir, 'test-o'));
      const config = manager.getAll();

      expect(config.history).toBeDefined();
      expect(config.history!.retentionDays).toBe(30);
    });

    it('should load history config from file', () => {
      const configDir = join(testDir, 'test-p');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'buffconfig.json'),
        JSON.stringify({ history: { retentionDays: 60 } }),
        'utf-8',
      );

      const manager = new ConfigManager(configDir);
      const config = manager.getAll();

      expect(config.history).toBeDefined();
      expect(config.history!.retentionDays).toBe(60);
    });

    it('should merge partial history config with defaults', () => {
      // If only partial history config is provided, defaults should be preserved
      const configDir = join(testDir, 'test-q');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'buffconfig.json'),
        JSON.stringify({ history: { retentionDays: 14 } }),
        'utf-8',
      );

      const manager = new ConfigManager(configDir);
      const config = manager.getAll();

      expect(config.history!.retentionDays).toBe(14);
    });

    it('should save history config to disk', () => {
      const configDir = join(testDir, 'test-r');
      const manager = new ConfigManager(configDir);

      manager.save({ history: { retentionDays: 90 } } as any);

      const savedContent = readFileSync(join(configDir, 'buffconfig.json'), 'utf-8');
      const savedConfig = JSON.parse(savedContent);

      expect(savedConfig.history).toBeDefined();
      expect(savedConfig.history.retentionDays).toBe(90);
    });

    it('should retain history config across load-save cycle', () => {
      const configDir = join(testDir, 'test-s');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'buffconfig.json'),
        JSON.stringify({ history: { retentionDays: 45 } }),
        'utf-8',
      );

      const manager = new ConfigManager(configDir);
      manager.save({ defaultProvider: 'groq' });

      const savedContent = readFileSync(join(configDir, 'buffconfig.json'), 'utf-8');
      const savedConfig = JSON.parse(savedContent);

      // history config should persist across saves
      expect(savedConfig.history.retentionDays).toBe(45);
      expect(savedConfig.defaultProvider).toBe('groq');
    });
  });

  describe('pricing config', () => {
    it('should default to empty pricing overrides', () => {
      const manager = new ConfigManager(join(testDir, 'test-pricing-default'));
      const config = manager.getAll();

      expect(config.pricing).toBeDefined();
      expect(Object.keys(config.pricing!)).toHaveLength(0);
    });

    it('should load pricing overrides from file', () => {
      const configDir = join(testDir, 'test-pricing-load');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'buffconfig.json'),
        JSON.stringify({ pricing: { gemini: { inputPer1K: 0.00125 } } }),
        'utf-8',
      );

      const manager = new ConfigManager(configDir);
      const config = manager.getAll();

      expect(config.pricing!.gemini).toBeDefined();
      expect(config.pricing!.gemini!.inputPer1K).toBe(0.00125);
    });

    it('should merge partial provider pricing with existing values', () => {
      const configDir = join(testDir, 'test-pricing-merge');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'buffconfig.json'),
        JSON.stringify({ pricing: { groq: { inputPer1K: 0.0005 } } }),
        'utf-8',
      );

      const manager = new ConfigManager(configDir);
      const config = manager.getAll();

      expect(config.pricing!.groq!.inputPer1K).toBe(0.0005);
      // outputPer1K remains unset (falls back to the built-in table at routing time)
      expect(config.pricing!.groq!.outputPer1K).toBeUndefined();
    });

    it('should save pricing overrides to disk', () => {
      const configDir = join(testDir, 'test-pricing-save');
      const manager = new ConfigManager(configDir);

      manager.save({ pricing: { groq: { inputPer1K: 0.0005, outputPer1K: 0.001 } } } as any);

      const saved = JSON.parse(readFileSync(join(configDir, 'buffconfig.json'), 'utf-8'));
      expect(saved.pricing.groq.inputPer1K).toBe(0.0005);
      expect(saved.pricing.groq.outputPer1K).toBe(0.001);
    });

    it('should preserve per-field pricing overrides across sequential saves', () => {
      // Mirrors `buff config set pricing.groq.inputPer1K X` then
      // `buff config set pricing.groq.outputPer1K Y` — both fields must survive.
      const configDir = join(testDir, 'test-pricing-sequential');
      const manager = new ConfigManager(configDir);

      manager.save({ pricing: { groq: { inputPer1K: 0.0005 } } } as any);
      manager.save({ pricing: { groq: { outputPer1K: 0.001 } } } as any);

      const saved = JSON.parse(readFileSync(join(configDir, 'buffconfig.json'), 'utf-8'));
      expect(saved.pricing.groq.inputPer1K).toBe(0.0005);
      expect(saved.pricing.groq.outputPer1K).toBe(0.001);

      // Also survives a reload from disk
      const reloaded = new ConfigManager(configDir);
      expect(reloaded.getAll().pricing!.groq!.inputPer1K).toBe(0.0005);
      expect(reloaded.getAll().pricing!.groq!.outputPer1K).toBe(0.001);
    });
  });

  describe('semanticSearch config', () => {
    it('should default to true', () => {
      const manager = new ConfigManager(join(testDir, 'test-t'));
      const config = manager.getAll();

      expect(config.history).toBeDefined();
      expect(config.history!.semanticSearch).toBe(true);
    });

    it('should load semanticSearch from config file', () => {
      const configDir = join(testDir, 'test-u');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'buffconfig.json'),
        JSON.stringify({ history: { semanticSearch: false } }),
        'utf-8',
      );

      const manager = new ConfigManager(configDir);
      const config = manager.getAll();

      expect(config.history!.semanticSearch).toBe(false);
    });

    it('should save semanticSearch to disk', () => {
      const configDir = join(testDir, 'test-v');
      const manager = new ConfigManager(configDir);

      manager.save({ history: { semanticSearch: false } } as any);

      const savedContent = readFileSync(join(configDir, 'buffconfig.json'), 'utf-8');
      const savedConfig = JSON.parse(savedContent);

      expect(savedConfig.history.semanticSearch).toBe(false);
    });

    it('should coexist with retentionDays in the same history config', () => {
      const configDir = join(testDir, 'test-w');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'buffconfig.json'),
        JSON.stringify({ history: { retentionDays: 14, semanticSearch: false } }),
        'utf-8',
      );

      const manager = new ConfigManager(configDir);
      const config = manager.getAll();

      expect(config.history!.retentionDays).toBe(14);
      expect(config.history!.semanticSearch).toBe(false);
    });
  });
});
