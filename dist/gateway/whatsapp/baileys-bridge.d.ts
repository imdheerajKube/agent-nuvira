/**
 * I8 — Baileys bridge (agent-nuvira's WhatsApp messaging layer).
 *
 * The native WhatsApp bridge:
 * QR-pairs a personal number over the WhatsApp Web multi-device protocol and
 * sends/receives by JID — no Meta Business account, no paid API.
 *
 * `baileys` is imported LAZILY so the rest of the gateway (and tests using a
 * fake bridge) never pay for it, and an unpaired bridge fails fast without
 * loading it. Session files (creds.json + peers/…) are written by Baileys'
 * `useMultiFileAuthState` — a multi-file auth-state layout.
 *
 * Since I8b:
 * - **Echo filtering (`recentlySentIds`):** every outbound send
 *   records the returned message id; inbound `messages.upsert` drops messages
 *   whose id matches (our own echoes), so the agent never re-ingests its own
 *   replies. Any OTHER `fromMe` message is dropped too, UNLESS self-chat mode
 *   is on (`BUFF_WHATSAPP_SELF_CHAT=1`) — then user-typed self-chat messages
 *   (fromMe but NOT in recentlySent) are forwarded as inbound.
 * - **Contact-name resolution (`allow_from`/contact UX):** the
 *   bridge learns name → JID from `contacts.upsert`/`contacts.update` (the
 *   phone's address book sync) and from every inbound message's `pushName`,
 *   so `send("Alex", …)` resolves the contact by name.
 */
import { type WhatsAppBridge } from './bridge.js';
/** Read persisted LID→PN pairs (missing/corrupt file → [] — never throws). */
export declare function readLidMappingsFile(sessionDir: string): Array<{
    lid: string;
    pn: string;
}>;
/** Persist LID→PN pairs (mkdir + atomic-ish write; never throws). */
export declare function writeLidMappingsFile(sessionDir: string, pairs: Array<{
    lid: string;
    pn: string;
}>): void;
/**
 * Runtime LID → phone-number resolver. Jids that are NOT `@lid` pass through
 * untouched; a `@lid` jid is translated to its PN jid ("@s.whatsapp.net")
 * when a mapping is known. Persists learned pairs so restarts keep working
 * before the first sync of a new session.
 *
 * Baileys itself persists the pairs IT learns (from message envelopes,
 * linked-profile notifications, history sync) as `<session>/lid-mapping-<pn>.json`
 * (= "<lid>") and `<session>/lid-mapping-<lid>_reverse.json` (= "<pn>") — but
 * it NEVER emits `lid-mapping.update` for the envelope path, so an event-only
 * bridge never learns contacts that message us. `resolve()` therefore falls
 * back to those files on a cache miss (lazy, cheap, cached + persisted), which
 * also makes a NEW contact's first message resolve correctly.
 */
export declare class LidJidMapper {
    private readonly lidToPn;
    private readonly sessionDir;
    constructor(sessionDir?: string, seed?: Array<{
        lid: string;
        pn: string;
    }>);
    /** Store a LID→PN pair (accepts bare digits or full jids; normalizes both). */
    learn(lid: string, pn: string): void;
    /**
     * Translate a `@lid` jid to its PN jid; every other jid passes through.
     * On a cache miss for a `@lid` jid, consult Baileys' own persisted mapping
     * file (`lid-mapping-<digits>_reverse.json`) — the pair may exist on disk
     * even though no `lid-mapping.update` event ever reached us.
     */
    resolve(jid: string): string;
    /** Read `<session>/lid-mapping-<digits>_reverse.json` (a JSON string PN). */
    private readBaileysReverse;
    /** Like {@link resolve} but returns the input unchanged when it is undefined. */
    resolveOr(jid: string | undefined): string | undefined;
    /** All learned pairs (for persistence). */
    pairs(): Array<{
        lid: string;
        pn: string;
    }>;
    get size(): number;
}
/**
 * I8b — self-chat mode: the user messages THEMSELVES on the paired number;
 * the bridge forwards their fromMe messages as inbound (and still drops the
 * agent's own outbound echoes via recentlySent). Opt-in via
 * `BUFF_WHATSAPP_SELF_CHAT=1`. Default (bot mode): every fromMe message is
 * dropped — the agent never re-ingests its own sends.
 */
export declare function isSelfChatEnabled(env?: NodeJS.ProcessEnv): boolean;
/** Options for {@link BaileysBridge.pair}. */
export interface PairOptions {
    /** Called with the raw QR payload (Baileys `connection.update.qr`). */
    onQr?: (qr: string) => void;
    /** Called with a pre-rendered, scannable terminal QR (qrcode blocks). */
    onQrRendered?: (rendered: string) => void;
    /** Called with the 8-char "link with phone number instead" pairing code. */
    onPairingCode?: (code: string) => void;
    /** Pairing window in ms (default 90s). */
    timeoutMs?: number;
    /**
     * Pair via phone number (Baileys `requestPairingCode`) instead of a QR:
     * the user enters the 8-char code under WhatsApp → Linked devices → Link
     * with phone number instead. Full international format, no leading '+'.
     */
    phoneNumber?: string;
    /**
     * Abort the pairing early: ends the socket and resolves
     * `{ ok: false, reason: 'cancelled' }` (dashboard in-page cancel).
     */
    signal?: AbortSignal;
}
/**
 * Render a QR payload to a scannable terminal QR (qrcode block characters).
 * Best-effort: returns '' if `qrcode` can't be loaded. Lazily imported so the
 * rest of the gateway never pays for it.
 */
export declare function renderQrToTerminal(qr: string): Promise<string>;
/**
 * Render a QR payload to a browser-scannable PNG data URL (the in-page
 * dashboard pairing). Best-effort: returns '' if `qrcode` can't be loaded.
 */
export declare function renderQrToDataUrl(qr: string): Promise<string>;
/**
 * Normalize a user-supplied phone for `requestPairingCode`: digits only, no
 * leading '+', must include the country code (10–15 digits). Returns '' if
 * invalid.
 */
export declare function normalizePairingPhone(phone: string): string;
export declare class BaileysBridge implements WhatsAppBridge {
    private readonly sessionDir;
    private readonly opts;
    private sock;
    private onMessage;
    /** Auto-reconnect watcher: while true (connected), a dead socket is recreated. */
    private keepAlive;
    /** Set when the session is logged out server-side (401) — reconnect would loop forever. */
    private loggedOut;
    /** Set while an explicit pair() is running so the watcher never races it. */
    private pairing;
    /** I8b — ids of messages THIS bridge sent (echo filter; id → sent-at). */
    private readonly recentlySent;
    /** I8b — contacts from the user's mapping file (`nuvira whatsapp contact add`). */
    private readonly fileContacts;
    /** I8b — contacts learned at runtime (contacts sync / inbound pushName). */
    private readonly learnedContacts;
    /** LID → PN resolver (privacy-rollout DMs arrive as random `@lid` jids). */
    private readonly lidMapper;
    constructor(sessionDir?: string, opts?: {
        reconnectDelayMs?: number;
        selfChat?: boolean;
    });
    /** Live check — a bridge that paired THIS process reports true immediately. */
    get paired(): boolean;
    describe(): string;
    /** Learn a name → JID mapping at runtime (real pushName / contact sync). */
    private learnContact;
    /** Learn a LID→PN pair and persist it (new pairs only; never throws). */
    private learnLidMapping;
    /**
     * Resolve a contact NAME to a JID. Learned (real) names win over the file
     * mapping; each list is checked exact-first, then prefix/contains. Returns
     * null when unknown. Non-name targets (numbers / JIDs) are handled by the
     * caller via normalizeWhatsAppJid.
     */
    resolveContact(name: string): string | null;
    /** All resolvable contacts (name → JID), learned first, sorted by name. */
    contactNames(): Array<{
        name: string;
        jid: string;
    }>;
    get contactCount(): number;
    /**
     * Add a contact to the mapping file (`nuvira whatsapp contact add <name>
     * <number>`) and to the live map. Number may be E.164 or plain digits.
     */
    addContact(name: string, number: string): boolean;
    /** Remove a contact from the mapping file + live maps. Returns true when it existed. */
    removeContact(name: string): boolean;
    /**
     * Resolve a non-numeric target by contact name, polling briefly — the
     * address-book sync lands shortly after the socket opens, and a one-shot
     * CLI send resolves names only after that sync arrives.
     */
    private resolveContactJid;
    connect(onMessage: (fromJid: string, text: string) => void): Promise<void>;
    disconnect(): Promise<void>;
    /**
     * Recreate a dead socket while connected, with exponential backoff. Polls
     * `this.sock` (the close handler nulls it); the 10s waitForOpen cap and
     * backoff growth bound how hot the loop can get.
     */
    private watchReconnect;
    send(target: string, text: string): Promise<boolean>;
    /**
     * Send media (image/video/audio/document). P3 — the Baileys message content
     * is `{ [type]: data, caption?, mimetype?, fileName? }`; the target resolves
     * like send() (number / JID / contact name). Never throws.
     */
    sendMedia(target: string, media: {
        type: 'image' | 'video' | 'audio' | 'document';
        data: Uint8Array;
        caption?: string;
        filename?: string;
    }): Promise<boolean>;
    /**
     * Interactive pairing (the `nuvira whatsapp pair` flow).
     *
     * QR mode (default): surfaces the raw payload via `onQr` and a scannable
     * terminal QR via `onQrRendered` (qrcode block characters). Baileys 7.x
     * deprecated `printQRInTerminal` — it no longer prints anything — so the
     * QR is rendered here from `connection.update.qr`.
     *
     * Phone mode (`phoneNumber` set): requests an 8-char pairing code via
     * Baileys `requestPairingCode` and surfaces it via `onPairingCode` — the
     * user enters it under WhatsApp → Linked devices → Link with phone number
     * instead (handy on headless/remote hosts where scanning is impossible).
     *
     * Resolves ok once the connection opens.
     */
    pair(opts?: PairOptions): Promise<{
        ok: boolean;
        reason: string;
    }>;
    /** Lazily create + wire the Baileys socket (idempotent). Never throws. */
    private ensureSocket;
    /** Resolve when the socket's connection opens (or after the timeout). */
    private waitForOpen;
}
//# sourceMappingURL=baileys-bridge.d.ts.map