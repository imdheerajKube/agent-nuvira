/**
 * audit-chain.ts — P6 M6.3 tamper-evident, hash-chained audit records.
 *
 * Extends the existing append-only JSONL audit stores (quota-events.jsonl,
 * model-registry-actions.jsonl) with a SHA-256 hash chain so any tampering —
 * even a single flipped byte — is detectable on verification.
 *
 * Design:
 * - Each record is serialized to a canonical JSON line, then wrapped:
 *   `{ ..., "chain": { "prevHash": "<sha256>", "hash": "<sha256>" } }`
 *   where `hash = sha256(prevHash ‖ canon)` and `canon` is the record's
 *   canonical JSON (stable key order) WITHOUT the chain wrapper.
 * - The chain head (the last hash) is persisted in a sidecar `.chain.json`
 *   file, so a tamperer who rewrites a line must also know the true head to
 *   hide the break (append-only external-of-record state).
 * - Verification walks the file lines, recomputes the chain, and reports:
 *   the tamper line index (first mismatch), the number of legacy un-chained
 *   lines (pre-M6.3 files remain readable), and whether the stored head
 *   matches the recomputed head.
 *
 * Purity: all functions are pure over (content, sidecar state) — no global
 * state, no filesystem access inside the core logic. Callers own I/O.
 *
 * @see NUVIRA_ROUTER_ROADMAP.md §P6 M6.3
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { safeLine } from './secrets.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Chain metadata persisted per audit store. */
export interface ChainHeadState {
  /** Namespaced chain id (e.g. 'quota-events' | 'model-registry-actions'). */
  chainId: string;
  /** The hash of the LAST chained record written (or null before any). */
  head: string | null;
  /** Record count at the time the head was persisted. */
  records: number;
  /** Schema version for forward compatibility. */
  version: 1;
}

/** Result of verifying one audit file's chain. */
export interface ChainVerifyResult {
  chainId: string;
  /** Total non-empty lines in the file. */
  totalLines: number;
  /** Lines that are legacy (pre-chain) — valid JSON but no chain wrapper. */
  legacyLines: number;
  /** Lines that are corrupt (not valid JSON at all). */
  corruptLines: number;
  /** Index (1-based) of the first line where the chain breaks; 0 = intact. */
  tamperLine: number;
  /** Recomputed head hash for the whole file. */
  recomputedHead: string | null;
  /** Head hash from the sidecar state (null if no sidecar / legacy-only). */
  storedHead: string | null;
  /** Whether the recomputed head matches the stored head. */
  headMatches: boolean;
  /** Human-readable verdict. */
  verdict: 'ok' | 'tampered' | 'legacy' | 'corrupt';
}

/** One hash-chained record (the on-disk line shape). */
export interface ChainedRecord {
  [key: string]: unknown;
  chain?: { prevHash: string; hash: string };
}

// ─── Canonical serialization ────────────────────────────────────────────────

/**
 * Canonical JSON: stable key order (sorted), no whitespace. Ensures the same
 * record always hashes identically regardless of object key insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

/** sha256 hex digest of a string. */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

// ─── Chain building ─────────────────────────────────────────────────────────

/**
 * Compute the chain wrapper for the NEXT record given the previous head.
 * `record` must be the record WITHOUT any chain wrapper (it will be stripped
 * defensively if present).
 */
export function nextChain(
  prevHead: string | null,
  record: unknown,
): { prevHash: string; hash: string } {
  const clean = stripChain(record);
  const canon = canonicalJson(clean);
  const prevHash = prevHead ?? 'genesis';
  return { prevHash, hash: sha256(`${prevHash}‖${canon}`) };
}

/** Serialize a record + chain wrapper to the on-disk line. */
export function chainLine(
  prevHead: string | null,
  record: unknown,
): string {
  const clean = stripChain(record) as Record<string, unknown>;
  const wrapper = nextChain(prevHead, clean);
  const line = JSON.stringify({ ...clean, chain: wrapper });
  return line;
}

/** Remove an existing `chain` field from a record (deep-copy safe). */
export function stripChain(record: unknown): unknown {
  if (record === null || typeof record !== 'object') return record;
  if (Array.isArray(record)) return record.map((r) => stripChain(r));
  const obj = { ...(record as Record<string, unknown>) };
  delete obj.chain;
  return obj;
}

// ─── Verification ───────────────────────────────────────────────────────────

/**
 * Parse the raw file lines and recompute the chain.
 *
 * @param lines Non-empty file lines (each a JSON string).
 * @param chainId Namespace for the verify result.
 * @param storedHead Optional head from the sidecar state (null = none).
 * @returns A ChainVerifyResult with the first tamper line (1-based) or 0.
 */
export function verifyChain(
  lines: string[],
  chainId: string,
  storedHead: string | null = null,
): ChainVerifyResult {
  let legacyLines = 0;
  let corruptLines = 0;
  let prevHead: string | null = null;
  let recomputedHead: string | null = null;
  let tamperLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed: ChainedRecord;
    try {
      parsed = JSON.parse(line) as ChainedRecord;
    } catch {
      corruptLines++;
      if (tamperLine === 0) tamperLine = i + 1;
      continue;
    }
    const chain = parsed.chain;
    if (!chain || typeof chain.hash !== 'string') {
      // Legacy pre-M6.3 line: readable, but outside the chain.
      legacyLines++;
      continue;
    }
    // Recompute: hash must equal sha256(prevHash ‖ canon(record-without-chain)).
    const clean = stripChain(parsed);
    const canon = canonicalJson(clean);
    const expected = sha256(`${chain.prevHash}‖${canon}`);
    if (chain.hash !== expected) {
      if (tamperLine === 0) tamperLine = i + 1;
      continue;
    }
    // The recomputed chain must link to the previous head.
    const expectedPrev = prevHead ?? 'genesis';
    if (chain.prevHash !== expectedPrev) {
      if (tamperLine === 0) tamperLine = i + 1;
      continue;
    }
    prevHead = chain.hash;
    recomputedHead = chain.hash;
  }

  const headMatches = storedHead === null ? recomputedHead === null : storedHead === recomputedHead;
  const verdict: ChainVerifyResult['verdict'] =
    corruptLines > 0 ? 'corrupt'
    : tamperLine > 0 ? 'tampered'
    : storedHead === null && recomputedHead === null ? 'legacy'
    : headMatches ? 'ok'
    : 'tampered';

  return {
    chainId,
    totalLines: lines.length,
    legacyLines,
    corruptLines,
    tamperLine,
    recomputedHead,
    storedHead,
    headMatches,
    verdict,
  };
}

// ─── Head state helpers ─────────────────────────────────────────────────────

/**
 * The current head (last hash) of an already-serialized chain of lines.
 * Uses `verifyChain` internally so the returned head is LINKAGE-checked
 * (a tampered-but-internally-consistent line cannot poison the next append).
 */
export function headOfLines(lines: string[]): string | null {
  const r = verifyChain(lines, 'head', null);
  return r.tamperLine === 0 && r.corruptLines === 0 ? r.recomputedHead : null;
}

/** Serialize head state for the sidecar file. */
export function serializeHeadState(state: ChainHeadState): string {
  return JSON.stringify(state, null, 2);
}

/** Parse sidecar head state (lenient: malformed → null head). */
export function parseHeadState(json: string): ChainHeadState | null {
  try {
    const parsed = JSON.parse(json) as ChainHeadState;
    if (typeof parsed.chainId !== 'string') return null;
    return {
      chainId: parsed.chainId,
      head: typeof parsed.head === 'string' ? parsed.head : null,
      records: Number.isFinite(parsed.records) ? parsed.records : 0,
      version: 1,
    };
  } catch {
    return null;
  }
}

// ─── Export ─────────────────────────────────────────────────────────────────

/**
 * SIEM-friendly flat export: one key=value "CEF-like" line per record.
 * Key values are CEF-escaped (`|`, `\`, `=` in values are escaped); the chain
 * hash is included so SIEMs can correlate back to the tamper-evident store.
 */
export function exportCefLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const fields = Object.entries(parsed)
        .map(([k, v]) => {
          const value = typeof v === 'object' ? JSON.stringify(v) : String(v);
          return `${k}=${cefEscape(value)}`;
        })
        .join(' ');
      const action = String(parsed.action ?? parsed.type ?? 'event');
      out.push(`cef:0|agent-nuvira|enterprise-audit|1.59.0|audit-record|${cefEscape(action)}|0|${fields}`);
    } catch {
      // Unparseable lines are skipped (export must never throw).
    }
  }
  return out;
}

/** CEF-escape a value: backslashes, pipes, and equals are backslash-escaped. */
export function cefEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/=/g, '\\=');
}

// ─── File wrapper (thin I/O over the pure core) ─────────────────────────────

/**
 * Append ONE hash-chained, scrubbed record to a JSONL audit store.
 *
 * - Reads the existing lines, derives the previous chain head (legacy lines
 *   are preserved as-is), appends `chainLine(prevHead, record)`.
 * - Optionally caps the file at `maxLines` (newest kept — rotation keeps the
 *   chain INTACT because the trimmed slice is re-chained below).
 * - Persists the sidecar head state (`<path>.chain.json`) so verification has
 *   an append-only external-of-record reference.
 * - Best-effort + safeLine-scrubbed (P6 M6.2): never throws.
 *
 * @returns the appended line, or null on failure.
 */
/**
 * FAST append for hot paths (model-registry action telemetry): reads only the
 * sidecar head state + appends with `appendFileSync` — O(1) per record instead
 * of a full read-rewrite. Rotation is handled by the caller (the model-
 * registry already rotates at 2× the cap, and the trimmed slice is re-chained
 * there).
 */
export function appendChainedRecordFast(
  filePath: string,
  chainId: string,
  record: unknown,
): string | null {
  try {
    const state = readHeadState(filePath, chainId);
    let prevHead: string | null;
    let recordCount: number;
    if (state?.head) {
      prevHead = state.head;
      recordCount = (state.records ?? 0) + 1;
    } else {
      // No sidecar yet (legacy store): derive the head from the file and count
      // the ACTUAL lines so the sidecar never under-reports existing records.
      const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8').split('\n').filter((l) => l.trim()) : [];
      prevHead = headOfLines(existing);
      recordCount = existing.length + 1;
    }
    const scrubbedRecord = safeLine(record);
    let parsedRecord: unknown;
    try {
      parsedRecord = JSON.parse(scrubbedRecord);
    } catch {
      parsedRecord = scrubbedRecord;
    }
    const line = chainLine(prevHead, parsedRecord);
    appendFileSync(filePath, `${line}\n`, 'utf-8');
    const chained = JSON.parse(line) as ChainedRecord;
    writeHeadState(filePath, chainId, chained.chain?.hash ?? null, recordCount);
    return line;
  } catch {
    return null;
  }
}

export function appendChainedRecord(
  filePath: string,
  chainId: string,
  record: unknown,
  maxLines?: number,
): string | null {
  try {
    const raw = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
    let lines = raw.split('\n').filter((l) => l.trim().length > 0);
    // 1. Scrub the record FIRST so the chain hash covers exactly what is
    //    stored (M6.2 + M6.3 compose: redaction, then chaining).
    const scrubbedRecord = safeLine(record);
    // Tamper-evidence guard: if the EXISTING store is already tampered, do
    // NOT silently re-chain from genesis (that would mask the evidence).
    // Emit a system warning so operators know the chain was broken before
    // this append. The append still proceeds (best-effort audit) but the
    // stale sidecar continues to expose the tamper on the next verify.
    try {
      const tamper = verifyChain(lines, chainId, null);
      if (tamper.tamperLine > 0) {
        console.warn(`[enterprise-audit] WARNING: ${chainId} audit chain was TAMPERED (first break at line ${tamper.tamperLine}) before this append — run 'buff audit verify' and restore from backup.`);
      }
    } catch {
      // Best-effort guard — never block the append.
    }
    let parsedRecord: unknown;
    try {
      parsedRecord = JSON.parse(scrubbedRecord);
    } catch {
      parsedRecord = scrubbedRecord;
    }
    const prevHead = headOfLines(lines);
    const line = chainLine(prevHead, parsedRecord);
    lines.push(line);
    let trimmed = false;
    if (maxLines !== undefined && lines.length > maxLines) {
      lines = lines.slice(-maxLines);
      trimmed = true;
    }
    if (trimmed && lines.length > 0) {
      // Rotation dropped the chain HEAD records, so the surviving slice's
      // first line would point at a trimmed-away prevHash. Re-chain the
      // surviving records from genesis so the chain stays verifiable.
      lines = rechainRecords(lines);
    }
    const head = headOfLines(lines);
    writeFileSync(filePath, lines.length ? `${lines.join('\n')}\n` : '', 'utf-8');
    writeHeadState(filePath, chainId, head, lines.length);
    return line;
  } catch {
    return null;
  }
}

/**
 * Strip the chain wrappers from parsed lines and rebuild a continuous chain
 * from `genesis`. Used after rotation so a trimmed slice never references a
 * trimmed-away record.
 */
export function rechainRecords(lines: string[]): string[] {
  const out: string[] = [];
  let prevHead: string | null = null;
  for (const raw of lines) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const line = chainLine(prevHead, stripChain(parsed));
      out.push(line);
      const chained = JSON.parse(line) as ChainedRecord;
      prevHead = chained.chain?.hash ?? prevHead;
    } catch {
      // Preserve unparseable lines verbatim (best-effort rotation).
      out.push(raw);
    }
  }
  return out;
}

/** Sidecar path for an audit file: `<file>.chain.json`. */
export function headStatePath(filePath: string): string {
  return `${filePath}.chain.json`;
}

/** Read + parse the sidecar head state (null when absent/malformed). */
export function readHeadState(filePath: string, chainId: string): ChainHeadState | null {
  const p = headStatePath(filePath);
  if (!existsSync(p)) return null;
  const parsed = parseHeadState(readFileSync(p, 'utf-8'));
  if (!parsed || parsed.chainId !== chainId) return null;
  return parsed;
}

/** Persist the sidecar head state (best-effort). */
export function writeHeadState(
  filePath: string,
  chainId: string,
  head: string | null,
  records: number,
): void {
  try {
    const state: ChainHeadState = { chainId, head, records, version: 1 };
    writeFileSync(headStatePath(filePath), serializeHeadState(state), 'utf-8');
  } catch {
    // Best-effort — a failed head write must never break the record append.
  }
}

/**
 * Verify a JSONL audit store's chain: pure core over the file's lines plus
 * the sidecar head state.
 */
export function verifyAuditFile(filePath: string, chainId: string): ChainVerifyResult {
  try {
    const raw = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const state = readHeadState(filePath, chainId);
    return verifyChain(lines, chainId, state?.head ?? null);
  } catch {
    return {
      chainId,
      totalLines: 0,
      legacyLines: 0,
      corruptLines: 0,
      tamperLine: 0,
      recomputedHead: null,
      storedHead: null,
      headMatches: false,
      verdict: 'corrupt',
    };
  }
}

/** Convenience: default memory dir join (honors BUFF_MEMORY_DIR like the rest). */
export function auditFilePath(chainId: string): string {
  const dir = process.env.BUFF_MEMORY_DIR || join(homedir(), '.buff', 'memory');
  return join(dir, chainId.endsWith('.jsonl') ? chainId : `${chainId}.jsonl`);
}
