import type { DashboardData, DAGData } from './types';

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
      if (!res.ok) return null;
      const data = (await res.json()) as DashboardData;
      this.lastData = data;
      return data;
    } catch {
      return null;
    }
  }
}

export const dashboardAPI = new DashboardAPI();
