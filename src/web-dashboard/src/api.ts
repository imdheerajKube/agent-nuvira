import { parseJsonOrNull } from './jsonOrNull';
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

export type DashboardListener = (data: DashboardData) => void;
export type ConnectionListener = (connected: boolean) => void;
export type DAGListener = (dag: DAGData) => void;

export class DashboardAPI {
  private sse: EventSource | null = null;
  private listeners: Set<DashboardListener> = new Set();
  private connectionListeners: Set<ConnectionListener> = new Set();
  private dagListeners: Set<DAGListener> = new Set();
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
  }

  onDAGEvent(listener: DAGListener): () => void {
    this.dagListeners.add(listener);
    return () => this.dagListeners.delete(listener);
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
   * (one source with `buff doctor`) and returns masked provider status.
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
    };
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
   * `buff gateway stop` / `buff dashboard stop`). Admin-gated: dashboard
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

  /** Save/update a provider's key + config (authed). Mirrors `buff config set providers.*`. */
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
   * I11: send a test message through the gateway (authed — routing.operate).
   * Mirrors `buff gateway send <target> <text>`; the server resolves the
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
  async gatewayPolicies(): Promise<{ ok: boolean; policies?: Record<string, HubChannelPolicy>; statusRecipients?: string[]; contacts?: HubContact[]; error?: string; unauthorized?: boolean; forbidden?: boolean }> {
    const r = await this.sendAdminRequest('/api/admin/gateway/policies', 'GET');
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as { ok?: boolean; policies?: Record<string, HubChannelPolicy>; statusRecipients?: string[]; contacts?: HubContact[]; error?: string };
    if (r.status === 200 && d.ok) return { ok: true, policies: d.policies, statusRecipients: d.statusRecipients, contacts: d.contacts };
    return { ok: false, error: d.error || 'Failed to read policies.', unauthorized: r.status === 401, forbidden: r.status === 403 };
  }

  async saveGatewayPolicies(policies: Record<string, HubChannelPolicy>, statusRecipients?: string[], contacts?: HubContact[]): Promise<AdminWriteResult> {
    const body: Record<string, unknown> = { policies };
    if (Array.isArray(statusRecipients)) body.statusRecipients = statusRecipients;
    if (Array.isArray(contacts)) body.contacts = contacts;
    const r = await this.sendAdminRequest('/api/admin/gateway/policies', 'PUT', body);
    if (!r) return { ok: false, error: 'Could not reach the dashboard server.' };
    const d = (r.data ?? {}) as AdminWriteResult;
    if (r.status === 200 && d.ok) return d;
    return { ok: false, error: d.error || 'Failed to save policies.', unauthorized: r.status === 401, forbidden: r.status === 403 };
  }

  /**
   * Platform transport config (GUI parity with `buff config gateway`): list
   * every env-configurable platform with current per-var values (full values
   * only for admin/operator). Authed.
   */
  async getPlatformConfigs(): Promise<PlatformConfigEntry[]> {
    const r = await this.sendAdminRequest('/api/config/platforms', 'GET');
    if (!r) return [];
    const d = (r.data ?? {}) as { platforms?: PlatformConfigEntry[] };
    return Array.isArray(d.platforms) ? d.platforms : [];
  }

  /** Write a platform's env values to ~/.buff/.env (authed — routing.operate). */
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

  /** Remove a platform's env values from ~/.buff/.env (authed — routing.operate). */
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

  // ─── P2 — in-page WhatsApp pairing (GUI parity with `buff whatsapp pair`) ──

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

  // ─── P3 — chat console (GUI parity with `buff chat "<prompt>"`) ─────────

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
   * Send one chat message. A turn runs the whole agent tool loop and can take
   * minutes — the 15s admin-request budget would kill it, so this uses its
   * own fetch with a 5-minute cap.
   */
  async chatSend(
    sessionId: string,
    message: string,
    opts?: { provider?: string; model?: string },
  ): Promise<
    | { ok: true; content: string; followups: Array<{ prompt: string; label?: string }>; provider: string | null; model: string | null; generationFailed: boolean }
    | { ok: false; error: string; unauthorized?: boolean; forbidden?: boolean }
  > {
    const token = getAdminToken();
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ sessionId, message, provider: opts?.provider, model: opts?.model }),
        signal: AbortSignal.timeout(300_000),
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
    handlers: { onProgress?: (line: string) => void; onStatus?: (status: string) => void },
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
    return () => es.close();
  }
}

export const dashboardAPI = new DashboardAPI();
