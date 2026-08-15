/**
 * I8 — WhatsApp bridge contract (agent-nuvira messaging platform).
 *
 * Hermes parity: in Hermes, `whatsapp` is a first-class messaging platform
 * (`hermes_cli/platforms.py`) implemented with its OWN bridge layer — a Node
 * subprocess running whatsapp-web.js or Baileys, QR-paired, with session creds
 * persisted at `~/.hermes/whatsapp/session/creds.json` — NOT the paid Meta
 * Business API (that is the separate, opt-in `whatsapp_cloud` platform).
 *
 * agent-nuvira is Node, so it embeds the Baileys bridge natively (no
 * Python→Node subprocess indirection): QR-pair once, persist the session in
 * the SAME multi-file creds.json format, then send/receive by WhatsApp JID.
 */

/** A WhatsApp bridge — injectable so the adapter is testable without baileys. */
export interface WhatsAppBridge {
  /** True when a paired session exists on disk (drives adapter.configured). */
  readonly paired: boolean;
  /** Human status line (session path / pairing state / missing dep). */
  describe(): string;
  /**
   * Connect + start listening. Calls onMessage for every inbound text.
   * `participant` is the real sender inside a group (`key.participant`),
   * undefined for DMs (the sender IS the fromJid).
   */
  connect(onMessage: (fromJid: string, text: string, participant?: string) => void): Promise<void>;
  /** Stop listening + disconnect (idempotent). */
  disconnect(): Promise<void>;
  /** Send a text message to a WhatsApp target (JID or E.164 / plain number). */
  send(target: string, text: string): Promise<boolean>;
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
