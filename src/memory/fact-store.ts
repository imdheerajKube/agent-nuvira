/**
 * FactStore — Fact & preference memory (Phase B1).
 *
 * Stores durable, project-scoped facts and user preferences extracted from
 * conversations and executions, retrievable semantically across sessions.
 *
 * Design (mirrors the plan's B1 spec, reusing what already exists):
 * - Reuses `embed()` (embedder.ts) + `VectorStore` (vector-store.ts, FAISS
 *   backend) in a DEDICATED `facts` namespace — no new dependency, and fact
 *   vectors never mix with trajectory vectors.
 * - Each fact is a vector entry with metadata
 *   `{ kind:'fact', projectId, agentRole, timestamp, tags, source, text }` so
 *   retrieval filters by project (the A2 projectId) and time range — the
 *   temporal-filter gap the existing stores don't cover.
 * - `extractFactsFromTurn` distills facts from a chat/execution turn: ONE LLM
 *   JSON call (the router-selected cheap model — caller passes `callLLM`) with
 *   a deterministic rule fallback when the LLM path is unavailable.
 * - Dedupe by cosine similarity (near-duplicate facts are not re-added).
 * - Per-project budget + 180-day expiry (expired facts are pruned, never
 *   surfaced).
 *
 * File location: facts live in the vector index namespace `facts`
 * (`~/.nuvira/memory/vectors-facts.json`).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { LLMCallFn } from '../agents/agent.js';
import { getVectorStore, cosineSimilarity, type VectorEntry } from './vector-store.js';
import { embed } from './embedder.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A fact to be stored. */
export interface FactInput {
  /** The fact text (self-contained, durable). */
  text: string;
  /** Optional domain tags (e.g. ['typescript', 'auth']). */
  tags?: string[];
  /** Optional provenance (e.g. 'chat', 'execution', 'manual'). */
  source?: string;
  /** Which agent observed this (e.g. 'planner', 'writer'). */
  agentRole?: string;
}

/** A stored fact (returned by retrieval/list). */
export interface StoredFact {
  id: string;
  text: string;
  projectId: string;
  agentRole: string;
  tags: string[];
  source: string;
  /** Epoch ms when the fact was stored. */
  timestamp: number;
}

/** Time-range filter for retrieval (epoch ms). */
export interface FactTimeRange {
  start?: number;
  end?: number;
}

/** Options for retrieveFacts. */
export interface FactRetrievalOptions {
  /** Max results (default 5). */
  k?: number;
  /** Restrict to a time range (overrides the default 180-day freshness). */
  timeRange?: FactTimeRange;
  /** Minimum cosine similarity to return (default 0.3). */
  minSimilarity?: number;
}

/** On-disk metadata shape stored on each vector entry. */
interface FactMetadata extends Record<string, unknown> {
  kind: 'fact';
  projectId: string;
  agentRole: string;
  timestamp: number;
  tags: string[];
  source: string;
  text: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const FACT_NAMESPACE = 'facts';

/** Facts older than this are expired (pruned, never surfaced). */
export const FACT_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

/** Max facts per project (oldest pruned when exceeded). */
export const MAX_FACTS_PER_PROJECT = 200;

/** Near-duplicate threshold: a fact within this cosine is NOT re-added. */
export const DEDUPE_COSINE_THRESHOLD = 0.92;

/** Default freshness window used when no explicit timeRange is given. */
const DEFAULT_RECENT_MS = FACT_TTL_MS;

/** Default minimum similarity for retrieval. */
const DEFAULT_MIN_SIMILARITY = 0.3;

/** LLM extraction prompt — one JSON call, router-selected cheap model. */
const EXTRACTION_PROMPT = `You are a memory curator for an AI agent. From the conversation turn below, extract durable FACTS and USER PREFERENCES that should be remembered across sessions.

Rules:
- Extract only STABLE facts/preferences: the user's tech stack, frameworks, code style, project conventions, credentials-independent decisions, repeated choices. NOT one-off task instructions or commands.
- Each fact is one self-contained sentence (no line breaks).
- Do NOT include API keys, tokens, passwords, or secrets.
- Return ONLY a JSON array of strings. No markdown, no explanations.

Example:
["The user prefers TypeScript over JavaScript.", "The project uses an Express backend with a React frontend.", "The user wants tests written for every new feature."]

Conversation turn:
USER: {userText}
ASSISTANT: {assistantText}

Return the JSON array:`;

// ─── FactStore ──────────────────────────────────────────────────────────────

export class FactStore {
  private namespace = FACT_NAMESPACE;
  private ttlMs: number;
  private maxPerProject: number;
  private dedupeThreshold: number;

  constructor(opts: { ttlMs?: number; maxPerProject?: number; dedupeThreshold?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? FACT_TTL_MS;
    this.maxPerProject = opts.maxPerProject ?? MAX_FACTS_PER_PROJECT;
    this.dedupeThreshold = opts.dedupeThreshold ?? DEDUPE_COSINE_THRESHOLD;
  }

  // ── Write ────────────────────────────────────────────────────────────────

  /**
   * Store a fact for a project: embed the text, dedupe by cosine against the
   * project's existing facts, then insert into the `facts` vector namespace.
   * Returns the fact id, or null when it was a near-duplicate (not re-added).
   * Best-effort — never throws (a failed embed/insert is a no-op).
   */
  async addFact(
    projectId: string,
    input: FactInput,
    callLLM?: LLMCallFn,
  ): Promise<string | null> {
    try {
      const text = (input.text || '').trim();
      if (!text || !projectId) return null;

      const vector = await embed(text, callLLM);
      if (vector.every((v) => v === 0)) {
        logger.debug('Fact embed failed (zero vector) — skipping fact store');
        return null;
      }

      // Load this project's facts ONCE (single getAll — the whole index is
      // already read by the FAISS backend, so per-fact getEntry would be an
      // N+1 re-read of the file). Dedupe by cosine against these, then prune
      // oldest past the budget before inserting.
      const all = await getVectorStore(this.namespace).getAll();
      const existing = all.filter((e) => {
        const m = e.metadata as FactMetadata;
        return m?.kind === 'fact' && m.projectId === projectId;
      });
      for (const entry of existing) {
        const sim = cosineSimilarity(vector, entry.vector);
        if (sim >= this.dedupeThreshold) {
          logger.debug(`Fact deduped (cosine ${sim.toFixed(3)}) — '${text.slice(0, 60)}'`);
          return null;
        }
      }

      // Enforce per-project budget BEFORE insert (prune oldest).
      const over = existing.length - (this.maxPerProject - 1);
      if (over > 0) {
        const sorted = [...existing].sort((a, b) => (a.metadata as FactMetadata).timestamp - (b.metadata as FactMetadata).timestamp);
        for (const oldest of sorted.slice(0, over)) {
          await getVectorStore(this.namespace).delete(oldest.id).catch(() => {});
        }
      }

      const id = `fact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const metadata: FactMetadata = {
        kind: 'fact',
        projectId,
        agentRole: input.agentRole || 'user',
        timestamp: Date.now(),
        tags: input.tags || [],
        source: input.source || 'manual',
        text,
      };
      await getVectorStore(this.namespace).insert(id, vector, metadata);
      return id;
    } catch (err) {
      logger.debug(`Fact add failed (non-critical): ${err}`);
      return null;
    }
  }

  /** Store multiple facts for a project (best-effort; returns stored count). */
  async addFacts(
    projectId: string,
    facts: FactInput[],
    callLLM?: LLMCallFn,
  ): Promise<number> {
    let stored = 0;
    for (const f of facts) {
      const id = await this.addFact(projectId, f, callLLM);
      if (id) stored++;
    }
    return stored;
  }

  /**
   * Distill durable facts from a conversation turn via ONE LLM JSON call with
   * a deterministic rule fallback. Returns the number of facts stored.
   * Never throws — any failure falls back to the rules (or a 0).
   */
  async extractFactsFromTurn(
    projectId: string,
    turn: { userText: string; assistantText?: string; source?: string; agentRole?: string },
    callLLM?: LLMCallFn,
  ): Promise<number> {
    const texts = this.ruleExtractFacts(turn.userText, turn.assistantText || '');

    // LLM path (one JSON call) when available — richer extraction.
    if (callLLM) {
      try {
        const prompt = EXTRACTION_PROMPT
          .replace('{userText}', turn.userText.slice(0, 4000))
          .replace('{assistantText}', (turn.assistantText || '').slice(0, 4000));
        const response = await callLLM(prompt, { temperature: 0.1, maxTokens: 1024 });
        const parsed = this.parseFactArray(response);
        if (parsed.length > 0) {
          texts.push(...parsed.filter((t) => !texts.includes(t)));
        }
      } catch (err) {
        logger.debug(`LLM fact extraction failed (using rules): ${err}`);
      }
    }

    const unique = [...new Set(texts.map((t) => t.trim()).filter(Boolean))];
    if (unique.length === 0) return 0;

    return this.addFacts(
      projectId,
      unique.map((t) => ({
        text: t,
        source: turn.source || 'chat',
        agentRole: turn.agentRole || 'user',
      })),
      callLLM,
    );
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  /**
   * Retrieve the top-k facts for a project most similar to the query.
   * Filters by projectId (metadata) and, unless an explicit timeRange is given,
   * drops facts older than the freshness window (180 days) — the temporal
   * filter the other stores lack. Best-effort — never throws.
   */
  async retrieveFacts(
    projectId: string,
    query: string,
    callLLM?: LLMCallFn,
    opts: FactRetrievalOptions = {},
  ): Promise<StoredFact[]> {
    try {
      const k = opts.k ?? 5;
      const minSim = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
      const now = Date.now();
      const range = opts.timeRange ?? { start: now - this.ttlMs };

      const queryVector = await embed(query, callLLM);
      if (queryVector.every((v) => v === 0)) return [];

      const results = await getVectorStore(this.namespace).search(
        queryVector,
        Math.max(k * 3, 10), // over-fetch, filter below
        (entry) => {
          const m = entry.metadata as FactMetadata;
          if (m?.kind !== 'fact') return false;
          if (m.projectId !== projectId) return false;
          if (range.start !== undefined && m.timestamp < range.start) return false;
          if (range.end !== undefined && m.timestamp > range.end) return false;
          return true;
        },
      );

      return results
        .filter((r) => r.similarity >= minSim)
        .slice(0, k)
        .map((r) => this.metadataToFact(r.entry));
    } catch (err) {
      logger.debug(`Fact retrieval failed: ${err}`);
      return [];
    }
  }

  /** List all facts for a project (or all projects), newest first. */
  async listFacts(projectId?: string): Promise<StoredFact[]> {
    try {
      const entries = await getVectorStore(this.namespace).getAll();
      const facts = entries
        .filter((e) => (e.metadata as FactMetadata)?.kind === 'fact')
        .filter((e) => !projectId || (e.metadata as FactMetadata).projectId === projectId)
        .map((e) => this.metadataToFact(e))
        .sort((a, b) => b.timestamp - a.timestamp);
      return facts;
    } catch (err) {
      logger.debug(`Fact list failed: ${err}`);
      return [];
    }
  }

  /**
   * Format retrieved facts as a prompt block for planner/chat injection.
   * Returns '' when there is nothing to inject.
   */
  formatAsPrompt(facts: StoredFact[]): string {
    if (facts.length === 0) return '';
    const lines = facts.map((f, i) => `${i + 1}. ${f.text}${f.tags.length ? ` [${f.tags.join(', ')}]` : ''}`);
    return (
      `\n---\n` +
      `Here are facts and preferences learned about this project:\n\n` +
      lines.join('\n') +
      `\n---\n`
    );
  }

  /** Basic stats (for `nuvira memory facts` / doctor). */
  async stats(): Promise<{ total: number; byProject: Record<string, number> }> {
    const facts = await this.listFacts();
    const byProject: Record<string, number> = {};
    for (const f of facts) {
      byProject[f.projectId] = (byProject[f.projectId] || 0) + 1;
    }
    return { total: facts.length, byProject };
  }

  /**
   * Prune facts older than the TTL. Returns how many were removed.
   */
  async expireFacts(): Promise<number> {
    try {
      const entries = await getVectorStore(this.namespace).getAll();
      const cutoff = Date.now() - this.ttlMs;
      let removed = 0;
      for (const e of entries) {
        const m = e.metadata as FactMetadata;
        if (m?.kind === 'fact' && m.timestamp < cutoff) {
          await getVectorStore(this.namespace).delete(e.id).catch(() => {});
          removed++;
        }
      }
      return removed;
    } catch {
      return 0;
    }
  }

  /** Remove one fact by id. Returns true when deleted. */
  async removeFact(id: string): Promise<boolean> {
    return getVectorStore(this.namespace).delete(id).catch(() => false);
  }

  /** Clear all facts (all projects). */
  async clear(): Promise<void> {
    await getVectorStore(this.namespace).clear().catch(() => {});
  }

  // ── Rule extraction (deterministic fallback) ─────────────────────────────

  /**
   * Deterministic fact extraction used when the LLM path is unavailable and as
   * the base for LLM enrichment. Exported for testing.
   */
  ruleExtractFacts(userText: string, assistantText: string): string[] {
    const facts: string[] = [];
    const combined = `${userText}\n${assistantText}`;
    const sentences = combined
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);

    // Pattern 1: explicit "remember/preference/fact:" markers
    for (const s of sentences) {
      const m = s.match(/^\s*(?:remember|preference|pref|fact)\s*[:\-]\s*(.+)$/i);
      if (m && m[1].trim().length > 3) facts.push(m[1].trim());
    }

    // Pattern 2: "I prefer / I use / I like / my preferred ..." declarations
    for (const s of sentences) {
      const m = s.match(/\bI (?:prefer|use|like|work with|stick with|favor|favour)\s+(.+?)[.!]?$/i);
      if (m && m[1].trim().length > 3) {
        facts.push(`The user prefers ${m[1].trim()}`);
      }
    }

    // Pattern 3: "the project/we use X" stack declarations
    for (const s of sentences) {
      const m = s.match(/\b(?:the project|we|our team)\s+(?:uses|runs on|is built with|is written in)\s+(.+?)[.!]?$/i);
      if (m && m[1].trim().length > 3) {
        facts.push(`The project uses ${m[1].trim()}`);
      }
    }

    // Pattern 4: quoted preferences with context words
    for (const s of sentences) {
      const m = s.match(/(?:want|need|must)\s+(\"[^\"]+\"|'[^']+')/i);
      if (m) facts.push(m[1].replace(/['"]/g, '').trim());
    }

    // Dedupe + cap
    return [...new Set(facts)].filter((f) => f.length >= 4).slice(0, 10);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private metadataToFact(entry: VectorEntry): StoredFact {
    const m = (entry.metadata || {}) as FactMetadata;
    return {
      id: entry.id,
      text: m.text || '',
      projectId: m.projectId || '',
      agentRole: m.agentRole || 'user',
      tags: Array.isArray(m.tags) ? m.tags : [],
      source: m.source || 'unknown',
      timestamp: typeof m.timestamp === 'number' ? m.timestamp : entry.createdAt,
    };
  }

  private parseFactArray(response: string): string[] {
    const trimmed = response.trim();
    // Direct JSON parse first
    try {
      const parsed = JSON.parse(trimmed.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
      if (Array.isArray(parsed)) {
        return parsed.filter((f) => typeof f === 'string');
      }
    } catch {
      // fall through
    }
    // Extract a JSON array from the text
    const arrayMatch = trimmed.match(/\[[\s\S]*?\]/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsed)) {
          return parsed.filter((f) => typeof f === 'string');
        }
      } catch {
        // fall through
      }
    }
    return [];
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let storeInstance: FactStore | null = null;

export function getFactStore(): FactStore {
  if (!storeInstance) {
    storeInstance = new FactStore();
  }
  return storeInstance;
}

/** Reset the singleton (test isolation). */
export function resetFactStore(): void {
  storeInstance = null;
}
