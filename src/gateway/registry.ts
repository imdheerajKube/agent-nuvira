/**
 * J1 — Gateway registry (Hermes `channel_directory` + `gateway` bridge).
 *
 * `GatewayRegistry` is the single choke point that turns an inbound channel
 * message into an agent action and streams the pipeline's board events back to
 * the channel:
 *
 *   channel message "fix the failing test"
 *     → parseRequestSync (C3 — intent + confidence + action)
 *     → high-confidence pipeline intent → runPipelineTool (shared H1 core)
 *     → reply with the summary + key details to the ORIGINATING channel
 *     → every ORCHESTRATOR / EXEC / CRON board event also streams as a
 *       compact status line (E2 JSON-events → channel).
 *
 * Reuses the SAME pipeline core as `buff chat` / `buff execute` — no parallel
 * agent path. All adapters opt-in via env tokens (channel-directory.ts).
 */

import { runPipelineTool } from '../tools/pipeline-tool.js';
import { parseRequestSync } from '../nlu/parser.js';
import { getEventBus, EventNames } from '../observability/event-bus.js';
import { ConfigManager } from '../config/manager.js';
import {
  ChannelDirectory,
  type ChannelRef,
  type Platform,
} from './channel-directory.js';
import type { ChannelAdapter, InboundMessage } from './adapters.js';
import { DeliveryLedger, type DeliveryEntry } from './delivery.js';
import { logger } from '../utils/logger.js';

/** How often the running gateway drains due delivery entries (ms). */
const DELIVERY_DRAIN_INTERVAL_MS = 30_000;

// ─── Reply formatting ───────────────────────────────────────────────────────

/** Compact one-line status from a board event (E2 events → channel text). */
export function eventToStatusLine(event: string, data: any): string | null {
  const d = data ?? {};
  switch (event) {
    case EventNames.ORCHESTRATOR_PIPELINE_STARTED:
      return `▶️ pipeline started${d.goal ? ` — ${String(d.goal).slice(0, 80)}` : ''}`;
    case EventNames.ORCHESTRATOR_PIPELINE_COMPLETED:
      return d.success ? `✅ pipeline complete` : `❌ pipeline failed`;
    case EventNames.ORCHESTRATOR_PLAN_READY: {
      const steps = Array.isArray(d.taskPlan) ? d.taskPlan.length : d.steps;
      return steps ? `📋 plan: ${steps} step${steps === 1 ? '' : 's'}` : null;
    }
    case EventNames.ORCHESTRATOR_TASK_STARTED:
      return d.agentType || d.agent ? `🔄 [${d.agentType ?? d.agent}] ${String(d.description ?? '').slice(0, 70)}` : null;
    case EventNames.ORCHESTRATOR_AGENT_UPDATE:
      return d.message ? `🧠 ${String(d.message).slice(0, 90)}` : null;
    case EventNames.EXEC_SHELL_START:
      return d.command ? `$ ${String(d.command).slice(0, 90)}` : null;
    case EventNames.CRON_RESULT:
      return d.name ? `⏰ cron '${d.name}' → ${String(d.output ?? '').slice(0, 80)}` : null;
    default:
      return null;
  }
}

// ─── Registry ───────────────────────────────────────────────────────────────

export interface GatewayRegistryOptions {
  /** Auto-subscribe to the event bus and stream board events to channels (default true). */
  streamEvents?: boolean;
  /** Only reply for pipeline intents; all other messages get a help line (default false). */
  pipelineOnly?: boolean;
  /** Config dir for the delivery ledger (tests pass a temp dir; default ~/.buff). */
  deliveryConfigDir?: string;
  /**
   * Authorized channels allowed to trigger the pipeline ("platform:channelId"
   * entries, comma-separated in BUFF_GATEWAY_ALLOW_IDS). Empty = every channel
   * may trigger. Non-authorized channels get a polite refusal instead.
   */
  allowIds?: string[];
}

export class GatewayRegistry {
  readonly directory: ChannelDirectory;
  /** I2 — guaranteed-delivery ledger for failed sends (Hermes delivery.py parity). */
  readonly delivery: DeliveryLedger;
  private adapters = new Map<Platform, ChannelAdapter>();
  private configManager: ConfigManager;
  private options: Required<Omit<GatewayRegistryOptions, 'deliveryConfigDir'>>;
  private unsubscribe: (() => void) | null = null;
  private deliveryTimer: NodeJS.Timeout | null = null;
  /** Channel the last inbound message came from (for event streaming). */
  private activeChannel: ChannelRef | null = null;
  /** Serializes inbound pipeline runs so board events stream to the RIGHT channel. */
  private runChain: Promise<unknown> = Promise.resolve();
  /** Serializes delivery drains — concurrent timer/CLI/opportunistic drains
   *  must never read the same pending entry twice (double-send + attempt
   *  double-count would prematurely fail entries). */
  private drainChain: Promise<unknown> = Promise.resolve();
  private started = false;

  constructor(options: GatewayRegistryOptions = {}, configManager?: ConfigManager) {
    const allowFromEnv = (process.env.BUFF_GATEWAY_ALLOW_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.options = {
      streamEvents: options.streamEvents ?? true,
      pipelineOnly: options.pipelineOnly ?? false,
      allowIds: options.allowIds ?? allowFromEnv,
    };
    this.directory = new ChannelDirectory();
    this.delivery = new DeliveryLedger(options.deliveryConfigDir);
    this.configManager = configManager ?? new ConfigManager();
  }

  /** Register an adapter (idempotent per platform). */
  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  /** All registered adapters. */
  adaptersList(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  /** Whether any adapter is configured with a token. */
  hasConfiguredAdapter(): boolean {
    return [...this.adapters.values()].some((a) => a.configured);
  }

  /** Send a text message to a channel target (alias or platform:channelId). */
  async send(target: string, text: string): Promise<boolean> {
    const ref = this.directory.resolve(target);
    if (!ref) {
      logger.warn(`gateway: unknown channel target '${target}'`);
      return false;
    }
    return this.sendToRef(ref, text, target);
  }

  /** Send to an explicit channel ref. I2: a failed send is ledgered for retry. */
  async sendToRef(ref: ChannelRef, text: string, target?: string): Promise<boolean> {
    const adapter = this.adapters.get(ref.platform);
    if (!adapter || !adapter.configured) {
      logger.warn(`gateway: adapter for '${ref.platform}' not configured`);
      return false;
    }
    const ok = await adapter.send(ref.channelId, text);
    if (!ok) {
      logger.warn(`gateway: send to ${ref.platform}:${ref.channelId} failed — enqueued for delivery retry`);
      // Persist for retry (survives this process) — the next drain (or the
      // next `gateway start`) delivers it. Keep the HUMAN target (alias)
      // when the caller had one, for readable ledger lines.
      this.delivery.enqueue({
        target: target ?? `${ref.platform}:${ref.channelId}`,
        ref,
        text,
      });
      return false;
    }
    // Opportunistic flush: a successful send often means the network is back
    // — drain any due pending entries for THIS platform right away (serialized
    // on the drain chain so it never overlaps the timer/CLI drains; awaits so
    // the caller's next send sees the ledger state settled). Never throws.
    await this.drainForPlatform(ref.platform);
    return true;
  }

  /**
   * Attempt all due pending delivery entries through the registered adapters.
   * Returns the counters (public so the CLI `buff gateway delivery --flush`
   * and tests can drive it directly). Serialized on the drain chain.
   */
  async drainDelivery(): Promise<{ processed: number; sent: number; failed: number }> {
    const run = this.drainChain.then(() => this.delivery.processDue((entry) => this.sendEntry(entry)));
    this.drainChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** One ledger entry send through the registered adapter (shared by drains). */
  private async sendEntry(entry: DeliveryEntry): Promise<{ ok: boolean; error?: string }> {
    const adapter = this.adapters.get(entry.platform);
    if (!adapter || !adapter.configured) {
      return { ok: false, error: `adapter for '${entry.platform}' not configured` };
    }
    const ok = await adapter.send(entry.channelId, entry.text);
    return ok ? { ok: true } : { ok: false, error: 'send failed' };
  }

  /** Drain due entries for one platform only (opportunistic flush, serialized). */
  private drainForPlatform(platform: Platform): Promise<void> {
    const run = this.drainChain.then(async () => {
      const due = this.delivery.pendingDue().filter((e) => e.platform === platform);
      for (const entry of due) {
        await this.delivery.recordAttempt(entry.id, await this.sendEntry(entry));
      }
      this.delivery.prune();
    });
    this.drainChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Handle an inbound channel message: parse → dispatch → reply.
   * Non-pipeline messages reply with a short intent/help line (unless
   * pipelineOnly). Never throws — a failed pipeline replies with the error.
   * Pipeline runs are SERIALIZED so board events stream to the originating
   * channel (a second message while a run is active queues behind it).
   */
  async handleInbound(msg: InboundMessage): Promise<string> {
    const ref: ChannelRef = { platform: msg.platform, channelId: msg.channelId };
    const replyTo = async (text: string): Promise<void> => {
      await this.sendToRef(ref, text);
    };

    const parsed = parseRequestSync(msg.text);

    // Non-pipeline request → help/understood line (or pipelineOnly silence).
    // Deliberately does NOT touch activeChannel: a chat message arriving while
    // a pipeline run is in flight must not redirect the run's board events.
    if (parsed.action.run !== 'pipeline') {
      const line = `🤖 I understood: **${parsed.intent}** (${(parsed.confidence * 100).toFixed(0)}% confidence)\nTry a task like "fix the failing test" or "explain this repo" — or run \`buff gateway status\` for help.`;
      if (!this.options.pipelineOnly) await replyTo(line);
      return line;
    }

    // Pipeline intent — gate on the allow-list, then run serialized.
    if (!this.isAllowed(ref)) {
      const line = '⛔ This channel is not authorized to trigger the agent pipeline. Add it to BUFF_GATEWAY_ALLOW_IDS (platform:channelId).';
      await replyTo(line);
      return line;
    }

    await replyTo(`✅ Got it — running the ${parsed.action.name} pipeline…`);
    const run = this.runChain.then(async (): Promise<string> => {
      // Only THIS run's events stream — set activeChannel inside the chain.
      this.activeChannel = ref;
      const result = await runPipelineTool(msg.text, this.configManager, {
        board: false,
        mode: parsed.mode,
        taskIntentHint: parsed.action.taskIntent,
      });
      const headline = result.success ? '✅ Done' : '❌ Failed';
      const lines = [`${headline} — ${result.summary}`];
      if (result.details && result.details.length > 0) {
        for (const line of result.details.slice(0, 6)) lines.push(`• ${line}`);
      }
      const reply = lines.join('\n');
      await replyTo(reply);
      return reply;
    });
    this.runChain = run.catch(() => undefined);
    return run;
  }

  /** Allow-list check: no allowIds configured = everyone; else exact platform:channelId. */
  private isAllowed(ref: ChannelRef): boolean {
    if (!this.options.allowIds || this.options.allowIds.length === 0) return true;
    return this.options.allowIds.includes(`${ref.platform}:${ref.channelId}`);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Start all registered adapters + the event-bus stream. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const onMessage = async (msg: InboundMessage): Promise<void> => {
      try {
        await this.handleInbound(msg);
      } catch (err) {
        const text = `⚠️ gateway error: ${err instanceof Error ? err.message : String(err)}`;
        logger.error(text);
        await this.sendToRef({ platform: msg.platform, channelId: msg.channelId }, text);
      }
    };

    for (const adapter of this.adapters.values()) {
      if (!adapter.configured) continue;
      try {
        await adapter.start(onMessage);
        logger.info(`gateway: ${adapter.describe()} started`);
      } catch (err) {
        logger.error(`gateway: failed to start ${adapter.describe()}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (this.options.streamEvents) {
      this.unsubscribe = getEventBus().on('*', (record) => {
        if (!this.activeChannel) return;
        const line = eventToStatusLine(record.event, record.data);
        if (line) void this.sendToRef(this.activeChannel, line);
      });
    }

    // I2: periodic drain of the delivery ledger (failed sends retry with
    // backoff while the gateway runs).
    this.deliveryTimer = setInterval(() => {
      void this.drainDelivery().catch(() => undefined);
    }, DELIVERY_DRAIN_INTERVAL_MS);
  }

  /** Stop adapters + unsubscribe + stop the delivery drain. Idempotent. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.deliveryTimer) {
      clearInterval(this.deliveryTimer);
      this.deliveryTimer = null;
    }
    for (const adapter of this.adapters.values()) {
      try { await adapter.stop(); } catch { /* best-effort */ }
    }
  }
}
