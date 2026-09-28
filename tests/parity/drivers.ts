/**
 * WS0 (#22) — the drivers that actually run a turn on each surface.
 *
 * Living in `tests/` on purpose: driving a surface needs the test runner's
 * mocking (`vi.spyOn` on the real engine), and putting a test seam into
 * production code to make a test convenient is how a codebase acquires
 * behaviour nobody can account for. Everything that is *not* mocking — the
 * registry, the projection, the matrix, the runner — lives in `src/parity/`,
 * where a future `nuvira parity` command could use it.
 *
 * STUB DEPTH IS DECLARED PER DRIVER, and the real turn code runs end to end on
 * both of the depths in use: `provider` for the in-process surfaces, where only
 * the provider OBJECT is replaced, and `transport` for the subagent, where the
 * child builds a real provider and only the server it talks to is a stub. That
 * is what makes a surface comparable — and `runParityScenario` refuses to compare
 * across depths (and refuses `engine`, which replaces the behaviour under test),
 * so a surface that cannot be driven at a comparable depth is DECLARED as such
 * rather than quietly weakening the verdict.
 *
 * ALL FIVE surfaces are driven here now. `cli-execute` was the last one blocked,
 * on the grounds that it builds its own provider and picks between engines
 * itself (SURFACE_DEBT in `src/parity/surfaces.ts`). That is still true of the
 * COMMAND module — and its two silos are still declared debt — but the surface
 * already runs its loop turns through a shared entry, and the provider beneath
 * that entry comes from the shared factory, so the turn is drivable at provider
 * depth today. The driver below says exactly what that does and does not prove.
 *
 * MODELLED ON A TEST THAT ALREADY EXISTS:
 * `tests/cli/chat-answer-once-auto-parity.test.ts` pins a real, dated
 * cross-surface regression (2026-09-20) — the dashboard resolved ONE concrete
 * provider with auto mode off while the CLI got auto routing, so the same prompt
 * was answered on the CLI and failed on the dashboard. "Same engine, same
 * config, two different modes." The mechanism below is that test's, generalised
 * to a surface pair instead of a single assertion.
 */

import { vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatCommand } from '../../src/cli/chat.js';
import { ChatConsole } from '../../src/web-dashboard/chat-console.js';
import { ProviderFactory } from '../../src/inference/factory.js';
import { getCache } from '../../src/context/cache.js';
import type { ChannelAdapter } from '../../src/gateway/adapters.js';
import { GatewayRegistry } from '../../src/gateway/registry.js';
import type { InferenceProvider } from '../../src/inference/interface.js';
import type { ToolCallObs, TurnObservation } from '../../src/parity/observation.js';
import type { ParityDriver, ParityScenario, StubDepth } from '../../src/parity/scenarios.js';
import type { SurfaceId } from '../../src/parity/surfaces.js';

/** Where every current driver stubs. */
export const DRIVER_DEPTH: StubDepth = 'provider';

/** The provider type and model the stub reports, so both surfaces must agree on them. */
export const PARITY_PROVIDER_TYPE = 'groq';
export const PARITY_MODEL = 'parity-stub-model';

type Proto = {
  getProvider: (opts?: unknown) => Promise<{ type: string; provider: InferenceProvider }>;
  routeMessageAuto: (
    message: string,
  ) => Promise<{ type: string; provider: InferenceProvider; model?: string }>;
};

/**
 * A provider that answers the scenario deterministically.
 *
 * STATELESS PER CALL, ON PURPOSE. The obvious stub is a step counter: first call
 * asks for the tool, second returns the answer — the script
 * `tests/cli/chat-tool-loop.test.ts` uses. That stub silently breaks the moment
 * two turns share a provider instance, which is exactly what the response cache
 * made happen here (turn 2 never called the stub at all, so its counter was
 * never advanced and the failure looked like "no tool events on the second
 * surface"). Reading the thread instead makes the stub correct under any sharing:
 * a `tool`-role message IS the tool result, so its presence means the tool ran
 * and the turn can close. Same two-step behaviour, no hidden state.
 */
function stubProvider(scenario: ParityScenario): InferenceProvider {
  return {
    name: 'ParityStub',
    generateTools: vi.fn(async (messages: Array<{ role?: string }>) => {
      const toolAlreadyRan = Array.isArray(messages) && messages.some((m) => m?.role === 'tool');
      if (scenario.toolCall && !toolAlreadyRan) {
        return {
          content: '',
          toolCalls: [
            { id: 'parity_call_1', name: scenario.toolCall.tool, arguments: scenario.toolCall.args },
          ],
        };
      }
      return { content: scenario.answer, toolCalls: [] };
    }),
    generate: vi.fn().mockResolvedValue(scenario.answer),
    isAvailable: vi.fn().mockResolvedValue(true),
    getInfo: () => 'ParityStub',
    // The catalog must CONTAIN the parity model. The chat surfaces never ask
    // (their routing is stubbed), but the loop entry validates a pinned model
    // against the provider's live list (`resolveWorkingModel`): an empty list
    // would repair the pin to some real provider default, and the run's own
    // attribution would then (honestly) disagree with the chat surfaces.
    listModels: vi.fn().mockResolvedValue([{ id: PARITY_MODEL }]),
  } as unknown as InferenceProvider;
}

/**
 * A provider mock set's OWN invocation count — the non-vacuity check every
 * driver makes, so a turn that agreed without reaching a model is caught by the
 * count rather than trusted on its answer.
 */
function stubModelCalls(provider: InferenceProvider): number {
  const generateTools = provider.generateTools as unknown as
    | { mock?: { calls: unknown[] } }
    | undefined;
  return generateTools?.mock?.calls.length ?? 0;
}

/**
 * The response cache is SHARED, ON DISK, AND ON BY DEFAULT for this path.
 *
 * `answerOnce` runs the turn with `cache: true` (`src/cli/chat.ts:690`) and the
 * cache is keyed by `provider:model:prompt` with a 1-hour TTL
 * (`src/context/cache.ts`). So the two drivers below, running the SAME scenario
 * message in one process, are not independent: the second is served from the
 * first one's entry. MEASURED on 2026-09-28 before this existed — the second
 * driver's own stub recorded `generateTools` calls of exactly 0 while returning
 * the right answer, i.e. a replay, and the run still said `at-par`.
 *
 * Two independent guards, because either one alone is one edit away from being
 * removed: this function makes each driven turn real, and the runner refuses any
 * observation with `modelCalls === 0`. The cache honours `NUVIRA_MEMORY_DIR`, so
 * this is hermetic under the suites' temp dirs.
 */
async function clearResponseCache(): Promise<void> {
  try {
    await getCache().clear();
  } catch {
    // The cache may never break a turn — and a driver must not fail here either;
    // the `modelCalls` guard is what catches a stale entry.
  }
}

/** A handle on the installed stub: how to undo it, and what it was actually asked. */
export interface StubHandle {
  /** Undo every spy. Safe to call once, from a `finally`. */
  restore: () => void;
  /** Model calls this turn actually made. Zero means the turn was a replay. */
  modelCalls: () => number;
  /**
   * What the SHARED engine returned for this turn, in order.
   *
   * Recorded through a call-through spy on `answerOnce`, so a surface that does
   * not hand the engine's result back to its caller (the gateway keeps only
   * `content` + `generationFailed`) can still be observed the same way the CLI
   * and the dashboard drivers observe it — from the engine itself, not from a
   * value this file invented.
   */
  engineAnswers: () => SurfaceAnswer[];
}

/**
 * Point the REAL engine at the stub. Both surfaces below go through the same
 * `ChatCommand` seam — which is the point: if the dashboard ever stops using the
 * shared engine, `ensureEngine()` stops honouring this and the parity case goes
 * red instead of quietly testing a stub.
 *
 * The returned `modelCalls` is the non-vacuity check: it counts the stub's own
 * invocations, so a turn that agreed with the other surface without reaching a
 * model is caught by the count rather than trusted on its answer.
 */
export function installStubProvider(provider: InferenceProvider): StubHandle {
  const getProvider = vi
    .spyOn(ChatCommand.prototype as unknown as Proto, 'getProvider')
    .mockResolvedValue({ type: PARITY_PROVIDER_TYPE, provider });
  const routeMessageAuto = vi
    .spyOn(ChatCommand.prototype as unknown as Proto, 'routeMessageAuto')
    .mockResolvedValue({ type: PARITY_PROVIDER_TYPE, provider, model: PARITY_MODEL });
  // CALL-THROUGH observation of the shared engine's own return value. The
  // original still runs — the spy only records what it returned — so the turn is
  // unchanged and only the observation gets a seam it otherwise lacks.
  //
  // The gateway is why this exists: `runInboundChat` awaits `answerOnce` and keeps
  // only `{ content, generationFailed }`, so the provider and model the shared
  // engine resolved never reach the gateway's caller (recorded on #22). The CLI
  // and dashboard drivers read those fields straight off the engine's return, so
  // reading them here is the same observation those drivers make.
  const answers: SurfaceAnswer[] = [];
  const originalAnswerOnce = ChatCommand.prototype.answerOnce as unknown as (
    this: unknown,
    ...args: unknown[]
  ) => Promise<SurfaceAnswer>;
  const answerOnce = vi
    .spyOn(
      ChatCommand.prototype as unknown as {
        answerOnce: (this: unknown, ...args: unknown[]) => Promise<SurfaceAnswer>;
      },
      'answerOnce',
    )
    .mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const result = await originalAnswerOnce.apply(this, args);
      answers.push(result);
      return result;
    });
  return {
    restore: () => {
      getProvider.mockRestore();
      routeMessageAuto.mockRestore();
      answerOnce.mockRestore();
    },
    modelCalls: () => stubModelCalls(provider),
    engineAnswers: () => answers,
  };
}

/** The shape both surfaces return, reduced to what an observer could see. */
interface SurfaceAnswer {
  /**
   * Optional on purpose: only the dashboard console SYNTHESISES an `ok`; the
   * engine, the gateway and the command all report `generationFailed` instead,
   * and the projection treats "no `ok`" as "judge it by generationFailed"
   * rather than inventing a verdict for them (see `toObservation`).
   */
  ok?: boolean;
  content?: string | null;
  provider?: string | null;
  model?: string | null;
  /**
   * R2 — the transport the engine reported (`native` / `json` / `none`), or
   * null/absent when it said nothing. Read, never inferred: the whole point of
   * teaching the chat engine to report this is that the observation can quote
   * it, exactly as the subagent driver quotes the child's announcement.
   */
  transport?: 'native' | 'json' | 'none' | null;
  /**
   * The surface's own per-call tool lifecycle, when it reports one. Read off
   * the surface's return for the gateway, exactly as the engine's own return is
   * read for the CLI: a surface that starts handing this on proves the claim,
   * and a surface that stops goes red rather than being read from somewhere
   * else.
   */
  toolCalls?: Array<{ tool: string; ok?: boolean }>;
  error?: string;
  generationFailed?: boolean;
}

/**
 * Reduce a surface's own answer object to the shared observation.
 *
 * MEASURED, and found by this harness on its first real run: the two surfaces do
 * NOT share a result contract. `ChatCommand.answerOnce` returns
 * `{ content, followups, provider, model, generationFailed? }` — there is no `ok`
 * field (`grep -n 'ok: true\|ok: false' src/cli/chat.ts` finds none) — while
 * `ChatConsole.answer` wraps that result and SYNTHESISES `ok`. So a caller of the
 * shared engine has to infer success from `generationFailed`, and a caller of the
 * console reads `ok`: two different questions asked of the same turn.
 *
 * The driver maps each surface's OWN contract rather than inventing a common one,
 * because inventing one here would hide precisely the seam difference this
 * harness exists to expose. The engine's missing `ok` is recorded on #22.
 */
function toObservation(
  surface: SurfaceId,
  scenario: ParityScenario,
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
    // src/parity/scenarios.ts) instead of reading a cache replay as agreement.
    modelCalls,
    ...(answer.provider ? { provider: answer.provider } : {}),
    ...(answer.model ? { model: answer.model } : {}),
    // R2 — the engine's own transport report. A surface that says nothing
    // leaves it absent, and `compare` names that absence as a difference rather
    // than reading silence as agreement.
    ...(answer.transport ? { transport: answer.transport } : {}),
    toolCalls,
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
 * not happen, and an outcome that is absent is recorded as absent rather than
 * guessed at.
 */
function collectCalled(
  target: ToolCallObs[],
  phase: string,
  info: { tool: string; ok?: boolean },
): void {
  if (phase !== 'called') return;
  target.push({ tool: info.tool, ...(typeof info.ok === 'boolean' ? { ok: info.ok } : {}) });
}

/** CLI chat: the shared engine, called directly. */
async function runViaChatOnce(scenario: ParityScenario): Promise<TurnObservation> {
  await clearResponseCache();
  const stub = installStubProvider(stubProvider(scenario));
  try {
    const command = new ChatCommand() as unknown as {
      answerOnce: (
        message: string,
        opts: {
          onToolCall?: (phase: 'started' | 'called', info: { tool: string; ok?: boolean }) => void;
        },
      ) => Promise<SurfaceAnswer>;
    };
    const toolCalls: ToolCallObs[] = [];
    // No provider and no model, exactly as the dashboard and the gateway call it.
    const answer = await command.answerOnce(scenario.message, {
      onToolCall: (phase, info) => collectCalled(toolCalls, phase, info),
    });
    return toObservation('cli-chat', scenario, answer, toolCalls, stub.modelCalls());
  } finally {
    stub.restore();
  }
}

/**
 * Dashboard chat: the real console, with NO injected engine — so `ensureEngine()`
 * lazily imports the real `ChatCommand` (`chat-console.ts:391`) and the console's
 * own turn plumbing (session record, busy guard, turn telemetry, progress
 * emission) is exercised rather than bypassed.
 */
async function runViaConsole(scenario: ParityScenario): Promise<TurnObservation> {
  await clearResponseCache();
  const stub = installStubProvider(stubProvider(scenario));
  const console_ = new ChatConsole({});
  const toolCalls: ToolCallObs[] = [];
  // The console's own subscription seam — the same one the GUI uses — rather
  // than reaching into the engine, so this observes what a dashboard user sees.
  const off = console_.onEvent((_sessionId, event) => {
    if (event.kind !== 'tool') return;
    collectCalled(toolCalls, event.phase, { tool: event.tool, ...(event.ok === undefined ? {} : { ok: event.ok }) });
  });
  try {
    const result = await console_.answer(`parity-${scenario.id}`, scenario.message, {});
    return toObservation('dashboard-chat', scenario, result, toolCalls, stub.modelCalls());
  } finally {
    off();
    stub.restore();
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

/** Unique per gateway run: the gateway dedups a re-delivered message, and the repeatability test re-runs one scenario. */
let gatewayRun = 0;

/**
 * Gateway (WhatsApp / Telegram / …): the REAL registry handler with NO chat
 * engine injected, so `runInboundChat` lazy-imports the real `ChatCommand` — the
 * same shared entry the CLI and the dashboard use. That lazy import is the seam
 * `tests/gateway/registry.test.ts` already pins.
 *
 * The observation is taken from what the surface HANDS BACK (a call-through spy
 * on `runInboundChat`), not from the engine it called: the gateway now returns
 * provider/model/transport, and reading the surface's own report is the
 * difference between proving the surface attributes a run and proving the
 * engine does.
 *
 * `forceKind: 'chat'` pins the ROUTE, deliberately: the shared NLU decision is
 * exercised by its own tests, and a pipeline-shaped message ('list the working
 * directory…') would otherwise dispatch to the orchestrator through
 * `runPipelineTool`. This driver compares the TURN, not the router.
 */
async function runViaGateway(scenario: ParityScenario): Promise<TurnObservation> {
  await clearResponseCache();
  const stub = installStubProvider(stubProvider(scenario));
  const adapter = new RecordingAdapter();
  const registryDir = mkdtempSync(join(tmpdir(), 'buff-parity-gateway-'));
  const registry = new GatewayRegistry({ streamEvents: false, deliveryConfigDir: registryDir });
  registry.register(adapter);
  // CALL-THROUGH observation of the SURFACE's own report. `runInboundChat` is
  // the gateway's boundary: it runs the shared engine and returns the turn's
  // outcome. The driver used to read the provider/model off the ENGINE, which
  // is evidence about the engine — and precisely why the gateway's
  // run-attribution cell could not be proved. Recording what the surface
  // RETURNS closes that: if the gateway stops handing the triple back, this
  // goes red instead of quietly reading it from somewhere else.
  const replies: SurfaceAnswer[] = [];
  const boundary = GatewayRegistry.prototype as unknown as {
    runInboundChat: (this: unknown, ...args: unknown[]) => Promise<SurfaceAnswer>;
  };
  const originalBoundary = boundary.runInboundChat;
  const boundarySpy = vi
    .spyOn(boundary, 'runInboundChat')
    .mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const reply = await originalBoundary.apply(this, args);
      replies.push(reply);
      return reply;
    });
  try {
    gatewayRun += 1;
    await registry.handleInbound(
      {
        platform: 'mock',
        channelId: `parity-${scenario.id}-${gatewayRun}`,
        text: scenario.message,
        from: 'parity',
        senderId: 'parity',
      },
      { forceKind: 'chat' },
    );
    const answer = replies.at(-1);
    if (!answer) throw new Error('the gateway did not run the shared chat engine for this message');
    // The gateway now wires the engine's onToolCall seam and hands each call's
    // outcome back on its own return (and into `inbound.chat`), so the tool
    // lifecycle is read from the SURFACE's report — the same reading the CLI,
    // dashboard and command drivers get. It used to record an empty list here,
    // which is why tool-call-lifecycle@gateway-chat could not be proven.
    const toolCalls: ToolCallObs[] = (answer.toolCalls ?? []).map((call) => ({
      tool: call.tool,
      ...(typeof call.ok === 'boolean' ? { ok: call.ok } : {}),
    }));
    return toObservation('gateway-chat', scenario, answer, toolCalls, stub.modelCalls());
  } finally {
    boundarySpy.mockRestore();
    stub.restore();
    rmSync(registryDir, { recursive: true, force: true });
  }
}

let subagentHome: string | null = null;

/**
 * A stable home for the manager's own state/log/result dirs.
 *
 * MEASURED: `SubagentManager` compiles those dirs from `NUVIRA_CONFIG_DIR` at
 * MODULE IMPORT. This suite pins a fresh config dir per test and deletes it
 * afterwards, so a manager imported during test 1 then wrote test 2's result into
 * a directory that no longer existed — ENOENT inside `handleExit`, and a run that
 * never reported completion. A dir that outlives the file fixes the cause rather
 * than retrying around it. Only `os.tmpdir()` is touched, and only when a
 * subagent is actually driven, so a registry-only test creates nothing.
 */
function stableSubagentHome(): string {
  if (!subagentHome) subagentHome = mkdtempSync(join(tmpdir(), 'buff-parity-subagent-home-'));
  return subagentHome;
}

/**
 * Subagent: a REAL forked child process over its IPC channel, with the model
 * served by a stub Groq-compatible endpoint. Transport depth by definition —
 * the provider object the child builds is real (the Groq adapter); only the
 * server it talks to is a stub.
 *
 * WHY THE PROVIDER ID MATCHES THE OTHER SURFACES. The child resolves its own
 * provider from config (that IS the isolation boundary), and a turn-parity claim
 * is only meaningful if the surfaces ran the SAME logical backend. So the child
 * is configured as `groq` — the id the in-process stubs report — pointed at the
 * local stub server through `providers.groq.baseUrl` (the override the adapter
 * honors, like NIM/Anthropic/the generic OpenAI-compat adapter). Groq speaks the
 * OpenAI tool protocol, so the child's tool-calling turn runs on the NATIVE
 * transport the other surfaces report, instead of the shared JSON fallback the
 * Ollama-only stub forced.
 *
 * The observation is read from what the child itself reported (provider, model,
 * transport, llm calls, and each tool call + outcome on its progress frames),
 * never reconstructed here.
 */
async function runViaSubagent(scenario: ParityScenario): Promise<TurnObservation> {
  // Lazy on purpose: a test that only reads the registry
  // (capability-matrix.test.ts) must not import the spawner at all, let alone
  // create its directories.
  const previousConfigDir = process.env.NUVIRA_CONFIG_DIR;
  process.env.NUVIRA_CONFIG_DIR = stableSubagentHome();
  let getSubagentManager: typeof import('../../src/tools/subagent-spawner.js')['getSubagentManager'];
  try {
    ({ getSubagentManager } = await import('../../src/tools/subagent-spawner.js'));
  } finally {
    if (previousConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = previousConfigDir;
  }

  const work = mkdtempSync(join(tmpdir(), 'buff-parity-subagent-'));
  const configDir = join(work, 'config');
  mkdirSync(configDir, { recursive: true });

  let chatCalls = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const json = (body: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/v1/models') {
        // The child never lists models (the configured model is pinned), but a
        // reachability probe against an OpenAI-compatible endpoint asks here.
        return json({ data: [{ id: PARITY_MODEL, object: 'model' }] });
      }
      if (req.url === '/v1/chat/completions') {
        chatCalls += 1;
        // First reply asks for the tool (OpenAI `tool_calls`), the next closes
        // the turn — the same two-step shape the other drivers' stub provider
        // uses, stated in the shared OpenAI wire contract rather than a private
        // dialect. The presence of a `tool`-role message is what says the call
        // already ran, so this is correct however the thread is replayed.
        let toolAlreadyRan = false;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
            messages?: Array<{ role?: string }>;
          };
          toolAlreadyRan = (body.messages ?? []).some((m) => m?.role === 'tool');
        } catch {
          toolAlreadyRan = false;
        }
        if (scenario.toolCall && !toolAlreadyRan) {
          return json({
            choices: [
              {
                message: {
                  content: '',
                  tool_calls: [
                    {
                      id: 'parity_call_1',
                      type: 'function',
                      function: {
                        name: scenario.toolCall.tool,
                        arguments: JSON.stringify(scenario.toolCall.args),
                      },
                    },
                  ],
                },
              },
            ],
          });
        }
        return json({ choices: [{ message: { content: scenario.answer } }] });
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  writeFileSync(
    join(configDir, 'buffconfig.json'),
    JSON.stringify({
      defaultProvider: 'groq',
      providers: {
        // The override the Groq adapter now honors: the child's REAL provider
        // object points at this stub server, so the provider id the run reports
        // (`groq`) and the transport it speaks (`native`) match the in-process
        // surfaces' — and the isolation is still the child's own process.
        groq: { apiKey: 'parity-stub-key', model: PARITY_MODEL, baseUrl: `${baseUrl}/v1` },
      },
    }),
  );

  const manager = getSubagentManager();
  // Keyed by run id: the listener is attached before the id exists, and a
  // progress frame can arrive before `spawn()` resolves.
  const callsByRun = new Map<string, ToolCallObs[]>();
  const onProgress = (id: string, msg: { phase?: string; tool?: string; ok?: boolean }) => {
    // The OUTCOME frame. The child reports both halves of a call now —
    // `tool_call` then `tool_result` — mirroring the main loop's
    // `tool:started`/`tool:called` pair, and the driver records the one that
    // carries WHAT HAPPENED, exactly as the in-process drivers read the
    // `called` phase. A call whose outcome never arrives keeps `ok` absent;
    // absence is never written up as a success.
    if (msg?.phase !== 'tool_result' || typeof msg.tool !== 'string') return;
    const list = callsByRun.get(id) ?? [];
    list.push({ tool: msg.tool, ...(typeof msg.ok === 'boolean' ? { ok: msg.ok } : {}) });
    callsByRun.set(id, list);
  };
  manager.on('progress', onProgress);
  try {
    const state = await manager.spawn({
      goal: scenario.message,
      provider: 'groq',
      model: PARITY_MODEL,
      tools: scenario.toolCall ? [scenario.toolCall.tool] : [],
      env: {
        NUVIRA_CONFIG_DIR: configDir,
        NUVIRA_MEMORY_DIR: join(work, 'memory'),
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
      // The child's own report of each call AND its outcome, read off its
      // progress frames — the name from `tool_call`, the verdict from
      // `tool_result` (collected above). Nothing is reconstructed here.
      toolCalls: callsByRun.get(state.id) ?? [],
      ...(result.result ? { answer: result.result } : {}),
      ...(result.success ? {} : { errorCode: result.refusalCode ?? 'turn_failed' }),
      noise: { at: Date.now() },
    };
  } finally {
    manager.off('progress', onProgress);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * CLI execute / one-shot: the COMMAND's own single-goal path, with the provider
 * served by the shared factory.
 *
 * WHY THE COMMAND NOW. This driver used to drive the shared loop entry
 * (`runLoopExecutor`) and admitted so in a note: `execute.ts` owned two silos
 * (its own provider, a private `Orchestrator`), so the command module could not
 * be driven at provider depth. Both are paid off — the command resolves through
 * the shared `resolveProvider` and runs pipeline turns through
 * `runPipelineTool` — and its single-goal path now hands the turn and its
 * attribution back to the caller. So the driver drives the SURFACE, which is
 * what a parity claim about a surface is supposed to mean.
 *
 * TWO SEAMS, ONE PROVIDER OBJECT. For the same message the surface can take
 * either arm of its own gate — `chat-once` (a conversational ask answered
 * directly) or its loop arm — so BOTH provider seams point at ONE stub: the
 * shared engine's `getProvider`/`routeMessageAuto`, and the shared
 * `ProviderFactory.createProvider` the loop arm resolves through. One object
 * means the model-call count is the run's whichever arm ran, so a turn can be
 * neither double-counted nor missed. `engine: 'loop'` pins the engine for a goal
 * the conversation gate does not claim, so the router cannot send this scenario
 * into the multi-agent pipeline.
 *
 * The observation is what the COMMAND reports back — status, content, the
 * attribution triple and each tool call with its outcome — never what the engine
 * inside it happened to know.
 */
async function runViaExecuteCommand(scenario: ParityScenario): Promise<TurnObservation> {
  await clearResponseCache();
  const provider = stubProvider(scenario);
  const stub = installStubProvider(provider);
  // The shared factory IS the seam: every provider the loop arm resolves (pinned
  // or auto, adapter or plugin) is constructed through it, so nothing above the
  // provider object is faked.
  const createProvider = vi
    .spyOn(ProviderFactory, 'createProvider')
    .mockReturnValue(provider as never);
  // Lazy on purpose: a test that only reads the registry
  // (capability-matrix.test.ts) must not drag the whole execute stack in.
  const { ExecuteCommand } = await import('../../src/cli/execute.js');
  try {
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
      }>;
    };
    const result = await command.runSingleGoal(scenario.message, PARITY_PROVIDER_TYPE, PARITY_MODEL, {
      engine: 'loop',
    });
    return {
      surface: 'cli-execute',
      engine: 'loop',
      status: result.success ? 'completed' : 'failed',
      // The stub's own count, exactly as the in-process drivers record it.
      modelCalls: stubModelCalls(provider),
      ...(result.provider ? { provider: result.provider } : {}),
      ...(result.model ? { model: result.model } : {}),
      ...(result.transport ? { transport: result.transport } : {}),
      // The command's own per-call outcomes. Its loop arm reports the ordered
      // `{ tool, ok }` pair now (captured from the loop's `tool`/`refusal`
      // events), so the outcome is READ, not derived — pairing a name list with
      // a separate error set could not say which of two calls by the same tool
      // failed. The fallback keeps a name-only result honest: `ok` stays absent
      // rather than being guessed.
      toolCalls: result.toolOutcomes
        ? result.toolOutcomes.map((call) => ({
            tool: call.tool,
            ...(typeof call.ok === 'boolean' ? { ok: call.ok } : {}),
          }))
        : (result.toolCalls ?? []).map((tool) => ({ tool })),
      ...(typeof result.content === 'string' ? { answer: result.content } : {}),
      ...(result.success ? {} : { errorCode: 'turn_failed' }),
      noise: { at: Date.now() },
    };
  } finally {
    createProvider.mockRestore();
    stub.restore();
  }
}

/**
 * A driver that exists only to record why it cannot run. Exported so a test can
 * pin the guard that a blocked surface is never silently invoked — the real
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

/**
 * Every surface, drivable or not — and today every declared surface is driven.
 * `blockedDriver` stays exported because the guard it builds is worth pinning.
 */
export function parityDrivers(): ParityDriver[] {
  return [
    { surface: 'cli-chat', depth: DRIVER_DEPTH, available: true, run: runViaChatOnce },
    { surface: 'dashboard-chat', depth: DRIVER_DEPTH, available: true, run: runViaConsole },
    { surface: 'gateway-chat', depth: DRIVER_DEPTH, available: true, run: runViaGateway },
    { surface: 'cli-execute', depth: DRIVER_DEPTH, available: true, run: runViaExecuteCommand },
    { surface: 'subagent', depth: 'transport', available: true, run: runViaSubagent },
  ];
}

/** The surfaces the harness can drive today. */
export function drivableSurfaces(): SurfaceId[] {
  return parityDrivers()
    .filter((driver) => driver.available)
    .map((driver) => driver.surface);
}

/**
 * The drivers whose stub sits at the provider object — comparable with each
 * other. This is the group a cross-surface verdict is read from.
 */
export function providerDepthDrivers(): ParityDriver[] {
  return parityDrivers().filter((driver) => driver.depth === 'provider');
}

/**
 * The driver that forks the real child against a stub server. Kept separate
 * because `runParityScenario` refuses to compare it with a provider-depth stub:
 * the two depths are declared, and folding them into one verdict would mean
 * comparing a fake provider object with a real one.
 */
export function transportDepthDrivers(): ParityDriver[] {
  return parityDrivers().filter((driver) => driver.depth === 'transport');
}

/**
 * The matrix cells the parity cases in this directory actually PROVE.
 *
 * Kept here, beside the drivers, so the claim and the mechanism that backs it
 * cannot drift: `capability-matrix.test.ts` asserts the matrix's unverified debt
 * equals everything else, and `scenario-parity.test.ts` is what makes these two
 * true. Adding a name here without a test that proves it turns the matrix into
 * the thing WS0 exists to prevent.
 */
export const VERIFIED_CELLS: ReadonlySet<string> = new Set([
  // Proven by 'answers the same message the same way, and attributes it the same
  // way': every surface runs the real engine at provider depth and agrees on
  // status, answer and the provider that served the turn. The gateway reaches the
  // engine through its own registry handler (no engine injected), so its lazy
  // import of the real ChatCommand is exercised too.
  'turn-parity@cli-chat',
  'turn-parity@dashboard-chat',
  'turn-parity@gateway-chat',
  // Proven by the same case, which asserts the FULL attribution triple agrees:
  // provider, model and — since R2 taught the shared engine to report it —
  // transport. Each surface's driver reads the triple from THAT SURFACE's own
  // report (the engine's return, the console's result, the command's result, the
  // gateway's `runInboundChat` return + its log), so the claim is about the
  // surface handing the attribution on, not about the engine happening to know.
  'run-attribution@cli-chat',
  'run-attribution@dashboard-chat',
  'run-attribution@gateway-chat',
  // Proven by the same case on the FIFTH surface: the driver drives the COMMAND's
  // own single-goal path (`runSingleGoal`) with the provider stubbed at the
  // shared factory, so the same message produces the same status, answer,
  // provider, model and transport as the chat surfaces' loop turns.
  'turn-parity@cli-execute',
  'run-attribution@cli-execute',
  // Proven by the mixed-depth run ('reports the subagent's tool call and its
  // outcome, and folds its transport depth into the comparison'): with the child
  // driven on the SAME provider id and transport as the in-process surfaces, the
  // comparison of all five surfaces is at-par — status, answer, provider, model,
  // transport and the ordered tool calls, all agreeing.
  'turn-parity@subagent',
  // Proven by 'drives the real forked subagent and reads the identity the child
  // reported': the child announces provider/model/transport before it can fail
  // and the manager records them on the run, so the surface genuinely reports
  // the triple it was served by.
  'run-attribution@subagent',
  // ALL FIVE surfaces report the executed call and its outcome, through their
  // own seams: the CLI through the engine's onToolCall, the dashboard through
  // the console event stream, the gateway through the onToolCall wiring whose
  // result rides back on `runInboundChat`, the command through the loop's
  // per-call `{ tool, ok }` outcomes, and the child through its `tool_call` →
  // `tool_result` progress frames. Proven by 'reports the same tool call, with
  // the same outcome, on both surfaces' (the four provider-depth surfaces) and
  // by the subagent driver case for the child.
  'tool-call-lifecycle@cli-chat',
  'tool-call-lifecycle@dashboard-chat',
  'tool-call-lifecycle@gateway-chat',
  'tool-call-lifecycle@cli-execute',
  'tool-call-lifecycle@subagent',
]);
