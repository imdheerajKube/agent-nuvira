/**
 * Hermetic memory store for the test suite.
 *
 * WHY THIS EXISTS (Models-page audit). The suite had NO environment isolation:
 * `vitest.config.ts` set `fileParallelism: false` specifically because "memory
 * tests share a JSON file store at ~/.buff/memory/", so every test that did not
 * pin its own directory wrote to the **developer's real store** — the same files
 * the dashboard reports and the router obeys.
 *
 * Proven live: `tests/federation/a2a.test.ts` isolates its CONFIG dir
 * (`NUVIRA_CONFIG_DIR`) but not its memory dir, so the real Orchestrator pipeline
 * it drives (deliberately configured with the fake model
 * `local/nonexistent-fast-fail`) recorded **20 real telemetry events per run**
 * into `~/.nuvira/memory/model-registry-actions.jsonl` plus a permanent
 * `deadPair` entry in `model-registry.json`. Over a day of test runs that fake
 * model became the single largest row in the dashboard's "Learned from real
 * usage" chart, and it polluted the per-provider stats that sit beside real
 * routing decisions.
 *
 * One test file re-running is not a test concern — it is a data-integrity
 * problem, and the fix belongs in the harness rather than in one test file,
 * otherwise the next test that drives the real pipeline leaks the same way.
 *
 * The `model-registry` module already documents this exact hazard for its async
 * vector mirror ("would write to whatever NUVIRA_MEMORY_DIR is at that later
 * moment (the real ~/.nuvira/memory) and leak test data"). This closes the other
 * half: the default itself.
 *
 * Scope: the MEMORY dir only. The CONFIG dir is left alone on purpose — tests
 * that need real credentials must keep working, and a test that wants its own
 * config dir already pins `NUVIRA_CONFIG_DIR` itself.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One throwaway store per test file (files run in their own process). */
const runDir = mkdtempSync(join(tmpdir(), 'nuvira-test-memory-'));
const memoryDir = join(runDir, 'memory');

// Respect an explicit setting (a caller isolating to a known path, or a test
// suite that pins its own), and otherwise take over every alias the resolvers
// read. `envBuff` checks NUVIRA_* before BUFF_*, so both are set to the SAME
// dir — a split pair would send one store back to the real home.
for (const key of ['NUVIRA_MEMORY_DIR', 'BUFF_MEMORY_DIR']) {
  if (!process.env[key]) process.env[key] = memoryDir;
}

// State the provenance explicitly rather than relying on the runner being
// detected: telemetry written from a test process is tagged `origin: 'test'` and
// excluded from every number the dashboard reports. Defence in depth — the
// registry also detects `VITEST` on its own (see `telemetryOrigin`), so this
// only removes the inference, it is not the guard.
process.env.NUVIRA_TELEMETRY_ORIGIN = 'test';

// Best-effort cleanup. `exit` only — a hard kill leaves the temp dir behind,
// which is harmless (the OS reclaims it) and must never mask a test failure.
process.on('exit', () => {
  try {
    rmSync(runDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
