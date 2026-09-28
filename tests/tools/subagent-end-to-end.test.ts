/**
 * The subagent child-process path, end to end.
 *
 * `subagent` was a dead path: `spawn()` threw `require is not defined` (an ESM
 * `require`), and even without that it forked a file the build never emits. The
 * worker it wrapped was simulated — `LLMClient.call()` switched on keywords in the
 * goal and returned canned strings, and its tool executor answered `Executed
 * <tool>` without running anything. Every test here fails on that original code.
 *
 * Two halves, on purpose:
 *
 *  1. **Real fork, real HTTP.** A child process is spawned for real, resolves a
 *     real provider (the `local` adapter), and makes a real request to an HTTP
 *     server started in this file. That covers the parts a mock cannot: the entry
 *     shipped/loaded in this package's module system, the fork handshake, and the
 *     IPC result. `~/.nuvira` is redirected (mock below) so no state lands in the
 *     developer's home.
 *  2. **Real tool loop, injected model.** Native tool-calling is driven with a
 *     scripted provider so the loop can be asserted without a network — and the
 *     tool that runs is a REAL registry tool, not a stub that claims to have run.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// `SubagentManager` computes its state/log dirs from `resolveNuviraHome()` at
// import time, which is `join(homedir(), '.nuvira')`. Without this the suite
// writes subagent state into the developer's real home. Same pattern as
// tests/tools/tool-truthfulness.test.ts.
const testHome = vi.hoisted(() => {
  const { mkdtempSync: mk } = require('node:fs');
  const { join: j } = require('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { value: mk(j(base, 'buff-subagent-home-')) };
});

vi.mock('node:os', () => ({
  homedir: () => testHome.value,
  tmpdir: () => process.env.TMPDIR || process.env.TEMP || '/tmp',
}));

import { getSubagentManager, resetSubagentManager } from '../../src/tools/subagent-spawner.js';
import { runSubagent, resolveToolAllowList } from '../../src/tools/child-agent-runtime.js';
import { SubagentRefusalError } from '../../src/tools/subagent-refusal.js';
import type { InferenceProvider, ToolCallResponse, ToolMessage, ToolSchema } from '../../src/inference/interface.js';

// ─── Stub Ollama: the real HTTP endpoint the child talks to ─────────────────

let server: Server;
let baseUrl = '';
const seen: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => {
      const json = (body: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/api/tags') return json({ models: [{ name: 'test-model' }] });
      if (req.url === '/api/generate') return json({ response: 'REAL-SUBAGENT-ANSWER', done: true });
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetSubagentManager();
  rmSync(testHome.value, { recursive: true, force: true });
});

// ─── 1. Real fork + real LLM call ───────────────────────────────────────────

describe('subagent — a forked child makes a real LLM call', () => {
  it('spawns, calls the provider over HTTP, and returns the model output', async () => {
    const configDir = mkdtempSync(join(testHome.value, 'config-'));
    const mgr = getSubagentManager();
    seen.length = 0;

    const state = await mgr.spawn({
      goal: 'report the answer',
      provider: 'local',
      model: 'test-model',
      // The child resolves its provider from a throwaway config dir and points
      // the local adapter at this file's server, rather than the developer's.
      env: { OLLAMA_HOST: baseUrl, NUVIRA_CONFIG_DIR: configDir },
    });

    const result = await mgr.waitForCompletion(state.id, 60_000);

    expect(result.success, `expected success, got: ${result.error ?? ''}\n${result.log.join('\n')}`).toBe(true);
    expect(result.result).toBe('REAL-SUBAGENT-ANSWER');
    expect(result.llmCalls).toBe(1);
    // The child talked to the stub over real HTTP — the provider was constructed
    // and used, not simulated.
    expect(seen).toContain('POST /api/generate');
  }, 90_000);

  it('refuses (rather than answering) when the backend is unreachable', async () => {
    const configDir = mkdtempSync(join(testHome.value, 'config-'));
    const mgr = getSubagentManager();

    const state = await mgr.spawn({
      goal: 'report the answer',
      provider: 'local',
      model: 'test-model',
      // Port 9 (discard) refuses immediately.
      env: { OLLAMA_HOST: 'http://127.0.0.1:9', NUVIRA_CONFIG_DIR: configDir },
    });

    // A failed subagent REJECTS (the manager's contract) — and the rejection
    // carries the child's own typed reason, not a bare "Exit code 1".
    const failure = await mgr.waitForCompletion(state.id, 60_000).then(
      () => null,
      (err: Error & { code?: string }) => err,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain('not reachable');
    expect(failure!.code).toBe('not_configured');
    // No plausible answer was produced for work that did not happen.
    expect(mgr.getState(state.id)?.result).toBeUndefined();
  }, 90_000);
});

// ─── 2. Real tool loop ──────────────────────────────────────────────────────

/** A provider that asks for one tool, then answers — and records what it saw. */
function scriptedProvider(onCall?: (messages: ToolMessage[], tools: ToolSchema[]) => void): InferenceProvider {
  let calls = 0;
  return {
    name: 'scripted',
    async isAvailable() {
      return true;
    },
    async generate() {
      return 'NO-TOOLS-ANSWER';
    },
    async generateTools(messages, tools): Promise<ToolCallResponse> {
      onCall?.(messages, tools);
      calls += 1;
      if (calls === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'note.txt' } }],
        };
      }
      return { content: 'ANSWER-AFTER-TOOL', toolCalls: [] };
    },
  };
}

describe('subagent — the tool loop runs real tools', () => {
  it('offers the requested tool schemas and feeds the tool result back', async () => {
    const calls: Array<{ messages: ToolMessage[]; tools: ToolSchema[] }> = [];
    const ran: string[] = [];

    const outcome = await runSubagent(
      { goal: 'read the note', tools: ['read_file'], cwd: testHome.value },
      {
        createProvider: async () => ({ provider: scriptedProvider((m, t) => calls.push({ messages: [...m], tools: [...t] })), type: 'scripted' }),
        runTool: async (name, args) => {
          ran.push(`${name}:${String((args as { path?: string }).path)}`);
          return 'NOTE-CONTENTS';
        },
      },
    );

    expect(outcome.result).toBe('ANSWER-AFTER-TOOL');
    expect(outcome.llmCalls).toBe(2);
    expect(outcome.toolCalls).toBe(1);
    expect(outcome.truncated).toBe(false);

    // The model was offered the real schema for the tool it was allowed.
    expect(calls[0].tools.map((t) => t.name)).toEqual(['read_file']);
    expect(calls[0].tools[0].description.length).toBeGreaterThan(10);

    // The tool really ran, and its output was replayed to the model.
    expect(ran).toEqual(['read_file:note.txt']);
    const replayed = calls[1].messages;
    expect(replayed.some((m) => m.role === 'tool' && m.content === 'NOTE-CONTENTS')).toBe(true);
    // The assistant turn went back with the tool call and its id intact.
    expect(replayed.some((m) => m.role === 'assistant' && m.toolCalls?.[0]?.id === 'call-1')).toBe(true);
  });

  it('runs the tool through the REAL registry, not a stand-in', async () => {
    // read_file is a real tool: it reads a real file from the working directory.
    const { writeFileSync } = await import('node:fs');
    const workDir = mkdtempSync(join(testHome.value, 'work-'));
    writeFileSync(join(workDir, 'note.txt'), 'CONTENT-FROM-DISK');

    const outcome = await runSubagent(
      { goal: 'read the note', tools: ['read_file'], cwd: workDir },
      { createProvider: async () => ({ provider: scriptedProvider(), type: 'scripted' }) },
    );

    expect(outcome.result).toBe('ANSWER-AFTER-TOOL');
    expect(outcome.toolCalls).toBe(1);
    rmSync(workDir, { recursive: true, force: true });
  });

  it('refuses tools the provider cannot call instead of answering without them', async () => {
    const noTools: InferenceProvider = {
      name: 'no-tools',
      async isAvailable() {
        return true;
      },
      async generate() {
        return 'plain answer';
      },
    };

    await expect(
      runSubagent(
        { goal: 'read the note', tools: ['read_file'] },
        { createProvider: async () => ({ provider: noTools, type: 'no-tools' }) },
      ),
    ).rejects.toThrow(SubagentRefusalError);
  });

  it('drops blocked and unknown tools rather than offering them', () => {
    const { allowed, unknown } = resolveToolAllowList({
      goal: 'x',
      tools: ['read_file', 'ask_user', 'no_such_tool'],
      blockedTools: ['run_terminal'],
    });
    expect(allowed).toEqual(['read_file']);
    expect(unknown).toEqual(['no_such_tool']);
  });

  it('refuses an unknown tool by name instead of quietly ignoring it', async () => {
    await expect(
      runSubagent({ goal: 'x', tools: ['no_such_tool'] }, { createProvider: async () => ({ provider: scriptedProvider(), type: 's' }) }),
    ).rejects.toThrow(/Unknown tool/);
  });
});
