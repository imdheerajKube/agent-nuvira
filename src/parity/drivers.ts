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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getCache } from '../context/cache.js';
import type { WireFinding } from '../findings/verdicts.js';
import { readGatewayLog } from '../gateway/gateway-log.js';
import type { ChannelAdapter } from '../gateway/adapters.js';
import type { ToolCallObs, TurnObservation } from './observation.js';
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
  close(): Promise<void>;
}

async function startStub(scenario: ParityScenario): Promise<ParityStub> {
  let chatCalls = 0;
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
        return json({ data: [{ id: PARITY_MODEL, object: 'model' }] });
      }
      if (req.url?.endsWith('/chat/completions')) {
        chatCalls += 1;
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ─── The workspace ──────────────────────────────────────────────────────────

/** The throwaway profile a run points the surfaces at. */
interface ParityWorkspace {
  root: string;
  configDir: string;
  memoryDir: string;
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
  const workspace: ParityWorkspace = {
    root,
    configDir,
    memoryDir,
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
function toObservation(
  surface: SurfaceId,
  answer: SurfaceAnswer,
  toolCalls: ToolCallObs[],
  modelCalls: number,
): TurnObservation {
  const succeeded =
    typeof answer.ok === 'boolean' ? answer.ok : answer.generationFailed !== true;
  return {
    surface,
    engine: 'loop',
    status: succeeded ? 'completed' : 'failed',
    // Recorded, never inferred: the runner refuses a zero (rule 4 in
    // ./scenarios.ts) instead of reading a cache replay as agreement.
    modelCalls,
    ...(answer.provider ? { provider: answer.provider } : {}),
    ...(answer.model ? { model: answer.model } : {}),
    ...(answer.transport ? { transport: answer.transport } : {}),
    toolCalls,
    // WS1 — recorded findings, in order. `[]` when the surface reported none.
    findings: answer.findings ?? [],
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
    const answer = await command.answerOnce(scenario.message, {
      provider: PARITY_PROVIDER_TYPE,
      model: PARITY_MODEL,
      onToolCall: (phase, info) => collectCalled(toolCalls, phase, info),
    });
    return toObservation('cli-chat', answer, toolCalls, stub.chatCalls());
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
      const result = await console_.answer(`parity-${scenario.id}`, scenario.message, {
        provider: PARITY_PROVIDER_TYPE,
        model: PARITY_MODEL,
      });
      return toObservation('dashboard-chat', result, toolCalls, stub.chatCalls());
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
    await registry.handleInbound(
      {
        platform: 'mock',
        channelId,
        text: scenario.message,
        from: 'parity',
        senderId: 'parity',
      },
      { forceKind: 'chat' },
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
      }>;
    };
    const result = await command.runSingleGoal(scenario.message, PARITY_PROVIDER_TYPE, PARITY_MODEL, {
      engine: 'loop',
    });
    return toObservation(
      'cli-execute',
      {
        content: result.content,
        provider: result.provider,
        model: result.model,
        transport: result.transport,
        generationFailed: !result.success,
        ...(result.findings ? { findings: result.findings } : {}),
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
  const childRoot = mkdtempSync(join(ws.root, 'subagent-'));
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
      const state = await manager.spawn({
        goal: scenario.message,
        provider: PARITY_PROVIDER_TYPE,
        model: PARITY_MODEL,
        tools: [availableTool],
        env: {
          NUVIRA_CONFIG_DIR: childConfig,
          NUVIRA_MEMORY_DIR: join(childRoot, 'memory'),
        },
      });
      const result = await manager.waitForCompletion(state.id, 60_000);
      const transport =
        result.transport === 'native' || result.transport === 'json' ? result.transport : 'none';
      return {
        surface: 'subagent',
        engine: 'loop',
        status: result.success ? 'completed' : 'failed',
        modelCalls: result.llmCalls,
        ...(result.provider ? { provider: result.provider } : {}),
        ...(result.model ? { model: result.model } : {}),
        transport,
        toolCalls: callsByRun.get(state.id) ?? [],
        // WS1 — the child's own findings, read from the frames it sent.
        findings: result.findings ?? [],
        ...(result.result ? { answer: result.result } : {}),
        ...(result.success ? {} : { errorCode: result.refusalCode ?? 'turn_failed' }),
        noise: { at: Date.now() },
      };
    } finally {
      manager.off('progress', onProgress);
    }
  } finally {
    await stub.close();
    rmSync(childRoot, { recursive: true, force: true });
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
  };
  process.env.NUVIRA_CONFIG_DIR = workspace.configDir;
  process.env.NUVIRA_MEMORY_DIR = workspace.memoryDir;
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
    run: (scenario) => run(workspace, scenario),
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
      rmSync(workspace.root, { recursive: true, force: true });
    },
  };
}
