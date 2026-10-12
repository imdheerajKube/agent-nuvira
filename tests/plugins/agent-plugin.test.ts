/**
 * Agent plugin → ModuleRegistry wiring (`src/plugins/agent-plugin.ts`).
 *
 * WHAT THIS PINS DOWN. Discovery used to build a map that nobody read, so a plugin
 * in ~/.nuvira/agents/ appeared in `nuvira plugins list` while the orchestrator —
 * which resolves agents through the ModuleRegistry — had no way to run it. These
 * tests assert the wiring that makes a plugin executable, and that a plugin which
 * replaces a BUILT-IN type is reported rather than silently winning.
 *
 * No filesystem and no subprocess: `installAgentPlugins` takes the map and the
 * registry, so the wiring is testable without a temp plugin directory. The second
 * half below drives the DISCOVERY half too (drop a file in, it loads, it runs) —
 * which is only possible because the plugin dirs now resolve through the same
 * `$NUVIRA_CONFIG_DIR` override every other state path honours. Before that they
 * were module-level constants pointing at the developer's real `~/.nuvira`, so a
 * test could only have written there or not tested it at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discoverAgentPlugins,
  installAgentPlugins,
  pluginDirectories,
  runAutoDiscovery,
  type AgentPlugin,
} from '../../src/plugins/agent-plugin.js';
import { ModuleRegistry, getModuleRegistry } from '../../src/agents/module-registry.js';
import type { AgentContext } from '../../src/agents/agent.js';

const context = (): AgentContext =>
  ({
    goal: 'do the thing',
    workingDirectory: process.cwd(),
    taskPlan: [],
    artifacts: [],
    conversations: [],
    fileChanges: [],
    metadata: {},
  }) as AgentContext;

const plugin = (agentTypes: string[], summary = 'ran'): AgentPlugin => ({
  metadata: { name: 'Test Plugin', version: '1.0.0', description: 'test', agentTypes },
  execute: vi.fn(async () => ({ success: true, summary })),
});

describe('installAgentPlugins', () => {
  it('makes a plugin executable for every agent type it declares', async () => {
    const registry = new ModuleRegistry();
    const p = plugin(['release-notes', 'changelog-writer']);

    const result = installAgentPlugins(new Map([['release-notes', p], ['changelog-writer', p]]), registry);

    expect(result.registered.sort()).toEqual(['changelog-writer', 'release-notes']);
    expect(result.shadowed).toEqual([]);
    expect(registry.hasModule('release-notes')).toBe(true);
    expect(registry.getMetadata('release-notes')).toMatchObject({
      name: 'Test Plugin',
      description: 'test',
      icon: '🧩', // plugin metadata carries no icon, so the spinner gets a real one
      isBuiltin: false,
    });

    // The registry's factory must produce something the orchestrator can run.
    const instance = registry.getModule('release-notes');
    const value = await instance.execute(context(), async () => 'unused');
    expect(value).toEqual({ success: true, summary: 'ran' });
    expect(p.execute).toHaveBeenCalledOnce();
    expect(instance.name).toBe('Test Plugin');
  });

  it('reports a plugin that replaces a built-in agent type instead of hiding it', () => {
    const registry = ModuleRegistry.createWithBuiltins();
    expect(registry.getMetadata('writer')?.isBuiltin).toBe(true);

    const result = installAgentPlugins(new Map([['writer', plugin(['writer'])]]), registry);

    expect(result.shadowed).toEqual(['writer']);
    expect(result.registered).toEqual(['writer']);
    // The override took effect — and is now attributed to the plugin, not the harness.
    expect(registry.getMetadata('writer')?.isBuiltin).toBe(false);
    expect(registry.getMetadata('writer')?.name).toBe('Test Plugin');
  });

  it('re-registering the same type does not throw (registerOrOverride, not register)', () => {
    const registry = new ModuleRegistry();
    installAgentPlugins(new Map([['mine', plugin(['mine'], 'first')]]), registry);
    expect(() => installAgentPlugins(new Map([['mine', plugin(['mine'], 'second')]]), registry)).not.toThrow();

    const instance = registry.getModule('mine');
    expect(instance).toBeDefined();
  });

  it('an empty discovery is a no-op', () => {
    const registry = new ModuleRegistry();
    expect(installAgentPlugins(new Map(), registry)).toEqual({ registered: [], shadowed: [] });
    expect(registry.size).toBe(0);
  });

  it('leaves the built-ins intact when a plugin adds a new type', () => {
    const registry = ModuleRegistry.createWithBuiltins();
    const before = registry.size;

    installAgentPlugins(new Map([['my-custom', plugin(['my-custom'])]]), registry);

    expect(registry.size).toBe(before + 1);
    expect(registry.hasModule('planner')).toBe(true);
    expect(registry.getMetadata('planner')?.isBuiltin).toBe(true);
  });
});

// ─── The discovery half, in a profile of its own ──────────────────────────────
/**
 * A plugin file that satisfies the documented contract: a DEFAULT export with
 * `metadata.agentTypes` and `execute`.
 */
function agentPluginFile(agentTypes: string[], summary = 'ran'): string {
  return [
    'const metadata = ' + JSON.stringify({ name: 'Isolated Plugin', version: '1.0.0', description: 'from a temp profile', agentTypes }) + ';',
    'async function execute() { return { success: true, summary: ' + JSON.stringify(summary) + ' }; }',
    'export default { metadata, execute };',
    '',
  ].join('\n');
}

describe('discovery in an isolated profile', () => {
  let profile: string;
  const previous = process.env.NUVIRA_CONFIG_DIR;

  beforeEach(() => {
    profile = mkdtempSync(join(tmpdir(), 'nuvira-plugins-'));
    process.env.NUVIRA_CONFIG_DIR = profile;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = previous;
    rmSync(profile, { recursive: true, force: true });
  });

  it('reads and writes the PROFILE`s dirs, never the developer`s own', () => {
    // The measured defect: a boot from an isolated run created `package.json`
    // markers in the real `~/.nuvira/agents/`. The resolved dirs are what the
    // CLI NAMES in its output too, so the listing can never point at a directory
    // the process did not read.
    expect(pluginDirectories()).toEqual({
      provider: join(profile, 'plugins'),
      agents: join(profile, 'agents'),
      workflows: join(profile, 'workflows'),
    });
  });

  it('finds a plugin on disk and installs it as an agent the orchestrator can run', async () => {
    const agents = join(profile, 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'isolated.js'), agentPluginFile(['isolated-writer'], 'from the temp profile'));

    const discovered = await discoverAgentPlugins();
    expect([...discovered.keys()]).toEqual(['isolated-writer']);

    const registry = new ModuleRegistry();
    const installed = installAgentPlugins(discovered, registry);
    expect(installed.registered).toEqual(['isolated-writer']);

    // The end of the claim: the registry hands out something RUNNABLE, and the
    // plugin's own code is what ran.
    const instance = registry.getModule('isolated-writer');
    await expect(instance.execute(context(), async () => 'unused')).resolves.toEqual({
      success: true,
      summary: 'from the temp profile',
    });
  });

  it('skips a file that does not export the documented default', async () => {
    // Named exports are not the contract, and a silent skip is the correct
    // answer — an agent type registered from a file nobody can execute is the bug
    // this whole path exists to prevent.
    const agents = join(profile, 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'named.js'), 'export const metadata = { agentTypes: ["nope"] };\n');
    writeFileSync(join(agents, 'notes.txt'), 'not a plugin\n');

    expect((await discoverAgentPlugins()).size).toBe(0);
  });

  it('marks the dirs as ES modules only while they hold no plugin', async () => {
    // The marker is what stops Node printing a MODULE_TYPELESS_PACKAGE_JSON
    // warning per boot per plugin. It is deliberately NOT written into a dir that
    // already holds `.js` files: adding it would reinterpret a user's working
    // CommonJS plugin as ESM, where `module.exports` throws.
    const agents = join(profile, 'agents');
    mkdirSync(agents, { recursive: true });
    await discoverAgentPlugins();
    expect(JSON.parse(readFileSync(join(agents, 'package.json'), 'utf-8'))).toEqual({ type: 'module' });

    writeFileSync(join(agents, 'existing.js'), 'module.exports = {};\n');
    rmSync(join(agents, 'package.json'));
    await discoverAgentPlugins();
    expect(existsSync(join(agents, 'package.json'))).toBe(false);
  });

  it('reports the discovered plugin through the boot path a turn takes', async () => {
    // `runAutoDiscovery()` is what the CLI entry calls before parsing any command,
    // and the orchestrator resolves plan steps through the same ModuleRegistry —
    // so this is the boot-to-runnable path, not a copy of it.
    const agents = join(profile, 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'boot.js'), agentPluginFile(['isolated-boot-agent']));

    const discovered = await runAutoDiscovery();
    expect(discovered.agentTypes).toContain('isolated-boot-agent');
    expect(discovered.shadowedAgentTypes).not.toContain('isolated-boot-agent');
    expect(getModuleRegistry().hasModule('isolated-boot-agent')).toBe(true);
  });
});

describe('runAutoDiscovery wiring', () => {
  it('returns the agent types it registered, so a caller can report them', async () => {
    const discovered = await runAutoDiscovery();

    // The shape matters: discovery must not silently discard the plugin map.
    expect(Array.isArray(discovered.agentTypes)).toBe(true);
    expect(Array.isArray(discovered.shadowedAgentTypes)).toBe(true);
    expect(typeof discovered.providerPlugins).toBe('number');
    expect(typeof discovered.agentPlugins).toBe('number');
    expect(typeof discovered.workflowPlugins).toBe('number');
  });
});
