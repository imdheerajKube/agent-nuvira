/**
 * I4 — Agent Hub read aggregation (`src/web-dashboard/hub-data.ts`).
 *
 * WebUI parity (SkillsPage / McpPage / ToolsetConfigDrawer): one read
 * surface that aggregates the four hub tabs the dashboard renders —
 * **Tools** (I1 toolsets), **Channels** (I2 gateway delivery + aliases),
 * **Artifacts** (I3 per-session store), and **Skills** (compiled SkillStore +
 * hub-installed SKILL.md). Pure reads, never throws, honors NUVIRA_MEMORY_DIR /
 * NUVIRA_CONFIG_DIR so the panel and CLI always agree.
 *
 * The WRITE side (toolset toggles) stays in server.ts (admin-gated) and calls
 * `setToolsetEnabled` directly — this module is the read-only source of truth
 * the panel and the tests share.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolveNuviraHome } from '../config/paths.js';
import { join } from 'node:path';
import { getToolsetStatus } from '../tools/toolsets.js';
import { DeliveryLedger } from '../gateway/delivery.js';
import { InboxLedger } from '../gateway/inbox.js';
import { GatewayChatStore, CHAT_HISTORY_TTL_MS } from '../gateway/chat-store.js';
import { ChannelDirectory, PLATFORM_ENV_VARS, PLATFORM_LABELS, isPlatformConfigured, } from '../gateway/channel-directory.js';
import { ArtifactStore } from '../tools/artifact-store.js';
import { getSkillStore } from '../learning/skill-store.js';
import { readDisabledSkills } from '../learning/hub-skill-catalog.js';
import { isAdminConfigured } from './src/admin-auth.js';
import { ConfigManager } from '../config/manager.js';
import { whatsappSessionDir } from '../gateway/whatsapp/session.js';
import { readContactsFile } from '../gateway/whatsapp/contacts.js';
import { readGatewayContacts } from '../gateway/contacts.js';
// ─── Tools (I1 toolsets) ─────────────────────────────────────────────────────
function readToolsetsData() {
    // getToolsetStatus() WITHOUT a ConfigManager never throws (absent state =
    // all enabled) — used as the fallback when the config file is unreadable
    // (EACCES/EISDIR), so the hub's never-throw contract holds even there.
    let toolsets;
    try {
        toolsets = getToolsetStatus(new ConfigManager());
    }
    catch {
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
function readChannelsData() {
    const platforms = Object.keys(PLATFORM_ENV_VARS)
        .filter((p) => p !== 'mock')
        .map((p) => ({
        platform: p,
        label: PLATFORM_LABELS[p],
        configured: isPlatformConfigured(p),
        envVars: [...PLATFORM_ENV_VARS[p]],
    }));
    const ledger = new DeliveryLedger().read();
    const recent = ledger.slice(0, 20).map((e) => ({
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
    const inboxRecent = inboxEntries.slice(0, 20).map((e) => ({
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
        dedupKey: e.dedupKey,
        dedupCount: e.dedupCount,
    }));
    const dir = new ChannelDirectory();
    let reachable = [];
    try {
        reachable = dir.reachableChannels();
    }
    catch {
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
        aliases: dir.listAliases().map((a) => ({
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
            phone: c.phone,
            status: c.status,
            registeredAt: c.registeredAt,
            addedAt: c.addedAt,
        })),
        statusRecipients: (() => {
            const cfg = new ConfigManager().getAll();
            return cfg.gateway?.statusRecipients ?? [];
        })(),
        statusRecipientDisplay: (() => {
            const cfg = new ConfigManager().getAll();
            const targets = cfg.gateway?.statusRecipients ?? [];
            if (targets.length === 0)
                return {};
            const display = {};
            // WhatsApp names resolve through the user's contacts file (name → digits);
            // numbers get the country-code '+' for readability. Other platforms stay
            // as-is. Never throws — resolution is best-effort.
            try {
                const contacts = readContactsFile(whatsappSessionDir());
                for (const t of targets) {
                    const m = /^whatsapp:(.+)$/i.exec(t);
                    if (!m)
                        continue;
                    const who = m[1].trim();
                    if (!who)
                        continue;
                    const digitsOnly = /^\+?\d[\d\s-]*$/.test(who);
                    if (digitsOnly) {
                        display[t] = `whatsapp:+${who.replace(/\D+/g, '')}`;
                    }
                    else {
                        const hit = contacts[who] ?? Object.entries(contacts).find(([k]) => k.toLowerCase() === who.toLowerCase())?.[1];
                        display[t] = hit ? `whatsapp:${who} → +${hit}` : t;
                    }
                }
            }
            catch {
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
            // Re-deliveries the gateway recognised and deliberately did NOT re-run.
            duplicate: inboxEntries.filter((e) => e.handled === 'duplicate').length,
            recent: inboxRecent,
        },
    };
}
/** Effective per-platform gateway policies (env < config, no network). */
function readPoliciesData() {
    const out = {};
    for (const p of Object.keys(PLATFORM_ENV_VARS)) {
        if (p === 'mock')
            continue;
        const cfg = new ConfigManager().getAll();
        const fromConfig = cfg.gateway?.policies?.[p] ?? {};
        out[p] = { ...fromConfig };
    }
    return out;
}
// ─── Conversations (gateway chat history) ───────────────────────────────────
function readConversationsData() {
    const store = new GatewayChatStore();
    const conversations = store.getAllConversations();
    // Build a channelId → name lookup from WhatsApp contacts file.
    let contactLookup = {};
    try {
        const contacts = readContactsFile(whatsappSessionDir());
        // contacts is { Name: 'digits' }, we need digits → Name
        for (const [name, digits] of Object.entries(contacts)) {
            if (name && digits)
                contactLookup[digits] = name;
        }
    }
    catch { /* best-effort */ }
    const recent = conversations
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .slice(0, 50)
        .map((c) => {
        const [platform, ...rest] = c.key.split(':');
        const channelId = rest.join(':');
        const lastUser = c.messages.filter((m) => m.role === 'user').pop();
        const lastAssistant = c.messages.filter((m) => m.role === 'assistant').pop();
        // Resolve contact name from lookup.
        const cleanId = channelId.replace(/[^\d]/g, '');
        const contactName = contactLookup[cleanId] || contactLookup[channelId];
        return {
            key: c.key,
            platform: platform || 'unknown',
            channelId,
            contactName,
            messageCount: c.messages.length,
            lastActiveAt: c.lastActiveAt,
            lastUserMessage: (lastUser?.content ?? '').slice(0, 300),
            lastAssistantMessage: (lastAssistant?.content ?? '').slice(0, 300),
            // Include full messages for the expandable chat thread view.
            messages: c.messages.map((m) => ({
                role: m.role,
                content: m.content,
                ts: m.ts,
            })),
            tags: c.tags,
        };
    });
    return { total: conversations.length, recent };
}
// ─── Conversation Analytics ─────────────────────────────────────────────────
/** Compute analytics from stored conversation data. */
function readConversationAnalytics() {
    const store = new GatewayChatStore();
    const conversations = store.getAllConversations();
    const now = Date.now();
    const TTL = CHAT_HISTORY_TTL_MS;
    // Build contact lookup.
    let contactLookup = {};
    try {
        const contacts = readContactsFile(whatsappSessionDir());
        for (const [name, digits] of Object.entries(contacts)) {
            if (name && digits)
                contactLookup[digits] = name;
        }
    }
    catch { /* best-effort */ }
    // Filter to active conversations.
    const active = conversations.filter((c) => now - c.lastActiveAt <= TTL);
    let totalMessages = 0;
    let totalUserMsgLen = 0;
    let totalAssistantMsgLen = 0;
    let userMsgCount = 0;
    let assistantMsgCount = 0;
    const hourly = new Array(24).fill(0);
    const daily = new Array(7).fill(0);
    const platformMap = new Map();
    const contactMap = new Map();
    const dailyVolumeMap = new Map();
    // Compute daily volume for last 14 days.
    for (let i = 0; i < 14; i++) {
        const d = new Date(now - i * 86_400_000);
        const key = d.toISOString().slice(0, 10);
        dailyVolumeMap.set(key, 0);
    }
    for (const conv of active) {
        const [platform] = conv.key.split(':');
        const plat = platform || 'unknown';
        const platEntry = platformMap.get(plat) ?? { conversations: 0, messages: 0 };
        platEntry.conversations++;
        platEntry.messages += conv.messages.length;
        platformMap.set(plat, platEntry);
        // Contact aggregation.
        const [_, ...rest] = conv.key.split(':');
        const channelId = rest.join(':');
        const cleanId = channelId.replace(/[^\d]/g, '');
        const contactName = contactLookup[cleanId] || contactLookup[channelId] || channelId;
        const existing = contactMap.get(conv.key) ?? { name: contactName, platform: plat, messageCount: 0, lastActiveAt: 0 };
        existing.messageCount += conv.messages.length;
        existing.lastActiveAt = Math.max(existing.lastActiveAt, conv.lastActiveAt);
        contactMap.set(conv.key, existing);
        for (const msg of conv.messages) {
            totalMessages++;
            const date = new Date(msg.ts);
            hourly[date.getHours()]++;
            daily[date.getDay()]++;
            if (msg.role === 'user') {
                totalUserMsgLen += msg.content.length;
                userMsgCount++;
            }
            else {
                totalAssistantMsgLen += msg.content.length;
                assistantMsgCount++;
            }
            // Daily volume.
            const dayKey = date.toISOString().slice(0, 10);
            if (dailyVolumeMap.has(dayKey)) {
                dailyVolumeMap.set(dayKey, (dailyVolumeMap.get(dayKey) ?? 0) + 1);
            }
        }
    }
    return {
        totalMessages,
        totalConversations: active.length,
        avgMessagesPerConversation: active.length > 0 ? Math.round(totalMessages / active.length * 10) / 10 : 0,
        topContacts: [...contactMap.values()].sort((a, b) => b.messageCount - a.messageCount).slice(0, 10),
        hourlyDistribution: hourly.map((count, hour) => ({ hour, count })),
        dailyDistribution: daily.map((count, day) => ({ day, count })),
        platformBreakdown: [...platformMap.entries()].map(([platform, v]) => ({ platform, ...v })),
        dailyVolume: [...dailyVolumeMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
        avgUserMessageLength: userMsgCount > 0 ? Math.round(totalUserMsgLen / userMsgCount) : 0,
        avgAssistantMessageLength: assistantMsgCount > 0 ? Math.round(totalAssistantMsgLen / assistantMsgCount) : 0,
    };
}
// ─── Artifacts (I3 store) ───────────────────────────────────────────────────
function readArtifactsData() {
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
export function parseSkillFrontmatter(markdown) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
    if (!m)
        return {};
    const out = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = /^([a-zA-Z0-9_.-]+):\s*(.*)$/.exec(line);
        if (kv)
            out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
    return { name: out.name, description: out.description };
}
/** Scan a skills root for `<name>/SKILL.md` directories. Best-effort. */
export function scanHubSkills(root) {
    try {
        if (!existsSync(root))
            return [];
        return readdirSync(root, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => {
            const skillPath = join(root, d.name, 'SKILL.md');
            if (!existsSync(skillPath))
                return null;
            try {
                const fm = parseSkillFrontmatter(readFileSync(skillPath, 'utf-8'));
                return {
                    id: d.name,
                    name: fm.name || d.name,
                    description: fm.description || 'No description in SKILL.md frontmatter.',
                    origin: 'hub',
                    // Raw scan result — the enabled flag is applied by readSkillsData
                    // against the live config (a disabled skill is still listed).
                    enabled: true,
                };
            }
            catch {
                return null;
            }
        })
            .filter((s) => s !== null)
            .sort((a, b) => a.name.localeCompare(b.name));
    }
    catch {
        return [];
    }
}
function readSkillsData() {
    let compiled = [];
    try {
        compiled = getSkillStore()
            .getAll()
            .map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            version: s.version,
            origin: 'compiled',
            usageCount: s.usageCount,
            enabled: true,
            // P6e — provenance: bundled first-party skills get a 🧠 badge (a
            // community/learned skill does not), so the panel separates what
            // ships with the product from what the user added.
            bundled: Array.isArray(s.sourceTrajectoryIds) && s.sourceTrajectoryIds.includes('bundled'),
        }));
    }
    catch {
        compiled = [];
    }
    const hub = [
        ...scanHubSkills(join(process.cwd(), '.agents', 'skills')),
        ...scanHubSkills(join(resolveNuviraHome(), 'skills')),
    ];
    // Dedupe by id — the user root wins over the project root when both exist.
    const seen = new Set();
    const deduped = hub.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
    // P3 — the I7 skills.disabled[] list (the SAME config the CLI + Agent Hub
    // toggle write) drives the per-skill flag + counts, so the hub reflects the
    // runtime match gate exactly. readDisabledSkills is best-effort: an
    // unreadable config simply means everything is enabled.
    const disabled = new Set(readDisabledSkills(new ConfigManager()));
    const mark = (s) => ({ ...s, enabled: !disabled.has(s.id) });
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
export function readHubData() {
    return {
        toolsets: readToolsetsData(),
        channels: readChannelsData(),
        artifacts: readArtifactsData(),
        skills: readSkillsData(),
        conversations: { ...readConversationsData(), analytics: readConversationAnalytics() },
        adminConfigured: isAdminConfigured(),
        serverTime: Date.now(),
    };
}
//# sourceMappingURL=hub-data.js.map