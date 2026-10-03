/**
 * Golden provider-wire fixtures — record/replay guard for the REQUEST we send.
 *
 * WHY THIS EXISTS. nuvira's largest failure mode is silent drift on a huge
 * surface: a tool schema, a message-ordering rule, or a serialization detail
 * changes and nothing notices, because every existing test asserts on a
 * RESPONSE (what the engine did) rather than on the REQUEST (what we sent). A
 * recorded golden request catches exactly that class — "the bytes we put on the
 * provider wire changed shape" — and it does so deterministically, with no
 * network and no model.
 *
 * HOW IT CAPTURES, WITHOUT A TEST SEAM IN PRODUCTION CODE. A loopback
 * OpenAI-compatible server stands in for the provider (the same transport-depth
 * seam `src/parity/drivers.ts` uses). A REAL adapter (`GroqAdapter`) is pointed
 * at it, and the REAL tool loop drives the adapter. The server records each
 * request body verbatim. Nothing in `chat.ts`, `tool-loop.ts`, `tools.ts` or the
 * adapters is modified — the seam is configuration, not a mock.
 *
 * WHAT IS NORMALIZED, AND WHY SO LITTLE. The fixture is the request as sent:
 * model, messages (in order), tool schemas (in order), temperature, max_tokens,
 * stream. Object keys are sorted so JSON key order is not drift; array order is
 * PRESERVED because message and tool ordering is exactly the kind of thing this
 * guard exists to protect. Inputs are fixed by the harness, so the request is
 * fully deterministic — there is no timestamp or path to scrub.
 *
 * ADOPTED FROM claw-code's mock parity harness (`mock-anthropic-service` + 21
 * captured `/v1/messages` requests), reimplemented for nuvira's loop and wire.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { GroqAdapter } from '../inference/groq-adapter.js';
import type { ToolMessage } from '../inference/interface.js';
import { runToolLoop, type StepResponse, type ToolLoopDeps } from '../tools/tool-loop.js';
import type { ToolContext, ToolJsonSchema } from '../tools/registry.js';

// ─── Locations ──────────────────────────────────────────────────────────────

/** The committed fixture directory (resolved from this module, not cwd). */
export const WIRE_FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tests',
  'fixtures',
  'provider-wire',
);

/** A fixture file path for a named case. */
export function wireFixturePath(name: string): string {
  return join(WIRE_FIXTURE_DIR, `${name}.json`);
}

/** Read a committed fixture, or null when it does not exist yet. */
export function readWireFixture(name: string): WireFixture | null {
  try {
    const path = wireFixturePath(name);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as WireFixture;
  } catch {
    return null;
  }
}

/** Write a fixture (used by the record mode). */
export function writeWireFixture(name: string, fixture: WireFixture): void {
  mkdirSync(WIRE_FIXTURE_DIR, { recursive: true });
  writeFileSync(wireFixturePath(name), `${JSON.stringify(fixture, null, 2)}\n`, 'utf-8');
}

/** Every committed fixture case name (sorted), for the check loop. */
export function listWireFixtures(): string[] {
  try {
    return readdirSync(WIRE_FIXTURE_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

// ─── Normalization + diff ───────────────────────────────────────────────────

/** One recorded request: the wire body plus the case it belongs to. */
export interface WireFixture {
  /** Human label for the case. */
  case: string;
  /** Note on what the case proves, so a reader knows why it is pinned. */
  proves: string;
  /** The requests the loop sent, in order. */
  requests: unknown[];
}

/**
 * Recursively sort object keys so JSON key order is never reported as drift.
 * Arrays keep their order (message/tool ordering IS the contract).
 */
export function normalizeWireRequest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => normalizeWireRequest(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalizeWireRequest((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** One point of divergence between a golden and an actual request. */
export interface WireDiff {
  path: string;
  golden: unknown;
  actual: unknown;
}

/**
 * Structural diff of two normalized wire values. Returns [] when identical.
 * Paths read like `messages[1].tool_calls[0].function.name`, so a failure names
 * the exact field that drifted rather than dumping two JSON blobs.
 */
export function wireDiff(golden: unknown, actual: unknown, path = '$'): WireDiff[] {
  if (golden === actual) return [];

  if (Array.isArray(golden) || Array.isArray(actual)) {
    if (!Array.isArray(golden) || !Array.isArray(actual)) {
      return [{ path, golden, actual }];
    }
    if (golden.length !== actual.length) {
      return [{ path: `${path}.length`, golden: golden.length, actual: actual.length }];
    }
    const out: WireDiff[] = [];
    for (let i = 0; i < golden.length; i += 1) {
      out.push(...wireDiff(golden[i], actual[i], `${path}[${i}]`));
    }
    return out;
  }

  if (golden && actual && typeof golden === 'object' && typeof actual === 'object') {
    const g = golden as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(g), ...Object.keys(a)])].sort();
    const out: WireDiff[] = [];
    for (const key of keys) {
      if (!(key in g)) out.push({ path: `${path}.${key}`, golden: undefined, actual: a[key] });
      else if (!(key in a)) out.push({ path: `${path}.${key}`, golden: g[key], actual: undefined });
      else out.push(...wireDiff(g[key], a[key], `${path}.${key}`));
    }
    return out;
  }

  return [{ path, golden, actual }];
}

// ─── The loopback recorder ──────────────────────────────────────────────────

/** A running loopback provider that records every request body it receives. */
export interface WireRecorder {
  /** Base URL including the `/v1` suffix the Groq adapter expects. */
  readonly baseUrl: string;
  /** Every `/chat/completions` request body, in arrival order (verbatim). */
  requests(): unknown[];
  close(): Promise<void>;
}

/**
 * Start a loopback OpenAI-compatible endpoint that records requests.
 *
 * The responder decides what to answer (deterministic, per case). It receives
 * the parsed body and the number of requests seen so far, so a case can script
 * "tool call first, final answer after the tool result".
 */
export async function startWireRecorder(
  respond: (body: Record<string, unknown>, callIndex: number) => unknown,
): Promise<WireRecorder> {
  const requests: unknown[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'wire-stub-model', object: 'model' }] }));
        return;
      }
      if (req.url?.endsWith('/chat/completions')) {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
        } catch {
          body = {};
        }
        const callIndex = requests.length;
        requests.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(respond(body, callIndex)));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: () => requests.map((r) => r),
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
      }),
  };
}

// ─── The core-loop cases ────────────────────────────────────────────────────

/**
 * The narrow, fixed tool set the core-loop cases expose. Deliberately SMALL:
 * the fixture is a human-reviewable record of the wire SHAPE (message ordering,
 * tool_call / tool-result serialization, model params), not a dump of every
 * schema. Schema-count drift is a different guard.
 */
const CASE_TOOL_NAMES: string[] = ['read_file', 'run_terminal'];

/** The fixed opening thread every case starts from. */
function caseMessages(): ToolMessage[] {
  return [
    { role: 'system', content: 'You are a coding agent. Use the tools to complete the task.' },
    { role: 'user', content: 'Read package.json and report the version.' },
  ];
}

/** A tool-call response asking for `read_file`, then a final answer. */
function toolThenAnswer(body: Record<string, unknown>): unknown {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string }>) : [];
  const toolAlreadyRan = messages.some((m) => m?.role === 'tool');
  if (!toolAlreadyRan) {
    return {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'wire_call_1',
                type: 'function',
                function: { name: 'read_file', arguments: JSON.stringify({ path: 'package.json' }) },
              },
            ],
          },
        },
      ],
    };
  }
  return { choices: [{ message: { content: 'The version is 3.3.8.' } }] };
}

/**
 * Capture the exact wire requests the REAL core loop sends, for the committed
 * cases. Runs entirely in-process against the loopback recorder: a real Groq
 * adapter, the real `runToolLoop`, a fixed tool set, and a deterministic tool
 * executor. No network, no model, no API key beyond the stub's dummy.
 */
export async function captureCoreLoopRequests(): Promise<WireFixture[]> {
  const out: WireFixture[] = [];

  // Case 1 — a tool-calling turn: the first request carries the tool schemas and
  // the opening thread; the second carries the assistant tool_call and the tool
  // result. Both are pinned, because both are things that can drift silently.
  {
    const recorder = await startWireRecorder((body) => toolThenAnswer(body));
    const adapter = new GroqAdapter({
      apiKey: 'wire-stub-key',
      model: 'wire-stub-model',
      baseUrl: recorder.baseUrl,
    });
    const context: ToolContext = {
      configManager: {},
      cwd: process.cwd(),
      authorizationRequest: 'Read package.json and report the version.',
    };
    const deps: ToolLoopDeps = {
      callModel: async (messages: ToolMessage[], tools: ToolJsonSchema[]) =>
        (await adapter.generateTools!(messages, tools)) as StepResponse,
      executeTool: async () => '{\n  "name": "agent-nuvira",\n  "version": "3.3.8"\n}',
      onEvent: () => {},
    };
    try {
      await runToolLoop({
        messages: caseMessages(),
        context,
        deps,
        // Narrow the exposed tools so the fixture pins the CORE wire shape
        // (message ordering, tool_call/tool-result serialization) rather than
        // the full ~112-schema catalogue, which would make a 300KB fixture no
        // human can review. Schema-count/shape drift is a separate concern.
        tools: CASE_TOOL_NAMES,
        maxSteps: 4,
        requireVerification: false,
        requireDeliverable: false,
      });
    } finally {
      await recorder.close();
    }
    out.push({
      case: 'tool-call-roundtrip',
      proves:
        'The core loop puts the tool schemas, the opening thread, the assistant tool_call and the tool result on the wire in this exact shape and order.',
      requests: recorder.requests().map((r) => normalizeWireRequest(r)),
    });
  }

  // Case 2 — a plain turn (no tools): the request the adapter sends when the loop
  // finishes without a tool call. Pins model/temperature/max_tokens/stream and
  // the messages-only body shape.
  {
    const recorder = await startWireRecorder(() => ({
      choices: [{ message: { content: 'Done — no tools needed.' } }],
    }));
    const adapter = new GroqAdapter({
      apiKey: 'wire-stub-key',
      model: 'wire-stub-model',
      baseUrl: recorder.baseUrl,
    });
    const context: ToolContext = {
      configManager: {},
      cwd: process.cwd(),
      authorizationRequest: 'Say hello.',
    };
    const deps: ToolLoopDeps = {
      callModel: async (messages: ToolMessage[], tools: ToolJsonSchema[]) =>
        (await adapter.generateTools!(messages, tools)) as StepResponse,
      executeTool: async () => '',
      onEvent: () => {},
    };
    try {
      await runToolLoop({
        messages: [
          { role: 'system', content: 'You are a coding agent.' },
          { role: 'user', content: 'Say hello.' },
        ],
        context,
        deps,
        tools: CASE_TOOL_NAMES,
        maxSteps: 2,
        requireVerification: false,
        requireDeliverable: false,
      });
    } finally {
      await recorder.close();
    }
    out.push({
      case: 'plain-turn',
      proves:
        'A tool-less turn still sends the full tool schema set (native tool-calling) with this body shape; model/temperature/max_tokens drift shows up here.',
      requests: recorder.requests().map((r) => normalizeWireRequest(r)),
    });
  }

  return out;
}
