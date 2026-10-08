/**
 * Bundle 42 — MCP tools become discoverable capabilities.
 *
 * Reach borrowed from outside: an external MCP server already declares what each
 * of its tools DOES (the MCP spec's `ToolAnnotations`) and what it NEEDS (its
 * JSON Schema). These tests pin that we READ those declarations rather than
 * guessing from a description — and that when a server declares NOTHING we
 * assume the worst reading that still lets a user proceed deliberately.
 *
 * Hermetic: MCP tools are injected, so no server is ever spawned.
 */

import { describe, it, expect } from 'vitest';

import {
  capabilityFromMcpTool,
  capabilityIndex,
  searchCapabilities,
} from '../../src/tools/capability-registry.js';

const server = 'github';

describe('capabilityFromMcpTool — the effect comes from the server\'s declaration', () => {
  it('reads `readOnlyHint` as a read, reversible, and gates nothing', () => {
    const cap = capabilityFromMcpTool({
      server,
      name: 'search_issues',
      description: 'Search issues in a repository. Returns matches.',
      inputSchema: { type: 'object', required: ['query'] },
      annotations: { readOnlyHint: true },
    });
    expect(cap).toMatchObject({
      id: 'mcp:github:search_issues',
      kind: 'mcp',
      ref: 'github/search_issues',
      effectClass: 'read',
      reversible: true,
    });
    expect(cap.grantCategory).toBeUndefined();
    expect(cap.oneLiner).toBe('Search issues in a repository.');
    expect(cap.requires.inputs).toEqual(['query']);
  });

  it('reads `destructiveHint` as destructive and NOT reversible, and never grantable', () => {
    const cap = capabilityFromMcpTool({
      server,
      name: 'purge_repo',
      description: 'Delete everything.',
      annotations: { destructiveHint: true },
    });
    expect(cap.effectClass).toBe('destructive');
    expect(cap.reversible).toBe(false);
    // Destructive actions are never unlockable by a session grant — the same
    // principle as the DENY floor.
    expect(cap.grantCategory).toBeUndefined();
  });

  it('treats SILENCE as off-machine and unknown — never as safe', () => {
    const cap = capabilityFromMcpTool({ server, name: 'mystery', description: 'Does something.' });
    // A foreign tool is off-machine by construction and declared nothing, so the
    // honest reading is external + not-known-reversible: it asks, and only an
    // explicit off-machine grant unlocks it.
    expect(cap.effectClass).toBe('external');
    expect(cap.reversible).toBe(false);
    expect(cap.grantCategory).toBe('external');
  });

  it('does not treat an explicit `readOnlyHint: false` as a read', () => {
    const cap = capabilityFromMcpTool({
      server,
      name: 'mutate',
      description: 'Mutates things.',
      annotations: { readOnlyHint: false },
    });
    expect(cap.effectClass).toBe('external');
    expect(cap.grantCategory).toBe('external');
  });

  it('says HOW to reach it, because the ref is not a callable tool name', () => {
    const cap = capabilityFromMcpTool({ server, name: 'create_issue', description: 'Create an issue.' });
    expect(cap.ref).toBe('github/create_issue');
    // The arguments mirror `mcp_tool`'s real schema — server + tool + the call action.
    expect(cap.invoke).toEqual({
      tool: 'mcp_tool',
      args: { action: 'call', server: 'github', tool: 'create_issue' },
    });
  });

  it('prefers the annotation title, and falls back to a usable one-liner', () => {
    const titled = capabilityFromMcpTool({
      server,
      name: 'list_repos',
      description: 'List repos.',
      annotations: { title: 'List repositories' },
    });
    expect(titled.name).toBe('List repositories');
    // The ref still names the real server/tool pair, not the display title.
    expect(titled.ref).toBe('github/list_repos');

    const undescribed = capabilityFromMcpTool({ server, name: 'mystery' });
    expect(undescribed.oneLiner).toBe('The mystery tool on the github MCP server.');
    expect(undescribed.tags).toContain('mcp');
    expect(undescribed.tags).toContain('github');
  });

  it('carries no requirements when the schema declares none', () => {
    expect(capabilityFromMcpTool({ server, name: 'ping', description: 'Ping.' }).requires).toEqual({});
  });
});

describe('capabilityIndex — ingesting a live server\'s tools', () => {
  const mcpTools = [
    { server: 'github', name: 'create_issue', description: 'Create an issue.', annotations: { readOnlyHint: false } },
    { server: 'filesystem', name: 'read_text_file', description: 'Read a text file.', annotations: { readOnlyHint: true } },
  ];

  it('adds injected MCP tools as kind:mcp capabilities', async () => {
    const index = await capabilityIndex([], { includeSkills: false, mcpTools });
    const mcp = index.filter((c) => c.kind === 'mcp');
    expect(mcp.map((c) => c.ref)).toEqual(['github/create_issue', 'filesystem/read_text_file']);
    expect(mcp.find((c) => c.ref === 'filesystem/read_text_file')!.effectClass).toBe('read');
  });

  it('omits them entirely when asked to', async () => {
    const index = await capabilityIndex([], { includeSkills: false, includeMcp: false });
    expect(index.some((c) => c.kind === 'mcp')).toBe(false);
  });

  it('lets MCP tools be FOUND by their server and their purpose', async () => {
    const index = await capabilityIndex([], { includeSkills: false, mcpTools });
    const hits = searchCapabilities(index, 'read a text file on the filesystem');
    expect(hits.some((h) => h.capability.ref === 'filesystem/read_text_file')).toBe(true);
    expect(searchCapabilities(index, 'github')[0]!.capability.kind).toBe('mcp');
  });

  it('is inert and non-throwing when no server is connected', async () => {
    // The live path must never spawn a server or break discovery — a cold process
    // simply has no MCP capabilities.
    const index = await capabilityIndex([{ name: 'read_file', description: 'Read a file.' }], { includeSkills: false });
    expect(index.some((c) => c.kind === 'mcp')).toBe(false);
    expect(index.some((c) => c.ref === 'read_file')).toBe(true);
  });
});
