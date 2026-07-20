/**
 * Unit tests for MCPClient — stdio and SSE transports, tool discovery,
 * tool invocation, timeout handling, and connection lifecycle.
 *
 * Mocks child_process.spawn and readline.createInterface for fast,
 * deterministic unit testing without real subprocesses.
 *
 * Uses vi.hoisted() to set up mock state before vi.mock() factories run,
 * avoiding the temporal-dead-zone error that occurs when module-level
 * let/const variables are referenced inside a hoisted mock factory.
 *
 * IMPORTANT: Mock responses must be deferred with setTimeout(fn, 0) because
 * the connect() method does `await connectStdio()` then `await initialize()`,
 * and both awaits yield to the microtask queue. If we sent responses
 * synchronously, they'd arrive before initialize() sends the request.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPClient } from '../../src/mcp/client.js';
import type { MCPServerConfig } from '../../src/mcp/types.js';

// ─── Hoisted mock state (runs BEFORE vi.mock factories) ─────────────────────

const mcpMockState = vi.hoisted(() => ({
  spawn: vi.fn(() => ({
    stdin: { writable: true, write: vi.fn() },
    stdout: { readable: true, resume: vi.fn(), pause: vi.fn(), setEncoding: vi.fn() },
    stderr: { readable: true, on: vi.fn() },
    killed: false,
    kill: vi.fn(function() { this.killed = true; }),
    on: vi.fn(),
  })),
}));

const lineCallbackRef = vi.hoisted(() => ({ current: null as ((_: string) => void) | null }));

// ─── Mock child_process ─────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  spawn: mcpMockState.spawn,
}));

// ─── Mock readline ──────────────────────────────────────────────────────────

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    close: vi.fn(),
    on: vi.fn((event: string, cb: any) => {
      if (event === 'line') lineCallbackRef.current = cb;
    }),
  })),
}));

// ─── Mock global.fetch for SSE tests ────────────────────────────────────────

const originalFetch = globalThis.fetch;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Simulate a server JSON-RPC response line */
function simulateResponse(id: number | string, result: unknown): void {
  if (lineCallbackRef.current) {
    lineCallbackRef.current(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }
}

/**
 * Connect a client with deferred mock responses.
 *
 * The connect() flow is:
 *   connect() → await connectStdio() → await initialize() → set _connected →
 *   discoverCapabilities() → listTools() → listResources() → listPrompts()
 *
 * Each await yields to the microtask queue. setTimeout(fn, 0) fires as a
 * macrotask AFTER all pending microtasks, so we can use it to synchronize.
 *
 * We must stagger the responses (one per macrotask) because each response
 * triggers the next request in the chain:
 *   response(1) → initialize resolves → discoverCapabilities calls listTools
 *   response(2) → listTools resolves → listResources is called
 *   response(3) → listResources resolves → listPrompts is called
 *   response(4) → listPrompts resolves → connect finishes
 */
async function connectWithMock(client: MCPClient): Promise<void> {
  const promise = client.connect();

  // Phase 1: Let connectStdio() run (synchronous spawn + readline setup)
  await new Promise(resolve => setTimeout(resolve, 0));
  // Now initialize() has called sendRequest('initialize') — request id 1 pending

  simulateResponse(1, {
    protocolVersion: '2025-06-18',
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: 'test-mcp-server', version: '1.0.0' },
  });

  // Phase 2: Let initialize() resolve and discoverCapabilities() start
  await new Promise(resolve => setTimeout(resolve, 0));
  // Now listTools() has called sendRequest('tools/list') — request id 2 pending

  simulateResponse(2, { tools: [] });

  // Phase 3: Let listTools() resolve and listResources() start
  await new Promise(resolve => setTimeout(resolve, 0));
  // Now listResources() has called sendRequest('resources/list') — request id 3 pending

  simulateResponse(3, { resources: [] });

  // Phase 4: Let listResources() resolve and listPrompts() start
  await new Promise(resolve => setTimeout(resolve, 0));
  // Now listPrompts() has called sendRequest('prompts/list') — request id 4 pending

  simulateResponse(4, { prompts: [] });

  await promise;
}

/** Send a tool-call response, deferred by one macrotask */
async function respondLater(id: number, result: unknown): Promise<void> {
  return new Promise(resolve => {
    setTimeout(() => {
      simulateResponse(id, result);
      resolve();
    }, 0);
  });
}

// ─── Config Factories ───────────────────────────────────────────────────────

function createStdioConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    name: 'test-server',
    transport: 'stdio',
    command: 'node',
    args: ['-e', ''],
    enabled: true,
    ...overrides,
  };
}

function createSSEConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    name: 'test-sse',
    transport: 'sse',
    url: 'http://localhost:9999/sse',
    enabled: true,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MCPClient — Constructor & Basic Properties', () => {
  it('creates a client with the given config', () => {
    const client = new MCPClient(createStdioConfig());
    expect(client.name).toBe('test-server');
    expect(client.connected).toBe(false);
    expect(client.tools).toEqual([]);
    expect(client.serverInfo).toBeNull();
  });

  it('accepts custom timeout', () => {
    expect(new MCPClient(createStdioConfig(), 5000).name).toBe('test-server');
  });

  it('starts in disconnected state', () => {
    const client = new MCPClient(createStdioConfig());
    expect(client.state.status).toBe('disconnected');
  });
});

describe('MCPClient — stdio Connection', () => {
  let client: MCPClient;

  beforeEach(() => {
    vi.clearAllMocks();
    lineCallbackRef.current = null;
    client = new MCPClient(createStdioConfig(), 5000);
  });

  afterEach(() => {
    try { client.disconnect(); } catch { /* ignore */ }
  });

  it('connects via stdio with handshake', async () => {
    await connectWithMock(client);
    expect(client.connected).toBe(true);
    expect(client.serverInfo!.name).toBe('test-mcp-server');
  });

  it('throws when command is missing', async () => {
    const bad = new MCPClient({ name: 'bad', transport: 'stdio', enabled: true });
    await expect(bad.connect()).rejects.toThrow(/No command/i);
  });

  it('is no-op when already connected', async () => {
    await connectWithMock(client);
    await expect(client.connect()).resolves.toBeUndefined();
  });

  it('disconnects and rejects pending requests', async () => {
    await connectWithMock(client);

    const callPromise = client.callTool('cmd');
    client.disconnect();

    expect(client.connected).toBe(false);
    await expect(callPromise).rejects.toThrow();
  });

  it('emits lifecycle events', async () => {
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();
    client.on('connected', onConnected);
    client.on('disconnected', onDisconnected);

    await connectWithMock(client);
    expect(onConnected).toHaveBeenCalledTimes(1);

    client.disconnect();
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });
});

describe('MCPClient — Tool Discovery & Invocation', () => {
  let client: MCPClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    lineCallbackRef.current = null;
    client = new MCPClient(createStdioConfig(), 5000);
    await connectWithMock(client);
  });

  afterEach(() => {
    try { client.disconnect(); } catch { /* ignore */ }
  });

  it('lists tools', async () => {
    const p = client.listTools();
    await respondLater(5, { tools: [{ name: 'read', description: 'Read a file' }] });
    const tools = await p;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('read');
  });

  it('calls a tool and returns result', async () => {
    const p = client.callTool('hello', { name: 'world' });
    await respondLater(5, { content: [{ type: 'text', text: 'Hello!' }] });
    const result = await p;
    expect(result.content).toHaveLength(1);
    expect((result.content[0] as any).text).toBe('Hello!');
  });

  it('updates tools cache', async () => {
    expect(client.tools).toEqual([]);
    const p = client.listTools();
    await respondLater(5, { tools: [{ name: 'write', description: 'Write' }] });
    await p;
    expect(client.tools).toHaveLength(1);
    expect(client.tools[0].name).toBe('write');
  });

  it('lists resources', async () => {
    const p = client.listResources();
    await respondLater(5, { resources: [{ uri: 'file:///tmp/t', name: 'test' }] });
    const resources = await p;
    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe('file:///tmp/t');
  });

  it('lists prompts', async () => {
    const p = client.listPrompts();
    await respondLater(5, { prompts: [{ name: 'greet', description: 'Greeting' }] });
    const prompts = await p;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].name).toBe('greet');
  });

  it('rejects tool call before connecting', async () => {
    const dc = new MCPClient(createStdioConfig());
    await expect(dc.callTool('x')).rejects.toThrow(/Not connected/i);
  });
});

describe('MCPClient — Timeout Handling', () => {
  it('rejects with timeout when no response', async () => {
    const client = new MCPClient(createStdioConfig(), 100);
    await expect(client.connect()).rejects.toThrow(/timed out/i);
    try { client.disconnect(); } catch { /* ignore */ }
  });
});

describe('MCPClient — SSE Transport', () => {
  beforeEach(() => {
    // Mock fetch to always reject for SSE tests
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects unreachable endpoint', async () => {
    const client = new MCPClient(createSSEConfig(), 1000);
    await expect(client.connect()).rejects.toThrow(/Failed to connect/i);
    try { client.disconnect(); } catch { /* ignore */ }
  });

  it('rejects missing URL', async () => {
    const client = new MCPClient({ name: 'bad', transport: 'sse', enabled: true });
    await expect(client.connect()).rejects.toThrow(/No URL/i);
  });
});

describe('MCPClient — Edge Cases', () => {
  it('disconnect without connect is safe', () => {
    expect(() => new MCPClient(createStdioConfig()).disconnect()).not.toThrow();
  });

  it('multiple disconnect calls are safe', async () => {
    const client = new MCPClient(createStdioConfig(), 5000);
    await connectWithMock(client);
    client.disconnect();
    expect(() => client.disconnect()).not.toThrow();
  });

  it('returns empty state before connect', () => {
    const client = new MCPClient(createStdioConfig());
    expect(client.tools).toEqual([]);
    expect(client.state.status).toBe('disconnected');
  });
});

describe('MCPClient — JSON-RPC Error Responses', () => {
  let client: MCPClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    lineCallbackRef.current = null;
    client = new MCPClient(createStdioConfig(), 5000);
    await connectWithMock(client);
  });

  afterEach(() => {
    try { client.disconnect(); } catch { /* ignore */ }
  });

  it('rejects tool call with JSON-RPC error response', async () => {
    const p = client.callTool('fail');
    // Simulate an error response from the server
    await new Promise(resolve => setTimeout(() => {
      if (lineCallbackRef.current) {
        lineCallbackRef.current(JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          error: { code: -32603, message: 'Internal error: something went wrong' },
        }));
      }
      resolve(undefined);
    }, 0));

    await expect(p).rejects.toThrow(/MCP RPC Error \(-32603\)/);
  });

  it('rejects tool call with method-not-found error', async () => {
    const p = client.callTool('nonexistent');
    await new Promise(resolve => setTimeout(() => {
      if (lineCallbackRef.current) {
        lineCallbackRef.current(JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          error: { code: -32601, message: 'Method not found' },
        }));
      }
      resolve(undefined);
    }, 0));

    await expect(p).rejects.toThrow(/Method not found/);
  });

  it('rejects tool call with invalid-params error', async () => {
    const p = client.callTool('bad_args', { foo: 'bar' });
    await new Promise(resolve => setTimeout(() => {
      if (lineCallbackRef.current) {
        lineCallbackRef.current(JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          error: { code: -32602, message: 'Invalid params: expected string, got object', data: { path: ['foo'] } },
        }));
      }
      resolve(undefined);
    }, 0));

    await expect(p).rejects.toThrow(/Invalid params/);
  });
});

describe('MCPClient — Resource Access (readResource)', () => {
  let client: MCPClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    lineCallbackRef.current = null;
    client = new MCPClient(createStdioConfig(), 5000);
    await connectWithMock(client);
  });

  afterEach(() => {
    try { client.disconnect(); } catch { /* ignore */ }
  });

  it('reads a text resource by URI', async () => {
    const p = client.readResource('file:///tmp/test.txt');
    await respondLater(5, { type: 'text', text: 'Hello from resource' });
    const result = await p;
    expect(result).toBeDefined();
    expect(result.type).toBe('text');
    expect((result as any).text).toBe('Hello from resource');
  });

  it('reads an embedded resource by URI', async () => {
    const p = client.readResource('file:///tmp/data.json');
    await respondLater(5, {
      type: 'resource',
      resource: { uri: 'file:///tmp/data.json', mimeType: 'application/json', text: '{"key": "value"}' },
    });
    const result = await p;
    expect(result.type).toBe('resource');
    const resource = (result as any).resource;
    expect(resource.uri).toBe('file:///tmp/data.json');
    expect(resource.text).toContain('"key"');
  });

  it('rejects readResource before connecting', async () => {
    const dc = new MCPClient(createStdioConfig());
    await expect(dc.readResource('file:///x')).rejects.toThrow(/Not connected/i);
  });
});

describe('MCPClient — Prompt Access (getPrompt)', () => {
  let client: MCPClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    lineCallbackRef.current = null;
    client = new MCPClient(createStdioConfig(), 5000);
    await connectWithMock(client);
  });

  afterEach(() => {
    try { client.disconnect(); } catch { /* ignore */ }
  });

  it('gets a prompt by name', async () => {
    const p = client.getPrompt('greet');
    await respondLater(5, {
      description: 'A greeting prompt',
      messages: [{ role: 'user', content: { type: 'text', text: 'Hello!' } }],
    });
    const result = await p as any;
    expect(result.description).toBe('A greeting prompt');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content.text).toBe('Hello!');
  });

  it('gets a prompt with arguments', async () => {
    const p = client.getPrompt('review_code', { file: 'src/main.ts', language: 'typescript' });
    await respondLater(5, {
      description: 'Code review prompt',
      messages: [{ role: 'user', content: { type: 'text', text: 'Review this code' } }],
    });
    const result = await p as any;
    expect(result.description).toBe('Code review prompt');
  });

  it('rejects getPrompt before connecting', async () => {
    const dc = new MCPClient(createStdioConfig());
    await expect(dc.getPrompt('greet')).rejects.toThrow(/Not connected/i);
  });
});

describe('MCPClient — Error Events', () => {
  it('emits error event on connect failure', async () => {
    vi.clearAllMocks();
    lineCallbackRef.current = null;
    const client = new MCPClient(
      { name: 'fail-server', transport: 'stdio', command: 'nonexistent-cmd', enabled: true },
      100,
    );

    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    await expect(client.connect()).rejects.toThrow();
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledWith(expect.any(Error));
    try { client.disconnect(); } catch { /* ignore */ }
  });
});
