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
// LEAF import on purpose: the gateway must not pull the whole tool registry
// (110 registrations + their modules) in just to clean up followups.
import { isSuggestedFollowup, normalizeFollowups } from '../tools/followup-utils.js';
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
import { InboundDedupLedger } from './dedup.js';
import { GatewayHeartbeat, HEARTBEAT_INTERVAL_MS, type AdapterHealth } from './heartbeat.js';
import { logGatewayEvent, previewText } from './gateway-log.js';
import { hasCodingAction, looksLikeAgentCliAsk, resolveAskKind } from '../nlu/conversation-gate.js';
import { GatewayChatStore, CHAT_HISTORY_MAX_PAIRS } from './chat-store.js';
import { looksLikeConfusedScaffoldingReply, toUserFacingGenerationError } from '../inference/tool-call-utils.js';
import { logger } from '../utils/logger.js';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBuffConfigDir } from '../config/paths.js';

/** How often the running gateway drains due delivery entries (ms). */
const DELIVERY_DRAIN_INTERVAL_MS = 30_000;

/** Cap the per-target send-failure map (diagnostics only — never grows). */
const MAX_TRACKED_SEND_ERRORS = 200;

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

  // ── Phase 1: Strip structured thinking tags (Hermes approach) ──
  // Models that support thinking modes emit reasoning in tags like
  // <think>, <thinking>, <reasoning>, <thought>, <REASONING_SCRATCHPAD>.
  // Strip closed pairs and unterminated open tags at block boundaries.
  const THINK_TAGS = ['think', 'thinking', 'reasoning', 'thought', 'REASONING_SCRATCHPAD'];
  for (const tag of THINK_TAGS) {
    // Closed pairs: <think>...</think>
    const closeRe = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'gi');
    t = t.replace(closeRe, '');
    // Unterminated open tag at block boundary (start of text or after newline)
    const openRe = new RegExp(`(?:^|\\n)\\s*<${tag}>[\\s\\S]*$`, 'gi');
    t = t.replace(openRe, '');
    // Stray orphan close tags
    const orphanCloseRe = new RegExp(`<\\/${tag}>`, 'gi');
    t = t.replace(orphanCloseRe, '');
  }
  // Also strip tool-call XML blocks some models leak (<tool_call>, etc.)
  t = t.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');
  t = t.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, '');
  t = t.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '');

  // ── Phase 2: Strip fallback plain-text reasoning patterns ──
  // These catch reasoning from models that DON'T use thinking tags.
  // Less precise than tag-based stripping, but necessary as a safety net.

  // Strip planning block lines starting with "* ".
  t = t.replace(/^\s*\*+\s+(?:User|Subjects?|Occasion|Goal|Delivery|Tone|Key elements?|Stanza|Drafting|Acknowledge|Answer|Tool|Follow-?ups?|Constraints?|Direct|No\s|End\s|Let'?s|Since\s|Wait,|Actually,|Correction|Self-Correction|Looking\s|Given\s|The\s+(?:bridge|system|prompt|target|user)|Since\s+the|My\s+(?:text|plan|approach)|However,|But\s+the|Let\s+me|Let's|Really,|If\s+I|The\s+most|To\s+be\s+safe|I\s+am\s+(?:acting|communicating|the)|I\s+need\s+to|One\s+more\s+thing|I\s+am\s+communicating|Since\s+I\s+am|Actually\s+the|Since\s+I\s+can't|I\s+don't|I\s+should\s+probably|I\s+will\s+just|I\s+should\s+(?:check|send|use|provide|be|do)|I\s+will\s+(?:send|provide)|Let\s+me\s+refine|Appropriate|Appropriate\s+for|Plan|Here'?s\s+(?:the|a)|That\s+(?:looks?|should|works?)|This\s+(?:is|should)|Now\s+(?:I|let)|So\s+(?:I|let)|I'll\s+now|I\s+will\s+now|Let\s+me\s+(?:now|write|draft)).*$/gim, '');

  // Strip self-evaluation numbered lists.
  t = t.replace(/^\s*\d+\.\s+(?:Direct\s+answer|No\s+(?:preamble|internal|bullet|narration|tool)|End\s+with|Preamble|Internal\s+reasoning|Tool\s+usage|Bullet-point|Narration|Gateway_send|Start\s+with|Describe|Talk\s+about|Mention|Speed|History|Past\s+uses|Intelligence|Baby|Loyalty|Colors|Diet|Physical).*$/gim, '');

  // Strip self-evaluation sentences.
  t = t.replace(/^\s*(?:That\s+(?:looks?|should|works?)|This\s+(?:is|should\s+work)|Looks\s+good|Seems\s+(?:good|correct|right)|Perfect|Great|Done).*/gim, '');

  // Strip standalone "Plan:" and "Here's the ...:" markers.
  t = t.replace(/^\s*(?:Plan\s*:|Here'?s\s+(?:the|a)\s+.*:|Let's\s+(?:begin|start|go|write)|I'?ll\s+(?:now|write|draft|create)).*$/gim, '');

  // Strip preamble at the very start.
  t = t.replace(/^\s*(?:I\s+(?:would|'d|will)\s+be\s+happy\s+to\s+).{0,200}?\n\n/s, '');

  // Strip tool-deliberation paragraphs about gateway_send.
  t = t.replace(/(?:^|\n)\s*(?:Wait,\s+the\s+prompt\s+says|Since\s+this\s+is\s+a\s+request|Actually,\s+looking\s+at|Correction:\s+The\s+user|Self-Correction|I\s+should\s+use\s+gateway_send|Let's\s+refine\s+the|Wait,\s+if\s+I\s+call)[\s\S]*?(?=\n\s*(?:\d+\.|[A-Z]|$))/g, '');

  // ── Phase 3: Cleanup ──
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

/**
 * Match a channel reply against the choices of a pending `ask_user` question.
 *
 * Deliberately conservative, because a WRONG match silently steers the agent:
 * only unambiguous forms resolve, and anything else returns `null` so the
 * caller releases the waiter with its default and handles the text as a normal
 * message. Supported forms:
 *   - `1`, `2`, … (1-based, in range) and `option 2` / `#2`
 *   - the choice label, case- and punctuation-insensitively ("pdf" → "PDF book")
 *   - a prefix of exactly ONE label ("interactive" → "Interactive game")
 * A number OUT of range, or a prefix matching several labels, is NOT a choice.
 */
export function matchAskUserChoice(
  text: string,
  choices: string[],
): { answer: string; index: number } | null {
  const raw = (text || '').trim();
  if (!raw || choices.length === 0) return null;
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const numbered = raw.match(/^(?:option\s*|#\s*)?(\d{1,2})[.)]?$/i);
  if (numbered) {
    const idx = Number(numbered[1]) - 1;
    return idx >= 0 && idx < choices.length ? { answer: choices[idx], index: idx } : null;
  }

  const n = norm(raw);
  const exact = choices.findIndex((c) => norm(c) === n);
  if (exact >= 0) return { answer: choices[exact], index: exact };

  if (n.length >= 2) {
    const hits = choices.map((c, i) => ({ c, i })).filter(({ c }) => norm(c).startsWith(n));
    if (hits.length === 1) return { answer: hits[0].c, index: hits[0].i };
  }
  return null;
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
  return passesSenderList(policy?.allowedUsers, senderId);
}

/**
 * Verified-list rule, applied to ANY sender list (not just `allowedUsers`):
 *  - list ABSENT            → open (caller decides what "open" means)
 *  - list has Allow-All     → anyone passes
 *  - list has entries       → exact JID/digit-normalized match required
 *  - list is EMPTY (`[]`)   → nobody passes
 * `senderId` undefined never matches a non-empty list.
 */
export function passesSenderList(list: string[] | undefined, senderId: string | undefined): boolean {
  if (!Array.isArray(list)) return true;
  if (list.some(isAllowAllToken)) return true;
  const norm = normalizeSenderId(senderId);
  return norm.length > 0 && list.some((u) => normalizeSenderId(u) === norm);
}

/** The decision returned by `authorizeOutboundSend`. */
export interface OutboundSendDecision {
  allowed: boolean;
  /** Human/model-readable reason when denied (undefined when allowed). */
  reason?: string;
  /** Which list governed the decision: the explicit one, the inherited one, or none. */
  source: 'same-conversation' | 'outboundSenders' | 'inherited-allowedUsers' | 'open' | 'no-sender';
}

/**
 * Authorize a `gateway_send` (outbound, third-party) command from a gateway
 * sender. This is the SECOND, independent gate — `allowedUsers` only decides
 * who may trigger the agent; this decides who may then direct it to deliver
 * to SOMEONE ELSE.
 *
 * Rules, in order:
 *  1. No sender id at all (local/unattributed turn) → allowed.
 *  2. Target IS the sender's own conversation → allowed (a self-send is just
 *     an explicit reply; the automatic text response does the same).
 *  3. `outboundSenders` set → verified-list rule (Allow-All = anyone; [] = none;
 *     else exact match).
 *  4. `outboundSenders` absent → INHERIT `allowedUsers` (legacy behaviour, so
 *     no deployment silently breaks). Accepting an inbound trigger is what
 *     grants outbound authority until an operator tightens it.
 *
 * `ownConversation` is computed by the caller (target resolves to the same
 * normalized channel as the origin).
 */
export function authorizeOutboundSend(opts: {
  policy: ChannelPolicy | undefined;
  senderId: string | undefined;
  /** True when the resolved target is the sender's OWN conversation. */
  ownConversation: boolean;
}): OutboundSendDecision {
  const { policy, senderId, ownConversation } = opts;
  if (!senderId || !normalizeSenderId(senderId)) {
    return { allowed: true, source: 'no-sender' };
  }
  if (ownConversation) {
    return { allowed: true, source: 'same-conversation' };
  }
  if (Array.isArray(policy?.outboundSenders)) {
    if (passesSenderList(policy.outboundSenders, senderId)) {
      return { allowed: true, source: 'outboundSenders' };
    }
    return {
      allowed: false,
      source: 'outboundSenders',
      reason:
        'send authority: you are not authorised to send messages to other people through this agent. ' +
        "Ask the administrator to add you to this platform's outbound senders (dashboard → Agent Hub → Permissions → Send authority).",
    };
  }
  // No explicit list — inherit the inbound allow-list (legacy default).
  if (passesSenderList(policy?.allowedUsers, senderId)) {
    return { allowed: true, source: policy?.allowedUsers ? 'inherited-allowedUsers' : 'open' };
  }
  return {
    allowed: false,
    source: 'inherited-allowedUsers',
    reason: 'send authority: this sender is not authorised to direct outbound messages.',
  };
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
  /**
   * Callback invoked when the gateway starts/stops processing a chat message.
   * The dashboard server uses this to broadcast typing indicators via SSE.
   */
  onTyping?: (event: { platform: string; channelId: string; typing: boolean }) => void;
}

export class GatewayRegistry {
  readonly directory: ChannelDirectory;
  /** I2 — guaranteed-delivery ledger for failed sends. */
  readonly delivery: DeliveryLedger;
  /** P2 — inbound message inbox (who messaged the bot, what happened). */
  readonly inbox: InboxLedger;
  /**
   * Idempotency ledger: a message delivered twice (bridge reconnect, offline
   * backfill, webhook retry) is handled once. Without it, one WhatsApp ask
   * became 20+ identical model turns — see dedup.ts.
   */
  readonly dedup: InboundDedupLedger;
  /**
   * Liveness beat — so a gateway that is DOWN is visibly down instead of
   * "configured ✅ but nobody home". Read by `gateway status` and the
   * supervisor.
   */
  readonly heartbeat: GatewayHeartbeat;
  private adapters = new Map<Platform, ChannelAdapter>();
  private configManager: ConfigManager;
  private options: Required<Omit<GatewayRegistryOptions, 'deliveryConfigDir' | 'policies' | 'chatEngine' | 'onTyping'>>;
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
  /** Epoch ms of start() — the uptime reported in the heartbeat. */
  private startedAt = 0;
  /** Beats written this run (monotonic; a stalled count means a stalled loop). */
  private beatCount = 0;
  /** Per-adapter health, published in every beat. */
  private adapterHealth = new Map<Platform, AdapterHealth>();
  /** Earliest epoch-ms at which a not-yet-started adapter may be retried. */
  private adapterRetryAt = new Map<Platform, number>();
  /** The heartbeat + watchdog tick. */
  private livenessTimer: NodeJS.Timeout | null = null;
  private chatEngine: GatewayRegistryOptions['chatEngine'] | null;
  /** Per-contact conversation history for gateway chat (WhatsApp/Telegram/etc.).
   *  Disk-backed via GatewayChatStore so history survives gateway restarts. */
  private chatStore: GatewayChatStore;
  /**
   * P5 — the followups last offered to each contact (`platform:channelId`).
   * A messaging-app sender has no clickable chips: they REPLY with one of the
   * rendered lines, so this is the only way to know the message is a follow-up
   * to the previous answer rather than a brand-new independent request.
   */
  private lastFollowupsByContact = new Map<string, import('../tools/followup-utils.js').FollowupSuggestion[]>();
  private onTypingCallback: GatewayRegistryOptions['onTyping'] | null = null;
  /**
   * Last send failure reason per `platform:channelId`, so a caller can report
   * the real cause (e.g. "not a WhatsApp account") instead of a generic line.
   * Bounded; cleared on the next successful send to the same target.
   */
  private readonly lastSendErrors = new Map<string, string>();
  /**
   * Questions the gateway is WAITING on, per `platform:channelId`
   * (`gateway.askUserWait`). The awaiting turn holds its promise until the
   * contact's next message resolves it — see `consumePendingAsk` — or the
   * timeout applies the default. At most ONE waiter per contact: a second
   * question replaces the first (which receives its default, exactly what it
   * would have received anyway), so this map cannot grow an unbounded queue.
   */
  private readonly pendingQuestions = new Map<
    string,
    {
      /** Choice labels in order; index 0 is the default. */
      choices: string[];
      resolve: (a: { answer: string; index: number }) => void;
      timer: NodeJS.Timeout;
      askedAt: number;
      question: string;
    }
  >();

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
    this.dedup = new InboundDedupLedger(options.deliveryConfigDir);
    this.heartbeat = new GatewayHeartbeat(options.deliveryConfigDir);
    this.configManager = configManager ?? new ConfigManager();
    this.chatEngine = options.chatEngine ?? null;
    this.chatStore = new GatewayChatStore(options.deliveryConfigDir);
    this.onTypingCallback = options.onTyping ?? null;
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
      const reason = `adapter for '${ref.platform}' is not configured`;
      logger.warn(`gateway: ${reason}`);
      this.recordSendError(ref, reason);
      return false;
    }
    // Prefer the VERIFIED path when the adapter has one (WhatsApp's Baileys
    // bridge): a bare boolean cannot say WHY a send failed, so a mistyped /
    // non-WhatsApp number looked identical to a success. The reason now flows
    // to the delivery ledger, the gateway logs and the caller.
    const outcome = adapter.sendDetailed
      ? await adapter.sendDetailed(ref.channelId, text)
      : { ok: await adapter.send(ref.channelId, text) };
    if (!outcome.ok) {
      const reason = outcome.error ?? 'send failed';
      this.recordSendError(ref, reason);
      logger.warn(
        `gateway: send to ${ref.platform}:${ref.channelId} failed — ${reason} — enqueued for delivery retry`,
      );
      // Persist for retry (survives this process) — the next drain (or the
      // next `gateway start`) delivers it. Keep the HUMAN target (alias)
      // when the caller had one, for readable ledger lines.
      const entry = this.delivery.enqueue({
        target: target ?? `${ref.platform}:${ref.channelId}`,
        ref,
        text,
        lastError: reason,
      });
      // Structured, durable record — the delivery ledger is pruned and stdout
      // is gone, so this is what makes a later "why did it never arrive?"
      // answerable.
      logGatewayEvent(
        'send.failed',
        {
          platform: ref.platform,
          channelId: ref.channelId,
          target: target ?? `${ref.platform}:${ref.channelId}`,
          reason,
          deliveryId: entry.id,
          verification: outcome.verification,
          textChars: text.length,
          textPreview: previewText(text),
        },
        'warn',
      );
      return false;
    }
    this.clearSendError(ref);
    logGatewayEvent('send.ok', {
      platform: ref.platform,
      channelId: ref.channelId,
      target: target ?? `${ref.platform}:${ref.channelId}`,
      verification: outcome.verification,
      textChars: text.length,
    });
    // Opportunistic flush: a successful send often means the network is back
    // — drain any due pending entries for THIS platform right away (serialized
    // on the drain chain so it never overlaps the timer/CLI drains; awaits so
    // the caller's next send sees the ledger state settled). Never throws.
    await this.drainForPlatform(ref.platform);
    return true;
  }

  /**
   * WHY the most recent send to this target failed (undefined when it did not).
   * The verified adapters (WhatsApp) fill this in so the caller — and the
   * `gateway_send` tool's model-facing output — can report the real cause
   * instead of a generic "transport unreachable".
   */
  lastSendError(ref: ChannelRef): string | undefined {
    return this.lastSendErrors.get(`${ref.platform}:${ref.channelId}`);
  }

  private recordSendError(ref: ChannelRef, reason: string): void {
    this.lastSendErrors.set(`${ref.platform}:${ref.channelId}`, reason);
    if (this.lastSendErrors.size > MAX_TRACKED_SEND_ERRORS) {
      const oldest = this.lastSendErrors.keys().next().value;
      if (oldest !== undefined) this.lastSendErrors.delete(oldest);
    }
  }

  private clearSendError(ref: ChannelRef): void {
    this.lastSendErrors.delete(`${ref.platform}:${ref.channelId}`);
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
    // Same verified path as a first attempt: a retry's failure reason is just
    // as important for diagnosing why a message never arrived.
    const outcome = adapter.sendDetailed
      ? await adapter.sendDetailed(entry.channelId, entry.text)
      : await adapter
          .send(entry.channelId, entry.text)
          .then((ok) => (ok ? { ok } : { ok: false, error: 'send failed' }));
    logGatewayEvent(
      'delivery.dispatched',
      {
        platform: entry.platform,
        channelId: entry.channelId,
        target: entry.target,
        attempt: entry.attempts + 1,
        ok: outcome.ok,
        reason: outcome.error,
      },
      outcome.ok ? 'info' : 'warn',
    );
    return outcome;
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
    const record = (
      handled: InboundDisposition,
      reply?: string,
      dup?: { key: string; count: number },
    ): void => {
      this.inbox.record({
        platform: msg.platform,
        channelId: msg.channelId,
        text: msg.text,
        from: msg.from,
        senderId: msg.senderId,
        isGroup: msg.isGroup,
        handled,
        reply,
        dedupKey: dup?.key,
        dedupCount: dup?.count,
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
      // Durable record of a drop: a sender who never gets an answer is the
      // hardest thing to diagnose from the outside.
      logGatewayEvent('inbound.refused', {
        platform: msg.platform,
        channelId: msg.channelId,
        from: msg.from,
        senderId: msg.senderId,
        reason: why,
      }, 'warn');
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

    // ── IDEMPOTENCY ── A messaging transport is at-least-once: the bridge
    // reconnects and replays its offline backfill, a webhook retries, a device
    // re-syncs. Observed live: ONE WhatsApp ask arrived 20+ times and was
    // answered 20+ times (and, when it routed to the pipeline, re-ran a 112s
    // multi-agent pipeline each time) — the sender's phone filled up with the
    // same reply. The transport's own message id is stable across those
    // re-deliveries, so a message handled once is never handled again.
    //
    // Placed AFTER the authorization gates on purpose: an unapproved sender
    // must leave NO trace (the silent-drop privacy rule), and their ledger
    // rows must not be written either.
    const dedupVerdict = this.dedup.classify({
      platform: msg.platform,
      channelId: msg.channelId,
      text: msg.text,
      senderId: msg.senderId,
      isGroup: msg.isGroup,
      messageId: msg.messageId,
    });
    if (dedupVerdict.duplicate) {
      // No reply: the sender ALREADY has the answer for this exact message.
      // No chat-history write either (that would double the user's turn and
      // corrupt the follow-up context).
      logger.info(
        `gateway: duplicate inbound (${dedupVerdict.kind}, delivery #${dedupVerdict.count}) — ignored`,
      );
      record('duplicate', undefined, { key: dedupVerdict.key, count: dedupVerdict.count });
      return 'duplicate';
    }

    // 7-DAY PER-CONTACT CONVERSATION MEMORY — record every AUTHORIZED inbound
    // message the moment it arrives, BEFORE the routing decision (chat,
    // pipeline, help). Placed AFTER the sender/channel gates: an unapproved
    // sender must leave no trace at all (the silent-drop privacy rule), so
    // recording happens only past the authorization boundary. DESIGN INTENT:
    // if the user asks anything, we have the history to check for relevance;
    // a pipeline- or help-handled ask must not vanish from the thread
    // (previously only chat turns were recorded). Keyed by platform:channelId,
    // persisted by GatewayChatStore (7-day TTL; best-effort — a history write
    // must never break handling).
    const historyKey = `${msg.platform}:${msg.channelId}`;
    try {
      this.chatStore.recordInbound(historyKey, msg.text);
    } catch {
      /* best-effort */
    }

    // PENDING QUESTION (gateway.askUserWait): a turn is HOLDING for this
    // contact's answer. Consume the message as that answer — placed AFTER the
    // authorization + dedup gates (an unapproved sender can never answer a
    // question, and a re-delivered duplicate must not consume one) and BEFORE
    // every routing decision, because the reply belongs to the question rather
    // than to the NLU. A message that does NOT match a choice releases the
    // waiter with its default and falls through to normal handling, so a user
    // typing something else is never silently dropped.
    const pendingAnswerLine = this.consumePendingAsk(msg);
    if (pendingAnswerLine) {
      await replyTo(pendingAnswerLine);
      record('clarified', pendingAnswerLine);
      return pendingAnswerLine;
    }

    // ── Local-CLI asks ── "run nuvira gateway status" names a command for the
    // OPERATOR's terminal. Observed live: it was dispatched to the multi-agent
    // pipeline as a create intent, burned 112s, failed, and wrote an approval
    // artifact. A remote sender cannot execute it locally and a coding
    // pipeline is the worst possible answer, so it gets a deterministic
    // pointer instead of agent work.
    if (looksLikeAgentCliAsk(msg.text)) {
      logger.debug(`gateway: agent-CLI ask → pointer line (${msg.text.slice(0, 60)})`);
      const line = `🤖 \`nuvira …\` is a command for your own terminal — I can't run it for a remote sender. Run it locally to see the result.`;
      await replyTo(line);
      record('help', line);
      return line;
    }

    // pipelineOnly: only pipeline intents run directly; chat/unknown intents
    // still route through runInboundChat so the model can handle them via
    // the tool loop. Light/config intents are silently recorded without a
    // reply — only reached by AUTHORIZED senders (the gate above already
    // dropped unapproved ones silently).
    if (this.options.pipelineOnly && parsed.action.run === 'config') {
      logger.debug(`gateway: light intent in pipelineOnly (${parsed.intent} @ ${parsed.confidence.toFixed(2)}) — recorded, no reply`);
      record('help');
      return '🤖 Noted.';
    }

    // Light intents (config / unknown) — cheap help/understood line, no agent
    // work, no model. Only reached by AUTHORIZED senders (the gate above
    // silently dropped unapproved ones). The parsed intent + confidence are
    // INTERNAL routing detail: they go to the logs, never to the sender.
    if (parsed.action.run !== 'pipeline' && parsed.action.run !== 'chat') {
      logger.debug(`gateway: light intent (${parsed.intent} @ ${parsed.confidence.toFixed(2)}) → help line`);
      const line = `🤖 I understood. Try a task like "fix the failing test" or "explain this repo" — or run \`nuvira gateway status\` for help.`;
      await replyTo(line);
      record('help', line);
      return line;
    }

    // ── THE routing verdict (one shared rule, every surface) ──
    // `resolveAskKind` is the SAME decision `nuvira chat` makes (see
    // chat.ts's resolvePipelineDispatch): a genuine question is answered
    // directly, a coding verb in command position runs the pipeline, and only
    // then does the NLU action map decide. The gateway used to ask only
    // `parsed.action.run`, so the two surfaces disagreed on the same ask —
    // "how do I add JWT auth to the app?" got prose here while chat/execute
    // did the work, and a question phrased like a task still burned a run.
    const askKind = resolveAskKind(msg.text, parsed);
    logger.debug(
      `gateway: route ${askKind} (intent ${parsed.intent} @ ${parsed.confidence.toFixed(2)}, coding=${hasCodingAction(msg.text)})`,
    );

    // Chat ask: a REAL chat answer through the same engine as the dashboard
    // console (ChatCommand.answerOnce) — so "write a poem and send it to Alex"
    // on WhatsApp actually writes the poem, and the model's toolset includes
    // gateway_send to deliver it.
    if (askKind === 'chat') {
      const answer = await this.runInboundChat(msg);
      if (answer && answer.content.trim() && !answer.generationFailed) {
        await replyTo(answer.content);
        record('chat', answer.content);
        return answer.content;
      }
      // Generation failed. The sender gets NO parsed intent/confidence (that
      // is internal routing — it stays in the logs + inbox ledger), and the
      // wording distinguishes a genuinely unconfigured model from a transient
      // provider failure so a glitch is not reported as "no model".
      logger.warn(`gateway: chat generation failed (${parsed.intent} @ ${parsed.confidence.toFixed(2)})`);
      logGatewayEvent('chat.failed', {
        platform: msg.platform,
        channelId: msg.channelId,
        intent: parsed.intent,
        confidence: parsed.confidence,
        hasModel: this.hasConfiguredModel(),
      }, 'error');
      const line = this.generationFailureLine();
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
          : this.generationFailureLine();
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
      logGatewayEvent('pipeline.completed', {
        platform: msg.platform,
        channelId: msg.channelId,
        success: result.success,
        summary: result.summary,
        tools: parsed.action.name,
      }, result.success ? 'info' : 'warn');
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
  /** Set the typing callback after construction (e.g. when dashboard attaches). */
  setOnTyping(callback: GatewayRegistryOptions['onTyping']): void {
    this.onTypingCallback = callback ?? null;
  }

  /** Write/delete typing.json for cross-process communication with dashboard. */
  private writeTypingFile(event: { platform: string; channelId: string; typing: boolean }): void {
    try {
      const dir = join(resolveBuffConfigDir(), 'gateway');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const file = join(dir, 'typing.json');
      if (event.typing) {
        writeFileSync(file, JSON.stringify({ platform: event.platform, channelId: event.channelId, ts: Date.now() }), 'utf-8');
      } else if (existsSync(file)) {
        unlinkSync(file);
      }
    } catch { /* best-effort */ }
  }

  /**
   * Sender-facing line when the chat engine produced no answer. Contains NO
   * internal routing detail (intent, confidence, provider/model) and does not
   * claim "no model" when one is in fact configured — `generationFailed`
   * covers ALL hard provider failures (missing key, 401, rate limit, network,
   * every failover candidate down), so the two cases are reported separately.
   */
  private generationFailureLine(): string {
    if (!this.hasConfiguredModel()) {
      // The most common live case (observed): default config, defaultProvider
      // 'auto', no API keys. Auto only ranks providers WITH credentials, so it
      // has nothing to route to — but the failure surfaced as an opaque
      // "no model" line. Say what is actually wrong and how to fix it.
      return '🤖 No model is set up yet — Auto routing only picks providers you have credentials for. Add a provider key (or a local model) via `nuvira models`, then try again.';
    }
    return "🤖 I couldn't get an answer from the model just now — please try again in a moment. If it keeps happening, run `nuvira gateway status`.";
  }

  /**
   * True when the user actually has a model to call: a provider holding real
   * credentials, or a keyless/local runner with a CONCRETE model pin.
   *
   * The default config ships `nim/gemini/openrouter/groq/bedrock` with no keys
   * and `local: { runner: 'ollama', model: 'default' }` — none of that counts
   * as configured. A `'default'` local model is a sentinel, not a model. Only
   * used to choose the sender-facing failure wording — never to block a call.
   */
  private hasConfiguredModel(): boolean {
    try {
      const providers = this.configManager.getAll().providers ?? {};
      const check = (this.configManager as unknown as { hasRequiredCredentials?: (p: string) => boolean })
        .hasRequiredCredentials;
      for (const [name, cfg] of Object.entries(providers)) {
        if (!cfg) continue;
        if (name === 'local') {
          const model = typeof cfg.model === 'string' ? cfg.model : '';
          if (model && model !== 'default') return true;
          if (typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim()) return true;
          continue;
        }
        if (typeof check === 'function' && check.call(this.configManager, name)) return true;
      }
      return false;
    } catch {
      // A config read must never turn into a false "unconfigured" claim.
      return true;
    }
  }

  private async runInboundChat(msg: InboundMessage): Promise<{ content: string; generationFailed?: boolean }> {
    try {
      // Broadcast typing indicator start.
      this.onTypingCallback?.({ platform: msg.platform, channelId: msg.channelId, typing: true });
      this.writeTypingFile({ platform: msg.platform, channelId: msg.channelId, typing: true });
      const engine =
        this.chatEngine ??
        // Instantiate + cast: ChatCommand's answerOnce is a prototype method,
        // and the console's ChatEngine is the loose slice it satisfies (same
        // cast the dashboard chat-console uses).
        (new ((await import('../cli/chat.js')).ChatCommand)() as unknown as import('../web-dashboard/chat-console.js').ChatEngine);
      const origin = `${PLATFORM_LABELS[msg.platform]} ${msg.isGroup ? 'group' : 'chat'} ${msg.from ?? msg.senderId ?? msg.channelId}`;
      // Per-contact conversation history: load prior messages so the model has
      // context for follow-up questions (e.g. "what was the second option?").
      // The store retains the full 7-day horizon; the model sees the LAST
      // window (CHAT_HISTORY_MODEL_WINDOW messages) so prompts stay bounded.
      // NOTE: the inbound message for THIS turn was already recorded in
      // handleInbound — exclude it (and everything after it) so the model does
      // not see its own question twice in the prompt + history.
      const historyKey = `${msg.platform}:${msg.channelId}`;
      const priorWindow = this.chatStore.getFullHistory(historyKey);
      const history = priorWindow.slice(0, Math.max(0, priorWindow.length - 1)).slice(-12);
      // P5 — is this message a REPLY to a followup we just sent? (No chips on
      // WhatsApp/Telegram — the sender re-types the line.) If so it continues
      // the previous execution instead of starting a fresh request.
      const lastFollowups = this.lastFollowupsByContact.get(historyKey);
      const continuation = isSuggestedFollowup(msg.text, lastFollowups);
      // P2 — origin context: the chat model knows who it's talking to, so its
      // gateway_send calls target the right contact/channel.
      // The response format rules ensure the user gets a clean, direct answer
      // without leaked internal reasoning or planning.
      const prompt = [
        `[Origin: ${origin} — this message was sent from a messaging app (WhatsApp/Telegram/etc). Your text response is automatically delivered back to the sender — do NOT call gateway_send for this conversation unless you need to send to a DIFFERENT target.]`,
        '',
        'RESPONSE FORMAT (non-negotiable for messaging app replies):',
        '- If you need to think or plan, put your reasoning inside <think> and </think> tags. Only the text OUTSIDE these tags is shown to the user.',
        '- Deliver your answer DIRECTLY. No preamble, no "I would be happy to...", no restating the request.',
        '- Do NOT include planning, constraints, self-evaluation, or tool deliberation in your visible response. Put ALL reasoning in <think> tags.',
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
      // askUser on a channel. DEFAULT (askUserWait off): reply with the question
      // + choices and pick the first as a best-effort default — the historical
      // behaviour, matching the dashboard's non-TTY renderer. With
      // gateway.askUserWait ON, the turn HOLDS for the contact's reply instead
      // (see `awaitAskUserReply`), so a typed answer actually steers the run.
      // gateway: reuse THIS live registry so the model's gateway_send calls
      // deliver through the already-connected bridge — a fresh registry would
      // open a second WhatsApp connection and stall.
      // Routing directive: when the user's default is 'auto' (the product
      // default), pass 'auto' THROUGH so the engine's AutoModelRouter picks the
      // best available provider+model per message. Resolving it here via
      // getProviderConfig() would pin the session to one provider and silently
      // disable auto routing — and the config's `model: 'default'` SENTINEL is
      // not a real model id (providers reject it as "model not found").
      const routingDefault = (this.configManager.getAll() as { defaultProvider?: string }).defaultProvider;
      const useAuto = !routingDefault || routingDefault === 'auto';
      const { type: providerType, config: providerConfig } =
        this.configManager.getProviderConfig();
      const answer = await engine.answerOnce(prompt, {
        provider: useAuto ? 'auto' : providerType,
        model: useAuto ? 'auto' : providerConfig.model,
        history,
        // P5 — a replied followup carries the continuation marker into the
        // model thread (the previous answer is already in `history`).
        ...(continuation ? { continuation: true } : {}),
        // Inject prior conversation context so the model remembers previous
        // exchanges with this contact (follow-up questions, suggested followups).
        gateway: {
          send: (target, text) => this.send(target, text),
          // Verified delivery: `gateway_send` uses these to report WHY a send
          // failed (a bare `send` boolean hid a mistyped number behind a
          // generic "transport unreachable").
          sendToRef: (ref, text, target) => this.sendToRef(ref as ChannelRef, text, target),
          lastSendError: (ref) => this.lastSendError(ref as ChannelRef),
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
          const labels = (choices as Array<{ label: string }>).map((c) => c.label);
          const list = labels.map((l, i) => `${i + 1}. ${l}`).join('\n');
          const ref = { platform: msg.platform, channelId: msg.channelId };
          const fallback = { answer: labels[0] ?? 'skip', index: 0 };
          const waiting = this.askUserWaitEnabled();
          await this.sendToRef(
            ref,
            `🤔 ${question}\n${list}` +
              (waiting
                ? '\n\nReply with the number (or the option text) — I will wait.'
                : `\n\n(Going with 1. ${labels[0] ?? 'skip'} — reply to change it after this turn.)`),
          );
          if (!waiting) return fallback;
          return this.awaitAskUserReply(`${msg.platform}:${msg.channelId}`, labels, fallback, question);
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
      // HONESTY GUARD — the model sometimes says "I have sent …" WITHOUT
      // actually calling gateway_send. A JSON-as-text call is already salvaged
      // into a real call by the loop, but a model that emits NO tool call at
      // all leaves a false claim standing. Append a truthful correction so the
      // sender is never told an action succeeded when it did not.
      if (answer.unverifiedActionClaim) {
        logger.warn('gateway: answer claimed a delivery but no gateway_send executed — appending correction');
        content +=
          '\n\n⚠️ Heads-up: I could not confirm that message was actually sent — the send action did not complete. ' +
          'Please ask me to try again, or send it yourself.';
      }
      // HONESTY GUARD (dropped intent) — the reply closed on "I will now …" and
      // the turn ended having done nothing. In a messaging channel that reads
      // as work in progress, so say plainly that it has not happened.
      if (answer.unfulfilledPromise) {
        logger.warn('gateway: answer announced an action the turn never performed — appending correction');
        content +=
          '\n\n⚠️ Note: I described what I was about to do, but I did not actually carry it out yet. ' +
          'Reply "go ahead" and I will do it now.';
      }
      // v1.8x audit — LAST-RESORT sender guard: a reply that is pure
      // tool-contract confusion ("I'm sorry, but the provided example call to
      // suggest_followups is incomplete…") is internal scaffolding leaking to
      // a messaging-app sender. The loop now retries/failovers on it (see
      // looksLikeConfusedScaffoldingReply), so reaching here means every
      // candidate replied confusedly — send a helpful line instead of the
      // raw meta-talk (the raw text stays in the inbox ledger + chat trace).
      if (looksLikeConfusedScaffoldingReply(content)) {
        logger.warn(`gateway: suppressing contract-confusion reply (${content.length} chars)`);
        content = '🤖 Sorry — none of my language models could handle that request just now. Please try again in a moment, or rephrase it — you can also run `nuvira models` to check your model setup.';
      }
      // P5 — remember what we offered (for the next inbound), and render the
      // "Try next" list CLEAN + STRUCTURED through the shared normalizer.
      const normalized = normalizeFollowups(answer.followups);
      this.lastFollowupsByContact.set(historyKey, normalized);
      const fups = normalized.map((f) => f.prompt);
      if (fups.length > 0) {
        const suffix = `\n\nTry next:\n${fups.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
        // WhatsApp truncates ~4096 chars — the ANSWER is the deliverable, so
        // drop the followups (never the answer) when the message would exceed
        // the cap.
        if (content.length + suffix.length <= 4000) content += suffix;
      }
      // Store the assistant reply in the per-contact history so follow-up
      // questions have context (the user message was already recorded in
      // handleInbound — pass null to avoid a duplicate row). Persisted to disk
      // via GatewayChatStore so it survives gateway restarts. The store
      // handles trimming to max pairs.
      this.chatStore.append(historyKey, null, content);
      this.onTypingCallback?.({ platform: msg.platform, channelId: msg.channelId, typing: false });
      this.writeTypingFile({ platform: msg.platform, channelId: msg.channelId, typing: false });
      return { content, generationFailed: answer.generationFailed };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`gateway: inbound chat failed: ${message}`);
      logGatewayEvent('inbound.failed', {
        platform: msg.platform,
        channelId: msg.channelId,
        error: message,
      }, 'error');
      this.onTypingCallback?.({ platform: msg.platform, channelId: msg.channelId, typing: false });
      this.writeTypingFile({ platform: msg.platform, channelId: msg.channelId, typing: false });
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
        // The RAW error goes to the log; the SENDER gets a plain sentence.
        // Interpolating err.message here put provider wire errors (rate-limit
        // JSON, stack fragments) in front of a messaging-app user.
        logger.error(`⚠️ gateway error: ${err instanceof Error ? err.message : String(err)}`);
        await this.sendToRef(
          { platform: msg.platform, channelId: msg.channelId },
          `🤖 ${toUserFacingGenerationError(err)}`,
        );
      }
    };

    for (const adapter of this.adapters.values()) {
      if (!adapter.configured) continue;
      await this.startAdapter(adapter, onMessage);
    }

    // Liveness + adapter watchdog: writes the beat `gateway status` reads, and
    // retries any configured adapter that never came up (a transient network
    // error at boot used to leave that platform silently dead for the run).
    this.startLiveness();

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

  /**
   * Start ONE adapter and record its health. Never throws: a platform that
   * fails to start must not take the gateway down with it.
   */
  private async startAdapter(adapter: ChannelAdapter, onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const prior = this.adapterHealth.get(adapter.platform);
    try {
      await adapter.start(onMessage);
      logger.info(`gateway: ${adapter.describe()} started`);
      this.adapterHealth.set(adapter.platform, {
        platform: adapter.platform,
        configured: true,
        started: true,
        restarts: prior?.restarts ?? 0,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`gateway: failed to start ${adapter.describe()}: ${message}`);
      this.adapterHealth.set(adapter.platform, {
        platform: adapter.platform,
        configured: true,
        started: false,
        restarts: prior?.restarts ?? 0,
        lastError: message,
      });
      this.scheduleAdapterRetry(adapter.platform, prior?.restarts ?? 0);
    }
  }

  /** Max restart attempts per adapter per run — beyond this, stop the churn. */
  private static readonly ADAPTER_MAX_RESTARTS = 8;

  /** Exponential backoff between adapter restart attempts (5s → 120s). */
  private scheduleAdapterRetry(platform: Platform, restarts: number): void {
    if (restarts >= GatewayRegistry.ADAPTER_MAX_RESTARTS) {
      logger.error(`gateway: ${platform} gave up after ${restarts} restart attempts (check its credentials/network)`);
      return;
    }
    const delay = Math.min(5_000 * 2 ** restarts, 120_000);
    this.adapterRetryAt.set(platform, Date.now() + delay);
  }

  /**
   * The liveness tick: retry dead adapters, then write a beat. Runs on the
   * same interval for both, so a stalled process is visible as a stalled beat.
   */
  private startLiveness(): void {
    this.startedAt = Date.now();
    this.beatCount = 0;
    const tick = async (): Promise<void> => {
      await this.retryPendingAdapters();
      this.beatCount += 1;
      this.heartbeat.beat({
        startedAt: this.startedAt,
        beats: this.beatCount,
        supervised: envBuff('GATEWAY_SUPERVISED') === '1',
        supervisorPid: process.ppid || undefined,
        adapters: [...this.adapterHealth.values()],
      });
    };
    // First beat immediately, so `gateway status` is honest within a second of
    // startup instead of reporting the previous run's stale beat.
    void tick().catch(() => undefined);
    this.livenessTimer = setInterval(() => void tick().catch(() => undefined), HEARTBEAT_INTERVAL_MS);
  }

  /** Retry every configured adapter that is not currently started. */
  private async retryPendingAdapters(): Promise<void> {
    const now = Date.now();
    for (const adapter of this.adapters.values()) {
      if (!adapter.configured) continue;
      const health = this.adapterHealth.get(adapter.platform);
      if (health?.started) continue;
      const restarts = health?.restarts ?? 0;
      if (restarts >= GatewayRegistry.ADAPTER_MAX_RESTARTS) continue;
      const due = this.adapterRetryAt.get(adapter.platform) ?? 0;
      if (due > now) continue;
      logger.warn(`gateway: retrying ${adapter.platform} (attempt ${restarts + 1})`);
      this.adapterHealth.set(adapter.platform, {
        platform: adapter.platform,
        configured: true,
        started: false,
        restarts: restarts + 1,
        lastError: health?.lastError,
      });
      this.adapterRetryAt.delete(adapter.platform);
      const onMessage = async (msg: InboundMessage): Promise<void> => {
        try {
          await this.handleInbound(msg);
        } catch (err) {
          logger.error(`⚠️ gateway error: ${err instanceof Error ? err.message : String(err)}`);
          await this.sendToRef(
            { platform: msg.platform, channelId: msg.channelId },
            `🤖 ${toUserFacingGenerationError(err)}`,
          );
        }
      };
      // startAdapter preserves the incremented count and re-schedules the
      // next retry (with a longer backoff) when the attempt fails again.
      await this.startAdapter(adapter, onMessage);
    }
  }

  /**
   * Is ask-and-wait enabled? `gateway.askUserWait === true` only — an absent or
   * malformed value keeps the historical no-wait behaviour, so enabling this is
   * an explicit, deliberate act.
   */
  private askUserWaitEnabled(): boolean {
    try {
      return (this.configManager.getAll() as { gateway?: { askUserWait?: boolean } }).gateway?.askUserWait === true;
    } catch {
      return false;
    }
  }

  /**
   * How long to hold a turn for a reply. Clamped to 5s–10min so a bad config
   * value can neither hang a turn forever nor time out before the user can
   * physically read the question.
   */
  private askUserWaitTimeoutMs(): number {
    let raw = 120_000;
    try {
      const v = (this.configManager.getAll() as { gateway?: { askUserTimeoutMs?: unknown } }).gateway?.askUserTimeoutMs;
      if (typeof v === 'number' && Number.isFinite(v)) raw = v;
    } catch {
      // Absent/unreadable → the default window.
    }
    return Math.min(600_000, Math.max(5_000, Math.round(raw)));
  }

  /**
   * Hold the current turn until `key`'s contact replies, or the window lapses.
   *
   * The promise ALWAYS settles: the timeout resolves it with `fallback`, so a
   * silent contact costs one bounded wait and never a stuck gateway. The timer
   * is unref'd so a pending question cannot keep the process alive on shutdown.
   */
  private awaitAskUserReply(
    key: string,
    choices: string[],
    fallback: { answer: string; index: number },
    question: string,
  ): Promise<{ answer: string; index: number }> {
    // One waiter per contact: the older question gets its default and is
    // released (the model asked twice in one turn — the older answer cannot be
    // honoured once the newer question is on screen).
    this.releasePendingAsk(key, 'replaced by a newer question');

    const timeoutMs = this.askUserWaitTimeoutMs();
    return new Promise((resolve) => {
      const settle = (a: { answer: string; index: number }): void => {
        const entry = this.pendingQuestions.get(key);
        if (entry) clearTimeout(entry.timer);
        this.pendingQuestions.delete(key);
        resolve(a);
      };
      const timer = setTimeout(() => {
        logger.warn(
          `gateway: no reply to "${question.slice(0, 60)}" within ${Math.round(timeoutMs / 1000)}s — using "${fallback.answer}".`,
        );
        settle(fallback);
      }, timeoutMs);
      // Never hold the event loop open for a question nobody will answer.
      if (typeof timer.unref === 'function') timer.unref();
      this.pendingQuestions.set(key, { choices, resolve: settle, timer, askedAt: Date.now(), question });
    });
  }

  /** Release a waiter with its default (timeout, replacement, or shutdown). */
  private releasePendingAsk(key: string, why: string): boolean {
    const entry = this.pendingQuestions.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pendingQuestions.delete(key);
    logger.info(
      `gateway: releasing pending question "${entry.question.slice(0, 60)}" — ${why}; using "${entry.choices[0] ?? 'skip'}".`,
    );
    entry.resolve({ answer: entry.choices[0] ?? 'skip', index: 0 });
    return true;
  }

  /**
   * Resolve an awaiting question from the contact's next message. Returns a
   * user-facing confirmation when the reply matched a choice, or `null` when it
   * did not — in which case the waiter is released with its default and the
   * message falls through to NORMAL handling. Failing open is the invariant: a
   * message is never swallowed by the question machinery.
   */
  private consumePendingAsk(msg: InboundMessage): string | null {
    const key = `${msg.platform}:${msg.channelId}`;
    const entry = this.pendingQuestions.get(key);
    if (!entry) return null;
    const match = matchAskUserChoice(msg.text, entry.choices);
    if (!match) {
      // Not an answer to the question — release with the default and let the
      // text be handled as a new request rather than dropping it.
      this.releasePendingAsk(key, 'reply did not match any choice');
      return null;
    }
    clearTimeout(entry.timer);
    this.pendingQuestions.delete(key);
    logger.info(
      `gateway: pending question answered with "${match.answer}" (choice ${match.index + 1}/${entry.choices.length}).`,
    );
    entry.resolve(match);
    return `👍 Got it — using "${match.answer}".`;
  }

  /** Stop adapters + unsubscribe + stop the delivery drain. Idempotent. */
  async stop(): Promise<void> {
    // Release every awaiting question FIRST, and before the `started` guard: a
    // turn blocked on a reply must not outlive the gateway, and stop() is also
    // called on registries that were never started (early shutdown, tests).
    for (const key of [...this.pendingQuestions.keys()]) {
      this.releasePendingAsk(key, 'gateway is shutting down');
    }
    if (!this.started) return;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    // A clean shutdown removes the beat: `gateway status` must then say "down",
    // not "stale", so the operator knows this was intentional.
    this.heartbeat.clear();
    if (this.deliveryTimer) {
      clearInterval(this.deliveryTimer);
      this.deliveryTimer = null;
    }
    for (const adapter of this.adapters.values()) {
      try { await adapter.stop(); } catch { /* best-effort */ }
    }
  }
}
