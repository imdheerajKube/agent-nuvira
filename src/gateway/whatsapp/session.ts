/**
 * I8 — WhatsApp bridge session location (Hermes parity).
 *
 * Hermes persists the Baileys/whatsapp-web.js session under
 * `~/.hermes/whatsapp/session/creds.json`; agent-nuvira uses the equivalent
 * `~/.buff/whatsapp/session/` (BUFF_WHATSAPP_SESSION_DIR overrides it so a
 * smoke/test can point anywhere without touching the user home). The files
 * are written by Baileys' `useMultiFileAuthState` — byte-compatible layout.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** The multi-file auth-state directory for the WhatsApp bridge. */
export function whatsappSessionDir(): string {
  return process.env.BUFF_WHATSAPP_SESSION_DIR || join(homedir(), '.buff', 'whatsapp', 'session');
}

/** True when a paired Baileys session (creds.json) exists on disk. */
export function hasWhatsAppSession(dir: string = whatsappSessionDir()): boolean {
  try {
    return existsSync(join(dir, 'creds.json'));
  } catch {
    return false;
  }
}
