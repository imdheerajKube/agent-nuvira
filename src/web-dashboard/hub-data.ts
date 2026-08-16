/**
 * I4 — Agent Hub read aggregation (`src/web-dashboard/hub-data.ts`).
 *
 * Hermes WebUI parity (SkillsPage / McpPage / ToolsetConfigDrawer): one read
 * surface that aggregates the four hub tabs the dashboard renders —
 * **Tools** (I1 toolsets), **Channels** (I2 gateway delivery + aliases),
 * **Artifacts** (I3 per-session store), and **Skills** (compiled SkillStore +
 * hub-installed SKILL.md). Pure reads, never throws, honors BUFF_MEMORY_DIR /
 * BUFF_CONFIG_DIR so the panel and CLI always agree.
 *
 * The WRITE side (toolset toggles) stays in server.ts (admin-gated) and calls
 * `setToolsetEnabled` directly — this module is the read-only source of truth
 * the panel and the tests share.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getToolsetStatus } from '../tools/toolsets.js';
import { DeliveryLedger, type DeliveryEntry } from '../gateway/delivery.js';
import { InboxLedger, type InboxEntry } from '../gateway/inbox.js';
import type { HubChannelPolicy, HubInboxEntry } from './src/types.js';
import {
  ChannelDirectory,
  PLATFORM_ENV_VARS,
  PLATFORM_LABELS,
  isPlatformConfigured,
  type ChannelAlias,
  type Platform,
  type ReachableChannel,
} from '../gateway/channel-directory.js';
import { ArtifactStore } from '../tools/artifact-store.js';
import { getSkillStore } from '../learning/skill-store.js';
import { readDisabledSkills } from '../learning/hub-skill-catalog.js';
import { isAdminConfigured } from './src/admin-auth.js';
import { ConfigManager } from '../config/manager.js';
import { whatsappSessionDir } from '../gateway/whatsapp/session.js';
import { readContactsFile } from '../gateway/whatsapp/contacts.js';
import { readGatewayContacts } from '../gateway/contacts.js';

// ─── Types (the /api/hub contract — keep stable for the panel + tests) ──────

export interface HubToolset {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  tools: string[];
  toolCount: number;
}

export interface HubChannelAlias {
  alias: string;
  platform: string;
  channelId: string;
  addedAt?: number;
}

/** Platform adapter status (which transports are configured). */
export interface HubPlatformStatus {
  platform: string;
  label: string;
  configured: boolean;
  envVars: string[];
}

export interface HubDeliverySummary {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  /** Most recent entries (capped — the ledger itself caps at 500). */
  recent: Array<{
    id: string;
    target: string;
    platform: string;
    channelId: string;
    text: string;
    status: string;
    attempts: number;
    nextAttemptAt: number;
    createdAt: number;
    lastError?: string;
  }>;
}

export interface HubArtifactSummary {
  sessionId: string;
  count: number;
  latestAt: number;
  /** Most recent artifacts in the session (title/kind/preview only — small). */
  recent: Array<{ kind: string; title?: string; preview?: string }>;
}

export interface HubSkill {
  /** Compiled skills: the store id; hub skills: the directory name. */
  id: string;
  name: string;
  description: string;
  version?: string;
  /** 'compiled' (SkillStore) | 'hub' (SKILL.md installed in .agents/skills). */
  origin: 'compiled' | 'hub';
  usageCount?: number;
  /** P3 — derived from buffconfig `skills.disabled[]` (false when disabled). */
  enabled: boolean;
}

export interface HubSkillsData {
  compiled: HubSkill[];
  hub: HubSkill[];
  total: number;
  /** P3 — enabled/disabled counts (mirror the toolsets summary cards). */
  enabled: number;
  disabled: number;
}

export interface HubData {
  toolsets: {
    toolsets: HubToolset[];
    enabled: number;
    disabled: number;
    totalTools: number;
  };
  channels: {
    delivery: HubDeliverySummary;
    aliases: HubChannelAlias[];
    reachable: Array<{ platform: string; channelId: string; aliases: string[]; reachable: boolean }>;
    /** Every platform's transport status (I6 — Email/Signal included). */
    platforms: HubPlatformStatus[];
    /** P1 — effective per-platform inbound policies (who may trigger). */
    policies: Record<string, HubChannelPolicy>;
    /**
     * Saved verified contacts (name + contact no) across platforms — the
     * validated list the Permissions page edits. Names resolve the bare ids
     * in `policies.*.allowedUsers` to human labels.
     */
    contacts: Array<{ name: string; platform: string; id: string; addedAt?: number }>;
    /** Status recipients — always get pipeline completion summaries. */
    statusRecipients: string[];
    /**
     * Friendly display labels for status recipients: `whatsapp:Daddy` shows as
     * `whatsapp:Daddy → +918178504516` (resolved through the contacts file), a
     * bare number gets the country-code `+` — so a user never sees a raw alias
     * without knowing who/what it maps to.
     */
    statusRecipientDisplay: Record<string, string>;
    /** P2 — inbound inbox (who messaged the bot, what happened). */
    inbox: {
      total: number;
      pipeline: number;
      chat: number;
      help: number;
      refused: number;
      recent: HubInboxEntry[];
    };
  };
  artifacts: {
    totalSessions: number;
    totalArtifacts: number;
    sessions: HubArtifactSummary[];
  };
  skills: HubSkillsData;
  adminConfigured: boolean;
  serverTime: number;
}

// ─── Tools (I1 toolsets) ─────────────────────────────────────────────────────

function readToolsetsData(): HubData['toolsets'] {
  // getToolsetStatus() WITHOUT a ConfigManager never throws (absent state =
  // all enabled) — used as the fallback when the config file is unreadable
  // (EACCES/EISDIR), so the hub's never-throw contract holds even there.
  let toolsets: ReturnType<typeof getToolsetStatus>;
  try {
    toolsets = getToolsetStatus(new ConfigManager());
  } catch {
    toolsets = getToolsetStatus();
  }
  return {
    toolsets,
    enabled: toolsets.filter((t) => t.enabled).length,
    disabled: toolsets.filter((t) => !t.enabled).length,
    totalTools: toolsets.reduce((s, t) => s + t.toolCount, 0),
  };
}

// ─── Channels (I2 gateway) ───────────────────────────────────────────────────

function readChannelsData(): HubData['channels'] {
  const platforms: HubPlatformStatus[] = (Object.keys(PLATFORM_ENV_VARS) as Platform[])
    .filter((p) => p !== 'mock')
    .map((p) => ({
      platform: p,
      label: PLATFORM_LABELS[p],
      configured: isPlatformConfigured(p),
      envVars: [...PLATFORM_ENV_VARS[p]],
    }));
  const ledger = new DeliveryLedger().read();
  const recent = ledger.slice(0, 20).map((e: DeliveryEntry) => ({
    id: e.id,
    target: e.target,
    platform: e.platform,
    channelId: e.channelId,
    text: e.text,
    status: e.status,
    attempts: e.attempts,
    nextAttemptAt: e.nextAttemptAt,
    createdAt: e.createdAt,
    lastError: e.lastError,
  }));
  const inboxEntries = new InboxLedger().read();
  const inboxRecent = inboxEntries.slice(0, 20).map((e: InboxEntry) => ({
    id: e.id,
    platform: e.platform,
    channelId: e.channelId,
    text: e.text,
    from: e.from,
    senderId: e.senderId,
    isGroup: Boolean(e.isGroup),
    handled: e.handled,
    reply: e.reply,
    at: e.at,
  }));
  const dir = new ChannelDirectory();
  let reachable: ReachableChannel[] = [];
  try {
    reachable = dir.reachableChannels();
  } catch {
    reachable = [];
  }
  return {
    delivery: {
      total: ledger.length,
      pending: ledger.filter((e) => e.status === 'pending').length,
      sent: ledger.filter((e) => e.status === 'sent').length,
      failed: ledger.filter((e) => e.status === 'failed').length,
      recent,
    },
    aliases: dir.listAliases().map((a: ChannelAlias) => ({
      alias: a.alias,
      platform: a.platform,
      channelId: a.channelId,
      addedAt: a.addedAt,
    })),
    reachable: reachable.map((r) => ({
      platform: r.platform,
      channelId: r.channelId,
      aliases: r.aliases,
      reachable: r.reachable,
    })),
    platforms,
    // Effective per-platform policies (env < config — the same merge the
    // running gateway applies; the dashboard also edits via PUT
    // /api/admin/gateway/policies).
    policies: readPoliciesData(),
    // Saved verified contacts (name + contact no) — the validated list.
    contacts: readGatewayContacts().map((c) => ({
      name: c.name,
      platform: c.platform,
      id: c.id,
      addedAt: c.addedAt,
    })),
    statusRecipients: (() => {
      const cfg = new ConfigManager().getAll() as { gateway?: { statusRecipients?: string[] } };
      return cfg.gateway?.statusRecipients ?? [];
    })(),
    statusRecipientDisplay: (() => {
      const cfg = new ConfigManager().getAll() as { gateway?: { statusRecipients?: string[] } };
      const targets = cfg.gateway?.statusRecipients ?? [];
      if (targets.length === 0) return {};
      const display: Record<string, string> = {};
      // WhatsApp names resolve through the user's contacts file (name → digits);
      // numbers get the country-code '+' for readability. Other platforms stay
      // as-is. Never throws — resolution is best-effort.
      try {
        const contacts = readContactsFile(whatsappSessionDir());
        for (const t of targets) {
          const m = /^whatsapp:(.+)$/i.exec(t);
          if (!m) continue;
          const who = m[1].trim();
          if (!who) continue;
          const digitsOnly = /^\+?\d[\d\s-]*$/.test(who);
          if (digitsOnly) {
            display[t] = `whatsapp:+${who.replace(/\D+/g, '')}`;
          } else {
            const hit = contacts[who] ?? Object.entries(contacts).find(([k]) => k.toLowerCase() === who.toLowerCase())?.[1];
            display[t] = hit ? `whatsapp:${who} → +${hit}` : t;
          }
        }
      } catch {
        // best-effort — fall back to the raw target
      }
      return display;
    })(),
    inbox: {
      total: inboxEntries.length,
      pipeline: inboxEntries.filter((e) => e.handled === 'pipeline').length,
      chat: inboxEntries.filter((e) => e.handled === 'chat').length,
      help: inboxEntries.filter((e) => e.handled === 'help').length,
      refused: inboxEntries.filter((e) => e.handled === 'refused').length,
      recent: inboxRecent,
    },
  };
}

/** Effective per-platform gateway policies (env < config, no network). */
function readPoliciesData(): Record<string, HubChannelPolicy> {
  const out: Record<string, HubChannelPolicy> = {};
  for (const p of Object.keys(PLATFORM_ENV_VARS) as Platform[]) {
    if (p === 'mock') continue;
    const cfg = new ConfigManager().getAll() as { gateway?: { policies?: Partial<Record<Platform, HubChannelPolicy>> } };
    const fromConfig = cfg.gateway?.policies?.[p] ?? {};
    out[p] = { ...fromConfig };
  }
  return out;
}

// ─── Artifacts (I3 store) ───────────────────────────────────────────────────

function readArtifactsData(): HubData['artifacts'] {
  const store = new ArtifactStore();
  const sessions = store.listSessions().map((s) => ({
    sessionId: s.sessionId,
    count: s.count,
    latestAt: s.latestAt,
    recent: store
      .read(s.sessionId)
      .slice(0, 5)
      .map((a) => ({
        kind: a.kind,
        title: a.title,
        preview: a.preview ? a.preview.slice(0, 160) : undefined,
      })),
  }));
  return {
    totalSessions: sessions.length,
    totalArtifacts: sessions.reduce((s, x) => s + x.count, 0),
    sessions,
  };
}

// ─── Skills (compiled SkillStore + hub SKILL.md) ────────────────────────────

/** Parse the name/description out of a SKILL.md frontmatter block (YAML-lite). */
export function parseSkillFrontmatter(markdown: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z0-9_.-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { name: out.name, description: out.description };
}

/** Scan a skills root for `<name>/SKILL.md` directories. Best-effort. */
export function scanHubSkills(root: string): HubSkill[] {
  try {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d): HubSkill | null => {
        const skillPath = join(root, d.name, 'SKILL.md');
        if (!existsSync(skillPath)) return null;
        try {
          const fm = parseSkillFrontmatter(readFileSync(skillPath, 'utf-8'));
          return {
            id: d.name,
            name: fm.name || d.name,
            description: fm.description || 'No description in SKILL.md frontmatter.',
            origin: 'hub' as const,
            // Raw scan result — the enabled flag is applied by readSkillsData
            // against the live config (a disabled skill is still listed).
            enabled: true,
          };
        } catch {
          return null;
        }
      })
      .filter((s): s is HubSkill => s !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function readSkillsData(): HubSkillsData {
  let compiled: HubSkill[] = [];
  try {
    compiled = getSkillStore()
      .getAll()
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        version: s.version,
        origin: 'compiled' as const,
        usageCount: s.usageCount,
        enabled: true,
      }));
  } catch {
    compiled = [];
  }
  const hub = [
    ...scanHubSkills(join(process.cwd(), '.agents', 'skills')),
    ...scanHubSkills(join(homedir(), '.buff', 'skills')),
  ];
  // Dedupe by id — the user root wins over the project root when both exist.
  const seen = new Set<string>();
  const deduped = hub.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  // P3 — the I7 skills.disabled[] list (the SAME config the CLI + Agent Hub
  // toggle write) drives the per-skill flag + counts, so the hub reflects the
  // runtime match gate exactly. readDisabledSkills is best-effort: an
  // unreadable config simply means everything is enabled.
  const disabled = new Set(readDisabledSkills(new ConfigManager()));
  const mark = (s: HubSkill): HubSkill => ({ ...s, enabled: !disabled.has(s.id) });
  const compiledMarked = compiled.map(mark);
  const hubMarked = deduped.map(mark);
  const total = compiled.length + deduped.length;
  const disabledCount = [...compiledMarked, ...hubMarked].filter((s) => !s.enabled).length;
  return {
    compiled: compiledMarked,
    hub: hubMarked,
    total,
    enabled: total - disabledCount,
    disabled: disabledCount,
  };
}

// ─── Aggregate (the /api/hub payload) ───────────────────────────────────────

/** The full Agent Hub read payload. Never throws. */
export function readHubData(): HubData {
  return {
    toolsets: readToolsetsData(),
    channels: readChannelsData(),
    artifacts: readArtifactsData(),
    skills: readSkillsData(),
    adminConfigured: isAdminConfigured(),
    serverTime: Date.now(),
  };
}
