/**
 * I8 — WhatsApp bridge session location.
 *
 * The session is persisted under
 * a `creds.json` Baileys session persisted under the agent-nuvira data dir; the
 * `~/.nuvira/whatsapp/session/` (NUVIRA_WHATSAPP_SESSION_DIR overrides it so a
 * smoke/test can point anywhere without touching the user home). The files
 * are written by Baileys' `useMultiFileAuthState` — byte-compatible layout.
 */
import { existsSync } from 'node:fs';
import { envBuff, resolveNuviraHome } from '../../config/paths.js';
import { join } from 'node:path';
/** The multi-file auth-state directory for the WhatsApp bridge. */
export function whatsappSessionDir() {
    return envBuff('WHATSAPP_SESSION_DIR') || join(resolveNuviraHome(), 'whatsapp', 'session');
}
/** True when a paired Baileys session (creds.json) exists on disk. */
export function hasWhatsAppSession(dir = whatsappSessionDir()) {
    try {
        return existsSync(join(dir, 'creds.json'));
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=session.js.map