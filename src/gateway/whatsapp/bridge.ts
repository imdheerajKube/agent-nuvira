/**
 * I8 — WhatsApp bridge contract (agent-nuvira messaging platform).
 *
 * `whatsapp` is a first-class messaging platform
 * (a Python CLI platform layer) implemented with its OWN bridge layer — a Node
 * subprocess running whatsapp-web.js or Baileys, QR-paired, with session creds
 * persisted as a local `creds.json` session — NOT the paid Meta
 * Business API (that is the separate, opt-in `whatsapp_cloud` platform).
 *
 * agent-nuvira is Node, so it embeds the Baileys bridge natively (no
 * Python→Node subprocess indirection): QR-pair once, persist the session in
 * the SAME multi-file creds.json format, then send/receive by WhatsApp JID.
 */

import type { InboundMedia } from '../inbound-media.js';

/**
 * Outcome of a VERIFIED send — how far the delivery was actually confirmed.
 *
 * Baileys' `sendMessage` resolving only proves the request was handed to the
 * socket. Live incident (2026-09-21): a WhatsApp send was reported as
 * delivered while the recipient received nothing, because success was assumed
 * from the resolve alone. Every send now reports WHAT was verified:
 *  - `delivered` — WhatsApp confirmed the recipient's device received it;
 *  - `accepted`  — WhatsApp confirmed the recipient EXISTS and accepted the
 *                  message for delivery (device ack still pending/offline);
 *  - `unverified`— sent, but no confirmation arrived in the wait window.
 */
export type WhatsAppSendVerification = 'delivered' | 'accepted' | 'unverified';

/** Result of a verified WhatsApp send. */
export interface WhatsAppSendResult {
  ok: boolean;
  /** How far the delivery was confirmed (absent when `ok` is false). */
  verification?: WhatsAppSendVerification;
  /**
   * Human-readable reason when `ok` is false (or the caveat when a send went
   * out unverified). Safe to show to a user — it never contains secrets.
   */
  reason?: string;
  /** The native JID the message was addressed to (diagnostics/logging). */
  jid?: string;
}

/** A WhatsApp bridge — injectable so the adapter is testable without baileys. */
export interface WhatsAppBridge {
  /** True when a paired session exists on disk (drives adapter.configured). */
  readonly paired: boolean;
  /** Human status line (session path / pairing state / missing dep). */
  describe(): string;
  /**
   * Connect + start listening. Calls onMessage for every inbound text.
   * `participant` is the real sender inside a group (`key.participant`),
   * undefined for DMs (the sender IS the fromJid). `messageId` is WhatsApp's
   * `key.id` — the gateway dedups on it so the bridge's offline-backfill
   * replay is handled once instead of once per reconnect. `media` carries a
   * downloaded document/image attachment when the message has one (with the
   * caption folded into `text`), so a document message is never dropped for
   * having empty text.
   */
  connect(
    onMessage: (fromJid: string, text: string, participant?: string, messageId?: string, media?: InboundMedia) => void,
  ): Promise<void>;
  /** Stop listening + disconnect (idempotent). */
  disconnect(): Promise<void>;
  /** Send a text message to a WhatsApp target (JID or E.164 / plain number). */
  send(target: string, text: string): Promise<boolean>;
  /**
   * VERIFIED send — same as {@link send} but also reports WHY a send failed and
   * HOW FAR it was verified (registered recipient? device ack?). Optional so
   * test fakes keep satisfying `send`; adapters prefer it when present.
   */
  sendVerified?(target: string, text: string): Promise<WhatsAppSendResult>;
  /**
   * Send media (image/video/audio/document) to a WhatsApp target. Optional —
   * only the Baileys bridge implements it; fakes return undefined.
   */
  sendMedia?(target: string, media: { type: 'image' | 'video' | 'audio' | 'document'; data: Uint8Array; caption?: string; filename?: string }): Promise<boolean>;
}

/**
 * Normalize a user-supplied WhatsApp target to a native JID:
 * - "+15551234567" / "15551234567"          → "15551234567@s.whatsapp.net"
 * - "…@s.whatsapp.net" (user) / "…@g.us" (group) / "…@lid" / "…@broadcast" → verbatim
 * - anything else                            → "<target>@s.whatsapp.net" (best-effort)
 */
export function normalizeWhatsAppJid(target: string): string {
  const t = (target || '').trim();
  if (!t) return '';
  if (t.includes('@')) return t;
  // Strip internal whitespace so "+1 555 123 4567" pairs like a number, and
  // never emits a jid containing spaces.
  const compact = t.replace(/\s+/g, '');
  const digits = compact.replace(/^\+/, '');
  if (/^\d{7,15}$/.test(digits)) return `${digits}@s.whatsapp.net`;
  return `${compact}@s.whatsapp.net`;
}
