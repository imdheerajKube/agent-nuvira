import { parseJsonOrNull } from './jsonOrNull';
import type { ExecutionEntry } from './components/ExecutionHistory';
import type {
  AdminAuthStatus,
  AdminCatalog,
  AdminCatalogProvider,
  AdminChecksData,
  AdminLoginResult,
  AdminQuotaConfig,
  AdminQuotaPayload,
  AdminTestResult,
  AdminUsersResult,
  AdminWriteResult,
  DashboardData,
  DAGData,
  HubChannelPolicy,
  HubContact,
  HubData,
  PlatformConfigEntry,
  QuotaInsights,
  RoutingInsights,
  TaskLogLine,
  TaskRecord,
  TaskStatus,
  SkillEnvVarRow,
  TraceEntry,
  WhatsAppPairStatus,
} from './types';

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
function getLocalStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* not a browser-like environment */
  }
  return null;
}

/** In-memory fallback when window.localStorage is unavailable. */
const adminTokenMemory = new Map<string, string>();

function readAdminToken(): string | null {
  const ls = getLocalStorage();
  if (ls) {
    try {
      const v = ls.getItem(ADMIN_TOKEN_KEY);
      if (v) return v;
    } catch {
      /* fall through to memory */
    }
  }
  return adminTokenMemory.get(ADMIN_TOKEN_KEY) ?? null;
}

function writeAdminToken(token: string | null): void {
  const ls = getLocalStorage();
  if (ls) {
    try {
      if (token) ls.setItem(ADMIN_TOKEN_KEY, token);
      else ls.removeItem(ADMIN_TOKEN_KEY);
      return;
    } catch {
      /* fall through to memory */
    }
  }
  if (token) adminTokenMemory.set(ADMIN_TOKEN_KEY, token);
  else adminTokenMemory.delete(ADMIN_TOKEN_KEY);
}

export function getAdminToken(): string | null {
  return readAdminToken();
}

export function setAdminToken(token: string | null): void {
  writeAdminToken(token);
}

/** Authorization header for admin-gated endpoints (empty when unauthenticated). */
export function authHeaders(): Record<string, string> {
  const token = getAdminToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type DashboardListener = (data: DashboardData) => void;
export type ConnectionListener = (connected: boolean) => void;
export type DAGListener = (dag: DAGData) => void;

/**
 * A deferred-retry update from the server: a failed chat turn was re-run after
 * its wait (or gave up), and the result must land in the open conversation.
 *
 * Delivered over the PERSISTENT `/api/sse` channel, not the per-turn chat
 * stream: a retry fires minutes or hours later, long after that stream closed.
 */
export interface ChatRetryEventPayload {
  sessionId: string;
  kind: 'answer' | 'failed' | 'abandoned';
  content: string;
  attempts?: number;
  taskId?: string;
  serverTime?: number;
}

export class DashboardAPI {
  private sse: EventSource | null = null;
  private listeners: Set<DashboardListener> = new Set();
  private connectionListeners: Set<ConnectionListener> = new Set();
  private dagListeners: Set<DAGListener> = new Set();
  private typingListeners: Set<(event: { platform: string; channelId: string; typing: boolean }) => void> = new Set();
  private chatRetryListeners: Set<(event: ChatRetryEventPayload) => void> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private baseUrl: string;
  private lastData: DashboardData | null = null;

  constructor(baseUrl: string = '') {
    this.baseUrl = baseUrl;
  }

  subscribe(listener: DashboardListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onConnectionChange(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }  onDAGEvent(listener: DAGListener): () => void {
    this.dagListeners.add(listener);
    return () => this.dagListeners.delete(listener);
  }

  onTypingEvent(listener: (event: { platform: string; channelId: string; typing: boolean }) => void): () => void {
    this.typingListeners.add(listener);
    return () => this.typingListeners.delete(listener);
  }

  /**
   * Subscribe to background retry updates (see ChatRetryEventPayload).
   * Returns an unsubscribe function.
   */
  onChatRetryEvent(listener: (event: ChatRetryEventPayload) => void): () => void {
    this.chatRetryListeners.add(listener);
    return () => this.chatRetryListeners.delete(listener);
  }


  connect(): void {
    if (this.sse) return;

    this.sse = new EventSource(`${this.baseUrl}/api/sse`);

    this.sse.addEventListener('init', (event) => {
      try {
        const data = JSON.parse(event.data) as DashboardData;
        this.lastData = data;
        this.notify(data);
        this.notifyConnection(true);
      } catch (e) {
        console.error('Failed to parse SSE init data:', e);
      }
    });

    this.sse.addEventListener('refresh', (event) => {
      try {
        const data = JSON.parse(event.data) as DashboardData;
        this.lastData = data;
        this.notify(data);
        this.notifyConnection(true);
      } catch (e) {
        console.error('Failed to parse SSE refresh data:', e);
      }
    });

    this.sse.addEventListener('dag', (event) => {
      try {
        const dag = JSON.parse(event.data) as DAGData;
        this.notifyDAG(dag);
        // Also merge DAG into lastData and notify dashboard listeners
        if (this.lastData) {
          const updated = { ...this.lastData, dag };
          this.lastData = updated;
          this.notify(updated);
        }
      } catch (e) {
        console.error('Failed to parse SSE dag event:', e);
      }
    });

    // Real-time quota pushes: the server watches quota-events.jsonl /
    // quota-ledger.json and emits a `quota` event the moment a failover,
    // park, or window reset lands — so the Failover Timeline updates without
    // waiting for the next 10s refresh tick. Merge into routing.quota.
    this.sse.addEventListener('quota', (event) => {
      try {
        const payload = JSON.parse(event.data) as { quota?: QuotaInsights; serverTime?: number };
        if (this.lastData && payload.quota) {
          const updated: DashboardData = {
            ...this.lastData,
            routing: {
              ...(this.lastData.routing || {}),
              quota: payload.quota,
            } as RoutingInsights,
            serverTime: payload.serverTime || this.lastData.serverTime,
          };
          this.lastData = updated;
          this.notify(updated);
        }
      } catch (e) {
        console.error('Failed to parse SSE quota event:', e);
      }
    });

    // Real-time conversation updates: the server watches chat-history.json
    // and emits a `conversation` event when a new message arrives.
    this.sse.addEventListener('conversation', (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          conversations?: Array<Record<string, unknown>>;
          total?: number;
          serverTime?: number;
        };
        if (this.lastData && payload.conversations) {
          const updated: DashboardData = {
            ...this.lastData,
            conversations: {
              total: payload.total ?? payload.conversations.length,
              recent: payload.conversations as DashboardData['conversations']['recent'],
            },
            serverTime: payload.serverTime || this.lastData.serverTime,
          };
          this.lastData = updated;
          this.notify(updated);
        }
      } catch (e) {
        console.error('Failed to parse SSE conversation event:', e);
      }
    });

    // Real-time typing indicator: gateway writes typing.json when processing,
    // dashboard broadcasts it via SSE so the UI can show a live typing bubble.
    this.sse.addEventListener('typing', (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          platform: string; channelId: string; typing: boolean; serverTime?: number;
        };
        for (const cb of this.typingListeners) {
          try { cb(payload); } catch { /* listener error */ }
        }
      } catch (e) {
        console.error('Failed to parse SSE typing event:', e);
      }
    });

    // A deferred chat retry finished (or gave up). This channel is the only one
    // open at that point — the per-turn chat stream was torn down when the POST
    // that failed resolved.
    this.sse.addEventListener('chat-retry', (event) => {
      try {
        const payload = JSON.parse(event.data) as ChatRetryEventPayload;
        if (!payload || typeof payload.sessionId !== 'string' || typeof payload.content !== 'string') return;
        for (const cb of this.chatRetryListeners) {
          try { cb(payload); } catch { /* listener error must not kill the stream */ }
        }
      } catch (e) {
        console.error('Failed to parse SSE chat-retry event:', e);
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

  disconnect(): void {
    if (this.sse) {
      this.sse.close();
      this.sse = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private reconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, 3000);
  }

  private notify(data: DashboardData): void {
    this.listeners.forEach((fn) => fn(data));
  }

  private notifyDAG(dag: DAGData): void {
    this.dagListeners.forEach((fn) => fn(dag));
  }

  private notifyConnection(connected: boolean): void {
    this.connectionListeners.forEach((fn) => fn(connected));
  }

  async fetchAll(): Promise<DashboardData | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/all`);
      // parseJsonOrNull: an HTML-200 from a stale server degrades to null (with
      // a console.warn hint) so App waits for the next SSE snapshot instead of
      // crashing on "Unexpected token '<'".
      const data = (await parseJsonOrNull(res)) as DashboardData | null;
      if (!data) return null;
      this.lastData = data;
      return data;
    } catch {
      return null;
    }
  }

  /** P0: fetch the reasoning-trace index (list view, no step previews). */
  /**
   * Skill execution audit trail (the `ExecutionHistory` panel's data source).
   *
   * Returns `[]` — never null — so the panel renders its empty state instead of
   * a spinner or a crash when nothing has been audited yet.
   */
  async fetchExecutionAudit(filters?: {
    skillName?: string;
    status?: string;
    limit?: number;
  }): Promise<ExecutionEntry[]> {
    try {
      const params = new URLSearchParams();
      if (filters?.skillName) params.set('skillName', filters.skillName);
      if (filters?.status) params.set('status', filters.status);
      if (filters?.limit) params.set('limit', String(filters.limit));
      const qs = params.toString();
      const res = await fetch(`${this.baseUrl}/api/executions${qs ? `?${qs}` : ''}`, {
        signal: AbortSignal.timeout(8000),
      });
      const data = (await parseJsonOrNull(res)) as { entries?: ExecutionEntry[] } | null;
      return data?.entries ?? [];
    } catch {
      return [];
    }
  }

  async fetchTraces(): Promise<TraceEntry[] | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/traces`, { signal: AbortSignal.timeout(8000) });
      const data = (await parseJsonOrNull(res)) as { total?: number; traces?: TraceEntry[] } | null;
      if (!data?.traces) return null;
      return data.traces;
    } catch {
      return null;
    }
  }

  /**
   * E3c follow-up: run ALL state commands (doctor/system/enterprise checks)
   * on demand — the dashboard command-runner. The server executes the checks
   * (one source with `nuvira doctor`) and returns masked provider status.
   */
  async fetchAdminChecks(): Promise<AdminChecksData | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/admin/checks`, { signal: AbortSignal.timeout(15000) });
      const data = (await parseJsonOrNull(res)) as AdminChecksData | null;
      if (!data || !Array.isArray(data.system) || !Array.isArray(data.enterprise) || !Array.isArray(data.providers)) return null;
      return data;
    } catch {
      return null;
    }
  }

  /** I4: fetch the Agent Hub aggregate (toolsets, channels, artifacts, skills). */
  async fetchHub(): Promise<HubData | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/hub`, { signal: AbortSignal.timeout(8000) });
      const data = (await parseJsonOrNull(res)) as HubData | null;
      if (!data || !Array.isArray(data.toolsets?.toolsets)) return null;
      return data;
    } catch {
      return null;
    }
  }

  /** P0: fetch a single trace's full detail (steps + previews). */
  async fetchTraceDetail(id: string): Promise<TraceEntry | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/traces/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) });
      const data = (await parseJsonOrNull(res)) as TraceEntry | null;
      return data && Array.isArray(data.steps) ? data : null;
    } catch {
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
  private async sendAdminRequest(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<{ status: number; data: unknown } | null> {
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
      let data: unknown = null;
      if (type.includes('application/json') || type.includes('text/json')) {
        try { data = await res.json(); } catch { data = null; }
      }
      return { status: res.status, data };
    } catch {
      return null;
    }
  }

  /** Is the admin surface configured + is the stored token still valid? */
  async fetchAdminAuthStatus(): Promise<AdminAuthStatus | null> {
    const r = await this.sendAdminRequest('/api/admin/auth-status', 'GET');
    if (!r || typeof r.data !== 'object' || r.data === null) return null;
    const d = r.data as Record<string, unknown>;
    if (typeof d.configured !== 'boolean' || typeof d.authenticated !== 'boolean') return null;
    return {
      configured: d.configured,
      authenticated: d.authenticated,
      user: typeof d.user === 'string' ? d.user : null,
      role: typeof d.role === 'string' ? d.role : null,
      mustChangePassword: d.mustChangePassword === true,
    };
  }

  /**
   * Change the signed-in admin's password. This is the ONLY mutating admin call
   * the server allows while the first-run default is still in place, so it is
   * what clears the forced-change gate.
   */
  async changeAdminPassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.sendAdminRequest('/api/admin/change-password', 'POST', {
      currentPassword,
      newPassword,
    });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as { ok?: boolean; error?: string };
    if (r.status === 200 && d.ok) return { ok: true };
    return { ok: false, error: d.error || 'Could not change the password.' };
  }

  /** The dashboard admin users (role.manage = admin only). */
  async fetchAdminUsers(): Promise<AdminUsersResult> {
    const r = await this.sendAdminRequest('/api/admin/users', 'GET');
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminUsersResult;
    if (r.status === 200 && d.ok && Array.isArray(d.users)) return d;
    return { ok: false, error: d.error || 'Failed to load users.', forbidden: r.status === 403, unauthorized: r.status === 401 };
  }

  /** Add a dashboard admin user with a role (admin only). */
  async addAdminUser(user: string, password: string, role: string): Promise<AdminUsersResult> {
    const r = await this.sendAdminRequest('/api/admin/users', 'POST', { user, password, role });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminUsersResult;
    if (r.status === 200 && d.ok) return d;
    return { ok: false, error: d.error || 'Failed to add user.', forbidden: r.status === 403, unauthorized: r.status === 401 };
  }

  /** Remove a dashboard admin user (admin only). */
  async removeAdminUser(user: string): Promise<AdminUsersResult> {
    const r = await this.sendAdminRequest(`/api/admin/users/${encodeURIComponent(user)}`, 'DELETE');
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminUsersResult;
    if (r.status === 200 && d.ok) return d;
    return { ok: false, error: d.error || 'Failed to remove user.', forbidden: r.status === 403, unauthorized: r.status === 401 };
  }

  /** The provider catalog (Add-provider selector source). */
  async fetchAdminCatalog(): Promise<AdminCatalogProvider[] | null> {
    const r = await this.sendAdminRequest('/api/admin/catalog', 'GET');
    const d = r?.data as AdminCatalog | null;
    if (!d || !Array.isArray(d.providers)) return null;
    return d.providers;
  }

  /** Bootstrap the admin credential (only valid while unconfigured). */
  async adminSetup(user: string, password: string): Promise<AdminLoginResult> {
    const r = await this.sendAdminRequest('/api/admin/setup', 'POST', { user, password });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminLoginResult;
    if (r.status === 200 && typeof d.token === 'string') {
      setAdminToken(d.token);
      return { ok: true, user: d.user, token: d.token };
    }
    return { ok: false, error: d.error || 'Setup failed.', unauthorized: r.status === 401 };
  }

  /** Login with the admin user-id + password. Persists the returned token. */
  async adminLogin(user: string, password: string): Promise<AdminLoginResult> {
    const r = await this.sendAdminRequest('/api/admin/login', 'POST', { user, password });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminLoginResult;
    if (r.status === 200 && typeof d.token === 'string') {
      setAdminToken(d.token);
      return { ok: true, user: d.user, token: d.token };
    }
    return { ok: false, error: d.error || 'Login failed.', unauthorized: r.status === 401 };
  }

  /** Log out — revoke the stored token server-side and locally. */
  async adminLogout(): Promise<void> {
    await this.sendAdminRequest('/api/admin/logout', 'POST');
    setAdminToken(null);
  }

  /**
   * Shut down the gateway or the dashboard server itself (the GUI twin of
   * `nuvira gateway stop` / `nuvira dashboard stop`). Admin-gated: dashboard
   * requires system.manage (admin), gateway requires gateway.manage
   * (admin + operator). Stopping the dashboard kills THIS page's server.
   */
  async shutdown(
    target: 'dashboard' | 'gateway',
  ): Promise<AdminWriteResult & { stopped?: boolean; reason?: string }> {
    const r = await this.sendAdminRequest('/api/admin/shutdown', 'POST', { target });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult & { stopped?: boolean; reason?: string };
    if (r.status === 200 && d.ok) return d;
    return { ok: false, error: d.error || 'Shutdown failed.', unauthorized: r.status === 401, forbidden: r.status === 403 };
  }

  /** Save/update a provider's key + config (authed). Mirrors `nuvira config set providers.*`. */
  async saveProvider(
    type: string,
    fields: { apiKey?: string; baseUrl?: string; model?: string; runner?: string },
  ): Promise<AdminWriteResult> {
    const r = await this.sendAdminRequest(`/api/admin/providers/${encodeURIComponent(type)}`, 'PUT', fields);
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult;
    if (r.status === 200 && d.ok) return d;
    return { ok: false, error: d.error || 'Save failed.', unauthorized: r.status === 401 };
  }

  /** Remove a provider's key + credential fields (authed). */
  async deleteProvider(type: string): Promise<AdminWriteResult> {
    const r = await this.sendAdminRequest(`/api/admin/providers/${encodeURIComponent(type)}`, 'DELETE');
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult;
    if (r.status === 200 && d.ok) return d;
    return { ok: false, error: d.error || 'Remove failed.', unauthorized: r.status === 401 };
  }

  /** Test a provider's configured credentials (authed — lists its models). */
  async testProvider(type: string): Promise<AdminTestResult> {
    const r = await this.sendAdminRequest(`/api/admin/providers/${encodeURIComponent(type)}/test`, 'POST');
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminTestResult;
    if (r.status === 200) return d;
    return { ok: false, error: d.error || 'Test failed.', unauthorized: r.status === 401 };
  }

  /** The user-declared budget (routing.quota + cost cap). Read is open. */
  async fetchAdminQuota(): Promise<AdminQuotaConfig | null> {
    const r = await this.sendAdminRequest('/api/admin/quota', 'GET');
    if (!r) return null;
    const d = r.data as AdminQuotaConfig | null;
    if (!d || !d.ok || typeof d.quota !== 'object') return null;
    return d;
  }

  /**
   * I5: toggle a toolset's enabled state (authed — routing.operate). The
   * server persists it to buffconfig; the I1 runtime gate (schema + execution)
   * honors it immediately, so the dashboard toggle is never cosmetic.
   */
  async setToolsetEnabled(name: string, enabled: boolean): Promise<AdminWriteResult> {
    const r = await this.sendAdminRequest(`/api/admin/hub/toolsets/${encodeURIComponent(name)}`, 'PUT', { enabled });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult;
    if (r.status === 200 && d.ok) return d;
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
  async setSkillEnabled(name: string, enabled: boolean): Promise<AdminWriteResult> {
    const r = await this.sendAdminRequest(`/api/admin/hub/skills/${encodeURIComponent(name)}`, 'PUT', { enabled });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult;
    if (r.status === 200 && d.ok) return d;
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
  async marketplaceSearch(query: string): Promise<Array<{
    name: string;
    version: string;
    description: string;
    author: string;
    tags: string[];
    source: string;
    sourceKind: string;
  }>> {
    try {
      const res = await fetch(`${this.baseUrl}/api/skills/marketplace?q=${encodeURIComponent(query)}`, {
        headers: authHeaders(),
      });
      const d = (await res.json()) as { results?: Array<{
        name: string; version: string; description: string; author: string; tags: string[]; source: string; sourceKind: string;
      }> };
      return Array.isArray(d.results) ? d.results : [];
    } catch {
      return [];
    }
  }

  /** P6d — install a marketplace skill (sandboxed + checksum-verified). */
  async marketplaceInstall(name: string): Promise<{ ok: boolean; error?: string; quarantined?: boolean }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/skills/marketplace/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ name }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string; quarantined?: boolean };
      if (res.status === 200 && d.ok) return { ok: true };
      return { ok: false, error: d.error || 'Install failed.', quarantined: d.quarantined === true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** P6d — uninstall a marketplace skill (removes dir + provenance). */
  async marketplaceUninstall(name: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/skills/marketplace/uninstall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ name }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (res.status === 200 && d.ok) return { ok: true };
      return { ok: false, error: d.error || 'Uninstall failed.' };
    } catch (err) {
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
  async sendChannelMessage(target: string, text: string): Promise<AdminWriteResult & { platform?: string; channelId?: string }> {
    const r = await this.sendAdminRequest('/api/admin/hub/channels/send', 'POST', { target, text });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult & { platform?: string; channelId?: string };
    if (r.status === 200 && d.ok) return d;
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
  async gatewayPolicies(): Promise<{ ok: boolean; policies?: Record<string, HubChannelPolicy>; statusRecipients?: string[]; contacts?: HubContact[]; askUserWait?: boolean; askUserTimeoutMs?: number; error?: string; unauthorized?: boolean; forbidden?: boolean }> {
    const r = await this.sendAdminRequest('/api/admin/gateway/policies', 'GET');
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as { ok?: boolean; policies?: Record<string, HubChannelPolicy>; statusRecipients?: string[]; contacts?: HubContact[]; askUserWait?: boolean; askUserTimeoutMs?: number; error?: string };
    if (r.status === 200 && d.ok) return { ok: true, policies: d.policies, statusRecipients: d.statusRecipients, contacts: d.contacts, askUserWait: d.askUserWait, askUserTimeoutMs: d.askUserTimeoutMs };
    return { ok: false, error: d.error || 'Failed to read policies.', unauthorized: r.status === 401, forbidden: r.status === 403 };
  }

  async saveGatewayPolicies(
    policies: Record<string, HubChannelPolicy>,
    statusRecipients?: string[],
    contacts?: HubContact[],
    askUser?: { wait: boolean; timeoutMs?: number },
  ): Promise<AdminWriteResult> {
    const body: Record<string, unknown> = { policies };
    if (Array.isArray(statusRecipients)) body.statusRecipients = statusRecipients;
    if (Array.isArray(contacts)) body.contacts = contacts;
    if (askUser) {
      body.askUserWait = askUser.wait;
      if (typeof askUser.timeoutMs === 'number') body.askUserTimeoutMs = askUser.timeoutMs;
    }
    const r = await this.sendAdminRequest('/api/admin/gateway/policies', 'PUT', body);
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult;
    if (r.status === 200 && d.ok) return d;
    return { ok: false, error: d.error || 'Failed to save policies.', unauthorized: r.status === 401, forbidden: r.status === 403 };
  }

  /** Fetch paginated gateway conversations with optional search. */
  async fetchGatewayConversations(opts: { offset?: number; limit?: number; q?: string } = {}): Promise<{ ok: boolean; conversations?: Array<{ key: string; platform: string; channelId: string; contactName?: string; messageCount: number; lastActiveAt: number; lastUserMessage: string; lastAssistantMessage: string; messages?: Array<{ role: 'user' | 'assistant'; content: string; ts: number }> }>; total?: number; hasMore?: boolean; error?: string }> {
    const params = new URLSearchParams();
    if (opts.offset) params.set('offset', String(opts.offset));
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.q) params.set('q', opts.q);
    const qs = params.toString();
    const r = await this.sendAdminRequest(`/api/admin/gateway/conversations${qs ? `?${qs}` : ''}`, 'GET');
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as { ok?: boolean; conversations?: unknown[]; total?: number; hasMore?: boolean; error?: string };
    if (r.status === 200 && d.ok) return { ok: true, conversations: d.conversations as never[], total: d.total, hasMore: d.hasMore };
    return { ok: false, error: d.error || 'Failed to load conversations.', unauthorized: r.status === 401, forbidden: r.status === 403 };
  }

  /** Clear a single gateway conversation by its key (e.g. "whatsapp:918800663237"). */
  async clearGatewayConversation(key: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.sendAdminRequest('/api/admin/gateway/conversations', 'DELETE', { key });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as { ok?: boolean; error?: string };
    if (r.status === 200 && d.ok) return { ok: true };
    return { ok: false, error: d.error || 'Failed to clear conversation.', unauthorized: r.status === 401, forbidden: r.status === 403 };
  }

  /** Add a tag to a conversation. */
  async addConversationTag(key: string, tag: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.sendAdminRequest('/api/admin/gateway/conversations/tags', 'PUT', { action: 'add', key, tag });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as { ok?: boolean; error?: string };
    if (r.status === 200 && d.ok) return { ok: true };
    return { ok: false, error: d.error || 'Failed to add tag.', unauthorized: r.status === 401, forbidden: r.status === 403 };
  }

  /** Remove a tag from a conversation. */
  async removeConversationTag(key: string, tag: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.sendAdminRequest('/api/admin/gateway/conversations/tags', 'PUT', { action: 'remove', key, tag });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as { ok?: boolean; error?: string };
    if (r.status === 200 && d.ok) return { ok: true };
    return { ok: false, error: d.error || 'Failed to remove tag.', unauthorized: r.status === 401, forbidden: r.status === 403 };
  }

  /** Get all unique tags across all conversations. */
  async getAllConversationTags(): Promise<{ ok: boolean; tags?: string[]; error?: string }> {
    const r = await this.sendAdminRequest('/api/admin/gateway/conversations/tags', 'PUT', { action: 'getAllTags' });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as { ok?: boolean; tags?: string[]; error?: string };
    if (r.status === 200 && d.ok) return { ok: true, tags: d.tags };
    return { ok: false, error: d.error || 'Failed to load tags.', unauthorized: r.status === 401, forbidden: r.status === 403 };
  }

  /** Bulk export conversations as a ZIP file. Triggers a browser download. */
  async exportGatewayConversations(keys: string[]): Promise<{ ok: boolean; error?: string }> {
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
      const d = await res.json().catch(() => ({})) as { error?: string };
      return { ok: false, error: d.error || 'Export failed.' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── Contacts management (name-centric outbound contacts) ────────────────

  /** List all contacts (name, platform, id, phone, status). */
  async getContacts(): Promise<{ ok: boolean; contacts?: Array<{ name: string; platform: string; id: string; phone?: string; status: string; registeredAt: number; addedAt: number }>; error?: string }> {
    const r = await this.sendAdminRequest('/api/admin/contacts', 'GET');
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as { ok?: boolean; contacts?: unknown[]; error?: string };
    if (r.status === 200 && d.ok) return { ok: true, contacts: d.contacts as never[] };
    return { ok: false, error: d.error || 'Failed to read contacts.' };
  }

  /** Approve a contact by platform + name or ID. */
  async approveContact(platform: string, nameOrId: string): Promise<AdminWriteResult> {
    return this.contactAction('approve', platform, nameOrId);
  }

  /** Reject a contact by platform + name or ID. */
  async rejectContact(platform: string, nameOrId: string): Promise<AdminWriteResult> {
    return this.contactAction('reject', platform, nameOrId);
  }

  /** Delete a contact by platform + name or ID. */
  async deleteContact(platform: string, nameOrId: string): Promise<AdminWriteResult> {
    return this.contactAction('delete', platform, nameOrId);
  }

  /** Update a contact's name, phone, or status. */
  async updateContact(platform: string, id: string, fields: { name?: string; phone?: string; status?: string }): Promise<AdminWriteResult> {
    const r = await this.sendAdminRequest('/api/admin/contacts', 'PUT', { action: 'update', platform, id, ...fields });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult;
    if (r.status === 200 && d.ok) return d;
    return { ok: false, error: d.error || 'Update failed.' };
  }

  private async contactAction(action: string, platform: string, nameOrId: string): Promise<AdminWriteResult> {
    const r = await this.sendAdminRequest('/api/admin/contacts', 'PUT', { action, platform, nameOrId });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult;
    if (r.status === 200 && d.ok) return d;
    return { ok: false, error: d.error || `${action} failed.` };
  }

  /**
   * Platform transport config (GUI parity with `nuvira config gateway`): list
   * every env-configurable platform with current per-var values (full values
   * only for admin/operator). Authed.
   */
  async getPlatformConfigs(): Promise<PlatformConfigEntry[]> {
    const r = await this.sendAdminRequest('/api/config/platforms', 'GET');
    if (!r) return [];
    const d = (r.data ?? {}) as { platforms?: PlatformConfigEntry[] };
    return Array.isArray(d.platforms) ? d.platforms : [];
  }

  /** Write a platform's env values to ~/.nuvira/.env (authed — routing.operate). */
  async setPlatformConfig(platform: string, values: Record<string, string>): Promise<AdminWriteResult> {
    const r = await this.sendAdminRequest(`/api/config/platforms/${encodeURIComponent(platform)}`, 'POST', { values });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult;
    if (r.status === 200 && d.ok) return d;
    return {
      ok: false,
      error: d.error || 'Save failed.',
      unauthorized: r.status === 401,
      forbidden: r.status === 403,
    };
  }

  /** Remove a platform's env values from ~/.nuvira/.env (authed — routing.operate). */
  async removePlatformConfig(platform: string): Promise<AdminWriteResult> {
    const r = await this.sendAdminRequest(`/api/config/platforms/${encodeURIComponent(platform)}`, 'DELETE');
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult;
    if (r.status === 200 && d.ok) return d;
    return {
      ok: false,
      error: d.error || 'Remove failed.',
      unauthorized: r.status === 401,
      forbidden: r.status === 403,
    };
  }

  /** Verify a platform's token by calling the platform's API (e.g. Telegram getMe). */
  async verifyPlatformConfig(platform: string, values: Record<string, string>): Promise<{ ok: boolean; info?: string; error?: string }> {
    const r = await this.sendAdminRequest(`/api/config/platforms/${encodeURIComponent(platform)}/verify`, 'POST', { values });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as { ok?: boolean; info?: string; error?: string };
    return { ok: d.ok ?? false, info: d.info, error: d.error };
  }

  /**
   * Save the user-declared budget (authed). Quota fields are gated by
   * routing.operate (admin + operator); the cost cap by policy.write (admin).
   */
  async saveAdminQuota(body: AdminQuotaPayload): Promise<AdminWriteResult> {
    const r = await this.sendAdminRequest('/api/admin/quota', 'PUT', body);
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult;
    if (r.status === 200 && d.ok) return d;
    return { ok: false, error: d.error || 'Save failed.', unauthorized: r.status === 401 };
  }

  // ─── Bedrock onboarding ───────────────────────────────────────────────────

  /** Get current Bedrock configuration status. */
  async getBedrockStatus(): Promise<{ configured: boolean; region: string; authMethod: string; apiKeySet: boolean; iamKeySet: boolean }> {
    const r = await this.sendAdminRequest('/api/bedrock/status', 'GET');
    if (!r || r.status !== 200) {
      return { configured: false, region: 'us-east-1', authMethod: 'none', apiKeySet: false, iamKeySet: false };
    }
    return (r.data ?? {}) as { configured: boolean; region: string; authMethod: string; apiKeySet: boolean; iamKeySet: boolean };
  }

  /** Save Bedrock env vars (credentials + region) to ~/.nuvira/.env. */
  async setupBedrock(envVars: Record<string, string>): Promise<{ ok: boolean; error?: string; envVarsWritten?: string[] }> {
    const r = await this.sendAdminRequest('/api/bedrock/setup', 'POST', { envVars });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as { ok?: boolean; error?: string; envVarsWritten?: string[] };
    if (r.status === 200 && d.ok) return { ok: true, envVarsWritten: d.envVarsWritten };
    return { ok: false, error: d.error || 'Save failed.' };
  }

  /** Probe Bedrock models in a region — returns accessibility status for each. */
  async probeBedrock(region: string): Promise<{ ok: boolean; models?: Array<{ modelId: string; status: string; httpStatus?: number }>; error?: string }> {
    const r = await this.sendAdminRequest('/api/bedrock/probe', 'POST', { region });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as { ok?: boolean; models?: Array<{ modelId: string; status: string; httpStatus?: number }>; error?: string };
    if (r.status === 200 && d.ok) return { ok: true, models: d.models };
    return { ok: false, error: d.error || 'Probe failed.' };
  }

  // ─── P1 task runner (command console) ─────────────────────────────────────

  /** Recent task history, newest first (authed — running commands is a write action). */
  async listTasks(): Promise<{ status: number; tasks: TaskRecord[] } | null> {
    const r = await this.sendAdminRequest('/api/tasks', 'GET');
    if (!r) return null;
    const d = (r.data ?? {}) as { ok?: boolean; tasks?: TaskRecord[] };
    return { status: r.status, tasks: Array.isArray(d.tasks) ? d.tasks : [] };
  }

  /** Start a CLI task: args = the command line split into argv (e.g. ['eval','run','--task','smoke']). */
  async startTask(args: string[], timeoutMs?: number): Promise<AdminWriteResult & { task?: TaskRecord }> {
    const r = await this.sendAdminRequest('/api/tasks', 'POST', { args, timeoutMs });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult & { task?: TaskRecord };
    if (r.status === 200 && d.ok && d.task) return d;
    return { ok: false, error: d.error || 'Start failed.', unauthorized: r.status === 401, forbidden: r.status === 403 };
  }

  /** Full task detail (logs included). */
  async getTask(id: string): Promise<{ status: number; task: TaskRecord | null } | null> {
    const r = await this.sendAdminRequest(`/api/tasks/${encodeURIComponent(id)}`, 'GET');
    if (!r) return null;
    const d = (r.data ?? {}) as { ok?: boolean; task?: TaskRecord };
    return { status: r.status, task: d.task ?? null };
  }

  /** Cancel a running task (SIGTERM). */
  async cancelTask(id: string): Promise<AdminWriteResult> {
    const r = await this.sendAdminRequest(`/api/tasks/${encodeURIComponent(id)}/cancel`, 'POST');
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult;
    if (r.status === 200 && d.ok) return d;
    return { ok: false, error: d.error || 'Cancel failed.', unauthorized: r.status === 401, forbidden: r.status === 403 };
  }

  /**
   * Subscribe to a task's live log/status events over SSE. EventSource can't
   * set Authorization headers, so the admin token rides the ?token= query.
   * Returns an unsubscribe function.
   */
  subscribeTask(
    id: string,
    handlers: { onLog?: (line: TaskLogLine) => void; onStatus?: (status: TaskStatus) => void },
  ): () => void {
    const token = getAdminToken();
    const es = new EventSource(`${this.baseUrl}/api/tasks/${encodeURIComponent(id)}/events?token=${encodeURIComponent(token ?? '')}`);
    es.addEventListener('log', (event) => {
      try {
        handlers.onLog?.(JSON.parse((event as MessageEvent).data) as TaskLogLine);
      } catch { /* ignore malformed */ }
    });
    es.addEventListener('status', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { status?: TaskStatus };
        if (payload.status) handlers.onStatus?.(payload.status);
      } catch { /* ignore malformed */ }
    });
    return () => es.close();
  }

  // ─── P2 — in-page WhatsApp pairing (GUI parity with `nuvira whatsapp pair`) ──

  /** Current pairing status (state, QR data URL, code, session dir). */
  async getWhatsAppStatus(): Promise<{ status: WhatsAppPairStatus; contacts: Record<string, string> } | null> {
    const r = await this.sendAdminRequest('/api/whatsapp', 'GET');
    if (!r) return null;
    const d = (r.data ?? {}) as { ok?: boolean; status?: WhatsAppPairStatus; contacts?: Record<string, string> };
    return r.status === 200 && d.ok && d.status ? { status: d.status, contacts: d.contacts ?? {} } : null;
  }

  /** Start pairing — QR mode, or phone mode when `phone` (intl, no +) is set. */
  async startWhatsAppPair(phone?: string): Promise<AdminWriteResult> {
    const r = await this.sendAdminRequest('/api/whatsapp/pair', 'POST', { phone: phone || undefined });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult;
    if (r.status === 200 && d.ok) return d;
    return { ok: false, error: d.error || 'Pairing failed to start.', unauthorized: r.status === 401, forbidden: r.status === 403 };
  }

  /** Abort the active pairing. */
  async cancelWhatsAppPair(): Promise<AdminWriteResult> {
    const r = await this.sendAdminRequest('/api/whatsapp/cancel', 'POST');
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult;
    if (r.status === 200 && d.ok) return d;
    return { ok: false, error: d.error || 'Cancel failed.', unauthorized: r.status === 401, forbidden: r.status === 403 };
  }

  /** Remove the paired WhatsApp session from disk. */
  async unpairWhatsApp(): Promise<AdminWriteResult> {
    const r = await this.sendAdminRequest('/api/whatsapp/unpair', 'POST');
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult;
    if (r.status === 200 && d.ok) return d;
    return { ok: false, error: d.error || 'Unpair failed.', unauthorized: r.status === 401, forbidden: r.status === 403 };
  }

  /**
   * Subscribe to pairing events over SSE: qr (PNG data URL) / code (8-char)
   * / status. EventSource can't set Authorization headers, so the admin
   * token rides the ?token= query. Returns an unsubscribe function.
   */
  subscribeWhatsApp(handlers: {
    onQr?: (qr: string) => void;
    onCode?: (code: string) => void;
    onStatus?: (status: WhatsAppPairStatus) => void;
  }): () => void {
    const token = getAdminToken();
    const es = new EventSource(`${this.baseUrl}/api/whatsapp/events?token=${encodeURIComponent(token ?? '')}`);
    es.addEventListener('qr', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { qr?: string };
        if (payload.qr) handlers.onQr?.(payload.qr);
      } catch { /* ignore malformed */ }
    });
    es.addEventListener('code', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { code?: string };
        if (payload.code) handlers.onCode?.(payload.code);
      } catch { /* ignore malformed */ }
    });
    es.addEventListener('status', (event) => {
      try {
        handlers.onStatus?.(JSON.parse((event as MessageEvent).data) as WhatsAppPairStatus);
      } catch { /* ignore malformed */ }
    });
    return () => es.close();
  }

  // ─── P3 — chat console (GUI parity with `nuvira chat "<prompt>"`) ─────────

  /**
   * Resolve a plain-English ask into the CLI command(s) the intent router
   * would run — the Chat UI calls this BEFORE the agent so deterministic
   * commands ("stop the dashboard") short-circuit to a confirm card.
   */
  async chatResolve(message: string): Promise<{ ok: boolean; matches: unknown[]; error?: string }> {
    const token = getAdminToken();
    try {
      const res = await fetch(`${this.baseUrl}/api/chat/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(10_000),
      });
      const d = (await res.json()) as Record<string, unknown>;
      if (res.status === 200 && d.ok && Array.isArray(d.matches)) return { ok: true, matches: d.matches };
      return { ok: false, matches: [], error: typeof d.error === 'string' ? d.error : 'Resolve failed.' };
    } catch {
      return { ok: false, matches: [], error: 'Could not reach the dashboard server.' };
    }
  }

  /**
   * P3 — project picker: the dashboard's cwd + recently attached paths.
   */
  async listProjects(): Promise<Array<{ path: string; name: string; kind: 'cwd' | 'recent' }>> {
    const token = getAdminToken();
    try {
      const res = await fetch(`${this.baseUrl}/api/projects`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      const d = (await res.json()) as { ok?: boolean; projects?: Array<{ path: string; name: string; kind: 'cwd' | 'recent' }> };
      if (res.status === 200 && d.ok && Array.isArray(d.projects)) return d.projects;
      return [];
    } catch {
      return [];
    }
  }

  /**
   * P3 — attach a project directory (server builds the bounded context
   * snapshot: code map + file tree, cached by path).
   */
  async attachProject(path: string): Promise<{ ok: boolean; project?: { path: string; name: string; fileCount: number; symbolCount: number; truncated: boolean }; error?: string }> {
    const token = getAdminToken();
    try {
      const res = await fetch(`${this.baseUrl}/api/projects/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ path }),
        signal: AbortSignal.timeout(30_000),
      });
      const d = (await res.json()) as { ok?: boolean; project?: { path: string; name: string; fileCount: number; symbolCount: number; truncated: boolean }; error?: string };
      if (res.status === 200 && d.ok && d.project) return { ok: true, project: d.project };
      return { ok: false, error: typeof d.error === 'string' ? d.error : 'Attach failed.' };
    } catch {
      return { ok: false, error: 'Could not reach the dashboard server.' };
    }
  }

  /**
   * Browse directories for the project picker folder browser.
   * Returns subdirectories of the given path (or home dir if empty).
   * showDrives=true returns drive roots (Windows drives, Mac /Volumes).
   */
  async browseDirectories(path?: string, opts?: { showDrives?: boolean }): Promise<{
    ok: boolean; path: string;
    entries: Array<{ name: string; path: string; isDir?: boolean; modified?: number }>;
    parent: string | null; isProject: boolean; error?: string;
    drives?: Array<{ name: string; path: string; type: string }>;
    breadcrumbs?: Array<{ name: string; path: string }>;
  }> {
    const token = getAdminToken();
    try {
      const params = new URLSearchParams();
      if (path) params.set('path', path);
      if (opts?.showDrives) params.set('showDrives', '1');
      const query = params.toString() ? `?${params.toString()}` : '';
      const res = await fetch(`${this.baseUrl}/api/browse${query}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      const d = (await res.json()) as any;
      if (res.status === 200 && d.ok && Array.isArray(d.entries)) {
        return {
          ok: true, path: d.path ?? '', entries: d.entries, parent: d.parent ?? null,
          isProject: d.isProject ?? false, drives: d.drives, breadcrumbs: d.breadcrumbs,
        };
      }
      return { ok: false, path: '', entries: [], parent: null, isProject: false, error: typeof d.error === 'string' ? d.error : 'Browse failed.' };
    } catch {
      return { ok: false, path: '', entries: [], parent: null, isProject: false, error: 'Could not reach the dashboard server.' };
    }
  }

  /**
   * Resolve a folder name to its absolute path by searching common locations.
   * Used by the native folder picker (webkitdirectory) which only returns the name.
   */
  async resolveFolder(name: string, subPath?: string): Promise<{ ok: boolean; path: string; error?: string }> {
    const token = getAdminToken();
    try {
      const res = await fetch(this.baseUrl + '/api/browse/resolve-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify({ name, subPath: subPath || '' }),
        signal: AbortSignal.timeout(10_000),
      });
      const d = (await res.json()) as { ok?: boolean; path?: string; error?: string };
      if (res.status === 200 && d.ok && d.path) return { ok: true, path: d.path };
      return { ok: false, path: '', error: typeof d.error === 'string' ? d.error : 'Could not resolve folder.' };
    } catch {
      return { ok: false, path: '', error: 'Could not reach the dashboard server.' };
    }
  }

  /**
   * P4 — session sidebar: list past conversations (title, preview, counts).
   */
  async listChatSessions(): Promise<Array<{ id: string; title: string; turnCount: number; createdAt: number; updatedAt: number; preview: string; firstUser: string; projectPath?: string }>> {
    const token = getAdminToken();
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      const d = (await res.json()) as { ok?: boolean; sessions?: Array<{ id: string; title: string; turnCount: number; createdAt: number; updatedAt: number; preview: string; firstUser: string; projectPath?: string }> };
      if (res.status === 200 && d.ok && Array.isArray(d.sessions)) return d.sessions;
      return [];
    } catch {
      return [];
    }
  }

  /**
   * P8 — delete a past session (sidebar ✕).
   */
  async deleteChatSession(id: string): Promise<{ ok: boolean; error?: string }> {
    const token = getAdminToken();
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (res.status === 200 && d.ok) return { ok: true };
      return { ok: false, error: d.error || 'Could not delete the session.' };
    } catch {
      return { ok: false, error: 'Network error — could not delete the session.' };
    }
  }

  /**
   * P8 — rename a past session (sidebar ✏️).
   */
  async renameChatSession(id: string, title: string): Promise<{ ok: boolean; error?: string }> {
    const token = getAdminToken();
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(id)}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ title }),
        signal: AbortSignal.timeout(10_000),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (res.status === 200 && d.ok) return { ok: true };
      return { ok: false, error: d.error || 'Could not rename the session.' };
    } catch {
      return { ok: false, error: 'Network error — could not rename the session.' };
    }
  }

  /**
   * P4 — load one past session's full transcript (resume in the thread).
   */
  async getChatSession(id: string): Promise<{ turns: Array<{ role: 'user' | 'assistant'; content: string }>; title: string; updatedAt: number; projectPath?: string } | null> {
    const token = getAdminToken();
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(id)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      const d = (await res.json()) as { ok?: boolean; session?: { turns: Array<{ role: 'user' | 'assistant'; content: string }>; title: string; updatedAt: number; projectPath?: string } };
      if (res.status === 200 && d.ok && d.session) return d.session;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Send one chat message. A turn runs the whole agent tool loop and can take
   * minutes — the 15s admin-request budget would kill it, so this uses its
   * own fetch with a 5-minute cap.
   */
  async chatSend(
    sessionId: string,
    message: string,
    opts?: { provider?: string; model?: string; projectPath?: string; attachments?: Array<{ name: string; content: string; kind?: string }> },
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; content: string; followups: Array<{ prompt: string; label?: string }>; provider: string | null; model: string | null; generationFailed: boolean; retryQueued?: boolean }
    | { ok: false; error: string; unauthorized?: boolean; forbidden?: boolean }
  > {
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
      const d = (await res.json()) as Record<string, unknown>;
      if (res.status === 200 && d.ok) {
        return {
          ok: true,
          content: typeof d.content === 'string' ? d.content : '',
          followups: Array.isArray(d.followups)
            ? (d.followups as Array<{ prompt: string; label?: string }>)
            : [],
          provider: typeof d.provider === 'string' ? d.provider : null,
          model: typeof d.model === 'string' ? d.model : null,
          generationFailed: d.generationFailed === true,
          retryQueued: d.retryQueued === true,
        };
      }
      return {
        ok: false,
        error: typeof d.error === 'string' ? d.error : 'The agent could not answer.',
        unauthorized: res.status === 401,
        forbidden: res.status === 403,
      };
    } catch {
      return { ok: false, error: 'Could not reach the dashboard server, or the turn timed out.' };
    }
  }

  /** Forget a chat session's conversation history. */
  async chatReset(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.sendAdminRequest('/api/chat/reset', 'POST', { sessionId });
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as { ok?: boolean; error?: string };
    return r.status === 200 && d.ok ? { ok: true } : { ok: false, error: d.error || 'Reset failed.' };
  }

  /**
   * Subscribe to a chat session's LIVE progress (agent working steps) and
   * status over SSE. Subscribe BEFORE sending a message so no step is missed.
   * Returns an unsubscribe function.
   */
  subscribeChat(
    sessionId: string,
    handlers: {
      onProgress?: (line: string) => void;
      onStatus?: (status: string) => void;
      /**
       * P4 — one content token of the answer as it streams (the typewriter).
       * The POST response remains authoritative — replace the streamed text
       * with its content when the turn resolves.
       */
      onToken?: (text: string) => void;
      /** P0.6 — a tool-call lifecycle step (rendered as a card). */
      onTool?: (t: { id: string; tool: string; phase: 'started' | 'called'; args?: string; ok?: boolean; result?: string; error?: string; durationMs?: number }) => void;
      /** P0.7 — a plan mutation (rendered as a live checklist card). */
      onPlan?: (p: { goal: string; steps: Array<{ id: string; description: string; status: string }>; revision: number }) => void;
      /** P3b — a git diff payload (rendered as a 🔧 diff card). */
      onDiff?: (d: { files: Array<{ path: string; body: string }>; summary: string }) => void;
      onQuestion?: (q: { questionId: string; question: string; choices: Array<{ label: string; description?: string }>; multiSelect: boolean }) => void;
      /** P6a — a skill draft (the /learn preview card: accept/edit/reject). */
      onSkillDraft?: (d: { name: string; description: string; markdown: string; updatedAt: number }) => void;
      /** PA4 — a skill loaded but needs env vars (notification card with save). */
      onSecretRequest?: (d: { skillName: string; missing: string[]; persisted: Record<string, boolean> }) => void;
      /** Execution result from skill execution engine. */
      onExecutionResult?: (d: { skillName: string; runtime: string; success: boolean; durationMs: number; exitCode: number; stdout: string; stderr: string; timestamp: number }) => void;
    },
  ): () => void {
    const token = getAdminToken();
    const es = new EventSource(`${this.baseUrl}/api/chat/${encodeURIComponent(sessionId)}/events?token=${encodeURIComponent(token ?? '')}`);
    es.addEventListener('progress', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { line?: string };
        if (payload.line) handlers.onProgress?.(payload.line);
      } catch { /* ignore malformed */ }
    });
    es.addEventListener('status', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { status?: string };
        if (payload.status) handlers.onStatus?.(payload.status);
      } catch { /* ignore malformed */ }
    });
    es.addEventListener('token', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { text?: string };
        if (typeof payload.text === 'string' && payload.text.length > 0) handlers.onToken?.(payload.text);
      } catch { /* ignore malformed */ }
    });
    es.addEventListener('tool', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          id?: string;
          tool?: string;
          phase?: 'started' | 'called';
          args?: string;
          ok?: boolean;
          result?: string;
          error?: string;
          durationMs?: number;
        };
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
      } catch { /* ignore malformed */ }
    });
    es.addEventListener('plan', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          goal?: string;
          steps?: Array<{ id: string; description: string; status: string }>;
          revision?: number;
        };
        if (payload.goal && Array.isArray(payload.steps)) {
          handlers.onPlan?.({
            goal: payload.goal,
            steps: payload.steps,
            revision: payload.revision ?? 0,
          });
        }
      } catch { /* ignore malformed */ }
    });
    es.addEventListener('diff', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          files?: Array<{ path: string; body: string }>;
          summary?: string;
        };
        if (Array.isArray(payload.files)) {
          handlers.onDiff?.({
            files: payload.files,
            summary: payload.summary ?? '',
          });
        }
      } catch { /* ignore malformed */ }
    });
    es.addEventListener('skill_draft', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          name?: string;
          description?: string;
          markdown?: string;
          updatedAt?: number;
        };
        if (payload.name && payload.markdown) {
          handlers.onSkillDraft?.({
            name: payload.name,
            description: payload.description ?? '',
            markdown: payload.markdown,
            updatedAt: payload.updatedAt ?? 0,
          });
        }
      } catch { /* ignore malformed */ }
    });
    es.addEventListener('secret_request', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          skillName?: string;
          missing?: string[];
          persisted?: Record<string, boolean>;
        };
        if (payload.skillName && Array.isArray(payload.missing)) {
          handlers.onSecretRequest?.({
            skillName: payload.skillName,
            missing: payload.missing,
            persisted: payload.persisted ?? {},
          });
        }
      } catch { /* ignore malformed */ }
    });
    es.addEventListener('execution_result', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          skillName?: string;
          runtime?: string;
          success?: boolean;
          durationMs?: number;
          exitCode?: number;
          stdout?: string;
          stderr?: string;
          timestamp?: number;
        };
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
      } catch { /* ignore malformed */ }
    });
    es.addEventListener('question', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          questionId?: string;
          question?: string;
          choices?: Array<{ label: string; description?: string }>;
          multiSelect?: boolean;
        };
        if (payload.questionId && payload.question) {
          handlers.onQuestion?.({
            questionId: payload.questionId,
            question: payload.question,
            choices: payload.choices ?? [],
            multiSelect: payload.multiSelect === true,
          });
        }
      } catch { /* ignore malformed */ }
    });
    return () => es.close();
  }

  /**
   * Answer a pending ask_user question (P0.1). Sends the selected option
   * index (or indices for multiSelect), or -1 to skip and let the agent
   * proceed on best judgment.
   */
  async chatRespond(
    sessionId: string,
    questionId: string,
    selection: { index?: number | number[]; custom?: string } = {},
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/chat/${encodeURIComponent(sessionId)}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ questionId, ...selection }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      return { ok: data.ok === true, error: data.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** P6a — accept a skill draft: promote it into the live stores (hub + compiled). */
  async skillDraftAccept(name: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/skills/drafts/${encodeURIComponent(name)}/accept`, {
        method: 'POST',
        headers: { ...authHeaders() },
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      return { ok: data.ok === true, error: data.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** P6a — reject a skill draft: discard it (nothing is saved). */
  async skillDraftReject(name: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/skills/drafts/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: { ...authHeaders() },
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      return { ok: data.ok === true, error: data.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * PA4 — save a skill's env vars (writes to the credential `.env`).
   *
   * `refused` names the vars the server would NOT store and why (a provider
   * credential, an invalid name, a write failure). Callers must surface it —
   * without it a blocked key looked identical to a successful save.
   */
  async saveSecrets(vars: Record<string, string>): Promise<{
    ok: boolean;
    error?: string;
    saved?: string[];
    refused?: Array<{ name: string; reason: string }>;
  }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/skills/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ vars }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        saved?: string[];
        refused?: Array<{ name: string; reason: string }>;
      };
      return { ok: data.ok === true, error: data.error, saved: data.saved, refused: data.refused };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * PA5 — the skill env-var inventory behind the environment-variable editor.
   *
   * Returns `[]` — never null — so the editor renders its empty state instead
   * of spinning forever when the request fails.
   */
  async fetchSkillEnv(): Promise<SkillEnvVarRow[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/skills/env`, { headers: { ...authHeaders() } });
      const data = (await parseJsonOrNull(res)) as { vars?: SkillEnvVarRow[] } | null;
      return data?.vars ?? [];
    } catch {
      return [];
    }
  }

  /** PA5 — remove one env var from the credential `.env`. */
  async deleteSkillEnvVar(name: string): Promise<{ ok: boolean; removed?: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/skills/env/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ name }),
      });
      const data = (await res.json()) as { ok?: boolean; removed?: boolean; error?: string };
      return { ok: data.ok === true, removed: data.removed, error: data.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * PA5 — ask whether a SKILL can consume this variable right now. This is not
   * an API-key validity check (that would cost a paid provider call); it proves
   * the value is set and not on the credential blocklist, which is exactly what
   * skill execution checks.
   */
  async testSkillEnvVar(name: string): Promise<{ ok: boolean; usable?: boolean; detail?: string; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/skills/env/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ name }),
      });
      const data = (await res.json()) as { ok?: boolean; usable?: boolean; detail?: string; error?: string };
      return { ok: data.ok === true, usable: data.usable, detail: data.detail, error: data.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export const dashboardAPI = new DashboardAPI();
