/**
 * Send authority — the OUTBOUND gate.
 *
 * `allowedUsers` decides who may TRIGGER the agent; `outboundSenders` decides
 * who may then direct it to deliver to SOMEONE ELSE. These tests pin both the
 * pure decision function and the real `gateway_send` tool path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { authorizeOutboundSend, passesSenderList } from '../../src/gateway/registry.js';
import { getTool } from '../../src/tools/registry.js';
import type { ToolContext } from '../../src/tools/registry.js';

// ─── Pure decision function ─────────────────────────────────────────────────

describe('authorizeOutboundSend (pure)', () => {
  it('allows when there is no sender (local/unattributed turn)', () => {
    const d = authorizeOutboundSend({ policy: { outboundSenders: [] }, senderId: undefined, ownConversation: false });
    expect(d.allowed).toBe(true);
    expect(d.source).toBe('no-sender');
  });

  it('always allows a sender reaching their OWN conversation', () => {
    const d = authorizeOutboundSend({
      policy: { outboundSenders: ['someone-else'] },
      senderId: '+919876543210',
      ownConversation: true,
    });
    expect(d.allowed).toBe(true);
    expect(d.source).toBe('same-conversation');
  });

  it('restricts to the explicit outboundSenders list (JID/digit normalized)', () => {
    const policy = { outboundSenders: ['+919876543210'] };
    expect(authorizeOutboundSend({ policy, senderId: '919876543210@s.whatsapp.net', ownConversation: false }).allowed).toBe(true);
    expect(authorizeOutboundSend({ policy, senderId: '+919999999999', ownConversation: false }).allowed).toBe(false);
  });

  it('an EMPTY outboundSenders list denies everyone', () => {
    const d = authorizeOutboundSend({ policy: { outboundSenders: [] }, senderId: '+919876543210', ownConversation: false });
    expect(d.allowed).toBe(false);
    expect(d.source).toBe('outboundSenders');
    expect(d.reason).toMatch(/not authorised/i);
  });

  it('the Allow-All wildcard opens sending to anyone', () => {
    const d = authorizeOutboundSend({ policy: { outboundSenders: ['Allow-All'] }, senderId: '+919999999999', ownConversation: false });
    expect(d.allowed).toBe(true);
  });

  it('ABSENT outboundSenders inherits allowedUsers (legacy, non-breaking)', () => {
    const policy = { allowedUsers: ['+919876543210'] };
    const allowed = authorizeOutboundSend({ policy, senderId: '919876543210', ownConversation: false });
    expect(allowed.allowed).toBe(true);
    expect(allowed.source).toBe('inherited-allowedUsers');
    const denied = authorizeOutboundSend({ policy, senderId: '+919111111111', ownConversation: false });
    expect(denied.allowed).toBe(false);
  });

  it('ABSENT everything is fully open (legacy default)', () => {
    const d = authorizeOutboundSend({ policy: undefined, senderId: '+919876543210', ownConversation: false });
    expect(d.allowed).toBe(true);
    expect(d.source).toBe('open');
  });
});

describe('passesSenderList', () => {
  it('absent list passes anyone', () => {
    expect(passesSenderList(undefined, 'x')).toBe(true);
  });
  it('empty list passes no one', () => {
    expect(passesSenderList([], 'x')).toBe(false);
  });
  it('Allow-All passes anyone', () => {
    expect(passesSenderList(['*'], 'x')).toBe(true);
  });
  it('matches after normalization', () => {
    expect(passesSenderList(['+15551234567'], '15551234567@s.whatsapp.net')).toBe(true);
  });
});

// ─── Real tool path (end-to-end) ────────────────────────────────────────────

const cfgDir = mkdtempSync(join(tmpdir(), 'buff-gw-sendauth-'));
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;

function writeConfig(policies: Record<string, unknown>): void {
  writeFileSync(
    join(cfgDir, 'buffconfig.json'),
    JSON.stringify({ defaultProvider: 'auto', gateway: { policies } }),
  );
}

/** A fake live gateway that records sends and resolves targets. */
function liveGateway(opts: { resolve?: (t: string) => { platform: string; channelId: string } | null; origin?: { platform: string; channelId: string } }) {
  const sent: Array<{ target: string; text: string }> = [];
  return {
    sent,
    gateway: {
      send: async (target: string, text: string) => {
        sent.push({ target, text });
        return true;
      },
      directory: { resolve: opts.resolve ?? (() => ({ platform: 'whatsapp', channelId: 'other-person' })) },
      origin: opts.origin,
    } as ToolContext['gateway'],
  };
}

describe('gateway_send outbound authorization (end-to-end)', () => {
  beforeAll(() => {
    process.env.NUVIRA_CONFIG_DIR = cfgDir;
  });
  afterAll(() => {
    if (ORIG_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = ORIG_CONFIG_DIR;
    rmSync(cfgDir, { recursive: true, force: true });
  });

  const tool = () => getTool('gateway_send')!;

  it('a LOCAL turn (no origin) is always allowed', async () => {
    writeConfig({ whatsapp: { outboundSenders: [] } }); // nobody may send
    const { sent, gateway } = liveGateway({});
    const out = await tool().run({ target: 'whatsapp:+15550001111', text: 'hi' }, { configManager: {}, gateway } as ToolContext);
    expect(out).toContain('✅ sent');
    expect(sent).toHaveLength(1);
  });

  it('an AUTHORIZED remote sender goes through', async () => {
    writeConfig({ whatsapp: { outboundSenders: ['+918800604222'] } });
    const { sent, gateway } = liveGateway({ origin: { platform: 'whatsapp', channelId: '918800604222@s.whatsapp.net' } });
    const out = await tool().run({ target: 'whatsapp:+918800425333', text: 'poem' }, { configManager: {}, gateway } as ToolContext);
    expect(out).toContain('✅ sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].target).toBe('whatsapp:+918800425333');
  });

  it('an UNAUTHORIZED remote sender is refused and NOTHING is sent', async () => {
    writeConfig({ whatsapp: { outboundSenders: ['+918800604222'] } });
    const { sent, gateway } = liveGateway({ origin: { platform: 'whatsapp', channelId: '918899999999@s.whatsapp.net' } });
    const out = await tool().run({ target: 'whatsapp:+918800425333', text: 'poem' }, { configManager: {}, gateway } as ToolContext);
    expect(out).toContain('🚫');
    expect(out).toMatch(/not authorised|send authority/i);
    expect(sent).toHaveLength(0);
  });

  it('sending to the sender’s OWN conversation is allowed even when restricted', async () => {
    writeConfig({ whatsapp: { outboundSenders: [] } });
    const { sent, gateway } = liveGateway({
      resolve: () => ({ platform: 'whatsapp', channelId: '918800604222@s.whatsapp.net' }),
      origin: { platform: 'whatsapp', channelId: '918800604222@s.whatsapp.net' },
    });
    const out = await tool().run({ target: 'whatsapp:+918800604222', text: 'self' }, { configManager: {}, gateway } as ToolContext);
    expect(out).toContain('✅ sent');
    expect(sent).toHaveLength(1);
  });

  it('an EMPTY outboundSenders list refuses a remote third-party send', async () => {
    writeConfig({ whatsapp: { outboundSenders: [] } });
    const { sent, gateway } = liveGateway({ origin: { platform: 'whatsapp', channelId: '918800604222@s.whatsapp.net' } });
    const out = await tool().run({ target: 'whatsapp:+918800425333', text: 'poem' }, { configManager: {}, gateway } as ToolContext);
    expect(out).toContain('🚫');
    expect(sent).toHaveLength(0);
  });

  it('ABSENT outboundSenders inherits allowedUsers', async () => {
    writeConfig({ whatsapp: { allowedUsers: ['+918800604222'] } });
    const { sent, gateway } = liveGateway({ origin: { platform: 'whatsapp', channelId: '918800604222@s.whatsapp.net' } });
    const out = await tool().run({ target: 'whatsapp:+918800425333', text: 'poem' }, { configManager: {}, gateway } as ToolContext);
    expect(out).toContain('✅ sent');
    expect(sent).toHaveLength(1);
  });

  it('requireApprovedTarget blocks a non-approved recipient', async () => {
    writeConfig({ whatsapp: { outboundSenders: ['Allow-All'], requireApprovedTarget: true } });
    // No contacts file written → no approved contacts.
    const { sent, gateway } = liveGateway({ origin: { platform: 'whatsapp', channelId: '918800604222@s.whatsapp.net' } });
    const out = await tool().run({ target: 'whatsapp:+918800425333', text: 'poem' }, { configManager: {}, gateway } as ToolContext);
    expect(out).toContain('🚫');
    expect(out).toMatch(/not an approved contact/i);
    expect(sent).toHaveLength(0);
  });

  it('requireApprovedTarget allows an APPROVED recipient', async () => {
    writeConfig({ whatsapp: { outboundSenders: ['Allow-All'], requireApprovedTarget: true } });
    mkdirSync(join(cfgDir, 'gateway'), { recursive: true });
    writeFileSync(
      join(cfgDir, 'gateway', 'contacts.json'),
      JSON.stringify({
        version: 1,
        contacts: [{ name: 'Anuj', platform: 'whatsapp', id: '+918800425333', status: 'approved', registeredAt: 1, addedAt: 1 }],
      }),
    );
    const { sent, gateway } = liveGateway({ origin: { platform: 'whatsapp', channelId: '918800604222@s.whatsapp.net' } });
    const out = await tool().run({ target: 'whatsapp:+918800425333', text: 'poem' }, { configManager: {}, gateway } as ToolContext);
    expect(out).toContain('✅ sent');
    expect(sent).toHaveLength(1);
  });
});
