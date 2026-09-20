/**
 * J1 — Channel adapters (a transport model shared across messaging platforms).
 *
 * All adapters are OPT-IN via env bot tokens (see channel-directory.ts). They
 * use Node's built-in fetch against the official bot APIs — deliberately NO
 * SDK dependencies (grammY/discord.js/@slack/web-api would add hundreds of
 * packages for the same REST calls), matching the free-first/lean philosophy
 * of the rest of the codebase. Each adapter is a thin transport: poll/receive
 * inbound messages → call the registry handler; send replies → POST the text.
 *
 * Telegram uses long-polling (getUpdates) — no public webhook URL needed.
 * Discord/Slack/WhatsApp use incoming webhooks for SEND and an optional local
 * HTTP listener for inbound (webhook mode).
 */
import type { Platform } from './channel-directory.js';
import type { WhatsAppBridge } from './whatsapp/bridge.js';
export interface InboundMessage {
    platform: Platform;
    /** Channel id (chat id / webhook channel id) to REPLY to. */
    channelId: string;
    /** Message text. */
    text: string;
    /** Human sender label (for the board/logs). */
    from?: string;
    /**
     * P1 — the real sender id (used by per-user policies). For DMs this is the
     * channel's owner; inside a group it is the actual author (WhatsApp
     * `key.participant`, Telegram `from.id`, Slack `event.user`, …).
     */
    senderId?: string;
    /** P1 — true when the message came from a group/channel, not a DM. */
    isGroup?: boolean;
    /**
     * The transport's own message id, when the adapter exposes one (WhatsApp
     * `key.id`, Telegram `message_id`, Slack `ts`, …). The gateway dedups on it
     * so a re-delivered message (bridge reconnect, offline backfill, webhook
     * retry) is handled ONCE. Adapters that expose no id leave it undefined and
     * every delivery is treated as new (content dedup is opt-in — see dedup.ts).
     */
    messageId?: string;
}
/** The handler an adapter calls for every inbound message. */
export type MessageHandler = (msg: InboundMessage) => void | Promise<void>;
/** P3 — media payload for `sendMedia` (image/video/audio/document upload). */
export interface MediaPayload {
    type: 'image' | 'video' | 'audio' | 'document';
    data: Uint8Array;
    caption?: string;
    filename?: string;
}
export interface ChannelAdapter {
    readonly platform: Platform;
    /** True when the transport token/env is present (opt-in). */
    readonly configured: boolean;
    /** Human description for `nuvira gateway status`. */
    describe(): string;
    /** Start receiving inbound messages (long-poll or webhook server). */
    start(onMessage: MessageHandler): Promise<void>;
    /** Stop receiving (idempotent). */
    stop(): Promise<void>;
    /** Send a text message to a channel. Never throws — returns success. */
    send(channelId: string, text: string): Promise<boolean>;
    /**
     * P3 — optional media send. Adapters whose transport supports file uploads
     * (WhatsApp, Telegram, Discord) implement it; the registry dispatches via
     * `sendMediaToRef`. Never throws — returns success.
     */
    sendMedia?(channelId: string, media: MediaPayload): Promise<boolean>;
}
/** Sanitize an outbound message: strip control chars, cap length. */
export declare function sanitizeOutbound(text: string, max?: number): string;
/** Default upload filename per media type (when the caller omits one). */
export declare function defaultMediaFilename(type: MediaPayload['type']): string;
/**
 * Telegram adapter via the Bot API long-poll (`getUpdates`). No public webhook
 * URL required — ideal for a local CLI gateway. Pure fetch, no grammY.
 */
export declare class TelegramAdapter implements ChannelAdapter {
    readonly platform: "telegram";
    readonly configured: boolean;
    private token;
    private offset;
    private running;
    private timer;
    private handler;
    private readonly pollIntervalMs;
    constructor(token?: string, pollIntervalMs?: number);
    describe(): string;
    private api;
    start(onMessage: MessageHandler): Promise<void>;
    stop(): Promise<void>;
    send(channelId: string, text: string): Promise<boolean>;
    /**
     * P3 — media upload via the Bot API multipart endpoints
     * (sendPhoto/sendVideo/sendAudio/sendDocument). FormData keeps the content
     * type + boundary correct — no manual multipart encoding.
     */
    sendMedia(channelId: string, media: MediaPayload): Promise<boolean>;
}
/**
 * Base webhook adapter: outbound via an incoming-webhook URL (pure fetch).
 * Inbound uses an optional shared HTTP listener (see startWebhookReceiver).
 */
export declare abstract class WebhookChannelAdapter implements ChannelAdapter {
    abstract readonly platform: Platform;
    abstract readonly webhookEnvVar: string;
    abstract readonly tokenEnvVar: string;
    abstract readonly configured: boolean;
    protected webhookUrl: string;
    protected token: string;
    abstract describe(): string;
    /** The outbound endpoint for this platform. */
    protected abstract sendUrl(channelId: string): string;
    /** The platform-specific payload for a text message. */
    protected abstract payloadFor(channelId: string, text: string): unknown;
    /** Extra outbound headers (e.g. protocol markers like weixin's ilink). */
    protected extraHeaders(): Record<string, string>;
    start(_onMessage: MessageHandler): Promise<void>;
    stop(): Promise<void>;
    send(channelId: string, text: string): Promise<boolean>;
}
/** Discord — send via incoming webhook URL (BUFF_DISCORD_WEBHOOK_URL). */
export declare class DiscordAdapter extends WebhookChannelAdapter {
    readonly platform: "discord";
    readonly webhookEnvVar = "BUFF_DISCORD_WEBHOOK_URL";
    readonly tokenEnvVar = "BUFF_DISCORD_BOT_TOKEN";
    readonly configured: boolean;
    constructor();
    describe(): string;
    protected sendUrl(channelId: string): string;
    protected payloadFor(_channelId: string, text: string): unknown;
    /**
     * P3 — media upload. Discord accepts the same multipart shape on webhooks
     * and the REST channel endpoint: a `payload_json` form field (message
     * content, i.e. the caption) plus `files[n]` for the attachment. The webhook
     * URL already carries its token; the REST path uses the Bearer bot token.
     */
    sendMedia(channelId: string, media: MediaPayload): Promise<boolean>;
}
/** Slack — send via incoming webhook URL (BUFF_SLACK_WEBHOOK_URL). */
export declare class SlackAdapter extends WebhookChannelAdapter {
    readonly platform: "slack";
    readonly webhookEnvVar = "BUFF_SLACK_WEBHOOK_URL";
    readonly tokenEnvVar = "BUFF_SLACK_BOT_TOKEN";
    readonly configured: boolean;
    constructor();
    describe(): string;
    protected sendUrl(channelId: string): string;
    protected payloadFor(channelId: string, text: string): unknown;
}
/** WhatsApp — Meta Cloud API (BUFF_WHATSAPP_TOKEN + BUFF_WHATSAPP_PHONE_ID). */
export declare class WhatsAppCloudAdapter extends WebhookChannelAdapter {
    readonly platform: "whatsapp_cloud";
    readonly webhookEnvVar = "BUFF_WHATSAPP_PHONE_ID";
    readonly tokenEnvVar = "BUFF_WHATSAPP_TOKEN";
    readonly configured: boolean;
    private phoneId;
    constructor();
    describe(): string;
    protected sendUrl(): string;
    protected payloadFor(channelId: string, text: string): unknown;
}
/**
 * I8 — the default `whatsapp` platform: a Baileys bridge over the WhatsApp
 * Web multi-device protocol. Pair once with
 * `nuvira whatsapp pair` (QR), then send to JIDs / E.164 numbers and receive
 * inbound messages. The bridge is injectable so tests never touch baileys.
 */
export declare class WhatsAppBridgeAdapter implements ChannelAdapter {
    private readonly bridge;
    readonly platform: "whatsapp";
    private handler;
    constructor(bridge?: WhatsAppBridge);
    /** Paired session on disk → configured (the bridge is the transport). */
    get configured(): boolean;
    describe(): string;
    start(onMessage: MessageHandler): Promise<void>;
    stop(): Promise<void>;
    /** Never throws — returns success (a failed send is ledgered for retry). */
    send(channelId: string, text: string): Promise<boolean>;
    /** P3 — media send passthrough (only the Baileys bridge implements it). */
    sendMedia?(channelId: string, media: {
        type: 'image' | 'video' | 'audio' | 'document';
        data: Uint8Array;
        caption?: string;
        filename?: string;
    }): Promise<boolean>;
}
/** DingTalk group robot — BUFF_DINGTALK_WEBHOOK_URL (URL carries access_token). */
export declare class DingTalkAdapter extends WebhookChannelAdapter {
    readonly platform: "dingtalk";
    readonly webhookEnvVar = "BUFF_DINGTALK_WEBHOOK_URL";
    readonly tokenEnvVar = "BUFF_DINGTALK_WEBHOOK_URL";
    readonly configured: boolean;
    constructor();
    describe(): string;
    protected sendUrl(_channelId: string): string;
    protected payloadFor(_channelId: string, text: string): unknown;
}
/** Feishu/Lark bot — BUFF_FEISHU_WEBHOOK_URL (open-apis bot/v2/hook/<token>). */
export declare class FeishuAdapter extends WebhookChannelAdapter {
    readonly platform: "feishu";
    readonly webhookEnvVar = "BUFF_FEISHU_WEBHOOK_URL";
    readonly tokenEnvVar = "BUFF_FEISHU_WEBHOOK_URL";
    readonly configured: boolean;
    constructor();
    describe(): string;
    protected sendUrl(_channelId: string): string;
    protected payloadFor(_channelId: string, text: string): unknown;
}
/** WeCom (WeChat Work) bot — BUFF_WECOM_WEBHOOK_URL (qyapi webhook/send?key=…). */
export declare class WeComAdapter extends WebhookChannelAdapter {
    readonly platform: "wecom";
    readonly webhookEnvVar = "BUFF_WECOM_WEBHOOK_URL";
    readonly tokenEnvVar = "BUFF_WECOM_WEBHOOK_URL";
    readonly configured: boolean;
    constructor();
    describe(): string;
    protected sendUrl(_channelId: string): string;
    protected payloadFor(_channelId: string, text: string): unknown;
}
/** Mattermost — BUFF_MATTERMOST_WEBHOOK_URL (incoming webhook, { text }). */
export declare class MattermostAdapter extends WebhookChannelAdapter {
    readonly platform: "mattermost";
    readonly webhookEnvVar = "BUFF_MATTERMOST_WEBHOOK_URL";
    readonly tokenEnvVar = "BUFF_MATTERMOST_WEBHOOK_URL";
    readonly configured: boolean;
    constructor();
    describe(): string;
    protected sendUrl(_channelId: string): string;
    protected payloadFor(_channelId: string, text: string): unknown;
}
/** Matrix — homeserver Client-Server API, Bearer auth, room channelId. */
export declare class MatrixAdapter extends WebhookChannelAdapter {
    readonly platform: "matrix";
    readonly webhookEnvVar = "BUFF_MATRIX_HOMESERVER";
    readonly tokenEnvVar = "BUFF_MATRIX_ACCESS_TOKEN";
    readonly configured: boolean;
    private homeserver;
    private handler;
    private running;
    private timer;
    private since;
    private ownUserId;
    constructor();
    describe(): string;
    protected sendUrl(channelId: string): string;
    protected payloadFor(_channelId: string, text: string): unknown;
    /**
     * P3 — inbound via the Client-Server /sync long-poll (no webhooks needed).
     * Polls `next_batch`-anchored sync, relays m.text room messages, skips our
     * own sends. A `since` token is kept in memory per gateway run.
     */
    start(onMessage: MessageHandler): Promise<void>;
    stop(): Promise<void>;
    private poll;
}
/** Generic webhook — BUFF_WEBHOOK_URL, posts { text } (any endpoint). */
export declare class GenericWebhookAdapter extends WebhookChannelAdapter {
    readonly platform: "webhook";
    readonly webhookEnvVar = "BUFF_WEBHOOK_URL";
    readonly tokenEnvVar = "BUFF_WEBHOOK_URL";
    readonly configured: boolean;
    constructor();
    describe(): string;
    protected sendUrl(_channelId: string): string;
    protected payloadFor(_channelId: string, text: string): unknown;
}
/** BlueBubbles (iMessage bridge, macOS) — REST API, Bearer server password. */
export declare class BlueBubblesAdapter extends WebhookChannelAdapter {
    readonly platform: "bluebubbles";
    readonly webhookEnvVar = "BUFF_BLUEBUBBLES_URL";
    readonly tokenEnvVar = "BUFF_BLUEBUBBLES_PASSWORD";
    readonly configured: boolean;
    private serverUrl;
    constructor();
    describe(): string;
    protected sendUrl(_channelId: string): string;
    protected payloadFor(channelId: string, text: string): unknown;
}
/** ntfy — push notifications to a topic (BUFF_NTFY_URL base + BUFF_NTFY_TOPIC). */
export declare class NtfyAdapter extends WebhookChannelAdapter {
    readonly platform: "ntfy";
    readonly webhookEnvVar = "BUFF_NTFY_URL";
    readonly tokenEnvVar = "BUFF_NTFY_TOKEN";
    readonly configured: boolean;
    private baseUrl;
    private topic;
    constructor();
    describe(): string;
    protected sendUrl(_channelId: string): string;
    protected payloadFor(_channelId: string, text: string): unknown;
}
/** Microsoft Teams — incoming webhook (BUFF_TEAMS_WEBHOOK_URL, { text }). */
export declare class TeamsAdapter extends WebhookChannelAdapter {
    readonly platform: "teams";
    readonly webhookEnvVar = "BUFF_TEAMS_WEBHOOK_URL";
    readonly tokenEnvVar = "BUFF_TEAMS_WEBHOOK_URL";
    readonly configured: boolean;
    constructor();
    describe(): string;
    protected sendUrl(_channelId: string): string;
    protected payloadFor(_channelId: string, text: string): unknown;
}
/** Google Chat — space webhook (BUFF_GOOGLE_CHAT_WEBHOOK_URL, { text }). */
export declare class GoogleChatAdapter extends WebhookChannelAdapter {
    readonly platform: "google_chat";
    readonly webhookEnvVar = "BUFF_GOOGLE_CHAT_WEBHOOK_URL";
    readonly tokenEnvVar = "BUFF_GOOGLE_CHAT_WEBHOOK_URL";
    readonly configured: boolean;
    constructor();
    describe(): string;
    protected sendUrl(_channelId: string): string;
    protected payloadFor(_channelId: string, text: string): unknown;
}
/**
 * Weixin — thin send-only client for WeChat's official iLink bot API
 * (WeChat Work webhook protocol). Sends one text message per
 * POST; inbound requires the full iLink get_updates protocol (deferred).
 */
export declare class WeixinAdapter extends WebhookChannelAdapter {
    readonly platform: "weixin";
    readonly webhookEnvVar = "BUFF_WEIXIN_BASE_URL";
    readonly tokenEnvVar = "BUFF_WEIXIN_TOKEN";
    readonly configured: boolean;
    private baseUrl;
    constructor();
    describe(): string;
    protected sendUrl(_channelId: string): string;
    protected payloadFor(channelId: string, text: string): unknown;
    protected extraHeaders(): Record<string, string>;
}
/** SMTP relay settings (from BUFF_SMTP_* env vars). */
export interface SmtpOptions {
    host: string;
    port: number;
    /** TLS from the first byte (SMTPS, port 465). Plain otherwise (STARTTLS unsupported). */
    secure: boolean;
    user?: string;
    pass?: string;
    from: string;
}
/** Build the SMTP options from the environment (BUFF_SMTP_*). */
export declare function smtpOptionsFromEnv(): SmtpOptions;
/**
 * A minimal dependency-free SMTP client (EHLO → AUTH LOGIN → MAIL FROM →
 * RCPT TO → DATA). Deliberately narrow: no STARTTLS, no MIME attachments —
 * text delivery only, matching the other adapters' "thin transport" contract.
 * Returns true when the server accepted the message (250 on DATA).
 */
export declare function smtpSend(opts: SmtpOptions, to: string, text: string, timeoutMs?: number): Promise<boolean>;
/** Email — outbound via an SMTP relay (BUFF_SMTP_*). Channel id = recipient. */
export declare class EmailAdapter implements ChannelAdapter {
    readonly platform: "email";
    readonly configured: boolean;
    private opts;
    constructor(opts?: SmtpOptions);
    describe(): string;
    start(_onMessage: MessageHandler): Promise<void>;
    stop(): Promise<void>;
    send(channelId: string, text: string): Promise<boolean>;
}
/**
 * Signal — outbound via a local signal-cli-rest-api server
 * (bbernhard/signal-cli-rest-api; the standard self-hosted Signal bridge).
 * BUFF_SIGNAL_ACCOUNT = the registered phone number (e.g. +15551234567),
 * BUFF_SIGNAL_REST_URL defaults to http://127.0.0.1:8080. Channel id = the
 * recipient's phone number. Inbound (v1/receive long-poll) is out of scope.
 */
export declare class SignalAdapter implements ChannelAdapter {
    readonly platform: "signal";
    readonly configured: boolean;
    private baseUrl;
    private account;
    constructor(baseUrl?: string, account?: string);
    describe(): string;
    start(_onMessage: MessageHandler): Promise<void>;
    stop(): Promise<void>;
    send(channelId: string, text: string): Promise<boolean>;
}
/**
 * SMS — Twilio REST API outbound (standard Twilio env vars, endpoint, and
 * auth). Sends a form-encoded
 * Messages.json POST with Basic (Account SID : Auth Token) auth. Inbound
 * (Twilio webhook signature validation) is deferred — outbound only, like
 * Signal/Email. Channel id = the recipient's E.164 number.
 */
export declare class SmsAdapter implements ChannelAdapter {
    readonly platform: "sms";
    readonly configured: boolean;
    private accountSid;
    private authToken;
    private fromNumber;
    constructor(accountSid?: string, authToken?: string, fromNumber?: string);
    describe(): string;
    start(_onMessage: MessageHandler): Promise<void>;
    stop(): Promise<void>;
    send(channelId: string, text: string): Promise<boolean>;
}
/** IRC connection settings (from IRC_* env vars). */
export interface IrcOptions {
    server: string;
    port: number;
    useTls: boolean;
    nickname: string;
    /** Optional home channel — used when send() gets no explicit channelId. */
    channel?: string;
    serverPassword?: string;
    nickservPassword?: string;
    /** How long to watch for error numerics after sending (ms). */
    graceMs?: number;
    /**
     * Max delay after 001 before the PRIVMSG is sent: lets NickServ IDENTIFY /
     * a slow JOIN settle when the server never sends 366 (default 1500ms).
     */
    settleDelayMs?: number;
    /** Reconnect delay after the server drops the listener (ms, default 5000). */
    reconnectDelayMs?: number;
    /**
     * Case-insensitive allowlist of nicks that may talk to the bot. When unset
     * (or empty), every nick is allowed — `allowed_users: []` means allow all.
     * Configured via the IRC_ALLOWED_USERS env var (comma list).
     */
    allowedUsers?: string[];
}
/** Build the IRC options from the environment (IRC_* env vars). */
export declare function ircOptionsFromEnv(): IrcOptions;
/**
 * Convert basic markdown to plain text for IRC (`_strip_markdown`
 * parity): bold/italic/code markers removed, images → url, links → text (url).
 */
export declare function stripIrcMarkdown(text: string): string;
/**
 * Split a message into IRC-safe lines (`_split_message` parity).
 * IRC has a ~510 byte wire-line limit; after accounting for the `PRIVMSG
 * <target> :` prefix (+\r\n) we split content into chunks, preferring word
 * boundaries and never splitting a multibyte UTF-8 sequence (binary search
 * for a safe character boundary).
 */
export declare function splitIrcMessage(text: string, target: string, maxLineBytes?: number): string[];
/**
 * Parse one raw IRC protocol line into components (
 * `_parse_irc_message` parity): `:prefix COMMAND p1 p2 :trailing`.
 */
export declare function parseIrcLine(raw: string): {
    prefix: string;
    command: string;
    params: string[];
    trailing: string;
};
/** Extract the nickname from an IRC prefix (`nick!user@host` → `nick`). */
export declare function extractIrcNick(prefix: string): string;
export declare function ircSend(opts: IrcOptions, target: string, text: string, timeoutMs?: number): Promise<boolean>;
/**
 * IRC — two-way via a persistent RFC 1459 connection (
 * `plugins/platforms/irc` parity: same env vars, same protocol). Channel id =
 * an IRC channel (#ops) or a nick for DMs; falls back to IRC_CHANNEL when
 * empty.
 *
 * INBOUND (start/stop): a full-time listener socket — registers (PASS → NICK
 * → USER), waits for 001 RPL_WELCOME, IDENTIFYs with NickServ, JOINS
 * IRC_CHANNEL, answers PING/PONG keepalives, retries nick collisions (433),
 * and relays PRIVMSG. Channel messages are only relayed when the bot is
 * addressed (`nick:`/`nick,`/`nick `); our own echoes are
 * filtered; CTCP ACTION becomes `* nick text` while other CTCP is dropped;
 * IRC_ALLOWED_USERS restricts who may talk to the bot. Reconnects with a
 * backoff when the server drops the socket.
 *
 * OUTBOUND (send): prefers the live listener socket — one IRC identity, so a
 * separate connect-per-send connection claiming the same nick would collide —
 * rate-limited 0.3s between lines. Falls back to connect-per-send
 * `ircSend` when no listener is running.
 */
export declare class IrcAdapter implements ChannelAdapter {
    readonly platform: "irc";
    readonly configured: boolean;
    private opts;
    private handler;
    private sock;
    private running;
    private reconnectTimer;
    private currentNick;
    private buffer;
    constructor(opts?: IrcOptions);
    describe(): string;
    /**
     * Open the persistent inbound listener. Non-blocking: reconnects on drop.
     * Idempotent (a second start while running is a no-op). Throws only when
     * the transport is unconfigured.
     */
    start(onMessage: MessageHandler): Promise<void>;
    stop(): Promise<void>;
    private connect;
    private register;
    private scheduleReconnect;
    private onData;
    private handleLine;
    private handlePrivmsg;
    send(channelId: string, text: string): Promise<boolean>;
}
/**
 * SimpleX options (from SIMPLEX_* env vars).
 */
export interface SimplexOptions {
    /** WebSocket URL of the simplex-chat daemon (ws://127.0.0.1:5225). */
    wsUrl: string;
    /** How long to watch for a chatCmdError after sending (ms). */
    graceMs?: number;
    /** Auto-accept incoming contact requests (default true — SIMPLEX_AUTO_ACCEPT). */
    autoAccept?: boolean;
    /**
     * Comma-separated contact ids allowed to talk to the bot. When unset,
     * every contact is allowed (SIMPLEX_ALLOWED_USERS).
     */
    allowedUsers?: string[];
    /**
     * Comma-separated group ids the bot participates in, or ['*'] for any.
     * When unset, group messages are IGNORED (a safer default — a bot in
     * a group otherwise processes every member's traffic).
     */
    groupAllowed?: string[];
    /** Reconnect delay after the daemon drops the WS (ms, default 5000). */
    reconnectDelayMs?: number;
}
/** Build SimpleX options from the environment (SIMPLEX_*). */
export declare function simplexOptionsFromEnv(): SimplexOptions;
/**
 * A minimal connect-per-send SimpleX client over the daemon's WebSocket API
 * Sends a chat
 * command frame `{"corrId": ..., "cmd": ...}` — DMs use the simple `@<id>
 * text` form, groups use the structured `/_send #<id> json [...]` form (the
 * bracket `#[<id>] text` syntax is parsed by the daemon as a display-name
 * lookup and silently drops). Fire-and-forget: the daemon doesn't
 * always reply to chat commands, so we watch a short grace window for a
 * `chatCmdError` response, then treat the send as accepted.
 */
export declare function simplexSend(opts: SimplexOptions, channelId: string, text: string, timeoutMs?: number): Promise<boolean>;
/**
 * SimpleX — two-way via a local simplex-chat daemon's WebSocket API (
 * `plugins/platforms/simplex` parity: same SIMPLEX_* env vars, same
 * chat-command protocol). Channel id = a contact id for DMs or `group:<id>`
 * for group messages. The daemon is started separately (`simplex-chat -p
 * 5225` or the official Docker image).
 *
 * INBOUND (start/stop): a persistent WS listener — auto-accepts contact
 * requests, filters our own command echoes (anv- corrIds / directSnd /
 * groupSnd chat directions), parses newChatItems/newChatItem events into
 * InboundMessages, applies the contact/group allowlists, and reconnects
 * with a backoff when the daemon drops the connection.
 *
 * ALLOWLIST DEFAULT (deliberate divergence): groups are ignored unless
 * SIMPLEX_GROUP_ALLOWED is set (a safer default — a bot in a group
 * otherwise processes every member's traffic). CONTACTS are allowed by
 * default when SIMPLEX_ALLOWED_USERS is unset — a permissive posture for a
 * local CLI gateway (inbound pipeline triggers are further gated by
 * BUFF_GATEWAY_ALLOW_IDS); set SIMPLEX_ALLOWED_USERS to restrict.
 * OUTBOUND (send): connect-per-send via simplexSend (independent WS).
 */
export declare class SimplexAdapter implements ChannelAdapter {
    readonly platform: "simplex";
    readonly configured: boolean;
    private opts;
    private handler;
    private ws;
    private running;
    private reconnectTimer;
    constructor(opts?: SimplexOptions);
    describe(): string;
    /**
     * Open the persistent inbound WS listener (auto-accept + message relay).
     * Non-blocking: reconnects on drop. Idempotent (a second start while
     * running is a no-op). Throws only when the transport is unconfigured.
     */
    start(onMessage: MessageHandler): Promise<void>;
    stop(): Promise<void>;
    private connect;
    private scheduleReconnect;
    private handleEvent;
    private handleChatItem;
    private contactAllowed;
    private groupAllowed;
    private fireAndForget;
    send(channelId: string, text: string): Promise<boolean>;
}
/**
 * Home Assistant send options (HASS_URL + HASS_TOKEN).
 */
export interface HassOptions {
    /** Base URL of the Home Assistant instance (default http://homeassistant.local:8123). */
    url: string;
    /** Long-Lived Access Token. */
    token: string;
}
/** Build Home Assistant options from the environment (HASS_URL/HASS_TOKEN). */
export declare function hassOptionsFromEnv(): HassOptions;
/**
 * Home Assistant — send-only via the HA REST API (
 * `plugins/platforms/homeassistant/adapter.py` parity: same env vars, same
 * endpoints, Bearer auth). Channel id = the `notify.notify` target (a
 * notification service / device); when no target is given, the notification
 * falls back to the dashboard-wide `persistent_notification.create` (the
 * main send path). 4096-char cap matches MAX_MESSAGE_LENGTH. Inbound
 * (WebSocket event-bus subscription with per-entity cooldowns) is deferred.
 */
export declare class HomeAssistantAdapter implements ChannelAdapter {
    readonly platform: "homeassistant";
    readonly configured: boolean;
    private opts;
    constructor(opts?: HassOptions);
    describe(): string;
    start(_onMessage: MessageHandler): Promise<void>;
    stop(): Promise<void>;
    send(channelId: string, text: string): Promise<boolean>;
}
/** Payload parsers: extract {channelId, text, from} from each platform's webhook body. */
export interface WebhookPayload {
    channelId: string;
    text: string;
    from?: string;
    /** P1 — real sender id (author/user id) for per-user policies. */
    senderId?: string;
    /** P1 — true when the message came from a group/channel, not a DM. */
    isGroup?: boolean;
    /** The platform's message id, when the webhook body carries one (dedup). */
    messageId?: string;
}
/**
 * Parse platform-specific webhook bodies into a normal InboundMessage.
 * Returns null when the payload isn't a user message (e.g. Slack challenge).
 */
export declare function parseWebhookPayload(platform: Platform, body: any): WebhookPayload | null;
/** Shared inbound webhook server. One listener serves Discord/Slack/WhatsApp. */
export declare class WebhookReceiver {
    private server;
    private handler;
    /**
     * Start the listener (default 127.0.0.1:8787). Localhost by default — a
     * public webhook needs an explicit host + the platform's signature secret:
     *   BUFF_SLACK_SIGNING_SECRET  (Slack X-Slack-Signature HMAC verification)
     *   BUFF_WHATSAPP_APP_SECRET   (WhatsApp X-Hub-Signature-256 verification)
     * When the platform secret is set, unsigned POSTs are rejected (401).
     */
    start(onMessage: MessageHandler, port?: number, host?: string): Promise<void>;
    /**
     * Verify a webhook POST's platform signature. Returns true when the
     * platform has NO secret configured (local/trusted setup) or the signature
     * matches. Slack: X-Slack-Signature (HMAC-SHA256, v0). WhatsApp:
     * X-Hub-Signature-256 (HMAC-SHA256, sha256= prefix). Discord webhooks are
     * unauthenticated by design (the URL is the secret) — always accepted.
     */
    private verifySignature;
    private platformFromPath;
    stop(): Promise<void>;
}
/** Build all adapters whose env tokens are present. */
export declare function createConfiguredAdapters(): ChannelAdapter[];
//# sourceMappingURL=adapters.d.ts.map