/**
 * I8b — WhatsApp contact-name mapping (`src/gateway/whatsapp/contacts.ts`).
 *
 * WhatsApp does NOT sync the phone's address book to linked devices (verified
 * on Baileys 7: the socket opens but no contactAction sync arrives), and an
 * inbound `pushName` is the SENDER's own profile name — not how the user
 * saved the contact. So to send to "Alex" by name, the user maps the name to
 * a number once:
 *
 *   nuvira whatsapp contact add Alex 919876543210
 *
 * Stored at `~/.nuvira/whatsapp/contacts.json` (next to the session; the
 * NUVIRA_WHATSAPP_SESSION_DIR override applies). The bridge seeds its
 * name → JID map from this file and merges anything it learns at runtime
 * (contacts sync / pushName) on top.
 */
/** A name → number mapping (numbers in E.164 digits, no '+'). */
export type ContactMap = Record<string, string>;
/** The contacts file path next to a WhatsApp session dir. */
export declare function whatsappContactsFile(sessionDir: string): string;
/** Read the mapping (missing/corrupt file → {} — never throws). */
export declare function readContactsFile(sessionDir: string): ContactMap;
/** Write the mapping (mkdir + atomic-ish write; never throws). */
export declare function writeContactsFile(sessionDir: string, contacts: ContactMap): void;
//# sourceMappingURL=contacts.d.ts.map