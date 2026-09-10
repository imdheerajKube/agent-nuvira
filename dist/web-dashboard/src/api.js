"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dashboardAPI = exports.DashboardAPI = void 0;
exports.getAdminToken = getAdminToken;
exports.setAdminToken = setAdminToken;
exports.authHeaders = authHeaders;
const jsonOrNull_1 = require("./jsonOrNull");
// ─── Admin session token persistence (Session 18) ────────────────────────────
// The Bearer token issued at login/setup rides in localStorage so a refresh of
// the dashboard keeps the session. localStorage may be unavailable (SSR/node
// tests) — every access is guarded.
const ADMIN_TOKEN_KEY = 'buff-dashboard-admin-token';
/**
 * window.localStorage — NOT the bare `localStorage` identifier: newer Node
 * versions expose an experimental global localStorage that is undefined
 * unless --localstorage-file is passed, and it shadows jsdom's window
 * storage. window.localStorage works in the browser; some environments
 * (jsdom under certain Node versions, private browsing, embedded webviews)
 * expose no usable storage at all — the in-memory fallback keeps the session
 * working for the page's lifetime there. Helpers never throw.
 */
function getLocalStorage() {
    try {
        if (typeof window !== 'undefined' && window.localStorage)
            return window.localStorage;
    }
    catch {
        /* not a browser-like environment */
    }
    return null;
}
/** In-memory fallback when window.localStorage is unavailable. */
const adminTokenMemory = new Map();
function readAdminToken() {
    const ls = getLocalStorage();
    if (ls) {
        try {
            const v = ls.getItem(ADMIN_TOKEN_KEY);
            if (v)
                return v;
        }
        catch {
            /* fall through to memory */
        }
    }
    return adminTokenMemory.get(ADMIN_TOKEN_KEY) ?? null;
}
function writeAdminToken(token) {
    const ls = getLocalStorage();
    if (ls) {
        try {
            if (token)
                ls.setItem(ADMIN_TOKEN_KEY, token);
            else
                ls.removeItem(ADMIN_TOKEN_KEY);
            return;
        }
        catch {
            /* fall through to memory */
        }
    }
    if (token)
        adminTokenMemory.set(ADMIN_TOKEN_KEY, token);
    else
        adminTokenMemory.delete(ADMIN_TOKEN_KEY);
}
function getAdminToken() {
    return readAdminToken();
}
function setAdminToken(token) {
    writeAdminToken(token);
}
/** Authorization header for admin-gated endpoints (empty when unauthenticated). */
function authHeaders() {
    const token = getAdminToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
}
class DashboardAPI {
    sse = null;
    listeners = new Set();
    connectionListeners = new Set();
    dagListeners = new Set();
    typingListeners = new Set();
    reconnectTimer = null;
    baseUrl;
    lastData = null;
    constructor(baseUrl = '') {
        this.baseUrl = baseUrl;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    onConnectionChange(listener) {
        this.connectionListeners.add(listener);
        return () => this.connectionListeners.delete(listener);
    }
    onDAGEvent(listener) {
        this.dagListeners.add(listener);
        return () => this.dagListeners.delete(listener);
    }
    onTypingEvent(listener) {
        this.typingListeners.add(listener);
        return () => this.typingListeners.delete(listener);
    }
    connect() {
        if (this.sse)
            return;
        this.sse = new EventSource(`${this.baseUrl}/api/sse`);
        this.sse.addEventListener('init', (event) => {
            try {
                const data = JSON.parse(event.data);
                this.lastData = data;
                this.notify(data);
                this.notifyConnection(true);
            }
            catch (e) {
                console.error('Failed to parse SSE init data:', e);
            }
        });
        this.sse.addEventListener('refresh', (event) => {
            try {
                const data = JSON.parse(event.data);
                this.lastData = data;
                this.notify(data);
                this.notifyConnection(true);
            }
            catch (e) {
                console.error('Failed to parse SSE refresh data:', e);
            }
        });
        this.sse.addEventListener('dag', (event) => {
            try {
                const dag = JSON.parse(event.data);
                this.notifyDAG(dag);
                // Also merge DAG into lastData and notify dashboard listeners
                if (this.lastData) {
                    const updated = { ...this.lastData, dag };
                    this.lastData = updated;
                    this.notify(updated);
                }
            }
            catch (e) {
                console.error('Failed to parse SSE dag event:', e);
            }
        });
        // Real-time quota pushes: the server watches quota-events.jsonl /
        // quota-ledger.json and emits a `quota` event the moment a failover,
        // park, or window reset lands — so the Failover Timeline updates without
        // waiting for the next 10s refresh tick. Merge into routing.quota.
        this.sse.addEventListener('quota', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (this.lastData && payload.quota) {
                    const updated = {
                        ...this.lastData,
                        routing: {
                            ...(this.lastData.routing || {}),
                            quota: payload.quota,
                        },
                        serverTime: payload.serverTime || this.lastData.serverTime,
                    };
                    this.lastData = updated;
                    this.notify(updated);
                }
            }
            catch (e) {
                console.error('Failed to parse SSE quota event:', e);
            }
        });
        // Real-time conversation updates: the server watches chat-history.json
        // and emits a `conversation` event when a new message arrives.
        this.sse.addEventListener('conversation', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (this.lastData && payload.conversations) {
                    const updated = {
                        ...this.lastData,
                        conversations: {
                            total: payload.total ?? payload.conversations.length,
                            recent: payload.conversations,
                        },
                        serverTime: payload.serverTime || this.lastData.serverTime,
                    };
                    this.lastData = updated;
                    this.notify(updated);
                }
            }
            catch (e) {
                console.error('Failed to parse SSE conversation event:', e);
            }
        });
        // Real-time typing indicator: gateway writes typing.json when processing,
        // dashboard broadcasts it via SSE so the UI can show a live typing bubble.
        this.sse.addEventListener('typing', (event) => {
            try {
                const payload = JSON.parse(event.data);
                for (const cb of this.typingListeners) {
                    try {
                        cb(payload);
                    }
                    catch { /* listener error */ }
                }
            }
            catch (e) {
                console.error('Failed to parse SSE typing event:', e);
            }
        });
        this.sse.onerror = () => {
            this.notifyConnection(false);
            this.disconnect();
            this.reconnect();
        };
        this.sse.onopen = () => {
            this.notifyConnection(true);
        };
    }
    disconnect() {
        if (this.sse) {
            this.sse.close();
            this.sse = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
    reconnect() {
        this.reconnectTimer = setTimeout(() => {
            this.connect();
        }, 3000);
    }
    notify(data) {
        this.listeners.forEach((fn) => fn(data));
    }
    notifyDAG(dag) {
        this.dagListeners.forEach((fn) => fn(dag));
    }
    notifyConnection(connected) {
        this.connectionListeners.forEach((fn) => fn(connected));
    }
    async fetchAll() {
        try {
            const res = await fetch(`${this.baseUrl}/api/all`);
            // parseJsonOrNull: an HTML-200 from a stale server degrades to null (with
            // a console.warn hint) so App waits for the next SSE snapshot instead of
            // crashing on "Unexpected token '<'".
            const data = (await (0, jsonOrNull_1.parseJsonOrNull)(res));
            if (!data)
                return null;
            this.lastData = data;
            return data;
        }
        catch {
            return null;
        }
    }
    /** P0: fetch the reasoning-trace index (list view, no step previews). */
    async fetchTraces() {
        try {
            const res = await fetch(`${this.baseUrl}/api/traces`, { signal: AbortSignal.timeout(8000) });
            const data = (await (0, jsonOrNull_1.parseJsonOrNull)(res));
            if (!data?.traces)
                return null;
            return data.traces;
        }
        catch {
            return null;
        }
    }
    /**
     * E3c follow-up: run ALL state commands (doctor/system/enterprise checks)
     * on demand — the dashboard command-runner. The server executes the checks
     * (one source with `nuvira doctor`) and returns masked provider status.
     */
    async fetchAdminChecks() {
        try {
            const res = await fetch(`${this.baseUrl}/api/admin/checks`, { signal: AbortSignal.timeout(15000) });
            const data = (await (0, jsonOrNull_1.parseJsonOrNull)(res));
            if (!data || !Array.isArray(data.system) || !Array.isArray(data.enterprise) || !Array.isArray(data.providers))
                return null;
            return data;
        }
        catch {
            return null;
        }
    }
    /** I4: fetch the Agent Hub aggregate (toolsets, channels, artifacts, skills). */
    async fetchHub() {
        try {
            const res = await fetch(`${this.baseUrl}/api/hub`, { signal: AbortSignal.timeout(8000) });
            const data = (await (0, jsonOrNull_1.parseJsonOrNull)(res));
            if (!data || !Array.isArray(data.toolsets?.toolsets))
                return null;
            return data;
        }
        catch {
            return null;
        }
    }
    /** P0: fetch a single trace's full detail (steps + previews). */
    async fetchTraceDetail(id) {
        try {
            const res = await fetch(`${this.baseUrl}/api/traces/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) });
            const data = (await (0, jsonOrNull_1.parseJsonOrNull)(res));
            return data && Array.isArray(data.steps) ? data : null;
        }
        catch {
            return null;
        }
    }
    // ─── Admin write surface (Session 18 — user-id + password control layer) ─
    /**
     * Send an admin request with the persisted Bearer token. Unlike
     * parseJsonOrNull, this keeps non-2xx JSON bodies (401/400 carry the server's
     * error message) while still guarding the content-type (an HTML-200 from a
     * stale server must never crash on res.json()). Returns null on network
     * failure.
     */
    async sendAdminRequest(path, method, body) {
        try {
            const token = getAdminToken();
            const res = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(15000),
            });
            const type = res.headers.get('content-type') || '';
            let data = null;
            if (type.includes('application/json') || type.includes('text/json')) {
                try {
                    data = await res.json();
                }
                catch {
                    data = null;
                }
            }
            return { status: res.status, data };
        }
        catch {
            return null;
        }
    }
    /** Is the admin surface configured + is the stored token still valid? */
    async fetchAdminAuthStatus() {
        const r = await this.sendAdminRequest('/api/admin/auth-status', 'GET');
        if (!r || typeof r.data !== 'object' || r.data === null)
            return null;
        const d = r.data;
        if (typeof d.configured !== 'boolean' || typeof d.authenticated !== 'boolean')
            return null;
        return {
            configured: d.configured,
            authenticated: d.authenticated,
            user: typeof d.user === 'string' ? d.user : null,
            role: typeof d.role === 'string' ? d.role : null,
        };
    }
    /** The dashboard admin users (role.manage = admin only). */
    async fetchAdminUsers() {
        const r = await this.sendAdminRequest('/api/admin/users', 'GET');
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok && Array.isArray(d.users))
            return d;
        return { ok: false, error: d.error || 'Failed to load users.', forbidden: r.status === 403, unauthorized: r.status === 401 };
    }
    /** Add a dashboard admin user with a role (admin only). */
    async addAdminUser(user, password, role) {
        const r = await this.sendAdminRequest('/api/admin/users', 'POST', { user, password, role });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return { ok: false, error: d.error || 'Failed to add user.', forbidden: r.status === 403, unauthorized: r.status === 401 };
    }
    /** Remove a dashboard admin user (admin only). */
    async removeAdminUser(user) {
        const r = await this.sendAdminRequest(`/api/admin/users/${encodeURIComponent(user)}`, 'DELETE');
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return { ok: false, error: d.error || 'Failed to remove user.', forbidden: r.status === 403, unauthorized: r.status === 401 };
    }
    /** The provider catalog (Add-provider selector source). */
    async fetchAdminCatalog() {
        const r = await this.sendAdminRequest('/api/admin/catalog', 'GET');
        const d = r?.data;
        if (!d || !Array.isArray(d.providers))
            return null;
        return d.providers;
    }
    /** Bootstrap the admin credential (only valid while unconfigured). */
    async adminSetup(user, password) {
        const r = await this.sendAdminRequest('/api/admin/setup', 'POST', { user, password });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && typeof d.token === 'string') {
            setAdminToken(d.token);
            return { ok: true, user: d.user, token: d.token };
        }
        return { ok: false, error: d.error || 'Setup failed.', unauthorized: r.status === 401 };
    }
    /** Login with the admin user-id + password. Persists the returned token. */
    async adminLogin(user, password) {
        const r = await this.sendAdminRequest('/api/admin/login', 'POST', { user, password });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && typeof d.token === 'string') {
            setAdminToken(d.token);
            return { ok: true, user: d.user, token: d.token };
        }
        return { ok: false, error: d.error || 'Login failed.', unauthorized: r.status === 401 };
    }
    /** Log out — revoke the stored token server-side and locally. */
    async adminLogout() {
        await this.sendAdminRequest('/api/admin/logout', 'POST');
        setAdminToken(null);
    }
    /**
     * Shut down the gateway or the dashboard server itself (the GUI twin of
     * `nuvira gateway stop` / `nuvira dashboard stop`). Admin-gated: dashboard
     * requires system.manage (admin), gateway requires gateway.manage
     * (admin + operator). Stopping the dashboard kills THIS page's server.
     */
    async shutdown(target) {
        const r = await this.sendAdminRequest('/api/admin/shutdown', 'POST', { target });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return { ok: false, error: d.error || 'Shutdown failed.', unauthorized: r.status === 401, forbidden: r.status === 403 };
    }
    /** Save/update a provider's key + config (authed). Mirrors `nuvira config set providers.*`. */
    async saveProvider(type, fields) {
        const r = await this.sendAdminRequest(`/api/admin/providers/${encodeURIComponent(type)}`, 'PUT', fields);
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return { ok: false, error: d.error || 'Save failed.', unauthorized: r.status === 401 };
    }
    /** Remove a provider's key + credential fields (authed). */
    async deleteProvider(type) {
        const r = await this.sendAdminRequest(`/api/admin/providers/${encodeURIComponent(type)}`, 'DELETE');
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return { ok: false, error: d.error || 'Remove failed.', unauthorized: r.status === 401 };
    }
    /** Test a provider's configured credentials (authed — lists its models). */
    async testProvider(type) {
        const r = await this.sendAdminRequest(`/api/admin/providers/${encodeURIComponent(type)}/test`, 'POST');
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200)
            return d;
        return { ok: false, error: d.error || 'Test failed.', unauthorized: r.status === 401 };
    }
    /** The user-declared budget (routing.quota + cost cap). Read is open. */
    async fetchAdminQuota() {
        const r = await this.sendAdminRequest('/api/admin/quota', 'GET');
        if (!r)
            return null;
        const d = r.data;
        if (!d || !d.ok || typeof d.quota !== 'object')
            return null;
        return d;
    }
    /**
     * I5: toggle a toolset's enabled state (authed — routing.operate). The
     * server persists it to buffconfig; the I1 runtime gate (schema + execution)
     * honors it immediately, so the dashboard toggle is never cosmetic.
     */
    async setToolsetEnabled(name, enabled) {
        const r = await this.sendAdminRequest(`/api/admin/hub/toolsets/${encodeURIComponent(name)}`, 'PUT', { enabled });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return {
            ok: false,
            error: d.error || 'Toggle failed.',
            unauthorized: r.status === 401,
            forbidden: r.status === 403,
        };
    }
    /**
     * P3: toggle a skill's enabled state (compiled OR hub). Admin-gated PUT
     * that writes the SAME `skills.disabled[]` config the runtime match gate
     * reads, so the toggle is never cosmetic.
     */
    async setSkillEnabled(name, enabled) {
        const r = await this.sendAdminRequest(`/api/admin/hub/skills/${encodeURIComponent(name)}`, 'PUT', { enabled });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return {
            ok: false,
            error: d.error || 'Toggle failed.',
            unauthorized: r.status === 401,
            forbidden: r.status === 403,
        };
    }
    /**
     * P6d — search the marketplace (every configured skill registry). The
     * repo stays private — this READS other people's registries.
     */
    async marketplaceSearch(query) {
        try {
            const res = await fetch(`${this.baseUrl}/api/skills/marketplace?q=${encodeURIComponent(query)}`, {
                headers: authHeaders(),
            });
            const d = (await res.json());
            return Array.isArray(d.results) ? d.results : [];
        }
        catch {
            return [];
        }
    }
    /** P6d — install a marketplace skill (sandboxed + checksum-verified). */
    async marketplaceInstall(name) {
        try {
            const res = await fetch(`${this.baseUrl}/api/skills/marketplace/install`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ name }),
            });
            const d = (await res.json());
            if (res.status === 200 && d.ok)
                return { ok: true };
            return { ok: false, error: d.error || 'Install failed.', quarantined: d.quarantined === true };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    /** P6d — uninstall a marketplace skill (removes dir + provenance). */
    async marketplaceUninstall(name) {
        try {
            const res = await fetch(`${this.baseUrl}/api/skills/marketplace/uninstall`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ name }),
            });
            const d = (await res.json());
            if (res.status === 200 && d.ok)
                return { ok: true };
            return { ok: false, error: d.error || 'Uninstall failed.' };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    /**
     * I11: send a test message through the gateway (authed — routing.operate).
     * Mirrors `nuvira gateway send <target> <text>`; the server resolves the
     * target (alias or platform:channelId) and sends through the SAME
     * GatewayRegistry the CLI uses, so a Channels-tab test is identical to a
     * CLI send.
     */
    async sendChannelMessage(target, text) {
        const r = await this.sendAdminRequest('/api/admin/hub/channels/send', 'POST', { target, text });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return {
            ok: false,
            error: d.error || 'Send failed.',
            unauthorized: r.status === 401,
            forbidden: r.status === 403,
        };
    }
    /**
     * Gateway Permissions (validated senders): read the effective per-platform
     * policies plus the saved verified contacts, or replace per-platform
     * policies (the running gateway re-reads config per inbound, so changes
     * apply without a restart).
     */
    async gatewayPolicies() {
        const r = await this.sendAdminRequest('/api/admin/gateway/policies', 'GET');
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return { ok: true, policies: d.policies, statusRecipients: d.statusRecipients, contacts: d.contacts };
        return { ok: false, error: d.error || 'Failed to read policies.', unauthorized: r.status === 401, forbidden: r.status === 403 };
    }
    async saveGatewayPolicies(policies, statusRecipients, contacts) {
        const body = { policies };
        if (Array.isArray(statusRecipients))
            body.statusRecipients = statusRecipients;
        if (Array.isArray(contacts))
            body.contacts = contacts;
        const r = await this.sendAdminRequest('/api/admin/gateway/policies', 'PUT', body);
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return { ok: false, error: d.error || 'Failed to save policies.', unauthorized: r.status === 401, forbidden: r.status === 403 };
    }
    /** Fetch paginated gateway conversations with optional search. */
    async fetchGatewayConversations(opts = {}) {
        const params = new URLSearchParams();
        if (opts.offset)
            params.set('offset', String(opts.offset));
        if (opts.limit)
            params.set('limit', String(opts.limit));
        if (opts.q)
            params.set('q', opts.q);
        const qs = params.toString();
        const r = await this.sendAdminRequest(`/api/admin/gateway/conversations${qs ? `?${qs}` : ''}`, 'GET');
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return { ok: true, conversations: d.conversations, total: d.total, hasMore: d.hasMore };
        return { ok: false, error: d.error || 'Failed to load conversations.', unauthorized: r.status === 401, forbidden: r.status === 403 };
    }
    /** Clear a single gateway conversation by its key (e.g. "whatsapp:918800663237"). */
    async clearGatewayConversation(key) {
        const r = await this.sendAdminRequest('/api/admin/gateway/conversations', 'DELETE', { key });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return { ok: true };
        return { ok: false, error: d.error || 'Failed to clear conversation.', unauthorized: r.status === 401, forbidden: r.status === 403 };
    }
    /** Add a tag to a conversation. */
    async addConversationTag(key, tag) {
        const r = await this.sendAdminRequest('/api/admin/gateway/conversations/tags', 'PUT', { action: 'add', key, tag });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return { ok: true };
        return { ok: false, error: d.error || 'Failed to add tag.', unauthorized: r.status === 401, forbidden: r.status === 403 };
    }
    /** Remove a tag from a conversation. */
    async removeConversationTag(key, tag) {
        const r = await this.sendAdminRequest('/api/admin/gateway/conversations/tags', 'PUT', { action: 'remove', key, tag });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return { ok: true };
        return { ok: false, error: d.error || 'Failed to remove tag.', unauthorized: r.status === 401, forbidden: r.status === 403 };
    }
    /** Get all unique tags across all conversations. */
    async getAllConversationTags() {
        const r = await this.sendAdminRequest('/api/admin/gateway/conversations/tags', 'PUT', { action: 'getAllTags' });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return { ok: true, tags: d.tags };
        return { ok: false, error: d.error || 'Failed to load tags.', unauthorized: r.status === 401, forbidden: r.status === 403 };
    }
    /** Bulk export conversations as a ZIP file. Triggers a browser download. */
    async exportGatewayConversations(keys) {
        try {
            const token = getAdminToken();
            const res = await fetch(`${this.baseUrl}/api/admin/gateway/conversations/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                body: JSON.stringify({ keys }),
                signal: AbortSignal.timeout(30_000),
            });
            if (res.status === 200 && res.headers.get('content-type')?.includes('application/zip')) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] || 'conversations.zip';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                return { ok: true };
            }
            const d = await res.json().catch(() => ({}));
            return { ok: false, error: d.error || 'Export failed.' };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    // ─── Contacts management (name-centric outbound contacts) ────────────────
    /** List all contacts (name, platform, id, phone, status). */
    async getContacts() {
        const r = await this.sendAdminRequest('/api/admin/contacts', 'GET');
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return { ok: true, contacts: d.contacts };
        return { ok: false, error: d.error || 'Failed to read contacts.' };
    }
    /** Approve a contact by platform + name or ID. */
    async approveContact(platform, nameOrId) {
        return this.contactAction('approve', platform, nameOrId);
    }
    /** Reject a contact by platform + name or ID. */
    async rejectContact(platform, nameOrId) {
        return this.contactAction('reject', platform, nameOrId);
    }
    /** Delete a contact by platform + name or ID. */
    async deleteContact(platform, nameOrId) {
        return this.contactAction('delete', platform, nameOrId);
    }
    /** Update a contact's name, phone, or status. */
    async updateContact(platform, id, fields) {
        const r = await this.sendAdminRequest('/api/admin/contacts', 'PUT', { action: 'update', platform, id, ...fields });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return { ok: false, error: d.error || 'Update failed.' };
    }
    async contactAction(action, platform, nameOrId) {
        const r = await this.sendAdminRequest('/api/admin/contacts', 'PUT', { action, platform, nameOrId });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return { ok: false, error: d.error || `${action} failed.` };
    }
    /**
     * Platform transport config (GUI parity with `nuvira config gateway`): list
     * every env-configurable platform with current per-var values (full values
     * only for admin/operator). Authed.
     */
    async getPlatformConfigs() {
        const r = await this.sendAdminRequest('/api/config/platforms', 'GET');
        if (!r)
            return [];
        const d = (r.data ?? {});
        return Array.isArray(d.platforms) ? d.platforms : [];
    }
    /** Write a platform's env values to ~/.nuvira/.env (authed — routing.operate). */
    async setPlatformConfig(platform, values) {
        const r = await this.sendAdminRequest(`/api/config/platforms/${encodeURIComponent(platform)}`, 'POST', { values });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return {
            ok: false,
            error: d.error || 'Save failed.',
            unauthorized: r.status === 401,
            forbidden: r.status === 403,
        };
    }
    /** Remove a platform's env values from ~/.nuvira/.env (authed — routing.operate). */
    async removePlatformConfig(platform) {
        const r = await this.sendAdminRequest(`/api/config/platforms/${encodeURIComponent(platform)}`, 'DELETE');
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return {
            ok: false,
            error: d.error || 'Remove failed.',
            unauthorized: r.status === 401,
            forbidden: r.status === 403,
        };
    }
    /** Verify a platform's token by calling the platform's API (e.g. Telegram getMe). */
    async verifyPlatformConfig(platform, values) {
        const r = await this.sendAdminRequest(`/api/config/platforms/${encodeURIComponent(platform)}/verify`, 'POST', { values });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        return { ok: d.ok ?? false, info: d.info, error: d.error };
    }
    /**
     * Save the user-declared budget (authed). Quota fields are gated by
     * routing.operate (admin + operator); the cost cap by policy.write (admin).
     */
    async saveAdminQuota(body) {
        const r = await this.sendAdminRequest('/api/admin/quota', 'PUT', body);
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return { ok: false, error: d.error || 'Save failed.', unauthorized: r.status === 401 };
    }
    // ─── Bedrock onboarding ───────────────────────────────────────────────────
    /** Get current Bedrock configuration status. */
    async getBedrockStatus() {
        const r = await this.sendAdminRequest('/api/bedrock/status', 'GET');
        if (!r || r.status !== 200) {
            return { configured: false, region: 'us-east-1', authMethod: 'none', apiKeySet: false, iamKeySet: false };
        }
        return (r.data ?? {});
    }
    /** Save Bedrock env vars (credentials + region) to ~/.nuvira/.env. */
    async setupBedrock(envVars) {
        const r = await this.sendAdminRequest('/api/bedrock/setup', 'POST', { envVars });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return { ok: true, envVarsWritten: d.envVarsWritten };
        return { ok: false, error: d.error || 'Save failed.' };
    }
    /** Probe Bedrock models in a region — returns accessibility status for each. */
    async probeBedrock(region) {
        const r = await this.sendAdminRequest('/api/bedrock/probe', 'POST', { region });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return { ok: true, models: d.models };
        return { ok: false, error: d.error || 'Probe failed.' };
    }
    // ─── P1 task runner (command console) ─────────────────────────────────────
    /** Recent task history, newest first (authed — running commands is a write action). */
    async listTasks() {
        const r = await this.sendAdminRequest('/api/tasks', 'GET');
        if (!r)
            return null;
        const d = (r.data ?? {});
        return { status: r.status, tasks: Array.isArray(d.tasks) ? d.tasks : [] };
    }
    /** Start a CLI task: args = the command line split into argv (e.g. ['eval','run','--task','smoke']). */
    async startTask(args, timeoutMs) {
        const r = await this.sendAdminRequest('/api/tasks', 'POST', { args, timeoutMs });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok && d.task)
            return d;
        return { ok: false, error: d.error || 'Start failed.', unauthorized: r.status === 401, forbidden: r.status === 403 };
    }
    /** Full task detail (logs included). */
    async getTask(id) {
        const r = await this.sendAdminRequest(`/api/tasks/${encodeURIComponent(id)}`, 'GET');
        if (!r)
            return null;
        const d = (r.data ?? {});
        return { status: r.status, task: d.task ?? null };
    }
    /** Cancel a running task (SIGTERM). */
    async cancelTask(id) {
        const r = await this.sendAdminRequest(`/api/tasks/${encodeURIComponent(id)}/cancel`, 'POST');
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return { ok: false, error: d.error || 'Cancel failed.', unauthorized: r.status === 401, forbidden: r.status === 403 };
    }
    /**
     * Subscribe to a task's live log/status events over SSE. EventSource can't
     * set Authorization headers, so the admin token rides the ?token= query.
     * Returns an unsubscribe function.
     */
    subscribeTask(id, handlers) {
        const token = getAdminToken();
        const es = new EventSource(`${this.baseUrl}/api/tasks/${encodeURIComponent(id)}/events?token=${encodeURIComponent(token ?? '')}`);
        es.addEventListener('log', (event) => {
            try {
                handlers.onLog?.(JSON.parse(event.data));
            }
            catch { /* ignore malformed */ }
        });
        es.addEventListener('status', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.status)
                    handlers.onStatus?.(payload.status);
            }
            catch { /* ignore malformed */ }
        });
        return () => es.close();
    }
    // ─── P2 — in-page WhatsApp pairing (GUI parity with `nuvira whatsapp pair`) ──
    /** Current pairing status (state, QR data URL, code, session dir). */
    async getWhatsAppStatus() {
        const r = await this.sendAdminRequest('/api/whatsapp', 'GET');
        if (!r)
            return null;
        const d = (r.data ?? {});
        return r.status === 200 && d.ok && d.status ? { status: d.status, contacts: d.contacts ?? {} } : null;
    }
    /** Start pairing — QR mode, or phone mode when `phone` (intl, no +) is set. */
    async startWhatsAppPair(phone) {
        const r = await this.sendAdminRequest('/api/whatsapp/pair', 'POST', { phone: phone || undefined });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return { ok: false, error: d.error || 'Pairing failed to start.', unauthorized: r.status === 401, forbidden: r.status === 403 };
    }
    /** Abort the active pairing. */
    async cancelWhatsAppPair() {
        const r = await this.sendAdminRequest('/api/whatsapp/cancel', 'POST');
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return { ok: false, error: d.error || 'Cancel failed.', unauthorized: r.status === 401, forbidden: r.status === 403 };
    }
    /** Remove the paired WhatsApp session from disk. */
    async unpairWhatsApp() {
        const r = await this.sendAdminRequest('/api/whatsapp/unpair', 'POST');
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        if (r.status === 200 && d.ok)
            return d;
        return { ok: false, error: d.error || 'Unpair failed.', unauthorized: r.status === 401, forbidden: r.status === 403 };
    }
    /**
     * Subscribe to pairing events over SSE: qr (PNG data URL) / code (8-char)
     * / status. EventSource can't set Authorization headers, so the admin
     * token rides the ?token= query. Returns an unsubscribe function.
     */
    subscribeWhatsApp(handlers) {
        const token = getAdminToken();
        const es = new EventSource(`${this.baseUrl}/api/whatsapp/events?token=${encodeURIComponent(token ?? '')}`);
        es.addEventListener('qr', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.qr)
                    handlers.onQr?.(payload.qr);
            }
            catch { /* ignore malformed */ }
        });
        es.addEventListener('code', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.code)
                    handlers.onCode?.(payload.code);
            }
            catch { /* ignore malformed */ }
        });
        es.addEventListener('status', (event) => {
            try {
                handlers.onStatus?.(JSON.parse(event.data));
            }
            catch { /* ignore malformed */ }
        });
        return () => es.close();
    }
    // ─── P3 — chat console (GUI parity with `nuvira chat "<prompt>"`) ─────────
    /**
     * Resolve a plain-English ask into the CLI command(s) the intent router
     * would run — the Chat UI calls this BEFORE the agent so deterministic
     * commands ("stop the dashboard") short-circuit to a confirm card.
     */
    async chatResolve(message) {
        const token = getAdminToken();
        try {
            const res = await fetch(`${this.baseUrl}/api/chat/resolve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                body: JSON.stringify({ message }),
                signal: AbortSignal.timeout(10_000),
            });
            const d = (await res.json());
            if (res.status === 200 && d.ok && Array.isArray(d.matches))
                return { ok: true, matches: d.matches };
            return { ok: false, matches: [], error: typeof d.error === 'string' ? d.error : 'Resolve failed.' };
        }
        catch {
            return { ok: false, matches: [], error: 'Could not reach the dashboard server.' };
        }
    }
    /**
     * P3 — project picker: the dashboard's cwd + recently attached paths.
     */
    async listProjects() {
        const token = getAdminToken();
        try {
            const res = await fetch(`${this.baseUrl}/api/projects`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
                signal: AbortSignal.timeout(10_000),
            });
            const d = (await res.json());
            if (res.status === 200 && d.ok && Array.isArray(d.projects))
                return d.projects;
            return [];
        }
        catch {
            return [];
        }
    }
    /**
     * P3 — attach a project directory (server builds the bounded context
     * snapshot: code map + file tree, cached by path).
     */
    async attachProject(path) {
        const token = getAdminToken();
        try {
            const res = await fetch(`${this.baseUrl}/api/projects/attach`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                body: JSON.stringify({ path }),
                signal: AbortSignal.timeout(30_000),
            });
            const d = (await res.json());
            if (res.status === 200 && d.ok && d.project)
                return { ok: true, project: d.project };
            return { ok: false, error: typeof d.error === 'string' ? d.error : 'Attach failed.' };
        }
        catch {
            return { ok: false, error: 'Could not reach the dashboard server.' };
        }
    }
    /**
     * Browse directories for the project picker folder browser.
     * Returns subdirectories of the given path (or home dir if empty).
     * showDrives=true returns drive roots (Windows drives, Mac /Volumes).
     */
    async browseDirectories(path, opts) {
        const token = getAdminToken();
        try {
            const params = new URLSearchParams();
            if (path)
                params.set('path', path);
            if (opts?.showDrives)
                params.set('showDrives', '1');
            const query = params.toString() ? `?${params.toString()}` : '';
            const res = await fetch(`${this.baseUrl}/api/browse${query}`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
                signal: AbortSignal.timeout(10_000),
            });
            const d = (await res.json());
            if (res.status === 200 && d.ok && Array.isArray(d.entries)) {
                return {
                    ok: true, path: d.path ?? '', entries: d.entries, parent: d.parent ?? null,
                    isProject: d.isProject ?? false, drives: d.drives, breadcrumbs: d.breadcrumbs,
                };
            }
            return { ok: false, path: '', entries: [], parent: null, isProject: false, error: typeof d.error === 'string' ? d.error : 'Browse failed.' };
        }
        catch {
            return { ok: false, path: '', entries: [], parent: null, isProject: false, error: 'Could not reach the dashboard server.' };
        }
    }
    /**
     * Resolve a folder name to its absolute path by searching common locations.
     * Used by the native folder picker (webkitdirectory) which only returns the name.
     */
    async resolveFolder(name, subPath) {
        const token = getAdminToken();
        try {
            const res = await fetch(this.baseUrl + '/api/browse/resolve-folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
                body: JSON.stringify({ name, subPath: subPath || '' }),
                signal: AbortSignal.timeout(10_000),
            });
            const d = (await res.json());
            if (res.status === 200 && d.ok && d.path)
                return { ok: true, path: d.path };
            return { ok: false, path: '', error: typeof d.error === 'string' ? d.error : 'Could not resolve folder.' };
        }
        catch {
            return { ok: false, path: '', error: 'Could not reach the dashboard server.' };
        }
    }
    /**
     * P4 — session sidebar: list past conversations (title, preview, counts).
     */
    async listChatSessions() {
        const token = getAdminToken();
        try {
            const res = await fetch(`${this.baseUrl}/api/sessions`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
                signal: AbortSignal.timeout(10_000),
            });
            const d = (await res.json());
            if (res.status === 200 && d.ok && Array.isArray(d.sessions))
                return d.sessions;
            return [];
        }
        catch {
            return [];
        }
    }
    /**
     * P8 — delete a past session (sidebar ✕).
     */
    async deleteChatSession(id) {
        const token = getAdminToken();
        try {
            const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(id)}`, {
                method: 'DELETE',
                headers: token ? { Authorization: `Bearer ${token}` } : {},
                signal: AbortSignal.timeout(10_000),
            });
            const d = (await res.json());
            if (res.status === 200 && d.ok)
                return { ok: true };
            return { ok: false, error: d.error || 'Could not delete the session.' };
        }
        catch {
            return { ok: false, error: 'Network error — could not delete the session.' };
        }
    }
    /**
     * P8 — rename a past session (sidebar ✏️).
     */
    async renameChatSession(id, title) {
        const token = getAdminToken();
        try {
            const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(id)}/rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                body: JSON.stringify({ title }),
                signal: AbortSignal.timeout(10_000),
            });
            const d = (await res.json());
            if (res.status === 200 && d.ok)
                return { ok: true };
            return { ok: false, error: d.error || 'Could not rename the session.' };
        }
        catch {
            return { ok: false, error: 'Network error — could not rename the session.' };
        }
    }
    /**
     * P4 — load one past session's full transcript (resume in the thread).
     */
    async getChatSession(id) {
        const token = getAdminToken();
        try {
            const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(id)}`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
                signal: AbortSignal.timeout(10_000),
            });
            const d = (await res.json());
            if (res.status === 200 && d.ok && d.session)
                return d.session;
            return null;
        }
        catch {
            return null;
        }
    }
    /**
     * Send one chat message. A turn runs the whole agent tool loop and can take
     * minutes — the 15s admin-request budget would kill it, so this uses its
     * own fetch with a 5-minute cap.
     */
    async chatSend(sessionId, message, opts, signal) {
        const token = getAdminToken();
        try {
            const res = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                body: JSON.stringify({ sessionId, message, provider: opts?.provider, model: opts?.model, projectPath: opts?.projectPath, attachments: opts?.attachments }),
                // P4 — the Cancel button aborts the POST; the 5-minute ceiling still
                // applies alongside the caller's signal.
                signal: signal ? AbortSignal.any([AbortSignal.timeout(300_000), signal]) : AbortSignal.timeout(300_000),
            });
            const d = (await res.json());
            if (res.status === 200 && d.ok) {
                return {
                    ok: true,
                    content: typeof d.content === 'string' ? d.content : '',
                    followups: Array.isArray(d.followups)
                        ? d.followups
                        : [],
                    provider: typeof d.provider === 'string' ? d.provider : null,
                    model: typeof d.model === 'string' ? d.model : null,
                    generationFailed: d.generationFailed === true,
                };
            }
            return {
                ok: false,
                error: typeof d.error === 'string' ? d.error : 'The agent could not answer.',
                unauthorized: res.status === 401,
                forbidden: res.status === 403,
            };
        }
        catch {
            return { ok: false, error: 'Could not reach the dashboard server, or the turn timed out.' };
        }
    }
    /** Forget a chat session's conversation history. */
    async chatReset(sessionId) {
        const r = await this.sendAdminRequest('/api/chat/reset', 'POST', { sessionId });
        if (!r)
            return { ok: false, error: 'Could not reach the dashboard server.' };
        const d = (r.data ?? {});
        return r.status === 200 && d.ok ? { ok: true } : { ok: false, error: d.error || 'Reset failed.' };
    }
    /**
     * Subscribe to a chat session's LIVE progress (agent working steps) and
     * status over SSE. Subscribe BEFORE sending a message so no step is missed.
     * Returns an unsubscribe function.
     */
    subscribeChat(sessionId, handlers) {
        const token = getAdminToken();
        const es = new EventSource(`${this.baseUrl}/api/chat/${encodeURIComponent(sessionId)}/events?token=${encodeURIComponent(token ?? '')}`);
        es.addEventListener('progress', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.line)
                    handlers.onProgress?.(payload.line);
            }
            catch { /* ignore malformed */ }
        });
        es.addEventListener('status', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.status)
                    handlers.onStatus?.(payload.status);
            }
            catch { /* ignore malformed */ }
        });
        es.addEventListener('token', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (typeof payload.text === 'string' && payload.text.length > 0)
                    handlers.onToken?.(payload.text);
            }
            catch { /* ignore malformed */ }
        });
        es.addEventListener('tool', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.tool && (payload.phase === 'started' || payload.phase === 'called')) {
                    handlers.onTool?.({
                        id: payload.id || `call_${Math.random().toString(36).slice(2, 8)}`,
                        tool: payload.tool,
                        phase: payload.phase,
                        args: payload.args,
                        ok: payload.ok,
                        result: payload.result,
                        error: payload.error,
                        durationMs: payload.durationMs,
                    });
                }
            }
            catch { /* ignore malformed */ }
        });
        es.addEventListener('plan', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.goal && Array.isArray(payload.steps)) {
                    handlers.onPlan?.({
                        goal: payload.goal,
                        steps: payload.steps,
                        revision: payload.revision ?? 0,
                    });
                }
            }
            catch { /* ignore malformed */ }
        });
        es.addEventListener('diff', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (Array.isArray(payload.files)) {
                    handlers.onDiff?.({
                        files: payload.files,
                        summary: payload.summary ?? '',
                    });
                }
            }
            catch { /* ignore malformed */ }
        });
        es.addEventListener('skill_draft', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.name && payload.markdown) {
                    handlers.onSkillDraft?.({
                        name: payload.name,
                        description: payload.description ?? '',
                        markdown: payload.markdown,
                        updatedAt: payload.updatedAt ?? 0,
                    });
                }
            }
            catch { /* ignore malformed */ }
        });
        es.addEventListener('secret_request', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.skillName && Array.isArray(payload.missing)) {
                    handlers.onSecretRequest?.({
                        skillName: payload.skillName,
                        missing: payload.missing,
                        persisted: payload.persisted ?? {},
                    });
                }
            }
            catch { /* ignore malformed */ }
        });
        es.addEventListener('execution_result', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.skillName && payload.runtime !== undefined) {
                    handlers.onExecutionResult?.({
                        skillName: payload.skillName,
                        runtime: payload.runtime,
                        success: payload.success ?? false,
                        durationMs: payload.durationMs ?? 0,
                        exitCode: payload.exitCode ?? 0,
                        stdout: payload.stdout ?? '',
                        stderr: payload.stderr ?? '',
                        timestamp: payload.timestamp ?? Date.now(),
                    });
                }
            }
            catch { /* ignore malformed */ }
        });
        es.addEventListener('question', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.questionId && payload.question) {
                    handlers.onQuestion?.({
                        questionId: payload.questionId,
                        question: payload.question,
                        choices: payload.choices ?? [],
                        multiSelect: payload.multiSelect === true,
                    });
                }
            }
            catch { /* ignore malformed */ }
        });
        return () => es.close();
    }
    /**
     * Answer a pending ask_user question (P0.1). Sends the selected option
     * index (or indices for multiSelect), or -1 to skip and let the agent
     * proceed on best judgment.
     */
    async chatRespond(sessionId, questionId, selection = {}) {
        try {
            const res = await fetch(`${this.baseUrl}/api/chat/${encodeURIComponent(sessionId)}/respond`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ questionId, ...selection }),
            });
            const data = (await res.json());
            return { ok: data.ok === true, error: data.error };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    /** P6a — accept a skill draft: promote it into the live stores (hub + compiled). */
    async skillDraftAccept(name) {
        try {
            const res = await fetch(`${this.baseUrl}/api/skills/drafts/${encodeURIComponent(name)}/accept`, {
                method: 'POST',
                headers: { ...authHeaders() },
            });
            const data = (await res.json());
            return { ok: data.ok === true, error: data.error };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    /** P6a — reject a skill draft: discard it (nothing is saved). */
    async skillDraftReject(name) {
        try {
            const res = await fetch(`${this.baseUrl}/api/skills/drafts/${encodeURIComponent(name)}`, {
                method: 'DELETE',
                headers: { ...authHeaders() },
            });
            const data = (await res.json());
            return { ok: data.ok === true, error: data.error };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    /** PA4 — save a skill's env vars (writes to ~/.nuvira/.env or ~/.nuvira/.env). */
    async saveSecrets(vars) {
        try {
            const res = await fetch(`${this.baseUrl}/api/skills/secrets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ vars }),
            });
            const data = (await res.json());
            return { ok: data.ok === true, error: data.error, saved: data.saved };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
}
exports.DashboardAPI = DashboardAPI;
exports.dashboardAPI = new DashboardAPI();
