/**
 * Real-time inbound transports: the Discord Gateway and Slack Socket Mode.
 *
 * Both are driven by a scripted socket (`socketFactory`) and a stubbed `fetch`,
 * so the tests assert the protocol handshake, the event → InboundMessage
 * mapping, and — the point of the feature — that an attachment's bytes are
 * downloaded and carried on `media` for the shared hydration path.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DiscordGatewaySource,
  SlackSocketModeSource,
  type RealtimeSocket,
} from '../../src/gateway/realtime.js';
import type { InboundMessage } from '../../src/gateway/adapters.js';

class FakeSocket implements RealtimeSocket {
  readonly sent: any[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }
  /** Deliver a frame as the server would. */
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** Simulate the connection dropping. */
  drop(): void {
    this.onclose?.();
  }
}

/** Let the async event handlers settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Stub global fetch (used by the shared attachment downloader). */
function stubDownload(body: Uint8Array, ok = true) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok,
        arrayBuffer: async () =>
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      } as unknown as Response;
    }),
  );
  return calls;
}

function collector() {
  const seen: InboundMessage[] = [];
  return { seen, handler: (msg: InboundMessage) => { seen.push(msg); } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DiscordGatewaySource', () => {
  function startDiscord(token = 'bot-token') {
    const socket = new FakeSocket();
    const urls: string[] = [];
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({ url: 'wss://gw.example' }),
    })) as unknown as typeof fetch;
    const source = new DiscordGatewaySource({
      token,
      fetchImpl: fetcher,
      socketFactory: (url) => {
        urls.push(url);
        return socket;
      },
      backoffMs: 1,
      maxBackoffMs: 2,
    });
    return { socket, urls, source };
  }

  it('identifies with the token and message intents after HELLO', async () => {
    const { socket, urls, source } = startDiscord();
    const { handler } = collector();
    await source.start(handler);

    expect(urls).toEqual(['wss://gw.example/?v=10&encoding=json']);

    socket.emit({ op: 10, d: { heartbeat_interval: 45_000 } });
    const identify = socket.sent.find((f) => f.op === 2);
    expect(identify).toBeTruthy();
    expect(identify.d.token).toBe('bot-token');
    // GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15)
    expect(identify.d.intents).toBe((1 << 9) | (1 << 12) | (1 << 15));

    await source.stop();
    expect(socket.closed).toBe(true);
  });

  it('downloads an attachment and carries it on media', async () => {
    const { socket, source } = startDiscord();
    const { seen, handler } = collector();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const calls = stubDownload(bytes);

    await source.start(handler);
    socket.emit({ op: 10, d: { heartbeat_interval: 45_000 } });
    socket.emit({
      op: 0,
      t: 'MESSAGE_CREATE',
      d: {
        id: 'msg-1',
        channel_id: 'chan-1',
        guild_id: 'guild-1',
        content: 'here is the report',
        author: { id: 'user-1', username: 'alice' },
        attachments: [
          {
            url: 'https://cdn.example/report.pdf',
            filename: 'report.pdf',
            content_type: 'application/pdf',
            size: bytes.byteLength,
          },
        ],
      },
    });
    await flush();

    expect(calls[0].url).toBe('https://cdn.example/report.pdf');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      platform: 'discord',
      channelId: 'chan-1',
      text: 'here is the report',
      from: 'alice',
      senderId: 'user-1',
      messageId: 'msg-1',
      isGroup: true,
    });
    expect(seen[0].media?.type).toBe('document');
    expect(seen[0].media?.filename).toBe('report.pdf');
    expect(seen[0].media?.caption).toBe('here is the report');
    expect(Array.from(seen[0].media!.data)).toEqual([1, 2, 3, 4]);

    await source.stop();
  });

  it('dispatches a media-only message (empty content) but ignores empty frames', async () => {
    const { socket, source } = startDiscord();
    const { seen, handler } = collector();
    stubDownload(new Uint8Array([9]));

    await source.start(handler);
    socket.emit({ op: 10, d: { heartbeat_interval: 45_000 } });
    // No text and no attachment → dropped.
    socket.emit({ op: 0, t: 'MESSAGE_CREATE', d: { channel_id: 'c', content: '', author: {} } });
    // Attachment with no caption → still dispatched.
    socket.emit({
      op: 0,
      t: 'MESSAGE_CREATE',
      d: {
        channel_id: 'c',
        content: '',
        author: { username: 'bob' },
        attachments: [{ url: 'https://cdn.example/a.png', filename: 'a.png', content_type: 'image/png' }],
      },
    });
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0].media?.type).toBe('image');
    await source.stop();
  });

  it('skips an over-cap attachment before fetching it', async () => {
    const { socket, source } = startDiscord();
    const { seen, handler } = collector();
    const calls = stubDownload(new Uint8Array([1]));

    await source.start(handler);
    socket.emit({ op: 10, d: { heartbeat_interval: 45_000 } });
    socket.emit({
      op: 0,
      t: 'MESSAGE_CREATE',
      d: {
        channel_id: 'c',
        content: 'too big',
        author: { username: 'bob' },
        attachments: [{ url: 'https://cdn.example/huge.zip', filename: 'huge.zip', size: 999_999_999 }],
      },
    });
    await flush();

    expect(calls).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].media).toBeUndefined();
    await source.stop();
  });
});

describe('SlackSocketModeSource', () => {
  function startSlack() {
    const socket = new FakeSocket();
    const opened: string[] = [];
    const fetcher = vi.fn(async (url: unknown) => {
      if (String(url).includes('apps.connections.open')) {
        return { ok: true, json: async () => ({ ok: true, url: 'wss://slack.example/socket' }) };
      }
      return { ok: false, json: async () => ({ ok: false }) };
    }) as unknown as typeof fetch;
    const source = new SlackSocketModeSource({
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      fetchImpl: fetcher,
      socketFactory: (url) => {
        opened.push(url);
        return socket;
      },
      backoffMs: 1,
      maxBackoffMs: 2,
    });
    return { socket, opened, source };
  }

  it('opens a socket with the app token', async () => {
    const { socket, opened, source } = startSlack();
    const { handler } = collector();
    await source.start(handler);

    expect(opened).toEqual(['wss://slack.example/socket']);
    await source.stop();
    expect(socket.closed).toBe(true);
  });

  it('acks an event and downloads a Slack file with the bot token', async () => {
    const { socket, source } = startSlack();
    const { seen, handler } = collector();
    const bytes = new Uint8Array([7, 7, 7]);
    const calls = stubDownload(bytes);

    await source.start(handler);
    socket.emit({
      type: 'events_api',
      envelope_id: 'env-1',
      payload: {
        type: 'event_callback',
        event: {
          type: 'message',
          channel: 'D123',
          user: 'U1',
          text: 'the quote',
          files: [
            {
              url_private_download: 'https://files.slack.com/quote.pdf',
              name: 'quote.pdf',
              mimetype: 'application/pdf',
              size: bytes.byteLength,
            },
          ],
        },
      },
    });
    await flush();

    expect(socket.sent.some((f) => f.envelope_id === 'env-1')).toBe(true);
    expect(calls[0].url).toBe('https://files.slack.com/quote.pdf');
    // Slack file URLs need the bot token.
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer xoxb-test');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ platform: 'slack', channelId: 'D123', text: 'the quote', senderId: 'U1' });
    expect(seen[0].media?.type).toBe('document');
    expect(seen[0].media?.caption).toBe('the quote');

    await source.stop();
  });

  it('reopens the socket after a disconnect envelope', async () => {
    const { socket, opened, source } = startSlack();
    const { handler } = collector();
    await source.start(handler);
    expect(opened).toHaveLength(1);

    socket.emit({ type: 'disconnect', envelope_id: 'env-2' });
    expect(socket.closed).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(opened).toHaveLength(2);

    await source.stop();
  });

  it('retries with backoff when the handshake fails', async () => {
    const socket = new FakeSocket();
    let attempts = 0;
    const fetcher = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) return { ok: false, status: 401, json: async () => ({ ok: false }) };
      return { ok: true, json: async () => ({ ok: true, url: 'wss://slack.example/retry' }) };
    }) as unknown as typeof fetch;
    const opened: string[] = [];
    const source = new SlackSocketModeSource({
      appToken: 'xapp-test',
      fetchImpl: fetcher,
      socketFactory: (url) => {
        opened.push(url);
        return socket;
      },
      backoffMs: 1,
      maxBackoffMs: 2,
    });
    const { handler } = collector();

    // start() must not reject on a failed handshake.
    await expect(source.start(handler)).resolves.toBeUndefined();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(opened).toEqual(['wss://slack.example/retry']);

    await source.stop();
  });
});
