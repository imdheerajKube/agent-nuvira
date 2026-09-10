"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = ContactsPage;
const react_1 = require("react");
const api_1 = require("../api");
function ContactsPage() {
    const [contacts, setContacts] = (0, react_1.useState)([]);
    const [loading, setLoading] = (0, react_1.useState)(true);
    const [filter, setFilter] = (0, react_1.useState)('all');
    const [editingContact, setEditingContact] = (0, react_1.useState)(null);
    const [editName, setEditName] = (0, react_1.useState)('');
    const [editPhone, setEditPhone] = (0, react_1.useState)('');
    const [msg, setMsg] = (0, react_1.useState)(null);
    const refresh = (0, react_1.useCallback)(async () => {
        setLoading(true);
        const result = await api_1.dashboardAPI.getContacts();
        if (result.ok && result.contacts) {
            setContacts(result.contacts);
        }
        setLoading(false);
    }, []);
    (0, react_1.useEffect)(() => { void refresh(); }, [refresh]);
    const filtered = contacts.filter((c) => filter === 'all' || c.status === filter);
    const handleApprove = async (c) => {
        setMsg(null);
        const r = await api_1.dashboardAPI.approveContact(c.platform, c.name);
        setMsg(r.ok ? { kind: 'ok', text: `✅ ${c.name} approved.` } : { kind: 'err', text: r.error || 'Failed.' });
        void refresh();
    };
    const handleReject = async (c) => {
        setMsg(null);
        const r = await api_1.dashboardAPI.rejectContact(c.platform, c.name);
        setMsg(r.ok ? { kind: 'ok', text: `🚫 ${c.name} rejected.` } : { kind: 'err', text: r.error || 'Failed.' });
        void refresh();
    };
    const handleDelete = async (c) => {
        setMsg(null);
        const r = await api_1.dashboardAPI.deleteContact(c.platform, c.name);
        setMsg(r.ok ? { kind: 'ok', text: `🗑️ ${c.name} deleted.` } : { kind: 'err', text: r.error || 'Failed.' });
        void refresh();
    };
    const handleSaveEdit = async () => {
        if (!editingContact)
            return;
        setMsg(null);
        const r = await api_1.dashboardAPI.updateContact(editingContact.platform, editingContact.id, { name: editName, phone: editPhone });
        setMsg(r.ok ? { kind: 'ok', text: `✅ ${editName} updated.` } : { kind: 'err', text: r.error || 'Failed.' });
        setEditingContact(null);
        void refresh();
    };
    const statusBadge = (status) => {
        if (status === 'approved')
            return <span className="contact-status-badge approved">✅ Approved</span>;
        if (status === 'pending')
            return <span className="contact-status-badge pending">⏳ Pending</span>;
        return <span className="contact-status-badge rejected">🚫 Rejected</span>;
    };
    const platformIcon = (p) => {
        const icons = { telegram: '✈️', whatsapp: '📱', whatsapp_cloud: '📱', email: '📧', slack: '💬', discord: '🎮' };
        return icons[p] || '🔌';
    };
    const formatDate = (ms) => ms ? new Date(ms).toLocaleString() : '—';
    return (<div className="panel contacts-page">
      <div className="panel-header">
        <h2>📇 Contacts — Outbound Messaging Directory</h2>
        <p className="admin-hint">Manage who the bot can send messages to. Users auto-register on first Telegram message.</p>
      </div>

      {msg && (<div className={`admin-row-msg ${msg.kind === 'err' ? 'admin-row-msg-err' : ''}`}>
          {msg.text}
          <button className="admin-mini-btn" onClick={() => setMsg(null)}>✕</button>
        </div>)}

      <div className="contacts-filters">
        {['all', 'approved', 'pending', 'rejected'].map((f) => (<button key={f} type="button" className={filter === f ? 'platforms-filter-btn active' : 'platforms-filter-btn'} onClick={() => setFilter(f)}>
            {f === 'all' ? `All (${contacts.length})` : f === 'approved' ? `✅ Approved (${contacts.filter((c) => c.status === 'approved').length})` : f === 'pending' ? `⏳ Pending (${contacts.filter((c) => c.status === 'pending').length})` : `🚫 Rejected (${contacts.filter((c) => c.status === 'rejected').length})`}
          </button>))}
        <button type="button" className="admin-refresh-btn" onClick={() => void refresh()}>🔄 Refresh</button>
      </div>

      {loading ? (<div className="empty-state">Loading contacts...</div>) : filtered.length === 0 ? (<div className="empty-state">
          <p>No contacts{filter !== 'all' ? ` with status "${filter}"` : ''}.</p>
          <p className="admin-hint">Contacts auto-register when users message the bot on Telegram. They appear here as "Pending" until you approve them.</p>
        </div>) : (<div className="contacts-table-wrapper">
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
              {filtered.map((c) => (<tr key={`${c.platform}:${c.id}`} className={`contact-row status-${c.status}`}>
                  <td>{platformIcon(c.platform)} {c.platform}</td>
                  <td className="contact-name">{c.name}</td>
                  <td className="contact-id"><code>{c.id}</code></td>
                  <td className="contact-phone">{c.phone || '—'}</td>
                  <td>{statusBadge(c.status)}</td>
                  <td className="contact-date">{formatDate(c.registeredAt || c.addedAt)}</td>
                  <td className="contact-actions">
                    {c.status !== 'approved' && (<button className="admin-mini-btn contact-approve-btn" onClick={() => void handleApprove(c)}>✅ Approve</button>)}
                    {c.status !== 'rejected' && (<button className="admin-mini-btn contact-reject-btn" onClick={() => void handleReject(c)}>🚫 Reject</button>)}
                    <button className="admin-mini-btn" onClick={() => { setEditingContact(c); setEditName(c.name); setEditPhone(c.phone || ''); }}>✏️ Edit</button>
                    <button className="admin-mini-btn contact-delete-btn" onClick={() => void handleDelete(c)}>🗑️</button>
                  </td>
                </tr>))}
            </tbody>
          </table>
        </div>)}

      {editingContact && (<div className="wizard-overlay" onClick={() => setEditingContact(null)}>
          <div className="wizard-modal" onClick={(e) => e.stopPropagation()}>
            <div className="wizard-header">
              <span className="wizard-icon">✏️</span>
              <span className="wizard-title">Edit Contact: {editingContact.name}</span>
              <button type="button" className="admin-mini-btn" onClick={() => setEditingContact(null)}>✕</button>
            </div>
            <div className="wizard-body">
              <label className="hub-send-target">
                <span className="admin-hint">Name</span>
                <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)}/>
              </label>
              <label className="hub-send-target">
                <span className="admin-hint">Phone (optional, for flexible lookup)</span>
                <input type="text" value={editPhone} onChange={(e) => setEditPhone(e.target.value)} placeholder="+918800123456"/>
              </label>
              <p className="admin-hint">Platform: <strong>{editingContact.platform}</strong> | ID: <code>{editingContact.id}</code></p>
              <div className="wizard-nav">
                <button type="button" className="admin-mini-btn" onClick={() => setEditingContact(null)}>Cancel</button>
                <button type="button" className="admin-refresh-btn" onClick={() => void handleSaveEdit()}>Save</button>
              </div>
            </div>
          </div>
        </div>)}
    </div>);
}
