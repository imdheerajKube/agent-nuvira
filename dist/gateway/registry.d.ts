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
import { ConfigManager } from '../config/manager.js';
import { ChannelDirectory, type ChannelRef, type PolicyMap } from './channel-directory.js';
import type { ChannelAdapter, InboundMessage, MediaPayload } from './adapters.js';
import { DeliveryLedger } from './delivery.js';
import { InboxLedger } from './inbox.js';
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
export declare function stripGatewayReasoning(text: string): string;
/**
 * Does a request ask to DELIVER something to someone (send/message/email/text
 * … to/for a recipient)? Used to route pipeline intents that ALSO ask for
 * delivery through the agent loop (which can compose build/repair →
 * gateway_send) instead of the bare orchestrator (which cannot deliver).
 */
export declare function hasDeliveryAsk(text: string): boolean;
/** Compact one-line status from a board event (E2 events → channel text). */
export declare function eventToStatusLine(event: string, data: any): string | null;
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
export declare function normalizeSenderId(id: string | undefined): string;
/**
 * True for the special "Allow-All" wildcard token in a verified list
 * (case-insensitive "Allow-All" / "allowall" / "allow all" / "*"): when
 * present, the sender verifier is SKIPPED entirely and anyone may trigger.
 */
export declare function isAllowAllToken(value: string | undefined): boolean;
/** True when a group message addresses the bot (name-prefix or @-mention). */
export declare function isBotAddressed(text: string): boolean;
/**
 * Build the per-platform policy map from env vars (config + explicit options
 * are merged over this in the constructor):
 *   BUFF_GATEWAY_ALLOWED_USERS[_{PLATFORM}]      — sender ids allowed to trigger
 *   BUFF_GATEWAY_ALLOWED_GROUPS[_{PLATFORM}]     — group ids allowed to trigger
 *   BUFF_GATEWAY_REQUIRE_MENTION[_{PLATFORM}]    — address-only mode (groups)
 *   BUFF_GATEWAY_DISABLED_PLATFORMS              — platforms fully off
 */
export declare function envPolicies(): PolicyMap;
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
    onTyping?: (event: {
        platform: string;
        channelId: string;
        typing: boolean;
    }) => void;
}
export declare class GatewayRegistry {
    readonly directory: ChannelDirectory;
    /** I2 — guaranteed-delivery ledger for failed sends. */
    readonly delivery: DeliveryLedger;
    /** P2 — inbound message inbox (who messaged the bot, what happened). */
    readonly inbox: InboxLedger;
    private adapters;
    private configManager;
    private options;
    /** Explicit per-platform policies (tests / programmatic use) — kept so the
     *  per-inbound live re-read merges them on top of env + config instead of
     *  dropping them. */
    private explicitPolicies;
    private policies;
    private unsubscribe;
    private deliveryTimer;
    /** Channel the last inbound message came from (for event streaming). */
    private activeChannel;
    /** Serializes inbound pipeline runs so board events stream to the RIGHT channel. */
    private runChain;
    /** Serializes delivery drains — concurrent timer/CLI/opportunistic drains
     *  must never read the same pending entry twice (double-send + attempt
     *  double-count would prematurely fail entries). */
    private drainChain;
    private started;
    private chatEngine;
    /** Per-contact conversation history for gateway chat (WhatsApp/Telegram/etc.).
     *  Disk-backed via GatewayChatStore so history survives gateway restarts. */
    private chatStore;
    private onTypingCallback;
    constructor(options?: GatewayRegistryOptions, configManager?: ConfigManager);
    /**
     * Build the effective policy map: explicit options < env < config (most
     * specific wins — same merge the constructor uses, re-run per inbound so
     * dashboard/CLI changes apply to the running gateway without a restart).
     * ConfigManager's statSync re-read is ~µs; the JSON parse only happens when
     * the config file actually changed.
     */
    private readPolicies;
    /**
     * Channel targets that ALWAYS receive pipeline completion summaries
     * (config `gateway.statusRecipients`, live re-read per pipeline so the
     * CLI/dashboard apply without a restart). Alias or platform:channelId.
     */
    private readStatusRecipients;
    /**
     * Forward a pipeline completion summary to every configured status
     * recipient (best-effort — a bad target is warned, never throws, and never
     * blocks the originating reply). Resolves aliases like any gateway send.
     */
    private notifyStatusRecipients;
    /** Register an adapter (idempotent per platform). */
    register(adapter: ChannelAdapter): void;
    /** All registered adapters. */
    adaptersList(): ChannelAdapter[];
    /** Whether any adapter is configured with a token. */
    hasConfiguredAdapter(): boolean;
    /** Send a text message to a channel target (alias or platform:channelId). */
    send(target: string, text: string): Promise<boolean>;
    /**
     * P3 — send media to a channel ref. Adapters that implement the optional
     * `sendMedia` (WhatsApp, Telegram, Discord) support it; others return false
     * (caller reports why). Called as a method so `this` stays bound.
     */
    sendMediaToRef(ref: ChannelRef, media: MediaPayload): Promise<boolean>;
    /** Send to an explicit channel ref. I2: a failed send is ledgered for retry. */
    sendToRef(ref: ChannelRef, text: string, target?: string): Promise<boolean>;
    /**
     * Attempt all due pending delivery entries through the registered adapters.
     * Returns the counters (public so the CLI `nuvira gateway delivery --flush`
     * and tests can drive it directly). Serialized on the drain chain.
     */
    drainDelivery(): Promise<{
        processed: number;
        sent: number;
        failed: number;
    }>;
    /** One ledger entry send through the registered adapter (shared by drains). */
    private sendEntry;
    /** Drain due entries for one platform only (opportunistic flush, serialized). */
    private drainForPlatform;
    /**
     * Handle an inbound channel message: parse → policy-gate → dispatch → reply.
     * Non-pipeline messages reply with a short intent/help line (unless
     * pipelineOnly). Never throws — a failed pipeline replies with the error.
     * Pipeline runs are SERIALIZED so board events stream to the originating
     * channel (a second message while a run is active queues behind it).
     * Every message is recorded in the inbox (P2) with its disposition.
     */
    handleInbound(msg: InboundMessage): Promise<string>;
    /**
     * Chat-intent answer (write/explain/ask): run ONE tool-loop turn through the
     * SAME engine the dashboard chat console uses (ChatCommand.answerOnce), so
     * a WhatsApp request like "write a poem and send it to Alex" is answered
     * AND delivered (the model's toolset includes gateway_send). Lazy-imported
     * so a gateway that only ever runs pipelines never pays for the CLI router.
     * Never throws — a model failure falls back to the help line in handleInbound.
     */
    /** Set the typing callback after construction (e.g. when dashboard attaches). */
    setOnTyping(callback: GatewayRegistryOptions['onTyping']): void;
    /** Write/delete typing.json for cross-process communication with dashboard. */
    private writeTypingFile;
    private runInboundChat;
    /** Allow-list check: no allowIds configured = everyone; else exact platform:channelId. */
    private isAllowed;
    /** Start all registered adapters + the event-bus stream. Idempotent. */
    start(): Promise<void>;
    /**
     * Auto-learn Telegram chat IDs: when a message arrives from a Telegram user,
     * update any contact/alias that used a phone number format with the real
     * numeric chat ID. Also auto-registers new users with status: 'pending'
     * for admin approval. Uses the sender's Telegram first_name as the
     * display name.
     */
    private learnTelegramChatId;
    /** Stop adapters + unsubscribe + stop the delivery drain. Idempotent. */
    stop(): Promise<void>;
}
//# sourceMappingURL=registry.d.ts.map