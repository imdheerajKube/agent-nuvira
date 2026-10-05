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

// Isolate the context cache from the real ~/.nuvira store: the I1 web_search run
// tests call searchWeb → getCache().set(), which would otherwise write to and
// wipe the user's real ~/.nuvira/cache.json (same pattern as web-research.test.ts
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
import { toolsetForTool } from '../../src/tools/toolsets.js';
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

  it('registers the experience tools (ask_user / suggest_followups / verify_requirement / skill)', () => {
    const askUser = getTool('ask_user');
    expect(askUser).toBeDefined();
    expect(askUser!.category).toBe('experience');
    const suggest = getTool('suggest_followups');
    expect(suggest).toBeDefined();
    expect(suggest!.endsAgentStep).toBe(false);
    expect(getTool('verify_requirement')).toBeDefined();
    // P0.8 — the skill tool joins the experience toolset (DELIBERATE count
    // update: the experience group now carries the capability-pack loader).
    const skill = getTool('skill');
    expect(skill).toBeDefined();
    expect(skill!.category).toBe('experience');
    expect(skill!.endsAgentStep).toBe(false);
    const skillParams = (toolJsonSchemas(['skill'])[0].parameters as { properties: Record<string, unknown> }).properties;
    expect(skillParams).toHaveProperty('skill');
    expect(skillParams).toHaveProperty('params');
    // One toolset owns it — never unassigned or duplicated.
    expect(toolsetForTool('skill')?.name).toBe('experience');
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

describe('registry — suggest_followups contract', () => {
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

  it('parses 4+ followups (~3 is prose guidance, not a schema cap)', () => {
    // The schema is .min(1) with NO max — a model emitting 4–5 valid
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

describe('registry — gateway_send tool (message delivery to channels)', () => {
  it('registers gateway_send with the target + text schema', () => {
    const tool = getTool('gateway_send');
    expect(tool).toBeDefined();
    expect(tool!.category).toBe('workflow');
    expect(tool!.endsAgentStep).toBe(false);
    const props = (toolJsonSchemas(['gateway_send'])[0].parameters as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('target');
    expect(props).toHaveProperty('text');
    // The schema documents the WhatsApp contact-by-name pattern.
    const target = props.target as { description?: string };
    expect(target.description ?? '').toContain('whatsapp:Alex');
  });

  it('reports an unknown target cleanly (no adapter needed — hermetic)', async () => {
    const tool = getTool('gateway_send')!;
    const out = await tool.run(
      { target: 'definitely-not-a-real-alias-xyz', text: 'hello' },
      { configManager: {} } as ToolContext,
    );
    expect(out).toContain('unknown channel target');
    expect(out).toContain('whatsapp:Alex'); // teaches the platform:channelId shape
  });

  it('rejects a missing text argument with a clear tool error', async () => {
    const tool = getTool('gateway_send')!;
    const out = await tool.run({ target: 'ops' }, { configManager: {} } as ToolContext);
    expect(out).toContain('text');
  });

  it('delivers through the injected LIVE gateway (no fresh registry / second connection)', async () => {
    const tool = getTool('gateway_send')!;
    const sent: Array<{ target: string; text: string }> = [];
    const live = {
      send: async (target: string, text: string) => {
        sent.push({ target, text });
        return true;
      },
      directory: { resolve: () => ({ platform: 'whatsapp', channelId: 'alex' }) },
    };
    const out = await tool.run(
      { target: 'whatsapp:Alex', text: 'hi alex' },
      { configManager: {}, gateway: live } as ToolContext,
    );
    expect(out).toContain('✅ sent to whatsapp:Alex');
    expect(sent).toEqual([{ target: 'whatsapp:Alex', text: 'hi alex' }]);
  });

  it('reports a failed send through the injected gateway without throwing', async () => {
    const tool = getTool('gateway_send')!;
    const live = {
      send: async () => false,
      directory: { resolve: () => ({ platform: 'whatsapp', channelId: 'alex' }) },
    };
    const out = await tool.run(
      { target: 'whatsapp:Alex', text: 'hi' },
      { configManager: {}, gateway: live } as ToolContext,
    );
    expect(out).toContain('failed');
  });

  it('P0.7 — registers plan_todo with create/update schema (workflow category)', () => {
    const tool = getTool('plan_todo');
    expect(tool).toBeDefined();
    expect(tool!.category).toBe('workflow');
    expect(tool!.endsAgentStep).toBe(false);
    const params = (toolJsonSchemas(['plan_todo'])[0].parameters as { properties: Record<string, unknown> }).properties;
    expect(params).toHaveProperty('action');
    expect(params).toHaveProperty('goal');
    expect(params).toHaveProperty('steps');
    expect(params).toHaveProperty('id');
    expect(params).toHaveProperty('status');
    const status = params.status as { enum?: string[] };
    expect(status.enum).toEqual(['pending', 'running', 'done', 'blocked']);
  });

  it('P0.7 — plan_todo create/update mutates the injected store and emits plan:changed', async () => {
    const { PlanStore } = await import('../../src/tools/plan-store.js');
    const store = new PlanStore();
    const tool = getTool('plan_todo')!;
    const events: Array<{ event: string; data: unknown }> = [];
    const ctx = {
      configManager: {},
      planStore: store,
      emit: (event: string, data: unknown) => events.push({ event, data }),
    } as ToolContext;

    const created = await tool.run(
      {
        action: 'create',
        goal: 'Fix the failing test',
        steps: [
          { id: 'reproduce', description: 'Reproduce the failure' },
          { id: 'verify', description: 'Verify with npm test' },
        ],
      },
      ctx,
    );
    expect(created).toContain('0/2 done');
    expect(store.snapshot()!.steps).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: 'plan:changed' });
    const snapshot = events[0].data as { goal: string; steps: Array<{ id: string }> };
    expect(snapshot.goal).toBe('Fix the failing test');
    expect(snapshot.steps.map((s) => s.id)).toEqual(['reproduce', 'verify']);

    const updated = await tool.run({ action: 'update', id: 'reproduce', status: 'done' }, ctx);
    expect(updated).toContain('1/2 done');
    expect(store.snapshot()!.steps[0].status).toBe('done');
    expect(events).toHaveLength(2); // one plan:changed per mutation
  });

  it('P0.7 — plan_todo validates args (create needs steps, update needs id+status)', async () => {
    const tool = getTool('plan_todo')!;
    const ctx = { configManager: {} } as ToolContext;
    const noSteps = await tool.run({ action: 'create', goal: 'Go' }, ctx);
    expect(noSteps).toContain('Error:');
    const noId = await tool.run({ action: 'update', status: 'done' }, ctx);
    expect(noId).toContain('Error:');
    // Missing status is also refused.
    const noStatus = await tool.run({ action: 'update', id: 'x' }, ctx);
    expect(noStatus).toContain('Error:');
  });

  it('A1 — plan_todo REFUSES an update that names no step, and still resolves aliases', async () => {
    const { PlanStore } = await import('../../src/tools/plan-store.js');
    const store = new PlanStore();
    const tool = getTool('plan_todo')!;
    const ctx = { configManager: {}, planStore: store } as ToolContext;

    await tool.run(
      {
        action: 'create',
        goal: 'Ship it',
        steps: [
          { id: 'step-1', description: 'One' },
          { id: 'step-2', description: 'Two' },
        ],
      },
      ctx,
    );

    // An unknown reference is reported with the ids that DO exist, instead of
    // returning the unchanged table (which read as success).
    const bad = await tool.run({ action: 'update', id: 'why-does-this-not-work', status: 'done' }, ctx);
    expect(bad).toContain('Error:');
    expect(bad).toContain('step-1');
    expect(bad).toContain('step-2');
    expect(store.progress().done).toBe(0);

    // A bare ordinal still moves the counter (the live `cal` run's failure mode).
    const advanced = await tool.run({ action: 'update', id: '1', status: 'done' }, ctx);
    expect(advanced).toContain('1/2 done');
    expect(store.progress().done).toBe(1);
  });

  it('A6 — refuses to mark a step done while the artifact it names is missing', async () => {
    const { PlanStore } = await import('../../src/tools/plan-store.js');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'buff-plan-artifact-'));
    try {
      const store = new PlanStore();
      const tool = getTool('plan_todo')!;
      const ctx = { configManager: {}, planStore: store, cwd: dir } as ToolContext;
      await tool.run(
        { action: 'create', goal: 'Ship the APK', steps: [{ id: 'apk', description: 'produce dist/app.apk' }] },
        ctx,
      );

      const blocked = await tool.run({ action: 'update', id: 'apk', status: 'done' }, ctx);
      expect(blocked).toContain('Error:');
      expect(blocked).toContain('dist/app.apk');
      expect(store.progress().done).toBe(0);

      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'dist', 'app.apk'), 'x');
      const ok = await tool.run({ action: 'update', id: 'apk', status: 'done' }, ctx);
      expect(ok).toContain('1/1 done');
      expect(store.progress().done).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P0.7 — plan_todo runs without an injected store (shared fallback, never throws)', async () => {
    const tool = getTool('plan_todo')!;
    const out = await tool.run(
      { action: 'create', goal: 'Go', steps: [{ id: 'a', description: 'A' }] },
      { configManager: {} } as ToolContext,
    );
    expect(out).toContain('0/1 done');
  });
});
