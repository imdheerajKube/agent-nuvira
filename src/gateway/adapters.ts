/**
 * J1 — Channel adapters (Hermes `gateway/` transport model).
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
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Platform } from './channel-directory.js';

// ─── Inbound message shape ──────────────────────────────────────────────────

export interface InboundMessage {
  platform: Platform;
  /** Channel id (chat id / webhook channel id) to REPLY to. */
  channelId: string;
  /** Message text. */
  text: string;
  /** Human sender label (for the board/logs). */
  from?: string;
}

/** The handler an adapter calls for every inbound message. */
export type MessageHandler = (msg: InboundMessage) => void | Promise<void>;

// ─── Adapter interface ──────────────────────────────────────────────────────

export interface ChannelAdapter {
  readonly platform: Platform;
  /** True when the transport token/env is present (opt-in). */
  readonly configured: boolean;
  /** Human description for `buff gateway status`. */
  describe(): string;
  /** Start receiving inbound messages (long-poll or webhook server). */
  start(onMessage: MessageHandler): Promise<void>;
  /** Stop receiving (idempotent). */
  stop(): Promise<void>;
  /** Send a text message to a channel. Never throws — returns success. */
  send(channelId: string, text: string): Promise<boolean>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** POST JSON to an endpoint and treat 2xx as success. */
async function postJson(url: string, body: unknown, token?: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
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
    this.token = token ?? process.env.BUFF_TELEGRAM_TOKEN ?? '';
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
            result?: Array<{ update_id: number; message?: { chat?: { id: number }; text?: string; from?: { first_name?: string } } }>;
          };
          for (const u of data.result ?? []) {
            this.offset = u.update_id + 1;
            const text = u.message?.text;
            if (!text || !u.message?.chat) continue;
            await this.handler?.({
              platform: 'telegram',
              channelId: String(u.message.chat.id),
              text,
              from: u.message.from?.first_name ?? 'telegram-user',
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
    const res = await this.api('sendMessage', {
      chat_id: Number(channelId),
      text: sanitizeOutbound(text),
      disable_web_page_preview: true,
    });
    return res.ok;
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

  async start(_onMessage: MessageHandler): Promise<void> {
    // Webhook inbound is handled by the shared receiver; nothing to poll here.
  }

  async stop(): Promise<void> {
    // No per-adapter resources (the receiver is shared).
  }

  async send(channelId: string, text: string): Promise<boolean> {
    if (!this.configured) return false;
    return postJson(this.sendUrl(channelId), this.payloadFor(channelId, sanitizeOutbound(text)), this.token);
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
    this.webhookUrl = process.env.BUFF_DISCORD_WEBHOOK_URL ?? '';
    this.token = process.env.BUFF_DISCORD_BOT_TOKEN ?? '';
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
}

/** Slack — send via incoming webhook URL (BUFF_SLACK_WEBHOOK_URL). */
export class SlackAdapter extends WebhookChannelAdapter {
  readonly platform = 'slack' as const;
  readonly webhookEnvVar = 'BUFF_SLACK_WEBHOOK_URL';
  readonly tokenEnvVar = 'BUFF_SLACK_BOT_TOKEN';
  readonly configured: boolean;

  constructor() {
    super();
    this.webhookUrl = process.env.BUFF_SLACK_WEBHOOK_URL ?? '';
    this.token = process.env.BUFF_SLACK_BOT_TOKEN ?? '';
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
export class WhatsAppAdapter extends WebhookChannelAdapter {
  readonly platform = 'whatsapp' as const;
  readonly webhookEnvVar = 'BUFF_WHATSAPP_PHONE_ID';
  readonly tokenEnvVar = 'BUFF_WHATSAPP_TOKEN';
  readonly configured: boolean;
  private phoneId = '';

  constructor() {
    super();
    this.phoneId = process.env.BUFF_WHATSAPP_PHONE_ID ?? '';
    this.token = process.env.BUFF_WHATSAPP_TOKEN ?? '';
    this.configured = Boolean(this.phoneId && this.token);
  }

  describe(): string {
    return this.configured ? 'WhatsApp (Meta Cloud API)' : 'WhatsApp (not configured)';
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

// ─── Webhook inbound receiver (Discord/Slack/WhatsApp) ──────────────────────

/** Payload parsers: extract {channelId, text, from} from each platform's webhook body. */
export interface WebhookPayload {
  channelId: string;
  text: string;
  from?: string;
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
        return { channelId, text: content, from: body?.author?.username ?? 'discord-user' };
      }
      return null;
    }
    if (platform === 'slack') {
      // Slack Events API — URL-verification challenge gets a raw text reply handled
      // by the receiver; real messages arrive via the `event` envelope.
      if (body?.challenge) return null;
      const event = body?.event;
      if (event?.type === 'message' && typeof event.text === 'string' && event.channel) {
        return { channelId: event.channel, text: event.text, from: event.user ?? 'slack-user' };
      }
      return null;
    }
    if (platform === 'whatsapp') {
      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0]?.value;
      const msg = change?.messages?.[0];
      if (msg?.type === 'text' && msg?.text?.body) {
        return { channelId: msg.from, text: msg.text.body, from: msg.from };
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
        if (mode === 'subscribe' && url.searchParams.get('hub.verify_token') === process.env.BUFF_WHATSAPP_VERIFY_TOKEN) {
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
      const secret = process.env.BUFF_SLACK_SIGNING_SECRET ?? '';
      if (!secret) return false; // signed request but no secret configured → reject
      const base = `v0:${timestamp}:${raw}`;
      const expected = `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
      return safeEqual(expected, header ?? '');
    }
    if (platform === 'whatsapp') {
      const secret = process.env.BUFF_WHATSAPP_APP_SECRET ?? '';
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
  if (process.env.BUFF_DISCORD_BOT_TOKEN || process.env.BUFF_DISCORD_WEBHOOK_URL) adapters.push(new DiscordAdapter());
  if (process.env.BUFF_SLACK_BOT_TOKEN || process.env.BUFF_SLACK_WEBHOOK_URL) adapters.push(new SlackAdapter());
  if (process.env.BUFF_WHATSAPP_TOKEN && process.env.BUFF_WHATSAPP_PHONE_ID) adapters.push(new WhatsAppAdapter());
  return adapters;
}
