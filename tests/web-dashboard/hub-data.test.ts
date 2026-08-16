/**
 * I4 — Agent Hub read aggregation tests (`tests/web-dashboard/hub-data.test.ts`).
 *
 * Covers the pure module that backs the dashboard's Skills/Tools/Channels/
 * Artifacts tabs: frontmatter parsing, hub-skill scanning, and the aggregate
 * `readHubData()` payload — hermetic via BUFF_CONFIG_DIR / BUFF_MEMORY_DIR
 * temp dirs + a temp cwd for `.agents/skills` scanning.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSkillFrontmatter, scanHubSkills, readHubData } from '../../src/web-dashboard/hub-data.js';
import { setToolsetEnabled } from '../../src/tools/toolsets.js';
import { setSkillEnabled } from '../../src/learning/hub-skill-catalog.js';
import { ConfigManager } from '../../src/config/manager.js';
import { DeliveryLedger } from '../../src/gateway/delivery.js';
import { ChannelDirectory } from '../../src/gateway/channel-directory.js';
import { writeAdminUser } from '../../src/web-dashboard/src/admin-auth.js';
import { resetSkillStore } from '../../src/learning/skill-store.js';

let cfgDir: string;
let memDir: string;
let cwdDir: string;
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'buff-hub-cfg-'));
  memDir = mkdtempSync(join(tmpdir(), 'buff-hub-mem-'));
  cwdDir = mkdtempSync(join(tmpdir(), 'buff-hub-cwd-'));
  envBackup.BUFF_CONFIG_DIR = process.env.BUFF_CONFIG_DIR;
  envBackup.BUFF_MEMORY_DIR = process.env.BUFF_MEMORY_DIR;
  process.env.BUFF_CONFIG_DIR = cfgDir;
  process.env.BUFF_MEMORY_DIR = memDir;
  process.chdir(cwdDir);
});

afterEach(() => {
  // The SkillStore singleton is homedir-backed (~/.buff/skills) — reset it so
  // no seeded-bundled-skill state leaks between tests in this worker.
  resetSkillStore();
  process.chdir(tmpdir());
  if (envBackup.BUFF_CONFIG_DIR === undefined) delete process.env.BUFF_CONFIG_DIR;
  else process.env.BUFF_CONFIG_DIR = envBackup.BUFF_CONFIG_DIR;
  if (envBackup.BUFF_MEMORY_DIR === undefined) delete process.env.BUFF_MEMORY_DIR;
  else process.env.BUFF_MEMORY_DIR = envBackup.BUFF_MEMORY_DIR;
  for (const d of [cfgDir, memDir, cwdDir]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ─── Frontmatter parser ─────────────────────────────────────────────────────

describe('parseSkillFrontmatter', () => {
  it('parses name + description out of a standard frontmatter block', () => {
    const md = [
      '---',
      'name: deploy-site',
      'description: "Deploy a static site to Cloudflare Pages"',
      'version: 1.2.0',
      'license: MIT',
      '---',
      '# Deploy Site',
      'Run the publish flow.',
    ].join('\n');
    expect(parseSkillFrontmatter(md)).toEqual({
      name: 'deploy-site',
      description: 'Deploy a static site to Cloudflare Pages',
    });
  });

  it('tolerates CRLF line endings', () => {
    const md = '---\r\nname: demo\r\ndescription: A demo skill\r\n---\r\nbody';
    expect(parseSkillFrontmatter(md).name).toBe('demo');
  });

  it('returns {} when there is no frontmatter block', () => {
    expect(parseSkillFrontmatter('# Just a heading')).toEqual({});
  });

  it('ignores nested/unknown keys and single-quoted values', () => {
    const md = [
      '---',
      'name: fix-lint',
      "description: 'Fix lint errors'",
      'metadata.hermes.tags: [a, b]',
      'prerequisites.commands: ["git"]',
      '---',
      'body',
    ].join('\n');
    const fm = parseSkillFrontmatter(md);
    expect(fm.name).toBe('fix-lint');
    expect(fm.description).toBe('Fix lint errors');
  });
});

// ─── Hub skill scanning ─────────────────────────────────────────────────────

describe('scanHubSkills', () => {
  it('lists <name>/SKILL.md dirs with parsed frontmatter', () => {
    const root = join(cwdDir, '.agents', 'skills');
    mkdirSync(join(root, 'demo-fix'), { recursive: true });
    writeFileSync(
      join(root, 'demo-fix', 'SKILL.md'),
      '---\nname: demo-fix\ndescription: Fix a demo issue\n---\nbody\n',
    );
    // A dir WITHOUT SKILL.md must be skipped.
    mkdirSync(join(root, 'no-skill-here'), { recursive: true });

    const skills = scanHubSkills(root);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ id: 'demo-fix', name: 'demo-fix', origin: 'hub' });
    expect(skills[0].description).toBe('Fix a demo issue');
  });

  it('falls back to the directory name when frontmatter lacks name', () => {
    const root = join(cwdDir, '.agents', 'skills');
    mkdirSync(join(root, 'bare'), { recursive: true });
    writeFileSync(join(root, 'bare', 'SKILL.md'), '# No frontmatter here\n');

    const skills = scanHubSkills(root);
    expect(skills[0].name).toBe('bare');
    expect(skills[0].description).toContain('No description');
  });

  it('returns [] for a missing root', () => {
    expect(scanHubSkills(join(cwdDir, 'nope'))).toEqual([]);
  });
});

// ─── Aggregate payload ──────────────────────────────────────────────────────

describe('readHubData', () => {
  it('returns the full hub shape with all 10 toolsets enabled by default', () => {
    const hub = readHubData();
    expect(hub.toolsets.toolsets).toHaveLength(10);
    expect(hub.toolsets.enabled).toBe(10);
    expect(hub.toolsets.disabled).toBe(0);
    for (const t of hub.toolsets.toolsets) {
      expect(t.enabled).toBe(true);
      expect(typeof t.toolCount).toBe('number');
      expect(Array.isArray(t.tools)).toBe(true);
    }
    expect(hub.channels.delivery.total).toBe(0);
    expect(hub.channels.delivery.recent).toEqual([]);
    expect(Array.isArray(hub.channels.aliases)).toBe(true);
    // P2 — inbound inbox is part of the hub channels payload (empty by default).
    expect(hub.channels.inbox).toEqual({ total: 0, pipeline: 0, chat: 0, help: 0, refused: 0, recent: [] });
    // P1 — per-platform policies ride along (empty by default).
    expect(hub.channels.policies.whatsapp).toEqual({});
    expect(hub.channels.policies.email).toEqual({});
    expect(hub.channels.statusRecipients).toEqual([]);
    // I6: every platform transport (incl. email + signal) is reported.
    expect(hub.channels.platforms.map((p) => p.platform).sort()).toEqual(
      [
        'bluebubbles', 'dingtalk', 'discord', 'email', 'feishu', 'google_chat', 'homeassistant', 'irc', 'matrix',
        'mattermost', 'ntfy', 'signal', 'simplex', 'slack', 'sms', 'teams', 'telegram', 'webhook', 'wecom',
        'weixin', 'whatsapp', 'whatsapp_cloud',
      ],
    );
    expect(hub.channels.platforms.find((p) => p.platform === 'email')?.configured).toBe(false);
    expect(Array.isArray(hub.artifacts.sessions)).toBe(true);
    expect(Array.isArray(hub.skills.compiled)).toBe(true);
    expect(Array.isArray(hub.skills.hub)).toBe(true);
    expect(hub.adminConfigured).toBe(false);
    expect(typeof hub.serverTime).toBe('number');
  });

  it('reflects a disabled toolset (persisted via setToolsetEnabled) — the toggle is real', () => {
    setToolsetEnabled('web', false, new ConfigManager());
    const hub = readHubData();
    const web = hub.toolsets.toolsets.find((t) => t.name === 'web');
    expect(web?.enabled).toBe(false);
    expect(hub.toolsets.disabled).toBe(1);
    expect(hub.toolsets.enabled).toBe(9);
  });

  it('reflects a disabled skill (persisted via setSkillEnabled) — the P3 toggle is real', () => {
    mkdirSync(join(cwdDir, '.agents', 'skills', 'demo-fix'), { recursive: true });
    writeFileSync(
      join(cwdDir, '.agents', 'skills', 'demo-fix', 'SKILL.md'),
      '---\nname: demo-fix\ndescription: Fix a demo issue\n---\n\nFix it.\n',
      'utf-8',
    );
    setSkillEnabled('demo-fix', false, new ConfigManager());
    const hub = readHubData();
    const skill = hub.skills.hub.find((s) => s.id === 'demo-fix');
    expect(skill?.enabled).toBe(false);
    expect(hub.skills.disabled).toBeGreaterThanOrEqual(1);
    // Counts are consistent — enabled + disabled always equals the total.
    expect(hub.skills.enabled + hub.skills.disabled).toBe(hub.skills.total);
  });

  it('aggregates the delivery ledger + aliases from the temp config dir', () => {
    const ledger = new DeliveryLedger();
    const dir = new ChannelDirectory();
    const ref = { platform: 'mock' as const, channelId: 'C1' };
    const e1 = ledger.enqueue({ target: 'ops', ref, text: 'hello' });
    ledger.recordAttempt(e1.id, { ok: true });
    const e2 = ledger.enqueue({ target: 'ops', ref, text: 'retry me' });
    dir.setAlias('ops', 'mock', 'C1');

    const hub = readHubData();
    expect(hub.channels.delivery.total).toBe(2);
    expect(hub.channels.delivery.sent).toBe(1);
    expect(hub.channels.delivery.pending).toBe(1);
    expect(hub.channels.delivery.recent[0].text).toBe('retry me');
    expect(hub.channels.aliases).toHaveLength(1);
    expect(hub.channels.aliases[0]).toMatchObject({ alias: 'ops', platform: 'mock', channelId: 'C1' });
  });

  it('reflects gateway.statusRecipients from the config file', () => {
    writeFileSync(
      join(cfgDir, 'buffconfig.json'),
      JSON.stringify({ gateway: { statusRecipients: ['whatsapp:Alex', 'slack:ops'] } }),
    );
    const hub = readHubData();
    expect(hub.channels.statusRecipients).toEqual(['whatsapp:Alex', 'slack:ops']);
  });

  it('resolves status-recipient display labels (name → number, country-code +)', () => {
    // A contacts file next to the WhatsApp session lets the dashboard show
    // what a recipient ALIAS actually maps to ("Alex → +919876543210") — so a
    // user never sees a bare personal name without its number.
    const waDir = mkdtempSync(join(tmpdir(), 'buff-hub-wa-'));
    const prev = process.env.BUFF_WHATSAPP_SESSION_DIR;
    try {
      process.env.BUFF_WHATSAPP_SESSION_DIR = waDir;
      mkdirSync(waDir, { recursive: true });
      writeFileSync(join(waDir, 'contacts.json'), JSON.stringify({ Alex: '919876543210', Sam: '919999999999' }), 'utf-8');
      writeFileSync(
        join(cfgDir, 'buffconfig.json'),
        JSON.stringify({
          gateway: { statusRecipients: ['whatsapp:Alex', 'whatsapp:+919999999999', 'whatsapp:Sam', 'slack:ops'] },
        }),
      );
      const hub = readHubData();
      expect(hub.channels.statusRecipients).toEqual(['whatsapp:Alex', 'whatsapp:+919999999999', 'whatsapp:Sam', 'slack:ops']);
      expect(hub.channels.statusRecipientDisplay).toEqual({
        'whatsapp:Alex': 'whatsapp:Alex → +919876543210',
        'whatsapp:+919999999999': 'whatsapp:+919999999999',
        'whatsapp:Sam': 'whatsapp:Sam → +919999999999',
      });
      // slack:ops has no display entry — the panel falls back to the raw target.
      expect(hub.channels.statusRecipientDisplay['slack:ops']).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.BUFF_WHATSAPP_SESSION_DIR;
      else process.env.BUFF_WHATSAPP_SESSION_DIR = prev;
      try { rmSync(waDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('reflects gateway.policies from the config file (the Permissions page source)', () => {
    // What `buff config gateway allow …` / the policies API write:
    writeFileSync(
      join(cfgDir, 'buffconfig.json'),
      JSON.stringify({
        gateway: {
          policies: {
            whatsapp: { allowedUsers: ['919876543210'], silentDrop: true },
            telegram: { allowedGroups: ['g-family'], requireMention: true },
          },
        },
      }),
    );
    const hub = readHubData();
    expect(hub.channels.policies.whatsapp).toEqual({ allowedUsers: ['919876543210'], silentDrop: true });
    expect(hub.channels.policies.telegram).toEqual({ allowedGroups: ['g-family'], requireMention: true });
    // Platforms without a policy stay an empty object (so the UI can render).
    expect(hub.channels.policies.discord).toEqual({});
  });

  it('surfaces the saved verified contacts (name + contact no) on channels', () => {
    // What the policies API PUT writes (~/.buff/gateway/contacts.json):
    mkdirSync(join(cfgDir, 'gateway'), { recursive: true });
    writeFileSync(
      join(cfgDir, 'gateway', 'contacts.json'),
      JSON.stringify({
        version: 1,
        contacts: [
          { name: 'Alex', platform: 'whatsapp', id: '+919876543210', addedAt: 1 },
          { name: 'Ops', platform: 'telegram', id: '987654321', addedAt: 2 },
        ],
      }),
    );
    const hub = readHubData();
    expect(hub.channels.contacts).toEqual([
      { name: 'Alex', platform: 'whatsapp', id: '+919876543210', addedAt: 1 },
      { name: 'Ops', platform: 'telegram', id: '987654321', addedAt: 2 },
    ]);
  });

  it('scans the cwd .agents/skills into the hub skills list', () => {
    const root = join(cwdDir, '.agents', 'skills');
    mkdirSync(join(root, 'demo-fix'), { recursive: true });
    writeFileSync(
      join(root, 'demo-fix', 'SKILL.md'),
      '---\nname: demo-fix\ndescription: Fix a demo issue\n---\nbody\n',
    );
    const hub = readHubData();
    const demo = hub.skills.hub.find((s) => s.id === 'demo-fix');
    expect(demo).toMatchObject({ id: 'demo-fix', origin: 'hub' });
  });

  it('never throws even when the config file is corrupt', () => {
    writeFileSync(join(cfgDir, 'buffconfig.json'), '{broken json', 'utf-8');
    const hub = readHubData();
    expect(hub.toolsets.toolsets.length).toBeGreaterThan(0);
  });

  it('never throws when the config path is unreadable (EISDIR) and reports all enabled', () => {
    // A DIRECTORY where buffconfig.json should be → readFileSync throws EISDIR.
    mkdirSync(join(cfgDir, 'buffconfig.json'), { recursive: true });
    const hub = readHubData();
    expect(hub.toolsets.toolsets).toHaveLength(10);
    expect(hub.toolsets.disabled).toBe(0);
    expect(hub.toolsets.enabled).toBe(10);
  });

  it('reflects SMTP env vars in the platform status (email configured)', () => {
    const saved = { host: process.env.BUFF_SMTP_HOST, user: process.env.BUFF_SMTP_USER };
    process.env.BUFF_SMTP_HOST = 'smtp.example.com';
    process.env.BUFF_SMTP_USER = 'bot';
    try {
      const hub = readHubData();
      const email = hub.channels.platforms.find((p) => p.platform === 'email');
      expect(email?.configured).toBe(true);
    } finally {
      if (saved.host === undefined) delete process.env.BUFF_SMTP_HOST;
      else process.env.BUFF_SMTP_HOST = saved.host;
      if (saved.user === undefined) delete process.env.BUFF_SMTP_USER;
      else process.env.BUFF_SMTP_USER = saved.user;
    }
  });

  it('marks adminConfigured true when an admin credential file exists', () => {
    writeAdminUser('admin', 'some-long-password', 'admin');
    expect(readHubData().adminConfigured).toBe(true);
    expect(existsSync(join(cfgDir, 'dashboard-admin.json'))).toBe(true);
  });
});
