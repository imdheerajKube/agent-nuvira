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
 * Scope: the MEMORY dir, the MCP config dir, and the SKILLS dir. The main CONFIG
 * dir is left alone on purpose — tests that need real credentials must keep
 * working, and a test that wants its own config dir already pins
 * `NUVIRA_CONFIG_DIR` itself. The MCP and skills dirs are isolated rather than
 * the whole config dir because those two are read and written by accident (a
 * discovery scan, a seeding constructor) rather than deliberately.
 *
 * PROVIDER AND MESSAGING CREDENTIALS ARE REMOVED, not isolated — see
 * `src/config/live-credentials.ts` for the measurement. In short: the release
 * pipeline spawns `npm test` with the operator's `~/.nuvira/.env`, so the suite
 * inherited live GROQ/GEMINI/NIM/OPENROUTER keys plus Twilio/Slack/Telegram
 * tokens; tests conditioned on a key being present then took real network paths
 * and timed out (7 files, 25 x 15s timeouts) where the same files are green in a
 * shell without those keys. A test that wants a real provider key sets one.
 *
 * The MCP dir is isolated for the same reason as the memory dir, and the leak was
 * the worse of the two: the orchestrator calls `discoverConfigs()` on every run,
 * so the suite found the developer's REAL `~/.nuvira/mcp/{github,exa,firecrawl}.json`
 * and spawned those servers mid-test. That is outbound network traffic from a test
 * process, MCP responses arriving for clients the test had already torn down
 * (`Received a response for an unknown message ID`), and a fully mocked test timing
 * out at 15s. See {@link resolveMcpConfigDir} for the resolution itself.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deleteTestUnsafeEnv } from '../../src/config/live-credentials.js';

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

// The MCP config dir, pointed at a path that does NOT exist: `discoverConfigs()`
// returns an empty list for a missing dir, so no server is ever started from a
// test. The alternative — discovering the real profile — is what spawned live
// GitHub/Exa/Firecrawl servers during the suite.
const mcpDir = join(runDir, 'mcp');
for (const key of ['NUVIRA_MCP_DIR', 'BUFF_MCP_DIR']) {
  if (!process.env[key]) process.env[key] = mcpDir;
}

// The skills store seeds all 152 bundled skills from its constructor and keeps an
// index beside them, so a test that merely does `new SkillStore()` wrote the
// developer's real `~/.nuvira/skills` — measured on this repo, 152 files plus
// `index.json`, on every run. It is also shared state: two files running at once
// raced on it (a re-seed reporting 140 where the test expected 0, a fresh store
// seeing 67 of 152 skills).
const skillsDir = join(runDir, 'skills');
for (const key of ['NUVIRA_SKILLS_DIR', 'BUFF_SKILLS_DIR']) {
  if (!process.env[key]) process.env[key] = skillsDir;
}

// State the provenance explicitly rather than relying on the runner being
// detected: telemetry written from a test process is tagged `origin: 'test'` and
// excluded from every number the dashboard reports. Defence in depth — the
// registry also detects `VITEST` on its own (see `telemetryOrigin`), so this
// only removes the inference, it is not the guard.
process.env.NUVIRA_TELEMETRY_ORIGIN = 'test';

// No live provider or messaging credential survives into a test. Without this a
// test that checks for a key — the right way to write it — reaches a real API
// and the suite becomes a function of the operator's shell.
deleteTestUnsafeEnv();

// Best-effort cleanup. `exit` only — a hard kill leaves the temp dir behind,
// which is harmless (the OS reclaims it) and must never mask a test failure.
process.on('exit', () => {
  try {
    rmSync(runDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
