/**
 * I8b — WhatsApp contact-name mapping (`src/gateway/whatsapp/contacts.ts`).
 *
 * WhatsApp does NOT sync the phone's address book to linked devices (verified
 * on Baileys 7: the socket opens but no contactAction sync arrives), and an
 * inbound `pushName` is the SENDER's own profile name — not how the user
 * saved the contact. So to send to "Daddy" by name, the user maps the name to
 * a number once:
 *
 *   buff whatsapp contact add Daddy 919876543210
 *
 * Stored at `~/.buff/whatsapp/contacts.json` (next to the session; the
 * BUFF_WHATSAPP_SESSION_DIR override applies). The bridge seeds its
 * name → JID map from this file and merges anything it learns at runtime
 * (contacts sync / pushName) on top.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A name → number mapping (numbers in E.164 digits, no '+'). */
export type ContactMap = Record<string, string>;

/** The contacts file path next to a WhatsApp session dir. */
export function whatsappContactsFile(sessionDir: string): string {
  return join(sessionDir, 'contacts.json');
}

/** Read the mapping (missing/corrupt file → {} — never throws). */
export function readContactsFile(sessionDir: string): ContactMap {
  try {
    const file = whatsappContactsFile(sessionDir);
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ContactMap;
    const out: ContactMap = {};
    for (const [name, number] of Object.entries(parsed ?? {})) {
      const n = (name || '').trim();
      const digits = String(number ?? '').replace(/\D+/g, '');
      if (n && digits) out[n] = digits;
    }
    return out;
  } catch {
    return {};
  }
}

/** Write the mapping (mkdir + atomic-ish write; never throws). */
export function writeContactsFile(sessionDir: string, contacts: ContactMap): void {
  try {
    const file = whatsappContactsFile(sessionDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(contacts, null, 2), 'utf-8');
  } catch {
    /* best-effort — a failed write must never break a send */
  }
}
