/**
 * Verified contacts (`src/gateway/contacts.ts`) — the cross-platform "name +
 * contact no" store behind the dashboard Permissions page and the verified
 * list.
 *
 * The verified list per platform (`gateway.policies.<platform>.allowedUsers`)
 * holds RAW sender ids — the exact strings the policy gate compares against.
 * This module stores the optional display NAME for each verified contact
 * (CLI parity: `buff whatsapp contact add <Name> <number>`), so the dashboard
 * can add a person as **Name + Contact No** and later show what contacts are
 * saved. It is metadata only — the gate never reads it, and removing a
 * contact here never widens access.
 *
 * Stored at `~/.buff/gateway/contacts.json` (BUFF_CONFIG_DIR honored, next to
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
  /** Display name (CLI `<Name>`), e.g. "Daddy". */
  name: string;
  /** The platform the id belongs to (whatsapp / telegram / email / …). */
  platform: Platform;
  /** Contact number / sender id (CLI `<Contact No>`), e.g. "+918178504516". */
  id: string;
  /** When the contact was added (epoch ms). */
  addedAt: number;
}

/** The contacts file path (BUFF_CONFIG_DIR honored — same dir as aliases.json). */
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
      addedAt: typeof c.addedAt === 'number' ? c.addedAt : Date.now(),
    }));
  } catch {
    return [];
  }
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
 * (`+918178504516` vs `918178504516` vs `91-8178-504516`).
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
  const entry: GatewayContact = { name, platform, id, addedAt: contact.addedAt ?? Date.now() };
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
 * the dashboard so a verified list chip renders `Daddy (+918178504516)`
 * instead of a bare number. Returns undefined when the id has no saved name.
 */
export function contactNameFor(contacts: GatewayContact[], platform: Platform, id: string): string | undefined {
  const hit = contacts.find((c) => c.platform === platform && sameContactId(c.id, id));
  return hit?.name;
}

/**
 * Sync a named WhatsApp contact into the bridge's contacts file — the exact
 * file `buff whatsapp contact add <Name> <number>` writes — so a contact added
 * from the dashboard is also sendable by name (`buff gateway send
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
