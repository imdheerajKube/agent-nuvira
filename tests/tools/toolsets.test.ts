/**
 * H1b — Toolset tests (Hermes capability-gating parity, I1).
 *
 * Covers: catalog coverage integrity (every registered tool in exactly one
 * toolset), pure filtering, config round-trip via a hermetic ConfigManager,
 * schema gating (disabled tools absent from provider schemas), and the
 * tool-loop enforcement point (a disabled tool is rejected at runtime).
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TOOLSETS,
  toolsetForTool,
  validateToolsetCoverage,
  readToolsetsState,
  disabledToolsetNames,
  setToolsetEnabled,
  isToolEnabled,
  effectiveTools,
  effectiveToolJsonSchemas,
  getToolsetStatus,
  filterToolsByToolsets,
  type ConfigManagerLike,
} from '../../src/tools/toolsets.js';
import { listTools } from '../../src/tools/registry.js';
import { ConfigManager } from '../../src/config/manager.js';
import { runToolLoop, type ToolLoopDeps, type StepResponse } from '../../src/tools/tool-loop.js';

/** A stub ConfigManager whose getAll returns a fixed toolsets state. */
function stubCm(toolsets: Record<string, { enabled?: boolean }>): ConfigManagerLike {
  return { getAll: () => ({ tools: { toolsets } }) };
}

describe('toolset catalog — coverage integrity', () => {
  it('assigns every registered tool to EXACTLY one toolset', () => {
    const registered = listTools().map((t) => t.name);
    const { unassigned, duplicated } = validateToolsetCoverage(registered);
    expect(unassigned).toEqual([]);
    expect(duplicated).toEqual([]);
  });

  it('is the only assignment source: every toolset tool is a real registry tool', () => {
    const registered = new Set(listTools().map((t) => t.name));
    for (const t of TOOLSETS) {
      for (const name of t.tools) {
        expect(registered.has(name), `${name} listed in toolset ${t.name} but not registered`).toBe(true);
      }
    }
  });

  it('toolsetForTool resolves ownership and returns undefined for unknown tools', () => {
    expect(toolsetForTool('web_search')?.name).toBe('web');
    expect(toolsetForTool('build')?.name).toBe('core');
    expect(toolsetForTool('does-not-exist')).toBeUndefined();
  });
});

describe('pure filtering', () => {
  it('disabledToolsetNames returns only explicitly-disabled toolsets', () => {
    expect(disabledToolsetNames({})).toEqual([]);
    expect(disabledToolsetNames({ web: { enabled: false } })).toEqual(['web']);
    expect(disabledToolsetNames({ web: { enabled: true } })).toEqual([]);
  });

  it('filterToolsByToolsets drops tools owned by disabled toolsets, keeps others', () => {
    const tools = listTools();
    const filtered = filterToolsByToolsets(tools, ['web', 'mcp']);
    const names = filtered.map((t) => t.name);
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('read_page');
    expect(names).toContain('build');
    expect(names).toContain('code_search');
  });

  it('empty disabled list is a no-op', () => {
    expect(filterToolsByToolsets(listTools(), [])).toHaveLength(listTools().length);
  });
});

describe('config-backed state (hermetic ConfigManager)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'buff-toolsets-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('setToolsetEnabled persists to buffconfig.json and gates effectiveTools', () => {
    const cm = new ConfigManager(dir);

    // All enabled by default.
    expect(effectiveTools(cm).map((t) => t.name)).toContain('web_search');

    setToolsetEnabled('web', false, cm);
    expect(readToolsetsState(cm).web).toEqual({ enabled: false });

    // Gating: web tools gone, core/experience intact.
    const names = effectiveTools(cm).map((t) => t.name);
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('read_page');
    expect(names).toContain('build');
    expect(names).toContain('ask_user');

    // Persisted on disk for the next process.
    const raw = readFileSync(join(dir, 'buffconfig.json'), 'utf-8');
    expect(JSON.parse(raw).tools.toolsets.web.enabled).toBe(false);

    // Re-enable round-trips.
    setToolsetEnabled('web', true, cm);
    expect(effectiveTools(cm).map((t) => t.name)).toContain('web_search');
    expect(isToolEnabled('web_search', cm)).toBe(true);
  });

  it('unknown toolset names throw (typo-safe)', () => {
    const cm = new ConfigManager(dir);
    expect(() => setToolsetEnabled('not-a-toolset', false, cm)).toThrow(/Unknown toolset/);
  });

  it('toggling preserves any future per-toolset keys (deep merge, no clobber)', () => {
    const cm = new ConfigManager(dir);
    cm.save({ tools: { toolsets: { web: { enabled: true, provider: 'duckduckgo' } } } } as any);
    setToolsetEnabled('web', false, cm);
    const raw = JSON.parse(readFileSync(join(dir, 'buffconfig.json'), 'utf-8'));
    expect(raw.tools.toolsets.web).toEqual({ enabled: false, provider: 'duckduckgo' });
    expect(readToolsetsState(cm).web?.provider).toBe('duckduckgo');
  });

  it('getToolsetStatus reflects the persisted state', () => {
    const cm = new ConfigManager(dir);
    setToolsetEnabled('media', false, cm);
    const status = getToolsetStatus(cm);
    const media = status.find((s) => s.name === 'media');
    expect(media?.enabled).toBe(false);
    expect(status.find((s) => s.name === 'core')?.enabled).toBe(true);
  });
});

describe('graceful stub handling (callers that pass a bare object)', () => {
  it('a stub without getAll means ALL toolsets enabled (never accidental gating)', () => {
    const cm: ConfigManagerLike = {};
    expect(readToolsetsState(cm)).toEqual({});
    expect(isToolEnabled('web_search', cm)).toBe(true);
    expect(effectiveToolJsonSchemas(cm).map((s) => s.name)).toContain('web_search');
  });

  it('a read error also degrades to all-enabled', () => {
    const cm: ConfigManagerLike = { getAll: () => { throw new Error('boom'); } };
    expect(readToolsetsState(cm)).toEqual({});
    expect(isToolEnabled('browser', cm)).toBe(true);
  });
});

describe('tool-loop enforcement (schema + execution gate)', () => {
  it('disabled tools are absent from the provider schema AND rejected at runtime', async () => {
    const cm = stubCm({ web: { enabled: false } });

    const callModel = vi.fn();
    let step = 0;
    callModel.mockImplementation(async () => {
      step += 1;
      if (step === 1) {
        // The model tries to call the DISABLED web_search tool (hallucinated
        // name — it was never in the schema it saw).
        return { content: '', toolCalls: [{ id: 'c1', name: 'web_search', arguments: { query: 'x' } }] } satisfies StepResponse;
      }
      return { content: 'The answer.', toolCalls: [] } satisfies StepResponse;
    });
    const executeTool = vi.fn(async () => 'SHOULD NOT RUN');

    const deps: ToolLoopDeps = { callModel, executeTool, onEvent: vi.fn() };
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'search the web' }],
      context: { configManager: cm },
      deps,
    });

    // Schema gating: step 1 saw NO web_search in its tool schemas.
    const schemasAtStep1 = callModel.mock.calls[0][1] as Array<{ name: string }>;
    expect(schemasAtStep1.map((s) => s.name)).not.toContain('web_search');
    expect(schemasAtStep1.map((s) => s.name)).toContain('code_search');

    // Execution gate: executeTool was never invoked for the disabled tool.
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.content).toBe('The answer.');

    // The disabled-tool error was fed back so the model could retry in context.
    const threadAtStep2 = callModel.mock.calls[1][0] as Array<{ role: string; content: string }>;
    const last = threadAtStep2[threadAtStep2.length - 1];
    expect(last.role).toBe('tool');
    expect(last.content).toContain('disabled');
  });

  it('enabled tools execute normally under the same stub', async () => {
    const cm = stubCm({ web: { enabled: false } });
    const deps: ToolLoopDeps = {
      callModel: vi.fn(async () => ({
        content: '',
        toolCalls: [{ id: 'c1', name: 'code_search', arguments: { pattern: 'foo' } }],
      })) as any,
      executeTool: vi.fn(async (name: string) => `ran ${name}`),
      onEvent: vi.fn(),
    };
    // Script: call code_search once, then answer.
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'code_search', arguments: { pattern: 'foo' } }] },
      { content: 'Done.', toolCalls: [] },
    ];
    let i = 0;
    (deps.callModel as any).mockImplementation(async () => script[Math.min(i++, script.length - 1)]);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'search code' }],
      context: { configManager: cm },
      deps,
    });
    expect(deps.executeTool).toHaveBeenCalledWith('code_search', { pattern: 'foo' }, expect.anything());
    expect(result.toolCalls).toEqual(['code_search']);
  });
});
