/**
 * I8 — WhatsApp bridge session location.
 *
 * The session is persisted under
 * a `creds.json` Baileys session persisted under the agent-nuvira data dir; the
 * `~/.nuvira/whatsapp/session/` (NUVIRA_WHATSAPP_SESSION_DIR overrides it so a
 * smoke/test can point anywhere without touching the user home). The files
 * are written by Baileys' `useMultiFileAuthState` — byte-compatible layout.
 */
/** The multi-file auth-state directory for the WhatsApp bridge. */
export declare function whatsappSessionDir(): string;
/** True when a paired Baileys session (creds.json) exists on disk. */
export declare function hasWhatsAppSession(dir?: string): boolean;
//# sourceMappingURL=session.d.ts.map