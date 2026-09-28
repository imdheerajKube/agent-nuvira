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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  normalizeWhatsAppJid,
  type WhatsAppBridge,
  type WhatsAppSendResult,
} from './bridge.js';
import { whatsappSessionDir } from './session.js';
import { readContactsFile, writeContactsFile } from './contacts.js';
import { MAX_INBOUND_MEDIA_BYTES, type InboundMedia } from '../inbound-media.js';
import { envBuff } from '../../config/paths.js';

/**
 * How old an OFFLINE-BACKFILL message may be and still be handled (ms).
 *
 * WhatsApp re-delivers history after every (re)connect. Anything genuinely new
 * — sent while the gateway was briefly offline — is seconds/minutes old and is
 * handled; anything older was already answered (or is stale), and re-running it
 * is what produced the observed reply storms. Override with
 * `BUFF_GATEWAY_BACKFILL_MAX_AGE_MS` (0 = never accept backfill at all).
 */
export const BACKFILL_MAX_AGE_MS = (() => {
  const raw = envBuff('GATEWAY_BACKFILL_MAX_AGE_MS');
  if (raw === undefined || raw.trim() === '') return 10 * 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10 * 60 * 1000;
})();

// ─── LID → phone-number mapping ────────────────────────────────────────────
// WhatsApp's privacy rollout moved DMs to LID jids ("123456789012345@lid"):
// the LID is a RANDOM id, NOT the contact's phone number, so an allow-list
// entry like "+918811122233" can never match the raw sender jid. Baileys
// learns the LID→PN pairs internally (linked-profile notifications,
// contactAction sync, history sync, pnForLidChatAction) and emits them as
// `lid-mapping.update` events — the bridge mirrors those into its own map so
// inbound senders resolve to their phone-number jid BEFORE the policy gate
// compares them against the allow-list.

/** The LID↔PN mapping file next to a WhatsApp session dir. */
function lidMappingsFile(sessionDir: string): string {
  return join(sessionDir, 'lid-mappings.json');
}

/** Read persisted LID→PN pairs (missing/corrupt file → [] — never throws). */
export function readLidMappingsFile(sessionDir: string): Array<{ lid: string; pn: string }> {
  try {
    const file = lidMappingsFile(sessionDir);
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Array<{ lid: string; pn: string }>;
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p?.lid === 'string' && typeof p?.pn === 'string') : [];
  } catch {
    return [];
  }
}

/** Persist LID→PN pairs (mkdir + atomic-ish write; never throws). */
export function writeLidMappingsFile(sessionDir: string, pairs: Array<{ lid: string; pn: string }>): void {
  try {
    const file = lidMappingsFile(sessionDir);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(file, JSON.stringify(pairs, null, 2), 'utf-8');
  } catch {
    /* best-effort — a failed write must never break a message */
  }
}

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
export class LidJidMapper {
  private readonly lidToPn = new Map<string, string>();
  private readonly sessionDir: string | undefined;

  constructor(sessionDir?: string, seed?: Array<{ lid: string; pn: string }>) {
    this.sessionDir = sessionDir;
    for (const { lid, pn } of seed ?? (sessionDir ? readLidMappingsFile(sessionDir) : [])) {
      this.learn(lid, pn);
    }
  }

  /** Store a LID→PN pair (accepts bare digits or full jids; normalizes both). */
  learn(lid: string, pn: string): void {
    const l = (lid || '').trim();
    const p = (pn || '').trim();
    if (!l || !p) return;
    const lidJid = l.includes('@') ? l : `${l}@lid`;
    const pnJid = p.includes('@') ? p : `${p}@s.whatsapp.net`;
    if (lidJid.endsWith('@lid') && pnJid.endsWith('@s.whatsapp.net')) this.lidToPn.set(lidJid, pnJid);
  }

  /**
   * Translate a `@lid` jid to its PN jid; every other jid passes through.
   * On a cache miss for a `@lid` jid, consult Baileys' own persisted mapping
   * file (`lid-mapping-<digits>_reverse.json`) — the pair may exist on disk
   * even though no `lid-mapping.update` event ever reached us.
   */
  resolve(jid: string): string {
    const hit = this.lidToPn.get(jid);
    if (hit) return hit;
    if (!this.sessionDir || !jid.endsWith('@lid')) return jid;
    const pn = this.readBaileysReverse(jid);
    if (!pn) return jid;
    this.learn(jid, pn);
    return this.lidToPn.get(jid) ?? jid;
  }

  /** Read `<session>/lid-mapping-<digits>_reverse.json` (a JSON string PN). */
  private readBaileysReverse(jid: string): string | null {
    try {
      // Strip the device suffix ("220722781786162:1@lid" → "220722781786162").
      const digits = jid.replace(/@lid$/i, '').replace(/:\d+$/, '');
      if (!/^\d+$/.test(digits)) return null;
      const file = join(this.sessionDir!, `lid-mapping-${digits}_reverse.json`);
      if (!existsSync(file)) return null;
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as string | number | null;
      const pn = String(parsed ?? '').trim();
      return /^\d+$/.test(pn) ? pn : null;
    } catch {
      return null;
    }
  }

  /** Like {@link resolve} but returns the input unchanged when it is undefined. */
  resolveOr(jid: string | undefined): string | undefined {
    return jid ? this.resolve(jid) : jid;
  }

  /** All learned pairs (for persistence). */
  pairs(): Array<{ lid: string; pn: string }> {
    return [...this.lidToPn.entries()].map(([lid, pn]) => ({ lid, pn }));
  }

  get size(): number {
    return this.lidToPn.size;
  }
}

function isLidJid(jid: string | undefined): boolean {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

// Minimal structural types — the real ones come from the lazy `baileys`
// import (cast through `unknown`), so the rest of the codebase never
// hard-depends on the package's public surface.
interface WASocketLike {
  sendMessage(jid: string, content: unknown): Promise<unknown>;
  /** Baileys phone-number pairing: resolves the 8-char "link with number" code. */
  requestPairingCode?(phoneNumber: string, customPairingCode?: string): Promise<string>;
  /** Resolves once the underlying WebSocket handshake completes. */
  waitForSocketOpen?(): Promise<void>;
  /**
   * WhatsApp's account-existence query (USync). Resolves `undefined` when the
   * query itself fails (inconclusive) and an array of `{ jid, exists }`
   * otherwise — note Baileys FILTERS unregistered users out, so an absent
   * entry means "not on WhatsApp".
   */
  onWhatsApp?(...phoneNumber: string[]): Promise<Array<{ jid: string; exists: boolean }> | undefined>;
  ev?: {
    on(event: string, cb: (...args: unknown[]) => void): unknown;
    removeAllListeners?(event?: string): unknown;
  };
  end?(reason?: unknown): void;
}

interface ConnectionUpdateLike {
  qr?: string;
  connection?: string;
  lastDisconnect?: { error?: Error };
}

/** The slice of the baileys module surface the bridge uses. */
interface BaileysApi {
  makeWASocket: (opts: Record<string, unknown>) => WASocketLike;
  useMultiFileAuthState: (dir: string) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
  /**
   * Module-level media downloader (Baileys `downloadMediaMessage`). Optional —
   * an older/partial baileys without it leaves inbound media undownloadable,
   * which the bridge reports by forwarding the caption-only text.
   */
  downloadMediaMessage?: (
    message: unknown,
    type: 'buffer',
    options?: unknown,
    ctx?: { logger?: unknown },
  ) => Promise<Buffer>;
}

function sessionHasCreds(dir: string): boolean {
  try {
    return existsSync(join(dir, 'creds.json'));
  } catch {
    return false;
  }
}

/**
 * I8b — self-chat mode: the user messages THEMSELVES on the paired number;
 * the bridge forwards their fromMe messages as inbound (and still drops the
 * agent's own outbound echoes via recentlySent). Opt-in via
 * `BUFF_WHATSAPP_SELF_CHAT=1`. Default (bot mode): every fromMe message is
 * dropped — the agent never re-ingests its own sends.
 */
export function isSelfChatEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.BUFF_WHATSAPP_SELF_CHAT ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// ─── Delivery verification ─────────────────────────────────────────────────

/**
 * How long to wait for WhatsApp's device acknowledgement of an outbound
 * message (ms).
 *
 * DEFAULT 0 — `sendMessage` only resolves after WhatsApp ACKS the message
 * stanza (Baileys awaits it), so a resolve already proves the recipient EXISTS
 * and the server accepted the message for delivery: that is `accepted`, and it
 * costs nothing. Waiting for the DELIVERY/READ receipt upgrades the verdict to
 * `delivered`, but it depends on the recipient's device being online — they
 * may legitimately acknowledge minutes later (WhatsApp holds offline messages)
 * — so it is opt-in rather than a default that would add latency to every
 * reply. `NUVIRA_WHATSAPP_ACK_WAIT_MS=<ms>` enables it (read per send, so tests
 * and config changes apply immediately).
 */
export function whatsappAckWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.NUVIRA_WHATSAPP_ACK_WAIT_MS ?? env.BUFF_WHATSAPP_ACK_WAIT_MS ?? '').trim();
  if (raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** How long a recipient-registration answer is trusted (ms). */
export const REGISTRATION_CACHE_TTL_MS = 10 * 60_000;

/**
 * `proto.WebMessageInfo.Status` values (see baileys/WAProto).
 * ERROR=0 rejects the message; SERVER_ACK=2 is WhatsApp accepting it;
 * DELIVERY_ACK=3 means the recipient's device received it.
 */
const WA_STATUS_ERROR = 0;
const WA_STATUS_SERVER_ACK = 2;
const WA_STATUS_DELIVERY_ACK = 3;

/** Cap the per-message status map (diagnostics only — never grows). */
const MAX_TRACKED_STATUSES = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Best-effort error text (never throws, never leaks a stack). */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message.split('\n')[0]?.trim() || err.name;
  const s = String(err ?? '').trim();
  return s || 'unknown error';
}

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
export async function renderQrToTerminal(qr: string): Promise<string> {
  try {
    const mod = await import('qrcode');
    return await mod.toString(qr, { type: 'terminal', small: true });
  } catch {
    return '';
  }
}

/**
 * Render a QR payload to a browser-scannable PNG data URL (the in-page
 * dashboard pairing). Best-effort: returns '' if `qrcode` can't be loaded.
 */
export async function renderQrToDataUrl(qr: string): Promise<string> {
  try {
    const mod = await import('qrcode');
    return await mod.toDataURL(qr, { margin: 1, width: 320 });
  } catch {
    return '';
  }
}

/**
 * Normalize a user-supplied phone for `requestPairingCode`: digits only, no
 * leading '+', must include the country code (10–15 digits). Returns '' if
 * invalid.
 */
export function normalizePairingPhone(phone: string): string {
  const digits = (phone || '').replace(/\D+/g, '');
  return /^\d{10,15}$/.test(digits) ? digits : '';
}

/** Silent pino-shaped logger so Baileys' internal noise never pollutes CLI output. */
const QUIET_LOGGER: Record<string, unknown> = {
  level: 'silent',
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child: () => QUIET_LOGGER,
};

async function loadBaileys(): Promise<BaileysApi | null> {
  try {
    return (await import('baileys')) as unknown as BaileysApi;
  } catch {
    return null;
  }
}

/** An inbound media attachment's descriptors (before the bytes are fetched). */
interface MediaDescriptor {
  type: InboundMedia['type'];
  mimetype?: string;
  filename?: string;
  caption?: string;
  /** Declared size in bytes, when the transport provides it (pre-download gate). */
  size?: number;
}

/** Best-effort text extraction from a Baileys message event. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function messageText(message: any): string {
  const c = message?.message;
  // A document/image/video carries its instruction in the CAPTION; reading only
  // `conversation`/`extendedTextMessage` made those messages look textless.
  return (
    c?.conversation
    ?? c?.extendedTextMessage?.text
    ?? c?.imageMessage?.caption
    ?? c?.videoMessage?.caption
    ?? c?.documentMessage?.caption
    ?? c?.documentWithCaptionMessage?.message?.documentMessage?.caption
    ?? ''
  );
}

/** Best-effort number from a Baileys field (Long / number / numeric string). */
function numOrUndef(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (v && typeof v === 'object') {
    const o = v as { toNumber?: () => unknown; low?: unknown };
    if (typeof o.toNumber === 'function') {
      const n = Number(o.toNumber());
      if (Number.isFinite(n)) return n;
    }
    if (Number.isFinite(Number(o.low))) return Number(o.low) >>> 0;
  }
  return undefined;
}

/**
 * Media descriptor for an inbound message, or null for a plain text message.
 * Handles the wrapped `documentWithCaptionMessage` shape some clients send for
 * a document that carries a caption.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mediaDescriptor(message: any): MediaDescriptor | null {
  const c = message?.message;
  const doc = c?.documentMessage ?? c?.documentWithCaptionMessage?.message?.documentMessage;
  if (doc) {
    return {
      type: 'document',
      mimetype: typeof doc.mimetype === 'string' ? doc.mimetype : undefined,
      filename: typeof doc.fileName === 'string' ? doc.fileName : (typeof doc.title === 'string' ? doc.title : undefined),
      caption: typeof doc.caption === 'string' ? doc.caption : undefined,
      size: numOrUndef(doc.fileLength),
    };
  }
  const img = c?.imageMessage;
  if (img) {
    return {
      type: 'image',
      mimetype: typeof img.mimetype === 'string' ? img.mimetype : undefined,
      caption: typeof img.caption === 'string' ? img.caption : undefined,
      size: numOrUndef(img.fileLength),
    };
  }
  const vid = c?.videoMessage;
  if (vid) {
    return {
      type: 'video',
      mimetype: typeof vid.mimetype === 'string' ? vid.mimetype : undefined,
      caption: typeof vid.caption === 'string' ? vid.caption : undefined,
      size: numOrUndef(vid.fileLength),
    };
  }
  const aud = c?.audioMessage;
  if (aud) {
    return {
      type: 'audio',
      mimetype: typeof aud.mimetype === 'string' ? aud.mimetype : undefined,
      size: numOrUndef(aud.fileLength),
    };
  }
  return null;
}

/**
 * Best-effort epoch-MILLISECONDS from a Baileys message's `messageTimestamp`.
 * Baileys delivers it in SECONDS as a number, a string, or a Long-like object
 * (`{ toNumber() }`) depending on the version — handle all three, and return
 * null when the shape is unrecognized so callers can decide (never guess a
 * timestamp, which would silently age a live message out).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function messageTimestampMs(message: any): number | null {
  const raw = message?.messageTimestamp;
  let seconds: number | null = null;
  if (typeof raw === 'number' && Number.isFinite(raw)) seconds = raw;
  else if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) seconds = Number(raw);
  else if (raw && typeof raw === 'object' && typeof raw.toNumber === 'function') {
    const n = Number(raw.toNumber());
    if (Number.isFinite(n)) seconds = n;
  } else if (raw && typeof raw === 'object' && Number.isFinite(Number(raw.low))) {
    // Long split into { low, high } without a toNumber helper (32-bit low).
    seconds = Number(raw.low) >>> 0;
  }
  if (seconds === null || seconds <= 0) return null;
  return seconds * 1000;
}

export class BaileysBridge implements WhatsAppBridge {
  private sock: WASocketLike | null = null;
  private onMessage:
    | ((fromJid: string, text: string, participant?: string, messageId?: string, media?: InboundMedia) => void)
    | null = null;
  /** Auto-reconnect watcher: while true (connected), a dead socket is recreated. */
  private keepAlive = false;
  /** Set when the session is logged out server-side (401) — reconnect would loop forever. */
  private loggedOut = false;
  /** Set while an explicit pair() is running so the watcher never races it. */
  private pairing = false;
  /** I8b — ids of messages THIS bridge sent (echo filter; id → sent-at). */
  private readonly recentlySent = new Map<string, number>();
  /** I8b — contacts from the user's mapping file (`nuvira whatsapp contact add`). */
  private readonly fileContacts = new Map<string, string>();
  /** I8b — contacts learned at runtime (contacts sync / inbound pushName). */
  private readonly learnedContacts = new Map<string, string>();
  /** LID → PN resolver (privacy-rollout DMs arrive as random `@lid` jids). */
  private readonly lidMapper: LidJidMapper;
  /**
   * Memoized recipient-registration answers (`onWhatsApp`), keyed by the
   * digits-only phone. Prevents a USync round-trip on every send while still
   * catching a mistyped / non-WhatsApp number — the silent-drop class this
   * guard exists for.
   */
  private readonly registrationCache = new Map<string, { exists: boolean; at: number }>();
  /**
   * Last known `WAMessageStatus` per outbound message id. Populated from
   * `messages.update`; used to confirm delivery and to record WHY a send
   * failed (structured gateway logs / diagnostics). Bounded.
   */
  private readonly messageStatus = new Map<string, number>();

  constructor(
    private readonly sessionDir: string = whatsappSessionDir(),
    private readonly opts: { reconnectDelayMs?: number; selfChat?: boolean } = {},
  ) {
    this.lidMapper = new LidJidMapper(sessionDir);
    // Seed the address-book mappings from ~/.nuvira/whatsapp/contacts.json.
    for (const [name, digits] of Object.entries(readContactsFile(this.sessionDir))) {
      const key = (name || '').trim().toLowerCase();
      if (!key || !digits) continue;
      const jid = normalizeWhatsAppJid(digits);
      if (jid) this.fileContacts.set(key, jid);
    }
  }

  /** Live check — a bridge that paired THIS process reports true immediately. */
  get paired(): boolean {
    return sessionHasCreds(this.sessionDir);
  }

  describe(): string {
    if (!this.paired) {
      return `WhatsApp (Baileys bridge — not paired; run \`nuvira whatsapp pair\`, session: ${this.sessionDir})`;
    }
    const mode = this.opts.selfChat ? ', self-chat mode' : '';
    return `WhatsApp (Baileys bridge — paired${mode}, session: ${this.sessionDir})`;
  }

  // ─── I8b contact learning / resolution ────────────────────────────────────

  /** Learn a name → JID mapping at runtime (real pushName / contact sync). */
  private learnContact(name: string, jid: string): void {
    const key = (name || '').trim().toLowerCase();
    if (!key || !jid) return;
    this.learnedContacts.set(key, jid);
  }

  /** Learn a LID→PN pair and persist it (new pairs only; never throws). */
  private learnLidMapping(lid: string, pn: string): void {
    const before = this.lidMapper.size;
    this.lidMapper.learn(lid, pn);
    if (this.lidMapper.size === before) return;
    writeLidMappingsFile(this.sessionDir, this.lidMapper.pairs());
  }

  /**
   * Resolve a contact NAME to a JID. Learned (real) names win over the file
   * mapping; each list is checked exact-first, then prefix/contains. Returns
   * null when unknown. Non-name targets (numbers / JIDs) are handled by the
   * caller via normalizeWhatsAppJid.
   */
  resolveContact(name: string): string | null {
    const key = (name || '').trim().toLowerCase();
    if (!key) return null;
    for (const map of [this.learnedContacts, this.fileContacts]) {
      const exact = map.get(key);
      if (exact) return exact;
      for (const [k, jid] of map) {
        if (k.includes(key) || key.includes(k)) return jid;
      }
    }
    return null;
  }

  /** All resolvable contacts (name → JID), learned first, sorted by name. */
  contactNames(): Array<{ name: string; jid: string }> {
    const merged = new Map<string, string>();
    for (const map of [this.learnedContacts, this.fileContacts]) {
      for (const [name, jid] of map) merged.set(name, jid);
    }
    return [...merged.entries()]
      .map(([name, jid]) => ({ name, jid }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get contactCount(): number {
    return this.fileContacts.size + this.learnedContacts.size;
  }

  /**
   * Add a contact to the mapping file (`nuvira whatsapp contact add <name>
   * <number>`) and to the live map. Number may be E.164 or plain digits.
   */
  addContact(name: string, number: string): boolean {
    const key = (name || '').trim();
    const digits = (number || '').replace(/\D+/g, '');
    if (!key || !digits) return false;
    const jid = normalizeWhatsAppJid(digits);
    if (!jid) return false;
    const contacts = readContactsFile(this.sessionDir);
    contacts[key] = digits;
    writeContactsFile(this.sessionDir, contacts);
    this.fileContacts.set(key.toLowerCase(), jid);
    return true;
  }

  /** Remove a contact from the mapping file + live maps. Returns true when it existed. */
  removeContact(name: string): boolean {
    const key = (name || '').trim().toLowerCase();
    let removed = false;
    const contacts = readContactsFile(this.sessionDir);
    for (const existing of Object.keys(contacts)) {
      if (existing.toLowerCase() === key) {
        delete contacts[existing];
        removed = true;
      }
    }
    if (removed) writeContactsFile(this.sessionDir, contacts);
    if (this.fileContacts.delete(key)) removed = true;
    this.learnedContacts.delete(key);
    return removed;
  }

  /**
   * Resolve a non-numeric target by contact name, polling briefly — the
   * address-book sync lands shortly after the socket opens, and a one-shot
   * CLI send resolves names only after that sync arrives.
   */
  private async resolveContactJid(name: string, timeoutMs = 10_000): Promise<string | null> {
    const hit = this.resolveContact(name);
    if (hit) return hit;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 250));
      const found = this.resolveContact(name);
      if (found) return found;
    }
    return null;
  }

  async connect(
    onMessage: (fromJid: string, text: string, participant?: string, messageId?: string, media?: InboundMedia) => void,
  ): Promise<void> {
    this.onMessage = onMessage;
    this.keepAlive = true;
    this.loggedOut = false;
    await this.ensureSocket();
    // whatsmeow-parity auto-reconnect: while the bridge is connected, a dead
    // socket (network drop, Baileys 7's 515 restart, server cycling) is
    // recreated from the persisted session so the inbound listener never
    // silently dies. Stops on disconnect() or a server-side logout (401).
    void this.watchReconnect();
  }

  async disconnect(): Promise<void> {
    this.keepAlive = false;
    try {
      this.sock?.end?.('gateway stop');
    } catch {
      /* best-effort */
    }
    this.sock = null;
    this.onMessage = null;
    this.loggedOut = false;
  }

  /**
   * Download an inbound media message's bytes. Never throws — returns null on
   * any failure (a missing downloader, an expired/undownloadable attachment)
   * so the turn still runs with whatever caption text it had.
   *
   * The declared size is checked BEFORE the download: a large video must not be
   * pulled into memory only to be discarded by the extraction cap.
   */
  private async downloadInboundMedia(
    raw: unknown,
    desc: MediaDescriptor,
  ): Promise<InboundMedia | null> {
    if (desc.size !== undefined && desc.size > MAX_INBOUND_MEDIA_BYTES) return null;
    try {
      const baileys = await loadBaileys();
      if (!baileys?.downloadMediaMessage) return null;
      const buf = await baileys.downloadMediaMessage(raw, 'buffer', {}, { logger: QUIET_LOGGER });
      if (!buf || buf.length === 0) return null;
      return {
        type: desc.type,
        data: new Uint8Array(buf),
        filename: desc.filename,
        mimetype: desc.mimetype,
        caption: desc.caption,
      };
    } catch {
      return null;
    }
  }

  /**
   * Recreate a dead socket while connected, with exponential backoff. Polls
   * `this.sock` (the close handler nulls it); the 10s waitForOpen cap and
   * backoff growth bound how hot the loop can get.
   */
  private async watchReconnect(): Promise<void> {
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    let delay = this.opts.reconnectDelayMs ?? 2_000;
    while (this.keepAlive) {
      while (this.keepAlive && !this.loggedOut && !this.pairing && this.sock) {
        await sleep(500);
      }
      if (!this.keepAlive || this.loggedOut) return;
      await sleep(delay);
      if (!this.keepAlive || this.loggedOut || this.pairing) return;
      if (this.sock) continue; // recreated by a concurrent send() meanwhile
      await this.ensureSocket();
      delay = Math.min(delay * 2, 30_000);
    }
  }

  async send(target: string, text: string): Promise<boolean> {
    return (await this.sendVerified(target, text)).ok;
  }

  /**
   * VERIFIED send — the honest answer to "did it actually go out?".
   *
   * `sendMessage` resolving is NOT proof of delivery (live incident
   * 2026-09-21: a WhatsApp send reported success while the recipient received
   * nothing). This checks, in order:
   *  1. the recipient is a REGISTERED WhatsApp account (`onWhatsApp`) — the
   *     mistyped/unknown-number class that silently went nowhere;
   *  2. WhatsApp returned a real message id and did not mark the message a stub
   *     (an undeliverable/blocked message is reported as a FAILURE, not a send);
   *  3. when `NUVIRA_WHATSAPP_ACK_WAIT_MS` is set, the device acknowledgement
   *     is awaited so the verdict can be upgraded to `delivered`.
   * A resolve already implies WhatsApp acked the stanza, so an unconfirmed
   * send reports `accepted`, never a bare "sent".
   */
  async sendVerified(target: string, text: string): Promise<WhatsAppSendResult> {
    return this.deliverVerified(target, { text });
  }

  /**
   * Shared verified-delivery path for text and media. Never throws.
   */
  private async deliverVerified(
    target: string,
    content: Record<string, unknown>,
  ): Promise<WhatsAppSendResult> {
    if (!this.paired) {
      return { ok: false, reason: 'WhatsApp is not paired — run `nuvira whatsapp pair` first.' };
    }
    let sock: WASocketLike | null = null;
    try {
      sock = await this.ensureSocket();
    } catch {
      sock = null;
    }
    if (!sock) {
      return { ok: false, reason: 'the WhatsApp transport could not be opened (socket unavailable).' };
    }

    // I8b — a non-numeric, non-JID target is a contact NAME: resolve it
    // against the learned contact list (waits for the address-book sync).
    const jid = await this.resolveTargetJid(target);
    if (!jid) return { ok: false, reason: `cannot resolve WhatsApp target '${target}'.` };

    const unreachable = await this.verifyRecipient(sock, jid);
    if (unreachable) return { ok: false, reason: unreachable, jid };

    let sent: { key?: { id?: string }; messageStubType?: number | string | null } | undefined;
    try {
      sent = (await sock.sendMessage(jid, content)) as typeof sent;
    } catch (err) {
      return { ok: false, reason: `WhatsApp rejected the send: ${errorText(err)}`, jid };
    }

    // ACCEPTANCE CHECK — a resolved promise with no message id means the
    // message was never actually accepted; claiming success here is exactly
    // the false positive this path removes.
    const id = sent?.key?.id;
    if (typeof id !== 'string' || !id) {
      return { ok: false, reason: 'WhatsApp returned no message id — the message was NOT sent.', jid };
    }
    const stub = Number(sent?.messageStubType ?? 0);
    if (Number.isFinite(stub) && stub > 0) {
      return { ok: false, reason: `WhatsApp marked the message undeliverable (stub type ${stub}).`, jid };
    }

    // Record the outbound message id so its echo is filtered on upsert.
    this.recentlySent.set(id, Date.now());
    // Cap the echo window at 10 minutes — ids never collide that late.
    for (const [k, at] of this.recentlySent) {
      if (Date.now() - at > 10 * 60_000) this.recentlySent.delete(k);
    }

    const verdict = await this.confirmDelivery(id);
    if (verdict === 'failed') {
      return {
        ok: false,
        reason: 'WhatsApp reported an error for this message — the recipient may be unreachable.',
        jid,
      };
    }
    return { ok: true, verification: verdict, jid };
  }

  /**
   * Resolve a user-supplied target to a native JID (number / JID verbatim,
   * contact NAME via the learned + file contact maps).
   */
  private async resolveTargetJid(target: string): Promise<string> {
    const t = (target || '').trim();
    if (!t) return '';
    if (t.includes('@') || /^\+?\d[\d\s-]*$/.test(t)) return normalizeWhatsAppJid(t);
    return (await this.resolveContactJid(t)) ?? normalizeWhatsAppJid(t);
  }

  /**
   * Confirm the recipient is a REGISTERED WhatsApp account before sending.
   *
   * Returns `true` (registered), `false` (definitively not on WhatsApp) or
   * `null` when the check is inconclusive — a group/broadcast/LID target, a
   * transport without `onWhatsApp`, or a failed USync query. Inconclusive
   * NEVER blocks a send: the guard exists to catch a wrong number, not to add
   * a new way for a good send to fail.
   *
   * Baileys FILTERS unregistered users out of the result, so an absent entry is
   * a definitive "no WhatsApp account for this number".
   */
  private async checkRegistration(sock: WASocketLike, jid: string): Promise<boolean | null> {
    const bare = jid.replace(/:\d+(?=@)/, '');
    if (!/^\d+@s\.whatsapp\.net$/.test(bare)) return null; // groups/broadcast/LID/aliases
    const digits = bare.split('@')[0]!;
    const cached = this.registrationCache.get(digits);
    if (cached && Date.now() - cached.at < REGISTRATION_CACHE_TTL_MS) return cached.exists;
    if (typeof sock.onWhatsApp !== 'function') return null;
    try {
      const res = await sock.onWhatsApp(bare);
      // `undefined` = the USync query failed (inconclusive — do not block).
      if (!res) return null;
      const exists = res.some((r) => r?.exists && String(r.jid ?? '').replace(/:\d+(?=@)/, '').split('@')[0] === digits);
      this.registrationCache.set(digits, { exists, at: Date.now() });
      return exists;
    } catch {
      return null;
    }
  }

  /** Failure reason when the recipient is definitively unreachable, else null. */
  private async verifyRecipient(sock: WASocketLike, jid: string): Promise<string | null> {
    const registered = await this.checkRegistration(sock, jid);
    if (registered === false) {
      return (
        `${jid} is not a WhatsApp account — the message was NOT sent. ` +
        'Check the number (include the country code) and try again.'
      );
    }
    return null;
  }

  /**
   * Confirm delivery using the `messages.update` status stream.
   *
   * With no wait configured this is a single check of the freshest status (a
   * resolve already implies WhatsApp acked the stanza → `accepted`). With
   * `NUVIRA_WHATSAPP_ACK_WAIT_MS` set it waits for a device acknowledgement and
   * upgrades the verdict to `delivered`; an explicit ERROR status is a failure
   * at any point.
   */
  private async confirmDelivery(id: string): Promise<'delivered' | 'accepted' | 'failed'> {
    const deadline = Date.now() + whatsappAckWaitMs();
    for (;;) {
      const status = this.messageStatus.get(id);
      if (status === WA_STATUS_ERROR) return 'failed';
      if (status !== undefined && status >= WA_STATUS_DELIVERY_ACK) return 'delivered';
      if (Date.now() >= deadline) {
        const latest = this.messageStatus.get(id);
        if (latest === WA_STATUS_ERROR) return 'failed';
        if (latest !== undefined && latest >= WA_STATUS_DELIVERY_ACK) return 'delivered';
        // ACKed by the server (implied by the resolve) or not yet reported.
        return 'accepted';
      }
      await sleep(120);
    }
  }

  /** Record a `messages.update` status (bounded; diagnostics + ack waiting). */
  private recordMessageStatus(id: string, status: number): void {
    this.messageStatus.set(id, status);
    if (this.messageStatus.size > MAX_TRACKED_STATUSES) {
      const oldest = this.messageStatus.keys().next().value;
      if (oldest !== undefined) this.messageStatus.delete(oldest);
    }
  }

  /**
   * Last known WhatsApp status for a message id (`proto.WebMessageInfo.Status`)
   * — `2` accepted, `3` delivered to the device, `0` error. Diagnostics only.
   */
  statusFor(messageId: string): number | undefined {
    return this.messageStatus.get(messageId);
  }

  /**
   * Send media (image/video/audio/document). P3 — the Baileys message content
   * is `{ [type]: data, caption?, mimetype?, fileName? }`; the target resolves
   * like send() (number / JID / contact name). Never throws.
   */
  async sendMedia(
    target: string,
    media: { type: 'image' | 'video' | 'audio' | 'document'; data: Uint8Array; caption?: string; filename?: string },
  ): Promise<boolean> {
    return (await this.sendMediaVerified(target, media)).ok;
  }

  /**
   * Verified media send — same recipient/acceptance checks as `sendVerified`
   * (a media send that went nowhere must not report success either).
   */
  async sendMediaVerified(
    target: string,
    media: { type: 'image' | 'video' | 'audio' | 'document'; data: Uint8Array; caption?: string; filename?: string },
  ): Promise<WhatsAppSendResult> {
    const payload: Record<string, unknown> = { [media.type]: media.data };
    if (media.caption) payload.caption = media.caption;
    if (media.type === 'audio') payload.mimetype = 'audio/mp4';
    if (media.type === 'document' && media.filename) payload.fileName = media.filename;
    return this.deliverVerified(target, payload);
  }

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
  async pair(opts: PairOptions = {}): Promise<{ ok: boolean; reason: string }> {
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const signal = opts.signal;
    const phone = opts.phoneNumber ? normalizePairingPhone(opts.phoneNumber) : '';
    if (opts.phoneNumber && !phone) {
      return {
        ok: false,
        reason: `invalid phone number '${opts.phoneNumber}' — use full international format with country code, e.g. 918844433322`,
      };
    }
    try {
      const baileys = await loadBaileys();
      if (!baileys) return { ok: false, reason: 'cannot load the Baileys bridge (is `baileys` installed?)' };
      this.pairing = true;
      mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
      const { state, saveCreds } = await baileys.useMultiFileAuthState(this.sessionDir);

      // Baileys 7 quirk: after a SUCCESSFUL scan / pairing-code issuance,
      // WhatsApp closes the connection (515 "Stream Errored (restart
      // required)" after a scan; a plain 428 close right after a pairing code)
      // — the creds are saved and the client must reconnect with them to
      // finish. Treating those closes as failures (as earlier versions did)
      // made real-world pairing report "pair failed: Stream Errored (restart
      // required)" / "Connection Terminated". We recreate the socket with the
      // same in-memory auth state (mutated in place + persisted via saveCreds);
      // the pairing window (timeoutMs) is the REAL bound — the restart cap is
      // only a defensive valve against a pathological server.
      const MAX_PAIR_RESTARTS = 40;
      const makeSocket = (): WASocketLike => {
        const s = baileys.makeWASocket({
          auth: state,
          // printQRInTerminal is DEPRECATED and a no-op in baileys ≥6.7 — the QR
          // only arrives via connection.update, and we render it ourselves.
          printQRInTerminal: false,
          logger: QUIET_LOGGER,
        });
        s.ev?.on('creds.update', () => void saveCreds());
        return s;
      };
      let current = makeSocket();

      return await new Promise<{ ok: boolean; reason: string }>((resolve) => {
        let settled = false;
        let restarts = 0;
        let credentialIssued = false;
        // finish() only ever runs asynchronously (timer/event handlers), so
        // `timer`/`onAbort` are assigned before they can be read (no TDZ issue)
        // — same latch pattern as waitForOpen().
        const finish = (result: { ok: boolean; reason: string }): void => {
          if (settled) return;
          settled = true;
          this.pairing = false;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        };
        const onAbort = (): void => {
          try {
            current.end?.('pairing cancelled');
          } catch {
            /* best-effort */
          }
          finish({ ok: false, reason: 'cancelled' });
        };
        const timer = setTimeout(() => {
          try {
            current.end?.(new Error('pair timeout'));
          } catch {
            /* best-effort */
          }
          finish({ ok: false, reason: 'pairing timed out — scan the QR / enter the code within the window' });
        }, timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });

        const onConnectionUpdate = (...args: unknown[]): void => {
          if (settled) return; // ignore events after we've finished (timeout/abort/cancel)
          const u = (args[0] ?? {}) as ConnectionUpdateLike;
          if (u.qr) {
            credentialIssued = true;
            opts.onQr?.(u.qr);
            if (phone) {
              // In phone mode the 8-char code can also arrive here.
              if (/^\d{8}$/.test(u.qr)) opts.onPairingCode?.(u.qr);
            } else {
              void renderQrToTerminal(u.qr).then((rendered) => {
                if (rendered) opts.onQrRendered?.(rendered);
              });
            }
          }
          if (u.connection === 'open') {
            this.sock = current;
            finish({ ok: true, reason: 'paired' });
            return;
          }
          if (u.connection !== 'close' || !u.lastDisconnect?.error) return;
          const err = u.lastDisconnect.error;
          // Boom-shaped errors carry the disconnect code at output.statusCode;
          // 515 = restartRequired ("Stream Errored (restart required)").
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const statusCode = (err as any)?.output?.statusCode ?? (err as any)?.statusCode;
          const message = err.message || 'connection closed';
          // Restart-worthy closes: the explicit 515 "restart required", or a
          // server-initiated close AFTER a QR/code was issued (WhatsApp
          // terminates the connection right after issuing a pairing code and
          // after a scan; an unregistered-with-code session also gets 401
          // 'Connection Failure' on reconnect until the phone completes the
          // pairing server-side). Each restart reuses the saved creds; the
          // pairing window bounds the total attempt.
          const isRestart = statusCode === 515 || /restart required/i.test(message);
          const isPostCredentialClose =
            credentialIssued && (statusCode === 428 || statusCode === 401 || /terminated|closed|failure/i.test(message));
          if (isRestart || isPostCredentialClose) {
            if (restarts >= MAX_PAIR_RESTARTS) {
              finish({
                ok: false,
                reason: `pairing stalled — WhatsApp keeps restarting the connection (${MAX_PAIR_RESTARTS}+ times); try again in a minute`,
              });
              return;
            }
            restarts += 1;
            // Detach from the dying socket BEFORE ending it so its own close
            // event can't race the restarted one, then swap in a fresh socket
            // that reuses the (now-populated) auth state.
            try {
              current.ev?.removeAllListeners?.('connection.update');
              current.ev?.removeAllListeners?.('creds.update');
              current.end?.('restart after pairing');
            } catch {
              /* best-effort */
            }
            current = makeSocket();
            current.ev?.on('connection.update', onConnectionUpdate);
            return;
          }
          if (!/loggedOut|timedOut/i.test(message)) {
            finish({ ok: false, reason: `pair failed: ${message}` });
          }
        };
        current.ev?.on('connection.update', onConnectionUpdate);

        if (phone) {
          void (async () => {
            // Wait for the WebSocket handshake BEFORE requesting the pairing
            // code: Baileys' sendRawMessage throws 'Connection Closed' when
            // the socket isn't open yet, so an immediate call races the
            // handshake and the request never reaches WhatsApp. Cap the wait
            // so a dead network can't hang the pairing window.
            await Promise.race([
              (current.waitForSocketOpen?.().then(() => true).catch(() => false)) ?? Promise.resolve(true),
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
            ]);
            void current
              .requestPairingCode?.(phone)
              .then((code) => {
                if (code) {
                  credentialIssued = true;
                  opts.onPairingCode?.(code);
                }
              })
              .catch(() => {
                /* best-effort — connection.update may still carry the code */
              });
          })();
        }
      });
    } catch (err) {
      this.pairing = false;
      return {
        ok: false,
        reason: `cannot load the Baileys bridge: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** Lazily create + wire the Baileys socket (idempotent). Never throws. */
  private async ensureSocket(): Promise<WASocketLike | null> {
    if (this.sock) return this.sock;
    try {
      const baileys = await loadBaileys();
      if (!baileys) return null;
      mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
      const { state, saveCreds } = await baileys.useMultiFileAuthState(this.sessionDir);
      const sock = baileys.makeWASocket({ auth: state, printQRInTerminal: false, logger: QUIET_LOGGER });
      sock.ev?.on('creds.update', () => void saveCreds());
      // DELIVERY VERIFICATION — WhatsApp reports the lifecycle of every
      // outbound message here (PENDING → SERVER_ACK → DELIVERY_ACK → READ, or
      // ERROR). Recording it is what lets a send be confirmed instead of
      // assumed, and gives the gateway logs a concrete failure reason.
      sock.ev?.on('messages.update', (...args: unknown[]) => {
        const updates = Array.isArray(args[0]) ? (args[0] as unknown[]) : [];
        for (const u of updates) {
          const entry = (u ?? {}) as { key?: { id?: unknown }; update?: { status?: unknown } };
          const id = entry.key?.id;
          const status = Number(entry.update?.status);
          if (typeof id === 'string' && id && Number.isFinite(status)) {
            this.recordMessageStatus(id, status);
          }
        }
      });
      // Learn OUR OWN LID→PN pair right away (self-chat inbound arrives as our
      // own LID jid; creds.me carries both ids on LID-mode accounts).
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const me = (state as any)?.creds?.me as { id?: string; lid?: string; phoneNumber?: string } | undefined;
        if (me?.id) {
          if (isLidJid(me.id) && me.phoneNumber) this.learnLidMapping(me.id, me.phoneNumber);
          else if (me.lid && !isLidJid(me.id)) this.learnLidMapping(me.lid, me.id);
        }
      } catch {
        /* best-effort */
      }
      // Privacy-rollout: Baileys learns LID→PN pairs (linked-profile
      // notifications, contactAction sync, pnForLidChatAction) and emits them
      // here — mirror them into our resolver so inbound senders match the
      // allow-list by phone number.
      sock.ev?.on('lid-mapping.update', (...args: unknown[]) => {
        const m = (args[0] ?? {}) as { lid?: string; pn?: string };
        if (typeof m.lid === 'string' && typeof m.pn === 'string') this.learnLidMapping(m.lid, m.pn);
      });
      // Self-healing: a socket that dies (e.g. Baileys 7's 515 "Stream Errored
      // (restart required)" close on an established session) is dropped so the
      // next send()/connect()/watchReconnect() recreates it from the persisted
      // session. A server-side logout (401/loggedOut/device_removed) is
      // terminal — it stops the auto-reconnect watcher (re-pair required).
      sock.ev?.on('connection.update', (...args: unknown[]) => {
        const u = (args[0] ?? {}) as ConnectionUpdateLike;
        if (u.connection !== 'close' || !u.lastDisconnect?.error || this.sock !== sock) return;
        this.sock = null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const err = u.lastDisconnect.error as any;
        const code = err?.output?.statusCode ?? err?.statusCode;
        const msg = err?.message || '';
        if (code === 401 || /logged\s?out|device_removed|conflict/i.test(msg)) {
          this.loggedOut = true;
        }
      });
      // I8b — contact learning: the address-book sync (contacts.upsert on
      // connect, contacts.update on edits) + every inbound pushName populate
      // the name → JID map used for `send("Alex", …)`.
      const learnContacts = (...args: unknown[]): void => {
        for (const c of (args[0] ?? []) as Array<Record<string, unknown>>) {
          const jid = typeof c?.id === 'string' ? c.id : '';
          if (!jid) continue;
          // Contact sync in LID mode carries the pair explicitly (id may be
          // the PN or the LID; lid/phoneNumber carry the other side).
          const lid = typeof c?.lid === 'string' ? c.lid : '';
          const phoneNumber = typeof c?.phoneNumber === 'string' ? c.phoneNumber : '';
          if (lid && phoneNumber) this.learnLidMapping(lid, phoneNumber);
          else if (lid && !isLidJid(jid) && !phoneNumber) this.learnLidMapping(lid, jid);
          else if (!lid && phoneNumber && isLidJid(jid)) this.learnLidMapping(jid, phoneNumber);
          for (const n of [c?.name, c?.notify, c?.verifiedName]) {
            if (typeof n === 'string' && n.trim()) this.learnContact(n.trim(), jid);
          }
        }
      };
      sock.ev?.on('contacts.upsert', learnContacts);
      sock.ev?.on('contacts.update', learnContacts);
      sock.ev?.on('contacts.set', learnContacts);
      sock.ev?.on('messages.upsert', (...args: unknown[]) => {
        const upsert = (args[0] ?? {}) as { type?: string; messages?: unknown[] };
        // 'notify' = a LIVE message. 'append' = the offline/history BACKFILL
        // Baileys replays on every (re)connect — the SAME messages, delivered
        // again and again. Observed live: one ask replayed as 20+ full turns
        // (and, when it routed to the pipeline, a 112s multi-agent run each
        // time), because every backfill entry was treated as brand new.
        // Only a RECENT backfill entry is worth acting on (the gateway was
        // briefly offline and the user has not seen an answer); older entries
        // were already handled or are stale, so replaying them only spams the
        // sender. The gateway's dedup ledger is the second line of defence.
        if (upsert.type !== 'notify' && upsert.type !== 'append') return;
        const isBackfill = upsert.type === 'append';
        for (const raw of upsert.messages ?? []) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const m = raw as any;
          if (isBackfill) {
            const sentAt = messageTimestampMs(m);
            // Unknown age → DO NOT process: an unfilterable replay is exactly
            // the failure this gate exists to stop.
            if (sentAt === null || Date.now() - sentAt > BACKFILL_MAX_AGE_MS) continue;
          }
          const rawFromJid = m?.key?.remoteJid as string | undefined;
          if (!rawFromJid) continue;
          const text = messageText(m);
          const media = mediaDescriptor(m);
          // A document/image has no `conversation`/`extendedTextMessage` — its
          // instruction is the caption. `if (!text)` used to drop every such
          // message silently, so the sender's own file vanished with no reply.
          if (!text && !media) continue;
          // Privacy-rollout: a DM's remoteJid may be the sender's random LID
          // ("123456789012345@lid") — translate it to the phone-number jid so
          // the policy gate's allow-list (digits) matches and replies route to
          // the right chat. Unknown LIDs pass through (mapping arrives via
          // lid-mapping.update shortly after).
          const fromJid = this.lidMapper.resolve(rawFromJid);
          // Learn the sender's profile name (contact resolution by name).
          if (typeof m?.pushName === 'string' && m.pushName.trim()) {
            this.learnContact(m.pushName.trim(), fromJid);
          }
          // I8b echo/self-message filter (recentlySentIds):
          //   - our OWN outbound sends echo back through upsert → drop.
          //   - other fromMe messages (the paired number typing) are only
          //     interesting in self-chat mode — the user messaging themselves.
          const fromMe = m?.key?.fromMe === true;
          if (fromMe) {
            const keyId = typeof m?.key?.id === 'string' ? m.key.id : '';
            if (keyId && this.recentlySent.has(keyId)) continue;
            if (!this.opts.selfChat) continue;
          }
          // P1 — real sender inside a group: `key.participant` (absent in
          // DMs). May also be a LID on privacy-rollout accounts — translate.
          // NOTE: Baileys 7 delivers DMs with `key.participant: ''` (EMPTY
          // string, not undefined) in some LID-mode sessions — an empty string
          // is NOT nullish, so `participant ?? fromJid` in the adapter would
          // blank the sender id and the policy gate would refuse everyone.
          // Treat '' as absent here.
          const rawParticipant =
            typeof m?.key?.participant === 'string' && m.key.participant.length > 0 ? m.key.participant : undefined;
          const participant = this.lidMapper.resolveOr(rawParticipant);
          const messageId = typeof m?.key?.id === 'string' && m.key.id ? m.key.id : undefined;
          if (media) {
            // Forward AFTER the bytes are in hand, so the turn always sees a
            // fully-hydrated attachment (never a dangling promise/partial file).
            // A failed download still forwards the caption-only text.
            void this.downloadInboundMedia(m, media)
              .then((downloaded) => this.onMessage?.(fromJid, text, participant, messageId, downloaded ?? undefined))
              .catch(() => this.onMessage?.(fromJid, text, participant, messageId));
          } else {
            this.onMessage?.(fromJid, text, participant, messageId);
          }
        }
      });
      this.sock = sock;
      // Barrier so the FIRST send() is reliable: Baileys connects in the
      // background; sendMessage before the WS handshake resolves would reject.
      // A stale/invalid session times out (10s) and send() fails gracefully
      // (the delivery ledger retries).
      if (this.paired) await this.waitForOpen(sock);
      return sock;
    } catch {
      return null;
    }
  }

  /** Resolve when the socket's connection opens (or after the timeout). */
  private waitForOpen(sock: WASocketLike, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      // settle() is only ever invoked asynchronously, so `timer` is assigned
      // before it can run (no TDZ issue).
      const timer = setTimeout(settle, timeoutMs);
      sock.ev?.on('connection.update', (...args: unknown[]) => {
        const u = (args[0] ?? {}) as ConnectionUpdateLike;
        if (u.connection === 'open') settle();
      });
    });
  }
}
