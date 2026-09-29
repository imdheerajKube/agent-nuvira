/**
 * WS3 (#25) — the OTLP export seam, unit-tested at its own boundary.
 *
 * The parity suite proves the CAPABILITY (every surface ships the same span tree
 * to a real collector, and the forked child joins the parent's trace). This file
 * proves the CONTRACT, including the rules in the module's header that a driven
 * run cannot observe:
 *
 *   1. opt-in — off unless asked, and `NUVIRA_OTEL=false` means OFF (a user
 *      writing that into an `.env` is not asking for spans to leave the box);
 *   2. it can never break the run — a bad endpoint or an absent one is a notice,
 *      never an exception, and the flush is bounded;
 *   3. it carries what the other sinks carry — an attribute is previewed AND
 *      redacted with the same `scrubSecrets` the gateway log uses, because a span
 *      is shipped to a third party by definition;
 *   4. the trace crosses the fork — the `traceparent` a child resumes from is the
 *      parent's ACTIVE span, and a child handed nothing starts its own trace
 *      rather than being grafted onto one nobody is running.
 *
 * These cases drive a REAL provider against a REAL loopback collector, because
 * the interesting failures (the string timestamps, the sampled bit, the parent
 * id, the global registration) live in the wire format — the part a hand-rolled
 * writer gets subtly wrong, and the reason this module depends on the SDK at all.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { DiagLogLevel, diag } from '@opentelemetry/api';

import {
  DEFAULT_SERVICE_NAME,
  OTEL_ATTR_PREVIEW_CHARS,
  OTEL_BSP_VAR,
  OTEL_FLUSH_TIMEOUT_MS,
  OTEL_MAX_EXPORT_BATCH_SIZE,
  OTEL_MAX_QUEUE,
  OTEL_SCHEDULE_DELAY_MS,
  TRACEPARENT_ENV,
  TURN_SPAN_NAME,
  childTraceEnv,
  flushSpans,
  otelBatchSettings,
  otelEnableVarName,
  otelEndpoint,
  otelExportEnabled,
  otelNotice,
  otelNoticeOnce,
  parentContextFromEnv,
  shutdownSpans,
  startTurnSpan,
  withSpanActive,
} from '../../src/observability/otel.js';

// ─── A loopback OTLP collector ──────────────────────────────────────────────

interface ReceivedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  startTimeUnixNano: unknown;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  events: Array<{ name: string; attributes: Array<{ key: string }> }>;
  status: { code?: number; message?: string };
}

interface Collector {
  url: string;
  spans: ReceivedSpan[];
  resources: Array<Record<string, unknown>>;
  bodies: string[];
  close(): Promise<void>;
}

/** The whole body, so a case can assert the SDK's own encoding, not just fields. */
async function startCollector(): Promise<Collector> {
  const state: Collector = {
    url: '',
    spans: [],
    resources: [],
    bodies: [],
    close: async () => {},
  };
  const server: Server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      state.bodies.push(text);
      const payload = JSON.parse(text || '{}') as {
        resourceSpans?: Array<{
          resource?: { attributes?: Array<{ key: string; value: Record<string, unknown> }> };
          scopeSpans?: Array<{ spans?: ReceivedSpan[] }>;
        }>;
      };
      for (const entry of payload.resourceSpans ?? []) {
        state.resources.push(
          Object.fromEntries((entry.resource?.attributes ?? []).map((a) => [a.key, a.value])),
        );
        for (const scope of entry.scopeSpans ?? []) state.spans.push(...(scope.spans ?? []));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  return state;
}

/** The env keys this module reads, so a case cannot leak into the next one. */
const KEYS = [
  otelEnableVarName,
  'BUFF_OTEL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  TRACEPARENT_ENV,
  ...Object.values(OTEL_BSP_VAR),
] as const;

const previous = new Map<string, string | undefined>(KEYS.map((k) => [k, process.env[k]]));
const collectors: Collector[] = [];

function setEnv(values: Record<string, string | undefined>): void {
  for (const key of KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
}

/** Turn export on and point it at a fresh collector. */
async function exportToCollector(extra: Record<string, string> = {}): Promise<Collector> {
  const collector = await startCollector();
  collectors.push(collector);
  setEnv({ [otelEnableVarName]: '1', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: collector.url, ...extra });
  return collector;
}

afterEach(async () => {
  await shutdownSpans();
  diag.disable();
  for (const key of KEYS) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (collectors.length > 0) await collectors.pop()!.close();
});

// ─── 1. Off unless asked ────────────────────────────────────────────────────

describe('WS3 OTLP export — opt-in', () => {
  it('is OFF when the env var is unset, and OFF for the falsey words a user writes', () => {
    expect(otelExportEnabled({})).toBe(false);
    for (const on of ['1', 'true', 'TRUE', 'yes', 'on', 'anything']) {
      expect(otelExportEnabled({ [otelEnableVarName]: on }), on).toBe(true);
    }
    // `NUVIRA_OTEL=false` in an `.env` means off, not "a non-empty string".
    for (const off of ['0', 'false', 'FALSE', 'off', 'no', '   ']) {
      expect(otelExportEnabled({ [otelEnableVarName]: off }), off).toBe(false);
    }
    expect(otelExportEnabled({ BUFF_OTEL: '1' })).toBe(true);
  });

  it('builds no span and ships nothing while it is off', async () => {
    // The gate is not merely decorative: with export off `startTurnSpan` returns
    // null, so no span object exists and the SDK is never imported.
    setEnv({});
    expect(await startTurnSpan({ surface: 'cli-chat', goal: 'off' })).toBeNull();
    // And the flush/shutdown paths are no-ops rather than throws, which is what
    // lets every surface call them unconditionally.
    await flushSpans();
    await shutdownSpans();
  });

  it('resolves the endpoint the way the OTLP spec does, and says when there is none', () => {
    // The per-signal variable is used verbatim; the generic one gets the path.
    expect(otelEndpoint({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://h:4318/v1/traces' })).toBe(
      'http://h:4318/v1/traces',
    );
    expect(otelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://h:4318' })).toBe(
      'http://h:4318/v1/traces',
    );
    expect(otelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://h:4318///' })).toBe(
      'http://h:4318/v1/traces',
    );
    expect(otelEndpoint({})).toBeNull();

    // A notice names where spans are going … and says so loudly when export is on
    // with no destination, because every span is being built and dropped — which
    // looks exactly like a broken collector from the other side.
    expect(otelNotice('cli-chat', {})).toBeNull();
    const live = otelNotice('cli-chat', {
      [otelEnableVarName]: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://h:4318',
    });
    expect(live).toContain('http://h:4318/v1/traces');
    // … and names the switch a user turns it back OFF with.
    expect(live).toContain(otelEnableVarName);
    const orphan = otelNotice('cli-chat', { [otelEnableVarName]: '1' });
    expect(orphan).toContain('no OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(orphan).toContain('dropped');
  });

  it('prints its notice once per surface, however many turns a server runs', () => {
    const env = { [otelEnableVarName]: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://h:4318' };
    expect(otelNoticeOnce('dashboard-chat', env)).not.toBeNull();
    expect(otelNoticeOnce('dashboard-chat', env)).toBeNull();
    // A different surface is a different fact, so it still gets its own line.
    expect(otelNoticeOnce('gateway-chat', env)).not.toBeNull();
    expect(otelNoticeOnce('cli-chat', {})).toBeNull();
  });
});

// ─── 2. The tree, as a collector receives it ────────────────────────────────

describe('WS3 OTLP export — the standard batch settings', () => {
  it('resolves the OTEL_BSP_* variables, falling back to this module`s defaults', () => {
    // The SDK's own fallbacks apply only to a config key left UNDEFINED, and this
    // module passes defaults for all of them — so before this resolution existed,
    // `OTEL_BSP_EXPORT_TIMEOUT=30000` was silently ignored. One precedence rule:
    // the environment wins, the module's default fills the gap.
    expect(otelBatchSettings({})).toEqual({
      maxQueueSize: OTEL_MAX_QUEUE,
      scheduledDelayMillis: OTEL_SCHEDULE_DELAY_MS,
      maxExportBatchSize: OTEL_MAX_EXPORT_BATCH_SIZE,
      exportTimeoutMillis: OTEL_FLUSH_TIMEOUT_MS,
    });

    expect(
      otelBatchSettings({
        [OTEL_BSP_VAR.maxQueueSize]: '99',
        [OTEL_BSP_VAR.scheduledDelayMillis]: '250',
        [OTEL_BSP_VAR.maxExportBatchSize]: '7',
        [OTEL_BSP_VAR.exportTimeoutMillis]: '60000',
      }),
    ).toEqual({
      maxQueueSize: 99,
      scheduledDelayMillis: 250,
      maxExportBatchSize: 7,
      exportTimeoutMillis: 60_000,
    });

    // A value that is set but unreadable is not honoured: a queue of zero and a
    // negative delay are both worse than the default, and neither is what the
    // user asked for.
    for (const bad of ['0', '-1', 'abc', '1.5', '', '   ', 'Infinity']) {
      const resolved = otelBatchSettings({ [OTEL_BSP_VAR.maxQueueSize]: bad });
      expect(resolved.maxQueueSize, bad).toBe(OTEL_MAX_QUEUE);
    }
  });

  it('hands those settings to the SDK, not merely to itself', async () => {
    // MEASURED rather than assumed: a queue of 1 makes the SDK DROP a span, and
    // it says so through `diag` — so this asserts the variable reached the
    // processor instead of stopping at this module's own function.
    const warnings: string[] = [];
    diag.setLogger(
      {
        error: (m) => warnings.push(String(m)),
        warn: (m) => warnings.push(String(m)),
        info: () => {},
        debug: () => {},
        verbose: () => {},
      },
      DiagLogLevel.WARN,
      true,
    );
    await exportToCollector({ [OTEL_BSP_VAR.maxQueueSize]: '1' });
    const turn = await startTurnSpan({ surface: 'cli-chat', goal: 'overflow the queue' });
    // One span is buffered; the next few are dropped, and the SDK reports the
    // count on the first add after a drop.
    turn!.child('nuvira.tool.a').end({ ok: true });
    turn!.child('nuvira.tool.b').end({ ok: true });
    turn!.child('nuvira.tool.c').end({ ok: true });
    turn!.end({ ok: true });
    await flushSpans();

    expect(warnings.join('\n')).toContain('maxQueueSize');
  });

  it('bounds the flush by the export timeout the operator set', async () => {
    // A collector that ACCEPTS the request and never answers — the case the bound
    // exists for, and the one a timing assertion can actually discriminate: with
    // `OTEL_BSP_EXPORT_TIMEOUT=200` the flush must return in well under the
    // module's 3s default. If the variable never reached the flush, this fails.
    const sockets: Array<import('node:net').Socket> = [];
    const silent = createTcpServer((socket) => {
      // Accept, and never answer. The sockets are kept so the teardown can
      // destroy them rather than waiting out the exporter's own 10s timeout.
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as AddressInfo).port;
    try {
      setEnv({
        [otelEnableVarName]: '1',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
        [OTEL_BSP_VAR.exportTimeoutMillis]: '200',
      });
      const turn = await startTurnSpan({ surface: 'cli-chat', goal: 'slow collector' });
      expect(turn).not.toBeNull();
      turn!.end({ ok: true });
      const started = Date.now();
      await flushSpans();
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      for (const socket of sockets) socket.destroy();
      silent.close();
      silent.closeAllConnections?.();
      await shutdownSpans();
    }
  }, 30_000);
});

describe('WS3 OTLP export — the tree a collector receives', () => {
  it('sends a turn span with one child per tool call, one trace, and the SDK-encoded fields', async () => {
    const collector = await exportToCollector();
    const turn = await startTurnSpan({ surface: 'cli-chat', session: 's-1', goal: 'do the thing' });
    expect(turn).not.toBeNull();
    turn!.attr('nuvira.toolCalls', 2);
    turn!.event('nuvira.finding', { 'nuvira.verdict': 'CONFIRMED' });
    const first = turn!.child('nuvira.tool.read_file', { 'nuvira.tool': 'read_file' });
    first.end({ ok: true });
    turn!.child('nuvira.tool.list_dir').end({ ok: false, message: 'no such directory' });
    turn!.end({ ok: true });
    await flushSpans();

    const names = collector.spans.map((s) => s.name).sort();
    expect(names).toEqual(['nuvira.tool.list_dir', 'nuvira.tool.read_file', TURN_SPAN_NAME]);

    const root = collector.spans.find((s) => s.name === TURN_SPAN_NAME)!;
    expect(root.parentSpanId === '' || root.parentSpanId === undefined).toBe(true);
    // One trace, and each tool child really hangs off the turn.
    expect(new Set(collector.spans.map((s) => s.traceId)).size).toBe(1);
    for (const span of collector.spans.filter((s) => s.name !== TURN_SPAN_NAME)) {
      expect(span.parentSpanId, `${span.name} is not a child of the turn`).toBe(root.spanId);
    }
    // The turn's own identity, as the surface set it.
    const attrs = Object.fromEntries(root.attributes.map((a) => [a.key, a.value]));
    expect(attrs['nuvira.surface']).toEqual({ stringValue: 'cli-chat' });
    expect(attrs['nuvira.session']).toEqual({ stringValue: 's-1' });
    expect(attrs['nuvira.goal']).toEqual({ stringValue: 'do the thing' });
    expect(attrs['nuvira.toolCalls']).toEqual({ intValue: 2 });
    // A finding is an EVENT, not a span: it has no duration.
    expect(root.events.map((e) => e.name)).toContain('nuvira.finding');
    expect(collector.spans.map((s) => s.name)).not.toContain('nuvira.finding');
    // A failed child is a RED span rather than an absent one.
    const failed = collector.spans.find((s) => s.name === 'nuvira.tool.list_dir')!;
    expect(failed.status.code).toBe(2);
    expect(failed.status.message).toBe('no such directory');

    // The SDK's own encoding, which is the reason for depending on it: the
    // timestamp is a 64-bit value carried as a STRING (JSON cannot hold it) and
    // the resource names the service.
    expect(typeof root.startTimeUnixNano).toBe('string');
    expect(collector.resources[0]?.['service.name']).toEqual({ stringValue: DEFAULT_SERVICE_NAME });
  });

  it('previews and redacts attributes, because a span leaves the machine', async () => {
    const collector = await exportToCollector();
    const turn = await startTurnSpan({ surface: 'cli-chat', goal: 'x' });
    turn!.attr('nuvira.key', 'gsk_abcdefghijklmnopqrstuvwxyz');
    turn!.attr('nuvira.long', 'z'.repeat(OTEL_ATTR_PREVIEW_CHARS * 3));
    turn!.attr('circular', (() => { const o: Record<string, unknown> = {}; o.self = o; return o; })());
    turn!.end({ ok: true });
    await flushSpans();

    const body = collector.bodies.join('\n');
    expect(body).not.toContain('gsk_abcdefghijklmnopqrstuvwxyz');
    expect(body).toContain('gsk_***');

    const attrs = Object.fromEntries(
      (collector.spans[0]?.attributes ?? []).map((a) => [a.key, a.value.stringValue as string]),
    );
    // Cut, and marked as cut — an attribute that silently vanishes is a
    // debugging hole that only shows up when someone needs it.
    expect(attrs['nuvira.long']?.length).toBeLessThanOrEqual(OTEL_ATTR_PREVIEW_CHARS);
    expect(attrs['nuvira.long']?.endsWith('…')).toBe(true);
    // A structure that cannot be rendered is a marker, never a throw.
    expect(attrs['circular']).toBeTruthy();
  });

  it('bounds the flush, and survives a collector that is not there', async () => {
    // An unreachable endpoint costs a turn at most the timeout, once, and never an
    // exception: a tracer that can fail the turn it observes is worse than none.
    setEnv({ [otelEnableVarName]: '1', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:9/v1/traces' });
    const turn = await startTurnSpan({ surface: 'cli-chat', goal: 'unreachable' });
    expect(turn).not.toBeNull();
    turn!.end({ ok: true });
    await expect(flushSpans()).resolves.toBeUndefined();
    await expect(shutdownSpans()).resolves.toBeUndefined();
  });
});

// ─── 3. Across the fork ─────────────────────────────────────────────────────

describe('WS3 OTLP export — the trace context across the fork', () => {
  it('hands a child the ACTIVE span, and the child resumes from it', async () => {
    let readEnv: Record<string, string> = {};
    let parentTraceId = '';
    let toolSpanId = '';

    await exportToCollector();
    const turn = await startTurnSpan({ surface: 'cli-chat', goal: 'spawn' });
    parentTraceId = turn!.traceId;
    const toolSpan = turn!.child('nuvira.tool.subagent');

    // `withSpanActive` is what the loop uses around a tool's execution, so this is
    // the same context the spawner reads when it forks.
    withSpanActive(toolSpan, () => {
      readEnv = childTraceEnv();
    });

    toolSpanId = toolSpan.spanId;
    expect(readEnv[TRACEPARENT_ENV]).toBeDefined();
    expect(readEnv[TRACEPARENT_ENV]).toBe(`00-${parentTraceId}-${toolSpanId}-01`);

    // In the child: the header becomes a context, and a turn span started under it
    // belongs to the SAME trace, with the tool span as its remote parent.
    const childContext = parentContextFromEnv({ [TRACEPARENT_ENV]: readEnv[TRACEPARENT_ENV]! });
    expect(childContext).not.toBeNull();
    const childTurn = await startTurnSpan({ surface: 'subagent', goal: 'spawn', parent: childContext });
    expect(childTurn!.traceId).toBe(parentTraceId);
    expect(childTurn!.spanId).not.toBe(toolSpanId);

    childTurn!.end({ ok: true });
    toolSpan.end({ ok: true });
    turn!.end({ ok: true });
    await flushSpans();
  });

  it('hands a child NOTHING when the parent is not tracing that context', async () => {
    // The honest answer when nothing is active: a child handed a fabricated parent
    // id would corrupt the trace it was supposed to join.
    setEnv({ [otelEnableVarName]: '1', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:9/v1/traces' });
    await expect(startTurnSpan({ surface: 'cli-chat', goal: 'x' })).resolves.not.toBeNull();
    expect(childTraceEnv()).toEqual({});
    // And with export off entirely, so is the header.
    setEnv({});
    expect(childTraceEnv()).toEqual({});
  });

  it('treats an absent or malformed traceparent as "no parent", never as a guess', () => {
    expect(parentContextFromEnv({})).toBeNull();
    expect(parentContextFromEnv({ [TRACEPARENT_ENV]: 'not-a-traceparent' })).toBeNull();
    expect(parentContextFromEnv({ [TRACEPARENT_ENV]: '   ' })).toBeNull();
    expect(
      parentContextFromEnv({
        [TRACEPARENT_ENV]: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
      }),
    ).not.toBeNull();
  });

  it('runs a null handle through untouched, so the disabled path costs one boolean', async () => {
    setEnv({});
    expect(withSpanActive(null, () => 'ran')).toBe('ran');
    expect(await startTurnSpan({ surface: 'cli-chat', goal: 'x' })).toBeNull();
  });

  it('can start tracing again after a shutdown in the same process', async () => {
    // MEASURED, and the reason `shutdownSpans` releases the API's global
    // registration: a provider that has been shut down still occupies the global
    // slot, so the next `register()` cannot take it over and every span built
    // afterwards is silently dropped — the spans exist and carry real trace ids,
    // and the collector sees nothing. The parity harness points several surfaces
    // at several collectors in one process, so this is load-bearing there too.
    const first = await exportToCollector();
    const before = await startTurnSpan({ surface: 'cli-chat', goal: 'first' });
    before!.end({ ok: true });
    await flushSpans();
    expect(first.spans.map((s) => s.name)).toContain(TURN_SPAN_NAME);
    await shutdownSpans();

    const second = await exportToCollector();
    const after = await startTurnSpan({ surface: 'cli-chat', goal: 'second' });
    expect(after).not.toBeNull();
    after!.end({ ok: true });
    await flushSpans();
    expect(second.spans.map((s) => s.name)).toContain(TURN_SPAN_NAME);
  });
});
