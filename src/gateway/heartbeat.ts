/**
 * Gateway liveness heartbeat (`src/gateway/heartbeat.ts`).
 *
 * The gateway is a FOREGROUND process. When it dies — laptop slept, terminal
 * closed, the harness killed the process group — nothing else notices: the
 * adapters stop receiving, `gateway status` still lists every platform as
 * "configured ✅" (that only reflects env vars), and senders keep messaging a
 * bridge nobody is listening to. Observed live: no gateway process existed at
 * all while the dashboard happily reported the channels as set up.
 *
 * This module makes that state VISIBLE and, with `--supervise`, self-healing:
 *
 * - the running gateway writes `~/.nuvira/gateway/heartbeat.json` every
 *   `HEARTBEAT_INTERVAL_MS` with its pid, uptime, adapter health and the
 *   supervisor's pid;
 * - `gateway status` reads it and reports `running` / `stale` / `down` — so the
 *   answer to "is my gateway up?" is never a guess;
 * - the heartbeat is the supervisor's liveness signal too (a supervisor that
 *   sees a stale child can restart it).
 *
 * Writes are best-effort: a failure to record liveness must never take the
 * gateway down with it.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveBuffConfigDir } from '../config/paths.js';

/** How often the running gateway writes a beat (ms). */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/**
 * A beat older than this means the process is gone (3 missed beats). Chosen
 * comfortably above the interval so a slow tick never reads as a death.
 */
export const HEARTBEAT_STALE_AFTER_MS = 3 * HEARTBEAT_INTERVAL_MS;

/** Health of one adapter as reported in a beat. */
export interface AdapterHealth {
  platform: string;
  configured: boolean;
  /** Whether `start()` succeeded (and has not been declared dead since). */
  started: boolean;
  /** Restart attempts made so far this run. */
  restarts: number;
  /** Last failure message, when the adapter is not started. */
  lastError?: string;
}

/** The on-disk beat. */
export interface HeartbeatFile {
  version: 1;
  /** The gateway process's pid. */
  pid: number;
  /** Epoch ms the gateway started. */
  startedAt: number;
  /** Epoch ms of this beat (the liveness timestamp). */
  at: number;
  /** How many beats have been written this run. */
  beats: number;
  /** True when a `gateway start --supervise` parent owns this process. */
  supervised: boolean;
  /** The supervisor's pid, when supervised. */
  supervisorPid?: number;
  /** Adapter health at beat time. */
  adapters: AdapterHealth[];
}

/** Liveness verdict for `gateway status`. */
export type GatewayLiveness = 'running' | 'stale' | 'down';

/** The verdict + the beat behind it. */
export interface HeartbeatStatus {
  state: GatewayLiveness;
  /** Age of the last beat in ms (Infinity-ish large when there is no beat). */
  ageMs: number;
  beat: HeartbeatFile | null;
  /** The heartbeat file path (always reported so an operator can inspect it). */
  path: string;
}

/** Read/write the gateway heartbeat file. */
export class GatewayHeartbeat {
  private file: string;

  constructor(configDir?: string) {
    this.file = join(resolveBuffConfigDir(configDir), 'gateway', 'heartbeat.json');
  }

  /** Absolute path of the heartbeat file. */
  get beatPath(): string {
    return this.file;
  }

  /** The last beat, or null when there is none / it is unreadable. */
  read(): HeartbeatFile | null {
    try {
      if (!existsSync(this.file)) return null;
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as HeartbeatFile;
      if (!parsed || typeof parsed.at !== 'number' || typeof parsed.pid !== 'number') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Classify liveness. `running` only when a beat exists AND is fresh — a
   * beat file left behind by a crashed process must read as `down`, never as
   * "configured and fine" (that was the silent failure).
   */
  status(now = Date.now()): HeartbeatStatus {
    const beat = this.read();
    if (!beat) return { state: 'down', ageMs: Number.POSITIVE_INFINITY, beat: null, path: this.file };
    const ageMs = Math.max(0, now - beat.at);
    return {
      state: ageMs <= HEARTBEAT_STALE_AFTER_MS ? 'running' : 'stale',
      ageMs,
      beat,
      path: this.file,
    };
  }

  /** Write a beat. Never throws (liveness bookkeeping must not kill the gateway). */
  beat(input: {
    pid?: number;
    startedAt: number;
    beats: number;
    supervised: boolean;
    supervisorPid?: number;
    adapters: AdapterHealth[];
  }): HeartbeatFile | null {
    const record: HeartbeatFile = {
      version: 1,
      pid: input.pid ?? process.pid,
      startedAt: input.startedAt,
      at: Date.now(),
      beats: input.beats,
      supervised: input.supervised,
      supervisorPid: input.supervisorPid,
      adapters: input.adapters,
    };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(record, null, 2), 'utf-8');
      return record;
    } catch {
      return null;
    }
  }

  /** Remove the beat on a clean shutdown (so `status` says "down", not "stale"). */
  clear(): void {
    try {
      if (existsSync(this.file)) unlinkSync(this.file);
    } catch {
      /* best-effort */
    }
  }
}

/** Human-readable age ("3s", "4m", "2h 7m"). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'never';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
