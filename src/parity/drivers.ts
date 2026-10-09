/**
 * WS0 (#22) — the drivers that actually run a turn on each surface.
 *
 * WHY THESE LIVE IN `src/` NOW. They used to live in `tests/parity/drivers.ts`
 * and reached the stub through `vi.spyOn` on the real engine — which made the
 * harness unrunnable outside the test runner, and left "prove every surface at
 * par" as something only CI could do. The requirement is a `nuvira parity`
 * command, so the drivers had to become a thing production code can call.
 *
 * The seam is CONFIGURATION, not a mock. Every surface resolves its provider
 * through the SAME shared `resolveProvider` (`src/cli/router.ts`), so a temp
 * `buffconfig.json` naming `groq` with `providers.groq.baseUrl` pointed at a
 * loopback OpenAI-compatible stub makes the whole stack run for real: the real
 * ChatCommand, the real console, the real gateway registry, the real execute
 * command and the real forked child, each with a REAL provider object (the Groq
 * adapter). Only the server on the other end of the socket is a stub — the
 * definition of `transport` depth in `./scenarios.ts`, and the same depth the
 * forked child was already driven at.
 *
 * NO TEST SEAM WAS ADDED TO PRODUCTION CODE. The surfaces already accept what is
 * needed: `answerOnce`/`ChatConsole.answer` take `provider`/`model`, the gateway
 * derives the pair from its own config (`registry.ts:1797`), and the child reads
 * its own `buffconfig.json`. Nothing in `chat.ts`, `chat-console.ts`,
 * `gateway/registry.ts`, `execute.ts` or the spawner changed to make this work.
 *
 * ISOLATION IS THE POINT, AND IT IS PROCESS-LOCAL. A run points
 * `NUVIRA_CONFIG_DIR` and `NUVIRA_MEMORY_DIR` at a throwaway directory for its
 * whole life, so the stub never touches the developer's real profile — no real
 * API key, no real response cache, no real model registry, no real gateway log.
 * That is the same convention `src/config/paths.ts` documents and the same one
 * the test drivers relied on. It cannot leak into a separately-running dashboard
 * or gateway: a `nuvira parity` invocation is its own process.
 *
 * EVERY SURFACE'S OBSERVATION IS READ FROM THAT SURFACE'S OWN REPORT — the
 * engine's return for the CLI, the console's result for the dashboard, the
 * gateway's `inbound.chat` log record for the gateway, the command's result for
 * execute, the child's own progress frames for the subagent. Nothing is
 * reconstructed here, so a surface that stops reporting its status, attribution
 * or tool calls goes red instead of quietly losing the fact.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { getCache } from '../context/cache.js';
import type { WireFinding } from '../findings/verdicts.js';
import { readGatewayLog } from '../gateway/gateway-log.js';
import type { ChannelAdapter } from '../gateway/adapters.js';
import { debugLogDir, readLatestDebugLog } from '../observability/debug-log.js';
// WS3 (#25) — the far end of the export the surfaces run, and the two names that
// define the portable span tree (`src/observability/otel.ts`).
import {
  otelEnableVarName,
  shutdownSpans,
  TOOL_SPAN_PREFIX,
  TURN_SPAN_NAME,
} from '../observability/otel.js';
// WS4 (#26) — the hook ENV names the harness declares through, and the phases
// they exist for. Imported from the module that defines them so a renamed
// variable cannot leave the harness silently declaring nothing (which would read
// as "no surface fired a hook", the failure this row is meant to catch).
import { TOOL_HOOK_ENV, TOOL_HOOK_PHASES } from '../tools/tool-hooks.js';
import {
  noDebugLog,
  noFault,
  noIsolation,
  noOtelExport,
  noResume,
  noToolHooks,
  turnStatus,
  type DebugLogObs,
  type FaultObs,
  type IsolationObs,
  type OtelExportObs,
  type ResumeObs,
  type ToolCallObs,
  type ToolHooksObs,
  type TurnObservation,
} from './observation.js';
// WS6 (#28) — the fault protocol. The harness OWNS the provider faults (the stub
// answers them) and DECLARES the seam faults (`tool`/`ipc`), so both halves of the
// workstream are driven through the same run rather than two harnesses.
import { FAULT_ENV, faultMessage, formatFaultPlan, resetFaultInjector } from '../runtime/fault-injection.js';
// WS5 (#27) — the two env keys the harness declares these capabilities THROUGH,
// imported from the modules that define them so a renamed variable cannot leave
// the harness silently declaring nothing (which would read as "no surface
// isolated its turn", the failure this row is meant to catch).
import { WORKTREE_ENABLE_ENV } from '../tools/worktree.js';
import { RESUME_ENABLE_ENV } from '../learning/step-checkpoint.js';
import type { ParityDriver, ParityScenario, StubDepth } from './scenarios.js';
import type { SurfaceId } from './surfaces.js';

/**
 * Where every driver stubs. Transport depth is not a compromise here — it is
 * what makes the comparison honest: the provider OBJECT is the real adapter and
 * the turn code above it is untouched. The runner folds `provider` and
 * `transport` into one comparable class (`./scenarios.ts`, rule 1), so these
 * observations compare with anything else that runs the real turn code.
 */
export const DRIVER_DEPTH: StubDepth = 'transport';

/** The provider id every surface is configured with, so the comparison is at-par. */
export const PARITY_PROVIDER_TYPE = 'groq';

/** The one model the stub serves. The surfaces are pinned to it, so all five agree. */
export const PARITY_MODEL = 'parity-stub-model';

/** The stub's API key. Never a real credential — the stub never validates it. */
const PARITY_API_KEY = 'parity-stub-key';

/**
 * The surfaces this module can drive. Declared as data so a caller can assert
 * the driver list covers the registry without paying for a live harness — a
 * surface missing here would otherwise be counted as neither covered nor
 * blocked, the silent hole this harness exists to prevent.
 */
export const PARITY_DRIVER_SURFACES: readonly SurfaceId[] = [
  'cli-chat',
  'dashboard-chat',
  'gateway-chat',
  'cli-execute',
  'subagent',
];

// ─── The stub server ────────────────────────────────────────────────────────

/**
 * A loopback OpenAI-compatible endpoint that answers the scenario.
 *
 * STATELESS PER CALL, ON PURPOSE (inherited from the test drivers): the first
 * reply asks for the scenario's tool, and any reply after a `tool`-role message
 * closes the turn. A step counter would break the moment two turns share a
 * provider, which the response cache made happen once already — reading the
 * thread instead makes the stub correct however the run is replayed.
 */
interface ParityStub {
  /** Base URL including the `/v1` suffix the Groq adapter expects. */
  readonly baseUrl: string;
  /** Model completions the stub actually served — the non-vacuity count. */
  chatCalls(): number;
  /**
   * WS6 (#28) — how many completions this stub answered with a DECLARED fault.
   *
   * Kept separate from `chatCalls` on purpose: the model call happened (the
   * harness's rule 4 requires it), and this count is what says the failure those
   * calls met was the harness's own injection rather than the socket.
   */
  faultsServed(): number;
  close(): Promise<void>;
}

async function startStub(scenario: ParityScenario): Promise<ParityStub> {
  let chatCalls = 0;
  let faultsServed = 0;
  // Only a PROVIDER-site fault is the stub's to serve. A `tool`/`ipc` fault is
  // declared to the running agent instead (`withTurnEnvelope`), which is what
  // makes the seam, rather than this stub, the thing under test there.
  const providerFault = scenario.fault?.site === 'provider' ? scenario.fault : null;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const json = (body: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url?.endsWith('/models')) {
        // A reachability probe or a model-list validation against an
        // OpenAI-compatible endpoint asks here. The stub serves the ONE model
        // the surfaces are pinned to, so `resolveWorkingModel` keeps the pin
        // instead of repairing it to some other provider's default.
        // DELIBERATELY NOT FAULTED: a faulted probe would make the surfaces fail
        // in their ROUTING rather than in their turn, which is a different row
        // (and would let a surface pass without ever attempting the call).
        return json({ data: [{ id: PARITY_MODEL, object: 'model' }] });
      }
      if (req.url?.endsWith('/chat/completions')) {
        chatCalls += 1;
        // WS6 (#28) — the DECLARED provider fault, served on the wire so the REAL
        // adapter's error mapping is what runs. `faultMessage` is shared with the
        // seam, so a fault reads the same words wherever it came from, and a body
        // that cannot be parsed is a distinct kind rather than a second flavour of
        // "error" — a response that arrives but says nothing is its own failure.
        if (providerFault && faultsServed < providerFault.times) {
          faultsServed += 1;
          if (providerFault.kind === 'malformed') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"choices": [{"message": {"content": '); // truncated on purpose
            return;
          }
          res.writeHead(providerFault.kind === 'unavailable' ? 503 : 500, {
            'content-type': 'application/json',
          });
          res.end(
            JSON.stringify({
              error: { message: faultMessage(providerFault, 'the model call') },
            }),
          );
          return;
        }
        let body: { stream?: boolean; messages?: Array<{ role?: string }> } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          body = {};
        }
        const toolAlreadyRan = (body.messages ?? []).some((m) => m?.role === 'tool');
        const wantTool = Boolean(scenario.toolCall) && !toolAlreadyRan;
        const content = wantTool ? '' : scenario.answer;
        const toolCalls = wantTool
          ? [
              {
                id: 'parity_call_1',
                type: 'function',
                function: {
                  name: scenario.toolCall!.tool,
                  arguments: JSON.stringify(scenario.toolCall!.args),
                },
              },
            ]
          : undefined;

        // The dashboard console passes `onToken`, so the real Groq adapter takes
        // the STREAMING path (`generateToolsStream` -> SSE). Answering that with
        // a JSON body reads as an empty response and the loop retries until its
        // budget — measured, and the reason this branch exists. Both shapes are
        // served so every surface can be driven the way it really talks.
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          const chunk = (delta: Record<string, unknown>, finish?: string): string =>
            `data: ${JSON.stringify({
              choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
            })}\n\n`;
          const fragments: string[] = [];
          if (wantTool) {
            fragments.push(
              chunk({
                role: 'assistant',
                content: '',
                tool_calls: toolCalls!.map((call, index) => ({ index, ...call })),
              }),
            );
          } else {
            fragments.push(chunk({ role: 'assistant', content }));
          }
          fragments.push(chunk({}, wantTool ? 'tool_calls' : 'stop'));
          fragments.push('data: [DONE]\n\n');
          res.end(fragments.join(''));
          return;
        }

        return json({
          choices: [
            {
              message: {
                content,
                ...(toolCalls ? { tool_calls: toolCalls } : {}),
              },
            },
          ],
        });
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    chatCalls: () => chatCalls,
    faultsServed: () => faultsServed,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ─── The OTLP collector ─────────────────────────────────────────────────────

/** One span the collector received, reduced to what the projection compares. */
interface CollectedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
}

/**
 * A real loopback OTLP/HTTP collector — the far end of the export path.
 *
 * WHY NOT A MOCKED EXPORTER. The claim the `otel-export` row makes is "a
 * collector receives this surface's turn", and only the wire settles that. A spy
 * on the exporter proves the SDK was asked to send something; parsing the request
 * bodies a collector actually received proves an operator with a real endpoint
 * would SEE the tree. It also keeps the SDK's own encoding under test: the JSON
 * shape, the resource attributes and the string timestamps are exactly the parts
 * a hand-rolled writer gets subtly wrong.
 */
interface OtlpCollector {
  /** The `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` value the surface is pointed at. */
  readonly endpoint: string;
  /** Every span received so far, in arrival (completion) order. */
  spans(): CollectedSpan[];
  /** The `service.name` from the resource attributes, or null. */
  serviceName(): string | null;
  /** Requests received, so "nothing exported" is distinguishable from "nothing parsed". */
  requests(): number;
  close(): Promise<void>;
}

/** Pull the comparable facts out of one OTLP JSON payload, ignoring the rest. */
function collectSpansInto(
  payload: unknown,
  into: CollectedSpan[],
  onServiceName: (name: string) => void,
): void {
  const resourceSpans = (payload as { resourceSpans?: unknown })?.resourceSpans;
  if (!Array.isArray(resourceSpans)) return;
  for (const entry of resourceSpans) {
    const attributes = (entry as { resource?: { attributes?: unknown } })?.resource?.attributes;
    if (Array.isArray(attributes)) {
      for (const attribute of attributes) {
        const a = attribute as { key?: unknown; value?: { stringValue?: unknown } };
        if (a?.key === 'service.name' && typeof a.value?.stringValue === 'string') {
          onServiceName(a.value.stringValue);
        }
      }
    }
    const scopeSpans = (entry as { scopeSpans?: unknown })?.scopeSpans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const scope of scopeSpans) {
      const spans = (scope as { spans?: unknown })?.spans;
      if (!Array.isArray(spans)) continue;
      for (const span of spans) {
        const s = span as Record<string, unknown>;
        if (typeof s?.name !== 'string') continue;
        into.push({
          name: s.name,
          traceId: typeof s.traceId === 'string' ? s.traceId : '',
          spanId: typeof s.spanId === 'string' ? s.spanId : '',
          parentSpanId: typeof s.parentSpanId === 'string' ? s.parentSpanId : '',
        });
      }
    }
  }
}

async function startOtlpCollector(): Promise<OtlpCollector> {
  const received: CollectedSpan[] = [];
  let service: string | null = null;
  let requests = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests += 1;
      try {
        const raw = Buffer.concat(chunks);
        // The SDK gzips when it is told to; decoding it here means a run that
        // enables compression is MEASURED rather than silently read as empty.
        const body = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
        collectSpansInto(JSON.parse(body.toString('utf8')), received, (name) => {
          service ??= name;
        });
      } catch {
        // A body we cannot parse is a span we report as MISSING — never a crash
        // in the harness, and never a silent pass.
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/v1/traces`,
    spans: () => [...received],
    serviceName: () => service,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        // The exporter holds keep-alive sockets and `close()` alone waits for
        // them. Tearing them down explicitly is what stops a harness run from
        // hanging on its own collector after the last span arrived.
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/**
 * Reduce the spans a collector received to the compared projection.
 *
 * The collector hands spans over in COMPLETION order (measured), so the whole
 * reduction is order-insensitive: sorted names, sorted edges. A `parentSpanId`
 * matching no span in this collector is a REMOTE parent (a child process that
 * continued a trace begun elsewhere) — it contributes no edge, because an edge to
 * a name we never received cannot compare, and it is recorded on `remoteParent`
 * for the scenario's own assertion instead.
 */
function otelObsOf(collector: OtlpCollector): OtelExportObs {
  const received = collector.spans();
  if (received.length === 0) return noOtelExport();
  const nameById = new Map(received.filter((s) => s.spanId).map((s) => [s.spanId, s.name]));
  const names = received.map((s) => s.name).sort();
  const edges = new Set<string>();
  for (const span of received) {
    if (!span.parentSpanId) continue;
    const parent = nameById.get(span.parentSpanId);
    if (parent) edges.add(`${parent} → ${span.name}`);
  }
  const traceIds = [...new Set(received.map((s) => s.traceId).filter(Boolean))];
  const turn = received.find((s) => s.name === TURN_SPAN_NAME) ?? null;
  return {
    exported: true,
    spans: names,
    edges: [...edges].sort(),
    turnSpans: received.filter((s) => s.name === TURN_SPAN_NAME).length,
    toolSpans: names.filter((name) => name.startsWith(TOOL_SPAN_PREFIX)),
    singleTrace: traceIds.length === 1,
    serviceName: collector.serviceName(),
    traceId: traceIds.length === 1 ? traceIds[0]! : (turn?.traceId ?? null),
    remoteParent:
      turn && turn.parentSpanId && !nameById.has(turn.parentSpanId) ? turn.parentSpanId : null,
  };
}

/**
 * Run one surface's turn with a fresh collector in front of the export path.
 *
 * Returns the turn's own value AND the projection read from the collector after
 * it finished, so a driver wraps exactly the call that talks to the model and
 * nothing else. The endpoint is set for the duration of that call and restored
 * after, because the SDK reads it when it BUILDS the provider — which is why the
 * harness resets the provider before each surface (`shutdownSpans` in the driver
 * wrapper) instead of trusting one endpoint to serve them all.
 */
async function withOtlpCollector<T>(body: () => Promise<T>): Promise<{ value: T; otel: OtelExportObs }> {
  const collector = await startOtlpCollector();
  const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = collector.endpoint;
  try {
    const value = await body();
    return { value, otel: otelObsOf(collector) };
  } finally {
    if (previousEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = previousEndpoint;
    await collector.close();
  }
}

// ─── The operator's tool hooks ──────────────────────────────────────────────

/** Where a declared hook appends the invocations it received (harness-owned). */
export const TOOL_HOOK_LOG_VAR = 'NUVIRA_TOOL_HOOK_LOG';
/** Which tools a declared `before` hook vetoes (harness-owned). */
export const TOOL_HOOK_DENY_VAR = 'NUVIRA_TOOL_HOOK_DENY';

/**
 * WS4 (#26) — the hook script the harness DECLARES, exactly as written.
 *
 * It is a real operator hook: a command that reads the call as JSON on stdin and
 * may veto it on stdout. It reads two variables the harness sets — where to
 * append the invocation it received, and which tools this scenario's `before`
 * hook denies — so ONE script serves every scenario and every phase, and the log
 * it writes is the record this row is compared on.
 *
 * Why a script at all, rather than a spy on the hook seam: the claim is "an
 * operator's declared command runs", and only a real process proves the path an
 * operator would actually take — the spawn, the stdin pipe, the JSON contract, the
 * exit code. A spy would only prove the surface called its own helper.
 */
const TOOL_HOOK_SCRIPT = `#!/usr/bin/env node
// WS4 (#26) — the operator hook the parity harness declares. See
// src/parity/drivers.ts for the contract and why it is a real process.
import { appendFileSync } from 'node:fs';

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let payload = {};
try {
  payload = JSON.parse(raw);
} catch {
  // Not JSON means this was never handed a real payload: exit non-zero so the
  // surface reports a problem instead of reading silence as a decision.
  process.stderr.write('parity hook: stdin was not the documented JSON payload');
  process.exit(2);
}

const denyList = (process.env.${TOOL_HOOK_DENY_VAR} ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const denied = payload.phase === 'before' && denyList.includes(payload.tool);

const log = process.env.${TOOL_HOOK_LOG_VAR};
if (log) {
  appendFileSync(
    log,
    JSON.stringify({
      phase: payload.phase,
      tool: payload.tool,
      surface: payload.surface ?? null,
      ok: typeof payload.ok === 'boolean' ? payload.ok : null,
      decision: denied ? 'deny' : null,
      hook: payload.hook,
    }) + '\\n',
  );
}

if (denied) {
  process.stdout.write(
    JSON.stringify({ decision: 'deny', reason: 'parity: ' + payload.tool + ' is not allowed to run' }),
  );
}
`;

/** One line of the hook's own log: what it was handed, and what it decided. */
interface HookInvocation {
  phase?: unknown;
  tool?: unknown;
  surface?: unknown;
  decision?: unknown;
}

/**
 * Reduce the hook's log AND the surface's own tool lifecycle to the projection.
 *
 * Two witnesses, deliberately: the log says what the hook was asked and how it
 * answered, and `observation.toolCalls` says what the SURFACE did with that
 * answer. `vetoReported` needs both to agree; `vetoLeaked` needs only the surface
 * to show a denied tool succeeding. See `ToolHooksObs` for why neither side alone
 * is trusted.
 */
function toolHooksObsOf(logPath: string, observation: TurnObservation): ToolHooksObs {
  let lines: string[];
  try {
    lines = readFileSync(logPath, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    // No log means the hook never ran (or never wrote) — the honest value, which
    // a scenario that declared hooks reads as a failure rather than a neutral.
    return noToolHooks();
  }

  const invocations = new Set<string>();
  const denied = new Set<string>();
  const surfacesSeen = new Set<string>();
  for (const line of lines) {
    let entry: HookInvocation;
    try {
      entry = JSON.parse(line) as HookInvocation;
    } catch {
      continue;
    }
    const phase = typeof entry.phase === 'string' ? entry.phase : 'unknown';
    const tool = typeof entry.tool === 'string' ? entry.tool : 'unknown';
    invocations.add(`${phase}:${tool}`);
    if (typeof entry.surface === 'string' && entry.surface !== '') surfacesSeen.add(entry.surface);
    if (phase === 'before' && entry.decision === 'deny') denied.add(tool);
  }

  const deniedTools = [...denied].sort();
  // The surface's OWN outcomes for the denied tools: `true` = reported success
  // (so the call ran — a leak), `false` = reported as a failed call.
  const outcomes = deniedTools.map((tool) =>
    observation.toolCalls.filter((call) => call.tool === tool).map((call) => call.ok === true),
  );
  return {
    invocations: [...invocations].sort(),
    denied: deniedTools,
    vetoReported:
      deniedTools.length > 0 && outcomes.every((perTool) => perTool.some((ok) => ok === false)),
    vetoLeaked: outcomes.some((perTool) => perTool.some((ok) => ok === true)),
    surfacesSeen: [...surfacesSeen].sort(),
  };
}

/**
 * Run one surface's turn with this scenario's hooks DECLARED, and read back what
 * the hook received.
 *
 * The declarations are environment variables for the duration of the call and are
 * restored afterwards, for the same reason the OTLP endpoint is: the surfaces
 * read them at call time, so a scenario that declared a hook must not leave it
 * declared for the next one — a veto that leaked into the next scenario would
 * look like that scenario's own behaviour.
 *
 * The log file is per SURFACE as well as per scenario, so the child's invocations
 * (written from its own process, which inherits the path) cannot be attributed to
 * an in-process surface that ran before it.
 */
async function withToolHooks(
  ws: ParityWorkspace,
  surface: SurfaceId,
  scenario: ParityScenario,
  body: () => Promise<TurnObservation>,
): Promise<TurnObservation> {
  const declared = scenario.hooks;
  const logPath = join(ws.root, `tool-hook-${scenario.id}-${surface}.jsonl`);
  rmSync(logPath, { force: true });

  const previous = new Map<string, string | undefined>();
  const set = (name: string, value: string | undefined): void => {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const deny = declared?.deny?.filter((tool) => tool.trim() !== '') ?? [];
  for (const phase of TOOL_HOOK_PHASES) {
    set(
      TOOL_HOOK_ENV[phase],
      declared?.phases.includes(phase) ? `node ${ws.hookScript}` : undefined,
    );
  }
  set(TOOL_HOOK_LOG_VAR, declared ? logPath : undefined);
  set(TOOL_HOOK_DENY_VAR, deny.length > 0 ? deny.join(',') : undefined);

  try {
    const observation = await body();
    return { ...observation, hooks: toolHooksObsOf(logPath, observation) };
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * B4 — the ENV the `execute` COMMAND reads to opt out of its default checkpoint.
 *
 * Checkpointing is default-ON for `nuvira execute` (a rollout policy on the
 * command, so an interrupted run leaves something to continue from), but the
 * surfaces this harness drives through the shared loop primitive do NOT open a
 * record on an ordinary turn. The parity comparison is about CAPABILITY, so the
 * command default is pinned OFF for the whole run: left on, the `cli-execute`
 * driver would report `resume.saved: true` while the four primitive surfaces
 * report `false`, and every row would measure a policy default instead of the
 * behaviour under test. An explicit `--resume` still works — it resolves through
 * `NUVIRA_RESUME` (`RESUME_ENABLE_ENV`), which the envelope sets per scenario —
 * so the `partial-resume` probe is unaffected. Restored in `dispose()`.
 */
const CHECKPOINT_ENABLE_ENV = 'NUVIRA_CHECKPOINT';

// ─── The turn envelope (WS5: isolation and resume) ──────────────────────────

/**
 * Run one surface's turn with this scenario's isolation and resume DECLARED, and
 * reduce the surface's own reports to what is compared.
 *
 * THE RESUME PROBE IS A PAIR OF TURNS, and it has to be: "a resumed run reuses
 * unchanged steps instead of re-paying for every model call" is a statement about
 * two runs — one that writes the record and one that reads it — so a single turn
 * cannot produce the fact. The FIRST turn is the one everything else about the
 * scenario is read from (a fully replayed turn reaches no model at all, and the
 * runner refuses to compare such a turn); the SECOND contributes only its resume
 * fields.
 *
 * THE RESPONSE CACHE IS CLEARED BEFORE EACH TURN, and skipping that would make
 * this row lie in the most convenient direction: the second turn sends the same
 * message as the first, so a cache hit would answer it without reaching the loop
 * at all — no record read, no step replayed, and a `resuming: false` that a
 * harness comparing only model counts would read as agreement. The driver's own
 * turns clear it too; this is the second, independent guard.
 *
 * Both declarations are the ENVIRONMENT (`NUVIRA_ISOLATE` / `NUVIRA_RESUME`) and
 * are restored afterwards, exactly like the OTLP endpoint and the hooks: the
 * surfaces read them at call time, so a declaration that leaked into the next
 * scenario would look like that scenario's own behaviour. The environment is also
 * what makes ONE declaration cover all five surfaces — the dashboard server, the
 * gateway and the forked child have no flags to carry.
 */
async function withTurnEnvelope(
  scenario: ParityScenario,
  surface: SurfaceId,
  body: () => Promise<TurnObservation>,
): Promise<TurnObservation> {
  const askedIsolation = scenario.isolation === true;
  const askedResume = scenario.resume === true;
  // WS6 (#28) — a `tool`/`ipc` fault is DECLARED to the running agent (the seam),
  // while a `provider` fault is served by the stub (so the real adapter's error
  // mapping runs and the model call still happens). Both are set explicitly,
  // including the `undefined` case: a declaration inherited from the developer's
  // shell would make the scenarios that DO NOT ask for a fault inject one anyway.
  const seamFault = scenario.fault && scenario.fault.site !== 'provider' ? scenario.fault : null;
  const previousIsolation = process.env[WORKTREE_ENABLE_ENV];
  const previousResume = process.env[RESUME_ENABLE_ENV];
  const previousFault = process.env[FAULT_ENV];
  const set = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  /**
   * The record this surface's probe uses — NAMED, and namespaced by surface.
   *
   * The auto id is `checkpointIdFor(goal, cwd)`, which is the right default for a
   * human (`--resume` means "the last run of this ask, here") and exactly wrong for
   * this harness: every in-process surface runs the SAME ask in the SAME directory,
   * so they would all read ONE record and a surface could "replay" a tree another
   * surface recorded — measured, and it made two surfaces pass for a reason that had
   * nothing to do with them. A per-surface id keeps each probe's record its own,
   * which is also the path an operator uses to resume a named run.
   */
  const resumeId = `parity-${scenario.id}-${surface}`;
  try {
    set(WORKTREE_ENABLE_ENV, askedIsolation ? '1' : undefined);
    // BOTH turns are asked to resume, and that is not a formality: the FIRST one is
    // what WRITES the record the second replays. A probe whose first turn ran
    // without a ledger would compare a resumed turn against an empty record —
    // replayed 0, model calls unchanged — and report that as the capability working.
    set(RESUME_ENABLE_ENV, askedResume ? resumeId : undefined);
    set(FAULT_ENV, seamFault ? formatFaultPlan(seamFault) : undefined);
    // The injector is cached per declaration, and this declaration is fresh for
    // this surface — so it starts with a full allowance either way.
    resetFaultInjector();
    await clearResponseCache();
    const first = await body();
    if (!askedResume) return first;
    await clearResponseCache();
    const second = await body();
    // Only the resume fields come from the second turn: everything else about the
    // scenario is read from the first one, which is the turn that reached a model.
    return { ...first, resume: second.resume };
  } finally {
    set(WORKTREE_ENABLE_ENV, previousIsolation);
    set(RESUME_ENABLE_ENV, previousResume);
    set(FAULT_ENV, previousFault);
    resetFaultInjector();
  }
}

// ─── The workspace ──────────────────────────────────────────────────────────

/** The throwaway profile a run points the surfaces at. */
interface ParityWorkspace {
  root: string;
  configDir: string;
  memoryDir: string;
  /** The hook script every declared hook command runs (WS4). */
  hookScript: string;
  /** Point the config at `baseUrl`'s stub — rewritten whenever a stub starts. */
  useStub(baseUrl: string): void;
}

/**
 * The response cache is SHARED, ON DISK, AND ON BY DEFAULT for `answerOnce`
 * (`src/cli/chat.ts:690`), keyed by `provider:model:prompt`. Every surface of a
 * run sends the SAME scenario message, so without clearing between surfaces the
 * second one would be served from the first one's entry — same answer, no model
 * call, no tool lifecycle, and a flawless "agreement" between two replays.
 *
 * Isolating `NUVIRA_MEMORY_DIR` already makes the cache file fresh per run, but
 * within a run the entries still collide, so this clears before each surface.
 * The runner's `unreached-model` refusal (`./scenarios.ts`, rule 4) is the
 * second, independent guard: a zero from a replay is refused, not compared.
 */
async function clearResponseCache(): Promise<void> {
  try {
    await getCache().clear();
  } catch {
    // The cache may never break a turn — and the `modelCalls` guard catches a
    // stale entry anyway.
  }
}

function createWorkspace(): ParityWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'buff-parity-'));
  const configDir = join(root, 'config');
  const memoryDir = join(root, 'memory');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  // WS4 — the hook command the harness declares. Written once per run, so every
  // scenario's hooks are the SAME program and a difference between scenarios can
  // only come from the declaration, not from the script.
  const hookScript = join(root, 'tool-hook.mjs');
  writeFileSync(hookScript, TOOL_HOOK_SCRIPT);
  const workspace: ParityWorkspace = {
    root,
    configDir,
    memoryDir,
    hookScript,
    useStub(baseUrl: string): void {
      // `buffconfig.json` is the file `ConfigManager` reads (`config/manager.ts`
      // -> `config/paths.ts`). The provider object the surfaces build from it is
      // the REAL Groq adapter; `baseUrl` is the override it honours.
      writeFileSync(
        join(configDir, 'buffconfig.json'),
        JSON.stringify(
          {
            defaultProvider: PARITY_PROVIDER_TYPE,
            providers: {
              [PARITY_PROVIDER_TYPE]: { apiKey: PARITY_API_KEY, model: PARITY_MODEL, baseUrl },
            },
          },
          null,
          2,
        ),
      );
    },
  };
  return workspace;
}

// ─── Shared observation shaping ─────────────────────────────────────────────

/** What a surface hands back, reduced to what an observer can see. */
interface SurfaceAnswer {
  /**
   * Optional on purpose: only the dashboard console SYNTHESISES an `ok`; the
   * engine, the gateway and the command report `generationFailed` instead, and
   * the projection treats "no `ok`" as "judge it by generationFailed" rather
   * than inventing a verdict for them.
   */
  ok?: boolean;
  content?: string | null;
  provider?: string | null;
  model?: string | null;
  transport?: 'native' | 'json' | 'none' | null;
  error?: string;
  generationFailed?: boolean;
  /** WS1 — the findings the turn recorded, in the shared wire form. */
  findings?: readonly WireFinding[];
  /** WS2 — the session debug log this surface wrote, reduced to its header. */
  debugLog?: DebugLogObs;
  /** WS3 — the span tree this surface exported, as its collector received it. */
  otel?: OtelExportObs;
  /** WS5 — the isolation this turn had (the surface's own report). */
  worktree?: { dir: string; base: string; diff: { files: readonly string[] }; removed: boolean };
  /**
   * WS5 — what this turn's resume replayed (the surface's own report).
   *
   * `notice` is the surface's OWN explanation, including each miss reason when
   * nothing replayed. It is carried for diagnosis only and never compared —
   * `resumeObsOf` copies it onto the observation, and `compare` quotes it on a
   * divergent resume row rather than comparing it.
   */
  resume?: { id: string; replayed: number; modelCalls: number; saved: boolean; notice?: string };
}

/**
 * Reduce a surface's own isolation report to the compared projection.
 *
 * Takes the shape both the in-process surfaces and the subagent manager report
 * (a base commit, a file list and whether the directory was removed) rather than
 * one of their concrete types, because the two are produced by different code on
 * purpose: the in-process turn makes its own worktree, the parent makes the
 * child's. What must agree is the RESULT, and that is what this reduces.
 */
function isolationObsOf(
  asked: boolean,
  report: { base: string; diff: { files: readonly string[] }; removed: boolean } | undefined | null,
): IsolationObs {
  if (!report) return { ...noIsolation(), asked };
  return {
    asked,
    isolated: true,
    // Sorted, so the comparison is over the SET of files the run changed: a diff
    // is measured from `git diff`, whose order is the repository's, not the
    // surface's.
    files: [...report.diff.files].sort(),
    removed: report.removed,
    base: report.base,
  };
}

/**
 * Reduce a surface's own resume report to the compared projection.
 *
 * `asked` with no report is the honest description of a surface that ignored the
 * request: `resuming: false` against every other surface's `true`, which
 * `compare` reports as a difference rather than as agreement about nothing.
 */
function resumeObsOf(
  asked: boolean,
  report:
    | { replayed: number; modelCalls: number; saved: boolean; notice?: string }
    | undefined
    | null,
): ResumeObs {
  if (!report) return { ...noResume(), asked };
  return {
    asked,
    resuming: true,
    replayed: report.replayed,
    modelCalls: report.modelCalls,
    saved: report.saved,
    // Diagnostic only (never compared) — see `ResumeObs.notice`. Carried so a
    // divergent row can name the miss reason instead of only the count.
    ...(report.notice ? { notice: report.notice } : {}),
  };
}

/**
 * Read a surface's OWN session debug log and reduce its header to the compared
 * facts — WS2.
 *
 * Read from DISK rather than from a return value, for the same reason the
 * gateway driver reads `inbound.chat` from the gateway log: the capability is
 * "a file you can attach to a bug report", so the artifact itself is the
 * evidence. `written: false` when the surface produced nothing, which the
 * harness refuses to read as agreement (the run turns logging on for every
 * surface).
 */
function debugLogOf(surface: string, dir: string = debugLogDir()): DebugLogObs {
  const found = readLatestDebugLog(surface, dir);
  if (!found) return noDebugLog();
  return {
    written: true,
    provider: found.header.provider,
    model: found.header.model,
    transport: found.header.transport,
  };
}

/**
 * Reduce a surface's own answer to the shared observation.
 *
 * MEASURED, and found by this harness on its first real run: the surfaces do NOT
 * share a result contract. `ChatCommand.answerOnce` reports `generationFailed`
 * and no `ok`; the console SYNTHESISES `ok`. Mapping each surface's OWN contract
 * rather than inventing a common one keeps that seam visible instead of hiding
 * it — which is what a parity harness is for.
 */
/**
 * WS6 (#28) — whether this surface's OWN turn shows the fault it was given.
 *
 * Derived rather than counted, because the counter cannot cross the fork (see
 * `FaultObs`). The rule is the fault's own contract:
 *
 *   - `tool`     — the named call (or any call, when none is named) is reported
 *                  FAILED. A surface that swallowed the injected `Error:` and
 *                  reported the call as ok reads as `took: false`.
 *   - `provider` / `ipc` — the turn did not COMPLETE. A surface that produced an
 *                  answer anyway reads as `took: false`, which is precisely the
 *                  false-success shape this workstream exists to catch.
 */
function faultObsOf(
  scenario: ParityScenario,
  toolCalls: readonly ToolCallObs[],
  status: TurnObservation['status'],
): FaultObs {
  const plan = scenario.fault;
  if (!plan) return noFault();
  const took =
    plan.site === 'tool'
      ? toolCalls.some(
          (call) => (plan.match === undefined || call.tool === plan.match) && call.ok === false,
        )
      : status !== 'completed';
  return { asked: true, site: plan.site, kind: plan.kind, took };
}

function toObservation(
  surface: SurfaceId,
  scenario: ParityScenario,
  answer: SurfaceAnswer,
  toolCalls: ToolCallObs[],
  modelCalls: number,
): TurnObservation {
  // WS6 (#28) — `generationFailed` outranks `ok`, through the ONE helper every
  // surface's read goes through (see `turnStatus`). A served-but-failed turn is a
  // failure; reading the request-level `ok` first is what let the provider-fault
  // row catch two surfaces calling an empty generation a completion.
  const status = turnStatus(answer);
  const succeeded = status === 'completed';
  return {
    surface,
    engine: 'loop',
    status,
    // Recorded, never inferred: the runner refuses a zero (rule 4 in
    // ./scenarios.ts) instead of reading a cache replay as agreement.
    modelCalls,
    ...(answer.provider ? { provider: answer.provider } : {}),
    ...(answer.model ? { model: answer.model } : {}),
    ...(answer.transport ? { transport: answer.transport } : {}),
    toolCalls,
    // WS1 — recorded findings, in order. `[]` when the surface reported none.
    findings: answer.findings ?? [],
    // WS2 — the session debug log's header. `written: false` when the surface
    // produced none, which the harness (logging ON) reads as a failure.
    debugLog: answer.debugLog ?? noDebugLog(),
    // WS3 — the span tree the collector received. `exported: false` when nothing
    // arrived, which the harness (export ON) reads as a failure.
    otel: answer.otel ?? noOtelExport(),
    // WS4 — replaced by the driver wrapper with what the operator's declared hook
    // actually received (`withToolHooks`): the log is written by the HOOK, and
    // only the wrapper knows which file this surface's run was pointed at.
    hooks: noToolHooks(),
    // WS5 — the surface's OWN report of the isolation it ran with, and of what its
    // resume replayed. `asked` comes from the scenario, which is what makes
    // "asked for it and did not do it" a difference rather than a tautology. The
    // resume field is REPLACED by `withTurnEnvelope` for the resumed scenario,
    // whose second turn is the one that can answer it.
    isolation: isolationObsOf(scenario.isolation === true, answer.worktree),
    resume: resumeObsOf(scenario.resume === true, answer.resume),
    // WS6 (#28) — the declared fault, and whether THIS surface's turn shows it.
    fault: faultObsOf(scenario, toolCalls, status),
    ...(typeof answer.content === 'string' ? { answer: answer.content } : {}),
    ...(succeeded
      ? {}
      : { errorCode: answer.generationFailed ? 'generation_failed' : 'turn_failed' }),
    noise: { at: Date.now() },
  };
}

/**
 * Collect one surface's tool-call lifecycle: the `called` phase only, which is
 * the one that carries an outcome (`ok`). A call that never reached `called` did
 * not happen, and an outcome that is absent is recorded as absent, not guessed.
 */
function collectCalled(
  target: ToolCallObs[],
  phase: string,
  info: { tool: string; ok?: boolean },
): void {
  if (phase !== 'called') return;
  target.push({ tool: info.tool, ...(typeof info.ok === 'boolean' ? { ok: info.ok } : {}) });
}

// ─── The drivers ────────────────────────────────────────────────────────────

/** CLI chat: the shared engine, called directly, pinned to the stub's model. */
async function runViaChatOnce(ws: ParityWorkspace, scenario: ParityScenario): Promise<TurnObservation> {
  const stub = await startStub(scenario);
  try {
    ws.useStub(stub.baseUrl);
    await clearResponseCache();
    const { ChatCommand } = await import('../cli/chat.js');
    const command = new ChatCommand();
    const toolCalls: ToolCallObs[] = [];
    const { value: answer, otel } = await withOtlpCollector(() =>
      command.answerOnce(scenario.message, {
        provider: PARITY_PROVIDER_TYPE,
        model: PARITY_MODEL,
        onToolCall: (phase, info) => collectCalled(toolCalls, phase, info),
      }),
    );
    return toObservation(
      'cli-chat',
      scenario,
      { ...answer, debugLog: debugLogOf('cli-chat'), otel },
      toolCalls,
      stub.chatCalls(),
    );
  } finally {
    await stub.close();
  }
}

/**
 * Dashboard chat: the real console, with NO injected engine and no injected
 * provider, so `ensureEngine()` lazily loads the real `ChatCommand` and the
 * console's own turn plumbing (session record, busy guard, turn telemetry,
 * progress emission) runs rather than being bypassed. The provider/model are
 * pinned through the console's public options, which is exactly the surface
 * handing the pin to its engine.
 */
async function runViaConsole(ws: ParityWorkspace, scenario: ParityScenario): Promise<TurnObservation> {
  const stub = await startStub(scenario);
  try {
    ws.useStub(stub.baseUrl);
    await clearResponseCache();
    const { ChatConsole } = await import('../web-dashboard/chat-console.js');
    const console_ = new ChatConsole({});
    const toolCalls: ToolCallObs[] = [];
    // The console's own subscription seam — the same one the GUI uses — rather
    // than reaching into the engine, so this observes what a dashboard user sees.
    const off = console_.onEvent((_sessionId, event) => {
      if (event.kind !== 'tool') return;
      collectCalled(toolCalls, event.phase, {
        tool: event.tool,
        ...(event.ok === undefined ? {} : { ok: event.ok }),
      });
    });
    try {
      // WS5 (#27) — one session PER TURN, counter and all. The resume probe runs
      // the same ask twice, and a second turn in the SAME conversation carries the
      // first answer in its history — so its input genuinely differs, the replay
      // correctly misses, and the row would compare two different questions. A
      // fresh conversation each time is what the other surfaces do anyway (a
      // one-shot CLI answer, a fresh child process). The counter keeps the ids
      // unique within a run; nothing else reads them.
      consoleRun += 1;
      const { value: result, otel } = await withOtlpCollector(() =>
        console_.answer(`parity-${scenario.id}-${consoleRun}`, scenario.message, {
          provider: PARITY_PROVIDER_TYPE,
          model: PARITY_MODEL,
        }),
      );
      return toObservation(
        'dashboard-chat',
        scenario,
        { ...result, debugLog: debugLogOf('dashboard-chat'), otel },
        toolCalls,
        stub.chatCalls(),
      );
    } finally {
      off();
    }
  } finally {
    await stub.close();
  }
}

/** A channel adapter that records every send, so the gateway driver sees a real reply. */
class RecordingAdapter implements ChannelAdapter {
  readonly platform = 'mock' as const;
  readonly configured = true;
  readonly sent: string[] = [];
  describe(): string {
    return 'Parity recorder';
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(_channelId: string, text: string): Promise<boolean> {
    this.sent.push(text);
    return true;
  }
}

/** Unique per gateway run: the gateway dedups a re-delivered message. */
let gatewayRun = 0;

/**
 * Unique per console turn (WS5): the resume probe drives the same ask twice, and
 * two turns in one conversation would carry the first answer in the second's
 * history (see the comment at the call site).
 */
let consoleRun = 0;

/**
 * Gateway (WhatsApp / Telegram / …): the REAL registry handler, with no chat
 * engine injected, so `runInboundChat` lazily imports the real `ChatCommand`.
 * The gateway derives the provider/model pair from its own config
 * (`registry.ts:1797`) — which the harness has pointed at the stub — so this is
 * the surface's own resolution, not something forced in from here.
 *
 * The observation is read from the gateway's OWN durable record, the
 * `inbound.chat` log entry: a messaging surface has no terminal to scroll, so
 * the log is where its attribution and tool lifecycle have to live. Reading the
 * log rather than a return value is the honest test of that claim — if the
 * gateway stops writing the triple, this goes red.
 */
async function runViaGateway(ws: ParityWorkspace, scenario: ParityScenario): Promise<TurnObservation> {
  const stub = await startStub(scenario);
  const deliveryDir = mkdtempSync(join(ws.root, 'gateway-'));
  try {
    ws.useStub(stub.baseUrl);
    await clearResponseCache();
    const { GatewayRegistry } = await import('../gateway/registry.js');
    const adapter = new RecordingAdapter();
    const registry = new GatewayRegistry({ streamEvents: false, deliveryConfigDir: deliveryDir });
    registry.register(adapter);
    gatewayRun += 1;
    const channelId = `parity-${scenario.id}-${gatewayRun}`;
    const { otel } = await withOtlpCollector(() =>
      registry.handleInbound(
        {
          platform: 'mock',
          channelId,
          text: scenario.message,
          from: 'parity',
          senderId: 'parity',
        },
        { forceKind: 'chat' },
      ),
    );
    const record = readGatewayLog(50).find(
      (r) => r.event === 'inbound.chat' && r.channelId === channelId,
    );
    if (!record) {
      throw new Error('the gateway did not record an inbound.chat turn for this message');
    }
    // The log carries the surface's own `{ tool, ok }` lifecycle; absence is
    // preserved as absence (a call whose outcome frame never arrived).
    const toolCalls: ToolCallObs[] = Array.isArray(record.toolCalls)
      ? (record.toolCalls as Array<{ tool: string; ok?: boolean }>).map((call) => ({
          tool: call.tool,
          ...(typeof call.ok === 'boolean' ? { ok: call.ok } : {}),
        }))
      : [];
    const reply = [...adapter.sent].reverse().find((line) => line.includes(scenario.answer));
    // WS1 — the findings the gateway recorded for this turn, read from its own
    // durable record for the same reason the tool lifecycle is: a messaging
    // surface has no terminal, so `inbound.chat` IS where this surface said it.
    const findings: WireFinding[] = Array.isArray(record.findings)
      ? (record.findings as WireFinding[])
      : [];
    return toObservation(
      'gateway-chat',
      scenario,
      {
        content: reply,
        findings,
        provider: typeof record.provider === 'string' ? record.provider : undefined,
        model: typeof record.model === 'string' ? record.model : undefined,
        transport:
          record.transport === 'native' || record.transport === 'json'
            ? record.transport
            : record.transport === 'none'
              ? 'none'
              : undefined,
        generationFailed: record.generationFailed === true,
        // WS2 — read from the same isolated profile the gateway wrote into.
        debugLog: debugLogOf('gateway-chat'),
        // WS3 — the span tree the collector received from this surface.
        otel,
        // WS5 — read from the gateway's own durable record, for the same reason
        // the tool lifecycle and the findings are: a messaging surface has no
        // terminal, so `inbound.chat` IS where this surface said what it did.
        ...(record.worktree && typeof record.worktree === 'object'
          ? { worktree: record.worktree as SurfaceAnswer['worktree'] }
          : {}),
        ...(record.resume && typeof record.resume === 'object'
          ? { resume: record.resume as SurfaceAnswer['resume'] }
          : {}),
      },
      toolCalls,
      stub.chatCalls(),
    );
  } finally {
    await stub.close();
    rmSync(deliveryDir, { recursive: true, force: true });
  }
}

/**
 * CLI execute / one-shot: the COMMAND's own single-goal path, with the provider
 * served by the shared factory pointed at the stub. Both of the command's arms
 * report now — the loop engine through `runLoopExecutor` and the direct chat
 * answer through the engine's `onToolCall` — so the observation is what the
 * COMMAND returns, not what the engine inside it happened to know.
 *
 * `runSingleGoal` is `private` in `src/cli/execute.ts`; the cast below is the
 * same typed seam the tests already use, and it goes red the day the command
 * stops handing its own result back.
 */
async function runViaExecuteCommand(ws: ParityWorkspace, scenario: ParityScenario): Promise<TurnObservation> {
  const stub = await startStub(scenario);
  try {
    ws.useStub(stub.baseUrl);
    await clearResponseCache();
    const { ExecuteCommand } = await import('../cli/execute.js');
    const command = new ExecuteCommand() as unknown as {
      runSingleGoal: (
        goal: string,
        provider: string | undefined,
        model: string | undefined,
        options: { engine?: 'auto' | 'loop' | 'pipeline' },
      ) => Promise<{
        success: boolean;
        content?: string;
        provider?: string;
        model?: string;
        transport?: 'native' | 'json' | 'none';
        toolCalls?: string[];
        toolOutcomes?: Array<{ tool: string; ok?: boolean }>;
        findings?: WireFinding[];
        worktree?: { dir: string; base: string; diff: { files: readonly string[] }; removed: boolean };
        resume?: { id: string; replayed: number; modelCalls: number; saved: boolean };
      }>;
    };
    const { value: result, otel } = await withOtlpCollector(() =>
      command.runSingleGoal(scenario.message, PARITY_PROVIDER_TYPE, PARITY_MODEL, {
        engine: 'loop',
      }),
    );
    return toObservation(
      'cli-execute',
      scenario,
      {
        content: result.content,
        provider: result.provider,
        model: result.model,
        transport: result.transport,
        generationFailed: !result.success,
        ...(result.findings ? { findings: result.findings } : {}),
        debugLog: debugLogOf('cli-execute'),
        // WS3 — the span tree this command's loop exported for the turn.
        otel,
        // WS5 — the command's own report, on either engine arm.
        ...(result.worktree ? { worktree: result.worktree } : {}),
        ...(result.resume ? { resume: result.resume } : {}),
      },
      // The command's own per-call outcomes (captured from the loop's
      // `tool`/`refusal` events). The fallback keeps a name-only result honest:
      // `ok` stays absent rather than being guessed.
      result.toolOutcomes
        ? result.toolOutcomes.map((call) => ({
            tool: call.tool,
            ...(typeof call.ok === 'boolean' ? { ok: call.ok } : {}),
          }))
        : (result.toolCalls ?? []).map((tool) => ({ tool })),
      stub.chatCalls(),
    );
  } finally {
    await stub.close();
  }
}

/**
 * Subagent: a REAL forked child process over its IPC channel, with the model
 * served by the same loopback stub. The child resolves its OWN provider from
 * config — that IS the isolation boundary — but the harness points that provider
 * at the same `groq` id and the same stub the in-process surfaces use, so
 * agreement is evidence rather than a stub coincidence.
 *
 * The observation is read from what the child itself reported (provider, model,
 * transport, llm calls, and each tool call + outcome on its progress frames),
 * never reconstructed here.
 */
async function runViaSubagent(ws: ParityWorkspace, scenario: ParityScenario): Promise<TurnObservation> {
  const stub = await startStub(scenario);
  // The child gets its OWN config/memory dirs, because it is its own process —
  // but the file it reads points at the SAME stub server.
  //
  // DETERMINISTIC, not `mkdtemp`: a resume probe drives the same scenario twice,
  // and the child's step record lives in the memory dir it inherits. A throwaway
  // dir per call would put the second turn's record in a different place from the
  // first one's, so the child could never replay anything and the probe would be
  // measuring the harness's own bookkeeping. Keyed by SCENARIO (not by surface) on
  // purpose: the child of one surface must not read another's record, and each
  // surface's own two turns must share one.
  const childRoot = join(ws.root, `subagent-${scenario.id}`);
  const childConfig = join(childRoot, 'config');
  mkdirSync(childConfig, { recursive: true });
  writeFileSync(
    join(childConfig, 'buffconfig.json'),
    JSON.stringify({
      defaultProvider: PARITY_PROVIDER_TYPE,
      providers: {
        [PARITY_PROVIDER_TYPE]: {
          apiKey: PARITY_API_KEY,
          model: PARITY_MODEL,
          baseUrl: stub.baseUrl,
        },
      },
    }),
  );
  try {
    const { getSubagentManager } = await import('../tools/subagent-spawner.js');
    const manager = getSubagentManager();
    const callsByRun = new Map<string, ToolCallObs[]>();
    // The listener is attached before the id exists, and a progress frame can
    // arrive before `spawn()` resolves — hence keying by run id.
    const onProgress = (id: string, msg: { phase?: string; tool?: string; ok?: boolean }) => {
      // The OUTCOME frame: the child reports `tool_call` then `tool_result`, and
      // the driver records the one that carries WHAT HAPPENED, exactly as the
      // `called` phase is read in-process. A missing outcome stays absent.
      if (msg?.phase !== 'tool_result' || typeof msg.tool !== 'string') return;
      const list = callsByRun.get(id) ?? [];
      list.push({ tool: msg.tool, ...(typeof msg.ok === 'boolean' ? { ok: msg.ok } : {}) });
      callsByRun.set(id, list);
    };
    manager.on('progress', onProgress);
    try {
      // A tool is ALWAYS offered to the child, even for a scenario that calls
      // none: the in-process surfaces always have their tools available, so
      // offering the child one keeps its transport attribution comparable. The
      // stub only asks for the tool when the scenario does.
      const availableTool = scenario.toolCall?.tool ?? 'list_dir';
      // WS3 — one collector for this surface, held across the WHOLE child run:
      // the fork inherits `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (and `NUVIRA_OTEL`)
      // from this process's environment, and the child flushes into it before it
      // reports its result — so what is read here is the child's OWN export,
      // produced in its own process, rather than something reconstructed here.
      const spawnConfig = {
        goal: scenario.message,
        provider: PARITY_PROVIDER_TYPE,
        model: PARITY_MODEL,
        tools: [availableTool],
        // WS5 (#27) — delegation-level isolation: the PARENT makes the worktree,
        // forks the child INTO it and measures the diff itself. That is the
        // mechanism a delegating caller actually has (the child resolves its own
        // config and could decline), and it is why this surface is asked through
        // the spawn config rather than through the environment the in-process
        // surfaces read.
        ...(scenario.isolation === true ? { worktree: true } : {}),
        env: {
          NUVIRA_CONFIG_DIR: childConfig,
          NUVIRA_MEMORY_DIR: join(childRoot, 'memory'),
          // WS2 — the child keeps its OWN config/memory (that IS the isolation
          // boundary) but writes its debug log into the run's throwaway debug
          // dir, so this driver and a test can read the artifact the child
          // actually produced instead of re-deriving a path inside the child's
          // private profile.
          NUVIRA_DEBUG_LOG_DIR: debugLogDir(),
        },
      };
      const { value, otel } = await withOtlpCollector(async () => {
        const state = await manager.spawn(spawnConfig);
        try {
          return { state, result: await manager.waitForCompletion(state.id, 60_000) };
        } catch {
          // A CHILD THAT FAILED IS AN OBSERVATION, NOT A HARNESS CRASH — found by
          // the WS6 provider-fault row, which is the first scenario where the child
          // legitimately ends in failure. `waitForCompletion` REJECTS on a failed
          // run, so this throw used to escape the driver, abort `runParityScenario`
          // and fail the harness with an exception instead of a verdict. A harness
          // that cannot say "every surface failed honestly" cannot measure fault
          // handling at all.
          //
          // The rejection is DISCARDED in favour of the manager's own recorded
          // state: what is reported is the child's own report (its error, its
          // attribution, its call counts), not the exception this driver happened
          // to catch — the same "read the surface's own record" rule the gateway
          // and debug-log drivers follow.
          const failed = manager.getState(state.id) ?? state;
          return {
            state: failed,
            result: {
              id: failed.id,
              success: false,
              result: failed.result ?? '',
              ...(failed.error ? { error: failed.error } : {}),
              ...(failed.refusalCode ? { refusalCode: failed.refusalCode } : {}),
              ...(failed.provider ? { provider: failed.provider } : {}),
              ...(failed.model ? { model: failed.model } : {}),
              ...(failed.transport ? { transport: failed.transport } : {}),
              ...(failed.findings ? { findings: failed.findings } : {}),
              ...(failed.resume ? { resume: failed.resume } : {}),
              llmCalls: failed.llmCalls,
              tokensUsed: failed.tokensUsed,
              toolCalls: failed.toolCalls,
              durationMs: failed.durationMs ?? 0,
              log: manager.getLog(failed.id),
            },
          };
        }
      });
      const { state, result } = value;
      const transport =
        result.transport === 'native' || result.transport === 'json' ? result.transport : 'none';
      // The child's own verdict, through the shared helper (it reports success
      // directly, so `ok` is the flag it has) — the same rule across the fork
      // rather than a second one that could disagree.
      const status = turnStatus({ ok: result.success });
      const childCalls = callsByRun.get(state.id) ?? [];
      return {
        surface: 'subagent',
        engine: 'loop',
        status,
        modelCalls: result.llmCalls,
        ...(result.provider ? { provider: result.provider } : {}),
        ...(result.model ? { model: result.model } : {}),
        transport,
        toolCalls: childCalls,
        // WS1 — the child's own findings, read from the frames it sent.
        findings: result.findings ?? [],
        // WS2 — the child's own debug log, read back from the file it wrote
        // (its dir is pinned into the child's env above, so this is the CHILD's
        // artifact — produced in its own process, with its own provider object —
        // and not something reconstructed here).
        debugLog: debugLogOf('subagent'),
        // WS3 — the span tree the CHILD exported, read back from the collector it
        // was pointed at through its inherited environment.
        otel,
        // WS4 — replaced by the driver wrapper with what the operator's declared
        // hook received: the child runs the hook in its OWN process and appends
        // to the log file it inherited the path of (`withToolHooks`).
        hooks: noToolHooks(),
        // WS5 — the isolation the PARENT made for this child, and what the diff
        // against the base commit was. Read from the result the manager hands its
        // caller, which is the artifact a delegating caller actually receives.
        isolation: isolationObsOf(scenario.isolation === true, result.worktree),
        // WS5 — the CHILD's own resume report, read from the frame it sent (the
        // child is a separate process; this is its only channel back).
        resume: resumeObsOf(scenario.resume === true, result.resume),
        // WS6 (#28) — the declared fault, derived from what the CHILD's own frames
        // and result say. This is the field that proves a declaration crosses the
        // fork: a `tool` fault reaches this child through the environment the
        // parent handed it, and the failed call is reported back on a frame.
        fault: faultObsOf(scenario, childCalls, status),
        ...(result.result ? { answer: result.result } : {}),
        ...(result.success ? {} : { errorCode: result.refusalCode ?? 'turn_failed' }),
        noise: { at: Date.now() },
      };
    } finally {
      manager.off('progress', onProgress);
    }
  } finally {
    // The child's root is left in place (the workspace's own teardown removes it):
    // a resume probe's two turns must share it, so deleting it here would delete the
    // record the second turn is about to read.
    await stub.close();
  }
}

/**
 * A driver that exists only to record why it cannot run. Exported so a caller
 * can pin the guard that a blocked surface is never silently invoked — the real
 * driver list currently needs no blocks.
 */
export function blockedDriver(surface: SurfaceId, reason: string): ParityDriver {
  return {
    surface,
    depth: DRIVER_DEPTH,
    available: false,
    blockedBy: reason,
    run: async () => {
      throw new Error(
        `parity driver for ${surface} is blocked and must never be invoked: ${reason}`,
      );
    },
  };
}

/** A live set of drivers plus the throwaway profile they run against. */
export interface ParityHarness {
  /** Every surface, in the order a parity report reads them. */
  drivers: ParityDriver[];
  /**
   * The four surfaces that run in THIS process. A cross-surface verdict is read
   * from this group: the forked child legitimately reports a different transport
   * for a turn that asked for no tools (it has no tools installed in that case),
   * which is a fact about the child, not a divergence — so the child is compared
   * in the scenarios where that fact matches, exactly as the registry declares.
   */
  inProcess: ParityDriver[];
  /** The forked-child driver on its own. */
  subagent: ParityDriver[];
  /** Restore the environment and delete the throwaway profile. */
  dispose(): Promise<void>;
}

/**
 * Build the real drivers.
 *
 * The environment is switched to a throwaway profile here and restored in
 * `dispose()`. Every module that resolves `NUVIRA_CONFIG_DIR` / `NUVIRA_MEMORY_DIR`
 * at call time (the config manager, the cache, the gateway log) therefore reads
 * the isolated profile for the whole run, and the developer's real profile is
 * untouched — the same hermetic convention the test suite uses.
 */
export async function createParityHarness(): Promise<ParityHarness> {
  const workspace = createWorkspace();
  const previous = {
    configDir: process.env.NUVIRA_CONFIG_DIR,
    memoryDir: process.env.NUVIRA_MEMORY_DIR,
    buffConfigDir: process.env.BUFF_CONFIG_DIR,
    buffMemoryDir: process.env.BUFF_MEMORY_DIR,
    debugLog: process.env.NUVIRA_DEBUG_LOG,
    otel: process.env[otelEnableVarName],
    otelEndpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    // WS5 (#27) — never the developer's own request. The harness DECLARES these
    // per scenario (`withTurnEnvelope`); a value inherited from the shell would
    // make the scenarios that do not ask for the capability measure it anyway.
    isolation: process.env[WORKTREE_ENABLE_ENV],
    resume: process.env[RESUME_ENABLE_ENV],
    // WS6 (#28) — same rule: the harness DECLARES a fault per scenario, so a
    // declaration inherited from the shell must not arm one for every scenario.
    fault: process.env[FAULT_ENV],
    // B4 — the `execute` command's rollout default, pinned off for the run (see
    // CHECKPOINT_ENABLE_ENV). A value inherited from the shell must not decide
    // whether every row compares a command default or a capability.
    checkpoint: process.env[CHECKPOINT_ENABLE_ENV],
  };
  process.env.NUVIRA_CONFIG_DIR = workspace.configDir;
  process.env.NUVIRA_MEMORY_DIR = workspace.memoryDir;
  // WS2 — logging is turned ON for the whole run, so "this surface wrote a log
  // whose header names the backend" is an ASSERTION rather than something the
  // harness never asked for. Every surface writes into the isolated profile
  // above (a forked child into its own), so nothing reaches the developer's
  // real `~/.nuvira`.
  process.env.NUVIRA_DEBUG_LOG = '1';
  // WS3 — span export is turned ON for the whole run, so "this surface exported
  // its turn" is an ASSERTION rather than something the harness never asked for.
  // Only the GATE belongs here; the endpoint is set per driver
  // (`withOtlpCollector`), because each surface gets its own collector.
  process.env[otelEnableVarName] = '1';
  // WS6 (#28) — and no fault, until a scenario declares one.
  delete process.env[FAULT_ENV];
  resetFaultInjector();
  // B4 — checkpointing is a COMMAND default, not a surface capability, so it is
  // off for the duration (restored in `dispose()`). Without this the `cli-execute`
  // driver — the only one that drives the real command's own path — reports a
  // saved resume point that no other surface has, and every row reads as a
  // divergence about policy rather than about the behaviour under test.
  process.env[CHECKPOINT_ENABLE_ENV] = 'off';
  // The legacy aliases would otherwise win on the modules that check them, and
  // point half the run back at the developer's real profile.
  delete process.env.BUFF_CONFIG_DIR;
  delete process.env.BUFF_MEMORY_DIR;

  const driver = (
    surface: SurfaceId,
    run: (ws: ParityWorkspace, scenario: ParityScenario) => Promise<TurnObservation>,
  ): ParityDriver => ({
    surface,
    depth: DRIVER_DEPTH,
    available: true,
    run: async (scenario) => {
      // WS3 — the SDK keeps ONE provider per process and reads the endpoint when
      // it builds it, so the previous surface's provider (pointing at the
      // previous collector, now closed) has to go before this surface starts.
      // Without this reset the second surface would export into the first
      // surface's collector, and every surface after that would read as having
      // exported nothing — a silent, permanent green on one surface only.
      await shutdownSpans();
      // WS5 — isolation and resume are DECLARED around the turn (and undeclared
      // again after it), so "this surface isolated its turn / replayed its steps"
      // is an assertion about a declaration the harness actually made. OUTSIDE
      // the hook wrapper because the resume probe runs the turn twice, and each
      // of those two turns is a whole turn of its own.
      return withTurnEnvelope(scenario, surface, () =>
        // WS4 — the operator's hooks are DECLARED around the turn (and undeclared
        // again after it), so "this surface ran the hook" is an assertion about a
        // declaration the harness actually made.
        withToolHooks(workspace, surface, scenario, () => run(workspace, scenario)),
      );
    },
  });

  const inProcess = [
    driver('cli-chat', runViaChatOnce),
    driver('dashboard-chat', runViaConsole),
    driver('gateway-chat', runViaGateway),
    driver('cli-execute', runViaExecuteCommand),
  ];
  const subagent = [driver('subagent', runViaSubagent)];

  return {
    drivers: [...inProcess, ...subagent],
    inProcess,
    subagent,
    async dispose(): Promise<void> {
      if (previous.configDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
      else process.env.NUVIRA_CONFIG_DIR = previous.configDir;
      if (previous.memoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
      else process.env.NUVIRA_MEMORY_DIR = previous.memoryDir;
      if (previous.buffConfigDir === undefined) delete process.env.BUFF_CONFIG_DIR;
      else process.env.BUFF_CONFIG_DIR = previous.buffConfigDir;
      if (previous.buffMemoryDir === undefined) delete process.env.BUFF_MEMORY_DIR;
      else process.env.BUFF_MEMORY_DIR = previous.buffMemoryDir;
      if (previous.debugLog === undefined) delete process.env.NUVIRA_DEBUG_LOG;
      else process.env.NUVIRA_DEBUG_LOG = previous.debugLog;
      if (previous.otel === undefined) delete process.env[otelEnableVarName];
      else process.env[otelEnableVarName] = previous.otel;
      if (previous.otelEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = previous.otelEndpoint;
      if (previous.isolation === undefined) delete process.env[WORKTREE_ENABLE_ENV];
      else process.env[WORKTREE_ENABLE_ENV] = previous.isolation;
      if (previous.resume === undefined) delete process.env[RESUME_ENABLE_ENV];
      else process.env[RESUME_ENABLE_ENV] = previous.resume;
      if (previous.fault === undefined) delete process.env[FAULT_ENV];
      else process.env[FAULT_ENV] = previous.fault;
      if (previous.checkpoint === undefined) delete process.env[CHECKPOINT_ENABLE_ENV];
      else process.env[CHECKPOINT_ENABLE_ENV] = previous.checkpoint;
      resetFaultInjector();
      // Tear the LAST surface's provider down too: a test file that runs several
      // parity runs in a row would otherwise inherit the first one's provider,
      // still pointing at a collector that has been closed.
      await shutdownSpans();
      rmSync(workspace.root, { recursive: true, force: true });
    },
  };
}
