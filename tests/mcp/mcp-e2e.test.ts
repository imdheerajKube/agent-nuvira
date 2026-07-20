/**
 * Integration tests for MCPClient — end-to-end with a real subprocess.
 *
 * Unlike the unit tests in mcp-client.test.ts which mock child_process.spawn
 * and readline, these tests actually spawn a real Node.js subprocess and
 * communicate via real stdin/stdout pipes.
 *
 * The mock server script is created dynamically in beforeAll and cleaned up
 * in afterAll, so the test is self-contained and doesn't depend on external
 * files.
 *
 * The mock server handles:
 *   - initialize handshake (serverInfo, capabilities)
 *   - tools/list (returns 2 tools: greet and echo)
 *   - resources/list (returns empty)
 *   - prompts/list (returns empty)
 *   - tools/call (echoes the tool name back)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MCPClient } from '../../src/mcp/client.js';
import type { MCPServerConfig } from '../../src/mcp/types.js';

// ─── Self-contained mock server script ──────────────────────────────────────

const MOCK_SERVER_PATH = join(tmpdir(), 'mcp-e2e-integration-test-' + Date.now() + '.js');

const MOCK_SERVER_SCRIPT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && msg.method) {
      const response = { jsonrpc: '2.0', id: msg.id };
      switch (msg.method) {
        case 'initialize':
          response.result = {
            protocolVersion: '2025-06-18',
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'mock-test-server', version: '1.0.0' },
          };
          console.log(JSON.stringify(response));
          return;
        case 'tools/list':
          response.result = {
            tools: [
              { name: 'greet', description: 'Greet a user by name', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
              { name: 'echo', description: 'Echo back input text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
            ],
          };
          break;
        case 'resources/list':
          response.result = { resources: [] };
          break;
        case 'prompts/list':
          response.result = { prompts: [] };
          break;
        case 'tools/call':
          response.result = { content: [{ type: 'text', text: 'Mock response for tool: ' + (msg.params?.name || 'unknown') }] };
          break;
        default:
          response.result = {};
      }
      console.log(JSON.stringify(response));
    }
  } catch (e) {}
});
`;

// ─── Config factory ─────────────────────────────────────────────────────────

function createConfig(timeout = 10_000): MCPServerConfig {
  return {
    name: 'e2e-test-server',
    transport: 'stdio',
    command: 'node',
    args: [MOCK_SERVER_PATH],
    enabled: true,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MCPClient E2E — Real Subprocess', () => {
  let client: MCPClient;

  beforeAll(() => {
    writeFileSync(MOCK_SERVER_PATH, MOCK_SERVER_SCRIPT);
  });

  afterAll(() => {
    try { rmSync(MOCK_SERVER_PATH); } catch { /* temp file may already be cleaned up */ }
  });

  afterEach(() => {
    try { client?.disconnect(); } catch { /* ignore */ }
  });

  it('connects to the mock server and completes the handshake', async () => {
    client = new MCPClient(createConfig(), 10_000);

    expect(client.connected).toBe(false);
    expect(client.serverInfo).toBeNull();

    await client.connect();

    expect(client.connected).toBe(true);
    expect(client.serverInfo).toBeDefined();
    expect(client.serverInfo!.name).toBe('mock-test-server');
    expect(client.serverInfo!.version).toBe('1.0.0');
  }, 15_000);

  it('discovers tools after connecting', async () => {
    client = new MCPClient(createConfig(), 10_000);
    await client.connect();

    const tools = client.tools;
    expect(tools).toHaveLength(2);

    const greet = tools.find((t) => t.name === 'greet');
    expect(greet).toBeDefined();
    expect(greet!.description).toContain('Greet');

    const echo = tools.find((t) => t.name === 'echo');
    expect(echo).toBeDefined();
    expect(echo!.description).toContain('Echo');
  }, 15_000);

  it('calls the greet tool and returns a response', async () => {
    client = new MCPClient(createConfig(), 10_000);
    await client.connect();

    const result = await client.callTool('greet', { name: 'World' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect((result.content[0] as any).text).toContain('greet');
  }, 15_000);

  it('calls the echo tool and returns a response', async () => {
    client = new MCPClient(createConfig(), 10_000);
    await client.connect();

    const result = await client.callTool('echo', { text: 'Hello E2E' });

    expect(result.content).toHaveLength(1);
    expect((result.content[0] as any).text).toContain('echo');
  }, 15_000);

  it('refreshes tool list with listTools after connect', async () => {
    client = new MCPClient(createConfig(), 10_000);
    await client.connect();

    const tools = await client.listTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('greet');
    expect(tools[1].name).toBe('echo');
  }, 15_000);

  it('disconnects cleanly and can reconnect', async () => {
    client = new MCPClient(createConfig(), 10_000);
    await client.connect();
    expect(client.connected).toBe(true);

    client.disconnect();
    expect(client.connected).toBe(false);
    expect(client.serverInfo).toBeNull();

    // Reconnect with a new client
    const client2 = new MCPClient(createConfig(), 10_000);
    try {
      await client2.connect();
      expect(client2.connected).toBe(true);
      expect(client2.serverInfo!.name).toBe('mock-test-server');
    } finally {
      client2.disconnect();
    }
  }, 30_000);

  it('rejects tool call after disconnect', async () => {
    client = new MCPClient(createConfig(), 10_000);
    await client.connect();
    client.disconnect();

    await expect(client.callTool('greet')).rejects.toThrow(/Not connected/i);
  }, 15_000);
});
