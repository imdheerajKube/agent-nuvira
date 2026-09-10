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
/**
 * Normalize a user-supplied WhatsApp target to a native JID:
 * - "+15551234567" / "15551234567"          → "15551234567@s.whatsapp.net"
 * - "…@s.whatsapp.net" (user) / "…@g.us" (group) / "…@lid" / "…@broadcast" → verbatim
 * - anything else                            → "<target>@s.whatsapp.net" (best-effort)
 */
export function normalizeWhatsAppJid(target) {
    const t = (target || '').trim();
    if (!t)
        return '';
    if (t.includes('@'))
        return t;
    // Strip internal whitespace so "+1 555 123 4567" pairs like a number, and
    // never emits a jid containing spaces.
    const compact = t.replace(/\s+/g, '');
    const digits = compact.replace(/^\+/, '');
    if (/^\d{7,15}$/.test(digits))
        return `${digits}@s.whatsapp.net`;
    return `${compact}@s.whatsapp.net`;
}
//# sourceMappingURL=bridge.js.map