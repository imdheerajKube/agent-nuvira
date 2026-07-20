/**
 * Unit tests for MCPManager — server discovery, connection management,
 * unified tool access, and singleton lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { MCPManager, getMCPManager, resetMCPManager } from '../../src/mcp/manager.js';
import type { MCPServerConfig } from '../../src/mcp/types.js';

// ─── Mock MCPClient (defined inside factory to avoid vi.mock hoisting issues) ─

vi.mock('../../src/mcp/client.js', () => {
  class MockMCPClient {
    name: string;
    connected = false;
    tools: any[] = [];
    resources: any[] = [];
    prompts: any[] = [];
    serverInfo: any = null;
    state: any;
    connect: any;
    disconnect: any;
    callTool = vi.fn().mockResolvedValue({ content: [], isError: false });
    listTools = vi.fn().mockResolvedValue([]);
    listResources = vi.fn().mockResolvedValue([]);
    listPrompts = vi.fn().mockResolvedValue([]);
    on = vi.fn();
    emit = vi.fn();

    constructor(config: any) {
      this.name = config.name;
      this.state = {
        name: config.name,
        transport: config.transport,
        status: 'disconnected',
        tools: [],
        resources: [],
        prompts: [],
      };

      // Support partial-failure testing: if command is '__FAIL__', connect rejects.
      const shouldFail = config.command === '__FAIL__';

      this.connect = vi.fn().mockImplementation(async () => {
        if (shouldFail) {
          throw new Error(`MCP[${this.name}]: Connection refused`);
        }
        this.connected = true;
        this.serverInfo = { name: 'test-server', version: '1.0.0' };
        this.state = {
          name: this.name,
          transport: config.transport,
          status: 'connected',
          tools: this.tools,
          resources: this.resources,
          prompts: this.prompts,
          serverInfo: this.serverInfo,
        };
      });
      this.disconnect = vi.fn(() => {
        this.connected = false;
        this.serverInfo = null;
        this.state = { ...this.state, status: 'disconnected' };
      });
    }
  }

  return {
    MCPClient: MockMCPClient,
    createMCPClient: (config: any) => new MockMCPClient(config),
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createTempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-test-'));
}

function writeConfig(dir: string, filename: string, config: MCPServerConfig): void {
  writeFileSync(join(dir, filename), JSON.stringify(config, null, 2));
}

function writeSubConfig(dir: string, subdir: string, config: MCPServerConfig): void {
  const subDirPath = join(dir, subdir);
  mkdirSync(subDirPath, { recursive: true });
  writeFileSync(join(subDirPath, 'config.json'), JSON.stringify(config, null, 2));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MCPManager — Constructor & Config Directory', () => {
  it('creates a manager with default config directory', () => {
    const manager = new MCPManager();
    expect(manager).toBeInstanceOf(MCPManager);
  });

  it('creates a manager with custom config directory', () => {
    const manager = new MCPManager('/tmp/mcp-custom');
    expect(manager).toBeInstanceOf(MCPManager);
  });

  it('discovers zero configs when directory does not exist', () => {
    const manager = new MCPManager('/tmp/nonexistent-mcp-dir');
    const configs = manager.discoverConfigs();
    expect(configs).toEqual([]);
  });
});

describe('MCPManager — Config Discovery', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = createTempConfigDir();
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('discovers JSON config files', () => {
    writeConfig(configDir, 'weather.json', {
      name: 'weather', transport: 'stdio', command: 'npx', args: ['-y', '@mcp/weather'], enabled: true,
    });

    const manager = new MCPManager(configDir);
    const configs = manager.discoverConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe('weather');
  });

  it('discovers multiple JSON config files', () => {
    writeConfig(configDir, 'a.json', { name: 'a', transport: 'stdio', command: 'x', enabled: true });
    writeConfig(configDir, 'b.json', { name: 'b', transport: 'stdio', command: 'x', enabled: true });
    writeConfig(configDir, 'c.json', { name: 'c', transport: 'stdio', command: 'x', enabled: true });

    const manager = new MCPManager(configDir);
    expect(manager.discoverConfigs()).toHaveLength(3);
  });

  it('discovers config.json in subdirectories', () => {
    const subDirPath = join(configDir, 'weather');
    mkdirSync(subDirPath, { recursive: true });
    writeFileSync(join(subDirPath, 'config.json'), JSON.stringify({
      name: 'weather', transport: 'stdio', command: 'npx', enabled: true,
    }));

    const manager = new MCPManager(configDir);
    expect(manager.discoverConfigs()).toHaveLength(1);
  });

  it('ignores non-JSON files', () => {
    writeFileSync(join(configDir, 'notes.txt'), 'not a config');
    const manager = new MCPManager(configDir);
    expect(manager.discoverConfigs()).toEqual([]);
  });

  it('ignores invalid JSON gracefully', () => {
    writeFileSync(join(configDir, 'broken.json'), '{ invalid }');
    const manager = new MCPManager(configDir);
    expect(manager.discoverConfigs()).toEqual([]);
  });
});

describe('MCPManager — Connection Management', () => {
  let configDir: string;
  let manager: MCPManager;

  beforeEach(() => {
    configDir = createTempConfigDir();
    writeConfig(configDir, 'filesystem.json', {
      name: 'filesystem', transport: 'stdio', command: 'node', args: ['-e', ''], enabled: true,
    });
    manager = new MCPManager(configDir);
  });

  afterEach(() => {
    manager.disconnectAll();
    rmSync(configDir, { recursive: true, force: true });
  });

  it('connects to a server by name', async () => {
    const client = await manager.connect('filesystem');
    expect(client).toBeDefined();
    expect(client.name).toBe('filesystem');
    expect(client.connected).toBe(true);
  });

  it('reuses existing client on reconnect', async () => {
    const client1 = await manager.connect('filesystem');
    const client2 = await manager.connect('filesystem');
    expect(client1).toBe(client2);
  });

  it('throws for unknown server', async () => {
    await expect(manager.connect('unknown')).rejects.toThrow(/not found/i);
  });

  it('connects to all discovered servers', async () => {
    writeConfig(configDir, 'weather.json', {
      name: 'weather', transport: 'stdio', command: 'node', enabled: true,
    });
    const clients = await manager.connectAll();
    expect(clients.length).toBeGreaterThanOrEqual(1);
  });

  it('connectAll handles partial failure gracefully', async () => {
    // Add a second server config that will fail to connect
    writeConfig(configDir, 'broken.json', {
      name: 'broken', transport: 'stdio', command: '__FAIL__', enabled: true,
    });

    const clients = await manager.connectAll();
    // Only the working server should be in the result
    expect(clients.length).toBe(1);
    expect(clients[0].name).toBe('filesystem');
    expect(clients[0].connected).toBe(true);

    // The broken server should NOT be connected
    expect(manager.isConnected('broken')).toBe(false);
  });

  it('disconnect unknown server is safe', () => {
    expect(() => manager.disconnect('nonexistent')).not.toThrow();
  });

  it('disconnects a specific server', async () => {
    await manager.connect('filesystem');
    expect(manager.isConnected('filesystem')).toBe(true);
    manager.disconnect('filesystem');
    expect(manager.isConnected('filesystem')).toBe(false);
  });

  it('disconnects all servers', async () => {
    await manager.connect('filesystem');
    manager.disconnectAll();
    expect(manager.isConnected('filesystem')).toBe(false);
  });

  it('returns false for unknown server', () => {
    expect(manager.isConnected('unknown')).toBe(false);
  });
});

describe('MCPManager — Tool Management', () => {
  let configDir: string;
  let manager: MCPManager;

  beforeEach(async () => {
    configDir = createTempConfigDir();
    writeConfig(configDir, 'filesystem.json', {
      name: 'filesystem', transport: 'stdio', command: 'node', enabled: true,
    });
    manager = new MCPManager(configDir);
    await manager.connect('filesystem');
  });

  afterEach(() => {
    manager.disconnectAll();
    rmSync(configDir, { recursive: true, force: true });
  });

  it('getAllTools returns tools across servers', async () => {
    const client = manager.getClient('filesystem')!;
    client.tools = [{ name: 'read', description: 'Read files', inputSchema: {} }];
    client.state.tools = client.tools;

    const allTools = manager.getAllTools();
    expect(allTools).toHaveLength(1);
    expect(allTools[0].server).toBe('filesystem');
    expect(allTools[0].tool.name).toBe('read');
  });

  it('getAllStates returns connected status', () => {
    const states = manager.getAllStates();
    const fs = states.find((s) => s.name === 'filesystem');
    expect(fs).toBeDefined();
    expect(fs!.status).toBe('connected');
  });

  it('getClient returns connected client', () => {
    const client = manager.getClient('filesystem');
    expect(client).toBeDefined();
    expect(client!.connected).toBe(true);
  });

  it('getClient returns undefined after disconnect', async () => {
    manager.disconnect('filesystem');
    expect(manager.getClient('filesystem')).toBeUndefined();
  });

  it('getClient returns undefined for unknown', () => {
    expect(manager.getClient('unknown')).toBeUndefined();
  });

  it('getAllStates shows disconnected after disconnect', async () => {
    manager.disconnect('filesystem');
    const states = manager.getAllStates();
    const fs = states.find((s) => s.name === 'filesystem');
    expect(fs).toBeDefined();
    expect(fs!.status).toBe('disconnected');
  });

  it('callTool returns null when no server has the tool', async () => {
    const result = await manager.callTool('read');
    expect(result).toBeNull();
  });

  it('callTool delegates to correct server when tool exists', async () => {
    const client = manager.getClient('filesystem')!;
    client.tools = [{ name: 'read', description: 'Read', inputSchema: {} }];
    client.callTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'file content' }],
      isError: false,
    });

    const result = await manager.callTool('read', { path: '/tmp/test.txt' });
    expect(result).toBeDefined();
    expect(result!.server).toBe('filesystem');
    expect(result!.result.content[0].text).toBe('file content');
  });

  it('callTool propagates server error when tool returns isError', async () => {
    const client = manager.getClient('filesystem')!;
    client.tools = [{ name: 'risky', description: 'Might fail', inputSchema: {} }];
    client.callTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Something went wrong' }],
      isError: true,
    });

    const result = await manager.callTool('risky');
    expect(result).toBeDefined();
    expect(result!.server).toBe('filesystem');
    expect(result!.result.isError).toBe(true);
    expect((result!.result.content[0] as any).text).toBe('Something went wrong');
  });

  it('callTool propagates client rejection when tool call throws', async () => {
    const client = manager.getClient('filesystem')!;
    client.tools = [{ name: 'crash', description: 'Crashes on call', inputSchema: {} }];
    client.callTool = vi.fn().mockRejectedValue(new Error('Process crashed'));

    // callTool in the manager doesn't catch errors — it propagates them
    await expect(manager.callTool('crash')).rejects.toThrow(/Process crashed/i);
  });

  it('getClient returns undefined after disconnect of unknown server', () => {
    // disconnect an unknown server — should be safe
    manager.disconnect('unknown-server');
    expect(manager.getClient('unknown-server')).toBeUndefined();
  });
});

describe('MCPManager — Singleton', () => {
  afterEach(() => { resetMCPManager(); });

  it('returns the same instance', () => {
    expect(getMCPManager()).toBe(getMCPManager());
  });

  it('reset creates new instance', () => {
    const a = getMCPManager();
    resetMCPManager();
    expect(getMCPManager()).not.toBe(a);
  });

  it('reset works when no singleton exists', () => {
    resetMCPManager();
    expect(getMCPManager()).toBeInstanceOf(MCPManager);
  });
});
