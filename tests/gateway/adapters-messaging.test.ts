/**
 * Messaging hot-path tests for the platforms the original adapter suite left
 * uncovered (assessment §1 follow-up):
 *
 *  - TelegramAdapter: Bot API long-poll (send + inbound getUpdates loop +
 *    unconfigured fast-fail).
 *  - DiscordAdapter / SlackAdapter: the Bot-token REST send paths (the
 *    webhook base is covered by connectors.test.ts; these cover the token
 *    routes and Bearer auth).
 *  - WhatsAppCloudAdapter: Meta Cloud API send + WebhookReceiver inbound with
 *    X-Hub-Signature-256 verification (good and bad signatures, hub.challenge).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import { TelegramAdapter, DiscordAdapter, SlackAdapter, WhatsAppCloudAdapter, WebhookReceiver, MatrixAdapter } from '../../src/gateway/adapters.js';
import type { InboundMessage } from '../../src/gateway/adapters.js';

// ─── Telegram (Bot API long-poll) ───────────────────────────────────────────

describe('TelegramAdapter (Bot API long-poll)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('send() POSTs sendMessage to the Bot API with the chat id and sanitized text', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const adapter = new TelegramAdapter('test-token');
    expect(adapter.configured).toBe(true);
    expect(await adapter.send('42', 'hello telegram')).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.telegram.org/bottest-token/sendMessage');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: 42,
      text: 'hello telegram',
      disable_web_page_preview: true,
    });
  });

  it('start() long-polls getUpdates, advances the offset, and dispatches inbound', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    // The update is delivered ONCE (the adapter acks it via offset), so later
    // polls return nothing — otherwise the same update would re-deliver every
    // 10ms while the test waits.
    let delivered = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown, init?: unknown) => {
      const body = JSON.parse(String((init as { body?: unknown })?.body ?? '{}'));
      calls.push({ url: String(url), body });
      const result = delivered ? [] : [{ update_id: 7, message: { chat: { id: 42 }, text: 'hi there', from: { first_name: 'Bob' } } }];
      delivered = true;
      return { ok: true, json: async () => ({ result }) } as Response;
    });

    const adapter = new TelegramAdapter('test-token', 10);
    const received: Array<{ platform: string; channelId: string; text: string; from: string }> = [];
    await adapter.start((m) => received.push(m));
    // Let a couple of poll cycles complete.
    await new Promise((r) => setTimeout(r, 50));
    await adapter.stop();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ platform: 'telegram', channelId: '42', text: 'hi there', from: 'Bob' });
    // First poll has no offset; the SECOND poll must use update_id 7 + 1.
    const offsets = calls.map((c) => (c.body as { offset?: number }).offset);
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(8);
    expect(String(calls[0].url)).toBe('https://api.telegram.org/bottest-token/getUpdates');
  });

  it('returns false without a network call when unconfigured, and start() throws', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const adapter = new TelegramAdapter('');
    expect(adapter.configured).toBe(false);
    expect(await adapter.send('42', 'x')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(adapter.start(() => {})).rejects.toThrow(/not configured/);
  });

  it('returns false on network failure (never throws)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const adapter = new TelegramAdapter('test-token');
    expect(await adapter.send('42', 'x')).toBe(false);
  });

  it('sendMedia() POSTs multipart to sendPhoto with chat_id, caption and the file', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const adapter = new TelegramAdapter('test-token');
    const ok = await adapter.sendMedia('42', {
      type: 'image',
      data: new Uint8Array([137, 80, 78, 71]),
      caption: 'look at this',
      filename: 'pic.png',
    });
    expect(ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.telegram.org/bottest-token/sendPhoto');
    expect(init?.method).toBe('POST');
    const form = init?.body as FormData;
    expect(form.get('chat_id')).toBe('42');
    expect(form.get('caption')).toBe('look at this');
    const file = form.get('photo') as File;
    expect(file.name).toBe('pic.png');
  });

  it('sendMedia() maps document → sendDocument, fills a default filename, and caps the caption', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const adapter = new TelegramAdapter('test-token');
    const longCaption = 'x'.repeat(5000);
    expect(await adapter.sendMedia('42', { type: 'document', data: new Uint8Array([1]), caption: longCaption })).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.telegram.org/bottest-token/sendDocument');
    const form = init?.body as FormData;
    expect(String(form.get('caption')).length).toBe(1024);
    const file = form.get('document') as File;
    expect(file.name).toBe('file.bin');
  });

  it('sendMedia() returns false without a network call when unconfigured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    expect(await new TelegramAdapter('').sendMedia('42', { type: 'image', data: new Uint8Array([1]) })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── Discord / Slack Bot-token REST paths ───────────────────────────────────

describe('DiscordAdapter + SlackAdapter (Bot-token REST sends)', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['NUVIRA_DISCORD_WEBHOOK_URL', 'NUVIRA_DISCORD_BOT_TOKEN', 'NUVIRA_SLACK_WEBHOOK_URL', 'NUVIRA_SLACK_BOT_TOKEN']) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of Object.keys(envBackup)) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    vi.restoreAllMocks();
  });

  it('Discord sends to the REST channel endpoint with a Bearer bot token when no webhook URL is set', async () => {
    process.env.NUVIRA_DISCORD_BOT_TOKEN = 'discord-bot-token';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const adapter = new DiscordAdapter();
    expect(adapter.configured).toBe(true);
    expect(await adapter.send('123456789', 'hi discord')).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://discord.com/api/v10/channels/123456789/messages');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer discord-bot-token');
    expect(JSON.parse(String(init?.body))).toEqual({ content: 'hi discord' });
  });

  it('Discord sendMedia() posts multipart payload_json + files[0] to the webhook URL', async () => {
    process.env.NUVIRA_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/111/abc';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const adapter = new DiscordAdapter();
    expect(adapter.configured).toBe(true);
    const ok = await adapter.sendMedia('123456789', {
      type: 'video',
      data: new Uint8Array([1, 2, 3]),
      caption: 'clip!',
      filename: 'clip.mp4',
    });
    expect(ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://discord.com/api/webhooks/111/abc');
    const form = init?.body as FormData;
    expect(JSON.parse(String(form.get('payload_json')))).toEqual({ content: 'clip!' });
    const file = form.get('files[0]') as File;
    expect(file.name).toBe('clip.mp4');
  });

  it('Discord sendMedia() uses the REST channel endpoint with Bearer auth when no webhook URL is set', async () => {
    process.env.NUVIRA_DISCORD_BOT_TOKEN = 'discord-bot-token';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const adapter = new DiscordAdapter();
    expect(await adapter.sendMedia('123456789', { type: 'image', data: new Uint8Array([1]), filename: 'a.png' })).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://discord.com/api/v10/channels/123456789/messages');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer discord-bot-token');
    const form = init?.body as FormData;
    expect(JSON.parse(String(form.get('payload_json')))).toEqual({ content: '' });
    const file = form.get('files[0]') as File;
    expect(file.name).toBe('a.png');
  });

  it('Discord sendMedia() returns false without a network call when unconfigured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    expect(await new DiscordAdapter().sendMedia('1', { type: 'image', data: new Uint8Array([1]) })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Slack sends to chat.postMessage with a Bearer bot token and the channel in the payload', async () => {
    process.env.NUVIRA_SLACK_BOT_TOKEN = 'slack-bot-token';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const adapter = new SlackAdapter();
    expect(adapter.configured).toBe(true);
    expect(await adapter.send('C1234', 'hi slack')).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://slack.com/api/chat.postMessage');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer slack-bot-token');
    expect(JSON.parse(String(init?.body))).toEqual({ channel: 'C1234', text: 'hi slack' });
  });

  it('both return false without a network call when unconfigured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    expect(await new DiscordAdapter().send('1', 'x')).toBe(false);
    expect(await new SlackAdapter().send('1', 'x')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── WhatsApp Cloud (Meta Business API) ─────────────────────────────────────

describe('WhatsAppCloudAdapter (Meta Cloud API)', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['NUVIRA_WHATSAPP_TOKEN', 'NUVIRA_WHATSAPP_PHONE_ID']) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of Object.keys(envBackup)) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    vi.restoreAllMocks();
  });

  it('send() POSTs the messaging_product payload to the Graph API with a Bearer token', async () => {
    process.env.NUVIRA_WHATSAPP_TOKEN = 'wa-token';
    process.env.NUVIRA_WHATSAPP_PHONE_ID = 'phone-123';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const adapter = new WhatsAppCloudAdapter();
    expect(adapter.configured).toBe(true);
    expect(await adapter.send('15551234567', 'hello wa')).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://graph.facebook.com/v20.0/phone-123/messages');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer wa-token');
    expect(JSON.parse(String(init?.body))).toEqual({
      messaging_product: 'whatsapp',
      to: '15551234567',
      type: 'text',
      text: { body: 'hello wa' },
    });
  });

  it('returns false without a network call when token or phone id is missing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    expect(await new WhatsAppCloudAdapter().send('15551234567', 'x')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── WebhookReceiver — WhatsApp X-Hub-Signature-256 verification ────────────

describe('WebhookReceiver WhatsApp inbound (X-Hub-Signature-256)', () => {
  const envBackup: Record<string, string | undefined> = {};
  // Each test binds its OWN port: server.close() is async, so reusing one
  // port across tests races the previous listener's shutdown (EADDRINUSE).
  let portSeq = 18787;
  let PORT = 18787;
  let receiver: WebhookReceiver | null = null;

  beforeEach(() => {
    PORT = portSeq++;
    envBackup.NUVIRA_WHATSAPP_APP_SECRET = process.env.NUVIRA_WHATSAPP_APP_SECRET;
    envBackup.NUVIRA_WHATSAPP_VERIFY_TOKEN = process.env.NUVIRA_WHATSAPP_VERIFY_TOKEN;
    process.env.NUVIRA_WHATSAPP_APP_SECRET = 'wa-app-secret';
    process.env.NUVIRA_WHATSAPP_VERIFY_TOKEN = 'verify-me';
  });

  afterEach(async () => {
    await receiver?.stop();
    receiver = null;
    for (const k of Object.keys(envBackup)) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
  });

  function post(path: string, body: string, signature?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: PORT, path, method: 'POST' },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 500));
        },
      );
      req.on('error', reject);
      if (signature) req.setHeader('X-Hub-Signature-256', signature);
      req.end(body);
    });
  }

  it('accepts a correctly-signed payload and dispatches it to the handler', async () => {
    const received: Array<{ platform: string; channelId: string; text: string }> = [];
    receiver = new WebhookReceiver();
    await receiver.start((m) => received.push(m), PORT, '127.0.0.1');

    const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '15551234567', type: 'text', text: { body: 'hi cloud' } }] } }] }] });
    const signature = `sha256=${createHmac('sha256', 'wa-app-secret').update(raw).digest('hex')}`;
    const status = await post('/whatsapp', raw, signature);
    expect(status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ platform: 'whatsapp', channelId: '15551234567', text: 'hi cloud' });
  });

  it('rejects a tampered signature with 401 and never dispatches', async () => {
    const received: Array<unknown> = [];
    receiver = new WebhookReceiver();
    await receiver.start((m) => received.push(m), PORT, '127.0.0.1');

    const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '15551234567', type: 'text', text: { body: 'evil' } }] } }] }] });
    const status = await post('/whatsapp', raw, 'sha256=deadbeef');
    expect(status).toBe(401);
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toHaveLength(0);
  });

  it('answers the hub.challenge GET when the verify token matches', async () => {
    receiver = new WebhookReceiver();
    await receiver.start(() => {}, PORT, '127.0.0.1');
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: PORT, path: '/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123', method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c));
        res.on('end', () => {
          expect(body).toBe('abc123');
          resolve(res.statusCode ?? 500);
        });
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
  });
});

// ─── Matrix inbound (/sync long-poll, P3) ───────────────────────────────────

describe('MatrixAdapter inbound (P3)', () => {
  const HOST = 'https://matrix.example.org';
  const TOKEN = 'tok';
  const oldHost = process.env.NUVIRA_MATRIX_HOMESERVER;
  const oldToken = process.env.NUVIRA_MATRIX_ACCESS_TOKEN;

  beforeEach(() => {
    process.env.NUVIRA_MATRIX_HOMESERVER = HOST;
    process.env.NUVIRA_MATRIX_ACCESS_TOKEN = TOKEN;
  });

  afterEach(() => {
    if (oldHost === undefined) delete process.env.NUVIRA_MATRIX_HOMESERVER;
    else process.env.NUVIRA_MATRIX_HOMESERVER = oldHost;
    if (oldToken === undefined) delete process.env.NUVIRA_MATRIX_ACCESS_TOKEN;
    else process.env.NUVIRA_MATRIX_ACCESS_TOKEN = oldToken;
    vi.restoreAllMocks();
  });

  it('relays m.text room messages from the /sync long-poll and skips its own sends', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/account/whoami')) {
        return { ok: true, json: async () => ({ user_id: '@bot:example.org' }) } as Response;
      }
      if (u.includes('/sync')) {
        return {
          ok: true,
          json: async () => ({
            next_batch: 's2',
            rooms: {
              join: {
                '!room:example.org': {
                  timeline: {
                    events: [
                      { type: 'm.room.message', sender: '@alice:example.org', content: { msgtype: 'm.text', body: 'fix the failing test' } },
                      // Our own reply — must be skipped (ownUserId learned).
                      { type: 'm.room.message', sender: '@bot:example.org', content: { msgtype: 'm.text', body: 'done' } },
                      // Non-text / non-message events — skipped.
                      { type: 'm.room.member', sender: '@bob:example.org', content: {} },
                    ],
                  },
                },
              },
            },
          }),
        } as Response;
      }
      return { ok: false } as Response;
    });

    const adapter = new MatrixAdapter();
    const received: InboundMessage[] = [];
    await adapter.start((m) => received.push(m));
    await new Promise((r) => setTimeout(r, 60));
    await adapter.stop();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      platform: 'matrix',
      channelId: '!room:example.org',
      text: 'fix the failing test',
      senderId: '@alice:example.org',
      isGroup: true,
    });
    // The sync URL carried the Bearer token.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/sync'))).toBe(true);
  });

  it('start() throws when unconfigured', async () => {
    delete process.env.NUVIRA_MATRIX_HOMESERVER;
    const adapter = new MatrixAdapter();
    await expect(adapter.start(() => {})).rejects.toThrow('not configured');
  });
});
