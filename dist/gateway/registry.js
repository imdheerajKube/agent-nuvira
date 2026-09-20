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
import { envBuff } from '../config/paths.js';
import { parseRequestSync } from '../nlu/parser.js';
import { getEventBus, EventNames } from '../observability/event-bus.js';
import { ConfigManager } from '../config/manager.js';
import { ChannelDirectory, PLATFORM_ENV_VARS, PLATFORM_LABELS, } from './channel-directory.js';
import { DeliveryLedger } from './delivery.js';
import { InboxLedger } from './inbox.js';
import { InboundDedupLedger } from './dedup.js';
import { GatewayHeartbeat, HEARTBEAT_INTERVAL_MS } from './heartbeat.js';
import { hasCodingAction, looksLikeAgentCliAsk, resolveAskKind } from '../nlu/conversation-gate.js';
import { GatewayChatStore } from './chat-store.js';
import { looksLikeConfusedScaffoldingReply, toUserFacingGenerationError } from '../inference/tool-call-utils.js';
import { logger } from '../utils/logger.js';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBuffConfigDir } from '../config/paths.js';
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
export function stripGatewayReasoning(text) {
    if (!text)
        return text;
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
export function hasDeliveryAsk(text) {
    // A delivery verb + a recipient marker (to/for a person/group, or a direct
    // pronoun recipient: "email me the report"). "add auth to the API" has "to"
    // but no delivery verb → stays a pure pipeline task; "implement the send
    // feature" has the verb but no recipient → also stays pipeline.
    return /\b(send|message|email|text|notify|deliver|share|forward|post|dm)\b/i.test(text) &&
        /\b(to|for|me|us|them|him|her)\b/i.test(text);
}
// ─── Reply formatting ───────────────────────────────────────────────────────
/** Compact one-line status from a board event (E2 events → channel text). */
export function eventToStatusLine(event, data) {
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
export function normalizeSenderId(id) {
    if (!id)
        return '';
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
export function isAllowAllToken(value) {
    const v = (value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    return v === 'allowall' || v === '*';
}
/**
 * True when the per-user verifier is ENABLED for a policy: an `allowedUsers`
 * array is present AND it holds no "Allow-All" wildcard. An EMPTY array is a
 * REAL gate (verified-list rule: blank = NO ONE may trigger); only an ABSENT
 * list keeps the legacy open default (everyone allowed).
 */
function userGateEnabled(policy) {
    return Array.isArray(policy?.allowedUsers) && !policy.allowedUsers.some(isAllowAllToken);
}
/**
 * Sender passes the verified list: "Allow-All" wildcard (anyone) or an exact
 * JID-normalized match (the bridge delivers "918811122233:13@s.whatsapp.net"
 * while the list holds "+918811122233" — both normalize to the same digits).
 */
function isVerifiedSender(policy, senderId) {
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
export function passesSenderList(list, senderId) {
    if (!Array.isArray(list))
        return true;
    if (list.some(isAllowAllToken))
        return true;
    const norm = normalizeSenderId(senderId);
    return norm.length > 0 && list.some((u) => normalizeSenderId(u) === norm);
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
export function authorizeOutboundSend(opts) {
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
            reason: 'send authority: you are not authorised to send messages to other people through this agent. ' +
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
export function isBotAddressed(text) {
    const t = (text || '').trim();
    if (/^@?(buff|agent-nuvira|nuvira)\b/i.test(t))
        return true;
    if (/@(buff|agent-nuvira)\b/i.test(t))
        return true;
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
export function envPolicies() {
    const truthy = (v) => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase());
    const split = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const globalUsers = split(envBuff('GATEWAY_ALLOWED_USERS'));
    const globalGroups = split(envBuff('GATEWAY_ALLOWED_GROUPS'));
    const globalMention = truthy(envBuff('GATEWAY_REQUIRE_MENTION'));
    const disabled = split(envBuff('GATEWAY_DISABLED_PLATFORMS'));
    const out = {};
    for (const p of Object.keys(PLATFORM_ENV_VARS)) {
        const key = p.toUpperCase();
        const pol = {};
        const users = split(process.env[`BUFF_GATEWAY_ALLOWED_USERS_${key}`]);
        if ((users.length ? users : globalUsers).length)
            pol.allowedUsers = users.length ? users : globalUsers;
        const groups = split(process.env[`BUFF_GATEWAY_ALLOWED_GROUPS_${key}`]);
        if ((groups.length ? groups : globalGroups).length)
            pol.allowedGroups = groups.length ? groups : globalGroups;
        if (globalMention || truthy(process.env[`BUFF_GATEWAY_REQUIRE_MENTION_${key}`]))
            pol.requireMention = true;
        if (disabled.includes(p))
            pol.disabled = true;
        if (Object.keys(pol).length)
            out[p] = pol;
    }
    return out;
}
export class GatewayRegistry {
    directory;
    /** I2 — guaranteed-delivery ledger for failed sends. */
    delivery;
    /** P2 — inbound message inbox (who messaged the bot, what happened). */
    inbox;
    /**
     * Idempotency ledger: a message delivered twice (bridge reconnect, offline
     * backfill, webhook retry) is handled once. Without it, one WhatsApp ask
     * became 20+ identical model turns — see dedup.ts.
     */
    dedup;
    /**
     * Liveness beat — so a gateway that is DOWN is visibly down instead of
     * "configured ✅ but nobody home". Read by `gateway status` and the
     * supervisor.
     */
    heartbeat;
    adapters = new Map();
    configManager;
    options;
    /** Explicit per-platform policies (tests / programmatic use) — kept so the
     *  per-inbound live re-read merges them on top of env + config instead of
     *  dropping them. */
    explicitPolicies;
    policies;
    unsubscribe = null;
    deliveryTimer = null;
    /** Channel the last inbound message came from (for event streaming). */
    activeChannel = null;
    /** Serializes inbound pipeline runs so board events stream to the RIGHT channel. */
    runChain = Promise.resolve();
    /** Serializes delivery drains — concurrent timer/CLI/opportunistic drains
     *  must never read the same pending entry twice (double-send + attempt
     *  double-count would prematurely fail entries). */
    drainChain = Promise.resolve();
    started = false;
    /** Epoch ms of start() — the uptime reported in the heartbeat. */
    startedAt = 0;
    /** Beats written this run (monotonic; a stalled count means a stalled loop). */
    beatCount = 0;
    /** Per-adapter health, published in every beat. */
    adapterHealth = new Map();
    /** Earliest epoch-ms at which a not-yet-started adapter may be retried. */
    adapterRetryAt = new Map();
    /** The heartbeat + watchdog tick. */
    livenessTimer = null;
    chatEngine;
    /** Per-contact conversation history for gateway chat (WhatsApp/Telegram/etc.).
     *  Disk-backed via GatewayChatStore so history survives gateway restarts. */
    chatStore;
    /**
     * P5 — the followups last offered to each contact (`platform:channelId`).
     * A messaging-app sender has no clickable chips: they REPLY with one of the
     * rendered lines, so this is the only way to know the message is a follow-up
     * to the previous answer rather than a brand-new independent request.
     */
    lastFollowupsByContact = new Map();
    onTypingCallback = null;
    constructor(options = {}, configManager) {
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
    readPolicies() {
        const fromConfig = this.configManager.getAll().gateway?.policies;
        // The config shape stores the same fields; cast through the typed view.
        // Explicit options are MOST specific (they win over env + config) — the
        // same precedence the constructor used before the live re-read existed.
        return { ...envPolicies(), ...(fromConfig ?? {}), ...this.explicitPolicies };
    }
    /**
     * Channel targets that ALWAYS receive pipeline completion summaries
     * (config `gateway.statusRecipients`, live re-read per pipeline so the
     * CLI/dashboard apply without a restart). Alias or platform:channelId.
     */
    readStatusRecipients() {
        const fromConfig = this.configManager.getAll().gateway?.statusRecipients;
        return Array.isArray(fromConfig) ? fromConfig : [];
    }
    /**
     * Forward a pipeline completion summary to every configured status
     * recipient (best-effort — a bad target is warned, never throws, and never
     * blocks the originating reply). Resolves aliases like any gateway send.
     */
    async notifyStatusRecipients(summary) {
        for (const target of this.readStatusRecipients()) {
            const ok = await this.send(target, `📊 Pipeline status — ${summary}`);
            if (!ok)
                logger.warn(`gateway: status recipient '${target}' unreachable — delivery enqueued for retry`);
        }
    }
    /** Register an adapter (idempotent per platform). */
    register(adapter) {
        this.adapters.set(adapter.platform, adapter);
    }
    /** All registered adapters. */
    adaptersList() {
        return [...this.adapters.values()];
    }
    /** Whether any adapter is configured with a token. */
    hasConfiguredAdapter() {
        return [...this.adapters.values()].some((a) => a.configured);
    }
    /** Send a text message to a channel target (alias or platform:channelId). */
    async send(target, text) {
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
    async sendMediaToRef(ref, media) {
        const adapter = this.adapters.get(ref.platform);
        if (!adapter || !adapter.configured || !adapter.sendMedia)
            return false;
        return adapter.sendMedia(ref.channelId, media);
    }
    /** Send to an explicit channel ref. I2: a failed send is ledgered for retry. */
    async sendToRef(ref, text, target) {
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
    async drainDelivery() {
        const run = this.drainChain.then(() => this.delivery.processDue((entry) => this.sendEntry(entry)));
        this.drainChain = run.then(() => undefined, () => undefined);
        return run;
    }
    /** One ledger entry send through the registered adapter (shared by drains). */
    async sendEntry(entry) {
        const adapter = this.adapters.get(entry.platform);
        if (!adapter || !adapter.configured) {
            return { ok: false, error: `adapter for '${entry.platform}' not configured` };
        }
        const ok = await adapter.send(entry.channelId, entry.text);
        return ok ? { ok: true } : { ok: false, error: 'send failed' };
    }
    /** Drain due entries for one platform only (opportunistic flush, serialized). */
    drainForPlatform(platform) {
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
    async handleInbound(msg) {
        // Auto-learn Telegram chat IDs: when a message arrives from a Telegram
        // user, update any contact/alias that used a phone number format.
        // Also auto-registers new users with status: 'pending' for admin approval.
        if (msg.platform === 'telegram' && msg.senderId) {
            void this.learnTelegramChatId(msg.senderId, msg.channelId, msg.from).catch(() => { });
        }
        const ref = { platform: msg.platform, channelId: msg.channelId };
        const replyTo = async (text) => {
            await this.sendToRef(ref, text);
        };
        const record = (handled, reply, dup) => {
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
        const refuse = async (why) => {
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
        }
        else if (userGateEnabled(policy) && !isVerifiedSender(policy, msg.senderId)) {
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
            logger.info(`gateway: duplicate inbound (${dedupVerdict.kind}, delivery #${dedupVerdict.count}) — ignored`);
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
        }
        catch {
            /* best-effort */
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
        logger.debug(`gateway: route ${askKind} (intent ${parsed.intent} @ ${parsed.confidence.toFixed(2)}, coding=${hasCodingAction(msg.text)})`);
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
            const line = answer && answer.content.trim() && !answer.generationFailed
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
        const run = this.runChain.then(async () => {
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
                for (const line of result.details.slice(0, 6))
                    lines.push(`• ${line}`);
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
    /** Set the typing callback after construction (e.g. when dashboard attaches). */
    setOnTyping(callback) {
        this.onTypingCallback = callback ?? null;
    }
    /** Write/delete typing.json for cross-process communication with dashboard. */
    writeTypingFile(event) {
        try {
            const dir = join(resolveBuffConfigDir(), 'gateway');
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
            const file = join(dir, 'typing.json');
            if (event.typing) {
                writeFileSync(file, JSON.stringify({ platform: event.platform, channelId: event.channelId, ts: Date.now() }), 'utf-8');
            }
            else if (existsSync(file)) {
                unlinkSync(file);
            }
        }
        catch { /* best-effort */ }
    }
    /**
     * Sender-facing line when the chat engine produced no answer. Contains NO
     * internal routing detail (intent, confidence, provider/model) and does not
     * claim "no model" when one is in fact configured — `generationFailed`
     * covers ALL hard provider failures (missing key, 401, rate limit, network,
     * every failover candidate down), so the two cases are reported separately.
     */
    generationFailureLine() {
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
    hasConfiguredModel() {
        try {
            const providers = this.configManager.getAll().providers ?? {};
            const check = this.configManager
                .hasRequiredCredentials;
            for (const [name, cfg] of Object.entries(providers)) {
                if (!cfg)
                    continue;
                if (name === 'local') {
                    const model = typeof cfg.model === 'string' ? cfg.model : '';
                    if (model && model !== 'default')
                        return true;
                    if (typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim())
                        return true;
                    continue;
                }
                if (typeof check === 'function' && check.call(this.configManager, name))
                    return true;
            }
            return false;
        }
        catch {
            // A config read must never turn into a false "unconfigured" claim.
            return true;
        }
    }
    async runInboundChat(msg) {
        try {
            // Broadcast typing indicator start.
            this.onTypingCallback?.({ platform: msg.platform, channelId: msg.channelId, typing: true });
            this.writeTypingFile({ platform: msg.platform, channelId: msg.channelId, typing: true });
            const engine = this.chatEngine ??
                // Instantiate + cast: ChatCommand's answerOnce is a prototype method,
                // and the console's ChatEngine is the loose slice it satisfies (same
                // cast the dashboard chat-console uses).
                new ((await import('../cli/chat.js')).ChatCommand)();
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
            // askUser must never hang the gateway on a TTY: when the model needs a
            // clarification, reply to the channel with the question + choices and
            // pick the first as a best-effort default (the user can answer on the
            // next message). Matches the dashboard's non-TTY renderer.
            // gateway: reuse THIS live registry so the model's gateway_send calls
            // deliver through the already-connected bridge — a fresh registry would
            // open a second WhatsApp connection and stall.
            // Routing directive: when the user's default is 'auto' (the product
            // default), pass 'auto' THROUGH so the engine's AutoModelRouter picks the
            // best available provider+model per message. Resolving it here via
            // getProviderConfig() would pin the session to one provider and silently
            // disable auto routing — and the config's `model: 'default'` SENTINEL is
            // not a real model id (providers reject it as "model not found").
            const routingDefault = this.configManager.getAll().defaultProvider;
            const useAuto = !routingDefault || routingDefault === 'auto';
            const { type: providerType, config: providerConfig } = this.configManager.getProviderConfig();
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
                    sendMedia: (target, media) => {
                        const ref = this.directory.resolve(target);
                        if (!ref)
                            return Promise.resolve(false);
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
                    const list = choices.map((c, i) => `${i + 1}. ${c.label}`).join('\n');
                    await this.sendToRef({ platform: msg.platform, channelId: msg.channelId }, `🤔 ${question}\n${list}`);
                    return { answer: choices[0]?.label ?? 'skip', index: 0 };
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
                if (content.length + suffix.length <= 4000)
                    content += suffix;
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
        }
        catch (err) {
            logger.error(`gateway: inbound chat failed: ${err instanceof Error ? err.message : String(err)}`);
            this.onTypingCallback?.({ platform: msg.platform, channelId: msg.channelId, typing: false });
            this.writeTypingFile({ platform: msg.platform, channelId: msg.channelId, typing: false });
            return { content: '', generationFailed: true };
        }
    }
    /** Allow-list check: no allowIds configured = everyone; else exact platform:channelId. */
    isAllowed(ref) {
        if (!this.options.allowIds || this.options.allowIds.length === 0)
            return true;
        return this.options.allowIds.includes(`${ref.platform}:${ref.channelId}`);
    }
    // ─── Lifecycle ────────────────────────────────────────────────────────────
    /** Start all registered adapters + the event-bus stream. Idempotent. */
    async start() {
        if (this.started)
            return;
        this.started = true;
        // Prune stale conversations on startup (best-effort).
        this.chatStore.prune();
        const onMessage = async (msg) => {
            try {
                await this.handleInbound(msg);
            }
            catch (err) {
                // The RAW error goes to the log; the SENDER gets a plain sentence.
                // Interpolating err.message here put provider wire errors (rate-limit
                // JSON, stack fragments) in front of a messaging-app user.
                logger.error(`⚠️ gateway error: ${err instanceof Error ? err.message : String(err)}`);
                await this.sendToRef({ platform: msg.platform, channelId: msg.channelId }, `🤖 ${toUserFacingGenerationError(err)}`);
            }
        };
        for (const adapter of this.adapters.values()) {
            if (!adapter.configured)
                continue;
            await this.startAdapter(adapter, onMessage);
        }
        // Liveness + adapter watchdog: writes the beat `gateway status` reads, and
        // retries any configured adapter that never came up (a transient network
        // error at boot used to leave that platform silently dead for the run).
        this.startLiveness();
        if (this.options.streamEvents) {
            this.unsubscribe = getEventBus().on('*', (record) => {
                if (!this.activeChannel)
                    return;
                const line = eventToStatusLine(record.event, record.data);
                if (line)
                    void this.sendToRef(this.activeChannel, line);
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
    async learnTelegramChatId(senderId, channelId, senderName) {
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
            if (aliasUpdated)
                writeAliases(aliases);
            if (updated || aliasUpdated) {
                logger.info(`gateway: Telegram chat ID learned from incoming message: ${channelId}`);
            }
        }
        catch {
            /* best-effort — never break the pipeline */
        }
    }
    /**
     * Start ONE adapter and record its health. Never throws: a platform that
     * fails to start must not take the gateway down with it.
     */
    async startAdapter(adapter, onMessage) {
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
        }
        catch (err) {
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
    static ADAPTER_MAX_RESTARTS = 8;
    /** Exponential backoff between adapter restart attempts (5s → 120s). */
    scheduleAdapterRetry(platform, restarts) {
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
    startLiveness() {
        this.startedAt = Date.now();
        this.beatCount = 0;
        const tick = async () => {
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
    async retryPendingAdapters() {
        const now = Date.now();
        for (const adapter of this.adapters.values()) {
            if (!adapter.configured)
                continue;
            const health = this.adapterHealth.get(adapter.platform);
            if (health?.started)
                continue;
            const restarts = health?.restarts ?? 0;
            if (restarts >= GatewayRegistry.ADAPTER_MAX_RESTARTS)
                continue;
            const due = this.adapterRetryAt.get(adapter.platform) ?? 0;
            if (due > now)
                continue;
            logger.warn(`gateway: retrying ${adapter.platform} (attempt ${restarts + 1})`);
            this.adapterHealth.set(adapter.platform, {
                platform: adapter.platform,
                configured: true,
                started: false,
                restarts: restarts + 1,
                lastError: health?.lastError,
            });
            this.adapterRetryAt.delete(adapter.platform);
            const onMessage = async (msg) => {
                try {
                    await this.handleInbound(msg);
                }
                catch (err) {
                    logger.error(`⚠️ gateway error: ${err instanceof Error ? err.message : String(err)}`);
                    await this.sendToRef({ platform: msg.platform, channelId: msg.channelId }, `🤖 ${toUserFacingGenerationError(err)}`);
                }
            };
            // startAdapter preserves the incremented count and re-schedules the
            // next retry (with a longer backoff) when the attempt fails again.
            await this.startAdapter(adapter, onMessage);
        }
    }
    /** Stop adapters + unsubscribe + stop the delivery drain. Idempotent. */
    async stop() {
        if (!this.started)
            return;
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
            try {
                await adapter.stop();
            }
            catch { /* best-effort */ }
        }
    }
}
//# sourceMappingURL=registry.js.map