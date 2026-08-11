/**
 * F2 — MCPClient unit tests on the official @modelcontextprotocol/sdk.
 *
 * Replaces the old mock-based suite (which mocked node:child_process spawn +
 * node:readline against the hand-rolled JSON-RPC loop). The SDK client is
 * driven here through an IN-MEMORY Transport (the test seam injected via the
 * optional transportFactory constructor param) — no subprocesses, no sockets,
 * deterministic. The real-subprocess path is covered by mcp-e2e.test.ts.
 *
 * The FakeTransport implements the SDK Transport interface and replies like a
 * tiny MCP server, letting the SDK's own initialize/discovery flow run for
 * real against our wrapper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPClient } from '../../src/mcp/client.js';
import type { MCPServerConfig } from '../../src/mcp/types.js';

// ─── In-memory transport (SDK Transport interface) ──────────────────────────

class FakeTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;
  sent: unknown[] = [];
  closed = false;

  constructor(private respond: (msg: any, t: FakeTransport) => void) {}

  async start(): Promise<void> { /* no-op */ }

  async send(message: unknown): Promise<void> {
    this.sent.push(message);
    this.respond(message as any, this);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.onclose?.();
  }

  /** Send a JSON-RPC result response for `id`. */
  reply(id: unknown, result: unknown): void {
    this.onmessage?.({ jsonrpc: '2.0', id, result });
  }

  /** Send a JSON-RPC error response for `id`. */
  errorReply(id: unknown, code: number, message: string): void {
    this.onmessage?.({ jsonrpc: '2.0', id, error: { code, message } });
  }
}

const DEFAULT_SERVER_INFO = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: 'test-mcp-server', version: '1.0.0' },
};

/** A tiny MCP server responder for the happy path. */
function defaultResponder(msg: any, t: FakeTransport): void {
  if (msg.id === undefined || msg.method === undefined) return; // notification
  switch (msg.method) {
    case 'initialize':
      t.reply(msg.id, DEFAULT_SERVER_INFO);
      break;
    case 'tools/list':
      t.reply(msg.id, { tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }] });
      break;
    case 'resources/list':
      t.reply(msg.id, { resources: [{ uri: 'file:///tmp/t', name: 'test' }] });
      break;
    case 'prompts/list':
      t.reply(msg.id, { prompts: [{ name: 'greet', description: 'Greeting' }] });
      break;
    case 'tools/call':
      t.reply(msg.id, { content: [{ type: 'text', text: 'Hello from tool' }] });
      break;
    case 'resources/read':
      t.reply(msg.id, { contents: [{ uri: msg.params?.uri, text: 'Hello from resource' }] });
      break;
    case 'prompts/get':
      t.reply(msg.id, { description: 'A greeting prompt', messages: [{ role: 'user', content: { type: 'text', text: 'Hello!' } }] });
      break;
    default:
      t.reply(msg.id, {});
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeClient(
  overrides: Partial<MCPServerConfig> = {},
  timeoutMs = 5000,
): { client: MCPClient; transport: FakeTransport } {
  const transport = new FakeTransport(defaultResponder);
  const client = new MCPClient(
    { name: 'test-server', transport: 'stdio', command: 'node', enabled: true, ...overrides },
    timeoutMs,
    () => transport as any,
  );
  return { client, transport };
}

function makeConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return { name: 'test-server', transport: 'stdio', command: 'node', enabled: true, ...overrides };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MCPClient — constructor & basic properties', () => {
  it('creates a client with the given config', () => {
    const { client } = makeClient();
    expect(client.name).toBe('test-server');
    expect(client.connected).toBe(false);
    expect(client.tools).toEqual([]);
    expect(client.serverInfo).toBeNull();
  });

  it('accepts custom timeout', () => {
    expect(new MCPClient(makeConfig(), 5000).name).toBe('test-server');
  });

  it('starts in disconnected state', () => {
    const { client } = makeClient();
    expect(client.state.status).toBe('disconnected');
  });

  it('disconnect without connect is safe', () => {
    expect(() => new MCPClient(makeConfig()).disconnect()).not.toThrow();
  });
});

describe('MCPClient — connection lifecycle (SDK handshake)', () => {
  it('connects and reports the server info from the initialize handshake', async () => {
    const { client } = makeClient();
    await client.connect();
    expect(client.connected).toBe(true);
    expect(client.serverInfo!.name).toBe('test-mcp-server');
    expect(client.serverInfo!.version).toBe('1.0.0');
  });

  it('is a no-op when already connected', async () => {
    const { client } = makeClient();
    await client.connect();
    await expect(client.connect()).resolves.toBeUndefined();
    expect(client.connected).toBe(true);
  });

  it('emits lifecycle events once each', async () => {
    const { client } = makeClient();
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();
    client.on('connected', onConnected);
    client.on('disconnected', onDisconnected);

    await client.connect();
    expect(onConnected).toHaveBeenCalledTimes(1);

    client.disconnect();
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(client.connected).toBe(false);
    expect(client.serverInfo).toBeNull();
  });

  it('disconnects cleanly and rejects in-flight calls', async () => {
    // A responder that answers discovery but NEVER answers tools/call, so the
    // call stays in flight until disconnect tears the transport down.
    const transport = new FakeTransport((msg: any, t: FakeTransport) => {
      if (msg.id === undefined || msg.method === undefined) return;
      if (msg.method === 'initialize') return t.reply(msg.id, DEFAULT_SERVER_INFO);
      if (msg.method === 'tools/list') return t.reply(msg.id, { tools: [] });
      if (msg.method === 'resources/list') return t.reply(msg.id, { resources: [] });
      if (msg.method === 'prompts/list') return t.reply(msg.id, { prompts: [] });
      // tools/call deliberately unanswered.
    });
    const client = new MCPClient(makeConfig(), 5000, () => transport as any);
    await client.connect();

    const callPromise = client.callTool('cmd');
    client.disconnect();

    expect(client.connected).toBe(false);
    await expect(callPromise).rejects.toThrow();
  });

  it('multiple disconnect calls are safe', async () => {
    const { client } = makeClient();
    await client.connect();
    client.disconnect();
    expect(() => client.disconnect()).not.toThrow();
  });

  it('throws when a stdio config has no command', async () => {
    const client = new MCPClient({ name: 'bad', transport: 'stdio', enabled: true });
    await expect(client.connect()).rejects.toThrow(/No command/i);
    try { client.disconnect(); } catch { /* ignore */ }
  });

  it('throws when an sse config has no URL', async () => {
    const client = new MCPClient({ name: 'bad', transport: 'sse', enabled: true });
    await expect(client.connect()).rejects.toThrow(/No URL/i);
    try { client.disconnect(); } catch { /* ignore */ }
  });

  it('emits exactly one error event on connect failure', async () => {
    const transport = new FakeTransport(() => { /* never responds */ });
    const client = new MCPClient(makeConfig(), 60, () => transport as any);
    const onError = vi.fn();
    client.on('error', onError);

    await expect(client.connect()).rejects.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    try { client.disconnect(); } catch { /* ignore */ }
  });
});

describe('MCPClient — tool & resource discovery / invocation', () => {
  let client: MCPClient;
  let transport: FakeTransport;

  beforeEach(async () => {
    ({ client, transport } = makeClient());
    await client.connect();
  });

  afterEach(() => {
    try { client.disconnect(); } catch { /* ignore */ }
  });

  it('discovers tools during connect (tools cache populated)', () => {
    expect(client.tools).toHaveLength(1);
    expect(client.tools[0].name).toBe('read');
  });

  it('calls a tool and returns its content blocks', async () => {
    const result = await client.callTool('read', { path: '/tmp/x' });
    expect(result.content).toHaveLength(1);
    expect((result.content[0] as { text: string }).text).toBe('Hello from tool');
    // The SDK must have sent the name + arguments over the transport.
    const call = transport.sent.find((m: any) => m.method === 'tools/call');
    expect(call).toBeDefined();
    expect((call as any).params.name).toBe('read');
    expect((call as any).params.arguments).toEqual({ path: '/tmp/x' });
  });

  it('re-lists tools on demand and refreshes the cache', async () => {
    // Override the responder so the next tools/list returns a different set.
    transport.respond = (msg: any, t: FakeTransport) => {
      if (msg.id === undefined || msg.method === undefined) return;
      if (msg.method === 'initialize') return t.reply(msg.id, DEFAULT_SERVER_INFO);
      if (msg.method === 'tools/list') return t.reply(msg.id, { tools: [{ name: 'write', description: 'Write', inputSchema: { type: 'object' } }] });
      if (msg.method === 'resources/list') return t.reply(msg.id, { resources: [] });
      if (msg.method === 'prompts/list') return t.reply(msg.id, { prompts: [] });
      t.reply(msg.id, {});
    };
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(client.tools[0].name).toBe('write');
  });

  it('lists resources', async () => {
    const resources = await client.listResources();
    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe('file:///tmp/t');
    expect(client.resources[0].uri).toBe('file:///tmp/t');
  });

  it('reads a text resource by URI', async () => {
    const result = await client.readResource('file:///tmp/test.txt');
    expect(result.type).toBe('text');
    expect((result as { text: string }).text).toBe('Hello from resource');
  });

  it('lists prompts', async () => {
    const prompts = await client.listPrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].name).toBe('greet');
  });

  it('gets a prompt by name', async () => {
    const result = await client.getPrompt('greet') as { description: string };
    expect(result.description).toBe('A greeting prompt');
  });

  it('rejects tool calls before connecting', async () => {
    const dc = new MCPClient(makeConfig());
    await expect(dc.callTool('x')).rejects.toThrow(/Not connected/i);
    await expect(dc.listTools()).rejects.toThrow(/Not connected/i);
    await expect(dc.readResource('file:///x')).rejects.toThrow(/Not connected/i);
    await expect(dc.getPrompt('p')).rejects.toThrow(/Not connected/i);
  });
});

describe('MCPClient — JSON-RPC error propagation', () => {
  it('rejects a tool call with the server error message', async () => {
    const transport = new FakeTransport((msg: any, t: FakeTransport) => {
      if (msg.id === undefined || msg.method === undefined) return;
      if (msg.method === 'initialize') return t.reply(msg.id, DEFAULT_SERVER_INFO);
      if (msg.method === 'tools/list') return t.reply(msg.id, { tools: [] });
      if (msg.method === 'resources/list') return t.reply(msg.id, { resources: [] });
      if (msg.method === 'prompts/list') return t.reply(msg.id, { prompts: [] });
      if (msg.method === 'tools/call') return t.errorReply(msg.id, -32603, 'Internal error: something went wrong');
      t.reply(msg.id, {});
    });
    const client = new MCPClient(makeConfig(), 5000, () => transport as any);
    await client.connect();
    await expect(client.callTool('boom')).rejects.toThrow(/Internal error/);
    try { client.disconnect(); } catch { /* ignore */ }
  });

  it('rejects a tool call with method-not-found', async () => {
    const transport = new FakeTransport((msg: any, t: FakeTransport) => {
      if (msg.id === undefined || msg.method === undefined) return;
      if (msg.method === 'initialize') return t.reply(msg.id, DEFAULT_SERVER_INFO);
      if (msg.method === 'tools/list') return t.reply(msg.id, { tools: [] });
      if (msg.method === 'resources/list') return t.reply(msg.id, { resources: [] });
      if (msg.method === 'prompts/list') return t.reply(msg.id, { prompts: [] });
      if (msg.method === 'tools/call') return t.errorReply(msg.id, -32601, 'Method not found');
      t.reply(msg.id, {});
    });
    const client = new MCPClient(makeConfig(), 5000, () => transport as any);
    await client.connect();
    await expect(client.callTool('nope')).rejects.toThrow(/Method not found/);
    try { client.disconnect(); } catch { /* ignore */ }
  });
});

describe('MCPClient — timeouts', () => {
  it('rejects with a timeout when the server never responds', async () => {
    const transport = new FakeTransport(() => { /* never replies */ });
    const client = new MCPClient(makeConfig(), 80, () => transport as any);
    const onError = vi.fn();
    client.on('error', onError);

    await expect(client.connect()).rejects.toThrow(/timed out|timeout/i);
    expect(onError).toHaveBeenCalledTimes(1);
    try { client.disconnect(); } catch { /* ignore */ }
  });
});

describe('MCPClient — SSE (Streamable HTTP) transport', () => {
  it('rejects an unreachable endpoint with a wrapped connect error', async () => {
    // Real StreamableHTTPClientTransport (no factory): port 9 refuses fast.
    const client = new MCPClient(
      { name: 'test-sse', transport: 'sse', url: 'http://127.0.0.1:9/mcp', enabled: true },
      1500,
    );
    const onError = vi.fn();
    client.on('error', onError);

    await expect(client.connect()).rejects.toThrow(/Failed to connect/i);
    expect(onError).toHaveBeenCalledTimes(1);
    try { client.disconnect(); } catch { /* ignore */ }
  }, 10_000);
});
