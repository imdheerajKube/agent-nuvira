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
import type { Platform } from './channel-directory.js';
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
export declare function gatewayContactsFile(): string;
/** Read saved contacts (missing/corrupt file → [] — never throws). */
export declare function readGatewayContacts(): GatewayContact[];
/** Persist contacts (small file — single write; never throws). */
export declare function writeGatewayContacts(contacts: GatewayContact[]): void;
/** Whitespace-stripped id, kept case-sensitive (email ids, jids). */
export declare function normalizeContactId(id: string): string;
/**
 * True when two sender ids refer to the same contact: exact match, or a
 * phone-style match where both sides reduce to the same digits
 * (`+919876543210` vs `919876543210` vs `91-9876-543210`).
 */
export declare function sameContactId(a: string, b: string): boolean;
/** Same contact NAME on a platform (case-insensitive, trimmed). */
export declare function sameContactName(a: string, b: string): boolean;
/**
 * Validate a contact ID for a given platform. Returns an error message if
 * invalid, or null if valid. Telegram requires a numeric chat ID (not a
 * phone number) — the ID is assigned by Telegram when a user first messages
 * the bot.
 */
export declare function validateContactId(platform: Platform, id: string): string | null;
/** Normalize a phone number to digits-only for flexible comparison.
 * Handles: +918800604222, 918800604222, 08800604222, 8800604222, 8800604222
 * Strips non-digit characters, leading 0, and country codes until 10 digits. */
export declare function normalizePhone(phone: string): string;
/** True when two phone numbers refer to the same person (digits-only comparison). */
export declare function samePhone(a: string, b: string): boolean;
/**
 * Add or update a contact. An existing contact with the same (platform, id) —
 * or the same (platform, name) — is replaced in place. Returns the saved
 * contact and whether it was a new entry.
 */
export declare function upsertGatewayContact(contact: Omit<GatewayContact, 'addedAt'> & {
    addedAt?: number;
}): {
    contact: GatewayContact;
    added: boolean;
};
/**
 * Remove a contact by platform + id OR by platform + name. Returns true when
 * an entry was removed.
 */
export declare function removeGatewayContact(platform: Platform, idOrName: string): boolean;
/**
 * Resolve a saved contact's display name for a (platform, id) pair — used by
 * the dashboard so a verified list chip renders `Alex (+919876543210)`
 * instead of a bare number. Returns undefined when the id has no saved name.
 */
export declare function contactNameFor(contacts: GatewayContact[], platform: Platform, id: string): string | undefined;
/**
 * Resolve a target string to a contact on a platform. Matches by:
 *  1. Exact name (case-insensitive)
 *  2. Phone number (flexible: +91..., 0..., digits-only)
 *  3. Platform ID (exact)
 * Returns the matching contact, or undefined.
 */
export declare function resolveContact(contacts: GatewayContact[], platform: Platform, target: string): GatewayContact | undefined;
/**
 * Set a contact's approval status. Returns true when the contact was found
 * and updated.
 */
export declare function setContactStatus(platform: Platform, nameOrId: string, status: ContactStatus): boolean;
/**
 * Remove a contact by name or ID across all platforms. Returns true when
 * an entry was removed.
 */
export declare function removeContactByNameOrId(nameOrId: string): boolean;
/**
 * Sync a named WhatsApp contact into the bridge's contacts file — the exact
 * file `nuvira whatsapp contact add <Name> <number>` writes — so a contact added
 * from the dashboard is also sendable by name (`nuvira gateway send
 * whatsapp:<Name> "…"`). Best-effort, never throws; numbers are stored as
 * E.164 digits without the '+' like the CLI does.
 */
export declare function syncWhatsAppContactName(name: string, id: string): void;
//# sourceMappingURL=contacts.d.ts.map