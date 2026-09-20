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

import { createServer, type Server } from 'node:http';
import { envBuff } from '../config/paths';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Platform } from './channel-directory.js';
import { isPlatformConfigured } from './channel-directory.js';
import type { WhatsAppBridge } from './whatsapp/bridge.js';
import { BaileysBridge, isSelfChatEnabled } from './whatsapp/baileys-bridge.js';
import { hasWhatsAppSession } from './whatsapp/session.js';

// ─── Inbound message shape ──────────────────────────────────────────────────

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

// ─── Adapter interface ──────────────────────────────────────────────────────

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

// ─── Helpers ────────────────────────────────────────────────────────────────

/** POST JSON to an endpoint and treat 2xx as success. */
async function postJson(url: string, body: unknown, token?: string, extraHeaders?: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Sanitize an outbound message: strip control chars, cap length. */
export function sanitizeOutbound(text: string, max = 3500): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
}

/** Default upload filename per media type (when the caller omits one). */
export function defaultMediaFilename(type: MediaPayload['type']): string {
  switch (type) {
    case 'image': return 'image.png';
    case 'video': return 'video.mp4';
    case 'audio': return 'audio.mp3';
    default: return 'file.bin';
  }
}

/** Upload field name for a Telegram send* method (photo/video/audio/document). */
function telegramMediaField(type: MediaPayload['type']): string {
  switch (type) {
    case 'image': return 'photo';
    case 'video': return 'video';
    case 'audio': return 'audio';
    default: return 'document';
  }
}

// ─── Telegram (long-poll) ───────────────────────────────────────────────────

/**
 * Telegram adapter via the Bot API long-poll (`getUpdates`). No public webhook
 * URL required — ideal for a local CLI gateway. Pure fetch, no grammY.
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly platform = 'telegram' as const;
  readonly configured: boolean;
  private token = '';
  private offset = 0;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private handler: MessageHandler | null = null;
  private readonly pollIntervalMs: number;

  constructor(token?: string, pollIntervalMs = 1500) {
    this.token = token ?? envBuff('TELEGRAM_TOKEN') ?? '';
    this.configured = Boolean(this.token);
    this.pollIntervalMs = pollIntervalMs;
  }

  describe(): string {
    return this.configured ? 'Telegram (long-poll, Bot API)' : 'Telegram (not configured)';
  }

  private api(method: string, body: unknown): Promise<Response> {
    return fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async start(onMessage: MessageHandler): Promise<void> {
    if (!this.configured) throw new Error('Telegram adapter not configured (BUFF_TELEGRAM_TOKEN)');
    this.handler = onMessage;
    this.running = true;
    const loop = async (): Promise<void> => {
      if (!this.running) return;
      try {
        const res = await this.api('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ['message'],
        });
        if (res.ok) {
          const data = (await res.json()) as {
            result?: Array<{
              update_id: number;
              message?: {
                chat?: { id: number; type?: string };
                text?: string;
                from?: { id?: number; first_name?: string };
              };
            }>;
          };
          for (const u of data.result ?? []) {
            this.offset = u.update_id + 1;
            const text = u.message?.text;
            if (!text || !u.message?.chat) continue;
            const chat = u.message.chat;
            await this.handler?.({
              platform: 'telegram',
              channelId: String(chat.id),
              text,
              from: u.message.from?.first_name ?? 'telegram-user',
              // P1: real sender id + group detection (chat.type).
              senderId: u.message.from?.id !== undefined ? String(u.message.from.id) : undefined,
              isGroup: chat.type !== undefined && chat.type !== 'private',
            });
          }
        }
      } catch { /* transient network error — keep polling */ }
      this.timer = setTimeout(loop, this.pollIntervalMs);
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async send(channelId: string, text: string): Promise<boolean> {
    if (!this.configured) return false;
    try {
      const res = await this.api('sendMessage', {
        chat_id: Number(channelId),
        text: sanitizeOutbound(text),
        disable_web_page_preview: true,
      });
      return res.ok;
    } catch {
      // send() must never throw — the delivery ledger / gateway callers rely
      // on a boolean (matches every other adapter's contract).
      return false;
    }
  }

  /**
   * P3 — media upload via the Bot API multipart endpoints
   * (sendPhoto/sendVideo/sendAudio/sendDocument). FormData keeps the content
   * type + boundary correct — no manual multipart encoding.
   */
  async sendMedia(channelId: string, media: MediaPayload): Promise<boolean> {
    if (!this.configured) return false;
    const method = media.type === 'image' ? 'sendPhoto' : media.type === 'video' ? 'sendVideo' : media.type === 'audio' ? 'sendAudio' : 'sendDocument';
    try {
      const form = new FormData();
      form.append('chat_id', String(Number(channelId)));
      // Telegram captions are capped at 1024 chars.
      if (media.caption) form.append('caption', sanitizeOutbound(media.caption, 1024));
      form.append(telegramMediaField(media.type), new Blob([media.data]), media.filename ?? defaultMediaFilename(media.type));
      const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, { method: 'POST', body: form });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ─── Webhook-based adapters (Discord / Slack / WhatsApp) ────────────────────

/**
 * Base webhook adapter: outbound via an incoming-webhook URL (pure fetch).
 * Inbound uses an optional shared HTTP listener (see startWebhookReceiver).
 */
export abstract class WebhookChannelAdapter implements ChannelAdapter {
  abstract readonly platform: Platform;
  abstract readonly webhookEnvVar: string;
  abstract readonly tokenEnvVar: string;
  abstract readonly configured: boolean;

  protected webhookUrl = '';
  protected token = '';

  abstract describe(): string;

  /** The outbound endpoint for this platform. */
  protected abstract sendUrl(channelId: string): string;

  /** The platform-specific payload for a text message. */
  protected abstract payloadFor(channelId: string, text: string): unknown;

  /** Extra outbound headers (e.g. protocol markers like weixin's ilink). */
  protected extraHeaders(): Record<string, string> {
    return {};
  }

  async start(_onMessage: MessageHandler): Promise<void> {
    // Webhook inbound is handled by the shared receiver; nothing to poll here.
  }

  async stop(): Promise<void> {
    // No per-adapter resources (the receiver is shared).
  }

  async send(channelId: string, text: string): Promise<boolean> {
    if (!this.configured) return false;
    return postJson(this.sendUrl(channelId), this.payloadFor(channelId, sanitizeOutbound(text)), this.token, this.extraHeaders());
  }
}

/** Discord — send via incoming webhook URL (BUFF_DISCORD_WEBHOOK_URL). */
export class DiscordAdapter extends WebhookChannelAdapter {
  readonly platform = 'discord' as const;
  readonly webhookEnvVar = 'BUFF_DISCORD_WEBHOOK_URL';
  readonly tokenEnvVar = 'BUFF_DISCORD_BOT_TOKEN';
  readonly configured: boolean;

  constructor() {
    super();
    this.webhookUrl = envBuff('DISCORD_WEBHOOK_URL') ?? '';
    this.token = envBuff('DISCORD_BOT_TOKEN') ?? '';
    this.configured = Boolean(this.webhookUrl || this.token);
  }

  describe(): string {
    return this.configured ? 'Discord (webhook)' : 'Discord (not configured)';
  }

  protected sendUrl(channelId: string): string {
    // A webhook URL may embed its own channel; an explicit channelId with a
    // bot token uses the REST API. When only the webhook URL exists, send there.
    if (this.webhookUrl && !channelId) return this.webhookUrl;
    if (this.webhookUrl) return this.webhookUrl;
    return `https://discord.com/api/v10/channels/${channelId}/messages`;
  }

  protected payloadFor(_channelId: string, text: string): unknown {
    return { content: text };
  }

  /**
   * P3 — media upload. Discord accepts the same multipart shape on webhooks
   * and the REST channel endpoint: a `payload_json` form field (message
   * content, i.e. the caption) plus `files[n]` for the attachment. The webhook
   * URL already carries its token; the REST path uses the Bearer bot token.
   */
  async sendMedia(channelId: string, media: MediaPayload): Promise<boolean> {
    if (!this.configured) return false;
    try {
      const form = new FormData();
      // Discord message content is capped at 2000 chars.
      form.append('payload_json', JSON.stringify({ content: sanitizeOutbound(media.caption ?? '', 2000) }));
      form.append('files[0]', new Blob([media.data]), media.filename ?? defaultMediaFilename(media.type));
      const res = await fetch(this.sendUrl(channelId), {
        method: 'POST',
        headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
        body: form,
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/** Slack — send via incoming webhook URL (BUFF_SLACK_WEBHOOK_URL). */
export class SlackAdapter extends WebhookChannelAdapter {
  readonly platform = 'slack' as const;
  readonly webhookEnvVar = 'BUFF_SLACK_WEBHOOK_URL';
  readonly tokenEnvVar = 'BUFF_SLACK_BOT_TOKEN';
  readonly configured: boolean;

  constructor() {
    super();
    this.webhookUrl = envBuff('SLACK_WEBHOOK_URL') ?? '';
    this.token = envBuff('SLACK_BOT_TOKEN') ?? '';
    this.configured = Boolean(this.webhookUrl || this.token);
  }

  describe(): string {
    return this.configured ? 'Slack (webhook)' : 'Slack (not configured)';
  }

  protected sendUrl(channelId: string): string {
    if (this.webhookUrl) return this.webhookUrl;
    return `https://slack.com/api/chat.postMessage`;
  }

  protected payloadFor(channelId: string, text: string): unknown {
    return this.webhookUrl ? { text } : { channel: channelId, text };
  }
}

/** WhatsApp — Meta Cloud API (BUFF_WHATSAPP_TOKEN + BUFF_WHATSAPP_PHONE_ID). */
export class WhatsAppCloudAdapter extends WebhookChannelAdapter {
  // I8: the paid Meta Business API is the OPT-IN `whatsapp_cloud` platform —
  // The platform table keeps `whatsapp` = personal bridge and
  // `whatsapp_cloud` = Cloud API as separate entries).
  readonly platform = 'whatsapp_cloud' as const;
  readonly webhookEnvVar = 'BUFF_WHATSAPP_PHONE_ID';
  readonly tokenEnvVar = 'BUFF_WHATSAPP_TOKEN';
  readonly configured: boolean;
  private phoneId = '';

  constructor() {
    super();
    this.phoneId = envBuff('WHATSAPP_PHONE_ID') ?? '';
    this.token = envBuff('WHATSAPP_TOKEN') ?? '';
    this.configured = Boolean(this.phoneId && this.token);
  }

  describe(): string {
    return this.configured ? 'WhatsApp Business (Meta Cloud API)' : 'WhatsApp Business (Meta Cloud API, not configured)';
  }

  protected sendUrl(): string {
    return `https://graph.facebook.com/v20.0/${this.phoneId}/messages`;
  }

  protected payloadFor(channelId: string, text: string): unknown {
    return {
      messaging_product: 'whatsapp',
      to: channelId,
      type: 'text',
      text: { body: text },
    };
  }
}

// ─── WhatsApp (Baileys bridge — personal number, QR pairing, no paid API) ──

/**
 * I8 — the default `whatsapp` platform: a Baileys bridge over the WhatsApp
 * Web multi-device protocol. Pair once with
 * `nuvira whatsapp pair` (QR), then send to JIDs / E.164 numbers and receive
 * inbound messages. The bridge is injectable so tests never touch baileys.
 */
export class WhatsAppBridgeAdapter implements ChannelAdapter {
  readonly platform = 'whatsapp' as const;
  private handler: MessageHandler | null = null;

  constructor(
    private readonly bridge: WhatsAppBridge = new BaileysBridge(undefined, {
      selfChat: isSelfChatEnabled(),
    }),
  ) {}

  /** Paired session on disk → configured (the bridge is the transport). */
  get configured(): boolean {
    return this.bridge.paired;
  }

  describe(): string {
    return this.bridge.describe();
  }

  async start(onMessage: MessageHandler): Promise<void> {
    this.handler = onMessage;
    await this.bridge.connect((fromJid, text, participant, messageId) => {
      // `||` (not `??`): Baileys 7 can deliver participant as an EMPTY string
      // for DMs — an empty string is not nullish, so `??` would blank the
      // sender id and the policy gate would refuse every sender.
      const sender = participant || fromJid;
      void this.handler?.({
        platform: 'whatsapp',
        channelId: fromJid,
        text,
        from: sender,
        // P1: the real author inside a group (participant) vs the chat itself.
        senderId: sender,
        isGroup: fromJid.endsWith('@g.us'),
        // Idempotency: WhatsApp's `key.id` is stable across re-deliveries, so
        // the gateway collapses the bridge's offline backfill into one turn.
        messageId,
      });
    });
  }

  async stop(): Promise<void> {
    this.handler = null;
    await this.bridge.disconnect();
  }

  /** Never throws — returns success (a failed send is ledgered for retry). */
  async send(channelId: string, text: string): Promise<boolean> {
    if (!this.configured) return false;
    return this.bridge.send(channelId, text);
  }

  /** P3 — media send passthrough (only the Baileys bridge implements it). */
  async sendMedia?(
    channelId: string,
    media: { type: 'image' | 'video' | 'audio' | 'document'; data: Uint8Array; caption?: string; filename?: string },
  ): Promise<boolean> {
    if (!this.configured || !this.bridge.sendMedia) return false;
    return this.bridge.sendMedia(channelId, media);
  }
}

// ─── I9 — Webhook/REST messaging connectors ────────────────────────────────
// Thin outbound adapters for the REST/webhook platforms: DingTalk,
// Feishu, WeCom, Mattermost, Matrix, a generic Webhook, and BlueBubbles
// (iMessage bridge). All are send-only bot webhooks/REST — inbound for these
// platforms would need their long-poll/bot SDKs (out of scope; the shared
// WebhookReceiver covers discord/slack/whatsapp_cloud).
//
// Notes:
// - For URL-keyed platforms (dingtalk/feishu/wecom/mattermost/webhook) the
//   `tokenEnvVar` is metadata only — the secret rides IN the webhook URL
//   (access_token/key/query), so no Authorization header is sent (token='').
// - Signed-robot mode (DingTalk &timestamp+sign, Feishu signature, WeCom
//   &sig) requires per-request HMAC and is NOT supported — use a plain
//   (no-secret) robot webhook URL for these adapters.

/** DingTalk group robot — BUFF_DINGTALK_WEBHOOK_URL (URL carries access_token). */
export class DingTalkAdapter extends WebhookChannelAdapter {
  readonly platform = 'dingtalk' as const;
  readonly webhookEnvVar = 'BUFF_DINGTALK_WEBHOOK_URL';
  readonly tokenEnvVar = 'BUFF_DINGTALK_WEBHOOK_URL';
  readonly configured: boolean;

  constructor() {
    super();
    this.webhookUrl = envBuff('DINGTALK_WEBHOOK_URL') ?? '';
    this.configured = Boolean(this.webhookUrl);
  }

  describe(): string {
    return this.configured ? 'DingTalk (group robot webhook)' : 'DingTalk (not configured)';
  }

  protected sendUrl(_channelId: string): string {
    return this.webhookUrl;
  }

  protected payloadFor(_channelId: string, text: string): unknown {
    return { msgtype: 'text', text: { content: text } };
  }
}

/** Feishu/Lark bot — BUFF_FEISHU_WEBHOOK_URL (open-apis bot/v2/hook/<token>). */
export class FeishuAdapter extends WebhookChannelAdapter {
  readonly platform = 'feishu' as const;
  readonly webhookEnvVar = 'BUFF_FEISHU_WEBHOOK_URL';
  readonly tokenEnvVar = 'BUFF_FEISHU_WEBHOOK_URL';
  readonly configured: boolean;

  constructor() {
    super();
    this.webhookUrl = envBuff('FEISHU_WEBHOOK_URL') ?? '';
    this.configured = Boolean(this.webhookUrl);
  }

  describe(): string {
    return this.configured ? 'Feishu (bot webhook)' : 'Feishu (not configured)';
  }

  protected sendUrl(_channelId: string): string {
    return this.webhookUrl;
  }

  protected payloadFor(_channelId: string, text: string): unknown {
    return { msg_type: 'text', content: { text } };
  }
}

/** WeCom (WeChat Work) bot — BUFF_WECOM_WEBHOOK_URL (qyapi webhook/send?key=…). */
export class WeComAdapter extends WebhookChannelAdapter {
  readonly platform = 'wecom' as const;
  readonly webhookEnvVar = 'BUFF_WECOM_WEBHOOK_URL';
  readonly tokenEnvVar = 'BUFF_WECOM_WEBHOOK_URL';
  readonly configured: boolean;

  constructor() {
    super();
    this.webhookUrl = envBuff('WECOM_WEBHOOK_URL') ?? '';
    this.configured = Boolean(this.webhookUrl);
  }

  describe(): string {
    return this.configured ? 'WeCom (group bot webhook)' : 'WeCom (not configured)';
  }

  protected sendUrl(_channelId: string): string {
    return this.webhookUrl;
  }

  protected payloadFor(_channelId: string, text: string): unknown {
    return { msgtype: 'text', text: { content: text } };
  }
}

/** Mattermost — BUFF_MATTERMOST_WEBHOOK_URL (incoming webhook, { text }). */
export class MattermostAdapter extends WebhookChannelAdapter {
  readonly platform = 'mattermost' as const;
  readonly webhookEnvVar = 'BUFF_MATTERMOST_WEBHOOK_URL';
  readonly tokenEnvVar = 'BUFF_MATTERMOST_WEBHOOK_URL';
  readonly configured: boolean;

  constructor() {
    super();
    this.webhookUrl = envBuff('MATTERMOST_WEBHOOK_URL') ?? '';
    this.configured = Boolean(this.webhookUrl);
  }

  describe(): string {
    return this.configured ? 'Mattermost (incoming webhook)' : 'Mattermost (not configured)';
  }

  protected sendUrl(_channelId: string): string {
    return this.webhookUrl;
  }

  protected payloadFor(_channelId: string, text: string): unknown {
    return { text };
  }
}

/** Matrix — homeserver Client-Server API, Bearer auth, room channelId. */
export class MatrixAdapter extends WebhookChannelAdapter {
  readonly platform = 'matrix' as const;
  readonly webhookEnvVar = 'BUFF_MATRIX_HOMESERVER';
  readonly tokenEnvVar = 'BUFF_MATRIX_ACCESS_TOKEN';
  readonly configured: boolean;
  private homeserver = '';
  private handler: MessageHandler | null = null;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private since: string | null = null;
  private ownUserId = '';

  constructor() {
    super();
    this.homeserver = (envBuff('MATRIX_HOMESERVER') ?? '').replace(/\/$/, '');
    this.token = envBuff('MATRIX_ACCESS_TOKEN') ?? '';
    this.configured = Boolean(this.homeserver && this.token);
  }

  describe(): string {
    return this.configured ? 'Matrix (homeserver API, two-way sync)' : 'Matrix (not configured)';
  }

  protected sendUrl(channelId: string): string {
    return `${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(channelId)}/send/m.room.message`;
  }

  protected payloadFor(_channelId: string, text: string): unknown {
    return { msgtype: 'm.text', body: text };
  }

  /**
   * P3 — inbound via the Client-Server /sync long-poll (no webhooks needed).
   * Polls `next_batch`-anchored sync, relays m.text room messages, skips our
   * own sends. A `since` token is kept in memory per gateway run.
   */
  async start(onMessage: MessageHandler): Promise<void> {
    if (!this.configured) throw new Error('Matrix adapter not configured (BUFF_MATRIX_HOMESERVER + BUFF_MATRIX_ACCESS_TOKEN)');
    if (this.running) return;
    this.handler = onMessage;
    this.running = true;
    // Learn our own user id once so we never re-ingest our own sends.
    try {
      const res = await fetch(`${this.homeserver}/_matrix/client/v3/account/whoami`, {
        headers: { authorization: `Bearer ${this.token}` },
      });
      if (res.ok) this.ownUserId = ((await res.json()) as { user_id?: string }).user_id ?? '';
    } catch {
      /* best-effort — own-message skip still works when it can't be learned */
    }
    void this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.handler = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      const url = `${this.homeserver}/_matrix/client/v3/sync?timeout=30000${this.since ? `&since=${encodeURIComponent(this.since)}` : ''}`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${this.token}` } });
      if (res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (await res.json()) as any;
        this.since = (data?.next_batch as string | undefined) ?? this.since;
        const joined = (data?.rooms?.join ?? {}) as Record<string, { timeline?: { events?: unknown[] } }>;
        for (const [roomId, room] of Object.entries(joined)) {
          for (const ev of room.timeline?.events ?? []) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const e = ev as any;
            if (e?.type !== 'm.room.message' || e?.sender === this.ownUserId) continue;
            const body = e?.content?.body;
            if (typeof body !== 'string' || !body.trim() || e?.content?.msgtype !== 'm.text') continue;
            await this.handler?.({
              platform: 'matrix',
              channelId: roomId,
              text: body,
              from: e.sender ?? 'matrix-user',
              senderId: e.sender,
              // Matrix rooms are channels; DM-vs-group is not inferred here.
              isGroup: true,
            });
          }
        }
      }
    } catch {
      /* transient network error — keep polling */
    }
    if (this.running) this.timer = setTimeout(() => void this.poll(), 1000);
  }
}

/** Generic webhook — BUFF_WEBHOOK_URL, posts { text } (any endpoint). */
export class GenericWebhookAdapter extends WebhookChannelAdapter {
  readonly platform = 'webhook' as const;
  readonly webhookEnvVar = 'BUFF_WEBHOOK_URL';
  readonly tokenEnvVar = 'BUFF_WEBHOOK_URL';
  readonly configured: boolean;

  constructor() {
    super();
    this.webhookUrl = envBuff('WEBHOOK_URL') ?? '';
    this.configured = Boolean(this.webhookUrl);
  }

  describe(): string {
    return this.configured ? 'Webhook (generic POST)' : 'Webhook (not configured)';
  }

  protected sendUrl(_channelId: string): string {
    return this.webhookUrl;
  }

  protected payloadFor(_channelId: string, text: string): unknown {
    return { text };
  }
}

/** BlueBubbles (iMessage bridge, macOS) — REST API, Bearer server password. */
export class BlueBubblesAdapter extends WebhookChannelAdapter {
  readonly platform = 'bluebubbles' as const;
  readonly webhookEnvVar = 'BUFF_BLUEBUBBLES_URL';
  readonly tokenEnvVar = 'BUFF_BLUEBUBBLES_PASSWORD';
  readonly configured: boolean;
  private serverUrl = '';

  constructor() {
    super();
    this.serverUrl = (envBuff('BLUEBUBBLES_URL') ?? '').replace(/\/$/, '');
    this.token = envBuff('BLUEBUBBLES_PASSWORD') ?? '';
    this.configured = Boolean(this.serverUrl && this.token);
  }

  describe(): string {
    return this.configured ? 'BlueBubbles (iMessage bridge, macOS)' : 'BlueBubbles (not configured)';
  }

  protected sendUrl(_channelId: string): string {
    return `${this.serverUrl}/api/v1/message/text`;
  }

  protected payloadFor(channelId: string, text: string): unknown {
    return { target: channelId, message: text };
  }
}

// ─── I10 — ntfy / Teams / Google Chat / Weixin (thin send adapters) ────────

/** ntfy — push notifications to a topic (BUFF_NTFY_URL base + BUFF_NTFY_TOPIC). */
export class NtfyAdapter extends WebhookChannelAdapter {
  readonly platform = 'ntfy' as const;
  readonly webhookEnvVar = 'BUFF_NTFY_URL';
  readonly tokenEnvVar = 'BUFF_NTFY_TOKEN';
  readonly configured: boolean;
  private baseUrl = '';
  private topic = '';

  constructor() {
    super();
    this.baseUrl = (envBuff('NTFY_URL') || 'https://ntfy.sh').replace(/\/$/, '');
    this.topic = envBuff('NTFY_TOPIC') ?? '';
    this.token = envBuff('NTFY_TOKEN') ?? '';
    this.configured = Boolean(this.topic);
  }

  describe(): string {
    return this.configured ? `ntfy (${this.baseUrl}/${this.topic})` : 'ntfy (not configured — set BUFF_NTFY_TOPIC)';
  }

  protected sendUrl(_channelId: string): string {
    return this.baseUrl;
  }

  protected payloadFor(_channelId: string, text: string): unknown {
    // The env topic gates `configured`, so `_channelId` can never override it
    // through send() — always post to the configured topic.
    return { topic: this.topic, message: text };
  }
}

/** Microsoft Teams — incoming webhook (BUFF_TEAMS_WEBHOOK_URL, { text }). */
export class TeamsAdapter extends WebhookChannelAdapter {
  readonly platform = 'teams' as const;
  readonly webhookEnvVar = 'BUFF_TEAMS_WEBHOOK_URL';
  readonly tokenEnvVar = 'BUFF_TEAMS_WEBHOOK_URL';
  readonly configured: boolean;

  constructor() {
    super();
    this.webhookUrl = envBuff('TEAMS_WEBHOOK_URL') ?? '';
    this.configured = Boolean(this.webhookUrl);
  }

  describe(): string {
    return this.configured ? 'Teams (incoming webhook)' : 'Teams (not configured)';
  }

  protected sendUrl(_channelId: string): string {
    return this.webhookUrl;
  }

  protected payloadFor(_channelId: string, text: string): unknown {
    return { text };
  }
}

/** Google Chat — space webhook (BUFF_GOOGLE_CHAT_WEBHOOK_URL, { text }). */
export class GoogleChatAdapter extends WebhookChannelAdapter {
  readonly platform = 'google_chat' as const;
  readonly webhookEnvVar = 'BUFF_GOOGLE_CHAT_WEBHOOK_URL';
  readonly tokenEnvVar = 'BUFF_GOOGLE_CHAT_WEBHOOK_URL';
  readonly configured: boolean;

  constructor() {
    super();
    this.webhookUrl = envBuff('GOOGLE_CHAT_WEBHOOK_URL') ?? '';
    this.configured = Boolean(this.webhookUrl);
  }

  describe(): string {
    return this.configured ? 'Google Chat (space webhook)' : 'Google Chat (not configured)';
  }

  protected sendUrl(_channelId: string): string {
    return this.webhookUrl;
  }

  protected payloadFor(_channelId: string, text: string): unknown {
    return { text };
  }
}

/**
 * Weixin — thin send-only client for WeChat's official iLink bot API
 * (WeChat Work webhook protocol). Sends one text message per
 * POST; inbound requires the full iLink get_updates protocol (deferred).
 */
export class WeixinAdapter extends WebhookChannelAdapter {
  readonly platform = 'weixin' as const;
  readonly webhookEnvVar = 'BUFF_WEIXIN_BASE_URL';
  readonly tokenEnvVar = 'BUFF_WEIXIN_TOKEN';
  readonly configured: boolean;
  private baseUrl = '';

  constructor() {
    super();
    this.baseUrl = (envBuff('WEIXIN_BASE_URL') || 'https://ilinkai.weixin.qq.com').replace(/\/$/, '');
    this.token = envBuff('WEIXIN_TOKEN') ?? '';
    this.configured = Boolean(this.token);
  }

  describe(): string {
    return this.configured ? 'Weixin (iLink bot API, send)' : 'Weixin (not configured — set BUFF_WEIXIN_TOKEN)';
  }

  protected sendUrl(_channelId: string): string {
    return `${this.baseUrl}/ilink/bot/sendmessage`;
  }

  protected payloadFor(channelId: string, text: string): unknown {
    return {
      msg: {
        from_user_id: '',
        to_user_id: channelId,
        client_id: randomUUID(),
        message_type: 2, // MSG_TYPE_BOT
        message_state: 2, // MSG_STATE_FINISH
        item_list: [{ type: 1, text_item: { text } }], // ITEM_TEXT
      },
    };
  }

  protected extraHeaders(): Record<string, string> {
    // Header names are case-insensitive on the wire; lowercase matches the
    // codebase convention (content-type / authorization) and the spy capture.
    return { authorizationtype: 'ilink_bot_token' };
  }
}

// ─── Email (SMTP over node:net/tls — no nodemailer) ─────────────────────────

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
export function smtpOptionsFromEnv(): SmtpOptions {
  const host = envBuff('SMTP_HOST') ?? '';
  const rawPort = envBuff('SMTP_PORT');
  const secure = envBuff('SMTP_SECURE') === 'true' || rawPort === '465';
  return {
    host,
    port: rawPort ? parseInt(rawPort, 10) || (secure ? 465 : 587) : secure ? 465 : 587,
    secure,
    user: envBuff('SMTP_USER') ?? undefined,
    pass: envBuff('SMTP_PASS') ?? undefined,
    from: envBuff('SMTP_FROM') ?? envBuff('SMTP_USER') ?? '',
  };
}

/**
 * A minimal dependency-free SMTP client (EHLO → AUTH LOGIN → MAIL FROM →
 * RCPT TO → DATA). Deliberately narrow: no STARTTLS, no MIME attachments —
 * text delivery only, matching the other adapters' "thin transport" contract.
 * Returns true when the server accepted the message (250 on DATA).
 */
export function smtpSend(opts: SmtpOptions, to: string, text: string, timeoutMs = 15000): Promise<boolean> {
  return new Promise((resolve) => {
    let sock: Socket | TLSSocket | null = null;
    let buffer = '';
    let code = 0;
    let failed = false;
    let step: 'greet' | 'ehlo' | 'auth-user' | 'auth-pass' | 'from' | 'rcpt' | 'data' | 'body' | 'quit' | 'bye' = 'greet';
    let timer: NodeJS.Timeout | null = null;

    const fail = (): void => {
      if (failed) return;
      failed = true;
      if (timer) clearTimeout(timer);
      try { sock?.destroy(); } catch { /* ignore */ }
      resolve(false);
    };
    const done = (): void => {
      if (failed) return;
      failed = true;
      if (timer) clearTimeout(timer);
      try { sock?.destroy(); } catch { /* ignore */ }
      resolve(true);
    };
    const send = (cmd: string): void => { try { sock?.write(cmd + '\r\n'); } catch { fail(); } };

    const onReply = (c: number): void => {
      if (c >= 400) { fail(); return; }
      switch (step) {
        case 'greet':
          step = 'ehlo';
          send('EHLO localhost');
          break;
        case 'ehlo':
          if (opts.user) { step = 'auth-user'; send('AUTH LOGIN'); }
          else { step = 'from'; send(`MAIL FROM:<${opts.from}>`); }
          break;
        case 'auth-user':
          step = 'auth-pass';
          send(Buffer.from(opts.user ?? '').toString('base64'));
          break;
        case 'auth-pass':
          step = 'from';
          send(Buffer.from(opts.pass ?? '').toString('base64'));
          break;
        case 'from':
          step = 'rcpt';
          send(`MAIL FROM:<${opts.from}>`);
          break;
        case 'rcpt':
          step = 'data';
          send(`RCPT TO:<${to}>`);
          break;
        case 'data':
          step = 'body';
          send('DATA');
          break;
        case 'body': {
          step = 'quit';
          const date = new Date().toUTCString();
          const payload = [
            `From: ${opts.from}`,
            `To: <${to}>`,
            `Subject: Agent-Nuvira gateway message`,
            `Date: ${date}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            text,
          ].join('\r\n');
          // SMTP dot-stuffing: any line starting with '.' must be escaped with
          // an extra '.' or the server terminates the message early. Written
          // as a character class (`[.]`, not `\.`) — same meaning, and immune
          // to any transform quirks around escaped-dot regex literals.
          const stuffed = payload.replace(/^[.]/gm, '..');
          try { sock?.write(stuffed + '\r\n.\r\n'); } catch { fail(); }
          break;
        }
        case 'quit':
          // The message is already accepted (250 on DATA) — QUIT is politeness.
          // Wait for the 221 so the server sees a clean goodbye, not a reset.
          step = 'bye';
          send('QUIT');
          break;
        case 'bye':
          done();
          break;
      }
    };

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf-8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        const m = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!m) continue;
        code = parseInt(m[1], 10);
        // A '- ' separator means more lines follow — only the final ' ' line acts.
        if (m[2] === ' ') onReply(code);
      }
    };

    // CR/LF in the recipient or sender would inject SMTP commands or extra
    // headers (MAIL FROM / RCPT TO / DATA) — reject before connecting.
    if (/[\r\n]/.test(to) || /[\r\n]/.test(opts.from)) { fail(); return; }

    const startTls = opts.secure;
    try {
      if (startTls) {
        // SMTPS against a private relay often uses a self-signed cert — accept
        // it (the transport is still encrypted; auth is the gate).
        sock = tlsConnect({ host: opts.host, port: opts.port, rejectUnauthorized: false });
      } else {
        sock = netConnect({ host: opts.host, port: opts.port });
      }
    } catch { fail(); return; }

    sock.on('data', onData);
    // Once the message is accepted (DATA 250) and we're in the QUIT/bye stage,
    // a reset/EPIPE is NOT a failure — the message was delivered; failing here
    // would make the delivery ledger retry and DUPLICATE the email.
    sock.on('error', () => { if (step === 'quit' || step === 'bye') done(); else fail(); });
    // A close once the message is accepted (step >= 'quit') is a success —
    // the server ended the session after our QUIT, or reset; the message was
    // already accepted at DATA time, so failing here would make the delivery
    // ledger retry and DUPLICATE the email.
    sock.on('close', () => { if (!failed) { if (step === 'quit' || step === 'bye') done(); else fail(); } });
    timer = setTimeout(fail, timeoutMs);
  });
}

/** Email — outbound via an SMTP relay (BUFF_SMTP_*). Channel id = recipient. */
export class EmailAdapter implements ChannelAdapter {
  readonly platform = 'email' as const;
  readonly configured: boolean;
  private opts: SmtpOptions;

  constructor(opts?: SmtpOptions) {
    this.opts = opts ?? smtpOptionsFromEnv();
    this.configured = Boolean(this.opts.host && this.opts.from);
  }

  describe(): string {
    return this.configured
      ? `Email (SMTP ${this.opts.host}:${this.opts.port}${this.opts.user ? ` as ${this.opts.user}` : ''})`
      : 'Email (not configured — set BUFF_SMTP_HOST + BUFF_SMTP_USER)';
  }

  async start(_onMessage: MessageHandler): Promise<void> {
    // Outbound only — inbound email would need IMAP (deliberately out of scope).
  }

  async stop(): Promise<void> {
    // No persistent resources.
  }

  async send(channelId: string, text: string): Promise<boolean> {
    if (!this.configured) return false;
    return smtpSend(this.opts, channelId, sanitizeOutbound(text, 20000));
  }
}

// ─── Signal (signal-cli-rest-api, pure fetch) ───────────────────────────────

/**
 * Signal — outbound via a local signal-cli-rest-api server
 * (bbernhard/signal-cli-rest-api; the standard self-hosted Signal bridge).
 * BUFF_SIGNAL_ACCOUNT = the registered phone number (e.g. +15551234567),
 * BUFF_SIGNAL_REST_URL defaults to http://127.0.0.1:8080. Channel id = the
 * recipient's phone number. Inbound (v1/receive long-poll) is out of scope.
 */
export class SignalAdapter implements ChannelAdapter {
  readonly platform = 'signal' as const;
  readonly configured: boolean;
  private baseUrl: string;
  private account: string;

  constructor(baseUrl?: string, account?: string) {
    this.baseUrl = (baseUrl ?? envBuff('SIGNAL_REST_URL') ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
    this.account = account ?? envBuff('SIGNAL_ACCOUNT') ?? '';
    this.configured = Boolean(this.account);
  }

  describe(): string {
    return this.configured
      ? `Signal (rest-api ${this.baseUrl}, account ${this.account})`
      : 'Signal (not configured — set BUFF_SIGNAL_ACCOUNT)';
  }

  async start(_onMessage: MessageHandler): Promise<void> {
    // Outbound only.
  }

  async stop(): Promise<void> {
    // No persistent resources.
  }

  async send(channelId: string, text: string): Promise<boolean> {
    if (!this.configured) return false;
    return postJson(`${this.baseUrl}/v2/send`, {
      message: sanitizeOutbound(text),
      number: this.account,
      recipients: [channelId],
    });
  }
}

// ─── SMS (Twilio REST) ─────────────────────────────────────────────────────

/**
 * SMS — Twilio REST API outbound (standard Twilio env vars, endpoint, and
 * auth). Sends a form-encoded
 * Messages.json POST with Basic (Account SID : Auth Token) auth. Inbound
 * (Twilio webhook signature validation) is deferred — outbound only, like
 * Signal/Email. Channel id = the recipient's E.164 number.
 */
export class SmsAdapter implements ChannelAdapter {
  readonly platform = 'sms' as const;
  readonly configured: boolean;
  private accountSid = '';
  private authToken = '';
  private fromNumber = '';

  constructor(accountSid?: string, authToken?: string, fromNumber?: string) {
    this.accountSid = accountSid ?? process.env.TWILIO_ACCOUNT_SID ?? '';
    this.authToken = authToken ?? process.env.TWILIO_AUTH_TOKEN ?? '';
    this.fromNumber = fromNumber ?? process.env.TWILIO_PHONE_NUMBER ?? '';
    this.configured = Boolean(this.accountSid && this.authToken && this.fromNumber);
  }

  describe(): string {
    return this.configured
      ? `SMS (Twilio ${this.fromNumber})`
      : 'SMS (Twilio, not configured — set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER)';
  }

  async start(_onMessage: MessageHandler): Promise<void> {
    // Outbound only — Twilio inbound (webhook + signature validation) deferred.
  }

  async stop(): Promise<void> {
    // No persistent resources.
  }

  async send(channelId: string, text: string): Promise<boolean> {
    if (!this.configured) return false;
    // Twilio's hard per-message cap is 1600 chars (~10 SMS segments).
    // truncates to this too (it then chunks into segment-sized sends); this
    // thin adapter caps at 1600 — one message, never a partial-SMS failure.
    const body = new URLSearchParams({
      From: this.fromNumber,
      To: channelId,
      Body: sanitizeOutbound(text, 1600),
    });
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ─── IRC (RFC 1459 over node:net/tls) ─────────────────────────────────────

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
export function ircOptionsFromEnv(): IrcOptions {
  const rawPort = process.env.IRC_PORT;
  const port = rawPort ? parseInt(rawPort, 10) || 6697 : 6697;
  const rawTls = process.env.IRC_USE_TLS;
  const rawReconnect = process.env.IRC_RECONNECT_DELAY_MS;
  // TLS defaults ON for the standard TLS port (6697); explicit 0/false/no turns it off.
  const useTls = rawTls !== undefined ? ['1', 'true', 'yes'].includes(rawTls.toLowerCase()) : port === 6697;
  const reconnectDelayMs = rawReconnect ? parseInt(rawReconnect, 10) || undefined : undefined;
  return {
    server: process.env.IRC_SERVER ?? '',
    port,
    useTls,
    nickname: process.env.IRC_NICKNAME ?? 'agent-nuvira',
    channel: process.env.IRC_CHANNEL || undefined,
    serverPassword: process.env.IRC_SERVER_PASSWORD || undefined,
    nickservPassword: process.env.IRC_NICKSERV_PASSWORD || undefined,
    // IRC_ALLOWED_USERS is an env-var option
    // `allowed_users` list (comma-separated nicks, case-insensitive).
    allowedUsers: (process.env.IRC_ALLOWED_USERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    reconnectDelayMs,
  };
}

/**
 * Convert basic markdown to plain text for IRC (`_strip_markdown`
 * parity): bold/italic/code markers removed, images → url, links → text (url).
 */
export function stripIrcMarkdown(text: string): string {
  let t = text;
  // Bold: **text** or __text__ → text
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');
  t = t.replace(/__(.+?)__/g, '$1');
  // Italic: *text* or _text_ → text (word-boundary underscores only)
  t = t.replace(/\*(.+?)\*/g, '$1');
  t = t.replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1');
  // Inline code: `text` → text
  t = t.replace(/`(.+?)`/g, '$1');
  // Code blocks: ```lang\n → '' (content kept)
  t = t.replace(/```\w*\n?/g, '');
  // Images: ![alt](url) → url (must come BEFORE links)
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$2');
  // Links: [text](url) → text (url)
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  return t;
}

/**
 * Split a message into IRC-safe lines (`_split_message` parity).
 * IRC has a ~510 byte wire-line limit; after accounting for the `PRIVMSG
 * <target> :` prefix (+\r\n) we split content into chunks, preferring word
 * boundaries and never splitting a multibyte UTF-8 sequence (binary search
 * for a safe character boundary).
 */
export function splitIrcMessage(text: string, target: string, maxLineBytes = 510): string[] {
  const content = stripIrcMarkdown(text);
  const overhead = Buffer.byteLength(`PRIVMSG ${target} :`) + 2; // +2 for \r\n
  const maxBytes = Math.max(64, maxLineBytes - overhead);
  const lines: string[] = [];
  for (const paragraph of content.split('\n')) {
    if (!paragraph.trim()) continue;
    let para = paragraph;
    while (Buffer.byteLength(para, 'utf-8') > maxBytes) {
      // Binary search for a safe character boundary <= maxBytes.
      let low = 1;
      let high = para.length;
      let best = 0;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (Buffer.byteLength(para.slice(0, mid), 'utf-8') <= maxBytes) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      let splitAt = best;
      // Prefer a space boundary (only when it's not near the start).
      const space = para.lastIndexOf(' ', splitAt);
      if (space > splitAt / 3) splitAt = space;
      const piece = para.slice(0, splitAt).trimEnd();
      if (piece) lines.push(piece);
      para = para.slice(splitAt).trimStart();
    }
    if (para.trim()) lines.push(para);
  }
  return lines.length ? lines : [''];
}

/**
 * Parse one raw IRC protocol line into components (
 * `_parse_irc_message` parity): `:prefix COMMAND p1 p2 :trailing`.
 */
export function parseIrcLine(raw: string): { prefix: string; command: string; params: string[]; trailing: string } {
  let line = raw.replace(/\r$/, '');
  let prefix = '';
  if (line.startsWith(':')) {
    const sp = line.indexOf(' ');
    if (sp === -1) {
      prefix = line.slice(1);
      line = '';
    } else {
      prefix = line.slice(1, sp);
      line = line.slice(sp + 1);
    }
  }
  let trailing = '';
  const colon = line.indexOf(' :');
  if (colon !== -1) {
    trailing = line.slice(colon + 2);
    line = line.slice(0, colon);
  }
  const parts = line.split(' ').filter(Boolean);
  const command = parts.shift() ?? '';
  const params = trailing !== '' ? [...parts, trailing] : parts;
  return { prefix, command, params, trailing };
}

/** Extract the nickname from an IRC prefix (`nick!user@host` → `nick`). */
export function extractIrcNick(prefix: string): string {
  const bang = prefix.indexOf('!');
  return bang === -1 ? prefix : prefix.slice(0, bang);
}

/**
 * A minimal connect-per-send IRC client (RFC 1459). Connects, registers
 * (PASS → NICK → USER), waits for 001 RPL_WELCOME, optionally IDENTIFYs with
 * NickServ, JOINS a channel target, sends the PRIVMSG line(s), then waits the
 * grace window for error numerics before QUIT. Returns true when the message
 * was written and no error numeric arrived (a silent channel deliver has no
 * ack; error numerics like 401/404/442 are the definitive failures).
 */
/** Numerics that are routine during registration / join — never failures. */
const IRC_BENIGN_NUMERICS = new Set([1, 2, 3, 4, 5, 251, 252, 253, 254, 255, 265, 266, 332, 333, 353, 366, 372, 375, 376, 422]);

export function ircSend(opts: IrcOptions, target: string, text: string, timeoutMs = 15000): Promise<boolean> {
  return new Promise((resolve) => {
    let sock: Socket | TLSSocket | null = null;
    let buffer = '';
    let failed = false;
    let done = false;
    let sentMessage = false;
    let settled = false;
    let graceElapsed = false;
    let graceTimer: NodeJS.Timeout | null = null;
    let settleTimer: NodeJS.Timeout | null = null;
    let timer: NodeJS.Timeout | null = null;
    const settleDelay = opts.settleDelayMs ?? 1500;

    const clearTimers = (): void => {
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      timer = graceTimer = settleTimer = null;
    };
    const fail = (): void => {
      if (failed || done) return;
      failed = true;
      clearTimers();
      try { sock?.destroy(); } catch { /* ignore */ }
      resolve(false);
    };
    const succeed = (): void => {
      if (failed || done) return;
      done = true;
      clearTimers();
      try { sock?.destroy(); } catch { /* ignore */ }
      resolve(true);
    };
    const sendRaw = (cmd: string): void => { try { sock?.write(cmd + '\r\n'); } catch { fail(); } };
    const isChannel = (t: string): boolean => /^[#&+!]/.test(t);

    const sendMessage = (): void => {
      if (sentMessage) return;
      sentMessage = true;
      const lines = splitIrcMessage(text, target);
      for (const line of lines) sendRaw(`PRIVMSG ${target} :${line}`);
      // A successful PRIVMSG has no ack — watch the grace window for error
      // numerics (401 no such nick / 404 cannot send / 442 not on channel), then QUIT.
      graceTimer = setTimeout(() => {
        graceElapsed = true;
        sendRaw('QUIT :bye');
        succeed();
      }, opts.graceMs ?? 800);
    };

    // After 001 (RPL_WELCOME): IDENTIFY with NickServ, JOIN channel targets,
    // then send once registration has settled (server's 366 for channels, the
    // settle timer as a fallback, or immediately for DMs without NickServ).
    const proceed = (): void => {
      if (settled || failed) return;
      settled = true;
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      sendMessage();
    };

    const onLine = (line: string): void => {
      // PING keep-alive — reply so the server doesn't drop us mid-send.
      if (line.startsWith('PING ')) { sendRaw('PONG ' + line.slice(5)); return; }
      const m = /^:([^\s]+)\s+(\d{3})\s+/.exec(line);
      if (!m) return;
      const code = parseInt(m[2], 10);
      if (code >= 400 && !IRC_BENIGN_NUMERICS.has(code)) { fail(); return; }
      if (code === 1) {
        if (opts.nickservPassword) sendRaw(`PRIVMSG NickServ :IDENTIFY ${opts.nickservPassword}`);
        if (isChannel(target)) {
          sendRaw(`JOIN ${target}`);
          // 366 (End of NAMES) confirms the join — but some servers skip it,
          // so the settle timer is the fallback.
          settleTimer = setTimeout(proceed, settleDelay);
        } else {
          // DM — no join needed; nickserv still gets a beat to process IDENTIFY.
          settleTimer = setTimeout(proceed, opts.nickservPassword ? settleDelay : 0);
        }
      }
      // 366 End of NAMES — the JOIN is confirmed ONLY when it names our target
      // channel (an unrelated 366 must not fire the send early).
      if (code === 366) {
        const chan = /^:[^\s]+\s+366\s+\S+\s+(\S+)\s+:/.exec(line)?.[1];
        if (chan === target && isChannel(target)) {
          if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
          proceed();
        }
      }
    };

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf-8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        onLine(line);
      }
    };

    // CR/LF in the target would inject IRC commands — reject before connecting.
    if (!opts.server || /[\r\n]/.test(target)) { fail(); return; }

    try {
      if (opts.useTls) {
        // Many private IRC nets use self-signed certs — accept them (the
        // transport is still encrypted; NickServ/server password is the gate).
        sock = tlsConnect({ host: opts.server, port: opts.port, rejectUnauthorized: false });
      } else {
        sock = netConnect({ host: opts.server, port: opts.port });
      }
    } catch { fail(); return; }

    sock.on('data', onData);
    // Unlike SMTP (which has explicit server acks), IRC has no "accepted"
    // reply to anchor success on — a socket error is therefore a genuine
    // failure (let the delivery ledger retry) rather than an assumed success.
    // The ONLY post-send success signal is the grace window elapsing cleanly
    // (no error numeric) — after which QUIT has been sent and the server's
    // close is expected, so it must not flip a clean result into a failure.
    sock.on('error', () => { fail(); });
    sock.on('close', () => {
      if (failed || done) return;
      if (graceElapsed) succeed();
      else fail();
    });
    // Registration handshake.
    if (opts.serverPassword) sendRaw(`PASS ${opts.serverPassword}`);
    sendRaw(`NICK ${opts.nickname}`);
    sendRaw(`USER ${opts.nickname} 0 * :Agent-Nuvira gateway`);
    timer = setTimeout(fail, timeoutMs);
  });
}

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
export class IrcAdapter implements ChannelAdapter {
  readonly platform = 'irc' as const;
  readonly configured: boolean;
  private opts: IrcOptions;
  private handler: MessageHandler | null = null;
  private sock: Socket | TLSSocket | null = null;
  private running = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private currentNick = '';
  private buffer = '';

  constructor(opts?: IrcOptions) {
    this.opts = opts ?? ircOptionsFromEnv();
    this.configured = Boolean(this.opts.server && this.opts.nickname);
    this.currentNick = this.opts.nickname;
  }

  describe(): string {
    return this.configured
      ? `IRC (${this.opts.server}:${this.opts.port}${this.opts.useTls ? ' TLS' : ''} as ${this.opts.nickname})`
      : 'IRC (not configured — set IRC_SERVER)';
  }

  /**
   * Open the persistent inbound listener. Non-blocking: reconnects on drop.
   * Idempotent (a second start while running is a no-op). Throws only when
   * the transport is unconfigured.
   */
  async start(onMessage: MessageHandler): Promise<void> {
    if (!this.configured) throw new Error('IRC adapter not configured (IRC_SERVER)');
    // Guard against a second start() without stop() — never stack listeners.
    if (this.running) return;
    this.handler = onMessage;
    this.running = true;
    this.currentNick = this.opts.nickname;
    this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.handler = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.sock;
    this.sock = null;
    if (sock && !sock.destroyed) {
      try {
        // end() flushes the QUIT before closing (destroy() may drop it).
        sock.end('QUIT :Agent-Nuvira shutting down\r\n');
      } catch {
        /* ignore */
      }
    }
  }

  private connect(): void {
    if (!this.running) return;
    let sock: Socket | TLSSocket;
    try {
      sock = this.opts.useTls
        ? tlsConnect({ host: this.opts.server, port: this.opts.port, rejectUnauthorized: false })
        : netConnect({ host: this.opts.server, port: this.opts.port });
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.sock = sock;
    sock.on('connect', () => this.register(sock));
    sock.on('data', (chunk: Buffer) => this.onData(chunk));
    sock.on('error', () => {
      /* close follows — handled below */
    });
    sock.on('close', () => {
      if (this.sock === sock) this.sock = null;
      this.scheduleReconnect();
    });
  }

  private register(sock: Socket | TLSSocket): void {
    if (this.opts.serverPassword) sock.write(`PASS ${this.opts.serverPassword}\r\n`);
    sock.write(`NICK ${this.currentNick}\r\n`);
    sock.write(`USER ${this.opts.nickname} 0 * :Agent-Nuvira gateway\r\n`);
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.opts.reconnectDelayMs ?? 5000);
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\r\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      try {
        this.handleLine(raw);
      } catch {
        // A malformed line must never take the listener down.
      }
    }
  }

  private handleLine(raw: string): void {
    const msg = parseIrcLine(raw);
    const { command, params } = msg;
    // PING/PONG keepalive — answer or the server drops us.
    if (command === 'PING') {
      const payload = params[0] ?? '';
      this.sock?.write(`PONG :${payload}\r\n`);
      return;
    }
    // 001 RPL_WELCOME — registration complete; the server may confirm our nick.
    if (command === '001') {
      if (params[0]) this.currentNick = params[0];
      if (this.opts.nickservPassword) {
        this.sock?.write(`PRIVMSG NickServ :IDENTIFY ${this.opts.nickservPassword}\r\n`);
      }
      if (this.opts.channel) {
        this.sock?.write(`JOIN ${this.opts.channel}\r\n`);
      }
      return;
    }
    // 433 ERR_NICKNAMEINUSE — retry with an incrementing suffix (
    // nick_, nick_1, nick_2…).
    if (command === '433') {
      const m = this.currentNick.match(/^(.+)_(\d+)$/);
      if (m) this.currentNick = `${m[1]}_${parseInt(m[2], 10) + 1}`;
      else if (this.currentNick === this.opts.nickname) this.currentNick = `${this.opts.nickname}_`;
      else this.currentNick = `${this.opts.nickname}_1`;
      this.sock?.write(`NICK ${this.currentNick}\r\n`);
      return;
    }
    // PRIVMSG — incoming message (channel or DM).
    if (command === 'PRIVMSG' && params.length >= 2) {
      this.handlePrivmsg(extractIrcNick(msg.prefix), params[0], params[1]);
      return;
    }
    // NICK — track our own nick changes.
    if (command === 'NICK' && extractIrcNick(msg.prefix).toLowerCase() === this.currentNick.toLowerCase()) {
      if (params[0]) this.currentNick = params[0];
    }
  }

  private handlePrivmsg(sender: string, target: string, text: string): void {
    if (!sender) return;
    // Ignore our own echoes — the server relays our own PRIVMSGs back.
    if (sender.toLowerCase() === this.currentNick.toLowerCase()) return;
    // CTCP ACTION (/me) → `* nick text`; other CTCP is ignored.
    if (text.startsWith('\x01ACTION ') && text.endsWith('\x01')) {
      text = `* ${sender} ${text.slice(8, -1)}`;
    } else if (text.startsWith('\x01')) {
      return;
    }
    const isChannel = target.startsWith('#') || target.startsWith('&');
    const channelId = isChannel ? target : sender;
    if (isChannel) {
      // In channels the bot only reacts when addressed (nick:/nick,/nick ).
      const nick = this.currentNick;
      let addressed = false;
      for (const prefix of [`${nick}:`, `${nick},`, `${nick} `]) {
        if (text.toLowerCase().startsWith(prefix.toLowerCase())) {
          text = text.slice(prefix.length).trim();
          addressed = true;
          break;
        }
      }
      if (!addressed) return;
    }
    // Case-insensitive allowlist (IRC_ALLOWED_USERS); unset = allow all.
    const allowed = this.opts.allowedUsers ?? [];
    if (allowed.length > 0 && !allowed.some((u) => u.toLowerCase() === sender.toLowerCase())) return;
    // senderId = the IRC nick, so the SHARED per-user policy gate (registry
    // `allowedUsers`) applies to IRC too — same enforcement as WhatsApp/etc.
    void this.handler?.({ platform: 'irc', channelId, text, from: sender, senderId: sender, isGroup: isChannel });
  }

  async send(channelId: string, text: string): Promise<boolean> {
    if (!this.configured) return false;
    const target = channelId || this.opts.channel || '';
    if (!target) return false;
    const content = sanitizeOutbound(text);
    // Prefer the live listener socket — one IRC identity, so no nick
    // collision between the listener and a separate send connection.
    const sock = this.sock;
    if (this.running && sock && !sock.destroyed) {
      try {
        for (const line of splitIrcMessage(content, target)) {
          sock.write(`PRIVMSG ${target} :${line}\r\n`);
          // a 0.3s flood guard between lines.
          await new Promise((r) => setTimeout(r, 300));
        }
        return true;
      } catch {
        return false;
      }
    }
    return ircSend(this.opts, target, content);
  }
}

// ─── SimpleX (local daemon WebSocket) ───────────────────────────────────────

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
export function simplexOptionsFromEnv(): SimplexOptions {
  const groupAllowed = process.env.SIMPLEX_GROUP_ALLOWED;
  return {
    wsUrl: (process.env.SIMPLEX_WS_URL ?? '').replace(/\/$/, ''),
    autoAccept: (process.env.SIMPLEX_AUTO_ACCEPT ?? '').toLowerCase() !== 'false',
    allowedUsers: (process.env.SIMPLEX_ALLOWED_USERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    groupAllowed: groupAllowed
      ? groupAllowed.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined,
  };
}

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
export function simplexSend(opts: SimplexOptions, channelId: string, text: string, timeoutMs = 10000): Promise<boolean> {
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    let failed = false;
    let done = false;
    let sent = false;
    let graceTimer: NodeJS.Timeout | null = null;
    let timer: NodeJS.Timeout | null = null;

    const finish = (ok: boolean): void => {
      if (failed || done) return;
      if (ok) done = true;
      else failed = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      try { ws?.close(); } catch { /* ignore */ }
      resolve(ok);
    };

    // CR/LF in the target would inject a second chat command into the daemon's
    // input (the DM form embeds it raw) — reject before connecting, like IRC.
    if (/[\r\n]/.test(channelId)) {
      finish(false);
      return;
    }

    try {
      ws = new WebSocket(opts.wsUrl);
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => finish(false), timeoutMs);

    ws.onopen = (): void => {
      const corrId = `anv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      let cmd: string;
      if (channelId.startsWith('group:')) {
        // Structured form: addresses by numeric ID; JSON-escapes text properly.
        const composed = JSON.stringify([{ msgContent: { type: 'text', text } }]);
        cmd = `/_send #${channelId.slice('group:'.length)} json ${composed}`;
      } else {
        // DM form embeds text raw in the command — strip CR/LF so a newline
        // in the message cannot inject a second command into the daemon.
        cmd = `@${channelId} ${text.replace(/[\r\n]+/g, ' ')}`;
      }
      try {
        ws?.send(JSON.stringify({ corrId, cmd }));
        sent = true;
      } catch {
        finish(false);
        return;
      }
      // Fire-and-forget — watch for a chatCmdError during the grace window.
      graceTimer = setTimeout(() => finish(true), opts.graceMs ?? 300);
    };

    ws.onmessage = (ev: MessageEvent): void => {
      // A chatCmdError response means the command was rejected (bad id etc.).
      try {
        const data = JSON.parse(String(ev.data)) as { resp?: { type?: string } };
        if (data.resp?.type === 'chatCmdError') {
          finish(false);
          return;
        }
      } catch { /* non-JSON frames are daemon chatter — ignore */ }
    };

    // Any socket error is a genuine failure (the frame may not have reached
    // the daemon) — fail so the delivery ledger retries. The ONLY success
    // signals are the grace window elapsing cleanly or a clean close after
    // the send went out.
    ws.onerror = (): void => { finish(false); };
    ws.onclose = (): void => { if (!failed && !done) { if (sent) finish(true); else finish(false); } };
  });
}

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
export class SimplexAdapter implements ChannelAdapter {
  readonly platform = 'simplex' as const;
  readonly configured: boolean;
  private opts: SimplexOptions;
  private handler: MessageHandler | null = null;
  private ws: WebSocket | null = null;
  private running = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(opts?: SimplexOptions) {
    this.opts = opts ?? simplexOptionsFromEnv();
    this.configured = Boolean(this.opts.wsUrl);
  }

  describe(): string {
    return this.configured
      ? `SimpleX (daemon ${this.opts.wsUrl})`
      : 'SimpleX (not configured — set SIMPLEX_WS_URL)';
  }

  /**
   * Open the persistent inbound WS listener (auto-accept + message relay).
   * Non-blocking: reconnects on drop. Idempotent (a second start while
   * running is a no-op). Throws only when the transport is unconfigured.
   */
  async start(onMessage: MessageHandler): Promise<void> {
    if (!this.configured) throw new Error('SimpleX adapter not configured (SIMPLEX_WS_URL)');
    // Guard against a second start() without stop() — never stack listeners.
    if (this.running) return;
    this.handler = onMessage;
    this.running = true;
    this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.handler = null;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  private connect(): void {
    if (!this.running) return;
    try {
      this.ws = new WebSocket(this.opts.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onmessage = (ev: MessageEvent): void => this.handleEvent(ev);
    this.ws.onerror = (): void => { /* close follows — handled below */ };
    this.ws.onclose = (): void => {
      this.ws = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.opts.reconnectDelayMs ?? 5000);
  }

  private handleEvent(ev: MessageEvent): void {
    let event: unknown;
    try { event = JSON.parse(String(ev.data)); } catch { return; }
    const resp = (event as any)?.resp && typeof (event as any).resp === 'object' ? (event as any).resp : event;
    const corrId = (event as any)?.corrId;
    // Echo filter: corrIds we minted for our own commands (fire-and-forget
    // sends / accepts) — never dispatch them as inbound.
    if (typeof corrId === 'string' && corrId.startsWith('anv-')) return;

    const type = resp?.type ?? '';
    if (type === 'contactRequest' && this.opts.autoAccept !== false) {
      const reqId = resp?.contactRequest?.contactRequestId;
      if (reqId != null) this.fireAndForget(`/accept ${reqId}`);
      return;
    }
    if (type === 'newChatItems') {
      const items: unknown[] = Array.isArray(resp?.chatItems) ? resp.chatItems : [];
      for (const item of items) this.handleChatItem(item);
      return;
    }
    if (type === 'newChatItem') {
      this.handleChatItem(resp);
    }
  }

  private handleChatItem(item: unknown): void {
    const chatInfo = (item as any)?.chatInfo ?? {};
    const chatItemData = (item as any)?.chatItem ?? {};
    // Skip our own outgoing messages (the daemon echoes them back).
    const direction = chatItemData?.chatDir ?? {};
    if (direction?.type === 'directSnd' || direction?.type === 'groupSnd') return;
    // Only received text content.
    const content = chatItemData?.content ?? {};
    if (content?.type !== 'rcvMsgContent') return;
    const text = content?.msgContent?.text;
    if (typeof text !== 'string' || !text) return;

    const chatType = chatInfo?.type;
    let channelId = '';
    let from = '';
    let senderId: string | undefined;
    if (chatType === 'direct') {
      const contact = chatInfo?.contact ?? {};
      const id = String(contact?.contactId ?? '');
      if (!id) return;
      if (!this.contactAllowed(id)) return;
      channelId = id;
      from = contact?.localDisplayName || contact?.profile?.displayName || 'simplex-contact';
      // senderId = the contact id, so the SHARED per-user policy gate applies.
      senderId = id;
    } else if (chatType === 'group') {
      const groupId = String(chatInfo?.groupInfo?.groupId ?? '');
      if (!groupId) return;
      if (!this.groupAllowed(groupId)) return;
      channelId = `group:${groupId}`;
      const member = direction?.groupMember ?? {};
      from = member?.localDisplayName || member?.memberProfile?.displayName || 'simplex-group';
      // The author's contact id (when the member is a contact) lets the shared
      // per-user policy gate apply inside groups too.
      const memberId = String(member?.contactId ?? member?.memberId ?? '');
      senderId = memberId || undefined;
    } else {
      return;
    }
    void this.handler?.({ platform: 'simplex', channelId, text, from, senderId, isGroup: chatType === 'group' });
  }

  private contactAllowed(id: string): boolean {
    const allowed = this.opts.allowedUsers ?? [];
    return allowed.length === 0 || allowed.includes(id);
  }

  private groupAllowed(id: string): boolean {
    const allowed = this.opts.groupAllowed ?? [];
    return allowed.includes('*') || allowed.includes(id);
  }

  private fireAndForget(cmd: string): void {
    try {
      this.ws?.send(JSON.stringify({ corrId: `anv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, cmd }));
    } catch { /* daemon may be gone — reconnect loop handles it */ }
  }

  async send(channelId: string, text: string): Promise<boolean> {
    if (!this.configured) return false;
    if (!channelId) return false;
    return simplexSend(this.opts, channelId, sanitizeOutbound(text));
  }
}

// ─── Home Assistant (REST API) ─────────────────────────────────────────────

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
export function hassOptionsFromEnv(): HassOptions {
  return {
    url: (process.env.HASS_URL || 'http://homeassistant.local:8123').replace(/\/$/, ''),
    token: process.env.HASS_TOKEN ?? '',
  };
}

/**
 * Home Assistant — send-only via the HA REST API (
 * `plugins/platforms/homeassistant/adapter.py` parity: same env vars, same
 * endpoints, Bearer auth). Channel id = the `notify.notify` target (a
 * notification service / device); when no target is given, the notification
 * falls back to the dashboard-wide `persistent_notification.create` (the
 * main send path). 4096-char cap matches MAX_MESSAGE_LENGTH. Inbound
 * (WebSocket event-bus subscription with per-entity cooldowns) is deferred.
 */
export class HomeAssistantAdapter implements ChannelAdapter {
  readonly platform = 'homeassistant' as const;
  readonly configured: boolean;
  private opts: HassOptions;

  constructor(opts?: HassOptions) {
    this.opts = opts ?? hassOptionsFromEnv();
    this.configured = Boolean(this.opts.url && this.opts.token);
  }

  describe(): string {
    return this.configured
      ? `Home Assistant (${this.opts.url})`
      : 'Home Assistant (not configured — set HASS_TOKEN)';
  }

  async start(_onMessage: MessageHandler): Promise<void> {
    // Outbound only — the WS event-bus subscription deferred.
  }

  async stop(): Promise<void> {
    // No persistent resources.
  }

  async send(channelId: string, text: string): Promise<boolean> {
    if (!this.configured) return false;
    const message = sanitizeOutbound(text, 4096);
    if (channelId) {
      // Target-aware: deliver to a specific notify service / device.
      return postJson(`${this.opts.url}/api/services/notify/notify`, { message, target: channelId }, this.opts.token);
    }
    // Dashboard-wide persistent notification (default send).
    return postJson(
      `${this.opts.url}/api/services/persistent_notification/create`,
      { title: 'Agent-Nuvira', message },
      this.opts.token,
    );
  }
}

// ─── Webhook inbound receiver (Discord/Slack/WhatsApp) ──────────────────────

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
export function parseWebhookPayload(platform: Platform, body: any): WebhookPayload | null {
  try {
    if (platform === 'discord') {
      const content = body?.content;
      const channelId = body?.channel_id;
      if (typeof content === 'string' && channelId) {
        return {
          channelId,
          text: content,
          from: body?.author?.username ?? 'discord-user',
          // P1: author id (webhooks can't tell DM vs guild channel).
          senderId: body?.author?.id !== undefined ? String(body.author.id) : undefined,
        };
      }
      return null;
    }
    if (platform === 'slack') {
      // Slack Events API — URL-verification challenge gets a raw text reply handled
      // by the receiver; real messages arrive via the `event` envelope.
      if (body?.challenge) return null;
      const event = body?.event;
      if (event?.type === 'message' && typeof event.text === 'string' && event.channel) {
        return {
          channelId: event.channel,
          text: event.text,
          from: event.user ?? 'slack-user',
          // P1: event.user IS the Slack user id; D-channels are DMs.
          senderId: event.user ?? undefined,
          isGroup: typeof event.channel === 'string' && !event.channel.startsWith('D'),
        };
      }
      return null;
    }
    if (platform === 'whatsapp') {
      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0]?.value;
      const msg = change?.messages?.[0];
      if (msg?.type === 'text' && msg?.text?.body) {
        // P1: group messages carry context.group_id — reply to the GROUP.
        const groupId = msg?.context?.group_id;
        return {
          channelId: groupId ?? msg.from,
          text: msg.text.body,
          from: groupId ? `${msg.from} (in ${groupId})` : msg.from,
          senderId: msg.from,
          isGroup: Boolean(groupId),
        };
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Shared inbound webhook server. One listener serves Discord/Slack/WhatsApp. */
export class WebhookReceiver {
  private server: Server | null = null;
  private handler: MessageHandler | null = null;

  /**
   * Start the listener (default 127.0.0.1:8787). Localhost by default — a
   * public webhook needs an explicit host + the platform's signature secret:
   *   BUFF_SLACK_SIGNING_SECRET  (Slack X-Slack-Signature HMAC verification)
   *   BUFF_WHATSAPP_APP_SECRET   (WhatsApp X-Hub-Signature-256 verification)
   * When the platform secret is set, unsigned POSTs are rejected (401).
   */
  async start(onMessage: MessageHandler, port = 8787, host = '127.0.0.1'): Promise<void> {
    this.handler = onMessage;
    this.server = createServer(async (req, res) => {
      // Only POST (and GET for WhatsApp webhook verification).
      if (req.method === 'GET') {
        // WhatsApp hub.challenge verification.
        const url = new URL(req.url ?? '/', 'http://localhost');
        const mode = url.searchParams.get('hub.mode');
        if (mode === 'subscribe' && url.searchParams.get('hub.verify_token') === envBuff('WHATSAPP_VERIFY_TOKEN')) {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end(url.searchParams.get('hub.challenge') ?? 'ok');
          return;
        }
        res.writeHead(404); res.end();
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }

      const platform = this.platformFromPath(req.url ?? '');
      if (!platform) { res.writeHead(404); res.end(); return; }

      // Platform signature verification BEFORE any payload is honored.
      if (!this.verifySignature(platform, req, raw)) {
        res.writeHead(401); res.end('unauthorized');
        return;
      }

      // Slack URL verification — reply with the challenge verbatim.
      if (platform === 'slack' && body?.type === 'url_verification') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(String(body.challenge ?? ''));
        return;
      }

      const parsed = parseWebhookPayload(platform, body);
      res.writeHead(200); res.end('ok');
      if (parsed) {
        await this.handler?.({
          platform,
          channelId: parsed.channelId,
          text: parsed.text,
          from: parsed.from,
          // P1: real sender id + DM/group detection ride through the payload.
          senderId: parsed.senderId,
          isGroup: parsed.isGroup,
        });
      }
    });
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
  }

  /**
   * Verify a webhook POST's platform signature. Returns true when the
   * platform has NO secret configured (local/trusted setup) or the signature
   * matches. Slack: X-Slack-Signature (HMAC-SHA256, v0). WhatsApp:
   * X-Hub-Signature-256 (HMAC-SHA256, sha256= prefix). Discord webhooks are
   * unauthenticated by design (the URL is the secret) — always accepted.
   */
  private verifySignature(platform: Platform, req: import('node:http').IncomingMessage, raw: string): boolean {
    const header = req.headers['x-slack-signature'] as string | undefined;
    const timestamp = req.headers['x-slack-request-timestamp'] as string | undefined;
    if (platform === 'slack' && (header || timestamp)) {
      const secret = envBuff('SLACK_SIGNING_SECRET') ?? '';
      if (!secret) return false; // signed request but no secret configured → reject
      const base = `v0:${timestamp}:${raw}`;
      const expected = `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
      return safeEqual(expected, header ?? '');
    }
    if (platform === 'whatsapp') {
      const secret = envBuff('WHATSAPP_APP_SECRET') ?? '';
      if (!secret) return true; // no secret configured → accept (local setup)
      const signature = req.headers['x-hub-signature-256'] as string | undefined;
      if (!signature) return false;
      const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
      return safeEqual(expected, signature);
    }
    return true; // discord / no-secret platforms
  }

  private platformFromPath(path: string): Platform | null {
    if (path.startsWith('/discord')) return 'discord';
    if (path.startsWith('/slack')) return 'slack';
    if (path.startsWith('/whatsapp')) return 'whatsapp';
    return null;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }
}

/** Constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ─── Factory ────────────────────────────────────────────────────────────────

/** Build all adapters whose env tokens are present. */
export function createConfiguredAdapters(): ChannelAdapter[] {
  const adapters: ChannelAdapter[] = [new TelegramAdapter()];
  if (envBuff('DISCORD_BOT_TOKEN') || envBuff('DISCORD_WEBHOOK_URL')) adapters.push(new DiscordAdapter());
  if (envBuff('SLACK_BOT_TOKEN') || envBuff('SLACK_WEBHOOK_URL')) adapters.push(new SlackAdapter());
  // I8: `whatsapp` = personal Baileys bridge (paired session), `whatsapp_cloud`
  // = the paid Meta Business API (explicit token + phone id).
  if (hasWhatsAppSession()) adapters.push(new WhatsAppBridgeAdapter());
  if (envBuff('WHATSAPP_TOKEN') && envBuff('WHATSAPP_PHONE_ID')) adapters.push(new WhatsAppCloudAdapter());
  // I9: webhook/REST connectors — opt-in via their env tokens.
  if (isPlatformConfigured('dingtalk')) adapters.push(new DingTalkAdapter());
  if (isPlatformConfigured('feishu')) adapters.push(new FeishuAdapter());
  if (isPlatformConfigured('wecom')) adapters.push(new WeComAdapter());
  if (isPlatformConfigured('mattermost')) adapters.push(new MattermostAdapter());
  if (isPlatformConfigured('matrix')) adapters.push(new MatrixAdapter());
  if (isPlatformConfigured('webhook')) adapters.push(new GenericWebhookAdapter());
  if (isPlatformConfigured('bluebubbles')) adapters.push(new BlueBubblesAdapter());
  // I10 — ntfy / Teams / Google Chat / Weixin.
  if (isPlatformConfigured('ntfy')) adapters.push(new NtfyAdapter());
  if (isPlatformConfigured('teams')) adapters.push(new TeamsAdapter());
  if (isPlatformConfigured('google_chat')) adapters.push(new GoogleChatAdapter());
  if (isPlatformConfigured('weixin')) adapters.push(new WeixinAdapter());
  // I12 — SMS (Twilio REST).
  if (isPlatformConfigured('sms')) adapters.push(new SmsAdapter());
  // I13 — IRC (RFC 1459 over node:net/tls).
  if (isPlatformConfigured('irc')) adapters.push(new IrcAdapter());
  // I14 — SimpleX (local daemon WebSocket).
  if (isPlatformConfigured('simplex')) adapters.push(new SimplexAdapter());
  // I15 — Home Assistant (REST API).
  if (isPlatformConfigured('homeassistant')) adapters.push(new HomeAssistantAdapter());
  if (isPlatformConfigured('email')) adapters.push(new EmailAdapter());
  if (isPlatformConfigured('signal')) adapters.push(new SignalAdapter());
  return adapters;
}
