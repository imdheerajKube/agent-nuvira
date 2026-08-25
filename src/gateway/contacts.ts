/**
 * Verified contacts (`src/gateway/contacts.ts`) — the cross-platform "name +
 * contact no" store behind the dashboard Permissions page and the verified
 * list.
 *
 * The verified list per platform (`gateway.policies.<platform>.allowedUsers`)
 * holds RAW sender ids — the exact strings the policy gate compares against.
 * This module stores the optional display NAME for each verified contact
 * (CLI parity: `nuvira whatsapp contact add <Name> <number>`), so the dashboard
 * can add a person as **Name + Contact No** and later show what contacts are
 * saved. It is metadata only — the gate never reads it, and removing a
 * contact here never widens access.
 *
 * Contact statuses:
 *  - `approved`  — outbound messages allowed (gateway_send resolves this name)
 *  - `pending`   — auto-registered from first inbound message, awaiting admin review
 *  - `rejected`  — admin rejected; name resolves but send is blocked
 *
 * Stored at `~/.nuvira/gateway/contacts.json` (NUVIRA_CONFIG_DIR honored, next to
 * aliases.json / inbox.json / delivery.json). Works for every platform: a
 * WhatsApp phone number, a Telegram user id, an email address, a group jid —
 * whatever the platform's allowedUsers entries use.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveBuffConfigDir } from '../config/paths.js';
import type { Platform } from './channel-directory.js';
import { whatsappSessionDir } from './whatsapp/session.js';
import { readContactsFile, writeContactsFile } from './whatsapp/contacts.js';

/** One saved verified contact: a display name mapped to a platform sender id. */
export interface GatewayContact {
  /** Display name (CLI `<Name>`), e.g. "Alex". */
  name: string;
  /** The platform the id belongs to (whatsapp / telegram / email / …). */
  platform: Platform;
  /** Contact number / sender id (CLI `<Contact No>`), e.g. "+919876543210". */
  id: string;
  /** Optional phone number (for cross-platform lookup and display). */
  phone?: string;
  /** Registration status — approved contacts can be sent TO via gateway_send. */
  status: ContactStatus;
  /** When the user first messaged the bot (epoch ms). 0 = pre-registration. */
  registeredAt: number;
  /** When the contact was added / last modified (epoch ms). */
  addedAt: number;
}

/** Contact registration status. */
export type ContactStatus = 'approved' | 'pending' | 'rejected';

/** The contacts file path (NUVIRA_CONFIG_DIR honored — same dir as aliases.json). */
export function gatewayContactsFile(): string {
  return join(resolveBuffConfigDir(), 'gateway', 'contacts.json');
}

/** Read saved contacts (missing/corrupt file → [] — never throws). */
export function readGatewayContacts(): GatewayContact[] {
  try {
    const raw = readFileSync(gatewayContactsFile(), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: number; contacts?: unknown };
    if (!Array.isArray(parsed.contacts)) return [];
    return (parsed.contacts as GatewayContact[]).filter(
      (c) =>
        c && typeof c === 'object' &&
        typeof c.name === 'string' && c.name.trim() &&
        typeof c.platform === 'string' && c.platform &&
        typeof c.id === 'string' && c.id.trim(),
    ).map((c) => ({
      name: c.name.trim(),
      platform: c.platform as Platform,
      id: c.id.trim(),
      phone: typeof c.phone === 'string' && c.phone.trim() ? c.phone.trim() : undefined,
      status: isValidContactStatus(c.status) ? c.status : 'approved',
      registeredAt: typeof c.registeredAt === 'number' ? c.registeredAt : 0,
      addedAt: typeof c.addedAt === 'number' ? c.addedAt : Date.now(),
    }));
  } catch {
    return [];
  }
}

function isValidContactStatus(v: unknown): v is ContactStatus {
  return v === 'approved' || v === 'pending' || v === 'rejected';
}

/** Persist contacts (small file — single write; never throws). */
export function writeGatewayContacts(contacts: GatewayContact[]): void {
  try {
    const file = gatewayContactsFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, contacts }, null, 2), 'utf-8');
  } catch {
    /* best-effort — a failed write must never break the API call that saved policies */
  }
}

/** Whitespace-stripped id, kept case-sensitive (email ids, jids). */
export function normalizeContactId(id: string): string {
  return (id || '').trim().replace(/\s+/g, '');
}

/**
 * True when two sender ids refer to the same contact: exact match, or a
 * phone-style match where both sides reduce to the same digits
 * (`+919876543210` vs `919876543210` vs `91-9876-543210`).
 */
export function sameContactId(a: string, b: string): boolean {
  const na = normalizeContactId(a);
  const nb = normalizeContactId(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const da = na.replace(/\D+/g, '');
  const db = nb.replace(/\D+/g, '');
  return da.length > 0 && da === db;
}

/** Same contact NAME on a platform (case-insensitive, trimmed). */
export function sameContactName(a: string, b: string): boolean {
  return normalizeContactId(a).toLowerCase() === normalizeContactId(b).toLowerCase();
}

/**
 * Validate a contact ID for a given platform. Returns an error message if
 * invalid, or null if valid. Telegram requires a numeric chat ID (not a
 * phone number) — the ID is assigned by Telegram when a user first messages
 * the bot.
 */
export function validateContactId(platform: Platform, id: string): string | null {
  const trimmed = (id || '').trim();
  if (!trimmed) return 'Contact ID is required.';
  if (platform === 'telegram') {
    // Telegram chat IDs are numeric (positive for DMs, negative for groups)
    if (!/^-?\d+$/.test(trimmed)) {
      return 'Telegram contact ID must be a numeric chat ID (e.g. 5123456789), not a phone number. Message the bot first to get the chat ID.';
    }
  }
  return null;
}

/** Normalize a phone number to digits-only for flexible comparison.
 * Handles: +918800604222, 918800604222, 08800604222, 8800604222, 8800604222
 * Strips non-digit characters, leading 0, and country codes until 10 digits. */
export function normalizePhone(phone: string): string {
  let digits = (phone || '').replace(/\D+/g, '');
  // Strip leading 0 (local format: 08800604222 → 8800604222)
  if (digits.startsWith('0') && digits.length > 10) digits = digits.slice(1);
  // Strip country codes until we reach a 10-digit local number
  // (e.g. 918800604222 → 8800604222, 15551234567 stays as-is)
  while (digits.length > 10 && !digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  return digits;
}

/** True when two phone numbers refer to the same person (digits-only comparison). */
export function samePhone(a: string, b: string): boolean {
  const da = normalizePhone(a);
  const db = normalizePhone(b);
  return da.length > 0 && da === db;
}

/**
 * Add or update a contact. An existing contact with the same (platform, id) —
 * or the same (platform, name) — is replaced in place. Returns the saved
 * contact and whether it was a new entry.
 */
export function upsertGatewayContact(
  contact: Omit<GatewayContact, 'addedAt'> & { addedAt?: number },
): { contact: GatewayContact; added: boolean } {
  const name = (contact.name || '').trim();
  const id = (contact.id || '').trim();
  const platform = contact.platform as Platform;
  const entry: GatewayContact = {
    name, platform, id,
    phone: contact.phone?.trim() || undefined,
    status: contact.status ?? 'approved',
    registeredAt: contact.registeredAt ?? 0,
    addedAt: contact.addedAt ?? Date.now(),
  };
  const current = readGatewayContacts();
  const rest = current.filter(
    (c) =>
      c.platform !== platform ||
      (!sameContactId(c.id, id) && !sameContactName(c.name, name)),
  );
  const added = rest.length === current.length;
  writeGatewayContacts([...rest, entry]);
  return { contact: entry, added };
}

/**
 * Remove a contact by platform + id OR by platform + name. Returns true when
 * an entry was removed.
 */
export function removeGatewayContact(platform: Platform, idOrName: string): boolean {
  const target = normalizeContactId(idOrName);
  const current = readGatewayContacts();
  const next = current.filter(
    (c) => !(c.platform === platform && (sameContactId(c.id, target) || sameContactName(c.name, target))),
  );
  if (next.length === current.length) return false;
  writeGatewayContacts(next);
  return true;
}

/**
 * Resolve a saved contact's display name for a (platform, id) pair — used by
 * the dashboard so a verified list chip renders `Alex (+919876543210)`
 * instead of a bare number. Returns undefined when the id has no saved name.
 */
export function contactNameFor(contacts: GatewayContact[], platform: Platform, id: string): string | undefined {
  const hit = contacts.find((c) => c.platform === platform && sameContactId(c.id, id));
  return hit?.name;
}

/**
 * Resolve a target string to a contact on a platform. Matches by:
 *  1. Exact name (case-insensitive)
 *  2. Phone number (flexible: +91..., 0..., digits-only)
 *  3. Platform ID (exact)
 * Returns the matching contact, or undefined.
 */
export function resolveContact(
  contacts: GatewayContact[],
  platform: Platform,
  target: string,
): GatewayContact | undefined {
  const t = (target || '').trim();
  if (!t) return undefined;
  const platformContacts = contacts.filter((c) => c.platform === platform);
  // 1. Exact name match (case-insensitive)
  const byName = platformContacts.find((c) => sameContactName(c.name, t));
  if (byName) return byName;
  // 2. Phone number match (flexible)
  if (/^\+?\d/.test(t)) {
    const byPhone = platformContacts.find((c) => c.phone && samePhone(c.phone, t));
    if (byPhone) return byPhone;
  }
  // 3. Platform ID match
  const byId = platformContacts.find((c) => sameContactId(c.id, t));
  if (byId) return byId;
  return undefined;
}

/**
 * Set a contact's approval status. Returns true when the contact was found
 * and updated.
 */
export function setContactStatus(
  platform: Platform,
  nameOrId: string,
  status: ContactStatus,
): boolean {
  const contacts = readGatewayContacts();
  const target = contacts.find(
    (c) => c.platform === platform &&
      (sameContactName(c.name, nameOrId) || sameContactId(c.id, nameOrId)),
  );
  if (!target) return false;
  target.status = status;
  target.addedAt = Date.now();
  writeGatewayContacts(contacts);
  return true;
}

/**
 * Remove a contact by name or ID across all platforms. Returns true when
 * an entry was removed.
 */
export function removeContactByNameOrId(nameOrId: string): boolean {
  const target = normalizeContactId(nameOrId);
  const current = readGatewayContacts();
  const next = current.filter(
    (c) => !(sameContactName(c.name, target) || sameContactId(c.id, target)),
  );
  if (next.length === current.length) return false;
  writeGatewayContacts(next);
  return true;
}

/**
 * Sync a named WhatsApp contact into the bridge's contacts file — the exact
 * file `nuvira whatsapp contact add <Name> <number>` writes — so a contact added
 * from the dashboard is also sendable by name (`nuvira gateway send
 * whatsapp:<Name> "…"`). Best-effort, never throws; numbers are stored as
 * E.164 digits without the '+' like the CLI does.
 */
export function syncWhatsAppContactName(name: string, id: string): void {
  try {
    const digits = (id || '').replace(/\D+/g, '');
    const cleanName = (name || '').trim();
    if (!cleanName || !digits) return;
    const contacts = readContactsFile(whatsappSessionDir());
    contacts[cleanName] = digits;
    writeContactsFile(whatsappSessionDir(), contacts);
  } catch {
    /* best-effort — never break the policies save */
  }
}
