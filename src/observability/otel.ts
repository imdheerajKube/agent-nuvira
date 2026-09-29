/**
 * WS3 (#25) — the turn's span tree, exported over OTLP when an operator asks.
 *
 * WHY THIS EXISTS. WS2 gave a run a log you can attach to a bug report; that is
 * one run on one machine. What it cannot do is show a turn's SHAPE across many
 * runs — which step is slow, which tool is the one that fails, whether the
 * subagent a turn spawned is where the time went. That is a tracing problem, and
 * the answer everyone's tooling already speaks is OTLP.
 *
 * WHY THE OFFICIAL SDK, here of all places. This repository hand-rolls its
 * observability on purpose (the debug log, the gateway log, `generateZip`) — and
 * a native OTLP writer was the obvious first instinct. It was rejected for a
 * specific reason: the parts hardest to get right are the ones nobody notices
 * until a collector shows nothing. 64-bit nanosecond timestamps as strings, the
 * sampled bit in `traceFlags`, an empty-versus-omitted `parentSpanId`, header
 * parsing, retries, gzip — each is a silent failure mode, and none of them is
 * this project's problem to own. `@opentelemetry/*` already ships them correct,
 * and anything that speaks OTLP accepts what it produces.
 *
 * THREE RULES, each closing a way tracing makes a product worse:
 *
 *  1. OFF UNLESS ASKED. `NUVIRA_OTEL=1` turns it on. With it off the SDK is
 *     never even imported (`ensureProvider` is the only place that loads it), so
 *     an ordinary run pays no startup cost and no span object is ever built. The
 *     API package is a static import because that is exactly its design: with no
 *     provider registered, every call through it is a no-op.
 *
 *  2. IT CAN NEVER BREAK THE RUN. Provider setup, attribute rendering and the
 *     final flush are each best-effort, and the flush is BOUNDED — an
 *     unreachable collector costs a turn at most three seconds, once, and never
 *     an exception. A tracer that can fail the turn it observes is worse than no
 *     tracer.
 *
 *  3. IT CARRIES WHAT THE OTHER SINKS CARRY. Attribute values are previewed and
 *     scrubbed with the SAME `scrubSecrets` the gateway log and the debug log
 *     use, because a span is shipped to a third party by definition. Two regex
 *     lists drift, and the one that drifts is the one that leaks.
 *
 * THE TREE, and what is deliberately not in it. A turn span (`nuvira.turn`) with
 * one child per tool call that actually ran (`nuvira.tool.<name>`), plus the
 * findings the turn recorded as span EVENTS — a finding has no duration, so it
 * is a point-in-time fact rather than a span. There is no model-call span, and
 * that is a measurement rather than an omission: the loop's event taxonomy
 * (`tool`, `gate`, `refusal`, `decision`) has no model kind, so a model span
 * could only be produced on some surfaces, and a tree that differs per surface
 * is a tracing feature that lies. The missing span is the honest version; it is
 * recorded here so the next person does not "fix" it by inventing one in
 * `chat.ts` alone.
 *
 * PROPAGATION ACROSS THE FORK. A subagent is a separate process with its own
 * provider, so its spans would be a second, unrelated trace by default. The
 * spawner injects the ambient W3C `traceparent` into the child's environment
 * (`childTraceEnv`) and the child resumes from it (`parentContextFromEnv`), so
 * the child's turn span hangs off the tool call that spawned it and the whole
 * thing is ONE trace. The parent comes from the ACTIVE context, never from
 * module state: the loop makes the tool span active around the tool's execution,
 * so two turns interleaving in one server process cannot hand each other's trace
 * ids to a child. The turn's own parent is passed in explicitly for the same
 * reason — reading it from `process.env` inside `startTurnSpan` would make every
 * in-process surface inherit whatever a parent process happened to leave there.
 */

import { readFileSync } from 'node:fs';
import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
// The W3C trace-context propagator, taken EXPLICITLY rather than through the
// global one, and that choice is load-bearing. MEASURED: a forked child resolves
// its parent BEFORE it registers a provider, and with nothing registered the API's
// global propagator is the NOOP one — which returns the input context unchanged
// and silently makes every child start a trace of its own. Using the same explicit
// propagator on both sides of the fork makes the header a matched pair.
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { scrubSecrets } from '../gateway/gateway-log.js';

/** The one propagator used to inject and extract the child's `traceparent`. */
const w3cTraceContext = new W3CTraceContextPropagator();

/** The env var suffix that turns span export on (`NUVIRA_OTEL=1`). */
export const OTEL_ENABLE_ENV = 'OTEL';
/**
 * The env var a forked child is handed its parent's trace in.
 *
 * The VALUE is the W3C `traceparent` header, and the name is deliberately the
 * conventional uppercase form of it — an environment variable, not a header.
 */
export const TRACEPARENT_ENV = 'TRACEPARENT';
/**
 * The W3C header name ITSELF, which is LOWERCASE, and that is not cosmetics.
 *
 * MEASURED: the propagator reads and writes the carrier by this exact key, so a
 * carrier keyed `TRACEPARENT` is a carrier it cannot see — inject silently yields
 * nothing and extract silently yields the input context, which is how every child
 * ends up starting a trace of its own while everything still "works".
 */
const TRACEPARENT_HEADER = 'traceparent';
/** The root span of a turn. One name on every surface, so a tree compares. */
export const TURN_SPAN_NAME = 'nuvira.turn';
/** Child span prefix for a tool call: `nuvira.tool.read_file`. */
export const TOOL_SPAN_PREFIX = 'nuvira.tool.';
/** The instrumentation scope name (what a collector shows as the source). */
export const INSTRUMENTATION_NAME = 'agent-nuvira';
/** Default `service.name`, overridable with `OTEL_SERVICE_NAME`. */
export const DEFAULT_SERVICE_NAME = 'agent-nuvira';
/** Attribute values are previews, not payloads — the longest line we ship. */
export const OTEL_ATTR_PREVIEW_CHARS = 300;
/** Bound on a flush: an unreachable collector must not stall a turn. */
export const OTEL_FLUSH_TIMEOUT_MS = 3_000;
/** Span queue bound, so a long-lived server cannot grow without limit. */
export const OTEL_MAX_QUEUE = 2_048;
/** How long the batch waits before shipping, in a process that keeps running. */
export const OTEL_SCHEDULE_DELAY_MS = 1_000;

/** The variable a user sets to turn this on, spelled out for a message. */
export const otelEnableVarName = `NUVIRA_${OTEL_ENABLE_ENV}`;

/**
 * Is span export on?
 *
 * `NUVIRA_OTEL` (or legacy `BUFF_OTEL`) set to anything other than the falsey
 * words `0`, `false`, `off` or `no` enables it — the same rule the debug log
 * uses, so `NUVIRA_OTEL=false` in an `.env` means off rather than "a non-empty
 * string".
 */
export function otelExportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[otelEnableVarName] ?? env[`BUFF_${OTEL_ENABLE_ENV}`];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false' && value !== 'off' && value !== 'no';
}

/**
 * Where spans will be shipped — for a notice, and so a user who enabled export
 * without an endpoint is told their spans are being built and dropped.
 *
 * Per the OTLP spec the TRACES variable is used verbatim and the generic one
 * gets the signal path appended. The SDK does that resolution for us; this only
 * has to say it out loud.
 */
export function otelEndpoint(env: NodeJS.ProcessEnv = process.env): string | null {
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (traces) return traces;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/v1/traces`;
}

/** One span we hand out. A `null` handle means export is off. */
export interface SpanHandle {
  /** 32 hex chars, shared by every span of the trace — including a child's. */
  readonly traceId: string;
  /** 16 hex chars — what a child process reports back as its remote parent. */
  readonly spanId: string;
  /** Set one attribute (previewed and scrubbed). */
  attr(key: string, value: unknown): void;
  /** Record a point-in-time fact on this span. */
  event(name: string, attrs?: Record<string, unknown>): void;
  /** Start a child span under this one (a tool call). */
  child(name: string, attrs?: Record<string, unknown>): SpanHandle;
  /** Finish. Idempotent, because a branch and a `finally` may both call it. */
  end(outcome?: { ok?: boolean; message?: string }): void;
}

/** What a turn span is started with. */
export interface TurnSpanOptions {
  /** `cli-chat` / `cli-execute` / `dashboard-chat` / `gateway-chat` / `subagent`. */
  surface: string;
  /** The conversation, when the surface has one (see the debug log's header). */
  session?: string;
  /** The request, previewed — the same bounded preview the debug log writes. */
  goal?: string;
  /**
   * The context to continue — a forked child resuming its parent's trace.
   * Passed in rather than read from `process.env` here, so an in-process surface
   * can never accidentally adopt a parent that some other process left in the
   * environment.
   */
  parent?: Context | null;
}

/** The outcome a span can be ended with. */
export interface SpanOutcome {
  ok?: boolean;
  message?: string;
}

/** Cut a string to `max` chars, marking the cut so a reader knows it happened. */
function cap(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * One attribute value, safe to ship: flattened, cut, then redacted.
 *
 * OTLP accepts a scalar or an array of scalars, so anything else becomes a
 * bounded JSON preview rather than being dropped — an attribute that silently
 * vanishes is a debugging hole that only shows up when someone needs it. A
 * circular structure returns a marker instead of throwing, because an
 * instrument must never be the reason a turn fails.
 */
function attrValue(value: unknown): string | number | boolean | string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items = value
      .filter((v): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      .slice(0, 20)
      .map((v) => scrubSecrets(cap(String(v), OTEL_ATTR_PREVIEW_CHARS)));
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === 'string') {
    return scrubSecrets(cap(value.replace(/\s+/g, ' ').trim(), OTEL_ATTR_PREVIEW_CHARS));
  }
  try {
    const json = JSON.stringify(value, (_key, v) =>
      typeof v === 'string' && v.length > 120 ? `${v.slice(0, 119)}…` : v,
    );
    return json === undefined ? undefined : scrubSecrets(cap(json, OTEL_ATTR_PREVIEW_CHARS));
  } catch {
    return '[unrenderable]';
  }
}

/** Turn a record of attributes into what OTLP wants, dropping absent values. */
function attrRecord(attrs: Record<string, unknown>): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const rendered = attrValue(value);
    if (rendered !== undefined) out[key] = rendered;
  }
  return out;
}

/** The real span wrapper. Private: callers program against {@link SpanHandle}. */
class OtelSpanHandle implements SpanHandle {
  private ended = false;
  private readonly record: Span;
  /**
   * The context this span hangs under — its own span set as the active one, so
   * a child nests correctly without depending on what is ambient at the time.
   */
  private readonly ownContext: Context;

  constructor(record: Span, baseContext: Context) {
    this.record = record;
    this.ownContext = trace.setSpan(baseContext, record);
  }

  get traceId(): string {
    return this.record.spanContext().traceId;
  }

  get spanId(): string {
    return this.record.spanContext().spanId;
  }

  /** The underlying span, for {@link withSpanActive}. Not part of the contract. */
  get spanRecord(): Span {
    return this.record;
  }

  attr(key: string, value: unknown): void {
    const rendered = attrValue(value);
    if (rendered === undefined) return;
    try {
      this.record.setAttribute(key, rendered);
    } catch {
      /* best-effort: an attribute must never break the turn it describes */
    }
  }

  event(name: string, attrs: Record<string, unknown> = {}): void {
    try {
      this.record.addEvent(name, attrRecord(attrs));
    } catch {
      /* best-effort */
    }
  }

  child(name: string, attrs: Record<string, unknown> = {}): SpanHandle {
    const record = trace.getTracer(INSTRUMENTATION_NAME).startSpan(
      name,
      { kind: SpanKind.INTERNAL, attributes: attrRecord(attrs) },
      this.ownContext,
    );
    return new OtelSpanHandle(record, this.ownContext);
  }

  end(outcome: SpanOutcome = {}): void {
    if (this.ended) return;
    this.ended = true;
    try {
      if (outcome.ok === false) {
        this.record.setStatus({
          code: SpanStatusCode.ERROR,
          ...(outcome.message ? { message: cap(outcome.message, OTEL_ATTR_PREVIEW_CHARS) } : {}),
        });
      } else {
        this.record.setStatus({ code: SpanStatusCode.OK });
      }
      this.record.end();
    } catch {
      /* best-effort */
    }
  }
}

/** The registered provider + tracer, built once per process. */
interface OtelRuntime {
  provider: { forceFlush(): Promise<void>; shutdown(): Promise<void> };
}

let runtime: OtelRuntime | null = null;
let starting: Promise<OtelRuntime | null> | null = null;

/**
 * Build and register the provider the first time a span is asked for.
 *
 * The SDK is imported HERE rather than at module load, so a run that never
 * enables export never pays for it — which is why `NUVIRA_OTEL` is a gate and
 * not merely a flag that produces no spans.
 */
async function ensureProvider(): Promise<OtelRuntime | null> {
  if (!otelExportEnabled()) return null;
  if (runtime) return runtime;
  if (!starting) {
    starting = (async (): Promise<OtelRuntime | null> => {
      try {
        const [{ NodeTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }, { resourceFromAttributes }] =
          await Promise.all([
            import('@opentelemetry/sdk-trace-node'),
            import('@opentelemetry/exporter-trace-otlp-http'),
            import('@opentelemetry/resources'),
          ]);
        const provider = new NodeTracerProvider({
          resource: resourceFromAttributes({
            'service.name': process.env.OTEL_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME,
            'service.version': agentVersion() ?? 'unknown',
            // A forked child is its own process, and that is the isolation
            // boundary this project already documents — so a collector can tell
            // the parent's spans from the child's by instance id.
            'service.instance.id': String(process.pid),
          }),
          spanProcessors: [
            new BatchSpanProcessor(
              // No explicit url, headers or compression: the exporter reads the
              // standard `OTEL_EXPORTER_OTLP_*` variables itself, which is the
              // whole reason for depending on the SDK instead of re-implementing
              // its environment contract.
              new OTLPTraceExporter(),
              {
                maxQueueSize: OTEL_MAX_QUEUE,
                scheduledDelayMillis: OTEL_SCHEDULE_DELAY_MS,
                exportTimeoutMillis: OTEL_FLUSH_TIMEOUT_MS,
              },
            ),
          ],
        });
        provider.register();
        runtime = { provider };
        return runtime;
      } catch {
        // A tracer that cannot start is a tracer that does not exist. The turn
        // runs untraced, which is the honest degradation.
        return null;
      }
    })();
  }
  return starting;
}

/**
 * Start a turn's root span, or `null` when export is off.
 *
 * Async because the SDK loads on first use; every caller is already async.
 */
export async function startTurnSpan(options: TurnSpanOptions): Promise<SpanHandle | null> {
  const otel = await ensureProvider();
  if (!otel) return null;
  try {
    const base = options.parent ?? context.active();
    const record = trace.getTracer(INSTRUMENTATION_NAME).startSpan(
      TURN_SPAN_NAME,
      {
        // INTERNAL on every surface on purpose: this span is the agent TURN, and
        // a turn is an internal operation wherever it runs. The inbound HTTP
        // request or messaging event that triggered it is a different span owned
        // by whoever accepted it, and giving each surface its own kind would
        // make the tree differ per surface for no reader's benefit.
        kind: SpanKind.INTERNAL,
        attributes: {
          'nuvira.surface': options.surface,
          ...attrRecord({ 'nuvira.session': options.session, 'nuvira.goal': options.goal }),
        },
      },
      base,
    );
    return new OtelSpanHandle(record, base);
  } catch {
    return null;
  }
}

/**
 * The trace context a child process should continue, or `{}` when there is none.
 *
 * Read from the ACTIVE context, so the loop must have made the tool span active
 * around the tool's execution. An empty object is the honest answer when nothing
 * is active: a child handed a fabricated parent id would corrupt the trace it
 * was supposed to join.
 */
export function childTraceEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!otelExportEnabled(env)) return {};
  const active = trace.getSpan(context.active());
  if (!active) return {};
  if (!trace.isSpanContextValid(active.spanContext())) return {};
  const carrier: Record<string, string> = {};
  try {
    w3cTraceContext.inject(trace.setSpan(context.active(), active), carrier, defaultTextMapSetter);
  } catch {
    return {};
  }
  const injected = carrier[TRACEPARENT_HEADER];
  return injected ? { [TRACEPARENT_ENV]: injected } : {};
}

/**
 * The context a child process resumes from, or `null` when it was not told.
 *
 * A malformed or absent `traceparent` yields null rather than a guess, so a
 * child started by hand simply begins a trace of its own.
 */
export function parentContextFromEnv(env: NodeJS.ProcessEnv = process.env): Context | null {
  const traceparent = env[TRACEPARENT_ENV]?.trim();
  if (!traceparent) return null;
  try {
    const extracted = w3cTraceContext.extract(
      context.active(),
      { [TRACEPARENT_HEADER]: traceparent },
      defaultTextMapGetter,
    );
    return trace.getSpanContext(extracted) ? extracted : null;
  } catch {
    return null;
  }
}

/**
 * Run `fn` with `handle`'s span ACTIVE, so anything below it inherits the right
 * parent — a tool that forks a subagent, or a library that is instrumented.
 *
 * Returns `fn`'s value unchanged, and a null handle simply runs `fn` with no
 * added context: the disabled path costs one boolean.
 */
export function withSpanActive<T>(handle: SpanHandle | null, fn: () => T): T {
  if (!handle) return fn();
  const record = handle instanceof OtelSpanHandle ? handle.spanRecord : null;
  if (!record) return fn();
  try {
    return context.with(trace.setSpan(context.active(), record), fn);
  } catch {
    return fn();
  }
}

/**
 * Ship what is buffered — bounded, and never throwing.
 *
 * Called at the end of a turn rather than relying on the scheduler, so a
 * one-shot process (and a test) can observe the spans it just produced.
 */
export async function flushSpans(): Promise<void> {
  const otel = runtime;
  if (!otel) return;
  try {
    await Promise.race([
      otel.provider.forceFlush(),
      new Promise<void>((resolve) => {
        // A collector that accepted a request but never answered must not hold a
        // turn open. Unref'd, so the timer itself cannot keep a CLI alive.
        const timer = setTimeout(resolve, OTEL_FLUSH_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    // Dropped spans are the correct outcome for an unreachable collector.
  }
}

/**
 * Tear the provider down — only for a process that is about to exit.
 *
 * Deliberately NOT called at the end of every turn: in the dashboard and the
 * gateway the provider has to outlive the turn it just traced. The one-shot
 * surfaces (a `nuvira execute`, a forked subagent) call it so a lingering
 * exporter socket cannot keep the process alive after the answer is printed.
 *
 * IT ALSO RELEASES THE API'S GLOBAL REGISTRATION, and that part is load-bearing
 * rather than tidiness — MEASURED, the hard way. `provider.register()` puts this
 * provider behind the API's process-wide proxy, and a provider that has been
 * shut down still HAS that slot: the next `register()` cannot take it over, so
 * `trace.getTracer()` keeps handing out tracers from the dead provider and every
 * span built afterwards is silently dropped (the spans exist, carry real trace
 * ids, and are never exported — the worst failure shape, because nothing errors
 * and a collector shows an empty trace). Disabling the global provider and the
 * global context manager is what lets tracing start again in the same process,
 * which is exactly what a test harness that points several surfaces at several
 * collectors does.
 */
export async function shutdownSpans(): Promise<void> {
  const otel = runtime;
  if (!otel) return;
  runtime = null;
  starting = null;
  try {
    await otel.provider.shutdown();
  } catch {
    /* best-effort */
  }
  try {
    trace.disable();
    context.disable();
  } catch {
    /* best-effort: an already-disabled global is not an error */
  }
}

/**
 * A one-line notice a surface can print, so a user knows spans are leaving.
 *
 * The no-endpoint case is the one worth printing: export is on, the tree is
 * being built, and every span is being dropped — which looks exactly like a
 * broken collector from the other side.
 */
export function otelNotice(surface: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!otelExportEnabled(env)) return null;
  const endpoint = otelEndpoint(env);
  return endpoint
    ? `🔭 ${surface}: OTLP spans → ${endpoint} (unset ${otelEnableVarName} to stop)`
    : `🔭 ${surface}: span export is ON but no OTEL_EXPORTER_OTLP_ENDPOINT is set — spans are built and dropped. Set the endpoint to ship them.`;
}

/** Surfaces whose notice has already been printed in this process. */
const noticesPrinted = new Set<string>();

/**
 * {@link otelNotice}, but only the first time for a surface.
 *
 * A long-running server prints this once per process rather than once per turn:
 * the destination does not change between turns, and a line per turn is noise
 * nobody can act on. The CLI, with one turn, sees it exactly once either way.
 */
export function otelNoticeOnce(surface: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const notice = otelNotice(surface, env);
  if (!notice || noticesPrinted.has(surface)) return null;
  noticesPrinted.add(surface);
  return notice;
}

/** Running version, read the same best-effort way the debug log reads it. */
let cachedVersion: string | null | undefined;
function agentVersion(): string | null {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { version?: unknown };
    cachedVersion = typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : null;
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}
