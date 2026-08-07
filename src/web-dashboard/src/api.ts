import { parseJsonOrNull } from './jsonOrNull';
import type { DashboardData, DAGData, QuotaInsights, RoutingInsights, TraceEntry } from './types';

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
}

export const dashboardAPI = new DashboardAPI();
