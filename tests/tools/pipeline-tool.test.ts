import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression: trace-1788970301803-8302u5 — a WhatsApp-triggered pipeline ran
 * on the single configured default provider (Groq) and became a 429 death
 * spiral (14 steps / 112s) because the AutoModelRouter — the product's core
 * routing USP — was never consulted for unpinned runs. The gateway and the
 * tool-registry loop call runPipelineTool WITHOUT provider/model, so the
 * orchestrator must receive autoRouteModels: true in that case (per-task
 * model-first scoring across ALL configured providers, quota-parking, and
 * session exclusions), while an explicit provider/model still wins.
 */

const executeMock = vi.fn();
const orchestrationResult = {
  success: true,
  summary: 'done',
  tasksCompleted: 1,
  tasksTotal: 1,
  agentResults: [],
  fileChanges: 'No files changed.',
};

vi.mock('../../src/agents/orchestrator.js', () => ({
  Orchestrator: class {
    constructor(_configManager: unknown) {}
    execute = executeMock;
  },
}));

import { runPipelineTool } from '../../src/tools/pipeline-tool.js';

describe('runPipelineTool — auto-routing for unpinned runs', () => {
  const configManager = {} as any;

  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue(orchestrationResult);
  });

  it('enables autoRouteModels when the caller pins NO provider/model (gateway/tool-loop path)', async () => {
    await runPipelineTool('build a CLI tool', configManager, { board: false, mode: 'dev' });
    expect(executeMock).toHaveBeenCalledTimes(1);
    const opts = executeMock.mock.calls[0][1];
    expect(opts.provider).toBeUndefined();
    expect(opts.model).toBeUndefined();
    expect(opts.autoRouteModels).toBe(true);
  });

  it('keeps autoRouteModels off when the caller pins a provider/model (explicit wins)', async () => {
    await runPipelineTool('build a CLI tool', configManager, {
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      board: false,
      mode: 'dev',
    });
    const opts = executeMock.mock.calls[0][1];
    expect(opts.provider).toBe('groq');
    expect(opts.model).toBe('llama-3.3-70b-versatile');
    expect(opts.autoRouteModels).toBe(false);
  });
});