/**
 * J1 — Gateway registry (`channel_directory` + `gateway` bridge).
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
 * Reuses the SAME pipeline core as `nuvira chat` / `nuvira execute` — no parallel
 * agent path. All adapters opt-in via env tokens (channel-directory.ts).
 */

import { runPipelineTool } from '../tools/pipeline-tool.js';
import { envBuff } from '../config/paths';
import { parseRequestSync } from '../nlu/parser.js';
import { getEventBus, EventNames } from '../observability/event-bus.js';
import { ConfigManager } from '../config/manager.js';
import {
  ChannelDirectory,
  PLATFORM_ENV_VARS,
  PLATFORM_LABELS,
  type ChannelPolicy,
  type ChannelRef,
  type Platform,
  type PolicyMap,
} from './channel-directory.js';
import type { ChannelAdapter, InboundMessage, MediaPayload } from './adapters.js';
import { DeliveryLedger, type DeliveryEntry } from './delivery.js';
import { InboxLedger, type InboundDisposition } from './inbox.js';
import { GatewayChatStore, CHAT_HISTORY_MAX_PAIRS } from './chat-store.js';
import { logger } from '../utils/logger.js';

/** How often the running gateway drains due delivery entries (ms). */
const DELIVERY_DRAIN_INTERVAL_MS = 30_000;

// ─── Response cleanup ──────────────────────────────────────────────────────

/**
 * Strip leaked internal reasoning, planning blocks, and meta-commentary from
 * a gateway chat response. The model sometimes emits its chain-of-thought
 * (draft planning, tool deliberation, self-correction) as visible text instead
 * of keeping it internal. This function removes the noise while preserving
 * the actual deliverable (poem, answer, code, etc.).
 *
 * Patterns stripped:
 *  - Planning blocks: lines like "* User: Divya", "* Tone: Loving", "* Stanza 1:..."
 *  - Drafting/action markers: "* Drafting:", "* Acknowledge:", "* Answer:", "* Tool:"
 *  - Self-correction: "Correction: ...", "Self-Correction on..."
 *  - Deliberation: "Wait, the prompt says...", "Actually, looking at..."
 *  - Preamble: "I would be happy to..." / "I'd be happy to..." at the start
 *  - Response format planning: "1. Text response", "2. gateway_send", etc.
 */
export function stripGatewayReasoning(text: string): string {
  if (!text) return text;
  let t = text;

  // ── Phase 1: Strip known planning/reasoning patterns ──

  // 1. Strip planning block lines starting with "* ".
  //    Catches: "* User:", "* Tone:", "* Constraints:", "* Direct answer...",
  //    "* Drafting:", "* Acknowledge:", "* Tool:", "* No preamble...",
  //    "* End with suggest_followups", "* Let's refine:", etc.
  t = t.replace(/^\s*\*+\s+(?:User|Subjects?|Occasion|Goal|Delivery|Tone|Key elements?|Stanza|Drafting|Acknowledge|Answer|Tool|Follow-?ups?|Constraints?|Direct|No\s|End\s|Let'?s|Since\s|Wait,|Actually,|Correction|Self-Correction|Looking\s|Given\s|The\s+(?:bridge|system|prompt|target|user)|Since\s+the|My\s+(?:text|plan|approach)|However,|But\s+the|Let\s+me|Let's|Really,|If\s+I|The\s+most|To\s+be\s+safe|I\s+am\s+(?:acting|communicating|the)|I\s+need\s+to|One\s+more\s+thing|I\s+am\s+communicating|Since\s+I\s+am|Actually\s+the|Since\s+I\s+can't|I\s+don't|I\s+should\s+probably|I\s+will\s+just|I\s+should\s+(?:check|send|use|provide|be|do)|I\s+will\s+(?:send|provide)|Let\s+me\s+refine|Appropriate|Appropriate\s+for).*$/gim, '');

  // 1b. Strip planning block lines starting with "* " followed by action verbs
  //     (numbered or unnumbered plan items). Catches patterns like:
  //     "*   Plan:", "*   Here's the essay:", "*   That looks good"
  t = t.replace(/^\s*\*+\s+(?:Plan|Here'?s\s+(?:the|a)|That\s+(?:looks?|should|works?)|This\s+(?:is|should)|Now\s+(?:I|let)|So\s+(?:I|let)|I'll\s+now|I\s+will\s+now|Let\s+me\s+(?:now|write|draft)).*$/gim, '');

  // 2. Strip self-evaluation numbered lists.
  //    Catches: "1. Direct answer? Yes.", "2. No preamble? Yes.", "That looks good..."
  t = t.replace(/^\s*\d+\.\s+(?:Direct\s+answer|No\s+(?:preamble|internal|bullet|narration|tool)|End\s+with|Preamble|Internal\s+reasoning|Tool\s+usage|Bullet-point|Narration|Gateway_send).*$/gim, '');
  // 2b. Strip self-evaluation sentences ("That looks good", "That should work").
  t = t.replace(/^\s*(?:That\s+(?:looks?|should|works?)|This\s+(?:is|should\s+work)|Looks\s+good|Seems\s+(?:good|correct|right)|Perfect|Great|Done).*/gim, '');

  // 3. Strip action-planning numbered lists.
  //    Catches: "1. Text response...", "2. gateway_send...", "Plan:\n1. Start..."
  t = t.replace(/^\s*\d+\.\s+(?:Text\s+response|gateway_send|suggest_followups|Provide\s+the|Acknowledge|Answer\s*:|Tool\s*:|The\s+response|Start\s+with|Describe|Talk\s+about|Mention|Speed|History|Past\s+uses|Intelligence|Baby|Loyalty|Colors|Diet|Physical).*$/gim, '');
  // 3b. Strip standalone "Plan:" lines and "Here's the ...:" markers.
  t = t.replace(/^\s*(?:Plan\s*:|Here'?s\s+(?:the|a)\s+.*:|Let's\s+(?:begin|start|go|write)|I'?ll\s+(?:now|write|draft|create)).*$/gim, '');

  // ── Phase 2: Strip multi-line deliberation blocks ──

  // 4. Strip response-format meta-planning paragraphs.
  //    Multi-line blocks discussing how to format/structure the response.
  t = t.replace(/(?:^|\n)\s*(?:Since\s+I\s+am\s+communicating|I\s+am\s+acting\s+as\s+a\s+bridge|The\s+user\s+is\s+communicating|I\s+don't\s+have\s+the\s+previous|I\s+need\s+to\s+find\s+out|Actually,\s+the\s+most\s+logical|Let's\s+refine:|Wait,\s+the\s+prompt\s+says|Actually,\s+looking\s+at|Correction:\s+The\s+user|Self-Correction\s+on|Since\s+this\s+is\s+a\s+request|The\s+bridge\s+usually|Looking\s+at\s+the\s+\[Origin\]|Given\s+the\s+prompt|However,\s+the|But\s+the\s+bridge|Actually,\s+I'll|Let\s+me\s+refine|I'll\s+just\s+provide|I'll\s+do\s+both|I\s+will\s+provide|I\s+should\s+use|I\s+am\s+(?:acting|communicating)|Since\s+I\s+(?:am|can't|don't)|One\s+more\s+thing|I\s+need\s+to|I\s+should\s+probably|I\s+will\s+just|Let\s+me\s+(?:check|see)|Wait,\s+if\s+I|Let's\s+refine)[\s\S]*?(?=\n\s*(?:[A-Z\d\*]|$))/g, '');

  // 5. Strip preamble at the very start of the response.
  t = t.replace(/^\s*(?:I\s+(?:would|'d|will)\s+be\s+happy\s+to\s+).{0,200}?\n\n/s, '');

  // 6. Strip tool-deliberation paragraphs about gateway_send usage.
  t = t.replace(/(?:^|\n)\s*(?:Wait,\s+the\s+prompt\s+says\s+"first\s+briefly|Since\s+this\s+is\s+a\s+request\s+to\s+write|Actually,\s+looking\s+at\s+the\s+\[Origin\]|I\s+should\s+use\s+gateway_send|Correction:\s+The\s+user\s+said|Self-Correction\s+on\s+gateway_send|Let's\s+refine\s+the|Wait,\s+if\s+I\s+call\s+gateway_send|Actually,\s+I'll\s+just\s+provide)[\s\S]*?(?=\n\s*(?:\d+\.|[A-Z]|$))/g, '');

  // ── Phase 3: Cleanup ──

  // 7. Collapse runs of 3+ blank lines into 2.
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

/**
 * Does a request ask to DELIVER something to someone (send/message/email/text
 * … to/for a recipient)? Used to route pipeline intents that ALSO ask for
 * delivery through the agent loop (which can compose build/repair →
 * gateway_send) instead of the bare orchestrator (which cannot deliver).
 */
export function hasDeliveryAsk(text: string): boolean {
  // A delivery verb + a recipient marker (to/for a person/group, or a direct
  // pronoun recipient: "email me the report"). "add auth to the API" has "to"
  // but no delivery verb → stays a pure pipeline task; "implement the send
  // feature" has the verb but no recipient → also stays pipeline.
  return /\b(send|message|email|text|notify|deliver|share|forward|post|dm)\b/i.test(text) &&
    /\b(to|for|me|us|them|him|her)\b/i.test(text);
}

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

// ─── P1 policy helpers ──────────────────────────────────────────────────────

/**
 * Normalize a WhatsApp sender id for allow-list comparison. The allow-list
 * may hold "919876543210" or "+919876543210", while the bridge delivers the
 * full JID — "919876543210@s.whatsapp.net" (DM) or "918811122233:13@s.whatsapp.net"
 * (self-chat, with device suffix). Strip the leading "+" and, ONLY for
 * WhatsApp JIDs (@s.whatsapp.net / @lid), the @domain + ":<device>" suffix so
 * both sides compare as plain digits. Other platforms' ids (telegram user
 * ids, slack ids, email addresses) pass through untouched — an email
 * address must NOT have its @domain stripped.
 */
export function normalizeSenderId(id: string | undefined): string {
  if (!id) return '';
  const t = id.trim();
  if (/@(s\.whatsapp\.net|lid)$/i.test(t)) {
    return t.replace(/^\+/, '').replace(/@(s\.whatsapp\.net|lid)$/i, '').replace(/:\d+$/, '');
  }
  return t.replace(/^\+/, '');
}

/**
 * True for the special "Allow-All" wildcard token in a verified list
 * (case-insensitive "Allow-All" / "allowall" / "allow all" / "*"): when
 * present, the sender verifier is SKIPPED entirely and anyone may trigger.
 */
export function isAllowAllToken(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  return v === 'allowall' || v === '*';
}

/**
 * True when the per-user verifier is ENABLED for a policy: an `allowedUsers`
 * array is present AND it holds no "Allow-All" wildcard. An EMPTY array is a
 * REAL gate (verified-list rule: blank = NO ONE may trigger); only an ABSENT
 * list keeps the legacy open default (everyone allowed).
 */
function userGateEnabled(policy: ChannelPolicy | undefined): boolean {
  return Array.isArray(policy?.allowedUsers) && !policy.allowedUsers.some(isAllowAllToken);
}

/**
 * Sender passes the verified list: "Allow-All" wildcard (anyone) or an exact
 * JID-normalized match (the bridge delivers "918811122233:13@s.whatsapp.net"
 * while the list holds "+918811122233" — both normalize to the same digits).
 */
function isVerifiedSender(policy: ChannelPolicy | undefined, senderId: string | undefined): boolean {
  const list = policy?.allowedUsers;
  if (!Array.isArray(list)) return true;
  if (list.some(isAllowAllToken)) return true;
  const norm = normalizeSenderId(senderId);
  return norm.length > 0 && list.some((u) => normalizeSenderId(u) === norm);
}

/** True when a group message addresses the bot (name-prefix or @-mention). */
export function isBotAddressed(text: string): boolean {
  const t = (text || '').trim();
  if (/^@?(buff|agent-nuvira|nuvira)\b/i.test(t)) return true;
  if (/@(buff|agent-nuvira)\b/i.test(t)) return true;
  return false;
}

/**
 * Build the per-platform policy map from env vars (config + explicit options
 * are merged over this in the constructor):
 *   BUFF_GATEWAY_ALLOWED_USERS[_{PLATFORM}]      — sender ids allowed to trigger
 *   BUFF_GATEWAY_ALLOWED_GROUPS[_{PLATFORM}]     — group ids allowed to trigger
 *   BUFF_GATEWAY_REQUIRE_MENTION[_{PLATFORM}]    — address-only mode (groups)
 *   BUFF_GATEWAY_DISABLED_PLATFORMS              — platforms fully off
 */
export function envPolicies(): PolicyMap {
  const truthy = (v: string | undefined): boolean => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase());
  const split = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const globalUsers = split(envBuff('GATEWAY_ALLOWED_USERS'));
  const globalGroups = split(envBuff('GATEWAY_ALLOWED_GROUPS'));
  const globalMention = truthy(envBuff('GATEWAY_REQUIRE_MENTION'));
  const disabled = split(envBuff('GATEWAY_DISABLED_PLATFORMS'));
  const out: PolicyMap = {};
  for (const p of Object.keys(PLATFORM_ENV_VARS) as Platform[]) {
    const key = p.toUpperCase();
    const pol: ChannelPolicy = {};
    const users = split(process.env[`BUFF_GATEWAY_ALLOWED_USERS_${key}`]);
    if ((users.length ? users : globalUsers).length) pol.allowedUsers = users.length ? users : globalUsers;
    const groups = split(process.env[`BUFF_GATEWAY_ALLOWED_GROUPS_${key}`]);
    if ((groups.length ? groups : globalGroups).length) pol.allowedGroups = groups.length ? groups : globalGroups;
    if (globalMention || truthy(process.env[`BUFF_GATEWAY_REQUIRE_MENTION_${key}`])) pol.requireMention = true;
    if (disabled.includes(p)) pol.disabled = true;
    if (Object.keys(pol).length) out[p] = pol;
  }
  return out;
}

// ─── Registry ───────────────────────────────────────────────────────────────

export interface GatewayRegistryOptions {
  /** Auto-subscribe to the event bus and stream board events to channels (default true). */
  streamEvents?: boolean;
  /** Only reply for pipeline intents; all other messages get a help line (default false). */
  pipelineOnly?: boolean;
  /** Config dir for the delivery ledger + inbox (tests pass a temp dir; default ~/.nuvira). */
  deliveryConfigDir?: string;
  /**
   * Authorized channels allowed to trigger the pipeline ("platform:channelId"
   * entries, comma-separated in BUFF_GATEWAY_ALLOW_IDS). Empty = every channel
   * may trigger. Non-authorized channels get a polite refusal instead.
   */
  allowIds?: string[];
  /**
   * P1 — per-platform inbound policies (who may trigger). Merged over env
   * (BUFF_GATEWAY_ALLOWED_USERS[_<PLATFORM>] / _GROUPS / _REQUIRE_MENTION /
   * BUFF_GATEWAY_DISABLED_PLATFORMS) and config (`gateway.policies`). Tests
   * inject policies here for hermetic coverage.
   */
  policies?: PolicyMap;
  /**
   * Chat-intent engine (write/explain/ask → answerOnce). Defaults to the real
   * ChatCommand (lazy-imported on first chat intent); tests inject a fake so
   * a chat-answer test never touches a model or the CLI router.
   */
  chatEngine?: import('../web-dashboard/chat-console.js').ChatEngine;
}

export class GatewayRegistry {
  readonly directory: ChannelDirectory;
  /** I2 — guaranteed-delivery ledger for failed sends. */
  readonly delivery: DeliveryLedger;
  /** P2 — inbound message inbox (who messaged the bot, what happened). */
  readonly inbox: InboxLedger;
  private adapters = new Map<Platform, ChannelAdapter>();
  private configManager: ConfigManager;
  private options: Required<Omit<GatewayRegistryOptions, 'deliveryConfigDir' | 'policies' | 'chatEngine'>>;
  /** Explicit per-platform policies (tests / programmatic use) — kept so the
   *  per-inbound live re-read merges them on top of env + config instead of
   *  dropping them. */
  private explicitPolicies: PolicyMap;
  private policies: PolicyMap;
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
  private chatEngine: GatewayRegistryOptions['chatEngine'] | null;
  /** Per-contact conversation history for gateway chat (WhatsApp/Telegram/etc.).
   *  Disk-backed via GatewayChatStore so history survives gateway restarts. */
  private chatStore: GatewayChatStore;

  constructor(options: GatewayRegistryOptions = {}, configManager?: ConfigManager) {
    const allowFromEnv = (envBuff('GATEWAY_ALLOW_IDS') ?? '')
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
    this.inbox = new InboxLedger(options.deliveryConfigDir);
    this.configManager = configManager ?? new ConfigManager();
    this.chatEngine = options.chatEngine ?? null;
    this.chatStore = new GatewayChatStore(options.deliveryConfigDir);
    this.explicitPolicies = options.policies ?? {};
    this.policies = this.readPolicies();
  }

  /**
   * Build the effective policy map: explicit options < env < config (most
   * specific wins — same merge the constructor uses, re-run per inbound so
   * dashboard/CLI changes apply to the running gateway without a restart).
   * ConfigManager's statSync re-read is ~µs; the JSON parse only happens when
   * the config file actually changed.
   */
  private readPolicies(): PolicyMap {
    const fromConfig = (this.configManager.getAll() as { gateway?: { policies?: PolicyMap } }).gateway?.policies;
    // The config shape stores the same fields; cast through the typed view.
    // Explicit options are MOST specific (they win over env + config) — the
    // same precedence the constructor used before the live re-read existed.
    return { ...envPolicies(), ...((fromConfig as PolicyMap | undefined) ?? {}), ...this.explicitPolicies };
  }

  /**
   * Channel targets that ALWAYS receive pipeline completion summaries
   * (config `gateway.statusRecipients`, live re-read per pipeline so the
   * CLI/dashboard apply without a restart). Alias or platform:channelId.
   */
  private readStatusRecipients(): string[] {
    const fromConfig = (this.configManager.getAll() as { gateway?: { statusRecipients?: string[] } }).gateway?.statusRecipients;
    return Array.isArray(fromConfig) ? fromConfig : [];
  }

  /**
   * Forward a pipeline completion summary to every configured status
   * recipient (best-effort — a bad target is warned, never throws, and never
   * blocks the originating reply). Resolves aliases like any gateway send.
   */
  private async notifyStatusRecipients(summary: string): Promise<void> {
    for (const target of this.readStatusRecipients()) {
      const ok = await this.send(target, `📊 Pipeline status — ${summary}`);
      if (!ok) logger.warn(`gateway: status recipient '${target}' unreachable — delivery enqueued for retry`);
    }
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

  /**
   * P3 — send media to a channel ref. Adapters that implement the optional
   * `sendMedia` (WhatsApp, Telegram, Discord) support it; others return false
   * (caller reports why). Called as a method so `this` stays bound.
   */
  async sendMediaToRef(ref: ChannelRef, media: MediaPayload): Promise<boolean> {
    const adapter = this.adapters.get(ref.platform);
    if (!adapter || !adapter.configured || !adapter.sendMedia) return false;
    return adapter.sendMedia(ref.channelId, media);
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
   * Returns the counters (public so the CLI `nuvira gateway delivery --flush`
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
   * Handle an inbound channel message: parse → policy-gate → dispatch → reply.
   * Non-pipeline messages reply with a short intent/help line (unless
   * pipelineOnly). Never throws — a failed pipeline replies with the error.
   * Pipeline runs are SERIALIZED so board events stream to the originating
   * channel (a second message while a run is active queues behind it).
   * Every message is recorded in the inbox (P2) with its disposition.
   */
  async handleInbound(msg: InboundMessage): Promise<string> {
    // Auto-learn Telegram chat IDs: when a message arrives from a Telegram
    // user, update any contact/alias that used a phone number format.
    // Also auto-registers new users with status: 'pending' for admin approval.
    if (msg.platform === 'telegram' && msg.senderId) {
      void this.learnTelegramChatId(msg.senderId, msg.channelId, msg.from).catch(() => {});
    }

    const ref: ChannelRef = { platform: msg.platform, channelId: msg.channelId };
    const replyTo = async (text: string): Promise<void> => {
      await this.sendToRef(ref, text);
    };
    const record = (handled: InboundDisposition, reply?: string): void => {
      this.inbox.record({
        platform: msg.platform,
        channelId: msg.channelId,
        text: msg.text,
        from: msg.from,
        senderId: msg.senderId,
        isGroup: msg.isGroup,
        handled,
        reply,
      });
    };

    const parsed = parseRequestSync(msg.text);

    // ── P1 policy gate — applies to EVERY message, including light/help
    // intents. HARD POLICY: an unapproved sender gets NO reply at all and NO
    // processing (no help line, no chat answer, no pipeline) — they must not
    // even learn a bot exists. Polite ⛔ refusals are an explicit opt-in
    // (`silentDrop: false`); the default is silent.
    // Live re-read: policies changed via `nuvira config gateway allow/…` or the
    // dashboard Permissions page apply to the RUNNING gateway immediately
    // (ConfigManager's statSync re-read is µs; the JSON parse only on change).
    this.policies = this.readPolicies();
    const policy = this.policies[msg.platform];
    const refuse = async (why: string): Promise<string> => {
      // HARD POLICY: silent by default — nothing is sent and nothing runs.
      // `silentDrop: false` explicitly opts a platform back into the polite
      // ⛔ message (for operators who want unapproved senders to know why).
      if (policy?.silentDrop === false) {
        const line = `⛔ ${why}`;
        await replyTo(line);
        record('refused', line);
        return line;
      }
      record('refused');
      return 'refused'; // handled, but NOTHING sent, NOTHING processed
    };
    if (policy?.disabled) {
      return refuse(`The ${msg.platform} channel is disabled for agent triggers.`);
    }
    if (msg.isGroup) {
      if (policy?.allowedGroups && policy.allowedGroups.length > 0 && !policy.allowedGroups.includes(msg.channelId)) {
        return refuse('This group is not authorized to trigger the agent.');
      }
      // Sender gate inside groups: a group message's author was previously
      // NEVER checked against allowedUsers (the DM-only else-if below) — so an
      // unapproved member in ANY group could trigger the agent, even with an
      // allow-list configured. Enforce the same verified list here: the group
      // must be allowed AND the sender must be verified (or the list holds
      // the "Allow-All" wildcard). JID ids ("114602662703205@lid",
      // "918811122233:13@s.whatsapp.net") normalize to digits like DM senders.
      if (userGateEnabled(policy) && !isVerifiedSender(policy, msg.senderId)) {
        return refuse('You are not authorized to trigger the agent.');
      }
      // Address-only mode: a group message must mention/address the bot.
      if (policy?.requireMention && !isBotAddressed(msg.text)) {
        const line = `🤖 I'm here — mention me (e.g. "nuvira fix the tests") to trigger a task in this group.`;
        await replyTo(line);
        record('help', line);
        return line;
      }
    } else if (userGateEnabled(policy) && !isVerifiedSender(policy, msg.senderId)) {
      // JID-normalized comparison: the bridge delivers "918811122233:13@s.whatsapp.net"
      // while the list holds "+918811122233" — both normalize to the same
      // digits. A sender who wrote "918811122233" without the + is the same
      // person. A BLANK list ([]) is a real gate: NO ONE may trigger; the
      // "Allow-All" wildcard disables the verifier (everyone may trigger).
      return refuse('You are not authorized to trigger the agent.');
    }
    if (!this.isAllowed(ref)) {
      return refuse('This channel is not authorized to trigger the agent. Add it to BUFF_GATEWAY_ALLOW_IDS (platform:channelId).');
    }

    // pipelineOnly: pipelines run, everything else is silently recorded —
    // only reached by AUTHORIZED senders (the gate above already dropped
    // unapproved ones silently).
    if (this.options.pipelineOnly && parsed.action.run !== 'pipeline') {
      record(parsed.action.run === 'chat' ? 'chat' : 'help');
      return `🤖 I understood: **${parsed.intent}** (${(parsed.confidence * 100).toFixed(0)}% confidence)`;
    }

    // Light intents (config / unknown) — cheap help/understood line, no agent
    // work, no model. Only reached by AUTHORIZED senders (the gate above
    // silently dropped unapproved ones).
    if (parsed.action.run !== 'pipeline' && parsed.action.run !== 'chat') {
      const line = `🤖 I understood: **${parsed.intent}** (${(parsed.confidence * 100).toFixed(0)}% confidence)\nTry a task like "fix the failing test" or "explain this repo" — or run \`nuvira gateway status\` for help.`;
      await replyTo(line);
      record('help', line);
      return line;
    }

    // Chat intent (write/explain/ask → run: 'chat'): a REAL chat answer through
    // the same engine as the dashboard console (ChatCommand.answerOnce) — so
    // "write a poem and send it to Alex" on WhatsApp actually writes the poem,
    // and the model's toolset includes gateway_send to deliver it.
    if (parsed.action.run === 'chat') {
      const answer = await this.runInboundChat(msg);
      const line =
        answer && answer.content.trim() && !answer.generationFailed
          ? answer.content
          : `🤖 I understood: **${parsed.intent}** (${(parsed.confidence * 100).toFixed(0)}% confidence)\nNo model is available right now — try a task like "fix the failing test" or "explain this repo", or run \`nuvira gateway status\` for help.`;
      await replyTo(line);
      record('chat', line);
      return line;
    }

    // Pipeline intent that ALSO asks to deliver the result ("create a report
    // and send it to the team", "fix the test and message the result to ops")
    // runs through the AGENT LOOP, not the bare orchestrator: the loop's model
    // sees build/repair (which run the pipeline as a tool) AND gateway_send,
    // so it can compose "build → then deliver" in one turn. A pure pipeline
    // task with no delivery ask stays on the fast direct-orchestrator path.
    if (hasDeliveryAsk(msg.text)) {
      const answer = await this.runInboundChat(msg);
      const line =
        answer && answer.content.trim() && !answer.generationFailed
          ? answer.content
          : `🤖 I understood: **${parsed.intent}** (${(parsed.confidence * 100).toFixed(0)}% confidence)\nNo model is available right now — try a task like "fix the failing test" or "explain this repo", or run \`nuvira gateway status\` for help.`;
      await replyTo(line);
      record('pipeline', line);
      // Status recipients: a pipeline task (even one routed through the loop
      // for delivery) forwards its outcome to the configured contacts.
      await this.notifyStatusRecipients(line);
      return line;
    }

    // Pure pipeline intent — run serialized. Deliberately does NOT touch
    // activeChannel before the gate: a chat message arriving while a pipeline
    // run is in flight must not redirect the run's board events.
    await replyTo(`✅ Got it — running the ${parsed.action.name} pipeline…`);
    const run = this.runChain.then(async (): Promise<string> => {
      // Only THIS run's events stream — set activeChannel inside the chain.
      this.activeChannel = ref;
      // P2 — origin context: the pipeline model knows who it's talking to and
      // where (so it can reply/forward to the right place via gateway_send).
      const origin = `${PLATFORM_LABELS[msg.platform]} ${msg.isGroup ? 'group' : 'chat'} ${msg.from ?? msg.senderId ?? msg.channelId}`;
      const result = await runPipelineTool(msg.text, this.configManager, {
        board: false,
        mode: parsed.mode,
        taskIntentHint: parsed.action.taskIntent,
        origin,
      });
      const headline = result.success ? '✅ Done' : '❌ Failed';
      const lines = [`${headline} — ${result.summary}`];
      if (result.details && result.details.length > 0) {
        for (const line of result.details.slice(0, 6)) lines.push(`• ${line}`);
      }
      const reply = lines.join('\n');
      await replyTo(reply);
      record('pipeline', reply);
      // Status recipients: ALWAYS forward the completion summary to the
      // configured contacts/groups, whoever triggered it.
      await this.notifyStatusRecipients(reply);
      return reply;
    });
    this.runChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Chat-intent answer (write/explain/ask): run ONE tool-loop turn through the
   * SAME engine the dashboard chat console uses (ChatCommand.answerOnce), so
   * a WhatsApp request like "write a poem and send it to Alex" is answered
   * AND delivered (the model's toolset includes gateway_send). Lazy-imported
   * so a gateway that only ever runs pipelines never pays for the CLI router.
   * Never throws — a model failure falls back to the help line in handleInbound.
   */
  private async runInboundChat(msg: InboundMessage): Promise<{ content: string; generationFailed?: boolean }> {
    try {
      const engine =
        this.chatEngine ??
        // Instantiate + cast: ChatCommand's answerOnce is a prototype method,
        // and the console's ChatEngine is the loose slice it satisfies (same
        // cast the dashboard chat-console uses).
        (new ((await import('../cli/chat.js')).ChatCommand)() as unknown as import('../web-dashboard/chat-console.js').ChatEngine);
      const origin = `${PLATFORM_LABELS[msg.platform]} ${msg.isGroup ? 'group' : 'chat'} ${msg.from ?? msg.senderId ?? msg.channelId}`;
      // Per-contact conversation history: load prior messages so the model has
      // context for follow-up questions (e.g. "what was the second option?").
      const historyKey = `${msg.platform}:${msg.channelId}`;
      const history = this.chatStore.getHistory(historyKey);
      // P2 — origin context: the chat model knows who it's talking to, so its
      // gateway_send calls target the right contact/channel.
      // The response format rules ensure the user gets a clean, direct answer
      // without leaked internal reasoning or planning.
      const prompt = [
        `[Origin: ${origin} — this message was sent from a messaging app (WhatsApp/Telegram/etc). Your text response is automatically delivered back to the sender — do NOT call gateway_send for this conversation unless you need to send to a DIFFERENT target.]`,
        '',
        'RESPONSE FORMAT (non-negotiable for messaging app replies):',
        '- Deliver your answer DIRECTLY. No preamble, no "I would be happy to...", no restating the request.',
        '- Do NOT include your internal reasoning, planning, draft iterations, or tool deliberation in your response text. Think internally, then output ONLY the final answer.',
        '- Do NOT use bullet-point planning blocks ("* User:", "* Tone:", "* Goal:", etc.) in your response.',
        '- Do NOT narrate your tool usage ("I should use gateway_send", "Looking at the Origin tag", etc.).',
        '- For creative tasks (poems, stories, messages): just write the content. No meta-commentary about how you wrote it.',
        '- End with suggest_followups (3 suggestions) — but NEVER include the suggest_followups JSON in your response text; use the tool call.',
        '',
        msg.text,
      ].join('\n');
      // One polite "working" line up front, then ONLY the final answer. The
      // engine's live progress ("routed to <provider>…", "⚙ tool(args)"
      // including raw suggest_followups JSON) is INTERNAL — streaming it to a
      // channel leaks routing internals and tool-call noise to the sender.
      await this.sendToRef({ platform: msg.platform, channelId: msg.channelId }, '🤖 Working on it…');
      // askUser must never hang the gateway on a TTY: when the model needs a
      // clarification, reply to the channel with the question + choices and
      // pick the first as a best-effort default (the user can answer on the
      // next message). Matches the dashboard's non-TTY renderer.
      // gateway: reuse THIS live registry so the model's gateway_send calls
      // deliver through the already-connected bridge — a fresh registry would
      // open a second WhatsApp connection and stall.
      const answer = await engine.answerOnce(prompt, {
        history,
        // Inject prior conversation context so the model remembers previous
        // exchanges with this contact (follow-up questions, suggested followups).
        gateway: {
          send: (target, text) => this.send(target, text),
          sendMedia: (target, media) => {
            const ref = this.directory.resolve(target);
            if (!ref) return Promise.resolve(false);
            return this.sendMediaToRef(ref, media);
          },
          origin: { platform: msg.platform, channelId: msg.channelId },
          autoDeliverMedia: (media) => {
            const ref = { platform: msg.platform, channelId: msg.channelId };
            return this.sendMediaToRef(ref, media);
          },
          directory: this.directory,
        },
        askUser: async (question, choices) => {
          const list = (choices as Array<{ label: string }>).map((c, i) => `${i + 1}. ${c.label}`).join('\n');
          await this.sendToRef({ platform: msg.platform, channelId: msg.channelId }, `🤔 ${question}\n${list}`);
          return { answer: (choices as Array<{ label: string }>)[0]?.label ?? 'skip', index: 0 };
        },
        // P3 note: the engine's onProgress is intentionally NOT wired here —
        // internal progress lines (routed-to, raw tool calls) must never leak
        // to the channel. Progress stays in the audit logs; the single
        // "working" line + final answer is the whole conversation.
      });
      // Only the FINAL answer reaches the sender, in natural language — plus
      // the model's suggested followups rendered as a readable numbered list
      // (WhatsApp has no clickable chips; the sender replies with one of the
      // lines). No technical jargon, no routing/tool-call noise.
      // E3b: strip any raw suggest_followups JSON the model embedded in the text
      // instead of making a proper tool call — this leaks internal tool-call
      // noise to the channel sender.
      let content = (answer.content || '')
        .replace(/\n?\*?\s*\{\s*"tool"\s*:\s*"suggest_followups"[\s\S]*$/, '')
        .replace(/\n?\*?\s*<function=suggest_followups[\s\S]*<\/function>/g, '')
        .trim();
      // Strip leaked internal reasoning, planning blocks, and meta-commentary.
      // The model sometimes emits chain-of-thought (draft planning, tool
      // deliberation, self-correction) as visible text. This cleans it up
      // so the user only sees the actual deliverable.
      content = stripGatewayReasoning(content);
      const fups = (answer.followups ?? [])
        .map((f) => (f && typeof f.prompt === 'string' && f.prompt.trim() ? f.prompt.trim() : ''))
        .filter(Boolean)
        .slice(0, 3);
      if (fups.length > 0) {
        const suffix = `\n\nTry next:\n${fups.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
        // WhatsApp truncates ~4096 chars — the ANSWER is the deliverable, so
        // drop the followups (never the answer) when the message would exceed
        // the cap.
        if (content.length + suffix.length <= 4000) content += suffix;
      }
      // Store this exchange in the per-contact history so follow-up questions
      // have context. Persisted to disk via GatewayChatStore so it survives
      // gateway restarts. The store handles trimming to max pairs.
      this.chatStore.append(historyKey, msg.text, content);
      return { content, generationFailed: answer.generationFailed };
    } catch (err) {
      logger.error(`gateway: inbound chat failed: ${err instanceof Error ? err.message : String(err)}`);
      return { content: '', generationFailed: true };
    }
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
    // Prune stale conversations on startup (best-effort).
    this.chatStore.prune();

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

  /**
   * Auto-learn Telegram chat IDs: when a message arrives from a Telegram user,
   * update any contact/alias that used a phone number format with the real
   * numeric chat ID. Also auto-registers new users with status: 'pending'
   * for admin approval. Uses the sender's Telegram first_name as the
   * display name.
   */
  private async learnTelegramChatId(senderId: string, channelId: string, senderName?: string): Promise<void> {
    try {
      const { readGatewayContacts, upsertGatewayContact } = await import('../gateway/contacts.js');
      const { readAliases, writeAliases } = await import('./channel-directory.js');
      const contacts = readGatewayContacts();
      let updated = false;

      // Update contacts that use phone number format for Telegram
      for (const c of contacts) {
        if (c.platform === 'telegram' && /^\+?\d{10,15}$/.test(c.id) && c.id !== channelId) {
          upsertGatewayContact({ ...c, id: channelId, status: c.status ?? 'approved' });
          logger.info(`gateway: auto-learned Telegram chat ID for ${c.name}: ${c.id} → ${channelId}`);
          updated = true;
        }
      }

      // Auto-register NEW Telegram users with status: 'pending'
      const existingContact = contacts.find((c) => c.platform === 'telegram' && c.id === channelId);
      if (!existingContact) {
        const name = (senderName || '').trim() || `telegram-user-${channelId.slice(-4)}`;
        upsertGatewayContact({
          name,
          platform: 'telegram',
          id: channelId,
          status: 'pending',
          registeredAt: Date.now(),
        });
        logger.info(`gateway: 🆕 new Telegram user registered: '${name}' (ID: ${channelId}) — pending admin approval`);
        updated = true;
      }

      // Update aliases that use phone number format for Telegram
      const aliases = readAliases();
      let aliasUpdated = false;
      for (const a of aliases) {
        if (a.platform === 'telegram' && /^\+?\d{10,15}$/.test(a.channelId) && a.channelId !== channelId) {
          a.channelId = channelId;
          aliasUpdated = true;
          logger.info(`gateway: auto-learned Telegram chat ID for alias '${a.alias}': ${a.channelId} → ${channelId}`);
        }
      }
      if (aliasUpdated) writeAliases(aliases);

      if (updated || aliasUpdated) {
        logger.info(`gateway: Telegram chat ID learned from incoming message: ${channelId}`);
      }
    } catch {
      /* best-effort — never break the pipeline */
    }
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
