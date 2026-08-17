/**
 * I6 — Email (SMTP) + Signal adapter tests.
 *
 * The EmailAdapter is exercised against a REAL in-process mock SMTP server
 * (node:net — no external deps): full EHLO → AUTH LOGIN → MAIL FROM → RCPT TO
 * → DATA flow, plus auth-less and failure paths. The SignalAdapter is tested
 * with a mocked fetch against the signal-cli-rest-api contract.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import {
  EmailAdapter,
  SignalAdapter,
  IrcAdapter,
  SimplexAdapter,
  createConfiguredAdapters,
  ircSend,
  simplexSend,
  smtpSend,
  splitIrcMessage,
  stripIrcMarkdown,
  type IrcOptions,
  type SimplexOptions,
  type SmtpOptions,
} from '../../src/gateway/adapters.js';

// ─── Minimal in-process SMTP server ─────────────────────────────────────────

interface SmtpCapture {
  connections: number;
  ehlo: boolean;
  authUser?: string;
  authPass?: string;
  mailFrom?: string;
  rcptTo?: string;
  messages: string[];
}

/** Start a scripted SMTP server. Responds with the given function per command. */
function startMockSmtp(
  respond: (command: string, capture: SmtpCapture) => string[] | string,
): Promise<{ port: number; capture: SmtpCapture; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const capture: SmtpCapture = { connections: 0, ehlo: false, messages: [] };
    let server: Server | null = null;
    let dataMode = false;
    let dataBuf = '';

    server = createServer((sock: Socket) => {
      capture.connections += 1;
      sock.write('220 mock-smtp ESMTP ready\r\n');
      let buf = '';
      const send = (lines: string[] | string): void => {
        const arr = typeof lines === 'string' ? [lines] : lines;
        sock.write(arr.join('\r\n') + '\r\n');
      };
      sock.on('error', () => { /* client may reset — never uncaught */ });
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const rawLine = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const line = rawLine.replace(/\r$/, '');
          if (dataMode) {
            dataBuf += line + '\n';
            if (dataBuf.endsWith('\n.\n')) {
              const body = dataBuf.slice(0, -3);
              dataMode = false;
              dataBuf = '';
              capture.messages.push(body);
              send(respond('DATA_END', capture));
            }
            continue;
          }
          const upper = line.toUpperCase();
          if (upper.startsWith('EHLO')) {
            capture.ehlo = true;
            send(['250-mock-smtp', '250 AUTH LOGIN']);
          } else if (upper === 'AUTH LOGIN') {
            send('334 VXNlcm5hbWU6'); // "Username:"
          } else if (upper.startsWith('MAIL FROM')) {
            capture.mailFrom = line;
            send(respond('MAIL', capture));
          } else if (upper.startsWith('RCPT TO')) {
            capture.rcptTo = line;
            send(respond('RCPT', capture));
          } else if (upper === 'DATA') {
            dataMode = true;
            dataBuf = '';
            send('354 End data with <CR><LF>.<CR><LF>');
          } else if (upper === 'QUIT') {
            send('221 Bye');
            sock.end();
          } else if (/^[A-Za-z0-9+/=]+$/.test(upper) && capture.authUser === undefined) {
            capture.authUser = Buffer.from(line, 'base64').toString('utf-8');
            send('334 UGFzc3dvcmQ6'); // "Password:"
          } else if (/^[A-Za-z0-9+/=]+$/.test(upper) && capture.authUser !== undefined && capture.authPass === undefined) {
            capture.authPass = Buffer.from(line, 'base64').toString('utf-8');
            send('235 2.7.0 Authentication successful');
          } else {
            send(respond(upper, capture));
          }
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : 0,
        capture,
        close: () => new Promise((r) => { try { server!.close(() => r()); } catch { r(); } }),
      });
    });
  });
}

const OPTS: SmtpOptions = { host: '127.0.0.1', port: 0, secure: false, user: 'bot', pass: 'sekret', from: 'bot@example.com' };

describe('EmailAdapter (SMTP)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers a message through the full EHLO→AUTH→MAIL→RCPT→DATA flow', async () => {
    const smtp = await startMockSmtp(() => '250 OK');
    const opts = { ...OPTS, port: smtp.port };
    try {
      const adapter = new EmailAdapter(opts);
      expect(adapter.configured).toBe(true);
      expect(await adapter.send('ops@example.com', 'nightly build done')).toBe(true);

      expect(smtp.capture.ehlo).toBe(true);
      expect(smtp.capture.authUser).toBe('bot');
      expect(smtp.capture.authPass).toBe('sekret');
      expect(smtp.capture.mailFrom).toBe('MAIL FROM:<bot@example.com>');
      expect(smtp.capture.rcptTo).toBe('RCPT TO:<ops@example.com>');
      expect(smtp.capture.messages).toHaveLength(1);
      const msg = smtp.capture.messages[0];
      expect(msg).toContain('From: bot@example.com');
      expect(msg).toContain('To: <ops@example.com>');
      expect(msg).toContain('Subject: Agent-Nuvira gateway message');
      expect(msg).toContain('nightly build done');
    } finally {
      await smtp.close();
    }
  });

  it('sends without auth when no user is configured', async () => {
    const smtp = await startMockSmtp(() => '250 OK');
    const opts = { host: '127.0.0.1', port: smtp.port, secure: false, from: 'relay@example.com' };
    try {
      const adapter = new EmailAdapter(opts);
      expect(await adapter.send('to@example.com', 'plain relay')).toBe(true);
      expect(smtp.capture.authUser).toBeUndefined();
      expect(smtp.capture.messages[0]).toContain('plain relay');
    } finally {
      await smtp.close();
    }
  });

  it('returns false when the server rejects MAIL FROM (5xx)', async () => {
    const smtp = await startMockSmtp((cmd) => (cmd === 'MAIL' ? '550 Sender rejected' : '250 OK'));
    const opts = { ...OPTS, port: smtp.port };
    try {
      expect(await new EmailAdapter(opts).send('to@example.com', 'x')).toBe(false);
    } finally {
      await smtp.close();
    }
  });

  it('returns false without connecting when unconfigured', async () => {
    const adapter = new EmailAdapter({ host: '', port: 587, secure: false, from: '' });
    expect(adapter.configured).toBe(false);
    expect(await adapter.send('to@example.com', 'x')).toBe(false);
  });

  it('dot-stuffs lines starting with a period (SMTP protocol requirement)', async () => {
    const smtp = await startMockSmtp(() => '250 OK');
    const opts = { ...OPTS, port: smtp.port };
    try {
      const body = ['first line', '.starts with a dot', '..double', '.', 'last'].join('\n');
      const adapter = new EmailAdapter(opts);
      expect(await adapter.send('to@example.com', body)).toBe(true);
      const received = smtp.capture.messages[0];
      // The mock sees the RAW payload — every line starting with '.' is doubled.
      expect(received).toContain('\n..starts with a dot');
      expect(received).toContain('\n...double');
      expect(received).toContain('\n..\n');
    } finally {
      await smtp.close();
    }
  });

  it('rejects CRLF injection in the recipient without connecting', async () => {
    const smtp = await startMockSmtp(() => '250 OK');
    const opts = { ...OPTS, port: smtp.port };
    try {
      const adapter = new EmailAdapter(opts);
      expect(await adapter.send('victim@x.com\r\nRCPT TO:<evil@y.com>', 'hi')).toBe(false);
      expect(smtp.capture.connections).toBe(0);
    } finally {
      await smtp.close();
    }
  });

  it('smtpSend times out/fails gracefully when the server never answers', async () => {
    const dead = createServer((s: Socket) => { s.on('error', () => { /* ignore resets */ }); });
    const port = await new Promise<number>((r) => dead.listen(0, '127.0.0.1', () => {
      const a = dead.address();
      r(typeof a === 'object' && a ? a.port : 0);
    }));
    try {
      const result = await smtpSend({ host: '127.0.0.1', port, secure: false, from: 'a@b.c' }, 'to@x.y', 'hi', 300);
      expect(result).toBe(false);
    } finally {
      dead.close();
    }
  });
});

// ─── Minimal in-process mock IRC server ─────────────────────────────────────

interface IrcCapture {
  connections: number;
  lines: string[];
  privmsg: Array<{ target: string; text: string }>;
  joins: string[];
}

/**
 * Start a scripted IRC server. Sends 001 RPL_WELCOME + 366 after NICK/USER,
 * replies to PING, and records every client line. `onPrivmsg` lets a test
 * inject error numerics (e.g. `:mock 401 nick target :No such nick`).
 */
function startMockIrc(
  onPrivmsg?: (target: string, text: string, capture: IrcCapture) => string | null,
): Promise<{
  port: number;
  capture: IrcCapture;
  /** Push a server→client line at the current connection (inbound tests). */
  push: (line: string) => void;
  /** Drop the current connection (reconnect tests). */
  drop: () => void;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const capture: IrcCapture = { connections: 0, lines: [], privmsg: [], joins: [] };
    let server: Server | null = null;
    let currentSock: Socket | null = null;

    server = createServer((sock: Socket) => {
      capture.connections += 1;
      currentSock = sock;
      let buf = '';
      let nick = 'agent-nuvira';
      const send = (line: string): void => sock.write(line + '\r\n');

      sock.on('error', () => { /* client may reset — never uncaught */ });
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const line = raw.replace(/\r$/, '');
          capture.lines.push(line);
          if (line.startsWith('PASS ')) { /* recorded */ }
          else if (line.startsWith('NICK ')) nick = line.slice(5).trim();
          else if (line.startsWith('USER ')) {
            // Registration complete → welcome only. 366 (join confirmation)
            // is sent ONLY in response to JOIN, like a real IRC server.
            send(`:mock 001 ${nick} :Welcome to the mock IRC network`);
          } else if (line.startsWith('JOIN ')) {
            capture.joins.push(line.slice(5).trim());
            send(`:mock 366 ${nick} ${line.slice(5).trim()} :End of /NAMES list`);
          } else if (line.startsWith('PRIVMSG ')) {
            const rest = line.slice(8);
            const colon = rest.indexOf(' :');
            const target = colon === -1 ? rest : rest.slice(0, colon);
            const text = colon === -1 ? '' : rest.slice(colon + 2);
            capture.privmsg.push({ target, text });
            if (onPrivmsg) {
              const error = onPrivmsg(target, text, capture);
              if (error) send(error);
            }
          } else if (line.startsWith('PING ')) {
            send(`PONG ${line.slice(5)}`);
          } else if (line.startsWith('QUIT')) {
            sock.end();
          }
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : 0,
        capture,
        push: (line: string): void => {
          if (currentSock && !currentSock.destroyed) currentSock.write(line + '\r\n');
        },
        drop: (): void => {
          currentSock?.destroy();
        },
        close: () => new Promise((r) => { try { server!.close(() => r()); } catch { r(); } }),
      });
    });
  });
}

const IRC_OPTS = (port: number, over: Partial<IrcOptions> = {}): IrcOptions => ({
  server: '127.0.0.1',
  port,
  useTls: false,
  nickname: 'agent-nuvira',
  graceMs: 150,
  settleDelayMs: 80,
  ...over,
});

/** Poll until `cond` is true (real sockets — everything is async here). */
async function until(cond: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for IRC condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('IrcAdapter / ircSend (RFC 1459)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers (NICK/USER), joins a channel target and delivers the PRIVMSG', async () => {
    const irc = await startMockIrc();
    try {
      const adapter = new IrcAdapter(IRC_OPTS(irc.port));
      expect(adapter.configured).toBe(true);
      expect(await adapter.send('#ops', 'nightly build done')).toBe(true);

      expect(irc.capture.connections).toBe(1);
      expect(irc.capture.lines[0]).toBe('NICK agent-nuvira');
      expect(irc.capture.lines[1]).toBe('USER agent-nuvira 0 * :Agent-Nuvira gateway');
      expect(irc.capture.joins).toEqual(['#ops']);
      expect(irc.capture.privmsg).toEqual([{ target: '#ops', text: 'nightly build done' }]);
    } finally {
      await irc.close();
    }
  });

  it('sends a DM to a nick without JOIN', async () => {
    const irc = await startMockIrc();
    try {
      const adapter = new IrcAdapter(IRC_OPTS(irc.port));
      expect(await adapter.send('ops-alerts', 'disk full')).toBe(true);
      expect(irc.capture.joins).toEqual([]);
      expect(irc.capture.privmsg).toEqual([{ target: 'ops-alerts', text: 'disk full' }]);
    } finally {
      await irc.close();
    }
  });

  it('sends PASS + NickServ IDENTIFY when passwords are configured', async () => {
    const irc = await startMockIrc();
    try {
      const adapter = new IrcAdapter(IRC_OPTS(irc.port, { serverPassword: 'srvpw', nickservPassword: 'nspw' }));
      expect(await adapter.send('#ops', 'hi')).toBe(true);
      expect(irc.capture.lines[0]).toBe('PASS srvpw');
      expect(irc.capture.lines).toContain('PRIVMSG NickServ :IDENTIFY nspw');
    } finally {
      await irc.close();
    }
  });

  it('uses IRC_CHANNEL as the fallback target when no channelId is given', async () => {
    const irc = await startMockIrc();
    try {
      const adapter = new IrcAdapter(IRC_OPTS(irc.port, { channel: '#home' }));
      expect(await adapter.send('', 'to home')).toBe(true);
      expect(irc.capture.privmsg).toEqual([{ target: '#home', text: 'to home' }]);
    } finally {
      await irc.close();
    }
  });

  it('returns false when the server sends an error numeric (401 no such nick)', async () => {
    const irc = await startMockIrc(() => ':mock 401 agent-nuvira ghost :No such nick');
    try {
      const adapter = new IrcAdapter(IRC_OPTS(irc.port));
      expect(await adapter.send('ghost', 'hello')).toBe(false);
    } finally {
      await irc.close();
    }
  });

  it('returns false without connecting when unconfigured', async () => {
    const irc = await startMockIrc();
    try {
      const adapter = new IrcAdapter({ server: '', port: 6697, useTls: false, nickname: '' });
      expect(adapter.configured).toBe(false);
      expect(await adapter.send('#ops', 'x')).toBe(false);
      expect(irc.capture.connections).toBe(0);
    } finally {
      await irc.close();
    }
  });

  it('ircSend times out/fails gracefully when the server never registers us', async () => {
    const dead = createServer((s: Socket) => { s.on('error', () => { /* ignore resets */ }); });
    const port = await new Promise<number>((r) => dead.listen(0, '127.0.0.1', () => {
      const a = dead.address();
      r(typeof a === 'object' && a ? a.port : 0);
    }));
    try {
      const result = await ircSend(IRC_OPTS(port, { settleDelayMs: 30 }), '#ops', 'hi', 300);
      expect(result).toBe(false);
    } finally {
      dead.close();
    }
  });

  it('rejects CRLF injection in the target without connecting', async () => {
    const irc = await startMockIrc();
    try {
      const adapter = new IrcAdapter(IRC_OPTS(irc.port));
      expect(await adapter.send('#ops\r\nPRIVMSG #evil :x', 'hi')).toBe(false);
      expect(irc.capture.connections).toBe(0);
    } finally {
      await irc.close();
    }
  });
});

describe('IrcAdapter inbound relay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('start() opens a persistent listener: registers and joins IRC_CHANNEL once', async () => {
    const irc = await startMockIrc();
    try {
      const adapter = new IrcAdapter(IRC_OPTS(irc.port, { channel: '#ops', reconnectDelayMs: 20 }));
      await adapter.start(() => {});
      await until(() => irc.capture.joins.length === 1);
      expect(irc.capture.connections).toBe(1);
      expect(irc.capture.lines[0]).toBe('NICK agent-nuvira');
      expect(irc.capture.lines[1]).toBe('USER agent-nuvira 0 * :Agent-Nuvira gateway');
      expect(irc.capture.joins).toEqual(['#ops']);
      await adapter.stop();
    } finally {
      await irc.close();
    }
  });

  it('relays DMs to the bot (channelId = sender nick)', async () => {
    const irc = await startMockIrc();
    try {
      const received: Array<{ channelId: string; text: string; from?: string }> = [];
      const adapter = new IrcAdapter(IRC_OPTS(irc.port, { reconnectDelayMs: 20 }));
      await adapter.start((m) => received.push(m));
      await until(() => irc.capture.connections === 1);
      irc.push(':alice!user@host PRIVMSG agent-nuvira :deploy the site');
      await until(() => received.length === 1);
      expect(received[0]).toEqual({
        platform: 'irc',
        channelId: 'alice',
        text: 'deploy the site',
        from: 'alice',
        // senderId feeds the SHARED per-user policy gate (same as WhatsApp/etc).
        senderId: 'alice',
        isGroup: false,
      });
      await adapter.stop();
    } finally {
      await irc.close();
    }
  });

  it('relays channel messages only when the bot is addressed and strips the prefix', async () => {
    const irc = await startMockIrc();
    try {
      const received: unknown[] = [];
      const adapter = new IrcAdapter(IRC_OPTS(irc.port, { channel: '#ops', reconnectDelayMs: 20 }));
      await adapter.start((m) => received.push(m));
      await until(() => irc.capture.connections === 1);
      irc.push(':alice!u@h PRIVMSG #ops :agent-nuvira: run the tests');
      await until(() => received.length === 1);
      expect(received[0]).toMatchObject({ platform: 'irc', channelId: '#ops', text: 'run the tests', from: 'alice' });
      // Unaddressed channel chatter is ignored.
      irc.push(':bob!u@h PRIVMSG #ops :anyone seen the logs?');
      await new Promise((r) => setTimeout(r, 60));
      expect(received.length).toBe(1);
      await adapter.stop();
    } finally {
      await irc.close();
    }
  });

  it('filters our own echoes and non-text CTCP', async () => {
    const irc = await startMockIrc();
    try {
      const received: unknown[] = [];
      const adapter = new IrcAdapter(IRC_OPTS(irc.port, { reconnectDelayMs: 20 }));
      await adapter.start((m) => received.push(m));
      await until(() => irc.capture.connections === 1);
      irc.push(':agent-nuvira!u@h PRIVMSG #ops :hello myself');
      irc.push(':mallory!u@h PRIVMSG agent-nuvira :\x01VERSION\x01');
      await new Promise((r) => setTimeout(r, 60));
      expect(received.length).toBe(0);
      await adapter.stop();
    } finally {
      await irc.close();
    }
  });

  it('converts CTCP ACTION (/me) to * nick text', async () => {
    const irc = await startMockIrc();
    try {
      const received: unknown[] = [];
      const adapter = new IrcAdapter(IRC_OPTS(irc.port, { reconnectDelayMs: 20 }));
      await adapter.start((m) => received.push(m));
      await until(() => irc.capture.connections === 1);
      irc.push(':alice!u@h PRIVMSG agent-nuvira :\x01ACTION waves\x01');
      await until(() => received.length === 1);
      expect(received[0]).toMatchObject({ text: '* alice waves' });
      await adapter.stop();
    } finally {
      await irc.close();
    }
  });

  it('applies the IRC_ALLOWED_USERS allowlist case-insensitively', async () => {
    const irc = await startMockIrc();
    try {
      const received: unknown[] = [];
      const adapter = new IrcAdapter(IRC_OPTS(irc.port, { allowedUsers: ['Alice'], reconnectDelayMs: 20 }));
      await adapter.start((m) => received.push(m));
      await until(() => irc.capture.connections === 1);
      irc.push(':ALICE!u@h PRIVMSG agent-nuvira :allowed');
      await until(() => received.length === 1);
      irc.push(':mallory!u@h PRIVMSG agent-nuvira :blocked');
      await new Promise((r) => setTimeout(r, 60));
      expect(received.length).toBe(1);
      await adapter.stop();
    } finally {
      await irc.close();
    }
  });

  it('answers PING with PONG to stay alive', async () => {
    const irc = await startMockIrc();
    try {
      const adapter = new IrcAdapter(IRC_OPTS(irc.port, { reconnectDelayMs: 20 }));
      await adapter.start(() => {});
      await until(() => irc.capture.connections === 1);
      irc.push('PING :keepalive-token');
      await until(() => irc.capture.lines.includes('PONG :keepalive-token'));
      await adapter.stop();
    } finally {
      await irc.close();
    }
  });

  it('retries with an incremented nick on 433 ERR_NICKNAMEINUSE', async () => {
    const irc = await startMockIrc();
    try {
      const adapter = new IrcAdapter(IRC_OPTS(irc.port, { reconnectDelayMs: 20 }));
      await adapter.start(() => {});
      await until(() => irc.capture.connections === 1);
      irc.push(':mock 433 * agent-nuvira :Nickname is already in use');
      await until(() => irc.capture.lines.some((l) => l.startsWith('NICK agent-nuvira_')));
      expect(irc.capture.lines).toContain('NICK agent-nuvira_');
      await adapter.stop();
    } finally {
      await irc.close();
    }
  });

  it('E2E round-trip: server → listener → handler → send replies over the SAME connection', async () => {
    const irc = await startMockIrc();
    try {
      let adapter!: IrcAdapter;
      const received: unknown[] = [];
      adapter = new IrcAdapter(IRC_OPTS(irc.port, { channel: '#ops', reconnectDelayMs: 20 }));
      await adapter.start(async (m) => {
        received.push(m);
        // The gateway handler replies through the same adapter.
        await adapter.send(m.channelId, `ack: ${m.text}`);
      });
      await until(() => irc.capture.connections === 1);
      irc.push(':alice!u@h PRIVMSG #ops :agent-nuvira: status?');
      await until(() => irc.capture.privmsg.some((p) => p.text.startsWith('ack:')));
      expect(received.length).toBe(1);
      expect(irc.capture.privmsg).toContainEqual({ target: '#ops', text: 'ack: status?' });
      // One connection carried the whole round trip (listener + reply).
      expect(irc.capture.connections).toBe(1);
      await adapter.stop();
    } finally {
      await irc.close();
    }
  });

  it('reconnects after a server drop and keeps delivering', async () => {
    const irc = await startMockIrc();
    try {
      const received: unknown[] = [];
      const adapter = new IrcAdapter(IRC_OPTS(irc.port, { reconnectDelayMs: 20 }));
      await adapter.start((m) => received.push(m));
      await until(() => irc.capture.connections === 1);
      irc.drop();
      await until(() => irc.capture.connections >= 2);
      irc.push(':alice!u@h PRIVMSG agent-nuvira :back online?');
      await until(() => received.length === 1);
      expect(received[0]).toMatchObject({ text: 'back online?' });
      await adapter.stop();
    } finally {
      await irc.close();
    }
  });

  it('stop() sends QUIT, stops delivering, and does not reconnect', async () => {
    const irc = await startMockIrc();
    try {
      const received: unknown[] = [];
      const adapter = new IrcAdapter(IRC_OPTS(irc.port, { reconnectDelayMs: 20 }));
      await adapter.start((m) => received.push(m));
      await until(() => irc.capture.connections === 1);
      await adapter.stop();
      // end() flushes the QUIT — poll until the mock server has read it.
      await until(() => irc.capture.lines.some((l) => l.startsWith('QUIT')));
      irc.push(':alice!u@h PRIVMSG agent-nuvira :after stop');
      await new Promise((r) => setTimeout(r, 60));
      expect(received.length).toBe(0);
      const before = irc.capture.connections;
      await new Promise((r) => setTimeout(r, 60));
      expect(irc.capture.connections).toBe(before);
      await adapter.stop(); // idempotent
    } finally {
      await irc.close();
    }
  });
});

describe('splitIrcMessage + stripIrcMarkdown', () => {
  it('strips markdown to plain text', () => {
    expect(stripIrcMarkdown('**bold** and `code` and [link](https://x.dev)')).toBe('bold and code and link (https://x.dev)');
  });

  it('keeps short messages as a single line', () => {
    expect(splitIrcMessage('hello world', '#ops')).toEqual(['hello world']);
  });

  it('splits long messages into ≤510-byte wire lines, never splitting UTF-8', () => {
    const text = 'é'.repeat(200) + ' ' + '中'.repeat(100) + ' ' + 'word '.repeat(60);
    const lines = splitIrcMessage(text, '#ops');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      // Wire line = PRIVMSG #ops :<line> + CRLF — under the 510-byte IRC cap.
      const wire = Buffer.byteLength(`PRIVMSG #ops :${line}\r\n`);
      expect(wire).toBeLessThanOrEqual(510);
    }
    // Join restores the exact content (split is lossless modulo the
    // whitespace normalization the splitter performs at boundaries).
    expect(lines.join(' ').replace(/\s+/g, ' ').trim()).toBe(stripIrcMarkdown(text).replace(/\s+/g, ' ').trim());
  });

  it('handles a single unbreakable long token (binary-search boundary)', () => {
    const token = 'x'.repeat(1200);
    const lines = splitIrcMessage(token, '#ops');
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((l) => Buffer.byteLength(`PRIVMSG #ops :${l}\r\n`) <= 510)).toBe(true);
    expect(lines.join('')).toBe(token);
  });
});

// ─── Fake WebSocket (Node has no built-in WS *server* — mock the global) ───

interface FakeWs {
  url: string;
  sent: string[];
  /** Trigger onopen (as if the daemon accepted the upgrade). */
  open(): void;
  /** Emit an inbound message frame. */
  message(payload: string): void;
  /** Emit a socket error. */
  error(): void;
  /** Emit onclose. */
  close(): void;
}

/**
 * A Minimal fake WebSocket that records sent frames and lets a test drive
 * onopen/onmessage/onerror/onclose. Mirrors how the Signal tests mock fetch.
 */
function installFakeWebSocket(): FakeWs {
  const fake: FakeWs = { url: '', sent: [], open: () => {}, message: () => {}, error: () => {}, close: () => {} };
  const instances: FakeWebSocket[] = [];
  class FakeWebSocket {
    url: string;
    onopen: (() => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(url: string) {
      this.url = url;
      fake.url = url;
      instances.push(this);
    }
    send(data: string): void { fake.sent.push(data); }
    close(): void { (this as any).closed = true; }
  }
  // Drive handlers on the MOST RECENT constructed instance — the adapter
  // (re)connects by constructing a new WebSocket, so reconnects are new
  // instances.
  const latest = (): (typeof instances)[number] | null => instances[instances.length - 1] ?? null;
  fake.open = () => { latest()?.onopen?.(); };
  fake.message = (payload: string) => { latest()?.onmessage?.({ data: payload } as MessageEvent); };
  fake.error = () => { latest()?.onerror?.(); };
  fake.close = () => { latest()?.onclose?.(); };
  // TypeScript doesn't know the global is swappable at runtime — cast through any.
  (globalThis as any).WebSocket = FakeWebSocket;
  (fake as any).instances = instances;
  return fake;
}

describe('SimplexAdapter / simplexSend (local daemon WebSocket)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).WebSocket;
  });

  it('sends a DM via the @<id> text chat-command frame', async () => {
    const fake = installFakeWebSocket();
    const opts: SimplexOptions = { wsUrl: 'ws://127.0.0.1:5225', graceMs: 20 };
    const promise = simplexSend(opts, 'alice', 'hello simplex');
    fake.open();
    expect(await promise).toBe(true);

    expect(fake.url).toBe('ws://127.0.0.1:5225');
    const frame = JSON.parse(fake.sent[0]);
    expect(frame.cmd).toBe('@alice hello simplex');
    expect(frame.corrId).toMatch(/^anv-/);
  });

  it('sends a group message via the structured /_send #<id> json form', async () => {
    const fake = installFakeWebSocket();
    const promise = simplexSend({ wsUrl: 'ws://127.0.0.1:5225', graceMs: 20 }, 'group:42', 'to the group');
    fake.open();
    expect(await promise).toBe(true);

    const frame = JSON.parse(fake.sent[0]);
    expect(frame.cmd).toBe('/_send #42 json [{"msgContent":{"type":"text","text":"to the group"}}]');
  });

  it('returns false when the daemon replies with chatCmdError', async () => {
    const fake = installFakeWebSocket();
    const promise = simplexSend({ wsUrl: 'ws://127.0.0.1:5225', graceMs: 20 }, 'ghost', 'hi');
    fake.open();
    fake.message(JSON.stringify({ corrId: 'anv-1', resp: { type: 'chatCmdError', details: 'no such contact' } }));
    expect(await promise).toBe(false);
  });

  it('returns false without connecting when unconfigured', async () => {
    const fake = installFakeWebSocket();
    const adapter = new SimplexAdapter({ wsUrl: '' });
    expect(adapter.configured).toBe(false);
    expect(await adapter.send('alice', 'x')).toBe(false);
    expect(fake.sent.length).toBe(0);
  });

  it('returns false when the WebSocket errors before sending', async () => {
    const fake = installFakeWebSocket();
    const promise = simplexSend({ wsUrl: 'ws://127.0.0.1:5225', graceMs: 20 }, 'alice', 'hi');
    fake.error();
    expect(await promise).toBe(false);
  });

  it('rejects CRLF injection in the channel id without sending', async () => {
    const fake = installFakeWebSocket();
    const promise = simplexSend({ wsUrl: 'ws://127.0.0.1:5225', graceMs: 20 }, 'alice\r\n/_send #5 json []', 'hi');
    expect(await promise).toBe(false);
    expect(fake.sent.length).toBe(0);
  });

  it('strips CR/LF from DM text so it cannot inject a second command', async () => {
    const fake = installFakeWebSocket();
    const promise = simplexSend({ wsUrl: 'ws://127.0.0.1:5225', graceMs: 20 }, 'alice', 'line1\n/_send #5 json []');
    fake.open();
    expect(await promise).toBe(true);
    const frame = JSON.parse(fake.sent[0]);
    expect(frame.cmd).toBe('@alice line1 /_send #5 json []');
  });

  it('returns false on connection timeout (daemon never opens)', async () => {
    const fake = installFakeWebSocket();
    const promise = simplexSend({ wsUrl: 'ws://127.0.0.1:5225', graceMs: 20 }, 'alice', 'hi', 30);
    // Never call open() — the timeout timer should fire.
    expect(await promise).toBe(false);
    expect(fake.sent.length).toBe(0);
  });
});

describe('SimplexAdapter inbound (persistent WS listener)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).WebSocket;
  });

  /** Build a newChatItems event for a direct message. */
  const directEvent = (contactId: string, text: string, displayName = 'Alice'): string =>
    JSON.stringify({
      corrId: 'daemon-1',
      resp: {
        type: 'newChatItems',
        chatItems: [
          {
            chatInfo: { type: 'direct', contact: { contactId, localDisplayName: displayName } },
            chatItem: {
              chatDir: { type: 'directRcv' },
              content: { type: 'rcvMsgContent', msgContent: { type: 'text', text } },
            },
          },
        ],
      },
    });

  it('relays an inbound direct message to the handler', async () => {
    const fake = installFakeWebSocket();
    const received: string[] = [];
    const adapter = new SimplexAdapter({ wsUrl: 'ws://127.0.0.1:5225', autoAccept: false });
    await adapter.start((msg) => { received.push(`${msg.channelId}|${msg.text}|${msg.from}`); });
    fake.message(directEvent('42', 'hello from simplex'));
    expect(received).toEqual(['42|hello from simplex|Alice']);
    await adapter.stop();
  });

  it('ignores our own outgoing echoes (directSnd) and non-text content', async () => {
    const fake = installFakeWebSocket();
    const received: string[] = [];
    const adapter = new SimplexAdapter({ wsUrl: 'ws://127.0.0.1:5225', autoAccept: false });
    await adapter.start((msg) => { received.push(msg.text); });
    // Own echo (directSnd), an anv- corrId echo, and a non-rcv content type.
    fake.message(JSON.stringify({
      corrId: 'anv-5-1',
      resp: { type: 'newChatItems', chatItems: [{ chatInfo: { type: 'direct', contact: { contactId: '9' } }, chatItem: { chatDir: { type: 'directSnd' }, content: { type: 'rcvMsgContent', msgContent: { type: 'text', text: 'mine' } } } }] },
    }));
    fake.message(JSON.stringify({
      corrId: 'anv-6-2',
      resp: { type: 'newChatItems', chatItems: [{ chatInfo: { type: 'direct', contact: { contactId: '9' } }, chatItem: { chatDir: { type: 'directRcv' }, content: { type: 'rcvMsgContent', msgContent: { type: 'text', text: 'x' } } } }] },
    }));
    fake.message(JSON.stringify({
      resp: { type: 'newChatItems', chatItems: [{ chatInfo: { type: 'direct', contact: { contactId: '9' } }, chatItem: { chatDir: { type: 'directRcv' }, content: { type: 'sndFile' } } }] },
    }));
    expect(received).toEqual([]);
    await adapter.stop();
  });

  it('auto-accepts contact requests via /accept when enabled', async () => {
    const fake = installFakeWebSocket();
    const adapter = new SimplexAdapter({ wsUrl: 'ws://127.0.0.1:5225', autoAccept: true });
    await adapter.start(() => {});
    fake.message(JSON.stringify({ resp: { type: 'contactRequest', contactRequest: { contactRequestId: 77 } } }));
    expect(fake.sent).toHaveLength(1);
    expect(JSON.parse(fake.sent[0]).cmd).toBe('/accept 77');
    await adapter.stop();
  });

  it('does NOT auto-accept when autoAccept is false', async () => {
    const fake = installFakeWebSocket();
    const adapter = new SimplexAdapter({ wsUrl: 'ws://127.0.0.1:5225', autoAccept: false });
    await adapter.start(() => {});
    fake.message(JSON.stringify({ resp: { type: 'contactRequest', contactRequest: { contactRequestId: 77 } } }));
    expect(fake.sent).toHaveLength(0);
    await adapter.stop();
  });

  it('respects the allowed-users allowlist', async () => {
    const fake = installFakeWebSocket();
    const received: string[] = [];
    const adapter = new SimplexAdapter({ wsUrl: 'ws://127.0.0.1:5225', autoAccept: false, allowedUsers: ['1'] });
    await adapter.start((msg) => { received.push(msg.channelId); });
    fake.message(directEvent('2', 'blocked'));
    fake.message(directEvent('1', 'allowed'));
    expect(received).toEqual(['1']);
    await adapter.stop();
  });

  it('ignores group messages unless the group is allow-listed', async () => {
    const fake = installFakeWebSocket();
    const received: string[] = [];
    const adapter = new SimplexAdapter({ wsUrl: 'ws://127.0.0.1:5225', autoAccept: false, groupAllowed: ['g1'] });
    await adapter.start((msg) => { received.push(msg.channelId); });
    const groupEvent = (gid: string): string => JSON.stringify({
      corrId: 'daemon-2',
      resp: {
        type: 'newChatItems',
        chatItems: [{
          chatInfo: { type: 'group', groupInfo: { groupId: gid } },
          chatItem: { chatDir: { type: 'groupRcv', groupMember: { localDisplayName: 'Bob' } }, content: { type: 'rcvMsgContent', msgContent: { type: 'text', text: 'hi group' } } },
        }],
      },
    });
    fake.message(groupEvent('g9'));
    fake.message(groupEvent('g1'));
    expect(received).toEqual(['group:g1']);
    await adapter.stop();
  });

  it('allows any group when SIMPLEX_GROUP_ALLOWED=*', async () => {
    const fake = installFakeWebSocket();
    const received: string[] = [];
    const adapter = new SimplexAdapter({ wsUrl: 'ws://127.0.0.1:5225', autoAccept: false, groupAllowed: ['*'] });
    await adapter.start((msg) => { received.push(msg.channelId); });
    fake.message(JSON.stringify({
      resp: { type: 'newChatItems', chatItems: [{ chatInfo: { type: 'group', groupInfo: { groupId: 'zz' } }, chatItem: { chatDir: { type: 'groupRcv' }, content: { type: 'rcvMsgContent', msgContent: { type: 'text', text: 'hi' } } } }] },
    }));
    expect(received).toEqual(['group:zz']);
    await adapter.stop();
  });

  it('reconnects after the daemon drops the connection — and the new listener delivers', async () => {
    const fake = installFakeWebSocket();
    const received: string[] = [];
    const adapter = new SimplexAdapter({ wsUrl: 'ws://127.0.0.1:5225', autoAccept: false, reconnectDelayMs: 5 });
    await adapter.start((msg) => { received.push(msg.text); });
    const instancesBefore = (fake as any).instances.length;
    fake.close(); // daemon drop → onclose → scheduleReconnect
    await new Promise((r) => setTimeout(r, 25));
    expect((fake as any).instances.length).toBeGreaterThan(instancesBefore);
    // The reconnected listener must actually deliver messages.
    fake.message(directEvent('42', 'after reconnect'));
    expect(received).toEqual(['after reconnect']);
    await adapter.stop();
  });

  it('does not deliver after stop (handler cleared, no reconnect)', async () => {
    const fake = installFakeWebSocket();
    const received: string[] = [];
    const adapter = new SimplexAdapter({ wsUrl: 'ws://127.0.0.1:5225', autoAccept: false, reconnectDelayMs: 5 });
    await adapter.start((msg) => { received.push(msg.text); });
    await adapter.stop();
    fake.message(directEvent('42', 'after stop'));
    await new Promise((r) => setTimeout(r, 25));
    expect(received).toEqual([]);
    expect((fake as any).instances.length).toBe(1); // no reconnect after stop
  });
});

describe('SignalAdapter (signal-cli-rest-api)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to /v2/send with message/number/recipients', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const adapter = new SignalAdapter('http://127.0.0.1:8080', '+15551234567');
    expect(adapter.configured).toBe(true);
    expect(await adapter.send('+15559876543', 'hello signal')).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:8080/v2/send');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      message: 'hello signal',
      number: '+15551234567',
      recipients: ['+15559876543'],
    });
  });

  it('returns false when unconfigured without calling the network', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const adapter = new SignalAdapter('http://127.0.0.1:8080', '');
    expect(adapter.configured).toBe(false);
    expect(await adapter.send('+15559876543', 'x')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const adapter = new SignalAdapter('http://127.0.0.1:8080', '+15551234567');
    expect(await adapter.send('+15559876543', 'x')).toBe(false);
  });

  it('uses the default local base URL when not specified', () => {
    expect(new SignalAdapter(undefined, '+1').describe()).toContain('127.0.0.1:8080');
  });
});

describe('createConfiguredAdapters (I6 platforms)', () => {
  const envBackup: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of Object.keys(envBackup)) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    Object.keys(envBackup).forEach((k) => delete envBackup[k]);
    vi.restoreAllMocks();
  });

  it('includes email + signal only when their env vars are present', () => {
    envBackup.BUFF_SMTP_HOST = process.env.BUFF_SMTP_HOST;
    envBackup.BUFF_SMTP_USER = process.env.BUFF_SMTP_USER;
    envBackup.BUFF_SIGNAL_ACCOUNT = process.env.BUFF_SIGNAL_ACCOUNT;
    delete process.env.BUFF_SMTP_HOST;
    delete process.env.BUFF_SMTP_USER;
    delete process.env.BUFF_SIGNAL_ACCOUNT;

    let platforms = createConfiguredAdapters().map((a) => a.platform);
    expect(platforms).not.toContain('email');
    expect(platforms).not.toContain('signal');

    process.env.BUFF_SMTP_HOST = 'smtp.example.com';
    process.env.BUFF_SMTP_USER = 'bot';
    process.env.BUFF_SIGNAL_ACCOUNT = '+15551234567';
    platforms = createConfiguredAdapters().map((a) => a.platform);
    expect(platforms).toContain('email');
    expect(platforms).toContain('signal');
  });

  it('includes irc only when IRC_SERVER is present', () => {
    envBackup.IRC_SERVER = process.env.IRC_SERVER;
    delete process.env.IRC_SERVER;
    expect(createConfiguredAdapters().map((a) => a.platform)).not.toContain('irc');

    process.env.IRC_SERVER = 'irc.libera.chat';
    expect(createConfiguredAdapters().map((a) => a.platform)).toContain('irc');
  });

  it('includes simplex only when SIMPLEX_WS_URL is present', () => {
    envBackup.SIMPLEX_WS_URL = process.env.SIMPLEX_WS_URL;
    delete process.env.SIMPLEX_WS_URL;
    expect(createConfiguredAdapters().map((a) => a.platform)).not.toContain('simplex');

    process.env.SIMPLEX_WS_URL = 'ws://127.0.0.1:5225';
    expect(createConfiguredAdapters().map((a) => a.platform)).toContain('simplex');
  });
});
