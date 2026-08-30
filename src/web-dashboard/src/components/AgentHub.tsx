/**
 * Agent Hub panel (I4 + I5) — a 4-tab management page the user picked out:
 * **Skills / Tools / Channels / Artifacts** on one screen.
 *
 * - **Tools** — I1 toolsets with enable/disable switches. Writes are
 *   admin-gated (PUT /api/admin/hub/toolsets/<name>, routing.operate) and
 *   honored by the runtime gate, so a toggle is never cosmetic.
 * - **Channels** — I2 gateway delivery ledger (pending/sent/failed + recent
 *   entries) and the channel directory aliases.
 * - **Artifacts** — I3 per-session artifact store (sessions + recent items).
 * - **Skills** — compiled SkillStore skills + hub-installed SKILL.md skills.
 *
 * Reads are open; the toggle surface follows the AdminPanel auth pattern:
 * unconfigured → setup form, configured → login form, authed → role-gated
 * switches (admin/operator can toggle, viewer reads).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { dashboardAPI } from '../api';
import type { HubChannelPolicy, HubContact, HubData, HubToolset } from '../types';
import WhatsAppPanel from './WhatsAppPanel';
import { PlatformConfigSection } from './PlatformConfigSection';
import { maskSenderId } from '../mask';

type HubTab = 'tools' | 'channels' | 'artifacts' | 'skills' | 'conversations';

const TABS: Array<{ id: HubTab; label: string; icon: string }> = [
  { id: 'tools', label: 'Tools', icon: '🧰' },
  { id: 'channels', label: 'Channels', icon: '📡' },
  { id: 'conversations', label: 'Conversations', icon: '💬' },
  { id: 'artifacts', label: 'Artifacts', icon: '📦' },
  { id: 'skills', label: 'Skills', icon: '🧠' },
];

const STATUS_LABEL: Record<string, string> = { pending: '⏳ pending', sent: '✅ sent', failed: '❌ failed' };

/** A pending toggle the user triggered before logging in. */
interface PendingToggle {
  kind: 'toolset' | 'skill';
  name: string;
  enabled: boolean;
}

export default function AgentHub() {
  const [tab, setTab] = useState<HubTab>('tools');
  const [data, setData] = useState<HubData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Auth (same control layer as AdminPanel).
  const [authStatus, setAuthStatus] = useState<{ configured: boolean; authenticated: boolean } | null>(null);
  const [authed, setAuthed] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [pendingToggle, setPendingToggle] = useState<PendingToggle | null>(null);

  const [toggling, setToggling] = useState<string | null>(null);
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({});

  // I11 — Channels-tab test send (mirrors `buff gateway send <target> <text>`).
  const [sendTarget, setSendTarget] = useState('');
  const [sendText, setSendText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // P1 — Permissions (validated senders): per-platform policy drafts + saves.
  const [policyDraft, setPolicyDraft] = useState<Record<string, HubChannelPolicy>>({});
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyMsg, setPolicyMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [policyUserInput, setPolicyUserInput] = useState<Record<string, string>>({});
  const [policyGroupInput, setPolicyGroupInput] = useState<Record<string, string>>({});
  // Privacy — sender ids are masked by default; admins/operators can reveal
  // full ids while working (per-session, resets on reload).
  const [revealIds, setRevealIds] = useState(false);

  // Conversations tab — infinite scroll state.
  const [expandedConv, setExpandedConv] = useState<string | null>(null);
  const [convSearch, setConvSearch] = useState('');
  const [clearingConv, setClearingConv] = useState<string | null>(null);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [typingContacts, setTypingContacts] = useState<Map<string, { platform: string; channelId: string; startedAt: number }>>(new Map());
  const [selectedConvs, setSelectedConvs] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState<string>('');
  const [addingTagTo, setAddingTagTo] = useState<string | null>(null);
  const [newTagValue, setNewTagValue] = useState('');
  const [convList, setConvList] = useState<NonNullable<HubData['conversations']['recent']>>([]);
  const [convTotal, setConvTotal] = useState(0);
  const [convOffset, setConvOffset] = useState(0);
  const [convHasMore, setConvHasMore] = useState(true);
  const [convLoading, setConvLoading] = useState(false);
  const [convInitialized, setConvInitialized] = useState(false);
  const convPageSize = 20;
  const convSentinelRef = useRef<HTMLDivElement | null>(null);

  /** Load the next page of conversations (or the first page on search/init). */
  const loadConversations = useCallback(async (reset = false) => {
    if (convLoading) return;
    const offset = reset ? 0 : convOffset;
    setConvLoading(true);
    try {
      const r = await dashboardAPI.fetchGatewayConversations({ offset, limit: convPageSize, q: convSearch || undefined });
      if (r.ok && r.conversations) {
        setConvList((prev) => reset ? r.conversations! : [...prev, ...r.conversations!]);
        setConvTotal(r.total ?? 0);
        setConvOffset(offset + r.conversations!.length);
        setConvHasMore(r.hasMore ?? false);
      }
    } catch { /* best-effort */ }
    setConvLoading(false);
  }, [convLoading, convOffset, convSearch]);

  // Load conversations when the tab is first opened.
  useEffect(() => {
    if (tab === 'conversations' && !convInitialized && !convLoading) {
      setConvInitialized(true);
      void loadConversations(true);
    }
  }, [tab, convInitialized, convLoading, loadConversations]);

  // Infinite scroll — observe the sentinel div at the bottom of the list.
  useEffect(() => {
    const sentinel = convSentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && convHasMore && !convLoading) {
          void loadConversations(false);
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [convHasMore, convLoading, loadConversations]);

  // Reset and reload conversations when search changes (debounced).
  useEffect(() => {
    const timer = setTimeout(() => {
      if (tab === 'conversations' && convInitialized) {
        setConvList([]);
        setConvOffset(0);
        setConvHasMore(true);
        void loadConversations(true);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [convSearch]);

  // Subscribe to typing events from SSE.
  useEffect(() => {
    const unsub = dashboardAPI.onTypingEvent((event) => {
      setTypingContacts((prev) => {
        const next = new Map(prev);
        const key = `${event.platform}:${event.channelId}`;
        if (event.typing) {
          next.set(key, { platform: event.platform, channelId: event.channelId, startedAt: Date.now() });
        } else {
          next.delete(key);
        }
        return next;
      });
    });
    return unsub;
  }, []);

  /** Toggle selection of a conversation. */
  const toggleConvSelection = useCallback((key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedConvs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  /** Select/deselect all visible conversations. */
  const toggleSelectAll = useCallback(() => {
    setSelectedConvs((prev) => {
      if (prev.size === convList.length) return new Set();
      return new Set(convList.map((c) => c.key));
    });
  }, [convList]);

  /** Export selected conversations as a ZIP file. */
  const handleBulkExport = useCallback(async () => {
    if (selectedConvs.size === 0) return;
    setExporting(true);
    try {
      await dashboardAPI.exportGatewayConversations([...selectedConvs]);
    } catch { /* best-effort */ }
    setExporting(false);
  }, [selectedConvs]);

  /** Load all tags on mount. */
  useEffect(() => {
    if (tab === 'conversations') {
      void dashboardAPI.getAllConversationTags().then((r) => {
        if (r.ok && r.tags) setAllTags(r.tags);
      });
    }
  }, [tab]);

  /** Add a tag to a conversation. */
  const handleAddTag = useCallback(async (key: string, tag: string) => {
    if (!tag.trim()) return;
    const r = await dashboardAPI.addConversationTag(key, tag.trim());
    if (r.ok) {
      setConvList((prev) => prev.map((c) => c.key === key ? { ...c, tags: [...(c.tags ?? []), tag.trim().toLowerCase()] } : c));
      setAllTags((prev) => prev.includes(tag.trim().toLowerCase()) ? prev : [...prev, tag.trim().toLowerCase()].sort());
    }
    setAddingTagTo(null);
    setNewTagValue('');
  }, []);

  /** Remove a tag from a conversation. */
  const handleRemoveTag = useCallback(async (key: string, tag: string) => {
    const r = await dashboardAPI.removeConversationTag(key, tag);
    if (r.ok) {
      setConvList((prev) => prev.map((c) => c.key === key ? { ...c, tags: (c.tags ?? []).filter((t) => t !== tag) } : c));
    }
  }, []);

  /** Export a conversation as a formatted text file download. */
  const exportConversationText = useCallback((c: NonNullable<HubData['conversations']['recent']>[0], e: React.MouseEvent) => {
    e.stopPropagation();
    const displayName = c.contactName || c.channelId;
    const lines: string[] = [
      `Conversation with ${displayName} (${c.platform})`,
      `Exported: ${new Date().toLocaleString()}`,
      `Messages: ${c.messageCount}`,
      '─'.repeat(50),
      '',
    ];
    if (c.messages) {
      for (const m of c.messages) {
        const role = m.role === 'user' ? displayName : 'Agent';
        const ts = new Date(m.ts).toLocaleString();
        lines.push(`[${ts}] ${role}:`);
        lines.push(m.content);
        lines.push('');
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conversation-${c.platform}-${c.channelId.replace(/[^\w]/g, '_')}-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  /** Export a conversation as a printable HTML page (user can Save as PDF). */
  const exportConversationPDF = useCallback((c: NonNullable<HubData['conversations']['recent']>[0], e: React.MouseEvent) => {
    e.stopPropagation();
    const displayName = c.contactName || c.channelId;
    const messages = c.messages ?? [];
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Conversation with ${displayName}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.6; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .meta { color: #666; font-size: 13px; margin-bottom: 20px; }
  .msg { margin-bottom: 16px; }
  .msg-user { text-align: right; }
  .msg-assistant { text-align: left; }
  .bubble { display: inline-block; max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 14px; white-space: pre-wrap; word-break: break-word; text-align: left; }
  .bubble-user { background: #007bff; color: #fff; border-bottom-right-radius: 4px; }
  .bubble-assistant { background: #f0f0f0; color: #1a1a1a; border-bottom-left-radius: 4px; }
  .timestamp { font-size: 11px; color: #999; margin-top: 2px; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
<h1>Conversation with ${displayName}</h1>
<div class="meta">Platform: ${c.platform} · ${c.messageCount} messages · Exported: ${new Date().toLocaleString()}</div>
${messages.map((m) => {
  const role = m.role === 'user' ? 'user' : 'assistant';
  const label = m.role === 'user' ? displayName : 'Agent';
  return `<div class="msg msg-${role}">
  <div class="bubble bubble-${role}">${m.content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
  <div class="timestamp">${label} · ${new Date(m.ts).toLocaleString()}</div>
</div>`;
}).join('\n')}
</body>
</html>`;
    const w = window.open('', '_blank');
    if (w) {
      w.document.write(html);
      w.document.close();
      // Auto-trigger print dialog which includes Save as PDF.
      setTimeout(() => w.print(), 300);
    }
  }, []);

  // Real-time SSE sync: when data.conversations is updated by a conversation SSE
  // event, merge new/updated entries into the infinite-scroll list without a
  // full reload. Only auto-syncs when the user is on the first page (offset=0)
  // and no search is active — otherwise a manual reload is cleaner.
  useEffect(() => {
    const sseConvs = data?.conversations?.recent;
    if (!sseConvs || sseConvs.length === 0) return;
    if (!convInitialized) return;
    // Only auto-sync on the first page with no search filter.
    // Guard: if we've loaded more than one page, don't overwrite.
    if (convOffset > convPageSize || convSearch) return;
    // Merge: update existing entries, prepend new ones.
    setConvList((prev) => {
      const existingKeys = new Set(prev.map((c) => c.key));
      const updated = sseConvs.map((c) => ({ ...c }));
      // Replace existing entries that match, keep the rest.
      const prevMap = new Map(prev.map((c) => [c.key, c]));
      for (const c of updated) {
        if (prevMap.has(c.key)) {
          prevMap.set(c.key, c);
        }
      }
      // Add any truly new entries at the top.
      const newEntries = updated.filter((c) => !existingKeys.has(c.key));
      const merged = [...newEntries, ...prevMap.values()];
      // Sort by lastActiveAt descending.
      merged.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      return merged;
    });
  }, [data?.conversations?.recent]);

  // P6d — marketplace import surface (search every configured registry).
  const [marketQuery, setMarketQuery] = useState('');
  const [marketResults, setMarketResults] = useState<Array<{
    name: string; version: string; description: string; author: string; tags: string[]; source: string; sourceKind: string;
  }>>([]);
  const [marketSearched, setMarketSearched] = useState(false);
  const [marketBusy, setMarketBusy] = useState(false);
  const [marketMsg, setMarketMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [marketBusyName, setMarketBusyName] = useState<string | null>(null);

  // P1 — verified contacts (name + contact no): the validated list.
  const [contactNameInput, setContactNameInput] = useState<Record<string, string>>({});
  const [contacts, setContacts] = useState<HubContact[]>([]);
  // Status recipients — always get pipeline completion summaries.
  const [statusRecipients, setStatusRecipients] = useState<string[]>([]);
  const [statusRecipientInput, setStatusRecipientInput] = useState('');

  /** Show the full id when the admin reveal toggle is on, else the masked form. */
  const showId = (id: string): string => (revealIds ? String(id ?? '') : maskSenderId(id));

  /** Extract a readable phone number from a WhatsApp channel id (918800663237@s.whatsapp.net). */
  const extractPhone = (channelId: string): string => {
    const match = channelId.match(/^(\d+)@/);
    if (!match) return '';
    const num = match[1];
    // Format Indian numbers: +91 XXXXX XXXXX
    if (num.length === 12 && num.startsWith('91')) {
      return `+${num.slice(0,2)} ${num.slice(2,7)} ${num.slice(7)}`;
    }
    if (num.length === 10) {
      return `+91 ${num.slice(0,5)} ${num.slice(5)}`;
    }
    return `+${num}`;
  };

  /** Build a display label for a conversation card: Name (phone) or just phone. */
  const convDisplayLabel = (c: NonNullable<HubData['conversations']['recent']>[0]): { name: string; phone: string } => {
    const phone = extractPhone(c.channelId);
    if (c.contactName) {
      return { name: c.contactName, phone };
    }
    return { name: phone || showId(c.channelId), phone: '' };
  };

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    const d = await dashboardAPI.fetchHub();
    setData(d);
    if (d?.channels?.statusRecipients) setStatusRecipients(d.channels.statusRecipients);
    if (d?.channels?.contacts) setContacts(d.channels.contacts);
    if (!d) setError('Could not reach the dashboard server, or the server is older than this panel. Run `buff dashboard` to start it.');
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void refresh();
    dashboardAPI.fetchAdminAuthStatus().then((s) => {
      if (!s) return;
      setAuthStatus({ configured: s.configured, authenticated: s.authenticated });
      setAuthed(s.authenticated);
      setRole(s.role ?? null);
      setUserName(s.user ?? null);
    });
  }, [refresh]);

  /** routing.operate — admin or operator may toggle capabilities. */
  const canWrite = authed && (role === 'admin' || role === 'operator');

  /** P6d — search the marketplace (reads OTHER registries; the repo stays private). */
  const searchMarket = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = marketQuery.trim();
    if (!q) return;
    setMarketBusy(true);
    setMarketMsg(null);
    const results = await dashboardAPI.marketplaceSearch(q);
    setMarketResults(results);
    setMarketSearched(true);
    setMarketBusy(false);
  };

  /** P6d — install a skill from the marketplace into <project>/.agents/skills/. */
  const installMarketSkill = async (name: string) => {
    if (!authed) {
      setMarketMsg({ kind: 'err', text: '🔐 Log in (or set up admin access) to install skills.' });
      return;
    }
    if (!canWrite) {
      setMarketMsg({ kind: 'err', text: 'Your role cannot install skills — admin or operator only.' });
      return;
    }
    setMarketBusyName(name);
    setMarketMsg(null);
    const r = await dashboardAPI.marketplaceInstall(name);
    if (r.ok) {
      setMarketMsg({ kind: 'ok', text: `✅ Installed ${name} (quarantine checked) — it appears in the Skills list and loads via the skill tool next turn.` });
      void refresh();
    } else {
      setMarketMsg({
        kind: 'err',
        text: r.quarantined ? `⛔ ${r.error || 'checksum mismatch — quarantined'}` : `❌ ${r.error || 'Install failed.'}`,
      });
    }
    setMarketBusyName(null);
  };

  /** P6d — uninstall a hub skill (removes the dir + provenance). */
  const uninstallSkill = async (name: string) => {
    if (!authed) {
      setMarketMsg({ kind: 'err', text: '🔐 Log in (or set up admin access) to uninstall skills.' });
      return;
    }
    if (!canWrite) {
      setMarketMsg({ kind: 'err', text: 'Your role cannot uninstall skills — admin or operator only.' });
      return;
    }
    setMarketBusyName(name);
    setMarketMsg(null);
    const r = await dashboardAPI.marketplaceUninstall(name);
    if (r.ok) {
      setMarketMsg({ kind: 'ok', text: `🗑️ Uninstalled ${name} — removed from .agents/skills/ and provenance.` });
      void refresh();
    } else {
      setMarketMsg({ kind: 'err', text: `❌ ${r.error || 'Uninstall failed.'}` });
    }
    setMarketBusyName(null);
  };

  const sessionExpired = () => {
    setAuthed(false);
    setAuthStatus((s) => (s ? { ...s, authenticated: false } : s));
    setAuthError('Session expired — log in again to toggle capabilities.');
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    const r = await dashboardAPI.adminLogin(user, password);
    if (r.ok) {
      setAuthed(true);
      setAuthStatus({ configured: true, authenticated: true });
      setRole(r.role ?? 'admin');
      setUserName(r.user ?? null);
      setUser('');
      setPassword('');
      const pending = pendingToggle;
      setPendingToggle(null);
      if (pending) await applyToggle(pending.kind, pending.name, pending.enabled);
    } else {
      setAuthError(r.error || 'Login failed.');
    }
    setAuthBusy(false);
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    if (password.length < 8) {
      setAuthError('Password must be at least 8 characters.');
      setAuthBusy(false);
      return;
    }
    const r = await dashboardAPI.adminSetup(user, password);
    if (r.ok) {
      setAuthed(true);
      setAuthStatus({ configured: true, authenticated: true });
      setRole(r.role ?? 'admin');
      setUserName(r.user ?? null);
      setUser('');
      setPassword('');
      const pending = pendingToggle;
      setPendingToggle(null);
      if (pending) await applyToggle(pending.kind, pending.name, pending.enabled);
    } else {
      setAuthError(r.error || 'Setup failed.');
    }
    setAuthBusy(false);
  };

  const handleLogout = async () => {
    await dashboardAPI.adminLogout();
    setAuthed(false);
    setAuthStatus((s) => (s ? { ...s, authenticated: false } : s));
    setRole(null);
    setUserName(null);
  };

  const applyToggle = async (kind: 'toolset' | 'skill', name: string, enabled: boolean) => {
    setToggling(name);
    const r = kind === 'skill'
      ? await dashboardAPI.setSkillEnabled(name, enabled)
      : await dashboardAPI.setToolsetEnabled(name, enabled);
    if (r.ok) {
      setRowMsg((m) => ({ ...m, [name]: `✅ ${enabled ? 'Enabled' : 'Disabled'} — live for new agent runs` }));
      void refresh();
    } else if (r.unauthorized) {
      sessionExpired();
    } else {
      setRowMsg((m) => ({ ...m, [name]: `❌ ${r.error || 'Toggle failed'}` }));
      if (r.forbidden) setAuthError(r.error || 'Your role cannot change capabilities.');
    }
    setToggling(null);
  };

  const toggleToolset = (name: string, enabled: boolean) => {
    if (!authed) {
      // Queue the toggle behind the login/setup gate.
      setPendingToggle({ kind: 'toolset', name, enabled });
      return;
    }
    void applyToggle('toolset', name, enabled);
  };

  const toggleSkill = (name: string, enabled: boolean) => {
    if (!authed) {
      // Queue the toggle behind the login/setup gate.
      setPendingToggle({ kind: 'skill', name, enabled });
      return;
    }
    void applyToggle('skill', name, enabled);
  };

  /** I11: send a test message through the gateway (admin/operator only). */
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authed) {
      setSendMsg({ kind: 'err', text: '🔐 Log in (or set up admin access) to send test messages.' });
      return;
    }
    if (!canWrite) {
      setSendMsg({ kind: 'err', text: '🔒 Your role cannot send channel messages — requires the admin or operator role.' });
      return;
    }
    setSending(true);
    setSendMsg(null);
    const r = await dashboardAPI.sendChannelMessage(sendTarget.trim(), sendText);
    if (r.ok) {
      setSendMsg({ kind: 'ok', text: `✅ Sent to ${sendTarget.trim()} (${r.platform}:${showId(r.channelId)})` });
      setSendText('');
    } else if (r.unauthorized) {
      sessionExpired();
      setSendMsg({ kind: 'err', text: r.error || 'Session expired — log in again.' });
    } else {
      setSendMsg({ kind: 'err', text: r.error || 'Send failed.' });
    }
    setSending(false);
  };

  /** The SAVED policy id list for a key — what the draft edits ON TOP of. */
  const savedPolicyIds = (platform: string, key: 'allowedUsers' | 'allowedGroups'): string[] => {
    const saved = (data?.channels?.policies?.[platform] ?? {}) as HubChannelPolicy;
    return saved[key] ?? [];
  };

  /**
   * P1 — add a user/group id to a platform's allowed list (draft only). The
   * draft is seeded from the SAVED list when it has no entry for the key, so
   * adding ONE user never hides (and on save, never silently deletes) the
   * rest of the saved list.
   */
  const addPolicyId = (platform: string, kind: 'user' | 'group', value: string) => {
    const id = value.trim();
    if (!id) return;
    setPolicyDraft((prev) => {
      const pol = { ...(prev[platform] ?? {}) };
      const key = kind === 'user' ? 'allowedUsers' : 'allowedGroups';
      const base = prev[platform]?.[key] ?? savedPolicyIds(platform, key);
      const list = [...base];
      if (!list.includes(id)) list.push(id);
      pol[key] = list;
      return { ...prev, [platform]: pol };
    });
  };

  /**
   * P1 — remove a user/group id from a platform's allowed list (draft only).
   * Seeded from the SAVED list too, so removing ONE entry keeps the rest of
   * the saved ones visible. Writing the list back — even when empty — keeps
   * the explicit "these are the allowed ids" statement (empty = no one may
   * trigger, per the verified-list rule). One guard: when nothing was saved
   * for this platform AND nothing remains after the removal, the draft key is
   * dropped so an OPEN platform stays open instead of flipping to "blank =
   * none" from a stray ✕.
   */
  const removePolicyId = (platform: string, kind: 'user' | 'group', id: string) => {
    setPolicyDraft((prev) => {
      const key = kind === 'user' ? 'allowedUsers' : 'allowedGroups';
      const saved = savedPolicyIds(platform, key);
      const base = prev[platform]?.[key] ?? saved;
      const next = base.filter((x) => x !== id);
      if (next.length === 0 && saved.length === 0) {
        // No saved list before and nothing left after — no change needed.
        const pol = { ...(prev[platform] ?? {}) };
        delete pol[key];
        const updated = { ...prev };
        if (Object.keys(pol).length === 0) delete updated[platform];
        else updated[platform] = pol;
        return updated;
      }
      const pol = { ...(prev[platform] ?? {}) };
      pol[key] = next;
      return { ...prev, [platform]: pol };
    });
  };

  /** Digit/format-tolerant sender-id equality (mirrors the gateway's normalize). */
  const sameVerifiedId = (a: string, b: string): boolean => {
    const na = a.trim().toLowerCase();
    const nb = b.trim().toLowerCase();
    if (na === '*' || nb === '*') return true; // Allow-All wildcard
    if (na === nb) return true;
    const da = na.replace(/\D+/g, '');
    const db = nb.replace(/\D+/g, '');
    return da.length > 0 && da === db;
  };

  /**
   * P1 — add a verified USER as <Name> <Contact No> (CLI parity): the number
   * goes into the allowedUsers draft, the name into the saved-contacts list.
   */
  const addVerifiedUser = (platform: string) => {
    const name = (contactNameInput[platform] ?? '').trim();
    const id = (policyUserInput[platform] ?? '').trim();
    if (!id) return;
    addPolicyId(platform, 'user', id);
    if (name) {
      setContacts((prev) => {
        const rest = prev.filter(
          (c) => !(c.platform === platform && (sameVerifiedId(c.id, id) || c.name.toLowerCase() === name.toLowerCase())),
        );
        return [...rest, { name, platform, id, addedAt: Date.now() }];
      });
    }
    setPolicyUserInput((s) => ({ ...s, [platform]: '' }));
    setContactNameInput((s) => ({ ...s, [platform]: '' }));
  };

  /** P1 — remove a verified user: allowedUsers draft + its saved contact. */
  const removeVerifiedUser = (platform: string, id: string) => {
    removePolicyId(platform, 'user', id);
    setContacts((prev) => prev.filter((c) => !(c.platform === platform && sameVerifiedId(c.id, id))));
  };

  /** P1 — remove a saved contact from the validated list (+ its allowedUsers). */
  const removeContact = (c: HubContact) => {
    setContacts((prev) => prev.filter((x) => !(x.platform === c.platform && sameVerifiedId(x.id, c.id))));
    removePolicyId(c.platform, 'user', c.id);
  };

  /** P1 — toggle a boolean policy flag on a platform (draft only). */
  const togglePolicyFlag = (platform: string, flag: 'silentDrop' | 'disabled' | 'requireMention') => {
    setPolicyDraft((prev) => {
      const pol = { ...(prev[platform] ?? {}) };
      if (flag === 'silentDrop') {
        // HARD POLICY: silent is the default — turning the toggle OFF must
        // write `silentDrop: false` (polite opt-in), NOT delete the key
        // (deleting would keep the silent default).
        pol.silentDrop = pol.silentDrop === false ? true : false;
      } else if (pol[flag]) delete pol[flag];
      else pol[flag] = true;
      return { ...prev, [platform]: pol };
    });
  };

  /**
   * True when the Permissions section has UNSAVED changes (the draft holds
   * edits, or contacts / status recipients differ from what was loaded). The
   * whole reason this exists: "+ User" only edits the local draft — without
   * a visible unsaved indicator, users add a contact, see the chip appear,
   * and assume it's saved when it isn't (until "💾 Save permissions").
   */
  const hasUnsavedPolicyChanges =
    Object.keys(policyDraft).length > 0 ||
    (contacts.length !== (data?.channels?.contacts?.length ?? 0)) ||
    contacts.some(
      (c, i) =>
        !data?.channels?.contacts?.[i] ||
        c.platform !== data.channels.contacts[i].platform ||
        c.id !== data.channels.contacts[i].id ||
        c.name !== data.channels.contacts[i].name,
    ) ||
    (statusRecipients.length !== (data?.channels?.statusRecipients?.length ?? 0)) ||
    statusRecipients.some((r, i) => r !== data?.channels?.statusRecipients?.[i]);

  /** P1 — save the draft policies to the gateway config (admin/operator only). */
  const handleSavePolicies = async () => {
    if (!authed) {
      setPolicyMsg({ kind: 'err', text: '🔐 Log in (or set up admin access) to change permissions.' });
      return;
    }
    if (!canWrite) {
      setPolicyMsg({ kind: 'err', text: '🔒 Your role cannot change permissions — requires the admin or operator role.' });
      return;
    }
    setPolicyBusy(true);
    setPolicyMsg(null);
    const r = await dashboardAPI.saveGatewayPolicies(policyDraft, statusRecipients, contacts);
    if (r.ok) {
      const warnMsg = r.contactErrors?.length ? `\n⚠️ Some contacts were rejected: ${r.contactErrors.join('; ')}` : '';
      setPolicyMsg({ kind: warnMsg ? 'warn' : 'ok', text: `✅ Permissions + saved contacts + status recipients saved — the running gateway applies them immediately.${warnMsg}` });
      setPolicyDraft({});
      void refresh();
    } else if (r.unauthorized) {
      sessionExpired();
      setPolicyMsg({ kind: 'err', text: r.error || 'Session expired — log in again.' });
    } else {
      setPolicyMsg({ kind: 'err', text: r.error || 'Failed to save permissions.' });
    }
    setPolicyBusy(false);
  };

  // ─── Loading / auth gate ─────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="admin-header">
        <h2 className="section-title">🧰 Agent Hub</h2>
        <div className="loading-state"><div className="loading-spinner" /><p>Loading hub…</p></div>
      </div>
    );
  }

  const needsAuth = !authed && pendingToggle !== null;

  return (
    <>
      <div className="admin-header">
        <h2 className="section-title">
          🧰 Agent Hub
          {userName ? (
            <span className={`admin-role-badge admin-role-${role || 'viewer'}`}>
              {userName} · {role || 'viewer'}
            </span>
          ) : null}
        </h2>
        <div className="admin-header-actions">
          <button className="admin-refresh-btn" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? '⏳ Refreshing…' : '🔄 Refresh'}
          </button>
          {authed ? (
            <button className="admin-logout-btn" onClick={() => void handleLogout()}>🚪 Log out</button>
          ) : null}
        </div>
      </div>

      <p className="admin-subtitle">
        Capabilities, messaging, artifacts and skills in one place — a single 4-view
        management page. Toggles persist to <code>buffconfig</code> and are
        honored by the runtime immediately (never cosmetic).
      </p>

      {error ? <div className="admin-error">{error}</div> : null}

      {/* ── Auth banner (only when a toggle was attempted) ───────────────── */}
      {needsAuth ? (
        <div className="admin-header">
          <h3 className="section-subtitle">
            {!authStatus?.configured
              ? `🔐 Set up admin access to ${pendingToggle.enabled ? 'enable' : 'disable'} '${pendingToggle.name}'`
              : `🔐 Log in to ${pendingToggle.enabled ? 'enable' : 'disable'} '${pendingToggle.name}'`}
          </h3>
          <form className="admin-gate-form" onSubmit={authStatus?.configured ? handleLogin : handleSetup}>
            <label>
              <span>Username</span>
              <input type="text" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" placeholder="admin" />
            </label>
            <label>
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={authStatus?.configured ? 'current-password' : 'new-password'}
                placeholder="••••••••"
              />
            </label>
            {authError ? <div className="admin-error">{authError}</div> : null}
            <button className="admin-refresh-btn" type="submit" disabled={authBusy || !user || !password}>
              {authBusy ? '⏳ …' : authStatus?.configured ? '🔐 Log in & apply' : '🔐 Create admin & apply'}
            </button>
            {!authStatus?.configured ? (
              <p className="admin-hint">
                The first user is always an admin. Automation alternative: set{' '}
                <code>BUFF_DASHBOARD_ADMIN_USER</code> / <code>BUFF_DASHBOARD_ADMIN_PASSWORD</code>.
              </p>
            ) : null}
          </form>
        </div>
      ) : null}

      {!needsAuth && !canWrite && authed ? (
        <div className="admin-readonly-note">
          🔒 Your role (<code>{role || 'viewer'}</code>) can view but not change capabilities —
          toggles require the <code>admin</code> or <code>operator</code> role.
        </div>
      ) : null}

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <div className="hub-tabs" role="tablist">
        {TABS.map((t) => {
          const count =
            t.id === 'tools' ? (data ? `${data.toolsets.enabled}/${data.toolsets.toolsets.length}` : '')
            : t.id === 'channels' ? (data ? String(data.channels.delivery.total) : '')
            : t.id === 'conversations' ? (data ? String(data.conversations?.total ?? 0) : '')
            : t.id === 'artifacts' ? (data ? String(data.artifacts.totalSessions) : '')
            : (data ? `${data.skills.enabled}/${data.skills.total}` : '');
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`hub-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.icon} {t.label}
              {count ? <span className="hub-tab-count">{count}</span> : null}
            </button>
          );
        })}
      </div>

      {/* ── Tools tab ────────────────────────────────────────────────────── */}
      {tab === 'tools' && data ? (
        <div role="tabpanel">
          <div className="admin-summary-grid">
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.toolsets.enabled}</div>
              <div className="admin-summary-label">Enabled toolsets</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.toolsets.disabled}</div>
              <div className="admin-summary-label">Disabled toolsets</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.toolsets.totalTools}</div>
              <div className="admin-summary-label">Registered tools</div>
            </div>
          </div>
          <div className="hub-toolset-grid">
            {data.toolsets.toolsets.map((t: HubToolset) => (
              <div className={`hub-card${t.enabled ? '' : ' hub-card-disabled'}`} key={t.name}>
                <div className="hub-card-top">
                  <div className="hub-card-title">
                    <span className="hub-card-name">{t.label}</span>
                    <span className="hub-card-id">{t.name}</span>
                  </div>
                  <button
                    role="switch"
                    aria-checked={t.enabled}
                    aria-label={`${t.enabled ? 'Disable' : 'Enable'} ${t.label}`}
                    className={`hub-switch${t.enabled ? ' on' : ''}`}
                    // Disabled while a toggle is in flight, once a toggle is
                    // queued behind the login gate (no flip-flopping), or when
                    // an AUTHENTICATED role lacks permission (viewer). When
                    // not authenticated the switch stays clickable — it queues
                    // the toggle behind the login gate instead of failing.
                    disabled={toggling === t.name || pendingToggle !== null || (authed && !canWrite)}
                    onClick={() => toggleToolset(t.name, !t.enabled)}
                  >
                    <span className="hub-switch-knob" />
                  </button>
                </div>
                <p className="hub-card-desc">{t.description}</p>
                <div className="hub-card-tools">
                  {t.tools.length > 0
                    ? t.tools.map((tool) => <span className="hub-chip" key={tool}>{tool}</span>)
                    : <span className="admin-hint">gates dynamic MCP tools (no static names)</span>}
                </div>
                {rowMsg[t.name] ? <div className="admin-row-msg">{rowMsg[t.name]}</div> : null}
                {!t.enabled ? <div className="hub-card-note">⛔ Removed from the model schema — calls return an explicit error</div> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── Channels tab ─────────────────────────────────────────────────── */}
      {tab === 'channels' && data ? (
        <div role="tabpanel">
          <div className="hub-reveal-row">
            <label className="hub-reveal-toggle">
              <input
                type="checkbox"
                checked={revealIds}
                onChange={(e) => setRevealIds(e.target.checked)}
                disabled={!canWrite}
              />
              Show full sender ids <span className="admin-hint">(masks phone numbers by default)</span>
            </label>
            {!canWrite ? <span className="admin-hint">— admins and operators only</span> : null}
          </div>
          <div className="admin-summary-grid">
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.channels.delivery.pending}</div>
              <div className="admin-summary-label">⏳ Queued for retry</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.channels.delivery.sent}</div>
              <div className="admin-summary-label">✅ Delivered</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.channels.delivery.failed}</div>
              <div className="admin-summary-label">❌ Failed (max retries)</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.channels.aliases.length}</div>
              <div className="admin-summary-label">Channel aliases</div>
            </div>
          </div>

          <h3 className="section-subtitle">📮 Delivery ledger (guaranteed delivery)</h3>
          {data.channels.delivery.recent.length > 0 ? (
            <div className="admin-table-wrapper">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Target</th>
                    <th>Platform</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Next retry</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {data.channels.delivery.recent.map((e) => (
                    <tr key={e.id}>
                      <td className="admin-provider-type">{showId(e.target)}</td>
                      <td>{e.platform}</td>
                      <td>
                        <span className={`admin-check-badge admin-check-${e.status === 'sent' ? 'pass' : e.status === 'failed' ? 'fail' : 'warn'}`}>
                          {STATUS_LABEL[e.status] || e.status}
                        </span>
                      </td>
                      <td>{e.attempts}/5</td>
                      <td>
                        {e.status === 'pending'
                          ? `${Math.max(0, Math.round((e.nextAttemptAt - Date.now()) / 1000))}s`
                          : '—'}
                      </td>
                      <td className="admin-hint">{e.lastError ? `⚠️ ${e.lastError}` : (e.text || '').slice(0, 60)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">Delivery ledger is empty — every gateway send has gone through.</div>
          )}

          <h3 className="section-subtitle">📥 Inbox (received messages)</h3>
          {data.channels.inbox.recent.length > 0 ? (
            <div className="admin-table-wrapper">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Platform</th>
                    <th>From</th>
                    <th>Message</th>
                    <th>Handled</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.channels.inbox.recent.map((e) => (
                    <tr key={e.id}>
                      <td className="admin-provider-type">
                        {e.platform}
                        {e.isGroup ? <span className="hub-chip">group</span> : null}
                      </td>
                      <td>{showId(e.from || e.senderId || e.channelId)}</td>
                      <td className="admin-hint">{(e.text || '').slice(0, 60)}</td>
                      <td>
                        <span className={`admin-check-badge admin-check-${e.handled === 'pipeline' ? 'pass' : e.handled === 'refused' ? 'fail' : 'warn'}`}>
                          {e.handled}
                        </span>
                        {e.reply ? <div className="admin-hint">{e.reply.slice(0, 40)}</div> : null}
                      </td>
                      <td className="admin-hint">{new Date(e.at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">Inbox is empty — messages the gateway receives will appear here.</div>
          )}
          <p className="admin-hint">
            {data.channels.inbox.total} received · {data.channels.inbox.pipeline} triggered the pipeline ·{' '}
            {data.channels.inbox.help} got the help line · {data.channels.inbox.refused} refused by policy.
          </p>

          <h3 className="section-subtitle">🔌 Platform transports</h3>
          <PlatformConfigSection canWrite={canWrite} sessionExpired={sessionExpired} mode="table" />

          <h3 className="section-subtitle">🔗 Channel aliases (buff gateway status)</h3>
          {data.channels.aliases.length > 0 ? (
            <div className="hub-alias-list">
              {data.channels.aliases.map((a) => (
                <div className="hub-alias-row" key={a.alias}>
                  <span className="hub-chip">{a.alias}</span>
                  <span className="admin-hint">→ {a.platform}:{showId(a.channelId)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              No aliases yet — register one with <code>buff gateway alias &lt;name&gt; &lt;platform&gt; &lt;channelId&gt;</code>.
            </div>
          )}

          {hasUnsavedPolicyChanges ? (
            <div className="hub-unsaved-banner" role="status">
              <span>
                ⚠️ <strong>Unsaved changes</strong> — what you see below is a <em>draft</em>. Press{' '}
                <strong>💾 Save permissions</strong> to apply it to the gateway; leaving the page discards it.
              </span>
              <button className="admin-refresh-btn" type="button" disabled={policyBusy} onClick={() => void handleSavePolicies()}>
                {policyBusy ? '⏳ Saving…' : '💾 Save permissions'}
              </button>
            </div>
          ) : null}
          <h3 className="section-subtitle">🔐 Permissions — who can TRIGGER the agent</h3>
          <p className="admin-hint">
            This list controls <strong>who may trigger the agent</strong> when they message you on each
            platform (WhatsApp, Telegram, email, …). A sender on the list gets a reply; everyone else is
            refused. Per platform: a listed sender/group is allowed; a <strong>blank</strong> list means{' '}
            <strong>no one</strong> may trigger; the token <code>Allow-All</code> skips the verifier and
            responds to everyone. <strong>Silent</strong> refuses without replying. Changes apply to the
            running gateway immediately.
          </p>
          <div className="admin-hint" style={{ marginBottom: 10 }}>
            ⚠ <strong>Not the same as send-by-name contacts:</strong> a WhatsApp contact name (from{' '}
            <code>buff whatsapp contact add</code>, shown in the WhatsApp bridge panel below) only lets{' '}
            <em>you</em> send <em>to</em> it by name — it does <strong>not</strong> let that number trigger
            the agent. Add the number here (or <code>buff config gateway allow &lt;platform&gt; user
            &lt;id&gt;</code>) to grant inbound access.
          </div>
          <div className="hub-permissions">
            {data.channels.platforms.map((p) => {
              // Merge the draft OVER the saved policy: a partial draft (e.g. a
              // single removed user, or a flag toggle) must not blank the
              // saved list — otherwise removing one contact hid all of them.
              const pol = { ...(data.channels.policies[p.platform] ?? {}), ...(policyDraft[p.platform] ?? {}) };
              const users = pol.allowedUsers ?? [];
              const groups = pol.allowedGroups ?? [];
              return (
                <div className="hub-card" key={p.platform}>
                  <div className="hub-card-top">
                    <span className="hub-chip">{p.label}</span>
                    <span className="hub-card-id">{p.platform}</span>
                    {pol.disabled ? <span className="hub-chip">disabled</span> : null}
                  </div>
                  <div className="admin-hint" style={{ margin: '4px 0 8px' }}>Allowed users — who may trigger the agent</div>
                  <div className="hub-alias-list">
                    {users.length === 0 ? <span className="admin-hint">(blank — no one may trigger; add <code>Allow-All</code> to allow everyone)</span> : null}
                    {users.map((u) => {
                      // A chip that only exists in the DRAFT (not yet saved) is
                      // marked pending so adding a user can't be mistaken for
                      // having saved it.
                      const pending = (policyDraft[p.platform]?.allowedUsers ?? []).includes(u) &&
                        !(data?.channels?.policies?.[p.platform]?.allowedUsers ?? []).includes(u);
                      return (
                        <div className="hub-alias-row" key={`u-${u}`}>
                          <span className={`hub-chip${pending ? ' hub-chip-pending' : ''}`} title={pending ? 'Not saved yet — press 💾 Save permissions' : undefined}>
                            {showId(u)}{pending ? ' · pending' : ''}
                          </span>
                          <button className="admin-refresh-btn" disabled={policyBusy} onClick={() => removeVerifiedUser(p.platform, u)}>✕</button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="hub-send-form" style={{ margin: '6px 0 10px' }}>
                    <input
                      type="text"
                      value={contactNameInput[p.platform] ?? ''}
                      onChange={(e) => setContactNameInput((s) => ({ ...s, [p.platform]: e.target.value }))}
                      placeholder="Name (optional)"
                      disabled={policyBusy}
                    />
                    <input
                      type="text"
                      value={policyUserInput[p.platform] ?? ''}
                      onChange={(e) => setPolicyUserInput((s) => ({ ...s, [p.platform]: e.target.value }))}
                      placeholder="Contact no / sender id, or Allow-All"
                      disabled={policyBusy}
                    />
                    <button
                      className="admin-refresh-btn"
                      disabled={policyBusy || !(policyUserInput[p.platform] ?? '').trim()}
                      onClick={() => addVerifiedUser(p.platform)}
                    >+ User</button>
                  </div>
                  <div className="admin-hint" style={{ margin: '4px 0 8px' }}>Allowed groups</div>
                  <div className="hub-alias-list">
                    {groups.length === 0 ? <span className="admin-hint">(none — any group may trigger)</span> : null}
                    {groups.map((g) => {
                      const pending = (policyDraft[p.platform]?.allowedGroups ?? []).includes(g) &&
                        !(data?.channels?.policies?.[p.platform]?.allowedGroups ?? []).includes(g);
                      return (
                        <div className="hub-alias-row" key={`g-${g}`}>
                          <span className={`hub-chip${pending ? ' hub-chip-pending' : ''}`} title={pending ? 'Not saved yet — press 💾 Save permissions' : undefined}>
                            {g}{pending ? ' · pending' : ''}
                          </span>
                          <button className="admin-refresh-btn" disabled={policyBusy} onClick={() => removePolicyId(p.platform, 'group', g)}>✕</button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="hub-send-form" style={{ margin: '6px 0 10px' }}>
                    <input
                      type="text"
                      value={policyGroupInput[p.platform] ?? ''}
                      onChange={(e) => setPolicyGroupInput((s) => ({ ...s, [p.platform]: e.target.value }))}
                      placeholder="group id, e.g. 1203630283471234@g.us"
                      disabled={policyBusy}
                    />
                    <button
                      className="admin-refresh-btn"
                      disabled={policyBusy || !(policyGroupInput[p.platform] ?? '').trim()}
                      onClick={() => { addPolicyId(p.platform, 'group', policyGroupInput[p.platform] ?? ''); setPolicyGroupInput((s) => ({ ...s, [p.platform]: '' })); }}
                    >+ Group</button>
                  </div>
                  <div className="hub-send-form" style={{ margin: '6px 0 0' }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 12 }}>
                      <input type="checkbox" checked={pol.silentDrop !== false} disabled={policyBusy} onChange={() => togglePolicyFlag(p.platform, 'silentDrop')} />
                      <span className="admin-hint">Silent (no reply to unapproved) — default</span>
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 12 }}>
                      <input type="checkbox" checked={Boolean(pol.requireMention)} disabled={policyBusy} onChange={() => togglePolicyFlag(p.platform, 'requireMention')} />
                      <span className="admin-hint">Groups: mention only</span>
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <input type="checkbox" checked={Boolean(pol.disabled)} disabled={policyBusy} onChange={() => togglePolicyFlag(p.platform, 'disabled')} />
                      <span className="admin-hint">Disabled (off)</span>
                    </label>
                  </div>
                </div>
              );
            })}
          </div>

          <h3 className="section-subtitle" style={{ marginTop: 22 }}>📇 Telegram User Onboarding</h3>
          <div className="onboarding-summary">
            <p className="admin-hint" style={{ marginBottom: 12 }}>
              Users who message your bot are auto-registered here. Approve them to enable outbound messaging.
            </p>
            {(() => {
              const pending = contacts.filter((c) => c.status === 'pending').length;
              const approved = contacts.filter((c) => c.status === 'approved').length;
              const rejected = contacts.filter((c) => c.status === 'rejected').length;
              return (
                <div className="onboarding-stats">
                  <span className="onboarding-stat pending">⏳ {pending} pending</span>
                  <span className="onboarding-stat approved">✅ {approved} approved</span>
                  <span className="onboarding-stat rejected">🚫 {rejected} rejected</span>
                </div>
              );
            })()}
            <div className="onboarding-steps">
              <div className="onboarding-step">
                <span className="onboarding-step-num">1</span>
                <span>User sends any message to <code>@agent_nuvira_bot</code></span>
              </div>
              <div className="onboarding-step">
                <span className="onboarding-step-num">2</span>
                <span>Bot auto-registers them as <strong>⏳ pending</strong></span>
              </div>
              <div className="onboarding-step">
                <span className="onboarding-step-num">3</span>
                <span>Admin approves → they can receive outbound messages</span>
              </div>
            </div>
            <a href="/contacts" className="admin-refresh-btn" style={{ marginTop: 12, display: 'inline-block', textDecoration: 'none' }}>
              📋 Go to Contacts tab to manage →
            </a>
          </div>

          <h3 className="section-subtitle" style={{ marginTop: 22 }}>📊 Status recipients</h3>
          <p className="admin-hint">
            Contacts/groups that ALWAYS receive the pipeline completion summary, whoever triggered it.
            Use a contact name, number, or <code>platform:channelId</code> — e.g.{' '}
            <code>whatsapp:Name</code>, <code>whatsapp:+91***</code>, <code>telegram:123456</code>,{' '}
            <code>slack:ops</code>.
          </p>
          {statusRecipients.length > 0 ? (
            <div className="hub-alias-list">
              {statusRecipients.map((t) => (
                <div className="hub-alias-row" key={t}>
                  <span className="hub-chip">📊</span>
                  <span className="admin-hint">{data?.channels?.statusRecipientDisplay?.[t] ?? t}</span>
                  <button className="admin-refresh-btn" disabled={policyBusy} onClick={() => setStatusRecipients((s) => s.filter((x) => x !== t))}>✕</button>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state" style={{ padding: '14px' }}>No status recipients — add one below.</div>
          )}
          <div className="hub-send-form">
            <input
              type="text"
              value={statusRecipientInput}
              onChange={(e) => setStatusRecipientInput(e.target.value)}
              placeholder="whatsapp:Name or whatsapp:+91***"
              disabled={policyBusy}
              maxLength={128}
            />
            <button
              className="admin-refresh-btn"
              disabled={policyBusy || !statusRecipientInput.trim() || statusRecipients.includes(statusRecipientInput.trim())}
              onClick={() => { setStatusRecipients((s) => [...s, statusRecipientInput.trim()]); setStatusRecipientInput(''); }}
            >+ Add</button>
          </div>
          <div className="hub-send-form" style={{ marginTop: 10 }}>
            <button className="admin-refresh-btn" type="button" disabled={policyBusy} onClick={() => void handleSavePolicies()}>
              {policyBusy ? '⏳ Saving…' : '💾 Save permissions'}
            </button>
            {Object.keys(policyDraft).length > 0 ? (
              <button className="admin-refresh-btn" type="button" disabled={policyBusy} onClick={() => setPolicyDraft({})}>
                Discard draft
              </button>
            ) : null}
          </div>
          {policyMsg ? (
            <div className={`admin-row-msg${policyMsg.kind === 'ok' ? '' : ' admin-row-msg-err'}`}>{policyMsg.text}</div>
          ) : null}

          <h3 className="section-subtitle">📤 Test a channel (buff gateway send)</h3>
          <form className="hub-send-form" onSubmit={(e) => void handleSendMessage(e)}>
            <label className="hub-send-target">
              <span className="admin-hint">Target — an alias or platform:channelId</span>
              <input
                type="text"
                value={sendTarget}
                onChange={(e) => setSendTarget(e.target.value)}
                placeholder="ops or slack:C0123 or email:team@example.com"
                disabled={sending}
                maxLength={128}
              />
            </label>
            <label className="hub-send-message">
              <span className="admin-hint">Message</span>
              <input
                type="text"
                value={sendText}
                onChange={(e) => setSendText(e.target.value)}
                placeholder="nightly build done 🎉"
                disabled={sending}
                maxLength={4000}
              />
            </label>
            <button className="admin-refresh-btn" type="submit" disabled={sending || !sendTarget.trim() || !sendText}>
              {sending ? '⏳ Sending…' : '📤 Send test message'}
            </button>
          </form>
          {sendMsg ? (
            <div className={`admin-row-msg${sendMsg.kind === 'ok' ? '' : ' admin-row-msg-err'}`}>{sendMsg.text}</div>
          ) : null}
          <p className="admin-hint">
            Sends through the same gateway the CLI uses — the dashboard process must have the
            platform's env token set (e.g. <code>BUFF_SMTP_HOST</code>). Requires admin or operator.
          </p>

          <h3 className="section-subtitle">🟢 WhatsApp bridge (buff whatsapp pair)</h3>
          <WhatsAppPanel authed={authed} canWrite={canWrite} sessionExpired={sessionExpired} reveal={revealIds} />
        </div>
      ) : null}

      {/* ── Conversations tab ──────────────────────────────────────────── */}
      {tab === 'conversations' && data ? (
        <div role="tabpanel">
          <div className="admin-summary-grid">
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.conversations?.total ?? 0}</div>
              <div className="admin-summary-label">Stored conversations</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{convList.filter((c) => Date.now() - c.lastActiveAt < 86_400_000).length}</div>
              <div className="admin-summary-label">Active today</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{convList.filter((c) => c.platform === 'whatsapp').length}</div>
              <div className="admin-summary-label">WhatsApp</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{convList.filter((c) => c.platform === 'telegram').length}</div>
              <div className="admin-summary-label">Telegram</div>
            </div>
          </div>
          {/* Analytics toggle + section */}
          {data.conversations?.analytics && data.conversations.analytics.totalConversations > 0 && (
            <>
              <button
                type="button"
                className="admin-refresh-btn"
                onClick={() => setShowAnalytics(!showAnalytics)}
                style={{ marginBottom: 12 }}
              >
                {showAnalytics ? '📊 Hide Analytics' : '📊 Show Analytics'}
              </button>
              {showAnalytics ? (
                <div className="hub-session-list" style={{ marginBottom: 16 }}>
                  {/* Summary stats */}
                  <div className="admin-summary-grid">
                    <div className="admin-summary-card">
                      <div className="admin-summary-value">{data.conversations.analytics.totalMessages}</div>
                      <div className="admin-summary-label">Total messages</div>
                    </div>
                    <div className="admin-summary-card">
                      <div className="admin-summary-value">{data.conversations.analytics.avgMessagesPerConversation}</div>
                      <div className="admin-summary-label">Avg msgs/conversation</div>
                    </div>
                    <div className="admin-summary-card">
                      <div className="admin-summary-value">{data.conversations.analytics.avgUserMessageLength}</div>
                      <div className="admin-summary-label">Avg user msg length</div>
                    </div>
                    <div className="admin-summary-card">
                      <div className="admin-summary-value">{data.conversations.analytics.avgAssistantMessageLength}</div>
                      <div className="admin-summary-label">Avg assistant msg length</div>
                    </div>
                  </div>
                  {/* Top contacts */}
                  <div className="hub-card" style={{ marginTop: 12 }}>
                    <div className="hub-card-top">
                      <div className="hub-card-title">
                        <span className="hub-card-name">🏆 Most Active Contacts</span>
                      </div>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      {data.conversations.analytics.topContacts.map((c, i) => {
                        const maxCount = data.conversations!.analytics.topContacts[0]?.messageCount || 1;
                        const pct = Math.round((c.messageCount / maxCount) * 100);
                        return (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', marginBottom: 6, fontSize: 13 }}>
                            <span style={{ width: 24, textAlign: 'center', fontWeight: 600, color: i < 3 ? '#f59e0b' : 'var(--muted)' }}>
                              {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`}
                            </span>
                            <span style={{ flex: 1, marginLeft: 8 }}>
                              {c.platform === 'whatsapp' ? '📱' : '✈️'} {c.name}
                            </span>
                            <span style={{ width: 60, textAlign: 'right', fontWeight: 600 }}>{c.messageCount}</span>
                            <div style={{ width: 100, height: 8, background: 'var(--border)', borderRadius: 4, marginLeft: 8 }}>
                              <div style={{ width: `${pct}%`, height: '100%', background: '#3b82f6', borderRadius: 4 }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {/* Hourly distribution */}
                  <div className="hub-card" style={{ marginTop: 12 }}>
                    <div className="hub-card-top">
                      <div className="hub-card-title">
                        <span className="hub-card-name">🕐 Peak Hours</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'flex-end', height: 80, marginTop: 8, gap: 2 }}>
                      {data.conversations.analytics.hourlyDistribution.map(({ hour, count }) => {
                        const maxCount = Math.max(...data.conversations!.analytics.hourlyDistribution.map((h) => h.count), 1);
                        const h = Math.round((count / maxCount) * 70);
                        return (
                          <div key={hour} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                            <div
                              style={{ width: '100%', height: h, background: hour >= 9 && hour <= 21 ? '#3b82f6' : '#6b7280', borderRadius: 2 }}
                              title={`${hour}:00 — ${count} messages`}
                            />
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ display: 'flex', fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
                      {[0, 6, 12, 18, 23].map((h) => (
                        <span key={h} style={{ flex: 1, textAlign: h === 0 ? 'left' : h === 23 ? 'right' : 'center' }}>{h}:00</span>
                      ))}
                    </div>
                  </div>
                  {/* Platform breakdown */}
                  <div className="hub-card" style={{ marginTop: 12 }}>
                    <div className="hub-card-top">
                      <div className="hub-card-title">
                        <span className="hub-card-name">📱 Platform Breakdown</span>
                      </div>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      {data.conversations.analytics.platformBreakdown.map((p) => (
                        <div key={p.platform} style={{ display: 'flex', alignItems: 'center', marginBottom: 6, fontSize: 13 }}>
                          <span className="hub-chip" style={{ width: 80, textAlign: 'center' }}>{p.platform}</span>
                          <span style={{ marginLeft: 8, flex: 1 }}>{p.conversations} conversations</span>
                          <span style={{ fontWeight: 600 }}>{p.messages} msgs</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {/* Daily volume (last 14 days) */}
                  <div className="hub-card" style={{ marginTop: 12 }}>
                    <div className="hub-card-top">
                      <div className="hub-card-title">
                        <span className="hub-card-name">📈 Daily Volume (14 days)</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'flex-end', height: 60, marginTop: 8, gap: 2 }}>
                      {data.conversations.analytics.dailyVolume.map(({ date, count }) => {
                        const maxCount = Math.max(...data.conversations!.analytics.dailyVolume.map((d) => d.count), 1);
                        const h = Math.round((count / maxCount) * 50);
                        return (
                          <div key={date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                            <div
                              style={{ width: '100%', height: h, background: '#10b981', borderRadius: 2 }}
                              title={`${date}: ${count} messages`}
                            />
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
                      <span>{data.conversations.analytics.dailyVolume[0]?.date}</span>
                      <span>{data.conversations.analytics.dailyVolume[data.conversations.analytics.dailyVolume.length - 1]?.date}</span>
                    </div>
                  </div>
                </div>
              ) : null}
            </>
          )}
          <h3 className="section-subtitle">💬 Per-contact chat history</h3>
          <p className="admin-hint">Conversation history is stored per-contact and survives gateway restarts. Messages older than 7 days are auto-pruned. Click a conversation to expand the full chat thread.</p>
          {convList.length > 0 || convLoading ? (
            <>
              {/* Tag filter chips */}
              {allTags.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                  <span className="admin-hint" style={{ marginRight: 4 }}>Filter by tag:</span>
                  {allTags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setTagFilter(tagFilter === tag ? '' : tag)}
                      style={{ padding: '2px 10px', borderRadius: 12, fontSize: 11, cursor: 'pointer', border: `1px solid ${tagFilter === tag ? '#3b82f6' : 'var(--border)'}`, background: tagFilter === tag ? '#3b82f620' : 'transparent', color: tagFilter === tag ? '#3b82f6' : 'var(--muted)' }}
                    >
                      🏷️ {tag}
                    </button>
                  ))}
                </div>
              )}
              {/* Search filter + selection toolbar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={convSearch}
                  onChange={(e) => setConvSearch(e.target.value)}
                  placeholder="🔍 Search by contact name, phone number, or message content…"
                  style={{ flex: 1, minWidth: 200 }}
                />
                <span className="admin-hint">
                  {convTotal} conversation{convTotal === 1 ? '' : 's'}
                  {convSearch ? ` matching "${convSearch}"` : ''}
                </span>
                <button type="button" className="admin-refresh-btn" onClick={toggleSelectAll} style={{ fontSize: 12, padding: '4px 10px' }}>
                  {selectedConvs.size === convList.length ? '☑ Deselect All' : '☐ Select All'}
                </button>
                {selectedConvs.size > 0 && (
                  <button
                    type="button"
                    className="admin-refresh-btn"
                    disabled={exporting}
                    onClick={() => void handleBulkExport()}
                    style={{ fontSize: 12, padding: '4px 10px', background: '#3b82f6', color: '#fff', border: 'none' }}
                  >
                    {exporting ? '⏳ Exporting…' : `📦 Export ${selectedConvs.size} as ZIP`}
                  </button>
                )}
              </div>
              {/* Conversation cards (not a table — each card expands into a chat thread) */}
              <div className="hub-session-list">
                {convList
                  .filter((c) => !tagFilter || (c.tags ?? []).includes(tagFilter))
                  .map((c) => {
                    const age = Date.now() - c.lastActiveAt;
                    const ageStr = age < 60_000 ? 'just now' : age < 3_600_000 ? `${Math.round(age / 60_000)}m ago` : age < 86_400_000 ? `${Math.round(age / 3_600_000)}h ago` : `${Math.round(age / 86_400_000)}d ago`;
                    const isExpanded = expandedConv === c.key;
                    const { name: displayName, phone } = convDisplayLabel(c);
                    const handleClear = async (e: React.MouseEvent) => {
                      e.stopPropagation();
                      if (!authed || !canWrite) {
                        setPolicyMsg({ kind: 'err', text: '🔐 Log in (admin/operator) to clear conversations.' });
                        return;
                      }
                      setClearingConv(c.key);
                      try {
                        // We need a DELETE endpoint — for now call the gateway history CLI endpoint.
                        // TODO: Add proper API endpoint.
                        await dashboardAPI.clearGatewayConversation(c.key);
                        void refresh();
                      } catch { /* best-effort */ }
                      setClearingConv(null);
                    };
                    const isSelected = selectedConvs.has(c.key);
                    return (
                      <div
                        className="hub-card"
                        key={c.key}
                        style={{ cursor: 'pointer', borderLeft: `3px solid ${c.platform === 'whatsapp' ? '#25d366' : c.platform === 'telegram' ? '#0088cc' : '#6c757d'}`, opacity: selectedConvs.size > 0 && !isSelected ? 0.5 : 1, transition: 'opacity 0.2s' }}
                        onClick={() => setExpandedConv(isExpanded ? null : c.key)}
                      >
                        <div className="hub-card-top">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onClick={(e) => toggleConvSelection(c.key, e)}
                              onChange={() => {}}
                              style={{ cursor: 'pointer', width: 16, height: 16 }}
                            />
                            <div className="hub-card-title">
                              <span className="hub-card-name">
                              {c.platform === 'whatsapp' ? '📱' : c.platform === 'telegram' ? '✈️' : '💬'} {displayName}
                            </span>
                            <span className="hub-card-id">{phone && <span style={{ color: 'var(--text-secondary, #8b949e)', marginRight: 6 }}>{phone}</span>}{c.platform} · {ageStr}</span>
                          </div>
                          </div>
                          <div className="hub-card-actions" style={{ gap: 6 }}>
                            <span className="hub-chip">{c.messageCount} msgs</span>
                            {isExpanded && c.messages && c.messages.length > 0 && (
                              <>
                                <button
                                  type="button"
                                  className="hub-mini-btn"
                                  onClick={(e) => exportConversationText(c, e)}
                                  title="Export as text file"
                                >
                                  📄
                                </button>
                                <button
                                  type="button"
                                  className="hub-mini-btn"
                                  onClick={(e) => exportConversationPDF(c, e)}
                                  title="Export as PDF (opens print dialog)"
                                >
                                  📑
                                </button>
                              </>
                            )}
                            <button
                              type="button"
                              className="hub-mini-btn"
                              disabled={clearingConv === c.key}
                              onClick={handleClear}
                              title="Clear conversation history"
                              style={{ color: '#ef4444' }}
                            >
                              🗑️
                            </button>
                            <span style={{ fontSize: 18, transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'none' }}>▼</span>
                          </div>
                        </div>
                        <p className="hub-card-desc" style={{ fontStyle: 'italic', color: 'var(--text-muted, #6e7681)' }}>
                          <span style={{ color: 'var(--text-primary, #e6edf3)', fontWeight: 500 }}>Last message:</span>{' '}
                          {c.lastUserMessage.slice(0, 120)}{c.lastUserMessage.length > 120 ? '…' : ''}
                        </p>
                        {/* Tags */}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                          {(c.tags ?? []).map((tag) => (
                            <span key={tag} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: '2px 8px', borderRadius: 12, fontSize: 11, background: '#3b82f620', color: '#3b82f6', border: '1px solid #3b82f640' }}>
                              🏷️ {tag}
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); void handleRemoveTag(c.key, tag); }}
                                style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', padding: 0, fontSize: 12, lineHeight: 1 }}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                          {addingTagTo === c.key ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                              <input
                                type="text"
                                value={newTagValue}
                                onChange={(e) => setNewTagValue(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') { void handleAddTag(c.key, newTagValue); } if (e.key === 'Escape') { setAddingTagTo(null); setNewTagValue(''); } }}
                                placeholder="tag name"
                                autoFocus
                                onClick={(e) => e.stopPropagation()}
                                style={{ width: 80, padding: '1px 6px', fontSize: 11, borderRadius: 8, border: '1px solid var(--border)' }}
                              />
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setAddingTagTo(c.key); setNewTagValue(''); }}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: '2px 8px', borderRadius: 12, fontSize: 11, background: 'var(--border)', color: 'var(--muted)', border: 'none', cursor: 'pointer' }}
                            >
                              + tag
                            </button>
                          )}
                        </div>
                        {isExpanded && c.messages && c.messages.length > 0 ? (
                          <div className="conversation-thread" style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10, maxHeight: 400, overflowY: 'auto' }}>
                            {c.messages.map((m, i) => (
                              <div
                                key={i}
                                style={{
                                  marginBottom: 8,
                                  display: 'flex',
                                  flexDirection: 'column',
                                  alignItems: m.role === 'user' ? 'flex-end' : 'flex-start',
                                }}
                              >
                                <div style={{
                                  maxWidth: '80%',
                                  padding: '8px 12px',
                                  borderRadius: 12,
                                  backgroundColor: m.role === 'user' ? '#007bff' : 'var(--bg-card, #1a1f2e)',
                                  color: m.role === 'user' ? '#fff' : 'var(--text-primary, #e6edf3)',
                                  fontSize: 13,
                                  lineHeight: 1.5,
                                  whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-word',
                                }}>
                                  {m.content.slice(0, 500)}{m.content.length > 500 ? '…' : ''}
                                </div>
                                <span style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2, padding: '0 4px' }}>
                                  {m.role === 'user' ? '👤' : '🤖'} {new Date(m.ts).toLocaleString()}
                                </span>
                              </div>
                            ))}
                            {/* Typing indicator */}
                            {typingContacts.has(c.key) && (
                              <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                                <div style={{
                                  padding: '8px 16px',
                                  borderRadius: 12,
                                  backgroundColor: 'var(--bg-card, #1a1f2e)',
                                  fontSize: 13,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 4,
                                }}>
                                  <span style={{ animation: 'typingBlink 1.4s infinite ease-in-out' }}>●</span>
                                  <span style={{ animation: 'typingBlink 1.4s infinite ease-in-out 0.2s' }}>●</span>
                                  <span style={{ animation: 'typingBlink 1.4s infinite ease-in-out 0.4s' }}>●</span>
                                </div>
                                <span style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2, padding: '0 4px' }}>
                                  🤖 typing…
                                </span>
                              </div>
                            )}
                          </div>
                        ) : isExpanded ? (
                          <p className="admin-hint" style={{ marginTop: 8 }}>No message details available.</p>
                        ) : null}
                      </div>
                    );
                  })}
                {/* Infinite scroll sentinel */}
                {convHasMore && !convLoading && (
                  <div ref={convSentinelRef} style={{ height: 1 }} />
                )}
                {convLoading && (
                  <div className="loading-state" style={{ padding: 12 }}>
                    <div className="loading-spinner" />
                    <span className="admin-hint" style={{ marginLeft: 8 }}>Loading more conversations…</span>
                  </div>
                )}
                {!convLoading && !convHasMore && convList.length > 0 && (
                  <p className="admin-hint" style={{ textAlign: 'center', padding: 12 }}>
                    All {convTotal} conversation{convTotal === 1 ? '' : 's'} loaded.
                  </p>
                )}
              </div>
            </>
          ) : convLoading ? (
            <div className="loading-state">
              <div className="loading-spinner" />
              <p className="admin-hint">Loading conversations…</p>
            </div>
          ) : (
            <div className="empty-state">No conversations stored yet. Conversations are created when users message the agent via WhatsApp/Telegram/etc.</div>
          )}
        </div>
      ) : null}

      {/* ── Artifacts tab ────────────────────────────────────────────────── */}
      {tab === 'artifacts' && data ? (
        <div role="tabpanel">
          <div className="admin-summary-grid">
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.artifacts.totalSessions}</div>
              <div className="admin-summary-label">Sessions</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.artifacts.totalArtifacts}</div>
              <div className="admin-summary-label">Artifacts</div>
            </div>
          </div>
          {data.artifacts.sessions.length > 0 ? (
            <div className="hub-session-list">
              {data.artifacts.sessions.map((s) => (
                <div className="hub-card" key={s.sessionId}>
                  <div className="hub-card-top">
                    <div className="hub-card-title">
                      <span className="hub-card-name">{s.sessionId}</span>
                      <span className="hub-card-id">{s.count} artifact{s.count === 1 ? '' : 's'} · {new Date(s.latestAt).toLocaleString()}</span>
                    </div>
                  </div>
                  {s.recent.length > 0 ? (
                    <ul className="hub-artifact-list">
                      {s.recent.map((a, i) => (
                        <li key={i}>
                          <span className="hub-chip">{a.kind}</span>
                          <span className="hub-artifact-title">{a.title || '(untitled)'}</span>
                          {a.preview ? <div className="hub-artifact-preview">{a.preview}</div> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="admin-hint">No artifact details.</div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">No artifacts yet — tools that return a deliverable payload land here per session.</div>
          )}
        </div>
      ) : null}

      {/* ── Skills tab ───────────────────────────────────────────────────── */}
      {tab === 'skills' && data ? (
        <div role="tabpanel">
          <div className="admin-summary-grid">
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.skills.enabled}</div>
              <div className="admin-summary-label">Enabled skills</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.skills.disabled}</div>
              <div className="admin-summary-label">Disabled skills</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.skills.hub.length}</div>
              <div className="admin-summary-label">Hub skills (SKILL.md)</div>
            </div>
          </div>

          <h3 className="section-subtitle">📚 Compiled skills (SkillStore — matched at plan time)</h3>
          {data.skills.compiled.length > 0 ? (
            <div className="hub-session-list">
              {data.skills.compiled.map((s) => (
                <div className={`hub-card${s.enabled ? '' : ' hub-card-disabled'}`} key={`c-${s.id}`}>
                  <div className="hub-card-top">
                    <div className="hub-card-title">
                      <span className="hub-card-name">{s.name}</span>
                      <span className="hub-card-id">{s.id}{s.version ? ` · v${s.version}` : ''}</span>
                    </div>
                    <div className="hub-card-actions">
                      {/* P6e — provenance badge: bundled ships with the product. */}
                      {s.bundled === true ? <span className="hub-chip hub-chip-bundled">🧠 bundled</span> : <span className="hub-chip">community</span>}
                      <button
                        role="switch"
                        aria-checked={s.enabled}
                        aria-label={`${s.enabled ? 'Disable' : 'Enable'} ${s.name}`}
                        className={`hub-switch${s.enabled ? ' on' : ''}`}
                        disabled={toggling === s.id || pendingToggle !== null || (authed && !canWrite)}
                        onClick={() => toggleSkill(s.id, !s.enabled)}
                      >
                        <span className="hub-switch-knob" />
                      </button>
                    </div>
                  </div>
                  <p className="hub-card-desc">{s.description}</p>
                  <div className="hub-card-tools">
                    {typeof s.usageCount === 'number' ? <span className="hub-chip">{s.usageCount} uses</span> : null}
                    {!s.enabled ? <span className="hub-chip">disabled</span> : null}
                  </div>
                  {/* Edge note: a hub dir named exactly like a compiled id would
                      share the rowMsg key — both cards represent the SAME
                      disabled[] entry then, so toggling either is coherent. */}
                  {rowMsg[s.id] ? <div className="admin-row-msg">{rowMsg[s.id]}</div> : null}
                  {!s.enabled ? <div className="hub-card-note">⛔ Excluded from skill matching — not injected into the planner</div> : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">No compiled skills.</div>
          )}

          <h3 className="section-subtitle">🌍 Hub skills (installed SKILL.md)</h3>
          {data.skills.hub.length > 0 ? (
            <div className="hub-session-list">
              {data.skills.hub.map((s) => (
                <div className={`hub-card${s.enabled ? '' : ' hub-card-disabled'}`} key={`h-${s.id}`}>
                  <div className="hub-card-top">
                    <div className="hub-card-title">
                      <span className="hub-card-name">{s.name}</span>
                      <span className="hub-card-id">{s.id}</span>
                    </div>
                    <div className="hub-card-actions">
                      <button
                        type="button"
                        className="hub-mini-btn"
                        disabled={marketBusyName === s.id || (authed && !canWrite)}
                        onClick={() => void uninstallSkill(s.id)}
                      >
                        🗑 Uninstall
                      </button>
                      <button
                        role="switch"
                        aria-checked={s.enabled}
                        aria-label={`${s.enabled ? 'Disable' : 'Enable'} ${s.name}`}
                        className={`hub-switch${s.enabled ? ' on' : ''}`}
                        disabled={toggling === s.id || pendingToggle !== null || (authed && !canWrite)}
                        onClick={() => toggleSkill(s.id, !s.enabled)}
                      >
                        <span className="hub-switch-knob" />
                      </button>
                    </div>
                  </div>
                  <p className="hub-card-desc">{s.description}</p>
                  <div className="hub-card-tools">
                    <span className="hub-chip">SKILL.md</span>
                    {!s.enabled ? <span className="hub-chip">disabled</span> : null}
                  </div>
                  {rowMsg[s.id] ? <div className="admin-row-msg">{rowMsg[s.id]}</div> : null}
                  {!s.enabled ? <div className="hub-card-note">⛔ Excluded from skill matching — not injected into the planner</div> : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              No hub skills installed — search the marketplace below or run <code>buff skills install &lt;name&gt;</code>.
            </div>
          )}

          {/* P6d — marketplace import surface: search every configured registry
              and install into .agents/skills/ (sandboxed + checksum-verified).
              The repo stays private — this READS other people's registries. */}
          <h3 className="section-subtitle">🛒 Marketplace (community skills)</h3>
          <form className="hub-market-search" onSubmit={searchMarket}>
            <input
              type="text"
              value={marketQuery}
              onChange={(e) => setMarketQuery(e.target.value)}
              placeholder="Search community skills (e.g. code-assist, deploy, testing)…"
            />
            <button type="submit" className="admin-refresh-btn" disabled={marketBusy}>
              {marketBusy ? 'Searching…' : '🔎 Search'}
            </button>
          </form>
          {marketMsg ? <div className={`admin-row-msg${marketMsg.kind === 'err' ? ' admin-row-msg-err' : ''}`}>{marketMsg.text}</div> : null}
          {marketSearched && !marketBusy ? (
            marketResults.length > 0 ? (
              <div className="hub-session-list">
                {marketResults.map((r) => (
                  <div className="hub-card" key={`m-${r.name}`}>
                    <div className="hub-card-top">
                      <div className="hub-card-title">
                        <span className="hub-card-name">{r.name}</span>
                        <span className="hub-card-id">v{r.version} · {r.sourceKind}</span>
                      </div>
                      <button
                        type="button"
                        className="admin-refresh-btn"
                        disabled={marketBusyName === r.name || (authed && !canWrite)}
                        onClick={() => void installMarketSkill(r.name)}
                      >
                        {marketBusyName === r.name ? 'Installing…' : '⬇ Install'}
                      </button>
                    </div>
                    <p className="hub-card-desc">{r.description}</p>
                    <div className="hub-card-tools">
                      <span className="hub-chip">{r.author}</span>
                      {r.tags.slice(0, 3).map((t) => <span className="hub-chip" key={t}>{t}</span>)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                No skills match "{marketQuery}" — try a broader term, or add a registry to <code>skills.registries</code> in config.
              </div>
            )
          ) : null}
        </div>
      ) : null}
    </>
  );
}
