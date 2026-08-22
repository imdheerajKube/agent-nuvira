/**
 * Execution Audit — Logs all skill executions for security and compliance.
 *
 * This provides an audit trail for:
 * - Security monitoring
 * - Compliance requirements
 * - Debugging and troubleshooting
 * - Usage analytics
 *
 * Logs include:
 * - Skill name and version
 * - Execution timestamp
 * - User/session ID
 * - Execution result (success/failure)
 * - Duration
 * - Environment variables used (masked)
 * - Any errors or warnings
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ───────────────────────────────────────────────────────────────

export type ExecutionStatus = 'success' | 'failure' | 'timeout' | 'rejected' | 'error';

export interface AuditEntry {
  /** Unique entry ID */
  id: string;
  /** Skill name */
  skillName: string;
  /** Skill version (if known) */
  skillVersion?: string;
  /** Skill source (bundled, marketplace, local) */
  skillSource: string;
  /** Execution runtime (python, node, shell) */
  runtime: string;
  /** Execution status */
  status: ExecutionStatus;
  /** Timestamp */
  timestamp: number;
  /** Session ID */
  sessionId: string;
  /** User ID (if known) */
  userId?: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Exit code (for shell execution) */
  exitCode?: number;
  /** Environment variables used (masked) */
  envVarsUsed?: string[];
  /** Error message (if failed) */
  error?: string;
  /** Command executed */
  command?: string;
  /** Output size in bytes */
  outputSizeBytes?: number;
}

export interface AuditConfig {
  /** Enable audit logging */
  enabled: boolean;
  /** Audit log directory */
  logDir?: string;
  /** Audit log file name */
  logFile?: string;
  /** Maximum log file size in bytes (default: 10MB) */
  maxLogSizeBytes?: number;
  /** Retention period in days (default: 30) */
  retentionDays?: number;
  /** Mask sensitive values */
  maskSensitive: boolean;
}

// ─── Default Configuration ───────────────────────────────────────────────

const DEFAULT_CONFIG: AuditConfig = {
  enabled: true,
  logDir: join(homedir(), '.nuvira', 'audit'),
  logFile: 'skill-executions.log',
  maxLogSizeBytes: 10 * 1024 * 1024, // 10MB
  retentionDays: 30,
  maskSensitive: true,
};

// ─── Sensitive Field Patterns ────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /auth/i,
  /private[_-]?key/i,
];

// ─── Audit Logger ────────────────────────────────────────────────────────

/**
 * Mask sensitive values in environment variables.
 */
function maskEnvVar(name: string, value: string): string {
  if (SENSITIVE_PATTERNS.some(pattern => pattern.test(name))) {
    // Show first 4 and last 4 characters, mask the rest
    if (value.length > 8) {
      return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
    }
    return '****';
  }
  return value;
}

/**
 * Generate a unique ID for the audit entry.
 */
function generateEntryId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Write an audit entry to the log file.
 */
async function writeAuditEntry(
  entry: AuditEntry,
  config: AuditConfig
): Promise<void> {
  if (!config.enabled) return;

  const logDir = config.logDir ?? DEFAULT_CONFIG.logDir!;
  const logFile = config.logFile ?? DEFAULT_CONFIG.logFile!;
  const logPath = join(logDir, logFile);

  // Ensure log directory exists
  await mkdir(logDir, { recursive: true });

  // Format the entry as JSON (one line per entry for easy parsing)
  const logLine = JSON.stringify(entry) + '\n';

  // Append to log file
  await appendFile(logPath, logLine, 'utf-8');
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Log a skill execution.
 */
export async function logExecution(
  params: {
    skillName: string;
    skillVersion?: string;
    skillSource: string;
    runtime: string;
    status: ExecutionStatus;
    sessionId: string;
    userId?: string;
    durationMs: number;
    exitCode?: number;
    envVarsUsed?: string[];
    error?: string;
    command?: string;
    outputSizeBytes?: number;
  },
  config?: Partial<AuditConfig>
): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const entry: AuditEntry = {
    id: generateEntryId(),
    skillName: params.skillName,
    skillVersion: params.skillVersion,
    skillSource: params.skillSource,
    runtime: params.runtime,
    status: params.status,
    timestamp: Date.now(),
    sessionId: params.sessionId,
    userId: params.userId,
    durationMs: params.durationMs,
    exitCode: params.exitCode,
    envVarsUsed: cfg.maskSensitive
      ? params.envVarsUsed?.map(v => maskEnvVar(v, process.env[v] ?? ''))
      : params.envVarsUsed,
    error: params.error,
    command: params.command,
    outputSizeBytes: params.outputSizeBytes,
  };

  await writeAuditEntry(entry, cfg);
}

/**
 * Query audit entries (for dashboard or CLI).
 */
export async function queryAuditEntries(
  filters: {
    skillName?: string;
    status?: ExecutionStatus;
    sessionId?: string;
    startDate?: number;
    endDate?: number;
    limit?: number;
  },
  config?: Partial<AuditConfig>
): Promise<AuditEntry[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const logDir = cfg.logDir ?? DEFAULT_CONFIG.logDir!;
  const logFile = cfg.logFile ?? DEFAULT_CONFIG.logFile!;
  const logPath = join(logDir, logFile);

  try {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(logPath, 'utf-8');
    const lines = content.trim().split('\n');

    let entries: AuditEntry[] = lines
      .map(line => {
        try {
          return JSON.parse(line) as AuditEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is AuditEntry => entry !== null);

    // Apply filters
    if (filters.skillName) {
      entries = entries.filter(e => e.skillName === filters.skillName);
    }
    if (filters.status) {
      entries = entries.filter(e => e.status === filters.status);
    }
    if (filters.sessionId) {
      entries = entries.filter(e => e.sessionId === filters.sessionId);
    }
    if (filters.startDate) {
      entries = entries.filter(e => e.timestamp >= filters.startDate!);
    }
    if (filters.endDate) {
      entries = entries.filter(e => e.timestamp <= filters.endDate!);
    }

    // Sort by timestamp (newest first)
    entries.sort((a, b) => b.timestamp - a.timestamp);

    // Apply limit
    if (filters.limit) {
      entries = entries.slice(0, filters.limit);
    }

    return entries;
  } catch {
    // Log file doesn't exist or can't be read
    return [];
  }
}

/**
 * Get audit statistics.
 */
export async function getAuditStats(
  config?: Partial<AuditConfig>
): Promise<{
  total: number;
  success: number;
  failure: number;
  timeout: number;
  rejected: number;
  error: number;
  bySkill: Record<string, number>;
  byRuntime: Record<string, number>;
  averageDurationMs: number;
}> {
  const entries = await queryAuditEntries({}, config);

  const stats = {
    total: entries.length,
    success: 0,
    failure: 0,
    timeout: 0,
    rejected: 0,
    error: 0,
    bySkill: {} as Record<string, number>,
    byRuntime: {} as Record<string, number>,
    averageDurationMs: 0,
  };

  let totalDuration = 0;

  for (const entry of entries) {
    // Count by status
    switch (entry.status) {
      case 'success':
        stats.success++;
        break;
      case 'failure':
        stats.failure++;
        break;
      case 'timeout':
        stats.timeout++;
        break;
      case 'rejected':
        stats.rejected++;
        break;
      case 'error':
        stats.error++;
        break;
    }

    // Count by skill
    stats.bySkill[entry.skillName] = (stats.bySkill[entry.skillName] || 0) + 1;

    // Count by runtime
    stats.byRuntime[entry.runtime] = (stats.byRuntime[entry.runtime] || 0) + 1;

    // Sum duration
    totalDuration += entry.durationMs;
  }

  // Calculate average duration
  if (entries.length > 0) {
    stats.averageDurationMs = Math.round(totalDuration / entries.length);
  }

  return stats;
}

/**
 * Clean up old audit entries.
 */
export async function cleanupAuditLog(
  config?: Partial<AuditConfig>
): Promise<number> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const retentionMs = (cfg.retentionDays ?? 30) * 24 * 60 * 60 * 1000;
  const cutoffDate = Date.now() - retentionMs;

  const entries = await queryAuditEntries({}, config);
  const retainedEntries = entries.filter(e => e.timestamp >= cutoffDate);

  if (retainedEntries.length === entries.length) {
    return 0; // Nothing to clean up
  }

  // Rewrite log file with retained entries
  const logDir = cfg.logDir ?? DEFAULT_CONFIG.logDir!;
  const logFile = cfg.logFile ?? DEFAULT_CONFIG.logFile!;
  const logPath = join(logDir, logFile);

  const { writeFile } = await import('node:fs/promises');
  const content = retainedEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(logPath, content, 'utf-8');

  return entries.length - retainedEntries.length;
}

/**
 * Export audit entries for analysis.
 */
export async function exportAuditEntries(
  format: 'json' | 'csv' = 'json',
  config?: Partial<AuditConfig>
): Promise<string> {
  const entries = await queryAuditEntries({}, config);

  if (format === 'json') {
    return JSON.stringify(entries, null, 2);
  }

  // CSV format
  const headers = [
    'id',
    'skillName',
    'skillVersion',
    'skillSource',
    'runtime',
    'status',
    'timestamp',
    'sessionId',
    'userId',
    'durationMs',
    'exitCode',
    'error',
    'command',
  ];

  const csvLines = [headers.join(',')];

  for (const entry of entries) {
    const values = headers.map(h => {
      const value = (entry as any)[h];
      if (value === undefined || value === null) return '';
      if (typeof value === 'string' && value.includes(',')) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return String(value);
    });
    csvLines.push(values.join(','));
  }

  return csvLines.join('\n');
}
