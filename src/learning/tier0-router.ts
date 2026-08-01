/**
 * Tier0Router — Deterministic, $0 routing for mechanical edits.
 *
 * Inspired by ruflo's `enhanced-model-router.ts` Tier-1 "Agent Booster" codemods:
 * simple, fully-deterministic transforms (remove console.log, rename a symbol,
 * dedupe imports) are applied <1ms and for $0 — no LLM round-trip at all.
 * agent-nuvira's tier-0 is built on its existing editing engine (`renameSymbol`),
 * guarded by AST syntax validation so we never emit broken code.
 *
 * Contract:
 * - `detectTier0Intent(goal, artifacts)` — is this task mechanically doable?
 *   Returns a high-confidence intent or null (→ fall through to the LLM).
 * - `tryTier0Route(goal, artifacts)` — if an intent applies to at least one
 *   artifact and every transformed file still parses, returns FileChange[]
 *   with a summary; otherwise null so the caller keeps the normal LLM path.
 *
 * The tier-0 router NEVER writes to disk — it returns FileChange objects just
 * like the EditModule, so the orchestrator applies them through the same
 * safe-apply pipeline (dry-run, sandbox, review bundles all keep working).
 */

import { detectLanguage } from '../editing/types.js';
import { validateSyntax } from '../editing/ast.js';
import { renameSymbol } from '../editing/transform.js';
import type { Artifact, FileChange } from '../agents/agent.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** The mechanical edit kinds tier-0 can perform deterministically. */
export type Tier0IntentType = 'remove-console' | 'rename-symbol' | 'dedupe-import';

/** A detected mechanical edit intent. */
export interface Tier0Intent {
  type: Tier0IntentType;
  /** 0–1 confidence this intent truly matches the user's goal */
  confidence: number;
  /** Free-form parameters (e.g., { oldName, newName } for rename) */
  params: Record<string, string>;
  /** Human-readable description shown in summaries */
  description: string;
}

/** Result of a successful tier-0 route (ready for the safe-apply pipeline). */
export interface Tier0Result {
  intent: Tier0Intent;
  changes: FileChange[];
  summary: string;
  changeCount: number;
}

// ─── Intent detection ───────────────────────────────────────────────────────

/** Regexes that map a goal string to a mechanical intent. */
const INTENT_PATTERNS: Array<{
  type: Tier0IntentType;
  re: RegExp;
  baseConfidence: number;
}> = [
  {
    type: 'remove-console',
    re: /remove\s+(?:all\s+)?(?:the\s+)?console(?:\.(?:log|debug|warn|error|info|table|trace)s?|\s+(?:statements?|logs?|debug|logging|lines))/i,
    baseConfidence: 0.95,
  },
  {
    type: 'remove-console',
    re: /clean(?:s| up)?\s+(?:up\s+|all\s+)?debug(?:ging)?\s+(?:statements?|logs?|lines)/i,
    baseConfidence: 0.85,
  },
  {
    type: 'dedupe-import',
    re: /(?:remove|clean|fix|dedupe|merge)\s+(?:duplicate\s+|redundant\s+)?imports?/i,
    baseConfidence: 0.9,
  },
  {
    type: 'rename-symbol',
    re: /rename\s+`?([A-Za-z_$][\w$]*)`?\s+(?:to|as|→|->)\s+`?([A-Za-z_$][\w$]*)`?/i,
    baseConfidence: 0.95,
  },
];

/**
 * Detect whether a goal can be handled deterministically without an LLM.
 * Rename additionally requires the old symbol to actually appear in an artifact.
 */
export function detectTier0Intent(goal: string, artifacts: Artifact[]): Tier0Intent | null {
  for (const { type, re, baseConfidence } of INTENT_PATTERNS) {
    const match = goal.match(re);
    if (!match) continue;

    if (type === 'rename-symbol') {
      const oldName = match[1];
      const newName = match[2];
      if (oldName === newName) continue;
      const appearsInArtifact = artifacts.some((a) => new RegExp(`\\b${oldName}\\b`).test(a.content));
      if (!appearsInArtifact) continue;
      return {
        type,
        confidence: baseConfidence,
        params: { oldName, newName },
        description: `Rename ${oldName} → ${newName}`,
      };
    }

    return { type, confidence: baseConfidence, params: {}, description: describeIntent(type, match[0]) };
  }
  return null;
}

function describeIntent(type: Tier0IntentType, matched: string): string {
  switch (type) {
    case 'remove-console':
      return 'Remove console.* debug statements';
    case 'dedupe-import':
      return 'Deduplicate redundant import lines';
    default:
      return `Mechanical edit (${type}) for "${matched}"`;
  }
}

// ─── Deterministic transforms ───────────────────────────────────────────────

/**
 * Detect whether a symbol name appears inside a string literal or comment.
 * Used to keep the rename transform conservative — renaming a symbol that also
 * appears in strings/comments would corrupt user-facing text, which the syntax
 * validator can't catch.
 */
export function symbolInStringOrComment(code: string, name: string): boolean {
  const nameRe = new RegExp(`\\b${name}\\b`);
  // Match single/double-quoted strings (never span lines), multi-line backtick
  // template literals (can span lines), and // and /* */ comments.
  const literalOrComment =
    /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[\s\S]*?`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  for (const m of code.matchAll(literalOrComment)) {
    if (nameRe.test(m[0])) return true;
  }
  return false;
}

/** Apply a single mechanical transform. Returns null when the file was unchanged. */
export function applyTier0Transform(
  intent: Tier0Intent,
  artifact: Artifact,
): { path: string; originalContent: string; newContent: string } | null {
  switch (intent.type) {
    case 'remove-console': {
      const lines = artifact.content.split('\n');
      const kept = lines.filter((line) => {
        const trimmed = line.trim();
        // Drop standalone console.* statement lines (possibly with trailing semicolon)
        if (/^console\.(log|debug|warn|error|info|table|trace)\(/.test(trimmed)) {
          return !/\);?\s*$/.test(trimmed);
        }
        return true;
      });
      const newContent = kept.join('\n');
      if (newContent === artifact.content) return null;
      return { path: artifact.path, originalContent: artifact.content, newContent };
    }

    case 'rename-symbol': {
      const { oldName, newName } = intent.params;
      if (!oldName || !newName) return null;
      // Conservative guard: if the symbol appears in a string literal or comment,
      // the word-boundary rename could corrupt user-facing text — fall through
      // to the LLM instead of silently mangling it.
      if (symbolInStringOrComment(artifact.content, oldName)) return null;
      const result = renameSymbol(artifact.content, artifact.path, { oldName, newName });
      if (!result.success || result.code === null || result.code === artifact.content) return null;
      return { path: artifact.path, originalContent: artifact.content, newContent: result.code };
    }

    case 'dedupe-import': {
      const lines = artifact.content.split('\n');
      // Key on the NORMALIZED FULL import line (specifier + bindings), not just
      // the module — dropping `import { b } from "./m"` when `import { a } from
      // "./m"` exists would break every reference to `b`, and the syntax
      // validator (bracket balance) can't catch that. Only truly identical
      // duplicate import lines are safe to remove.
      const seenLines = new Set<string>();
      const out: string[] = [];
      let changed = false;
      for (const line of lines) {
        const trimmed = line.trim();
        // Match import statements: `import X from 'm'`, `import {a} from 'm'`, `import 'm'`
        const m = trimmed.match(/^import\s+(?:[^'"]+\s+from\s+)?['"][^'"]+['"];?$/);
        if (m) {
          const normalized = trimmed.replace(/;\s*$/, '').replace(/\s+/g, ' ');
          if (seenLines.has(normalized)) {
            changed = true;
            continue; // drop the exact duplicate
          }
          seenLines.add(normalized);
        }
        out.push(line);
      }
      if (!changed) return null;
      return { path: artifact.path, originalContent: artifact.content, newContent: out.join('\n') };
    }

    default:
      return null;
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Try to fulfill the goal deterministically (no LLM). Returns a Tier0Result
 * when a mechanical intent was detected AND at least one file was transformed
 * AND every transformed file still passes syntax validation. Otherwise null.
 */
export function tryTier0Route(goal: string, artifacts: Artifact[]): Tier0Result | null {
  if (!goal || artifacts.length === 0) return null;

  const intent = detectTier0Intent(goal, artifacts);
  if (!intent || intent.confidence < 0.8) return null;

  const changes: FileChange[] = [];
  for (const artifact of artifacts) {
    const applied = applyTier0Transform(intent, artifact);
    if (!applied) continue;

    // Guard: never emit broken code from a deterministic transform
    const lang = detectLanguage(applied.path);
    if (lang !== 'unknown' && !validateSyntax(applied.newContent, lang)) {
      return null; // conservative — fall through to the LLM path
    }

    changes.push({
      path: applied.path,
      originalContent: applied.originalContent,
      newContent: applied.newContent,
      status: 'modified',
    });
  }

  if (changes.length === 0) return null;

  return {
    intent,
    changes,
    changeCount: changes.length,
    summary: `⚡ Tier-0 deterministic edit (no LLM call): ${intent.description} across ${changes.length} file(s)`,
  };
}
