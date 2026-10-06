/**
 * secret-scan — find secret-shaped strings in a working tree, ON DEMAND.
 *
 * WHY THIS EXISTS. Nuvira writes code and commits it. "Did I just stage a key?"
 * is a real, recurring failure mode in that loop, and it is the one the toolchain
 * cannot answer today: `redact()` (enterprise/secrets.ts) keeps secrets out of
 * logs and history, but nothing ever LOOKS for them in the user's files.
 *
 * RELATIONSHIP TO `redact()`: deliberately complementary, not a second opinion.
 * `redact()` is a SCRUBBER — it masks and never reports. This module is a
 * DETECTOR — it reports what and where, and masks the value in its own output
 * (reusing the SAME `maskSecret`/`redact` primitives and the SAME
 * `KNOWN_KEY_PREFIXES` table), so what we detect can never drift from what we
 * redact. One pattern source of truth, two readers.
 *
 * DESIGN CONSTRAINTS
 * - Dependency-free and LOCAL. No `gitleaks`/`ggshield` binary, no network, no
 *   vendor. That is the whole point of the local-first path: a scanner that
 *   reads every file is a privacy decision, so the default must keep the data
 *   on the machine.
 * - PURE + DETERMINISTIC at the text level (`scanText`), so it is unit-testable
 *   without a filesystem; `scanDirectory` is the thin I/O wrapper.
 * - NEVER a security guarantee. It is a lint: it catches KNOWN shapes and common
 *   assignments, and a clean result means "nothing matched", not "no secrets".
 *   The summary says so, because a scanner that overclaims is worse than none.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { KNOWN_KEY_PREFIXES, maskSecret, redact } from '../enterprise/secrets.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SecretSeverity = 'critical' | 'high' | 'medium';

export interface SecretPattern {
  /** Stable id used in the report. */
  id: string;
  /** Human label, e.g. 'AWS access key id'. */
  label: string;
  severity: SecretSeverity;
  /** Global regex; `lastIndex` is reset before every use. */
  re: RegExp;
}

export interface SecretFinding {
  /** Workspace-relative path (never an absolute path — see scanDirectory). */
  path: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column of the match start. */
  column: number;
  id: string;
  label: string;
  severity: SecretSeverity;
  /** Masked form of the matched value (`gsk_…S9ak`). NEVER the real value. */
  masked: string;
  /** The containing line with every secret-shaped substring already redacted. */
  preview: string;
}

export interface SecretScanResult {
  root: string;
  filesScanned: number;
  filesSkipped: number;
  /** True when the file cap or size cap stopped the walk early. */
  truncated: boolean;
  findings: SecretFinding[];
  bySeverity: Record<SecretSeverity, number>;
  /** One truthful line for a human/model — never overclaims a clean scan. */
  summary: string;
}

// ─── Pattern table ──────────────────────────────────────────────────────────

/**
 * High-confidence, low-false-positive shapes. Ordered most-specific first so a
 * value is attributed to the narrowest pattern that matches it.
 *
 * Deliberately NOT included: a bare high-entropy heuristic. It is the classic
 * source of "your scan found 4000 secrets" noise (git SHAs, hashes, minified
 * bundles), and a lint nobody trusts gets switched off — which is worse than a
 * narrower one people keep on.
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  { id: 'private-key', label: 'Private key block', severity: 'critical', re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g },
  { id: 'aws-access-key-id', label: 'AWS access key id', severity: 'critical', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'aws-secret', label: 'AWS secret access key', severity: 'critical', re: /\baws[_-]?secret[_-]?access[_-]?key\b\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/gi },
  { id: 'github-pat', label: 'GitHub token', severity: 'critical', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: 'github-pat-fine', label: 'GitHub fine-grained token', severity: 'critical', re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g },
  { id: 'anthropic-key', label: 'Anthropic API key', severity: 'critical', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'openai-key', label: 'OpenAI-compatible API key', severity: 'critical', re: /\bsk-(?!ant-)[A-Za-z0-9]{20,}\b/g },
  { id: 'groq-key', label: 'Groq API key', severity: 'critical', re: /\bgsk_[A-Za-z0-9]{20,}\b/g },
  { id: 'google-api-key', label: 'Google API key', severity: 'critical', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'google-oauth-secret', label: 'Google OAuth client secret', severity: 'critical', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'nvidia-nim-key', label: 'NVIDIA NIM key', severity: 'critical', re: /\bnvapi-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'slack-token', label: 'Slack token', severity: 'critical', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'stripe-key', label: 'Stripe secret/restricted key', severity: 'critical', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { id: 'hf-token', label: 'HuggingFace token', severity: 'high', re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { id: 'xai-key', label: 'xAI API key', severity: 'high', re: /\bxai-[A-Za-z0-9]{20,}\b/g },
  { id: 'jwt', label: 'JWT / bearer token', severity: 'high', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    id: 'url-credentials',
    label: 'Credentials embedded in a URL',
    severity: 'high',
    re: /\b[a-z][a-z0-9+.-]{1,12}:\/\/[^\s/:@]{2,}:[^\s/:@]{4,}@[^\s/]+/gi,
  },
];

/**
 * Build a bare-prefix pattern from the SAME list `redact()` uses, so every
 * prefix we know how to mask is also one we can find. Kept separate from
 * SECRET_PATTERNS because it is generated, not hand-written.
 */
function buildPrefixPatterns(): SecretPattern[] {
  // Skip prefixes already covered by an explicit, narrower pattern above
  // (rewriting them here would double-report the same value).
  const covered = new Set(['sk-', 'gsk_', 'AIza', 'xai-', 'hf_', 'AKIA', 'eyJ', 'ghp_', 'nvapi-']);
  return KNOWN_KEY_PREFIXES.filter((p) => !covered.has(p)).map((prefix) => ({
    id: `prefix:${prefix}`,
    label: `Known key prefix "${prefix}"`,
    severity: 'medium' as SecretSeverity,
    re: new RegExp(`\\b${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[A-Za-z0-9._\\-+/]{16,}`, 'g'),
  }));
}

const ALL_PATTERNS: SecretPattern[] = [...SECRET_PATTERNS, ...buildPrefixPatterns()];

/**
 * Assignment-shaped matches (`apiKey = "…"`, `"token": "…"`). The value must be
 * long AND not obviously a placeholder, or every `.env.example` in the world
 * becomes a finding.
 */
const ASSIGN_PATTERN: SecretPattern = {
  id: 'assigned-secret',
  label: 'Secret-looking value assigned to a sensitive name',
  severity: 'medium',
  re: /\b(?:api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|password|passwd|private[_-]?key|access[_-]?key)\b["']?\s*[:=]\s*["']([A-Za-z0-9._\-+/]{16,})["']/gi,
};

/** Values that are plainly not real secrets — checked before reporting. */
const PLACEHOLDER_RE = /^(?:your|my|the|example|sample|test|dummy|fake|placeholder|changeme|change_me|none|null|undefined|todo|xxx+|\*+|<.*>)$/i;
const TEMPLATE_RE = /[$%{<]/; // `${VAR}`, `{{var}}`, `<your-key>` — interpolation, not a literal
const LOW_ENTROPY_RE = /^(.)\1+$/; // aaaa..., 1111...

/** Is this matched VALUE obviously a placeholder rather than a real secret? */
export function looksLikePlaceholder(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (v.length < 8) return true;
  if (PLACEHOLDER_RE.test(v)) return true;
  if (TEMPLATE_RE.test(v)) return true;
  if (LOW_ENTROPY_RE.test(v)) return true;
  if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) {
    // Pure letters or pure digits is usually a word/number, not a credential.
    // (Real keys are mixed, and the prefix patterns above still catch the
    // vendors whose keys are letters-only.)
    if (v.length < 24) return true;
  }
  return false;
}

// ─── Text scanning (pure) ───────────────────────────────────────────────────

/**
 * Find secret-shaped substrings in `text`. Pure and synchronous — the whole
 * detector lives here, so it can be tested without touching a filesystem.
 *
 * @param text   Content to scan (a file body, a diff, a log line).
 * @param path   Label attached to each finding (workspace-relative).
 */
export function scanText(text: string, path = '<text>'): Omit<SecretFinding, 'preview'>[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const findings: Omit<SecretFinding, 'preview'>[] = [];
  // One report per (pattern, line) — a minified line must not yield 50 rows.
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.length === 0) continue;

    for (const pattern of [...ALL_PATTERNS, ASSIGN_PATTERN]) {
      pattern.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.re.exec(line)) !== null) {
        // When the pattern captures the value explicitly, judge THAT (the
        // assignment case); otherwise judge the whole match.
        const value = m[1] ?? m[0];
        if (looksLikePlaceholder(value)) {
          if (m[0].length === 0) pattern.re.lastIndex += 1; // never loop forever
          continue;
        }
        const key = `${pattern.id}:${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          path,
          line: i + 1,
          column: m.index + 1,
          id: pattern.id,
          label: pattern.label,
          severity: pattern.severity,
          masked: maskSecret(value),
        });
        break; // one finding per pattern per line is enough to act on
      }
    }
  }

  return findings;
}

// ─── Filesystem walk ────────────────────────────────────────────────────────

/** Directories that never contain the user's own source. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor',
  '.next', '.nuxt', '.svelte-kit', '__pycache__', '.venv', 'venv', '.tox',
  '.cache', '.turbo', 'target', '.idea', '.vscode', 'Pods', '.gradle',
]);

/** Extensions that are binary or generated — reading them wastes time and noise. */
const SKIP_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg', 'pdf', 'zip', 'gz',
  'tar', 'tgz', 'bz2', '7z', 'rar', 'jar', 'war', 'class', 'exe', 'dll', 'so',
  'dylib', 'bin', 'o', 'a', 'wasm', 'mp3', 'mp4', 'mov', 'avi', 'wav', 'woff',
  'woff2', 'ttf', 'eot', 'otf', 'map', 'lock', 'pyc', 'pyo', 'snap',
]);

/** Per-file read cap. A secret never hides beyond this; a minified bundle does. */
export const MAX_FILE_BYTES = 1_000_000;
/** Default cap on files visited per scan, so a huge monorepo cannot hang a turn. */
export const DEFAULT_MAX_FILES = 5_000;

/** Should this workspace-relative path be skipped? (exported for tests) */
export function shouldSkipPath(relPath: string): boolean {
  const parts = relPath.split(/[\\/]/);
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  const base = parts[parts.length - 1] ?? '';
  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    const ext = base.slice(dot + 1).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

export interface ScanDirectoryOptions {
  /** Max files to read (default DEFAULT_MAX_FILES). */
  maxFiles?: number;
  /** Per-file byte cap (default MAX_FILE_BYTES). */
  maxFileBytes?: number;
  /** Restrict the walk to one workspace-relative subtree. */
  subdir?: string;
}

/**
 * Scan a directory tree for secret-shaped content.
 *
 * The walk is bounded twice (file count + per-file size) and skips binary dirs
 * and generated artifacts. Findings carry a WORKSPACE-RELATIVE path so a report
 * can be pasted into a ticket without leaking the operator's home directory.
 * Read failures are counted as skipped, never thrown — a scan must not die on
 * one unreadable file.
 */
export function scanDirectory(root: string, options: ScanDirectoryOptions = {}): SecretScanResult {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const start = options.subdir ? join(root, options.subdir) : root;

  const findings: SecretFinding[] = [];
  let filesScanned = 0;
  let filesSkipped = 0;
  let truncated = false;

  const walk = (dir: string): void => {
    if (truncated) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      filesSkipped += 1;
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const abs = join(dir, entry);
      let rel: string;
      try {
        rel = relative(root, abs);
      } catch {
        filesSkipped += 1;
        continue;
      }
      if (shouldSkipPath(rel)) {
        filesSkipped += 1;
        continue;
      }
      let st;
      try {
        st = statSync(abs);
      } catch {
        filesSkipped += 1;
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!st.isFile()) {
        filesSkipped += 1;
        continue;
      }
      if (filesScanned >= maxFiles) {
        truncated = true;
        return;
      }
      if (st.size > maxFileBytes) {
        filesSkipped += 1;
        continue;
      }
      let body: string;
      try {
        body = readFileSync(abs, 'utf-8');
      } catch {
        filesSkipped += 1;
        continue;
      }
      filesScanned += 1;
      for (const hit of scanText(body, rel.split(sep).join('/'))) {
        const lineText = body.split(/\r?\n/)[hit.line - 1] ?? '';
        findings.push({ ...hit, preview: redact(lineText).slice(0, 200) });
      }
    }
  };

  walk(start);

  const bySeverity: Record<SecretSeverity, number> = { critical: 0, high: 0, medium: 0 };
  for (const f of findings) bySeverity[f.severity] += 1;

  return {
    root,
    filesScanned,
    filesSkipped,
    truncated,
    findings: findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line),
    bySeverity,
    summary: buildSummary(findings, bySeverity, filesScanned, truncated),
  };
}

/** One honest sentence. A clean scan is reported as "nothing matched". */
function buildSummary(
  findings: SecretFinding[],
  bySeverity: Record<SecretSeverity, number>,
  filesScanned: number,
  truncated: boolean,
): string {
  const suffix = truncated ? ' (file cap reached — coverage is partial)' : '';
  if (findings.length === 0) {
    return `Scanned ${filesScanned} file(s)${suffix}: nothing matched a known secret shape. ` +
      'This is a lint, not a guarantee — it finds known shapes and common assignments only.';
  }
  return (
    `Scanned ${filesScanned} file(s)${suffix}: ${findings.length} finding(s) — ` +
    `${bySeverity.critical} critical, ${bySeverity.high} high, ${bySeverity.medium} medium. ` +
    'Values are masked; rotate any that are real before they are committed.'
  );
}

// ─── Rendering ──────────────────────────────────────────────────────────────

/** Render a result as a compact report a model or a human can act on. */
export function formatSecretScan(result: SecretScanResult): string {
  const lines = [result.summary];
  if (result.findings.length > 0) {
    lines.push('', 'path:line  severity  kind  value(masked)');
    for (const f of result.findings.slice(0, 200)) {
      lines.push(`${f.path}:${f.line}  ${f.severity}  ${f.label}  ${f.masked}`);
    }
    if (result.findings.length > 200) {
      lines.push(`… and ${result.findings.length - 200} more`);
    }
  }
  return lines.join('\n');
}
