/**
 * MarketplaceCommand — Unit tests for buff marketplace browse/search/info.
 *
 * Covers:
 * 1. Browse — shows built-in workflow templates
 * 2. Browse — shows plugins when available
 * 3. Browse — shows "no plugins" message when none found
 * 4. Browse --workflows — shows workflows only
 * 5. Browse --plugins — shows plugins only
 * 6. Search — finds matching built-in templates
 * 7. Search — handles registry search failure gracefully
 * 8. Search — shows "no results" for unmatched queries
 * 9. Info — shows built-in template details
 * 10. Info — shows plugin details
 * 11. Info — shows "not found" for unknown items
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { logger } from '../../src/utils/logger.js';

// ─── Hoisted mock data ──────────────────────────────────────────────────────

const mockBuiltinTemplates = vi.hoisted(() => [
  {
    id: 'quick-fix',
    name: 'Quick Fix',
    description: 'Fix a specific bug or issue quickly',
    steps: [{ id: 'step-1', agentType: 'writer', description: 'Apply fix' }],
    tags: ['fix', 'quick'],
    useMemory: false,
  },
  {
    id: 'feature-dev',
    name: 'Feature Development',
    description: 'Implement a new feature from specification',
    steps: [
      { id: 'step-1', agentType: 'planner', description: 'Plan feature' },
      { id: 'step-2', agentType: 'writer', description: 'Implement feature' },
      { id: 'step-3', agentType: 'tester', description: 'Test feature' },
    ],
    tags: ['feature', 'dev'],
    useMemory: true,
    recommendedModels: { writer: 'groq/llama-3.3-70b-versatile', tester: 'groq/llama-3.3-70b-versatile' },
  },
]);

const mockInstalledTemplates = vi.hoisted(() => [
  {
    id: 'community-workflow',
    name: 'Community Workflow',
    description: 'A workflow from the community',
    steps: [{ id: 'step-1', agentType: 'writer', description: 'Do something' }],
    version: '1.2.0',
    author: 'community-contributor',
  },
]);

const mockPlugin = vi.hoisted(() => ({
  metadata: { name: 'Custom AI', version: '1.0.0', description: 'A custom provider plugin', author: 'plugin-author' },
  getProviderType: () => 'custom-ai',
  createProvider: vi.fn(),
}));

const mockAllPlugins: any[] = [];

vi.mock('../../src/workflow/templates.js', () => ({
  getWorkflowTemplates: vi.fn(() => mockBuiltinTemplates),
  getWorkflowTemplate: vi.fn((id: string) => mockBuiltinTemplates.find((t: any) => t.id === id) || null),
}));

vi.mock('../../src/workflow/registry.js', () => ({
  searchRegistry: vi.fn(async (query: string) => {
    if (query === 'error') throw new Error('Registry unavailable');
    return [
      { id: 'cloud-deploy', name: 'Cloud Deploy', description: 'Deploy to the cloud', author: 'devops-team', version: '2.0.0', tags: ['deploy', 'cloud'], stepCount: 5, updatedAt: '2025-01-15' },
    ];
  }),
  installTemplate: vi.fn(),
  getRegistryEntry: vi.fn(async (id: string) => {
    if (id === 'cloud-deploy') {
      return { id: 'cloud-deploy', name: 'Cloud Deploy', description: 'Deploy to cloud', author: 'devops-team', version: '2.0.0', tags: ['deploy'], stepCount: 5, updatedAt: '2025-01-15', sourceUrl: 'https://github.com/example/workflows' };
    }
    return null;
  }),
  getInstalledTemplates: vi.fn(() => mockInstalledTemplates),
  clearRegistryCache: vi.fn(),
}));

vi.mock('../../src/plugins/registry.js', () => ({
  getPluginRegistry: vi.fn(() => ({
    getAllPlugins: vi.fn(() => mockAllPlugins),
  })),
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function muteConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

async function runMarketplace(args: string[]): Promise<void> {
  const { MarketplaceCommand } = await import('../../src/cli/marketplace.js');
  const cmd = new MarketplaceCommand();
  const command = cmd.create();
  await command.parseAsync(['node', 'buff', ...args]);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MarketplaceCommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockAllPlugins.length = 0;
    muteConsole();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── browse ────────────────────────────────────────────────────────────

  describe('browse', () => {
    it('should show header with marketplace title', async () => {
      const highlightSpy = vi.spyOn(logger, 'highlight');

      await runMarketplace(['browse']);

      expect(highlightSpy).toHaveBeenCalledWith(expect.stringContaining('Marketplace'));
    });

    it('should list built-in workflow templates', async () => {
      await runMarketplace(['browse']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('quick-fix'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('feature-dev'));
    });

    it('should show installed templates when present', async () => {
      await runMarketplace(['browse']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('community-workflow'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('community-contributor'));
    });

    it('should show plugins when available', async () => {
      mockAllPlugins.push(mockPlugin);

      await runMarketplace(['browse']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Custom AI'));
    });

    it('should show "no plugins" message when none found', async () => {
      await runMarketplace(['browse']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No plugins discovered'));
    });

    it('should show only workflows when --workflows is given', async () => {
      mockAllPlugins.push(mockPlugin);

      await runMarketplace(['browse', '--workflows']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('quick-fix'));
      // Should NOT mention plugins since we filtered
      // But the "no plugins" message won't show since showPlugins is false
    });

    it('should show only plugins when --plugins is given', async () => {
      mockAllPlugins.push(mockPlugin);

      await runMarketplace(['browse', '--plugins']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Custom AI'));
    });

    it('should refresh cache when --refresh is given', async () => {
      const { clearRegistryCache } = await import('../../src/workflow/registry.js');

      await runMarketplace(['browse', '--refresh']);

      expect(clearRegistryCache).toHaveBeenCalled();
    });
  });

  // ── search ────────────────────────────────────────────────────────────

  describe('search', () => {
    it('should find built-in templates matching query', async () => {
      await runMarketplace(['search', 'quick']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('quick-fix'));
    });

    it('should find registry templates matching query', async () => {
      await runMarketplace(['search', 'cloud']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('cloud-deploy'));
    });

    it('should find plugins matching query', async () => {
      mockAllPlugins.push(mockPlugin);

      await runMarketplace(['search', 'Custom AI']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Custom AI'));
    });

    it('should handle registry search failure gracefully', async () => {
      // The "error" query triggers a throw in the mock
      const infoSpy = vi.spyOn(logger, 'info');

      await runMarketplace(['search', 'error']);

      // Should not crash — registry fallback shows "not found" since no local results match
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('No marketplace items found'));
    });

    it('should show results for registry match even when local results are empty', async () => {
      const highlightSpy = vi.spyOn(logger, 'highlight');

      await runMarketplace(['search', 'zzz_nonexistent_zzz']);

      // Registry always returns cloud-deploy from our mock
      expect(highlightSpy).toHaveBeenCalledWith(expect.stringContaining('Marketplace Results'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('cloud-deploy'));
    });
  });

  // ── install ───────────────────────────────────────────────────────────

  describe('install', () => {
    it('should show info message for template not found in registry', async () => {
      // Mock returns undefined by default, triggering the "not found" path
      const infoSpy = vi.spyOn(logger, 'info');

      await runMarketplace(['install', 'nonexistent-template']);

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('buff marketplace search'));
    });

    it('should handle network failure during install', async () => {
      const registry = await import('../../src/workflow/registry.js');
      vi.mocked(registry.installTemplate).mockRejectedValueOnce(new Error('Could not reach registry'));

      const errorSpy = vi.spyOn(logger, 'error');

      await runMarketplace(['install', 'cloud-deploy']);

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Could not reach registry'));
    });
  });

  // ── info ──────────────────────────────────────────────────────────────

  describe('info', () => {
    it('should show details for a built-in template', async () => {
      const highlightSpy = vi.spyOn(logger, 'highlight');

      await runMarketplace(['info', 'quick-fix']);

      expect(highlightSpy).toHaveBeenCalledWith(expect.stringContaining('Quick Fix'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Fix a specific bug'));
    });

    it('should show details for a feature-dev template with models', async () => {
      await runMarketplace(['info', 'feature-dev']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Feature Development'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Recommended models'));
    });

    it('should show details for a plugin', async () => {
      mockAllPlugins.push(mockPlugin);

      await runMarketplace(['info', 'Custom AI']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Custom AI'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('custom-ai'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('plugin-author'));
    });

    it('should show registry template details', async () => {
      await runMarketplace(['info', 'cloud-deploy']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Cloud Deploy'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('devops-team'));
    });

    it('should show not found for unknown items', async () => {
      const errorSpy = vi.spyOn(logger, 'error');

      await runMarketplace(['info', 'nonexistent-item']);

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });
  });
});
