/**
 * M1 — Integration: orchestrator → workspace write cycle (Phase A2 continuity).
 *
 * Proves the REAL pipeline writes its run row into the project registry even
 * when the run FAILS — the workspace write is best-effort and must never break
 * result delivery (orchestrator.execute() → configManager.getWorkspaceStore()
 * → recordRun).
 *
 * Hermetic: BUFF_CONFIG_DIR + BUFF_MEMORY_DIR pinned to a temp dir; the config
 * pins `local` to a NONEXISTENT model so the planner fails fast with zero
 * network (the same pattern as tests/agents/injection-guardrail.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../../src/agents/orchestrator.js';
import { ConfigManager } from '../../src/config/manager.js';
import { getWorkspaceStore, resetWorkspaceStore } from '../../src/config/workspace.js';

const root = mkdtempSync(join(tmpdir(), 'buff-integration-orch-'));
const cfgDir = join(root, '.nuvira');
const memDir = join(root, '.nuvira', 'memory');
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;
const ORIG_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;

beforeAll(() => {
  mkdirSync(cfgDir, { recursive: true });
  process.env.NUVIRA_CONFIG_DIR = cfgDir;
  process.env.NUVIRA_MEMORY_DIR = memDir;
  // Local → nonexistent model: the planner call fails fast (model-not-found),
  // so the whole pipeline resolves a FAILED result without touching the network.
  writeFileSync(
    join(cfgDir, 'buffconfig.json'),
    JSON.stringify({
      defaultProvider: 'local',
      providers: {
        local: { runner: 'ollama', model: 'nonexistent-fast-fail', temperature: 0.7, maxTokens: 1024 },
      },
    }),
  );
});

afterAll(() => {
  resetWorkspaceStore();
  if (ORIG_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = ORIG_CONFIG_DIR;
  if (ORIG_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIG_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('orchestrator → workspace write cycle', () => {
  it('execute() records its run row even when the pipeline fails (best-effort write)', async () => {
    const cm = new ConfigManager();
    const orchestrator = new Orchestrator(cm);
    const goal = 'Add auth to the API (integration smoke)';

    const result = await orchestrator.execute(goal, {
      // Non-auto: pinned local provider above; no MCP subprocesses; no repair
      // escalation to other providers; never writes files.
      autoRouteModels: false,
      enableMcp: false,
      maxRepairs: 0,
      repairMode: 'off',
      dryRun: true,
      // NOTE: maxRepairs/repairMode only govern PER-TASK repair. The planner
      // failure path has its own internal repair budget (maxRepairs: 3 hardcoded
      // in executePipeline) — every attempt hits the nonexistent model and fails
      // fast, so the pipeline still resolves in well under a second.
    });

    // The pipeline resolves (never throws) with a failed result.
    expect(result).toBeDefined();
    expect(result.success).toBe(false);

    // The workspace row for THIS cwd now carries the goal + ❌ outcome.
    const ws = getWorkspaceStore(cfgDir);
    const row = ws.getProjectForCwd(process.cwd());
    expect(row.lastGoal).toBe(goal);
    expect(row.runSummary.startsWith('❌')).toBe(true);

    // A fresh store (reload from disk) sees the same row — real persistence.
    resetWorkspaceStore();
    const ws2 = getWorkspaceStore(cfgDir);
    expect(ws2.getProjectForCwd(process.cwd()).lastGoal).toBe(goal);
  });

  it('a second run updates the same project row (upsert, not duplicate)', async () => {
    const cm = new ConfigManager();
    const orchestrator = new Orchestrator(cm);
    const goal2 = 'Refactor the CLI entry (integration smoke)';

    await orchestrator.execute(goal2, {
      autoRouteModels: false,
      enableMcp: false,
      maxRepairs: 0,
      repairMode: 'off',
      dryRun: true,
    });
    // (Planner-repair budget is internal — see note in the first test.)

    const ws = getWorkspaceStore(cfgDir);
    const row = ws.getProjectForCwd(process.cwd());
    expect(row.lastGoal).toBe(goal2);
    // One row per project — the goal was updated in place.
    const sameCwdRows = ws.listProjects().filter((p) => p.cwdHash === row.cwdHash);
    expect(sameCwdRows).toHaveLength(1);
  });
});
