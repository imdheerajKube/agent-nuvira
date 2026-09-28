/**
 * Real-time inbound transports for the gateway (`src/gateway/realtime.ts`).
 *
 * The webhook receiver covers platforms that PUSH to us — but a bot cannot
 * receive Discord `MESSAGE_CREATE` events or Slack Events API deliveries over a
 * webhook it does not own. Discord bots get messages over the Discord Gateway
 * (a WebSocket we dial out to); Slack apps that cannot expose a public HTTPS
 * endpoint use Socket Mode (a WebSocket that carries the very same
 * `event_callback` envelopes the Events API would POST). Without these, an
 * inbound document on either platform never reaches the hydration path, so the
 * attachment handling added for webhooks was unreachable in practice.
 *
 * Both sources end at the same place: build an `InboundMessage`, download the
 * attachment's bytes with the shared `downloadInboundAttachment` helper, and
 * hand it to the registry's `handleInbound` — exactly like the webhook
 * receiver. Extraction, auto-reply, and the sandbox prune are therefore shared,
 * not reimplemented.
 *
 * The socket and `fetch` are injectable so tests drive a scripted gateway
 * without network or a real Discord/Slack connection.
 */

import { logger } from '../utils/logger.js';
import {
  downloadInboundAttachment,
  type RemoteAttachment,
} from './inbound-media.js';
import {
  mediaKindFromMime,
  parseWebhookPayload,
  type InboundMessage,
  type MessageHandler,
} from './adapters.js';

/** The slice of a WebSocket this module needs (real or scripted). */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
}

export type SocketFactory = (url: string) => RealtimeSocket;

/** The minimal WebSocket surface both the native client and `ws` provide. */
type AnyWebSocket = {
  send(data: string): void;
  close(): void;
  addEventListener?(type: string, cb: (ev: any) => void): void;
  on?(type: string, cb: (...args: any[]) => void): void;
};

/**
 * Default socket. Prefers the platform's built-in `WebSocket` (Node 22+, Bun,
 * Deno) and falls back to `ws` — neither is a dependency of the gateway core,
 * so this stays a lazy, best-effort import.
 */
export async function defaultSocketFactory(url: string): Promise<RealtimeSocket> {
  const Native = (globalThis as unknown as { WebSocket?: new (url: string) => AnyWebSocket }).WebSocket;
  let ws: AnyWebSocket;
  if (Native) {
    ws = new Native(url);
  } else {
    const mod = (await import('ws')) as unknown as { default?: new (url: string) => AnyWebSocket };
    const WS = mod.default;
    if (!WS) throw new Error('no WebSocket implementation available');
    ws = new WS(url);
  }
  const socket: RealtimeSocket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => ws.send(data),
    close: () => ws.close(),
  };
  if (ws.addEventListener) {
    ws.addEventListener('open', () => socket.onopen?.());
    ws.addEventListener('message', (ev: { data: unknown }) => socket.onmessage?.({ data: ev.data }));
    ws.addEventListener('close', () => socket.onclose?.());
    ws.addEventListener('error', (err: unknown) => socket.onerror?.(err));
  } else {
    ws.on?.('open', () => socket.onopen?.());
    ws.on?.('message', (data: unknown) => socket.onmessage?.({ data }));
    ws.on?.('close', () => socket.onclose?.());
    ws.on?.('error', (err: unknown) => socket.onerror?.(err));
  }
  return socket;
}

/** Base backoff/reconnect plumbing shared by both transports. */
abstract class ReconnectingSource {
  protected stopped = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  protected socket: RealtimeSocket | null = null;

  constructor(
    protected readonly backoffMs = 1_000,
    protected readonly maxBackoffMs = 30_000,
  ) {}

  protected abstract open(onMessage: MessageHandler): Promise<void>;

  async start(onMessage: MessageHandler): Promise<void> {
    this.stopped = false;
    this.attempt = 0;
    await this.connect(onMessage);
  }

  private async connect(onMessage: MessageHandler): Promise<void> {
    if (this.stopped) return;
    try {
      await this.open(onMessage);
      this.attempt = 0;
    } catch {
      // A failed handshake (bad token, network) retries with backoff rather
      // than throwing into the adapter's `start()` — the gateway must stay up.
      this.scheduleReconnect(onMessage);
    }
  }

  /** Called by the transport when its socket drops. */
  protected scheduleReconnect(onMessage: MessageHandler): void {
    if (this.stopped) return;
    this.teardownSocket();
    const delay = Math.min(this.backoffMs * 2 ** this.attempt, this.maxBackoffMs);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect(onMessage);
    }, delay);
    this.retryTimer.unref?.();
  }

  protected teardownSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.teardownSocket();
  }
}

// ─── Discord Gateway (WebSocket) ────────────────────────────────────────────

/** GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT. */
const DISCORD_INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

const DISCORD_API = 'https://discord.com/api/v10';

export interface DiscordGatewayOptions {
  token: string;
  fetchImpl?: typeof fetch;
  socketFactory?: SocketFactory;
  backoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Inbound Discord messages over the Gateway (op 10 HELLO → op 2 IDENTIFY,
 * heartbeat on the advertised interval, op 0 MESSAGE_CREATE). An attachment is
 * downloaded before dispatch so it hydrates exactly like a webhook one.
 */
export class DiscordGatewaySource extends ReconnectingSource {
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private firstBeat: ReturnType<typeof setTimeout> | null = null;
  private readonly fetcher: typeof fetch;

  constructor(private readonly opts: DiscordGatewayOptions) {
    super(opts.backoffMs, opts.maxBackoffMs);
    this.fetcher = opts.fetchImpl ?? fetch;
  }

  /** Ask Discord for the socket URL; fall back to the public base. */
  private async gatewayUrl(): Promise<string> {
    try {
      const res = await this.fetcher(`${DISCORD_API}/gateway/bot`, {
        headers: { authorization: `Bot ${this.opts.token}` },
      });
      if (res.ok) {
        const body = (await res.json()) as { url?: string };
        if (body?.url) return `${body.url}/?v=10&encoding=json`;
      }
    } catch {
      // Fall through to the public gateway.
    }
    return 'wss://gateway.discord.gg/?v=10&encoding=json';
  }

  protected async open(onMessage: MessageHandler): Promise<void> {
    const url = await this.gatewayUrl();
    const socket = this.opts.socketFactory
      ? this.opts.socketFactory(url)
      : await defaultSocketFactory(url);
    // Stopped while the handshake was in flight — do not adopt the socket.
    if (this.stopped) {
      socket.close();
      return;
    }
    this.socket = socket;
    socket.onmessage = (ev) => this.onFrame(ev.data, onMessage);
    socket.onclose = () => {
      // Logged because this is the ONLY outward sign a live check has: with no
      // handler installed the socket is otherwise invisible, and a silent
      // reconnect loop looks exactly like "no messages arrived".
      logger.warn('Discord gateway: socket closed — reconnecting with backoff');
      this.scheduleReconnect(onMessage);
    };
    socket.onerror = () => this.scheduleReconnect(onMessage);
    logger.info('Discord gateway: connected — waiting for HELLO');
  }

  private onFrame(raw: unknown, onMessage: MessageHandler): void {
    let frame: { op?: number; t?: string | null; d?: any };
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    switch (frame.op) {
      case 10: // HELLO — begin heartbeating, then identify.
        this.startHeartbeat(frame.d?.heartbeat_interval);
        this.send({
          op: 2,
          d: {
            token: this.opts.token,
            intents: DISCORD_INTENTS,
            properties: { os: 'linux', browser: 'nuvira', device: 'nuvira' },
          },
        });
        return;
      case 1: // Server asked for an immediate heartbeat.
        this.send({ op: 1, d: null });
        return;
      case 11: // Heartbeat ACK.
      case 0:
        break;
      case 7: // Reconnect requested by the server.
      case 9: // Invalid session — re-identify on a fresh socket.
        this.scheduleReconnect(onMessage);
        return;
      default:
        return;
    }
    if (frame.t === 'MESSAGE_CREATE') {
      void this.onMessageCreate(frame.d, onMessage);
    }
  }

  private startHeartbeat(intervalMs: unknown): void {
    this.clearHeartbeat();
    const interval = typeof intervalMs === 'number' && intervalMs > 0 ? intervalMs : 41_250;
    this.firstBeat = setTimeout(() => {
      this.firstBeat = null;
      this.send({ op: 1, d: null });
    }, interval * Math.random());
    this.firstBeat.unref?.();
    this.heartbeat = setInterval(() => this.send({ op: 1, d: null }), interval);
    this.heartbeat.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.firstBeat) {
      clearTimeout(this.firstBeat);
      this.firstBeat = null;
    }
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private send(payload: unknown): void {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch {
      // A dead socket surfaces via onclose → reconnect.
    }
  }

  private async onMessageCreate(d: any, onMessage: MessageHandler): Promise<void> {
    const channelId = d?.channel_id;
    const content = typeof d?.content === 'string' ? d.content : '';
    const first = (Array.isArray(d?.attachments) ? d.attachments[0] : undefined) as
      | { url?: string; filename?: string; content_type?: string; size?: number }
      | undefined;
    const hasMedia = Boolean(first?.url);
    // A media-only message has empty content — it must still dispatch.
    if (!channelId || (!content && !hasMedia)) return;

    let media: InboundMessage['media'];
    if (hasMedia && first?.url) {
      const att: RemoteAttachment = {
        type: mediaKindFromMime(first.content_type, first.filename),
        url: first.url,
        filename: first.filename,
        mimetype: first.content_type,
        size: first.size,
      };
      const downloaded = await downloadInboundAttachment(att);
      if (downloaded) media = { ...downloaded, caption: content || undefined };
    }

    await onMessage({
      platform: 'discord',
      channelId,
      text: content,
      from: d?.author?.username ?? 'discord-user',
      senderId: d?.author?.id !== undefined ? String(d.author.id) : undefined,
      ...(d?.id !== undefined ? { messageId: String(d.id) } : {}),
      // A guild_id is present for guild (group) messages, absent for DMs.
      isGroup: Boolean(d?.guild_id),
      ...(media ? { media } : {}),
    });
  }

  async stop(): Promise<void> {
    this.clearHeartbeat();
    await super.stop();
  }
}

// ─── Slack Socket Mode (WebSocket) ─────────────────────────────────────────

export interface SlackSocketModeOptions {
  /** The app-level token (`xapp-…`) used to open the socket. */
  appToken: string;
  /** The bot token (`xoxb-…`) used to download `url_private*` files. */
  botToken?: string;
  fetchImpl?: typeof fetch;
  socketFactory?: SocketFactory;
  backoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Inbound Slack messages over Socket Mode. Slack delivers the same
 * `event_callback` envelopes as the Events API, so the webhook parser is reused
 * verbatim — the only new work is the socket, the ack, and the token-auth file
 * download.
 */
export class SlackSocketModeSource extends ReconnectingSource {
  private readonly fetcher: typeof fetch;

  constructor(private readonly opts: SlackSocketModeOptions) {
    super(opts.backoffMs, opts.maxBackoffMs);
    this.fetcher = opts.fetchImpl ?? fetch;
  }

  /** `apps.connections.open` mints a single-use socket URL. */
  private async openSocketUrl(): Promise<string> {
    const res = await this.fetcher('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.appToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    if (!res.ok) throw new Error(`Slack Socket Mode open failed (${res.status})`);
    const body = (await res.json()) as { ok?: boolean; url?: string; error?: string };
    if (!body?.ok || !body.url) {
      throw new Error(`Slack Socket Mode open failed (${body?.error ?? 'unknown'})`);
    }
    return body.url;
  }

  protected async open(onMessage: MessageHandler): Promise<void> {
    const url = await this.openSocketUrl();
    const socket = this.opts.socketFactory
      ? this.opts.socketFactory(url)
      : await defaultSocketFactory(url);
    if (this.stopped) {
      socket.close();
      return;
    }
    this.socket = socket;
    socket.onmessage = (ev) => this.onFrame(ev.data, onMessage);
    socket.onclose = () => {
      logger.warn('Slack Socket Mode: socket closed — reconnecting with backoff');
      this.scheduleReconnect(onMessage);
    };
    socket.onerror = () => this.scheduleReconnect(onMessage);
    logger.info('Slack Socket Mode: connected');
  }

  private send(payload: unknown): void {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch {
      // Dead socket → onclose → reconnect.
    }
  }

  private onFrame(raw: unknown, onMessage: MessageHandler): void {
    let envelope: { type?: string; envelope_id?: string; payload?: any };
    try {
      envelope = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    // Slack retries any envelope it does not see acked.
    if (envelope.envelope_id) this.send({ envelope_id: envelope.envelope_id });

    if (envelope.type === 'disconnect') {
      // Slack is asking us to drop this connection and open a fresh URL.
      logger.info('Slack Socket Mode: server asked us to reconnect');
      this.scheduleReconnect(onMessage);
      return;
    }
    if (envelope.type !== 'events_api' || !envelope.payload) return;
    void this.onEvent(envelope.payload, onMessage);
  }

  private async onEvent(payload: any, onMessage: MessageHandler): Promise<void> {
    const parsed = parseWebhookPayload('slack', payload);
    if (!parsed) return;

    let media: InboundMessage['media'];
    if (parsed.media) {
      const att = parsed.media.attachment;
      const downloaded = await downloadInboundAttachment({
        type: parsed.media.type,
        url: att.url,
        filename: att.filename,
        mimetype: att.mimetype,
        size: att.size,
        authenticated: att.authenticated,
        token: this.opts.botToken,
      });
      if (downloaded) media = { ...downloaded, caption: parsed.media.caption };
    }

    await onMessage({
      platform: 'slack',
      channelId: parsed.channelId,
      text: parsed.text,
      from: parsed.from,
      senderId: parsed.senderId,
      isGroup: parsed.isGroup,
      ...(media ? { media } : {}),
    });
  }
}
