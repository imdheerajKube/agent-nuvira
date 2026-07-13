import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PluginRegistry, getPluginRegistry } from '../../src/plugins/registry.js';
import type { ProviderPlugin } from '../../src/plugins/registry.js';

describe('PluginRegistry', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  describe('register', () => {
    it('should register a new plugin', () => {
      const plugin: ProviderPlugin = {
        metadata: { name: 'Test Provider', version: '1.0.0', description: 'A test provider' },
        getProviderType: () => 'test-provider',
        createProvider: vi.fn(),
      };

      registry.register(plugin);

      expect(registry.hasPlugin('test-provider')).toBe(true);
      expect(registry.getAllPlugins()).toHaveLength(1);
    });

    it('should allow overwriting an existing plugin', () => {
      const plugin1: ProviderPlugin = {
        metadata: { name: 'Old Provider', version: '1.0.0', description: 'Old' },
        getProviderType: () => 'test',
        createProvider: vi.fn(),
      };

      const plugin2: ProviderPlugin = {
        metadata: { name: 'New Provider', version: '2.0.0', description: 'New' },
        getProviderType: () => 'test',
        createProvider: vi.fn(),
      };

      registry.register(plugin1);
      registry.register(plugin2);

      expect(registry.getAllPlugins()).toHaveLength(1);
      const plugin = registry.getPlugin('test');
      expect(plugin?.metadata.name).toBe('New Provider');
    });
  });

  describe('unregister', () => {
    it('should remove a registered plugin', () => {
      const plugin: ProviderPlugin = {
        metadata: { name: 'Test', version: '1.0.0', description: '' },
        getProviderType: () => 'test',
        createProvider: vi.fn(),
      };

      registry.register(plugin);
      expect(registry.hasPlugin('test')).toBe(true);

      const result = registry.unregister('test');
      expect(result).toBe(true);
      expect(registry.hasPlugin('test')).toBe(false);
    });

    it('should return false for unregistering non-existent plugin', () => {
      const result = registry.unregister('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('hasPlugin', () => {
    it('should return false for unregistered type', () => {
      expect(registry.hasPlugin('nothing')).toBe(false);
    });
  });

  describe('createProviderFromPlugin', () => {
    it('should create provider from registered plugin', () => {
      const createProviderMock = vi.fn().mockReturnValue({ name: 'Custom Provider' });
      const plugin: ProviderPlugin = {
        metadata: { name: 'Custom', version: '1.0.0', description: '' },
        getProviderType: () => 'custom',
        createProvider: createProviderMock,
      };

      registry.register(plugin);
      const config = { apiKey: 'key-123' };
      const result = registry.createProviderFromPlugin('custom', config);

      expect(result).toEqual({ name: 'Custom Provider' });
      expect(createProviderMock).toHaveBeenCalledWith(config);
    });

    it('should throw for unregistered plugin type', () => {
      expect(() => registry.createProviderFromPlugin('unregistered', {})).toThrow(
        'No plugin registered for provider type: unregistered'
      );
    });
  });

  describe('getPlugin', () => {
    it('should return the plugin for a provider type', () => {
      const plugin: ProviderPlugin = {
        metadata: { name: 'My Plugin', version: '1.0.0', description: 'A plugin' },
        getProviderType: () => 'my-plugin',
        createProvider: vi.fn(),
      };

      registry.register(plugin);
      const retrieved = registry.getPlugin('my-plugin');
      expect(retrieved).toBe(plugin);
    });

    it('should return undefined for unregistered type', () => {
      expect(registry.getPlugin('nothing')).toBeUndefined();
    });
  });

  describe('getAllPlugins', () => {
    it('should return all registered plugins', () => {
      const plugin1: ProviderPlugin = {
        metadata: { name: 'A', version: '1.0.0', description: '' },
        getProviderType: () => 'a',
        createProvider: vi.fn(),
      };
      const plugin2: ProviderPlugin = {
        metadata: { name: 'B', version: '1.0.0', description: '' },
        getProviderType: () => 'b',
        createProvider: vi.fn(),
      };

      registry.register(plugin1);
      registry.register(plugin2);

      const plugins = registry.getAllPlugins();
      expect(plugins).toHaveLength(2);
      expect(plugins).toContain(plugin1);
      expect(plugins).toContain(plugin2);
    });

    it('should return empty array when no plugins registered', () => {
      expect(registry.getAllPlugins()).toHaveLength(0);
    });
  });

  describe('listPlugins', () => {
    it('should return metadata for all plugins', () => {
      const plugin: ProviderPlugin = {
        metadata: { name: 'My Plugin', version: '1.0.0', description: 'A plugin', author: 'Me' },
        getProviderType: () => 'my',
        createProvider: vi.fn(),
      };

      registry.register(plugin);
      const list = registry.listPlugins();

      expect(list).toHaveLength(1);
      expect(list[0]).toEqual({ name: 'My Plugin', version: '1.0.0', description: 'A plugin', author: 'Me' });
    });
  });
});

describe('getPluginRegistry singleton', () => {
  it('should return the same instance', () => {
    const registry1 = getPluginRegistry();
    const registry2 = getPluginRegistry();
    expect(registry1).toBe(registry2);
  });
});
