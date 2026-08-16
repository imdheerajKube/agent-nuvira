/**
 * Verified-contacts store (`src/gateway/contacts.ts`) — the cross-platform
 * "name + contact no" list behind the dashboard Permissions page.
 *
 * Hermetic: a temp BUFF_CONFIG_DIR for the contacts file and a temp
 * BUFF_WHATSAPP_SESSION_DIR for the bridge sync test. No network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';

const ORIG_CONFIG_DIR = process.env.BUFF_CONFIG_DIR;
const ORIG_WA_DIR = process.env.BUFF_WHATSAPP_SESSION_DIR;
let cfgDir: string;
let waDir: string;

beforeEach(() => {
  cfgDir = mkdtempSync(join(TMP_BASE, 'buff-contacts-cfg-'));
  waDir = mkdtempSync(join(TMP_BASE, 'buff-contacts-wa-'));
  process.env.BUFF_CONFIG_DIR = cfgDir;
  process.env.BUFF_WHATSAPP_SESSION_DIR = waDir;
});

afterEach(() => {
  if (ORIG_CONFIG_DIR === undefined) delete process.env.BUFF_CONFIG_DIR;
  else process.env.BUFF_CONFIG_DIR = ORIG_CONFIG_DIR;
  if (ORIG_WA_DIR === undefined) delete process.env.BUFF_WHATSAPP_SESSION_DIR;
  else process.env.BUFF_WHATSAPP_SESSION_DIR = ORIG_WA_DIR;
  try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { rmSync(waDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('gateway contacts store', () => {
  it('starts empty and round-trips a contact (name + contact no)', async () => {
    const { readGatewayContacts, writeGatewayContacts, gatewayContactsFile } = await import('../../src/gateway/contacts.js');
    expect(readGatewayContacts()).toEqual([]);

    writeGatewayContacts([{ name: 'Alex', platform: 'whatsapp', id: '+919876543210', addedAt: 1 }]);
    const saved = readGatewayContacts();
    expect(saved).toEqual([{ name: 'Alex', platform: 'whatsapp', id: '+919876543210', addedAt: 1 }]);
    // Persisted next to the other gateway state, honoring BUFF_CONFIG_DIR.
    expect(existsSync(gatewayContactsFile())).toBe(true);
    const raw = JSON.parse(readFileSync(gatewayContactsFile(), 'utf-8'));
    expect(raw.contacts).toHaveLength(1);
  });

  it('upsert replaces by (platform, id) — including phone-format-tolerant matches', async () => {
    const { upsertGatewayContact, readGatewayContacts } = await import('../../src/gateway/contacts.js');
    upsertGatewayContact({ name: 'Alex', platform: 'whatsapp', id: '+919876543210' });
    // Same number, different formatting + new name → replaces, not duplicates.
    const { contact, added } = upsertGatewayContact({ name: 'Dad', platform: 'whatsapp', id: '919876543210' });
    expect(added).toBe(false);
    expect(contact.name).toBe('Dad');
    const saved = readGatewayContacts();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'Dad', id: '919876543210' });
  });

  it('upsert replaces by (platform, name) — rename keeps one entry', async () => {
    const { upsertGatewayContact, readGatewayContacts } = await import('../../src/gateway/contacts.js');
    upsertGatewayContact({ name: 'Sam', platform: 'whatsapp', id: '+919999999999' });
    upsertGatewayContact({ name: 'Sam', platform: 'whatsapp', id: '+919811112222' });
    const saved = readGatewayContacts();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'Sam', id: '+919811112222' });
  });

  it('keeps the same contact on DIFFERENT platforms separate', async () => {
    const { upsertGatewayContact, readGatewayContacts } = await import('../../src/gateway/contacts.js');
    upsertGatewayContact({ name: 'Alex', platform: 'whatsapp', id: '+919876543210' });
    upsertGatewayContact({ name: 'Alex', platform: 'telegram', id: '123456789' });
    const saved = readGatewayContacts();
    expect(saved).toHaveLength(2);
  });

  it('removeGatewayContact works by id and by name', async () => {
    const { upsertGatewayContact, removeGatewayContact, readGatewayContacts } = await import('../../src/gateway/contacts.js');
    upsertGatewayContact({ name: 'Alex', platform: 'whatsapp', id: '+919876543210' });
    upsertGatewayContact({ name: 'Sam', platform: 'whatsapp', id: '+919999999999' });

    expect(removeGatewayContact('whatsapp', '919876543210')).toBe(true); // id, format-tolerant
    expect(readGatewayContacts().map((c) => c.name)).toEqual(['Sam']);
    expect(removeGatewayContact('whatsapp', 'SAM')).toBe(true); // by name, case-insensitive
    expect(readGatewayContacts()).toEqual([]);
    expect(removeGatewayContact('whatsapp', 'nobody')).toBe(false);
  });

  it('contactNameFor resolves a display name (format-tolerant)', async () => {
    const { upsertGatewayContact, contactNameFor, readGatewayContacts } = await import('../../src/gateway/contacts.js');
    upsertGatewayContact({ name: 'Alex', platform: 'whatsapp', id: '+919876543210' });
    const contacts = readGatewayContacts();
    expect(contactNameFor(contacts, 'whatsapp', '919876543210')).toBe('Alex');
    expect(contactNameFor(contacts, 'whatsapp', '+919876543210')).toBe('Alex');
    expect(contactNameFor(contacts, 'whatsapp', '+919999999999')).toBeUndefined();
    expect(contactNameFor(contacts, 'telegram', '+919876543210')).toBeUndefined();
  });

  it('reads a corrupt/missing file as empty (never throws)', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const { gatewayContactsFile, readGatewayContacts } = await import('../../src/gateway/contacts.js');
    mkdirSync(dirname(gatewayContactsFile()), { recursive: true });
    writeFileSync(gatewayContactsFile(), '{broken json', 'utf-8');
    expect(readGatewayContacts()).toEqual([]);
  });

  it('syncs a named WhatsApp contact into the bridge contacts file (CLI parity)', async () => {
    const { syncWhatsAppContactName } = await import('../../src/gateway/contacts.js');
    const { readContactsFile } = await import('../../src/gateway/whatsapp/contacts.js');
    syncWhatsAppContactName('Alex', '+919876543210');
    // Stored as E.164 digits without '+', exactly like `buff whatsapp contact add`.
    expect(readContactsFile(waDir)).toEqual({ Alex: '919876543210' });
    // A nameless or number-less sync is a no-op.
    syncWhatsAppContactName('', '919876543210');
    syncWhatsAppContactName('X', '');
    expect(readContactsFile(waDir)).toEqual({ Alex: '919876543210' });
  });
});
