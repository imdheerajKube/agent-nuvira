/**
 * H1 + E3c — Tool registry tests.
 *
 * Covers the declarative registry: the C3 pipeline tools + the E3c task tools
 * (document/website/analyze/test/publish) + experience tools are registered,
 * listTools is stable, the JSON-schema form derives from the zod schemas, the
 * shared suggest_followups parser enforces one contract across surfaces, and
 * the followups sink collects suggestions.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Isolate the context cache from the real ~/.buff store: the I1 web_search run
// tests call searchWeb → getCache().set(), which would otherwise write to and
// wipe the user's real ~/.buff/cache.json (same pattern as web-research.test.ts
// and eval-framework.test.ts).
const testDirHolder = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs');
  const { join } = require('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { value: mkdtempSync(join(base, 'buff-registry-tools-')) };
});

vi.mock('node:os', () => ({
  homedir: () => testDirHolder.value,
  tmpdir: () => process.env.TMPDIR || process.env.TEMP || '/tmp',
}));
import {
  getTool,
  listTools,
  toolJsonSchemas,
  toFollowupSuggestions,
  suggestFollowupsSchema,
  type ToolContext,
} from '../../src/tools/registry.js';
import { z } from 'zod';

describe('registry — registration', () => {
  it('registers the C3 pipeline tools (build/resume/repair) with the action-map schemas', () => {
    for (const name of ['build', 'resume', 'repair']) {
      const tool = getTool(name);
      expect(tool, `${name} should be registered`).toBeDefined();
      expect(tool!.category).toBe('pipeline');
      expect(tool!.endsAgentStep).toBe(true);
      expect(tool!.inputSchema).toBeInstanceOf(z.ZodType);
    }
  });

  it('registers the E3c model-decides task tools (document/website/analyze/test/publish)', () => {
    for (const name of ['document', 'website', 'analyze', 'test']) {
      const tool = getTool(name);
      expect(tool, `${name} should be registered`).toBeDefined();
      expect(tool!.category).toBe('pipeline');
      expect(tool!.endsAgentStep).toBe(true);
    }
    const publish = getTool('publish');
    expect(publish).toBeDefined();
    expect(publish!.category).toBe('workflow');
    expect(publish!.endsAgentStep).toBe(true);
    // Publish is IRREVERSIBLE — its schema carries the safety flags.
    const props = (toolJsonSchemas(['publish'])[0].parameters as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('bump');
    expect(props).toHaveProperty('dry_run');
    expect(props).toHaveProperty('skip_tests');
  });

  it('registers the experience tools (ask_user / suggest_followups / verify_requirement)', () => {
    const askUser = getTool('ask_user');
    expect(askUser).toBeDefined();
    expect(askUser!.category).toBe('experience');
    const suggest = getTool('suggest_followups');
    expect(suggest).toBeDefined();
    expect(suggest!.endsAgentStep).toBe(false);
    expect(getTool('verify_requirement')).toBeDefined();
  });

  it('listTools is sorted and stable', () => {
    const tools = listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain('build');
    expect(names).toContain('suggest_followups');
    // E3c task tools visible in the registry surface.
    for (const name of ['document', 'website', 'analyze', 'test', 'publish']) {
      expect(names).toContain(name);
    }
  });

  it('unknown tools are not registered', () => {
    expect(getTool('definitely_not_a_tool')).toBeUndefined();
  });

  it('registers the F2 code_search tool (ripgrep-fast project search)', () => {
    const tool = getTool('code_search');
    expect(tool).toBeDefined();
    expect(tool!.category).toBe('workflow');
    expect(tool!.endsAgentStep).toBe(false);
    const params = (toolJsonSchemas(['code_search'])[0].parameters as { properties: Record<string, unknown> }).properties;
    expect(params).toHaveProperty('pattern');
    expect(params).toHaveProperty('max_results');
  });

  it('registers the I1 web-research tools (web_search / read_page)', () => {
    const web = getTool('web_search');
    expect(web).toBeDefined();
    expect(web!.category).toBe('workflow');
    expect(web!.endsAgentStep).toBe(false);
    const webParams = (toolJsonSchemas(['web_search'])[0].parameters as { properties: Record<string, unknown> }).properties;
    expect(webParams).toHaveProperty('query');
    expect(webParams).toHaveProperty('max_results');

    const read = getTool('read_page');
    expect(read).toBeDefined();
    expect(read!.category).toBe('workflow');
    const readParams = (toolJsonSchemas(['read_page'])[0].parameters as { properties: Record<string, unknown> }).properties;
    expect(readParams).toHaveProperty('url');
    expect(readParams).toHaveProperty('max_chars');
  });
});

describe('registry — code_search tool run', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'registry-code-search-'));
    writeFileSync(join(dir, 'main.ts'), 'export const hello = 1;\nconst other = 2;\n');
    writeFileSync(join(dir, 'README.md'), '# hello project\n');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns file:line:column matches for the given pattern', async () => {
    const out = await getTool('code_search')!.run(
      { pattern: 'hello', max_results: 10 },
      { configManager: {}, cwd: dir } as ToolContext,
    );
    expect(out).toContain('main.ts:1:');
    expect(out).toContain('README.md:1:');
  });

  it('reports no matches cleanly', async () => {
    const out = await getTool('code_search')!.run(
      { pattern: 'zzz_nothing_matches', max_results: 10 },
      { configManager: {}, cwd: dir } as ToolContext,
    );
    expect(out).toContain('No matches found');
  });
});

describe('registry — I1 web tools run (mocked fetch)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch; // restore, never delete
    vi.restoreAllMocks();
  });

  it('web_search returns formatted hits from the mocked DDG endpoint', async () => {
    const fakeHtml =
      '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Result A</a><a class="result__snippet">Snippet A</a>';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => fakeHtml,
      json: async () => ({}),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await getTool('web_search')!.run(
      { query: 'nuvira', max_results: 3 },
      { configManager: {} } as ToolContext,
    );
    // DDG redirect URLs are decoded to their real target.
    expect(out).toContain('web_search: 1 result');
    expect(out).toContain('https://example.com/a');
    expect(out).toContain('Result A');
  });

  it('web_search reports no results cleanly when the backend returns nothing', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      text: async () => '',
      json: async () => ({}),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await getTool('web_search')!.run(
      { query: 'nothing', max_results: 3 },
      { configManager: {} } as ToolContext,
    );
    expect(out).toContain('no results');
  });
});

describe('registry — JSON schemas (native tool-calling)', () => {
  it('derives OpenAPI-style JSON schemas from the zod definitions', () => {
    const schemas = toolJsonSchemas(['build', 'ask_user']);
    expect(schemas.length).toBe(2);
    const build = schemas.find((s) => s.name === 'build')!;
    expect(build.description.length).toBeGreaterThan(10);
    // zod → JSON schema: properties carry the goal string field.
    expect(build.parameters).toHaveProperty('properties');
    const askUser = schemas.find((s) => s.name === 'ask_user')!;
    expect(askUser.parameters).toHaveProperty('properties');
    const props = (askUser.parameters as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('question');
    expect(props).toHaveProperty('choices');
    expect(props).toHaveProperty('multi_select');
  });

  it('filters by requested tool names and returns [] for unknown names', () => {
    const schemas = toolJsonSchemas(['resume', 'nope']);
    expect(schemas.map((s) => s.name)).toEqual(['resume']);
  });
});

describe('registry — suggest_followups contract (Freebuff parity)', () => {
  it('validates the tool-shape output [{prompt,label?}]', () => {
    const raw = JSON.stringify([
      { prompt: 'Add unit tests for the new parser', label: 'Add tests' },
      { prompt: 'Run the full suite to verify' },
    ]);
    const result = toFollowupSuggestions(raw);
    expect(result.length).toBe(2);
    expect(result[0].prompt).toBe('Add unit tests for the new parser');
    expect(result[0].label).toBe('Add tests');
    expect(result[1].label).toBeUndefined();
  });

  it('accepts the legacy execute.ts shape [{label,description,goal}] (mapped to prompt)', () => {
    const raw = JSON.stringify([
      { label: 'Add error handling', description: 'd', goal: 'Add error handling to the API routes' },
    ]);
    const result = toFollowupSuggestions(raw);
    expect(result.length).toBe(1);
    expect(result[0].prompt).toBe('Add error handling to the API routes');
    expect(result[0].label).toBe('Add error handling');
  });

  it('extracts a JSON array from surrounding text', () => {
    const raw = 'Here are suggestions:\n[{"prompt":"A"},{"prompt":"B"},{"prompt":"C"}]\nThat is all.';
    expect(toFollowupSuggestions(raw).length).toBe(3);
  });

  it('rejects invalid output (no array / empty prompts) with []', () => {
    expect(toFollowupSuggestions('no json here')).toEqual([]);
    expect(toFollowupSuggestions('[{"prompt":""}]')).toEqual([]);
  });

  it('parses 4+ followups (Freebuff parity: ~3 is prose guidance, not a schema cap)', () => {
    // Freebuff's schema is .min(1) with NO max — a model emitting 4–5 valid
    // followups must PARSE (a zod rejection feeds a tool error back and forces
    // a wasteful retry loop). Callers trim to the top 3 for display.
    const four = Array.from({ length: 4 }, (_, i) => ({ prompt: `p${i}` }));
    const parsed = suggestFollowupsSchema.safeParse({ followups: four });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.followups.length).toBe(4);
    expect(toFollowupSuggestions(JSON.stringify(four)).length).toBe(4);
  });
});

describe('registry — pipeline tool run (build + E3c task tools)', () => {
  it('rejects a missing goal argument with a clear tool error', async () => {
    const tool = getTool('build')!;
    const ctx: ToolContext = { configManager: {} };
    const out = await tool.run({}, ctx);
    expect(out).toContain('requires a goal');
  });

  it('every E3c task tool rejects a missing goal with a clear error', async () => {
    const ctx: ToolContext = { configManager: {} };
    for (const name of ['document', 'website', 'analyze', 'test']) {
      const out = await getTool(name)!.run({}, ctx);
      expect(out, name).toContain('requires a goal');
    }
  });
});

describe('registry — publish tool (dry-run is machine-independent)', () => {
  it('previews the publish phases in dry-run mode without touching anything', async () => {
    const tool = getTool('publish')!;
    const ctx: ToolContext = { configManager: {} };
    const out = await tool.run({ dry_run: true, bump: 'minor' }, ctx);
    expect(out).toContain('DRY RUN');
    expect(out).toContain('Version Bump (minor)');
  });
});
