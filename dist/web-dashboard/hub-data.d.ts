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
import type { HubChannelPolicy, HubInboxEntry } from './src/types.js';
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
/** Summary of a stored conversation (per-contact gateway chat history). */
export interface HubConversationSummary {
    key: string;
    platform: string;
    channelId: string;
    /** Human-readable contact name (resolved from WhatsApp contacts file, etc.). */
    contactName?: string;
    messageCount: number;
    lastActiveAt: number;
    lastUserMessage: string;
    lastAssistantMessage: string;
    /** Full message thread (when requested via detail endpoint). */
    messages?: Array<{
        role: 'user' | 'assistant';
        content: string;
        ts: number;
    }>;
}
/** Conversation analytics computed from stored chat history. */
export interface HubConversationAnalytics {
    /** Total messages across all conversations. */
    totalMessages: number;
    /** Total conversations stored. */
    totalConversations: number;
    /** Average messages per conversation. */
    avgMessagesPerConversation: number;
    /** Most active contacts (sorted by message count, top 10). */
    topContacts: Array<{
        name: string;
        platform: string;
        messageCount: number;
        lastActiveAt: number;
    }>;
    /** Messages grouped by hour of day (0-23). */
    hourlyDistribution: Array<{
        hour: number;
        count: number;
    }>;
    /** Messages grouped by day of week (0=Sun, 6=Sat). */
    dailyDistribution: Array<{
        day: number;
        count: number;
    }>;
    /** Messages per platform. */
    platformBreakdown: Array<{
        platform: string;
        conversations: number;
        messages: number;
    }>;
    /** Messages per day (last 14 days). */
    dailyVolume: Array<{
        date: string;
        count: number;
    }>;
    /** Average user message length (characters). */
    avgUserMessageLength: number;
    /** Average assistant message length (characters). */
    avgAssistantMessageLength: number;
}
export interface HubArtifactSummary {
    sessionId: string;
    count: number;
    latestAt: number;
    /** Most recent artifacts in the session (title/kind/preview only — small). */
    recent: Array<{
        kind: string;
        title?: string;
        preview?: string;
    }>;
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
        reachable: Array<{
            platform: string;
            channelId: string;
            aliases: string[];
            reachable: boolean;
        }>;
        /** Every platform's transport status (I6 — Email/Signal included). */
        platforms: HubPlatformStatus[];
        /** P1 — effective per-platform inbound policies (who may trigger). */
        policies: Record<string, HubChannelPolicy>;
        /**
         * Saved verified contacts (name + contact no) across platforms — the
         * validated list the Permissions page edits. Names resolve the bare ids
         * in `policies.*.allowedUsers` to human labels.
         */
        contacts: Array<{
            name: string;
            platform: string;
            id: string;
            addedAt?: number;
        }>;
        /** Status recipients — always get pipeline completion summaries. */
        statusRecipients: string[];
        /**
         * Friendly display labels for status recipients: `whatsapp:Name` shows as
         * `whatsapp:Name → +91***` (resolved through the contacts file, number
         * masked), a bare number gets the country-code `+` — so a user never sees
         * a raw alias without knowing who/what it maps to.
         */
        statusRecipientDisplay: Record<string, string>;
        /** P2 — inbound inbox (who messaged the bot, what happened). */
        inbox: {
            total: number;
            pipeline: number;
            chat: number;
            help: number;
            refused: number;
            /** Re-deliveries recognised by the dedup ledger and not re-run. */
            duplicate: number;
            recent: HubInboxEntry[];
        };
    };
    artifacts: {
        totalSessions: number;
        totalArtifacts: number;
        sessions: HubArtifactSummary[];
    };
    skills: HubSkillsData;
    /** Gateway chat conversations (per-contact history). */
    conversations: {
        total: number;
        recent: HubConversationSummary[];
        analytics?: HubConversationAnalytics;
    };
    adminConfigured: boolean;
    serverTime: number;
}
/** Parse the name/description out of a SKILL.md frontmatter block (YAML-lite). */
export declare function parseSkillFrontmatter(markdown: string): {
    name?: string;
    description?: string;
};
/** Scan a skills root for `<name>/SKILL.md` directories. Best-effort. */
export declare function scanHubSkills(root: string): HubSkill[];
/** The full Agent Hub read payload. Never throws. */
export declare function readHubData(): HubData;
//# sourceMappingURL=hub-data.d.ts.map