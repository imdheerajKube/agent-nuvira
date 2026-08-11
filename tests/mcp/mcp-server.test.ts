/**
 * F2 follow-up — MCP server: unit tests for src/mcp/server.ts.
 *
 * Uses the SDK's InMemoryTransport linked pair (one side to the server, one
 * to a real SDK Client) — the exact same wire protocol a stdio client speaks,
 * with zero subprocess. Covers:
 * 1. The safe public surface (pipeline tools + code_search) is exposed.
 * 2. Loop-internal/LLM-dependent tools (ask_user, suggest_followups,
 *    verify_requirement, delegate, publish) are NOT exposed by default.
 * 3. code_search round-trips a real ripgrep search on a temp fixture.
 * 4. A missing-argument call returns an isError result (not a crash).
 * 5. extraTools opt-in exposes publish.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { createAgentMcpServer, AGENT_MCP_TOOL_NAMES } from '../../src/mcp/server.js';

// ─── Temp project fixture (code_search target) ─────────────────────────────

let fixtureDir: string;

beforeAll(() => {
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  fixtureDir = mkdtempSync(join(base, 'buff-mcp-server-'));
  mkdirSync(join(fixtureDir, 'src'), { recursive: true });
  writeFileSync(join(fixtureDir, 'src', 'main.ts'), 'export const greeting = "hello world";\nfunction hello(name: string) { return `hello ${name}`; }\n', 'utf-8');
  writeFileSync(join(fixtureDir, 'README.md'), '# hello project\n', 'utf-8');
});

afterAll(() => {
  try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ─── Harness ───────────────────────────────────────────────────────────────

async function connectClient(extraTools?: string[]) {
  const server = await createAgentMcpServer({ cwd: fixtureDir, extraTools });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { server, client };
}

describe('createAgentMcpServer', () => {
  it('exposes the safe pipeline + code_search surface', async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const names = (tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual([...AGENT_MCP_TOOL_NAMES].sort());
    for (const expected of ['build', 'resume', 'repair', 'document', 'website', 'analyze', 'test', 'code_search', 'web_search', 'read_page']) {
      expect(names).toContain(expected);
    }
    await client.close();
  });

  it('does NOT expose loop-internal / LLM-dependent / irreversible tools by default', async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const names = (tools ?? []).map((t) => t.name);
    for (const excluded of ['ask_user', 'suggest_followups', 'verify_requirement', 'delegate', 'publish']) {
      expect(names).not.toContain(excluded);
    }
    await client.close();
  });

  it('exposes extra tools when opted in via extraTools', async () => {
    const { client } = await connectClient(['publish']);
    const { tools } = await client.listTools();
    const names = (tools ?? []).map((t) => t.name);
    expect(names).toContain('publish');
    await client.close();
  });
});

describe('code_search over MCP', () => {
  it('round-trips a real ripgrep search on the temp fixture', async () => {
    const { client } = await connectClient();
    const result = await client.callTool({
      name: 'code_search',
      arguments: { pattern: 'hello', max_results: 10 },
    });
    expect(result.isError).toBeFalsy();
    const text = result.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('\n');
    expect(text).toMatch(/src\/main\.ts/);
    expect(text).toContain('hello');
    await client.close();
  });

  it('returns a helpful no-match result instead of an error', async () => {
    const { client } = await connectClient();
    const result = await client.callTool({
      name: 'code_search',
      arguments: { pattern: 'zzz_definitely_absent_zzz' },
    });
    expect(result.isError).toBeFalsy();
    const text = result.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('\n');
    expect(text).toMatch(/No matches found/);
    await client.close();
  });

  it('returns an isError result for a missing required argument', async () => {
    const { client } = await connectClient();
    const result = await client.callTool({ name: 'code_search', arguments: {} });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('\n');
    expect(text).toContain('code_search');
    await client.close();
  });
});

describe('pipeline tools over MCP', () => {
  it('advertises zod-derived input schemas for pipeline tools', async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const build = (tools ?? []).find((t) => t.name === 'build');
    expect(build).toBeDefined();
    expect(build!.inputSchema).toBeDefined();
    const props = (build!.inputSchema as { properties?: Record<string, unknown> }).properties;
    expect(props).toBeDefined();
    expect(Object.keys(props!)).toContain('goal');
    await client.close();
  });
});
