/**
 * I9 — Webhook/REST messaging connectors (Hermes platform parity).
 *
 * DingTalk, Feishu, WeCom, Mattermost, Matrix, generic Webhook, BlueBubbles —
 * each is a thin outbound adapter (URL + payload), verified here with a fetch
 * spy (no network). Env vars are set/restored per test; constructors read env
 * at construction time.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DingTalkAdapter,
  FeishuAdapter,
  WeComAdapter,
  MattermostAdapter,
  MatrixAdapter,
  GenericWebhookAdapter,
  BlueBubblesAdapter,
  NtfyAdapter,
  TeamsAdapter,
  GoogleChatAdapter,
  WeixinAdapter,
  SmsAdapter,
  HomeAssistantAdapter,
  createConfiguredAdapters,
} from '../../src/gateway/adapters.js';

const envBackup: Record<string, string | undefined> = {};

function setEnv(pairs: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(pairs)) {
    envBackup[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  for (const k of Object.keys(envBackup)) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  Object.keys(envBackup).forEach((k) => delete envBackup[k]);
  vi.restoreAllMocks();
});

interface CapturedCall {
  url: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Mock fetch to capture one call; resolves ok. */
function spyFetchOk(): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown, init?: RequestInit) => {
    // JSON bodies are parsed for shape assertions; form-encoded bodies (SMS)
    // fall back to the raw string.
    let body: unknown = init?.body === undefined ? undefined : String(init.body);
    if (typeof body === 'string' && body.startsWith('{')) {
      try { body = JSON.parse(body); } catch { /* keep raw */ }
    }
    calls.push({
      url: String(input),
      method: init?.method,
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return { ok: true } as Response;
  });
  return { calls };
}

describe('I9 webhook connectors — URL + payload shapes', () => {
  it('DingTalk posts msgtype text to the robot webhook', async () => {
    setEnv({ BUFF_DINGTALK_WEBHOOK_URL: 'https://oapi.dingtalk.com/robot/send?access_token=tok' });
    const { calls } = spyFetchOk();
    const adapter = new DingTalkAdapter();
    expect(adapter.configured).toBe(true);
    expect(await adapter.send('group', 'hi')).toBe(true);
    expect(calls[0].url).toBe('https://oapi.dingtalk.com/robot/send?access_token=tok');
    expect(calls[0].body).toEqual({ msgtype: 'text', text: { content: 'hi' } });
  });

  it('Feishu posts msg_type text to the bot webhook', async () => {
    setEnv({ BUFF_FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/tok' });
    const { calls } = spyFetchOk();
    const adapter = new FeishuAdapter();
    expect(await adapter.send('x', 'hi')).toBe(true);
    expect(calls[0].body).toEqual({ msg_type: 'text', content: { text: 'hi' } });
  });

  it('WeCom posts msgtype text to the group bot webhook', async () => {
    setEnv({ BUFF_WECOM_WEBHOOK_URL: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=kk' });
    const { calls } = spyFetchOk();
    const adapter = new WeComAdapter();
    expect(await adapter.send('x', 'hi')).toBe(true);
    expect(calls[0].body).toEqual({ msgtype: 'text', text: { content: 'hi' } });
  });

  it('Mattermost posts { text } to the incoming webhook', async () => {
    setEnv({ BUFF_MATTERMOST_WEBHOOK_URL: 'https://mm.example.com/hooks/abc' });
    const { calls } = spyFetchOk();
    const adapter = new MattermostAdapter();
    expect(await adapter.send('x', 'hi')).toBe(true);
    expect(calls[0].body).toEqual({ text: 'hi' });
  });

  it('Matrix posts m.text to the homeserver room endpoint with Bearer auth', async () => {
    setEnv({ BUFF_MATRIX_HOMESERVER: 'https://matrix.example.org', BUFF_MATRIX_ACCESS_TOKEN: 'tok' });
    const { calls } = spyFetchOk();
    const adapter = new MatrixAdapter();
    expect(adapter.configured).toBe(true);
    expect(await adapter.send('!room:example.org', 'hi')).toBe(true);
    const room = encodeURIComponent('!room:example.org');
    expect(calls[0].url).toBe(`https://matrix.example.org/_matrix/client/v3/rooms/${room}/send/m.room.message`);
    expect(calls[0].body).toEqual({ msgtype: 'm.text', body: 'hi' });
    expect(String(calls[0].headers?.authorization)).toBe('Bearer tok');
  });

  it('Generic webhook posts { text } to the configured URL', async () => {
    setEnv({ BUFF_WEBHOOK_URL: 'https://hooks.example.com/ingest' });
    const { calls } = spyFetchOk();
    const adapter = new GenericWebhookAdapter();
    expect(await adapter.send('x', 'hi')).toBe(true);
    expect(calls[0].url).toBe('https://hooks.example.com/ingest');
    expect(calls[0].body).toEqual({ text: 'hi' });
  });

  it('BlueBubbles posts target/message to the iMessage bridge API with the server password', async () => {
    setEnv({ BUFF_BLUEBUBBLES_URL: 'http://127.0.0.1:1234', BUFF_BLUEBUBBLES_PASSWORD: 'pw' });
    const { calls } = spyFetchOk();
    const adapter = new BlueBubblesAdapter();
    expect(adapter.configured).toBe(true);
    expect(await adapter.send('+15551234567', 'hi')).toBe(true);
    expect(calls[0].url).toBe('http://127.0.0.1:1234/api/v1/message/text');
    expect(calls[0].body).toEqual({ target: '+15551234567', message: 'hi' });
    expect(String(calls[0].headers?.authorization)).toBe('Bearer pw');
  });

  it('ntfy posts topic/message to the base URL (default ntfy.sh)', async () => {
    setEnv({ BUFF_NTFY_TOPIC: 'my-alerts', BUFF_NTFY_URL: 'https://ntfy.example.com' });
    const { calls } = spyFetchOk();
    const adapter = new NtfyAdapter();
    expect(adapter.configured).toBe(true);
    expect(await adapter.send('', 'disk full')).toBe(true);
    expect(calls[0].url).toBe('https://ntfy.example.com');
    expect(calls[0].body).toEqual({ topic: 'my-alerts', message: 'disk full' });
  });

  it('ntfy returns false without a network call when no topic is set', async () => {
    setEnv({ BUFF_NTFY_TOPIC: undefined });
    const { calls } = spyFetchOk();
    const adapter = new NtfyAdapter();
    expect(adapter.configured).toBe(false);
    expect(await adapter.send('ops', 'hi')).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('Teams posts { text } to the incoming webhook', async () => {
    setEnv({ BUFF_TEAMS_WEBHOOK_URL: 'https://outlook.office.com/webhook/abc' });
    const { calls } = spyFetchOk();
    const adapter = new TeamsAdapter();
    expect(adapter.configured).toBe(true);
    expect(await adapter.send('x', 'hi')).toBe(true);
    expect(calls[0].url).toBe('https://outlook.office.com/webhook/abc');
    expect(calls[0].body).toEqual({ text: 'hi' });
  });

  it('Google Chat posts { text } to the space webhook', async () => {
    setEnv({ BUFF_GOOGLE_CHAT_WEBHOOK_URL: 'https://chat.googleapis.com/v1/spaces/AAA/messages' });
    const { calls } = spyFetchOk();
    const adapter = new GoogleChatAdapter();
    expect(adapter.configured).toBe(true);
    expect(await adapter.send('x', 'hi')).toBe(true);
    expect(calls[0].url).toBe('https://chat.googleapis.com/v1/spaces/AAA/messages');
    expect(calls[0].body).toEqual({ text: 'hi' });
  });

  it('SMS posts a form-encoded Twilio Messages.json with Basic auth and the from number', async () => {
    setEnv({
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'tok',
      TWILIO_PHONE_NUMBER: '+15551234567',
    });
    const { calls } = spyFetchOk();
    const adapter = new SmsAdapter();
    expect(adapter.configured).toBe(true);
    expect(await adapter.send('+15559998888', 'hi')).toBe(true);
    expect(calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    // Twilio auth is Basic base64(SID:Token) — not Bearer.
    expect(String(calls[0].headers?.authorization)).toBe(`Basic ${Buffer.from('AC123:tok').toString('base64')}`);
    expect(String(calls[0].headers?.['content-type'])).toContain('application/x-www-form-urlencoded');
    // Form-encoded body (not JSON): From / To / Body (URLSearchParams escapes
    // the '+' in E.164 numbers, so parse the form back in the assertion).
    const form = new URLSearchParams(String(calls[0].body));
    expect(form.get('From')).toBe('+15551234567');
    expect(form.get('To')).toBe('+15559998888');
    expect(form.get('Body')).toBe('hi');
  });

  it('SMS caps the message at the Twilio 1600-char limit', async () => {
    setEnv({
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'tok',
      TWILIO_PHONE_NUMBER: '+15551234567',
    });
    const { calls } = spyFetchOk();
    const adapter = new SmsAdapter();
    expect(await adapter.send('x', 'a'.repeat(4000))).toBe(true);
    const form = new URLSearchParams(String(calls[0].body));
    expect(form.get('Body')?.length).toBe(1600);
  });

  it('Home Assistant posts notify.notify with the target when a channel id is given', async () => {
    setEnv({ HASS_TOKEN: 'ha-token', HASS_URL: 'http://ha.local:8123' });
    const { calls } = spyFetchOk();
    const adapter = new HomeAssistantAdapter();
    expect(adapter.configured).toBe(true);
    expect(await adapter.send('mobile_app_phone', 'front door open')).toBe(true);
    expect(calls[0].url).toBe('http://ha.local:8123/api/services/notify/notify');
    expect(String(calls[0].headers?.authorization)).toBe('Bearer ha-token');
    expect(calls[0].body).toEqual({ message: 'front door open', target: 'mobile_app_phone' });
  });

  it('Home Assistant falls back to persistent_notification.create without a target', async () => {
    setEnv({ HASS_TOKEN: 'ha-token' });
    const { calls } = spyFetchOk();
    const adapter = new HomeAssistantAdapter();
    expect(await adapter.send('', 'nightly done')).toBe(true);
    expect(calls[0].url).toBe('http://homeassistant.local:8123/api/services/persistent_notification/create');
    expect(calls[0].body).toMatchObject({ title: 'Agent-Nuvira', message: 'nightly done' });
  });

  it('Home Assistant caps the message at the Hermes 4096-char limit', async () => {
    setEnv({ HASS_TOKEN: 'ha-token' });
    const { calls } = spyFetchOk();
    const adapter = new HomeAssistantAdapter();
    expect(await adapter.send('x', 'a'.repeat(5000))).toBe(true);
    const body = calls[0].body as { message?: string };
    expect(body.message?.length).toBe(4096);
  });

  it('Weixin posts the iLink bot payload with AuthorizationType header and the jid target', async () => {
    setEnv({ BUFF_WEIXIN_TOKEN: 'bot-token' });
    const { calls } = spyFetchOk();
    const adapter = new WeixinAdapter();
    expect(adapter.configured).toBe(true);
    expect(await adapter.send('wxid_user1', 'hi')).toBe(true);
    expect(calls[0].url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
    expect(String(calls[0].headers?.authorizationtype)).toBe('ilink_bot_token');
    expect(calls[0].body).toMatchObject({
      msg: {
        to_user_id: 'wxid_user1',
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: 'hi' } }],
      },
    });
    const msg = (calls[0].body as { msg: { client_id: string } }).msg;
    expect(typeof msg.client_id).toBe('string');
    expect(msg.client_id.length).toBeGreaterThan(8);
  });
});

describe('I9 connectors — unconfigured + failure behavior', () => {
  it('returns false without calling the network when env tokens are absent', async () => {
    setEnv({
      BUFF_DINGTALK_WEBHOOK_URL: undefined,
      BUFF_FEISHU_WEBHOOK_URL: undefined,
      BUFF_WECOM_WEBHOOK_URL: undefined,
      BUFF_MATTERMOST_WEBHOOK_URL: undefined,
      BUFF_MATRIX_HOMESERVER: undefined,
      BUFF_MATRIX_ACCESS_TOKEN: undefined,
      BUFF_WEBHOOK_URL: undefined,
      BUFF_BLUEBUBBLES_URL: undefined,
      BUFF_BLUEBUBBLES_PASSWORD: undefined,
      BUFF_NTFY_TOPIC: undefined,
      BUFF_TEAMS_WEBHOOK_URL: undefined,
      BUFF_GOOGLE_CHAT_WEBHOOK_URL: undefined,
      BUFF_WEIXIN_TOKEN: undefined,
      TWILIO_ACCOUNT_SID: undefined,
      TWILIO_AUTH_TOKEN: undefined,
      TWILIO_PHONE_NUMBER: undefined,
      IRC_SERVER: undefined,
      SIMPLEX_WS_URL: undefined,
      HASS_TOKEN: undefined,
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const adapters = [
      new DingTalkAdapter(),
      new FeishuAdapter(),
      new WeComAdapter(),
      new MattermostAdapter(),
      new MatrixAdapter(),
      new GenericWebhookAdapter(),
      new BlueBubblesAdapter(),
      new NtfyAdapter(),
      new TeamsAdapter(),
      new GoogleChatAdapter(),
      new WeixinAdapter(),
      new SmsAdapter(),
      new HomeAssistantAdapter(),
    ];
    for (const a of adapters) {
      expect(a.configured).toBe(false);
      expect(await a.send('x', 'hi')).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false on network failure (never throws)', async () => {
    setEnv({ BUFF_WEBHOOK_URL: 'https://hooks.example.com/ingest' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const adapter = new GenericWebhookAdapter();
    expect(await adapter.send('x', 'hi')).toBe(false);
  });
});

describe('createConfiguredAdapters — I9 platforms opt in via env', () => {
  it('includes each I9 connector only when its env vars are present', () => {
    setEnv({
      BUFF_DINGTALK_WEBHOOK_URL: undefined,
      BUFF_FEISHU_WEBHOOK_URL: undefined,
      BUFF_WECOM_WEBHOOK_URL: undefined,
      BUFF_MATTERMOST_WEBHOOK_URL: undefined,
      BUFF_MATRIX_HOMESERVER: undefined,
      BUFF_MATRIX_ACCESS_TOKEN: undefined,
      BUFF_WEBHOOK_URL: undefined,
      BUFF_BLUEBUBBLES_URL: undefined,
      BUFF_BLUEBUBBLES_PASSWORD: undefined,
      BUFF_NTFY_TOPIC: undefined,
      BUFF_TEAMS_WEBHOOK_URL: undefined,
      BUFF_GOOGLE_CHAT_WEBHOOK_URL: undefined,
      BUFF_WEIXIN_TOKEN: undefined,
      TWILIO_ACCOUNT_SID: undefined,
      TWILIO_AUTH_TOKEN: undefined,
      TWILIO_PHONE_NUMBER: undefined,
      IRC_SERVER: undefined,
      SIMPLEX_WS_URL: undefined,
      HASS_TOKEN: undefined,
    });
    let platforms = createConfiguredAdapters().map((a) => a.platform);
    for (const p of ['dingtalk', 'feishu', 'wecom', 'mattermost', 'matrix', 'webhook', 'bluebubbles', 'ntfy', 'teams', 'google_chat', 'weixin', 'sms', 'homeassistant']) {
      expect(platforms).not.toContain(p);
    }

    setEnv({
      BUFF_DINGTALK_WEBHOOK_URL: 'https://oapi.dingtalk.com/robot/send?access_token=t',
      BUFF_FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/t',
      BUFF_WECOM_WEBHOOK_URL: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k',
      BUFF_MATTERMOST_WEBHOOK_URL: 'https://mm.example.com/hooks/a',
      BUFF_MATRIX_HOMESERVER: 'https://matrix.example.org',
      BUFF_MATRIX_ACCESS_TOKEN: 'tok',
      BUFF_WEBHOOK_URL: 'https://hooks.example.com/ingest',
      BUFF_BLUEBUBBLES_URL: 'http://127.0.0.1:1234',
      BUFF_BLUEBUBBLES_PASSWORD: 'pw',
      BUFF_NTFY_TOPIC: 'alerts',
      BUFF_TEAMS_WEBHOOK_URL: 'https://outlook.office.com/webhook/a',
      BUFF_GOOGLE_CHAT_WEBHOOK_URL: 'https://chat.googleapis.com/v1/spaces/A/messages',
      BUFF_WEIXIN_TOKEN: 'bot-token',
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'tok',
      TWILIO_PHONE_NUMBER: '+15551234567',
      IRC_SERVER: 'irc.libera.chat',
      SIMPLEX_WS_URL: 'ws://127.0.0.1:5225',
      HASS_TOKEN: 'ha-token',
    });
    platforms = createConfiguredAdapters().map((a) => a.platform);
    for (const p of ['dingtalk', 'feishu', 'wecom', 'mattermost', 'matrix', 'webhook', 'bluebubbles', 'ntfy', 'teams', 'google_chat', 'weixin', 'sms', 'homeassistant']) {
      expect(platforms).toContain(p);
    }
  });
});
