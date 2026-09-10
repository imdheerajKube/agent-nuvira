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
import { join } from 'node:path';
import { resolveNuviraHome } from '../config/paths.js';
import * as path from 'path';
// ─── Constants ──────────────────────────────────────────────────────────────
const RETENTION_DAYS = 7;
const ASSISTANT_MAX = 600;
const THINKING_MAX = 300;
const ARGS_MAX = 220;
const RESULT_MAX = 400;
// ─── Live Transcript Writer ────────────────────────────────────────────────
class LiveTranscriptWriter {
    delegationId;
    taskIndex;
    goal;
    rootDir;
    filePath;
    ok = true;
    constructor(delegationId, taskIndex, goal, rootDir) {
        this.delegationId = delegationId;
        this.taskIndex = taskIndex;
        this.goal = goal;
        this.rootDir = rootDir;
        const root = rootDir || join(resolveNuviraHome(), 'cache', 'delegation', 'live');
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
        }
        catch (err) {
            this.ok = false;
            this.filePath = '';
        }
    }
    /**
     * Append an event to the log.
     */
    event(role, content) {
        if (!this.ok || !this.filePath)
            return;
        try {
            const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
            const line = `${timestamp} ${role.padEnd(9)}| ${this.redact(content)}\n`;
            fs.appendFileSync(this.filePath, line, 'utf-8');
        }
        catch {
            this.ok = false;
        }
    }
    /**
     * Log assistant text.
     */
    assistantText(text) {
        const t = this.oneLine(text, ASSISTANT_MAX);
        if (t)
            this.event('assistant', t);
    }
    /**
     * Log thinking.
     */
    thinking(text) {
        const t = this.oneLine(text, THINKING_MAX);
        if (t)
            this.event('think', t);
    }
    /**
     * Log tool start.
     */
    toolStart(name, args) {
        const argsStr = args ? this.oneLine(JSON.stringify(args), ARGS_MAX) : '';
        this.event('tool', `-> ${name || '?'}(${argsStr})`);
    }
    /**
     * Log tool result.
     */
    toolResult(name, result, duration, isError = false) {
        const status = isError ? 'ERROR' : 'ok';
        const dur = duration !== undefined ? ` ${duration.toFixed(1)}s` : '';
        this.event('result', `${name || '?'} ${status}${dur}: ${this.oneLine(result, RESULT_MAX)}`);
    }
    /**
     * Log lifecycle marker.
     */
    marker(text) {
        this.event('final', this.oneLine(text, ASSISTANT_MAX));
    }
    /**
     * Finalize the transcript.
     */
    finalize(entry) {
        const parts = [`end status=${entry.status}`];
        if (entry.exitReason)
            parts.push(`exit_reason=${entry.exitReason}`);
        if (entry.error)
            parts.push(`error: ${this.oneLine(entry.error, RESULT_MAX)}`);
        this.marker(parts.join(' '));
    }
    /**
     * One-line truncation.
     */
    oneLine(text, limit) {
        const s = String(text || '').replace(/\s+/g, ' ').trim();
        if (s.length > limit) {
            return s.slice(0, limit) + ` …(+${s.length - limit} chars)`;
        }
        return s;
    }
    /**
     * Redact credentials.
     */
    redact(text) {
        if (!text)
            return text;
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
    transcripts = new Map();
    rootDir;
    constructor(rootDir) {
        this.rootDir = rootDir || join(resolveNuviraHome(), 'cache', 'delegation', 'live');
        fs.mkdirSync(this.rootDir, { recursive: true });
    }
    /**
     * Create live transcripts for a batch of tasks.
     */
    createTranscripts(tasks, delegationId) {
        const id = delegationId || `deleg_${Date.now().toString(36)}`;
        const paths = [];
        tasks.forEach((task, index) => {
            const writer = new LiveTranscriptWriter(id, index, task.goal, this.rootDir);
            this.transcripts.set(`${id}:${index}`, writer);
            if (writer.filePath) {
                paths.push(writer.filePath);
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
    getWriter(delegationId, taskIndex) {
        return this.transcripts.get(`${delegationId}:${taskIndex}`) || null;
    }
    /**
     * Update manifest status.
     */
    updateStatus(delegationId, results) {
        const manifestPath = path.join(this.rootDir, delegationId, 'manifest.json');
        if (!fs.existsSync(manifestPath))
            return;
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            for (const result of results) {
                const task = manifest.tasks[result.taskIndex];
                if (task) {
                    task.status = result.status;
                    if (result.exitReason)
                        task.exit_reason = result.exitReason;
                }
            }
            manifest.completed = new Date().toISOString();
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
        }
        catch {
            // Best effort
        }
    }
    /**
     * Prune stale live directories.
     */
    pruneStale() {
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
        }
        catch {
            // Best effort
        }
        return removed;
    }
    /**
     * Write manifest for a delegation batch.
     */
    writeManifest(delegationId, tasks, paths) {
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
        }
        catch {
            // Best effort
        }
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let _instance = null;
export function getDelegationLiveLogManager() {
    if (!_instance)
        _instance = new DelegationLiveLogManager();
    return _instance;
}
export { DelegationLiveLogManager, LiveTranscriptWriter };
//# sourceMappingURL=delegation-live-log.js.map