/**
 * delegation_live_log — Live tail-able transcripts for delegated subagents.
 *
 * Creates append-only, human-readable logs for each delegated task.
 * Logs stream while the subagent runs, enabling real-time monitoring.
 *
 * Features:
 * - Append-only logs (no seeks, no corruption)
 * - Auto-pruning of stale logs
 * - Credential redaction
 * - Manifest tracking
 * - Status updates
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

// ─── Types ──────────────────────────────────────────────────────────────────

interface LogEntry {
  timestamp: string;
  role: 'user' | 'assistant' | 'tool' | 'result' | 'error' | 'system';
  content: string;
}

interface LiveTranscript {
  delegationId: string;
  taskIndex: number;
  goal: string;
  entries: LogEntry[];
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  filePath: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const RETENTION_DAYS = 7;
const ASSISTANT_MAX = 600;
const THINKING_MAX = 300;
const ARGS_MAX = 220;
const RESULT_MAX = 400;

// ─── Live Transcript Writer ────────────────────────────────────────────────

class LiveTranscriptWriter {
  private filePath: string;
  private ok = true;

  constructor(
    private delegationId: string,
    private taskIndex: number,
    private goal: string,
    private rootDir?: string,
  ) {
    const root = rootDir || path.join(homedir(), '.buff', 'cache', 'delegation', 'live');
    const dir = path.join(root, delegationId);

    try {
      fs.mkdirSync(dir, { recursive: true });
      this.filePath = path.join(dir, `task-${taskIndex}.log`);

      // Write header
      const header = [
        '=== Agent-Nuvira subagent live transcript ===',
        `delegation: ${delegationId}   task: ${taskIndex}`,
        `goal: ${this.redact(this.oneLine(goal, 500))}`,
        `started: ${new Date().toISOString()}`,
        '(append-only; streams while the subagent runs)',
        '='.repeat(40),
        '',
      ].join('\n');

      fs.writeFileSync(this.filePath, header, 'utf-8');
    } catch (err) {
      this.ok = false;
      this.filePath = '';
    }
  }

  /**
   * Append an event to the log.
   */
  event(role: string, content: string): void {
    if (!this.ok || !this.filePath) return;

    try {
      const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
      const line = `${timestamp} ${role.padEnd(9)}| ${this.redact(content)}\n`;
      fs.appendFileSync(this.filePath, line, 'utf-8');
    } catch {
      this.ok = false;
    }
  }

  /**
   * Log assistant text.
   */
  assistantText(text: string): void {
    const t = this.oneLine(text, ASSISTANT_MAX);
    if (t) this.event('assistant', t);
  }

  /**
   * Log thinking.
   */
  thinking(text: string): void {
    const t = this.oneLine(text, THINKING_MAX);
    if (t) this.event('think', t);
  }

  /**
   * Log tool start.
   */
  toolStart(name: string, args?: any): void {
    const argsStr = args ? this.oneLine(JSON.stringify(args), ARGS_MAX) : '';
    this.event('tool', `-> ${name || '?'}(${argsStr})`);
  }

  /**
   * Log tool result.
   */
  toolResult(name: string, result?: any, duration?: number, isError = false): void {
    const status = isError ? 'ERROR' : 'ok';
    const dur = duration !== undefined ? ` ${duration.toFixed(1)}s` : '';
    this.event('result', `${name || '?'} ${status}${dur}: ${this.oneLine(result, RESULT_MAX)}`);
  }

  /**
   * Log lifecycle marker.
   */
  marker(text: string): void {
    this.event('final', this.oneLine(text, ASSISTANT_MAX));
  }

  /**
   * Finalize the transcript.
   */
  finalize(entry: { status: string; exitReason?: string; error?: string }): void {
    const parts = [`end status=${entry.status}`];
    if (entry.exitReason) parts.push(`exit_reason=${entry.exitReason}`);
    if (entry.error) parts.push(`error: ${this.oneLine(entry.error, RESULT_MAX)}`);
    this.marker(parts.join(' '));
  }

  /**
   * One-line truncation.
   */
  private oneLine(text: any, limit: number): string {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length > limit) {
      return s.slice(0, limit) + ` …(+${s.length - limit} chars)`;
    }
    return s;
  }

  /**
   * Redact credentials.
   */
  private redact(text: string): string {
    if (!text) return text;
    return text
      .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
      .replace(/ghp_[A-Za-z0-9]+/g, 'ghp_[REDACTED]')
      .replace(/sk-[A-Za-z0-9]+/g, 'sk_[REDACTED]')
      .replace(/password\s*[:=]\s*[^\s,}]+/gi, 'password=[REDACTED]')
      .replace(/token\s*[:=]\s*[^\s,}]+/gi, 'token=[REDACTED]');
  }
}

// ─── Live Log Manager ───────────────────────────────────────────────────────

class DelegationLiveLogManager {
  private transcripts = new Map<string, LiveTranscriptWriter>();
  private rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir = rootDir || path.join(homedir(), '.buff', 'cache', 'delegation', 'live');
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  /**
   * Create live transcripts for a batch of tasks.
   */
  createTranscripts(
    tasks: { goal: string; context?: string }[],
    delegationId?: string,
  ): { delegationId: string; paths: string[] } {
    const id = delegationId || `deleg_${Date.now().toString(36)}`;
    const paths: string[] = [];

    tasks.forEach((task, index) => {
      const writer = new LiveTranscriptWriter(id, index, task.goal, this.rootDir);
      this.transcripts.set(`${id}:${index}`, writer);
      if ((writer as any).filePath) {
        paths.push((writer as any).filePath);
      }
    });

    // Write manifest
    this.writeManifest(id, tasks, paths);

    // Prune old transcripts
    this.pruneStale();

    return { delegationId: id, paths };
  }

  /**
   * Get writer for a specific task.
   */
  getWriter(delegationId: string, taskIndex: number): LiveTranscriptWriter | null {
    return this.transcripts.get(`${delegationId}:${taskIndex}`) || null;
  }

  /**
   * Update manifest status.
   */
  updateStatus(
    delegationId: string,
    results: { taskIndex: number; status: string; exitReason?: string }[],
  ): void {
    const manifestPath = path.join(this.rootDir, delegationId, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      for (const result of results) {
        const task = manifest.tasks[result.taskIndex];
        if (task) {
          task.status = result.status;
          if (result.exitReason) task.exit_reason = result.exitReason;
        }
      }
      manifest.completed = new Date().toISOString();
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    } catch {
      // Best effort
    }
  }

  /**
   * Prune stale live directories.
   */
  pruneStale(): number {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;

    try {
      const entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirPath = path.join(this.rootDir, entry.name);
          const stat = fs.statSync(dirPath);
          if (stat.mtimeMs < cutoff) {
            fs.rmSync(dirPath, { recursive: true, force: true });
            removed++;
          }
        }
      }
    } catch {
      // Best effort
    }

    return removed;
  }

  /**
   * Write manifest for a delegation batch.
   */
  private writeManifest(
    delegationId: string,
    tasks: { goal: string; context?: string }[],
    paths: string[],
  ): void {
    const manifestPath = path.join(this.rootDir, delegationId, 'manifest.json');
    const manifest = {
      delegation_id: delegationId,
      started: new Date().toISOString(),
      task_count: tasks.length,
      tasks: tasks.map((task, i) => ({
        index: i,
        goal: task.goal.slice(0, 500),
        log: paths[i] || null,
        status: 'running',
      })),
    };

    try {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    } catch {
      // Best effort
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: DelegationLiveLogManager | null = null;

export function getDelegationLiveLogManager(): DelegationLiveLogManager {
  if (!_instance) _instance = new DelegationLiveLogManager();
  return _instance;
}

export { DelegationLiveLogManager, LiveTranscriptWriter };
