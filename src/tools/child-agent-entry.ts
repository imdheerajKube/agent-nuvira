/**
 * Child-agent entry point (`src/tools/child-agent-entry.ts`) — the file the
 * spawner forks.
 *
 * It exists as TypeScript for two reasons that were both live defects:
 *
 *   1. **It is shipped.** `tsc` emits `dist/tools/child-agent-entry.js`, so the
 *      compiled layout forks a file that exists. The previous entry was a
 *      hand-written `child-agent-entry.js` under `src/`, which nothing copied to
 *      `dist/` (`allowJs` is false) — a compiled install forked a path that was
 *      never there, and `spawn()` threw ENOENT.
 *   2. **It runs in this package's module system.** `package.json` is
 *      `"type": "module"`, so that same `.js` file was parsed as ESM while being
 *      written in CommonJS (`require`, `__dirname`, a `parentPort` import from a
 *      worker-thread API that a `fork()`ed process does not have). It died on
 *      `require is not defined` before it read a single environment variable.
 *
 * The child reports over the IPC channel `fork()` establishes: `progress` while
 * it works, then exactly one `result` or `error`. The parent treats "exited
 * without a result" as a failure, so this file must never exit 0 silently.
 */

import { runSubagent, type SubagentRuntimeConfig } from './child-agent-runtime.js';
import { SubagentRefusalError } from './subagent-refusal.js';
// WS6 (#28) — the declared fault seam, read in the CHILD's own process (the
// declaration reaches it through the environment it inherited).
import { faultAt } from '../runtime/fault-injection.js';

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Env vars the spawner sets; anything malformed falls back rather than throwing. */
function readConfig(): SubagentRuntimeConfig {
  const parseList = (raw: string | undefined): string[] => {
    try {
      const parsed = JSON.parse(raw ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    goal: process.env.SUBAGENT_GOAL ?? '',
    provider: process.env.SUBAGENT_PROVIDER || 'auto',
    model: process.env.SUBAGENT_MODEL || undefined,
    tools: parseList(process.env.SUBAGENT_TOOLS),
    blockedTools: parseList(process.env.SUBAGENT_BLOCKED_TOOLS),
    maxLlmCalls: num(process.env.SUBAGENT_MAX_LLM_CALLS, 25),
    maxIterations: num(process.env.SUBAGENT_MAX_ITERATIONS, 12),
    cwd: process.cwd(),
  };
}

/**
 * The run's identity, as the runtime announced it: which provider, which model it
 * pinned, and which transport carries tool calls.
 *
 * Remembered on the way OUT so the failure frame can carry it too. A child that
 * died before producing a result used to reach the parent as a bare message, so a
 * failed subagent could not be attributed to a backend — the one moment you most
 * want to know which provider/model was serving the run.
 */
const identity: { provider?: string; model?: string; transport?: string } = {};

function send(msg: Record<string, unknown>): void {
  if (typeof msg.provider === 'string') identity.provider = msg.provider;
  if (typeof msg.model === 'string') identity.model = msg.model;
  if (typeof msg.transport === 'string') identity.transport = msg.transport;
  try {
    process.send?.(msg);
  } catch {
    // A closed IPC channel must not turn a finished task into a crash.
  }
}

async function main(): Promise<void> {
  // WS6 (#28) — a DECLARED ipc fault: this process dies before it does any work,
  // and deliberately WITHOUT a frame, because a crash is the failure the parent
  // cannot observe from inside its own process. The assertion it exists for is
  // that the parent reports the run as failed rather than hanging on a child that
  // will never speak, or inventing a result for it.
  if (faultAt('ipc', 'child')) process.exit(3);

  const config = readConfig();
  if (!config.goal) {
    send({ type: 'error', error: 'SUBAGENT_GOAL is empty — nothing to do.' });
    process.exit(1);
    return;
  }

  try {
    const outcome = await runSubagent(config, { send });
    send({
      type: 'result',
      result: outcome.result,
      llmCalls: outcome.llmCalls,
      toolCalls: outcome.toolCalls,
      provider: outcome.provider,
      // Which model and which tool transport actually served the run — recorded
      // so a finished subagent can be inspected after the fact rather than guessed
      // at from its output.
      ...(outcome.model ? { model: outcome.model } : {}),
      transport: outcome.transport,
      truncated: outcome.truncated,
      // G1 — the child's OWN verification verdict, on the frame like every other
      // fact the parent can only learn across the fork. Without it a delegated run
      // that wrote and verified nothing looked exactly like one that checked its
      // work: the honesty flags live in this process and nowhere else.
      ...(outcome.unverifiedEdit ? { unverifiedEdit: true } : {}),
      ...(outcome.unverifiedEditClaim ? { unverifiedEditClaim: true } : {}),
      ...(outcome.unverifiedBuildClaim ? { unverifiedBuildClaim: true } : {}),
    });
    process.exit(0);
  } catch (err) {
    // The refusal's code crosses the boundary with the message: the parent logs
    // WHY, instead of inferring it from an exit code. The identity rides along so
    // the parent can record which provider/model/transport failed.
    const code = err instanceof SubagentRefusalError ? err.code : 'unavailable';
    send({
      type: 'error',
      code,
      error: err instanceof Error ? err.message : String(err),
      ...identity,
    });
    process.exit(1);
  }
}

void main();
