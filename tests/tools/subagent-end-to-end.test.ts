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
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

import {
  flushSpans,
  shutdownSpans,
  startTurnSpan,
  withSpanActive,
} from '../../src/observability/otel.js';
import { getSubagentManager, resetSubagentManager } from '../../src/tools/subagent-spawner.js';
import { runSubagent, resolveToolAllowList } from '../../src/tools/child-agent-runtime.js';
import { SubagentRefusalError } from '../../src/tools/subagent-refusal.js';
import type { InferenceProvider, ToolCallResponse, ToolMessage, ToolSchema } from '../../src/inference/interface.js';

// ─── Stub Ollama: the real HTTP endpoint the child talks to ─────────────────

let server: Server;
let baseUrl = '';
const seen: string[] = [];

/**
 * Hold the generation open, so a test can kill the child WHILE it is mid-call —
 * after it announced its identity and before it could report an outcome. The
 * only surviving trace of the run at that point is the first frame it sent.
 */
let generateDelayMs = 0;

/**
 * G1 — make the stub answer the NEXT `/api/generate` call with a JSON-transport
 * `write_file` request, so a REAL forked child mutates its workspace and verifies
 * nothing. Reset by the test that sets it; the counter is per-server, not per
 * child, so it is only armed for the duration of one spawn.
 */
let jsonWriteFirst = false;
/**
 * A3 Part 2 — make the stub answer the FIRST `/api/generate` call with a
 * JSON-transport `run_terminal` build command (a command that really fails in an
 * empty workspace) and the SECOND with a success claim, so a forked child can be
 * caught certifying a build its own ledger saw FAIL.
 */
let jsonBuildFirst = false;
let generateCalls = 0;

/** Poll until `pred()` holds, so a test can synchronise with a forked child. */
async function waitFor(pred: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('waitFor timed out');
}

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
      if (req.url === '/api/generate') {
        generateCalls += 1;
        let body: { response: string; done: boolean };
        if (jsonBuildFirst && generateCalls === 1) {
          // `make` with no Makefile is a build command that really fails (and it
          // is recognised by `isBuildCommand`). `confirm:true` because
          // `run_terminal` is state-changing and would otherwise be declined.
          body = {
            response:
              'Building.\n{"tool":"run_terminal","arguments":{"command":"make","confirm":true}}',
            done: true,
          };
        } else if (jsonBuildFirst && generateCalls === 2) {
          body = { response: 'The build succeeded.', done: true };
        } else if (jsonWriteFirst && generateCalls === 1) {
          // `confirm:true` because `write_file` is state-changing and would
          // otherwise be declined — the gate under test is the VERIFICATION
          // one, and it needs a write that really happened.
          body = {
            response:
              'Writing the note.\n{"tool":"write_file","arguments":{"path":"out.txt","content":"hi","confirm":true}}',
            done: true,
          };
        } else {
          body = { response: 'REAL-SUBAGENT-ANSWER', done: true };
        }
        const reply = () => json(body);
        if (generateDelayMs > 0) return void setTimeout(reply, generateDelayMs);
        return reply();
      }
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

    // WHO served the run and HOW, recorded on the run itself: this is what the
    // dashboard's Subagents tab reads back (provider, model and transport), so a
    // finished run is attributable instead of only inspectable by re-reading its
    // output. `transport: none` because no tools were requested.
    expect(mgr.getState(state.id)).toMatchObject({
      provider: 'local',
      model: 'test-model',
      transport: 'none',
    });
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

    // A run that produced NOTHING is still attributable. The child announces the
    // provider/model/transport on its first frame, before it can fail, and the
    // parent records them from every frame — without this a failed subagent landed
    // as a bare error, and the one moment you need to know which backend was
    // serving the run was the one moment the answer was missing.
    expect(mgr.getState(state.id)).toMatchObject({
      provider: 'local',
      model: 'test-model',
      transport: 'none',
    });
  }, 90_000);
});

// ─── 1b. A run killed before it could report is still attributable ───────────

describe('subagent — a killed run keeps the identity it announced', () => {
  it('records provider/model/transport from the first frame when no result ever arrives', async () => {
    const configDir = mkdtempSync(join(testHome.value, 'config-'));
    const mgr = getSubagentManager();

    generateDelayMs = 30_000;
    const state = await mgr.spawn({
      goal: 'report the answer',
      provider: 'local',
      model: 'test-model',
      env: { OLLAMA_HOST: baseUrl, NUVIRA_CONFIG_DIR: configDir },
    });

    try {
      // The child announced who was serving the run, then sat in the model call.
      await waitFor(() => mgr.getState(state.id)?.provider === 'local');
      mgr.kill(state.id, 'test');
      await waitFor(() => mgr.getState(state.id)?.status === 'killed');

      const killed = mgr.getState(state.id)!;
      // Nothing was produced — and it still says WHICH backend was producing it.
      expect(killed.result).toBeUndefined();
      expect(killed).toMatchObject({ provider: 'local', model: 'test-model', transport: 'none' });
    } finally {
      generateDelayMs = 0;
    }
  }, 90_000);
});

// ─── 1c. WS3 — the child's spans join the PARENT's trace ────────────────────

/**
 * A message-oriented loopback collector, enough to read a span tree back.
 *
 * The claim here is about a FORKED process, so the far end has to be a real
 * collector: the child builds its own provider in its own process, and the only
 * way to see what it exported is to receive it. (The unit-level contract lives in
 * `tests/observability/otel.test.ts`; the per-surface tree is asserted by the
 * `otel-export` parity scenario.)
 */
async function startCollector(): Promise<{
  url: string;
  spans: Array<{ name: string; traceId: string; spanId: string; parentSpanId: string }>;
  close(): Promise<void>;
}> {
  const spans: Array<{ name: string; traceId: string; spanId: string; parentSpanId: string }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
          resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<Record<string, string>> }> }>;
        };
        for (const entry of payload.resourceSpans ?? []) {
          for (const scope of entry.scopeSpans ?? []) {
            for (const span of scope.spans ?? []) {
              spans.push({
                name: span.name,
                traceId: span.traceId ?? '',
                spanId: span.spanId ?? '',
                parentSpanId: span.parentSpanId ?? '',
              });
            }
          }
        }
      } catch {
        /* a body we cannot parse is a span we report as missing */
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`,
    spans,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

describe('WS3 otel — a forked subagent continues the parent`s trace', () => {
  it('hands the child the ACTIVE span as a remote parent, and the child exports into the SAME trace', async () => {
    const collector = await startCollector();
    const previousOtel = process.env.NUVIRA_OTEL;
    const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    process.env.NUVIRA_OTEL = '1';
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = collector.url;

    const configDir = mkdtempSync(join(testHome.value, 'config-'));
    const mgr = getSubagentManager();
    try {
      const turn = await startTurnSpan({ surface: 'cli-chat', goal: 'delegate to a subagent' });
      expect(turn, 'the parent turn span was not created').not.toBeNull();
      const toolSpan = turn!.child('nuvira.tool.subagent');

      // The loop makes the TOOL span active around the tool`s execution, so the
      // spawner reads the right parent out of the context — never out of module
      // state, which two interleaved turns in one server would share.
      const state = await withSpanActive(toolSpan, () =>
        mgr.spawn({
          goal: 'report the answer',
          provider: 'local',
          model: 'test-model',
          env: { OLLAMA_HOST: baseUrl, NUVIRA_CONFIG_DIR: configDir },
        }),
      );
      const result = await mgr.waitForCompletion(state.id, 60_000);
      expect(result.success, `expected success, got: ${result.error ?? ''}`).toBe(true);

      toolSpan.end({ ok: true });
      turn!.end({ ok: true });
      await flushSpans();

      // The child`s OWN export, from its own process: exactly one turn span, and
      // it continues the trace the parent began rather than starting a second one.
      // The child exported its OWN turn span, in its own process …
      const childTurn = collector.spans.find(
        (s) => s.name === 'nuvira.turn' && s.parentSpanId === toolSpan.spanId,
      );
      expect(
        childTurn,
        `no child turn span joined to the parent tool span (got ${JSON.stringify(collector.spans)})`,
      ).toBeDefined();
      // … hanging off the parent`s TOOL span (the one that was active at the
      // fork), inside the parent`s trace. That is the whole claim: one trace
      // across a process boundary, not two unrelated ones.
      expect(childTurn!.traceId).toBe(turn!.traceId);
      // The parent`s own two spans are there as well, so the tree is complete.
      const parentTurn = collector.spans.find(
        (s) => s.name === 'nuvira.turn' && s.parentSpanId === '',
      );
      expect(parentTurn?.spanId).toBe(turn!.spanId);
      expect(collector.spans.map((s) => s.name).sort()).toEqual([
        'nuvira.tool.subagent',
        'nuvira.turn',
        'nuvira.turn',
      ]);
      expect(new Set(collector.spans.map((s) => s.traceId))).toEqual(new Set([turn!.traceId]));
    } finally {
      if (previousOtel === undefined) delete process.env.NUVIRA_OTEL;
      else process.env.NUVIRA_OTEL = previousOtel;
      if (previousEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = previousEndpoint;
      await shutdownSpans();
      await collector.close();
    }
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
    expect(outcome.transport).toBe('native');

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

  it('falls back to the shared JSON transport when the provider cannot call tools', async () => {
    // The `local`/Ollama case: no `generateTools`, so the tool call has to travel
    // as text. This used to REFUSE (honest, but it meant a local-only setup could
    // not use tools at all).
    const prompts: string[] = [];
    let turns = 0;
    const jsonOnly: InferenceProvider = {
      name: 'json-only',
      async isAvailable() {
        return true;
      },
      async generate(prompt: string) {
        prompts.push(prompt);
        turns += 1;
        if (turns === 1) {
          // The fallback shape the shared parser understands.
          return 'Let me look that up.\n{"tool":"read_file","arguments":{"path":"note.txt"}}';
        }
        return 'ANSWER-AFTER-FALLBACK';
      },
      // Deliberately NO generateTools.
    };

    const ran: string[] = [];
    const outcome = await runSubagent(
      { goal: 'read the note', tools: ['read_file'] },
      {
        createProvider: async () => ({ provider: jsonOnly, type: 'json-only' }),
        runTool: async (name) => {
          ran.push(name);
          return 'FALLBACK-NOTE';
        },
      },
    );

    expect(outcome.transport).toBe('json');
    expect(outcome.result).toBe('ANSWER-AFTER-FALLBACK');
    expect(ran).toEqual(['read_file']);
    // The shared fallback prompt carried the tool names and the argument shapes,
    // and the tool result was fed back on the next turn.
    expect(prompts[0]).toContain('read_file');
    expect(prompts[0]).toContain('TOOL ARGUMENT SHAPES');
    expect(prompts[1]).toContain('FALLBACK-NOTE');
    // A raw tool block must never reach the answer.
    expect(outcome.result).not.toContain('"tool"');
  });

  it('reports the native transport when the provider speaks the tool protocol', async () => {
    const outcome = await runSubagent(
      { goal: 'read the note', tools: ['read_file'] },
      { createProvider: async () => ({ provider: scriptedProvider(), type: 'scripted' }) },
    );
    expect(outcome.transport).toBe('native');
    expect(outcome.result).toBe('ANSWER-AFTER-TOOL');
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

  it('runs the operator`s declared hook, and a VETO holds inside the child', async () => {
    // WS4 (#26) — the child is a separate PROCESS and reads its own config, so a
    // policy that stopped at the process boundary would be worse than no policy:
    // it would look enforced. The hook here is a real command, declared through
    // the same environment a forked child inherits, and the assertions are on what
    // that command received and on whether the TOOL RAN.
    const hookDir = mkdtempSync(join(testHome.value, 'hooks-'));
    const logPath = join(hookDir, 'invocations.jsonl');
    const scriptPath = join(hookDir, 'hook.mjs');
    writeFileSync(
      scriptPath,
      `import { appendFileSync } from 'node:fs';
` +
        `let raw = '';process.stdin.setEncoding('utf8');
` +
        `for await (const c of process.stdin) raw += c;
` +
        `const payload = JSON.parse(raw);
` +
        `appendFileSync(process.env.HOOK_LOG, JSON.stringify({ phase: payload.phase, tool: payload.tool, surface: payload.surface ?? null }) + String.fromCharCode(10));
` +
        `if (process.env.HOOK_DENY === payload.tool) process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'not here' }));
`,
    );

    const previous = {
      before: process.env.NUVIRA_TOOL_HOOK_BEFORE,
      after: process.env.NUVIRA_TOOL_HOOK_AFTER,
      log: process.env.HOOK_LOG,
      deny: process.env.HOOK_DENY,
    };
    process.env.NUVIRA_TOOL_HOOK_BEFORE = `node ${scriptPath}`;
    process.env.NUVIRA_TOOL_HOOK_AFTER = `node ${scriptPath}`;
    process.env.HOOK_LOG = logPath;
    try {
      const seen: Array<{ phase: string; tool: string; surface: string | null }> = [];

      const allowed = await runSubagent(
        { goal: 'read the note', tools: ['read_file'] },
        {
          createProvider: async () => ({ provider: scriptedProvider(), type: 'scripted' }),
          runTool: async () => 'NOTE-CONTENTS',
        },
      );
      expect(allowed.toolCalls, 'the hook must not stop a call it did not deny').toBe(1);

      // Now the SAME call, with the operator denying it.
      process.env.HOOK_DENY = 'read_file';
      const ran: string[] = [];
      const vetoed = await runSubagent(
        { goal: 'read the note', tools: ['read_file'] },
        {
          createProvider: async () => ({ provider: scriptedProvider(), type: 'scripted' }),
          runTool: async (name) => {
            ran.push(name);
            return 'NOTE-CONTENTS';
          },
        },
      );

      // The veto held inside the child: the tool never ran, and the child did not
      // count a call it refused.
      expect(ran, 'a vetoed tool ran anyway in the child').toEqual([]);
      expect(vetoed.toolCalls).toBe(0);
      // The turn still completes: the refusal is fed back to the model, which
      // answers on its next call — a refused call is not a failed run.
      expect(vetoed.llmCalls).toBe(2);
      expect(vetoed.result).toBe('ANSWER-AFTER-TOOL');

      for (const line of readFileSync(logPath, 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        seen.push(JSON.parse(line) as { phase: string; tool: string; surface: string | null });
      }
      // The operator`s command was handed the call — and told WHICH surface it came
      // from, which is the difference between a policy that can be written and one
      // that has to be guessed at.
      expect(seen.map((entry) => `${entry.phase}:${entry.tool}`)).toEqual([
        'before:read_file',
        'after:read_file',
        'before:read_file',
      ]);
      expect(seen.every((entry) => entry.surface === 'subagent')).toBe(true);
    } finally {
      if (previous.before === undefined) delete process.env.NUVIRA_TOOL_HOOK_BEFORE;
      else process.env.NUVIRA_TOOL_HOOK_BEFORE = previous.before;
      if (previous.after === undefined) delete process.env.NUVIRA_TOOL_HOOK_AFTER;
      else process.env.NUVIRA_TOOL_HOOK_AFTER = previous.after;
      if (previous.log === undefined) delete process.env.HOOK_LOG;
      else process.env.HOOK_LOG = previous.log;
      if (previous.deny === undefined) delete process.env.HOOK_DENY;
      else process.env.HOOK_DENY = previous.deny;
      rmSync(hookDir, { recursive: true, force: true });
    }
  });

  it('refuses an unknown tool by name instead of quietly ignoring it', async () => {
    // The refusal is a TYPED error, which is what lets the child entry map it to
    // a `code` over IPC instead of the parent having to read the message text.
    const failure = await runSubagent(
      { goal: 'x', tools: ['no_such_tool'] },
      { createProvider: async () => ({ provider: scriptedProvider(), type: 's' }) },
    ).then(() => null, (err: unknown) => err);

    expect(failure).toBeInstanceOf(SubagentRefusalError);
    expect((failure as SubagentRefusalError).code).toBe('unsupported_format');
    expect((failure as Error).message).toMatch(/Unknown tool/);
  });
});

// ─── 3. G1 — the child applies the verification gate ────────────────────────

/**
 * A provider that replays a fixed script, one entry per model call, and records
 * what each call was sent. The interesting facts about the gate are how MANY
 * calls the child made and what the extra one was asked for.
 */
function turnsProvider(script: ToolCallResponse[]): { provider: InferenceProvider; calls: ToolMessage[][] } {
  const calls: ToolMessage[][] = [];
  let i = 0;
  const provider: InferenceProvider = {
    name: 'scripted-turns',
    async isAvailable() {
      return true;
    },
    async generate() {
      return 'NO-TOOLS-ANSWER';
    },
    async generateTools(messages): Promise<ToolCallResponse> {
      calls.push([...messages]);
      const next = script[Math.min(i, script.length - 1)];
      i += 1;
      return next;
    },
  };
  return { provider, calls };
}

/** The nudge text the loop sends — asserted by NAME, not by paraphrase. */
const NUDGE_MARKER = 'nothing VERIFIED the change';

const wroteOut = (): ToolCallResponse => ({
  content: '',
  toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'out.txt', content: 'hi' } }],
});

const answered = (content: string): ToolCallResponse => ({ content, toolCalls: [] });

describe('G1 — the child applies the same verification gate as the in-process loop', () => {
  it('spends ONE bounded nudge when the child wrote and verified nothing, and flags it', async () => {
    const workDir = mkdtempSync(join(testHome.value, 'gate-'));
    const { provider, calls } = turnsProvider([wroteOut(), answered('I have successfully created out.txt.')]);

    const outcome = await runSubagent(
      { goal: 'write out.txt', tools: ['write_file'], cwd: workDir },
      {
        createProvider: async () => ({ provider, type: 'scripted' }),
        runTool: async () => 'Wrote out.txt (3 bytes)',
      },
    );

    // write → nudge → answer. The nudge is a REAL model call, and it did not eat
    // the iteration budget: the ceiling is what the goal was owed.
    expect(outcome.llmCalls).toBe(3);
    expect(outcome.toolCalls).toBe(1);
    expect(outcome.truncated).toBe(false);
    expect(calls).toHaveLength(3);
    // The extra call was asked for the check, in the same words the in-process
    // loop uses — the gate is imported, not reimplemented.
    expect(calls[0].some((m) => m.content.includes(NUDGE_MARKER))).toBe(false);
    // Delivered as a marked harness directive (system role), not a user turn.
    expect(calls[2].some((m) => m.role === 'system' && m.content.startsWith('[harness]') && m.content.includes(NUDGE_MARKER))).toBe(true);
    expect(calls[2].some((m) => m.role === 'system' && m.content.includes('out.txt'))).toBe(true);

    // And the result says so, whether or not a caller acted on the nudge. A run
    // whose write nothing observed may not be read as a checked one.
    expect(outcome.unverifiedEdit).toBe(true);
    expect(outcome.unverifiedEditClaim).toBe(true);
  });

  it('does not nudge a child that verified its own write', async () => {
    const workDir = mkdtempSync(join(testHome.value, 'gate-'));
    const { provider, calls } = turnsProvider([
      wroteOut(),
      { content: '', toolCalls: [{ id: 'v1', name: 'run_terminal', arguments: { command: 'npm test' } }] },
      answered('Wrote out.txt and ran the check: 12 passed.'),
    ]);

    const outcome = await runSubagent(
      { goal: 'write out.txt and check it', tools: ['write_file', 'run_terminal'], cwd: workDir },
      {
        createProvider: async () => ({ provider, type: 'scripted' }),
        runTool: async (name) => (name === 'run_terminal' ? 'npm test — 12 passed' : 'Wrote out.txt'),
      },
    );

    // write → verify → answer, with no fourth call: the gate saw the artifact
    // observed and stayed quiet (and so did the needless-nudge path in-process).
    expect(outcome.llmCalls).toBe(3);
    expect(outcome.toolCalls).toBe(2);
    expect(calls.some((sent) => sent.some((m) => m.content.includes(NUDGE_MARKER)))).toBe(false);
    expect(outcome.unverifiedEdit).toBeUndefined();
    expect(outcome.unverifiedEditClaim).toBeUndefined();
  });

  it('does not treat a REFUSED write as a mutation to verify', async () => {
    const workDir = mkdtempSync(join(testHome.value, 'gate-'));
    const { provider, calls } = turnsProvider([
      {
        content: '',
        toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: '../escape.txt', content: 'x' } }],
      },
      answered('That path is outside the workspace, so nothing was written.'),
    ]);

    const outcome = await runSubagent(
      { goal: 'write ../escape.txt', tools: ['write_file'], cwd: workDir },
      {
        createProvider: async () => ({ provider, type: 'scripted' }),
        // The workspace guard's own wording — a refusal with NO `Error:` prefix.
        runTool: async () => 'Path ../escape.txt escapes the workspace (/tmp) — denied',
      },
    );

    // Two calls, not three: a declined write is not a mutation, so there was
    // nothing to verify. Counting it would send the model to verify a file that
    // was never written.
    expect(outcome.llmCalls).toBe(2);
    expect(calls.some((sent) => sent.some((m) => m.content.includes(NUDGE_MARKER)))).toBe(false);
    expect(outcome.unverifiedEdit).toBeUndefined();
  });

  it('carries the child\'s verdict across the FORK onto the parent\'s result', async () => {
    // The tracker item was about a real forked child, so the last check is a real
    // fork: a JSON-transport `write_file`, no verification, and the flag arriving
    // on the result frame the parent records.
    const workDir = mkdtempSync(join(testHome.value, 'gate-fork-'));
    // A forked child resolves its loader (`tsx` in a source run) from ITS cwd, so
    // an empty temp workspace has to have the dependencies linked in — exactly
    // what an isolated worktree does (`src/tools/worktree.ts`). Without this the
    // fork dies on `Cannot find package 'tsx'` before any of it runs.
    symlinkSync(join(process.cwd(), 'node_modules'), join(workDir, 'node_modules'), 'dir');
    const configDir = mkdtempSync(join(testHome.value, 'config-'));
    const mgr = getSubagentManager();
    jsonWriteFirst = true;
    generateCalls = 0;
    try {
      const state = await mgr.spawn({
        goal: 'write the note',
        provider: 'local',
        model: 'test-model',
        tools: ['write_file'],
        cwd: workDir,
        env: { OLLAMA_HOST: baseUrl, NUVIRA_CONFIG_DIR: configDir },
      });
      const result = await mgr.waitForCompletion(state.id, 60_000);

      expect(result.success, `expected success, got: ${result.error ?? ''}\n${result.log.join('\n')}`).toBe(
        true,
      );
      // The write really happened (in the child's own cwd), and the child made the
      // extra call to ask for a check before answering.
      expect(readFileSync(join(workDir, 'out.txt'), 'utf8')).toBe('hi');
      expect(result.toolCalls).toBe(1);
      expect(result.llmCalls).toBe(3);
      // The parent knows: recorded from the frame, not inferred from the text.
      expect(result.unverifiedEdit).toBe(true);
      expect(mgr.getState(state.id)?.unverifiedEdit).toBe(true);
    } finally {
      jsonWriteFirst = false;
      generateCalls = 0;
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('A3 Part 2 — a forked child that certifies a FAILED build is flagged', () => {
  it("carries the child's unverified-build verdict across the FORK", async () => {
    // The child runs a build command that really fails (its own ledger records
    // `ok:false`), then answers that the build succeeded. The in-process honesty
    // detector (`detectFailedBuildSuccessClaim`, imported — never reimplemented)
    // must fire in the child, and the flag must arrive on the parent's result.
    const workDir = mkdtempSync(join(testHome.value, 'build-fork-'));
    // A forked child resolves its loader (`tsx` in a source run) from ITS cwd.
    symlinkSync(join(process.cwd(), 'node_modules'), join(workDir, 'node_modules'), 'dir');
    const configDir = mkdtempSync(join(testHome.value, 'config-'));
    const mgr = getSubagentManager();
    jsonBuildFirst = true;
    generateCalls = 0;
    try {
      const state = await mgr.spawn({
        goal: 'build the project',
        provider: 'local',
        model: 'test-model',
        tools: ['run_terminal'],
        cwd: workDir,
        env: { OLLAMA_HOST: baseUrl, NUVIRA_CONFIG_DIR: configDir },
      });
      const result = await mgr.waitForCompletion(state.id, 60_000);

      expect(result.success, `expected success, got: ${result.error ?? ''}\n${result.log.join('\n')}`).toBe(
        true,
      );
      // The build really ran (and really failed): a `make` with no Makefile.
      expect(result.toolCalls).toBeGreaterThanOrEqual(1);
      // The parent knows, recorded from the child's frame rather than inferred
      // from the prose.
      expect(result.unverifiedBuildClaim).toBe(true);
      expect(mgr.getState(state.id)?.unverifiedBuildClaim).toBe(true);
    } finally {
      jsonBuildFirst = false;
      generateCalls = 0;
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 90_000);
});

// ─── Phase 4b/4c — a resumed child rehydrates its prior conversation ─────────

describe('Phase 4b/4c — a resumed child rehydrates the conversation it left', () => {
  it('feeds a dead child`s OPEN session back into the new run', async () => {
    const workDir = mkdtempSync(join(testHome.value, 'sess-'));
    const memDir = mkdtempSync(join(testHome.value, 'mem-'));
    const prevMem = process.env.NUVIRA_MEMORY_DIR;
    process.env.NUVIRA_MEMORY_DIR = memDir;
    try {
      const { openSession } = await import('../../src/learning/session-store.js');
      const store = openSession({ goal: 'read the note', cwd: workDir });
      // Deliberately left OPEN — this is a child that died mid-task.
      store.save(
        [
          { role: 'system', content: 'stale child prompt' },
          { role: 'user', content: 'read the note' },
          { role: 'assistant', content: 'PRIOR-CHILD-MARKER' },
        ],
        { steps: 1, successfulTools: ['read_file'], mutatedPaths: [] },
      );

      const calls: ToolMessage[][] = [];
      const outcome = await runSubagent(
        { goal: 'read the note', tools: ['read_file'], cwd: workDir, resume: true },
        {
          createProvider: async () => ({
            provider: scriptedProvider((m) => calls.push([...m])),
            type: 'scripted',
          }),
          runTool: async () => 'NOTE-CONTENTS',
        },
      );

      expect(outcome.result).toBe('ANSWER-AFTER-TOOL');
      // The dead child's conversation is present…
      expect(calls[0].some((m) => m.content.includes('PRIOR-CHILD-MARKER'))).toBe(true);
      // …and the stored (stale) head was replaced by a fresh one.
      expect(calls[0].some((m) => m.content.includes('stale child prompt'))).toBe(false);
    } finally {
      if (prevMem === undefined) delete process.env.NUVIRA_MEMORY_DIR;
      else process.env.NUVIRA_MEMORY_DIR = prevMem;
      rmSync(workDir, { recursive: true, force: true });
      rmSync(memDir, { recursive: true, force: true });
    }
  });
});
