/**
 * CostTracker — Tracks API usage costs per provider per session.
 *
 * Stores cost data as JSON at ~/.nuvira/memory/cost-tracker.json
 * and provides CLI commands to view costs.
 *
 * Cost per 1K tokens (approximate, in USD):
 * - Groq: llama-3.3-70b = $0.59/$0.79, llama-3.1-8b = $0.05/$0.08
 * - NVIDIA NIM: varies by model, typically $0.10-$0.50/$1K
 * - Google Gemini: free tier (limited), paid tier ~$0.10/$1K
 * - OpenRouter: varies by model (pass-through pricing)
 * - Local: free
 *
 * Costs are configurable via config file for accuracy.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { envBuff, resolveNuviraHome } from '../config/paths';
import { formatCount } from '../utils/format.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { getQuotaLedger } from './quota-ledger.js';
import { getModelRegistry } from './model-registry.js';
import { classifyModelEntitlement } from '../inference/model-entitlement.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CostEntry {
  /** Provider name (e.g., 'groq', 'gemini', 'openrouter', 'nim', 'local') */
  provider: string;
  /** Model name used */
  model: string;
  /** Timestamp of the request */
  timestamp: number;
  /** Input tokens used */
  inputTokens: number;
  /** Output tokens generated */
  outputTokens: number;
  /** Total tokens */
  totalTokens: number;
  /** Estimated cost in USD (micro-cents precision) */
  costUsd: number;
  /** The task/goal that triggered this request */
  task?: string;
  /**
   * M2.2: true when inputTokens/outputTokens are MEASURED from the provider's
   * reported usage (wire-token metering), false/undefined when length-based
   * estimates were used. The dashboard splits measured vs estimated spend.
   */
  measured?: boolean;
  /**
   * True when `costUsd` was reported BY THE PROVIDER for this call rather than
   * computed from the local price table. A provider-reported cost is the most
   * accurate value available (it reflects credits, free tier, discounts), so it
   * wins over any estimate — see calculateCost's `reportedCostUsd` parameter.
   */
  costReported?: boolean;
}

export interface CostSummary {
  /** Total cost in USD across all time */
  totalCost: number;
  /** Total cost by provider */
  byProvider: Record<string, number>;
  /** Total cost by model */
  byModel: Record<string, number>;
  /** Total tokens consumed */
  totalTokens: number;
  /** Total requests made */
  totalRequests: number;
  /** Number of entries in the current session */
  sessionRequests: number;
  /** Session cost in USD */
  sessionCost: number;
  /** Session start timestamp */
  sessionStart: number;
}

interface CostData {
  entries: CostEntry[];
  version: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CURRENT_VERSION = 1;

/**
 * Cost-ledger location — resolved LAZILY through the standard
 * `NUVIRA_MEMORY_DIR` override, like every other persisted store. Captured at
 * module load it ignored the override, so spend recorded by a hermetic run
 * (test, sandbox, isolated profile) was written into the real profile.
 */
function memoryDir(): string {
  return envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
}

function costPath(): string {
  return join(memoryDir(), 'cost-tracker.json');
}

/**
 * Default pricing per 1K tokens (input/output) in USD.
 * Users can override these via config file.
 * Source: provider pricing pages (approximate, may change).
 */
const DEFAULT_PRICING: Record<string, { inputPer1K: number; outputPer1K: number }> = {
  groq: { inputPer1K: 0.00059, outputPer1K: 0.00079 },   // Average across models
  nim: { inputPer1K: 0.00010, outputPer1K: 0.00050 },     // Varies by model
  gemini: { inputPer1K: 0, outputPer1K: 0 },              // Free tier by default
  openrouter: { inputPer1K: 0.00010, outputPer1K: 0.00010 }, // Minimum; most models cost more
  local: { inputPer1K: 0, outputPer1K: 0 },               // Free (local compute)
};

/** Maximum number of cost entries to keep */
const MAX_ENTRIES = 10000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(): void {
  const dir = memoryDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readCosts(): CostData {
  try {
    ensureDir();
    const path = costPath();
    if (!existsSync(path)) {
      return { entries: [], version: CURRENT_VERSION };
    }
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as CostData;
  } catch {
    return { entries: [], version: CURRENT_VERSION };
  }
}

function writeCosts(data: CostData): void {
  ensureDir();
  writeFileSync(costPath(), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Estimate the number of tokens from text length.
 * Rough heuristic: ~4 characters per token for code, ~5 for prose.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4.5);
}

/**
 * True when the provider/model pair provably costs nothing per call — a
 * provider-declared free id (`:free` suffix) or a keyless local runtime.
 *
 * Delegates to the ONE authority for this question (classifyModelEntitlement),
 * so the dashboard badge and the cost ledger can never disagree about what is
 * free. A zero price in the catalog is deliberately NOT free — see the module
 * header on model-entitlement.ts (Gemini paid models 403 without billing).
 */
export function isFreeModel(provider: string, model: string): boolean {
  try {
    return classifyModelEntitlement(provider, model).tier === 'free';
  } catch {
    return false;
  }
}

/**
 * Calculate the cost for a given provider, model, and token counts.
 *
 * @param reportedCostUsd When the PROVIDER told us the exact cost of this call
 *   (e.g. OpenRouter's `usage.cost`), that figure is authoritative and is
 *   returned verbatim (rounded to the ledger's micro-cent precision). This is
 *   what lets a free/subscription call report a TRUE $0 instead of a generic
 *   rate, and a discounted call report what was actually charged.
 */
export function calculateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  reportedCostUsd?: number,
): number {
  // Provider-reported cost wins over everything — it is the provider's own
  // accounting, not our estimate.
  if (typeof reportedCostUsd === 'number' && Number.isFinite(reportedCostUsd)) {
    return Math.round(reportedCostUsd * 100000) / 100000;
  }

  // A free model bills $0 regardless of token count — a provider-declared
  // free id or a local runtime. Without this, a `:free` OpenRouter id was
  // charged the generic OpenRouter rate, inventing spend the user never paid.
  if (isFreeModel(provider, model)) {
    return 0;
  }

  const pricing = DEFAULT_PRICING[provider] || { inputPer1K: 0.00010, outputPer1K: 0.00010 };

  // Model-specific pricing overrides for known expensive models
  const expensiveModels: Record<string, { inputPer1K: number; outputPer1K: number }> = {
    'openai/gpt-oss-120b': { inputPer1K: 0.00015, outputPer1K: 0.00060 },
    'openai/gpt-oss-20b': { inputPer1K: 0.000075, outputPer1K: 0.00030 },
    'qwen/qwen3.6-27b': { inputPer1K: 0.00060, outputPer1K: 0.00300 },
  };

  const modelPricing = expensiveModels[model];
  const p = modelPricing || pricing;

  const inputCost = (inputTokens / 1000) * p.inputPer1K;
  const outputCost = (outputTokens / 1000) * p.outputPer1K;

  return Math.round((inputCost + outputCost) * 100000) / 100000; // Micro-cent precision
}

// ─── CostTracker ────────────────────────────────────────────────────────────

/**
 * Tracks API usage costs per provider.
 */
export class CostTracker {
  private sessionStart: number;
  private sessionEntries: CostEntry[] = [];

  constructor() {
    this.sessionStart = Date.now();
  }

  /**
   * Record a single API call's cost.
   *
   * @param provider  Provider name
   * @param model     Model name
   * @param inputTokens  Input tokens used (or estimated)
   * @param outputTokens Output tokens generated (or estimated)
   * @param task      Optional task description
   */
  recordCall(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    task?: string,
    measured?: boolean,
    reportedCostUsd?: number,
  ): CostEntry {
    const costReported =
      typeof reportedCostUsd === 'number' && Number.isFinite(reportedCostUsd);
    const costUsd = calculateCost(provider, model, inputTokens, outputTokens, reportedCostUsd);

    const entry: CostEntry = {
      provider,
      model,
      timestamp: Date.now(),
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd,
      task,
      // M2.2: must be set BEFORE persist below — the entry is serialized in
      // writeCosts and any post-hoc mutation never reaches disk (which would
      // silently zero the dashboard's measured-vs-estimated split).
      measured,
      // Set (only when true) so the dashboard can show provider-billed spend
      // apart from locally-priced estimates.
      ...(costReported ? { costReported: true } : {}),
    };

    // Store in session
    this.sessionEntries.push(entry);

    // Persist to disk
    const data = readCosts();
    data.entries.push(entry);

    // Prune old entries if over limit
    if (data.entries.length > MAX_ENTRIES) {
      data.entries = data.entries.slice(-MAX_ENTRIES);
    }

    writeCosts(data);

    // ── Write-through to the central quota ledger ────────────────────────
    // Every LLM call (via the adapters' recordCallEstimated) also records
    // usage in the quota ledger so Auto routing can park exhausted providers
    // until their reset window rolls. Best-effort — never break the call.
    try {
      getQuotaLedger().recordUsage(provider, model, inputTokens, outputTokens);
    } catch {
      // Ledger is best-effort; cost recording must never crash on it.
    }

    // ── Write-through to the Model Availability Registry ─────────────────
    // A successful real call is the strongest signal a model works — upgrade
    // it to `verified` (source: telemetry) so future routing trusts it without
    // a network probe. Best-effort — never break the call.
    try {
      getModelRegistry().recordCall(provider, model, true);
    } catch {
      // Registry is best-effort.
    }

    return entry;
  }

  /**
   * Record a call with EXACT tokens reported by the provider/gateway usage
   * (M2.2 wire-token metering). Cost is computed from real token counts × the
   * same per-1K pricing, the entry is flagged `measured: true`, and the exact
   * tokens also flow to the Model Availability Registry so Auto routing's cost
   * scoring can prefer measured cost over TYPICAL-token estimates.
   */
  recordCallMeasured(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    task?: string,
    reportedCostUsd?: number,
  ): CostEntry {
    // measured: true is set inside recordCall BEFORE the entry is persisted,
    // so the dashboard's measured-vs-estimated split reads correctly from disk.
    const entry = this.recordCall(provider, model, inputTokens, outputTokens, task, true, reportedCostUsd);
    // Write the exact measured tokens through to the registry (best-effort) so
    // getMeasuredUsage() feeds measured-cost routing scoring.
    try {
      getModelRegistry().recordMeasuredUsage(provider, model, inputTokens, outputTokens);
    } catch {
      // Registry is best-effort.
    }
    return entry;
  }

  /**
   * Record a call with estimated tokens from prompt/response lengths.
   * Useful when the API doesn't return exact token counts.
   */
  recordCallEstimated(
    provider: string,
    model: string,
    promptText: string,
    responseText: string,
    task?: string,
  ): CostEntry {
    const inputTokens = estimateTokens(promptText);
    const outputTokens = estimateTokens(responseText);
    return this.recordCall(provider, model, inputTokens, outputTokens, task);
  }

  /**
   * Get cost summary across all time and current session.
   */
  getSummary(): CostSummary {
    const data = readCosts();
    const allEntries = data.entries;

    const byProvider: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    let totalCost = 0;
    let totalTokens = 0;

    for (const entry of allEntries) {
      totalCost += entry.costUsd;
      totalTokens += entry.totalTokens;
      byProvider[entry.provider] = (byProvider[entry.provider] || 0) + entry.costUsd;
      byModel[entry.model] = (byModel[entry.model] || 0) + entry.costUsd;
    }

    const sessionCost = this.sessionEntries.reduce((sum, e) => sum + e.costUsd, 0);

    return {
      totalCost: Math.round(totalCost * 100000) / 100000,
      byProvider,
      byModel,
      totalTokens,
      totalRequests: allEntries.length,
      sessionRequests: this.sessionEntries.length,
      sessionCost: Math.round(sessionCost * 100000) / 100000,
      sessionStart: this.sessionStart,
    };
  }

  /**
   * Format cost summary as a human-readable string.
   */
  formatSummary(): string {
    const summary = this.getSummary();

    const lines: string[] = [
      '💰 Cost Tracker',
      '',
      '── Session ──',
      `   Started: ${new Date(summary.sessionStart).toLocaleString()}`,
      `   Requests: ${summary.sessionRequests}`,
      `   Session cost: $${summary.sessionCost.toFixed(6)}`,
      '',
      '── All Time ──',
      `   Total requests: ${summary.totalRequests}`,
      `   Total tokens: ${formatCount(summary.totalTokens)}`,
      `   Total cost: $${summary.totalCost.toFixed(6)}`,
      '',
    ];

    if (Object.keys(summary.byProvider).length > 0) {
      lines.push('── By Provider ──');
      for (const [provider, cost] of Object.entries(summary.byProvider).sort(([, a], [, b]) => b - a)) {
        const pct = summary.totalCost > 0 ? (cost / summary.totalCost * 100).toFixed(1) : '0.0';
        lines.push(`   ${provider.padEnd(15)} $${cost.toFixed(6)} (${pct}%)`);
      }
      lines.push('');
    }

    if (Object.keys(summary.byModel).length > 0) {
      lines.push('── By Model ──');
      for (const [model, cost] of Object.entries(summary.byModel).sort(([, a], [, b]) => b - a).slice(0, 10)) {
        lines.push(`   ${model.padEnd(40)} $${cost.toFixed(6)}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Clear all cost tracking data.
   */
  clear(): void {
    this.sessionEntries = [];
    this.sessionStart = Date.now();
    writeCosts({ entries: [], version: CURRENT_VERSION });
  }

  /**
   * Get all cost entries (for export).
   */
  getAllEntries(): CostEntry[] {
    const data = readCosts();
    return [...data.entries];
  }
}

// Singleton instance
let trackerInstance: CostTracker | null = null;

export function getCostTracker(): CostTracker {
  if (!trackerInstance) {
    trackerInstance = new CostTracker();
  }
  return trackerInstance;
}

/**
 * Spend and tokens recorded at or after `since` (epoch ms) — the per-batch
 * economy window for unattended runs (G27).
 *
 * Read from the PERSISTED ledger rather than a session counter on purpose: a
 * continuation batch runs through a fresh orchestrator (and after a resume, a
 * fresh process), so an instance counter would report zero for every batch but
 * the first. A timestamp window is the only measure that survives that.
 */
export function costSince(since: number): { costUsd: number; tokens: number; requests: number } {
  let costUsd = 0;
  let tokens = 0;
  let requests = 0;
  for (const entry of readCosts().entries) {
    if (entry.timestamp < since) continue;
    costUsd += entry.costUsd;
    tokens += entry.totalTokens;
    requests += 1;
  }
  return { costUsd: Math.round(costUsd * 100000) / 100000, tokens, requests };
}

/**
 * M2.2: record a call preferring MEASURED wire tokens when the provider
 * reported usage; otherwise fall back to the length-based estimate. Shared by
 * the OpenAI-compatible adapters so the measured-vs-estimated logic lives in
 * one place. Best-effort — never throws.
 */
export function recordCallWithUsage(
  costTracker: CostTracker,
  provider: string,
  model: string,
  prompt: string,
  content: string,
  usage?: { promptTokens?: number; completionTokens?: number; costUsd?: number },
  reportedCostUsd?: number,
): void {
  // Prefer the explicit reported-cost argument, else the cost carried on the
  // usage object (sse/tools attach it from the endpoint's `usage.cost`).
  const cost =
    typeof reportedCostUsd === 'number'
      ? reportedCostUsd
      : typeof usage?.costUsd === 'number'
        ? usage.costUsd
        : undefined;
  if (usage && typeof usage.promptTokens === 'number' && typeof usage.completionTokens === 'number') {
    costTracker.recordCallMeasured(provider, model, usage.promptTokens, usage.completionTokens, undefined, cost);
  } else {
    // No measured tokens: estimate token counts, but still honor a
    // provider-reported cost when the endpoint gave us one.
    const inputTokens = estimateTokens(prompt);
    const outputTokens = estimateTokens(content);
    costTracker.recordCall(provider, model, inputTokens, outputTokens, undefined, undefined, cost);
  }
}
