import { useState, useEffect, useCallback } from 'react';
import { dashboardAPI } from '../api';

interface Contact {
  name: string;
  platform: string;
  id: string;
  phone?: string;
  status: 'approved' | 'pending' | 'rejected';
  registeredAt: number;
  addedAt: number;
}

/** Platforms that support two-way outbound messaging (send authority applies). */
const OUTBOUND_PLATFORMS = ['whatsapp', 'whatsapp_cloud', 'telegram', 'signal', 'slack', 'discord', 'email'] as const;

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'approved' | 'pending' | 'rejected'>('all');
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // ── Send authority ──────────────────────────────────────────────────────
  // Who may command the agent to message OTHER people (gateway_send). This is
  // distinct from a contact's APPROVAL status above (which only gates sending
  // TO that person).
  const [sendAuth, setSendAuth] = useState<Record<string, { outboundSenders?: string[]; requireApprovedTarget?: boolean }>>({});
  const [savedSendAuth, setSavedSendAuth] = useState<Record<string, { outboundSenders?: string[]; requireApprovedTarget?: boolean }>>({});
  const [sendInputs, setSendInputs] = useState<Record<string, string>>({});
  const [sendMsg, setSendMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  // Channel clarification behaviour — the same Permissions surface, so it rides
  // this panel rather than hiding in a config file.
  const [askUserWait, setAskUserWait] = useState(false);
  const [savedAskUserWait, setSavedAskUserWait] = useState(false);
  const [askUserTimeoutMs, setAskUserTimeoutMs] = useState(120_000);

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await dashboardAPI.getContacts();
    if (result.ok && result.contacts) {
      setContacts(result.contacts as Contact[]);
    }
    // Send authority rides the gateway-policies endpoint.
    const pol = await dashboardAPI.gatewayPolicies();
    if (pol.ok && pol.policies) {
      const next: Record<string, { outboundSenders?: string[]; requireApprovedTarget?: boolean }> = {};
      for (const p of OUTBOUND_PLATFORMS) {
        const v = (pol.policies as Record<string, { outboundSenders?: string[]; requireApprovedTarget?: boolean }>)[p];
        if (!v) continue;
        next[p] = {
          ...(v.outboundSenders !== undefined ? { outboundSenders: v.outboundSenders } : {}),
          ...(v.requireApprovedTarget !== undefined ? { requireApprovedTarget: v.requireApprovedTarget } : {}),
        };
      }
      setSendAuth(next);
      setSavedSendAuth(next);
    }
    setAskUserWait(pol.askUserWait === true);
    setSavedAskUserWait(pol.askUserWait === true);
    if (typeof pol.askUserTimeoutMs === 'number') setAskUserTimeoutMs(pol.askUserTimeoutMs);
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const filtered = contacts.filter((c) => filter === 'all' || c.status === filter);

  const handleApprove = async (c: Contact) => {
    setMsg(null);
    const r = await dashboardAPI.approveContact(c.platform, c.name);
    setMsg(r.ok ? { kind: 'ok', text: `✅ ${c.name} approved.` } : { kind: 'err', text: r.error || 'Failed.' });
    void refresh();
  };

  const handleReject = async (c: Contact) => {
    setMsg(null);
    const r = await dashboardAPI.rejectContact(c.platform, c.name);
    setMsg(r.ok ? { kind: 'ok', text: `🚫 ${c.name} rejected.` } : { kind: 'err', text: r.error || 'Failed.' });
    void refresh();
  };

  const handleDelete = async (c: Contact) => {
    setMsg(null);
    const r = await dashboardAPI.deleteContact(c.platform, c.name);
    setMsg(r.ok ? { kind: 'ok', text: `🗑️ ${c.name} deleted.` } : { kind: 'err', text: r.error || 'Failed.' });
    void refresh();
  };

  const handleSaveEdit = async () => {
    if (!editingContact) return;
    setMsg(null);
    const r = await dashboardAPI.updateContact(editingContact.platform, editingContact.id, { name: editName, phone: editPhone });
    setMsg(r.ok ? { kind: 'ok', text: `✅ ${editName} updated.` } : { kind: 'err', text: r.error || 'Failed.' });
    setEditingContact(null);
    void refresh();
  };

  const statusBadge = (status: string) => {
    if (status === 'approved') return <span className="contact-status-badge approved">✅ Approved</span>;
    if (status === 'pending') return <span className="contact-status-badge pending">⏳ Pending</span>;
    return <span className="contact-status-badge rejected">🚫 Rejected</span>;
  };

  const platformIcon = (p: string) => {
    const icons: Record<string, string> = { telegram: '✈️', whatsapp: '📱', whatsapp_cloud: '📱', email: '📧', slack: '💬', discord: '🎮' };
    return icons[p] || '🔌';
  };

  const formatDate = (ms: number) => ms ? new Date(ms).toLocaleString() : '—';

  // ── Send-authority handlers ──────────────────────────────────────────────
  const addSender = (platform: string) => {
    const id = (sendInputs[platform] ?? '').trim();
    if (!id) return;
    setSendAuth((prev) => {
      const entry = { ...(prev[platform] ?? {}) };
      const base = entry.outboundSenders ?? savedSendAuth[platform]?.outboundSenders ?? [];
      if (!base.some((x) => x.toLowerCase() === id.toLowerCase())) entry.outboundSenders = [...base, id];
      return { ...prev, [platform]: entry };
    });
    setSendInputs((s) => ({ ...s, [platform]: '' }));
  };

  const removeSender = (platform: string, id: string) => {
    setSendAuth((prev) => {
      const entry = { ...(prev[platform] ?? {}) };
      const base = entry.outboundSenders ?? savedSendAuth[platform]?.outboundSenders ?? [];
      entry.outboundSenders = base.filter((x) => x.toLowerCase() !== id.toLowerCase());
      return { ...prev, [platform]: entry };
    });
  };

  const toggleApprovedTarget = (platform: string) => {
    setSendAuth((prev) => {
      const entry = { ...(prev[platform] ?? {}) };
      entry.requireApprovedTarget = entry.requireApprovedTarget === true ? false : true;
      return { ...prev, [platform]: entry };
    });
  };

  /** Reset to the OPEN default (inherit the inbound allow-list). */
  const resetSenderAuthority = (platform: string) => {
    setSendAuth((prev) => {
      const entry = { ...(prev[platform] ?? {}) };
      delete entry.outboundSenders;
      return { ...prev, [platform]: entry };
    });
  };

  const handleSaveSendAuth = async () => {
    setSendBusy(true);
    setSendMsg(null);
    // Build the payload: for each platform send ONLY its send-authority keys.
    // The API merges PER-KEY over the saved policy, so this never touches
    // allowedUsers / allowedGroups / etc.
    const payload: Record<string, unknown> = {};
    for (const p of OUTBOUND_PLATFORMS) {
      const nextEntry = sendAuth[p] ?? {};
      const savedEntry = savedSendAuth[p] ?? {};
      const changed =
        JSON.stringify(nextEntry.outboundSenders ?? null) !== JSON.stringify(savedEntry.outboundSenders ?? null) ||
        Boolean(nextEntry.requireApprovedTarget) !== Boolean(savedEntry.requireApprovedTarget);
      if (!changed) continue;
      payload[p] = {
        ...(nextEntry.outboundSenders !== undefined
          ? { outboundSenders: nextEntry.outboundSenders }
          : { outboundSenders: null }), // null = delete key → back to inherit
        requireApprovedTarget: Boolean(nextEntry.requireApprovedTarget),
      };
    }
    const askUserChanged = askUserWait !== savedAskUserWait;
    if (Object.keys(payload).length === 0 && !askUserChanged) {
      setSendBusy(false);
      setSendMsg({ kind: 'ok', text: 'No changes to save.' });
      return;
    }
    const r = await dashboardAPI.saveGatewayPolicies(
      payload as never,
      undefined,
      undefined,
      { wait: askUserWait, timeoutMs: askUserTimeoutMs },
    );
    if (r.ok) {
      setSendMsg({ kind: 'ok', text: '✅ Send authority saved.' });
      void refresh();
    } else {
      setSendMsg({ kind: 'err', text: r.error || 'Failed to save send authority.' });
    }
    setSendBusy(false);
  };

  return (
    <div className="panel contacts-page">
      <div className="panel-header">
        <h2>📇 Contacts — Outbound Messaging Directory</h2>
        <p className="admin-hint">Manage who the bot can send messages to. Users auto-register on first Telegram message.</p>
      </div>

      {msg && (
        <div className={`admin-row-msg ${msg.kind === 'err' ? 'admin-row-msg-err' : ''}`}>
          {msg.text}
          <button className="admin-mini-btn" onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

      <div className="contacts-filters">
        {(['all', 'approved', 'pending', 'rejected'] as const).map((f) => (
          <button key={f} type="button" className={filter === f ? 'platforms-filter-btn active' : 'platforms-filter-btn'} onClick={() => setFilter(f)}>
            {f === 'all' ? `All (${contacts.length})` : f === 'approved' ? `✅ Approved (${contacts.filter((c) => c.status === 'approved').length})` : f === 'pending' ? `⏳ Pending (${contacts.filter((c) => c.status === 'pending').length})` : `🚫 Rejected (${contacts.filter((c) => c.status === 'rejected').length})`}
          </button>
        ))}
        <button type="button" className="admin-refresh-btn" onClick={() => void refresh()}>🔄 Refresh</button>
      </div>

      {loading ? (
        <div className="empty-state">Loading contacts...</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <p>No contacts{filter !== 'all' ? ` with status "${filter}"` : ''}.</p>
          <p className="admin-hint">Contacts auto-register when users message the bot on Telegram. They appear here as "Pending" until you approve them.</p>
        </div>
      ) : (
        <div className="contacts-table-wrapper">
          <table className="contacts-table">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Name</th>
                <th>ID</th>
                <th>Phone</th>
                <th>Status</th>
                <th>Registered</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={`${c.platform}:${c.id}`} className={`contact-row status-${c.status}`}>
                  <td>{platformIcon(c.platform)} {c.platform}</td>
                  <td className="contact-name">{c.name}</td>
                  <td className="contact-id"><code>{c.id}</code></td>
                  <td className="contact-phone">{c.phone || '—'}</td>
                  <td>{statusBadge(c.status)}</td>
                  <td className="contact-date">{formatDate(c.registeredAt || c.addedAt)}</td>
                  <td className="contact-actions">
                    {c.status !== 'approved' && (
                      <button className="admin-mini-btn contact-approve-btn" onClick={() => void handleApprove(c)}>✅ Approve</button>
                    )}
                    {c.status !== 'rejected' && (
                      <button className="admin-mini-btn contact-reject-btn" onClick={() => void handleReject(c)}>🚫 Reject</button>
                    )}
                    <button className="admin-mini-btn" onClick={() => { setEditingContact(c); setEditName(c.name); setEditPhone(c.phone || ''); }}>✏️ Edit</button>
                    <button className="admin-mini-btn contact-delete-btn" onClick={() => void handleDelete(c)}>🗑️</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel-header" style={{ marginTop: 28 }}>
        <h2>🔐 Send authority — who may message others</h2>
        <p className="admin-hint">
          Controls who can ask the agent to send a message to <strong>someone else</strong> through the gateway
          (e.g. “send this poem to my brother on WhatsApp”). This is separate from a contact’s approval status
          above, which only gates sending <em>to</em> that person. Left empty, a platform <strong>inherits</strong> its
          allowed-users list (open). Add <code>Allow-All</code> to allow everyone, or list specific senders to restrict it.
        </p>
      </div>

      {sendMsg && (
        <div className={`admin-row-msg ${sendMsg.kind === 'err' ? 'admin-row-msg-err' : ''}`}>
          {sendMsg.text}
          <button className="admin-mini-btn" onClick={() => setSendMsg(null)}>✕</button>
        </div>
      )}

      <div className="hub-permissions">
        {OUTBOUND_PLATFORMS.map((p) => {
          const entry = sendAuth[p] ?? {};
          const senders = entry.outboundSenders ?? [];
          const open = entry.outboundSenders === undefined;
          return (
            <div className="hub-card" key={`sa-${p}`}>
              <div className="hub-card-top">
                <span className="hub-chip">{platformIcon(p)} {p}</span>
                {open ? <span className="hub-chip">open</span> : <span className="hub-chip">restricted</span>}
              </div>
              <div className="hub-alias-list">
                {open ? (
                  <span className="admin-hint">Open — anyone who can trigger the agent may send to others.</span>
                ) : senders.length === 0 ? (
                  <span className="admin-hint">(empty — nobody may send to others)</span>
                ) : (
                  senders.map((u) => (
                    <div className="hub-alias-row" key={`sa-${p}-${u}`}>
                      <span className="hub-chip">{u}</span>
                      <button className="admin-refresh-btn" disabled={sendBusy} onClick={() => removeSender(p, u)}>✕</button>
                    </div>
                  ))
                )}
              </div>
              <div className="hub-send-form">
                <input
                  type="text"
                  value={sendInputs[p] ?? ''}
                  onChange={(e) => setSendInputs((s) => ({ ...s, [p]: e.target.value }))}
                  placeholder="sender id, or Allow-All"
                  disabled={sendBusy}
                />
                <button className="admin-refresh-btn" disabled={sendBusy || !(sendInputs[p] ?? '').trim()} onClick={() => addSender(p)}>+ Sender</button>
                {!open ? (
                  <button className="admin-refresh-btn" disabled={sendBusy} onClick={() => resetSenderAuthority(p)}>↺ Reset to open</button>
                ) : null}
              </div>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                <input type="checkbox" checked={Boolean(entry.requireApprovedTarget)} disabled={sendBusy} onChange={() => toggleApprovedTarget(p)} />
                <span className="admin-hint">Require approved recipients</span>
              </label>
            </div>
          );
        })}
      </div>
      <div className="hub-card" style={{ marginTop: 16 }}>
        <div className="hub-card-top">
          <span className="hub-chip">🧠 Clarifying questions</span>
          {askUserWait ? <span className="hub-chip">wait for reply</span> : <span className="hub-chip">assume option 1</span>}
          {askUserWait !== savedAskUserWait ? <span className="hub-chip">· unsaved</span> : null}
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <input
            type="checkbox"
            checked={askUserWait}
            disabled={sendBusy}
            onChange={() => setAskUserWait((v) => !v)}
          />
          <span className="admin-hint">
            When the agent asks a question on a channel, <strong>wait for the sender&apos;s reply</strong> before
            acting. Off (default): the question is sent and the <em>first</em> option is assumed immediately — so a
            reply typed afterwards arrives too late to change anything.
          </span>
        </label>
        {askUserWait ? (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <span className="admin-hint">Reply window (seconds)</span>
            <input
              type="number"
              min={5}
              max={600}
              value={Math.round(askUserTimeoutMs / 1000)}
              disabled={sendBusy}
              onChange={(e) => setAskUserTimeoutMs(Math.max(5, Math.min(600, Number(e.target.value) || 120)) * 1000)}
              style={{ width: 90 }}
            />
            <span className="admin-hint">then the first option is used, and the timeout is logged.</span>
          </label>
        ) : null}
      </div>

      <div style={{ marginTop: 12 }}>
        <button className="admin-refresh-btn" disabled={sendBusy} onClick={() => void handleSaveSendAuth()}>💾 Save send authority</button>
      </div>

      {editingContact && (
        <div className="wizard-overlay" onClick={() => setEditingContact(null)}>
          <div className="wizard-modal" onClick={(e) => e.stopPropagation()}>
            <div className="wizard-header">
              <span className="wizard-icon">✏️</span>
              <span className="wizard-title">Edit Contact: {editingContact.name}</span>
              <button type="button" className="admin-mini-btn" onClick={() => setEditingContact(null)}>✕</button>
            </div>
            <div className="wizard-body">
              <label className="hub-send-target">
                <span className="admin-hint">Name</span>
                <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} />
              </label>
              <label className="hub-send-target">
                <span className="admin-hint">Phone (optional, for flexible lookup)</span>
                <input type="text" value={editPhone} onChange={(e) => setEditPhone(e.target.value)} placeholder="+918800123456" />
              </label>
              <p className="admin-hint">Platform: <strong>{editingContact.platform}</strong> | ID: <code>{editingContact.id}</code></p>
              <div className="wizard-nav">
                <button type="button" className="admin-mini-btn" onClick={() => setEditingContact(null)}>Cancel</button>
                <button type="button" className="admin-refresh-btn" onClick={() => void handleSaveEdit()}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
