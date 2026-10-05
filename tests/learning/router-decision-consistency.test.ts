/**
 * Router decision PRESENTATION consistency (T3).
 *
 * Model-first routing (and per-model learning) can select a provider/model that
 * differs from the deterministic `selected` pick. Before this, the rationale
 * line named the PRE-override provider (observed live as
 * `Decision: gemini/gemini-3.1-flash-lite` beside a `groq/gemini-3.1-flash-lite`
 * rationale), `decision.score` was that loser's score, and the ✅ marker could
 * sit on a row ranked below #1 — so `models explain`'s rationale, Decision line
 * and ranked table disagreed.
 *
 * These tests pin the invariant: whichever provider the router finally decides
 * on is the one named EVERYWHERE — the rationale, the Decision, and ranked[0].
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AutoModelRouter, resetAutoRouter } from '../../src/learning/auto-router.js';
import { isTinyModel, isAgenticCapableModel } from '../../src/learning/model-harness.js';
import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';
import { resetRouterBandit } from '../../src/learning/router-bandit.js';
import { resetRouterPromotion } from '../../src/learning/router-promotion.js';
import { resetQuotaLedger } from '../../src/learning/quota-ledger.js';
import { resetProviderFallback } from '../../src/learning/provider-fallback.js';

let tempDir: string;
let originalMemoryDir: string | undefined;

/** ConfigManager-shaped stub with a controllable credential set. */
function makeConfig(creds: string[]): any {
  return {
    hasRequiredCredentials: vi.fn((p: string) => creds.includes(p)),
    getAll: () => ({ providers: {}, routing: {} }),
    getProviderConfig: () => ({ type: 'groq', config: {} }),
  };
}

/** Seed a verified provider × model so model-first routing has real data. */
function seedVerified(provider: string, ...models: string[]): void {
  for (const m of models) getModelRegistry().markVerified(provider, m, 'telemetry', 400);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-decision-consistency-'));
  originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = tempDir;
  resetQuotaLedger();
  resetModelRegistry();
  resetAutoRouter();
  resetRouterBandit();
  resetRouterPromotion();
  resetProviderFallback();
});

afterEach(() => {
  resetQuotaLedger();
  resetModelRegistry();
  resetAutoRouter();
  resetRouterBandit();
  resetRouterPromotion();
  resetProviderFallback();
  if (originalMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('AutoModelRouter — decision presentation is self-consistent (T3)', () => {
  const cases: Array<{ agent: string; task: string }> = [
    { agent: 'chat', task: 'say hi' },
    { agent: 'writer', task: 'implement a token bucket rate limiter in TypeScript' },
    { agent: 'planner', task: 'design a distributed rate limiter with Redis and failover semantics' },
    { agent: 'reviewer', task: 'review this diff for security vulnerabilities' },
    { agent: 'writer', task: 'remove all console.log statements' },
  ];

  it('the rationale names the SAME provider/model as the Decision, and ranked[0] is the pick', () => {
    // Verified models on three providers — enough for model-first routing to
    // have real data and potentially override the deterministic pick.
    seedVerified('gemini', 'gemini-big', 'gemini-small');
    seedVerified('groq', 'groq-mid', 'groq-fast');
    seedVerified('local', 'local-model');
    const config = makeConfig(['gemini', 'groq', 'local']);

    for (const { agent, task } of cases) {
      const router = new AutoModelRouter();
      const decision = router.resolve(agent, task, {}, config);

      // The ranked table's #1 row IS the decision (so the ✅ can never sit on a
      // lower-ranked row while a different provider heads the list).
      expect(decision.ranked[0].provider).toBe(decision.provider);
      expect(decision.ranked[0].score).toBe(decision.score);

      // The rationale's `provider/model` segment matches the Decision exactly.
      const rationale = decision.explanation.split('→ ')[1]?.split(' ')[0];
      expect(rationale).toBe(`${decision.provider}/${decision.model}`);
    }
  });
});

/**
 * REGRESSION (2026-10-04, live trace): a MODERATE software build ask routed to
 * `local/gemma4:e4b` — a ≤4B model — even though credentialed cloud providers
 * were available. The deterministic rank was correct (groq first); the
 * MODEL-FIRST override, which runs AFTER the agentic capability floor, replaced
 * it with the local 4B model (reason `local: model-first pick`). Chat then
 * fabricated `[Tool result] ✅ succeeded` output. The override must respect the
 * same agentic floor the ranker applied.
 */
describe('AutoModelRouter — model-first override respects the agentic capability floor', () => {
  // The shared predicate is what BOTH the ranking floor and the model-first
  // override call, so pinning it pins both seams. (The live bug was the
  // override bypassing the floor and re-picking `local/gemma4:e4b`.)
  it('excludes tiny and local-placeholder models, keeps unknown and capable ones', () => {
    // Out: ≤4B tags on any provider.
    expect(isAgenticCapableModel('gemma4:e4b', 'local')).toBe(false);
    expect(isAgenticCapableModel('qwen2.5:0.5b', 'local')).toBe(false);
    expect(isAgenticCapableModel('llama3.2:1b', 'groq')).toBe(false);
    expect(isAgenticCapableModel('phi3', 'openrouter')).toBe(false);
    // Out: a local runtime with no judgeable model id.
    expect(isAgenticCapableModel('default', 'local')).toBe(false);
    expect(isAgenticCapableModel('unknown', 'local')).toBe(false);
    // Kept: a real local tag (a local 70B is fine), a capable cloud model, and
    // an UNKNOWN model (never eliminate on ignorance).
    expect(isAgenticCapableModel('llama3:70b', 'local')).toBe(true);
    expect(isAgenticCapableModel('gemini-3.1-flash-lite', 'gemini')).toBe(true);
    expect(isAgenticCapableModel('llama-3.3-70b-versatile', 'groq')).toBe(true);
    expect(isAgenticCapableModel(undefined, 'local')).toBe(true);
  });

  it('never lands an agentic software ask on a ≤4B local model when a capable provider exists', () => {
    // A box with a tiny local runtime AND two credentialed cloud providers —
    // exactly the shape that produced the regression.
    seedVerified('local', 'gemma4:e4b', 'qwen2.5:0.5b', 'deepseek-coder:latest');
    seedVerified('groq', 'llama-3.3-70b-versatile');
    seedVerified('gemini', 'gemini-2.5-flash');
    const config = makeConfig(['local', 'groq', 'gemini']);

    const router = new AutoModelRouter();
    const decision = router.resolve(
      'chat',
      'install rust and build the macos gui app in /Users/me/Documents/cal/src-tauri',
      {},
      config,
    );

    expect(isTinyModel(decision.model)).toBe(false);
    expect(decision.provider).not.toBe('local');
  });
});

/**
 * A1 — the router must RECORD a capability verdict on its own decision, so the
 * turn/trace/console can prove what it did without re-deriving it. These pin
 * that `agenticCapable` is exactly the shared predicate on the FINAL pair, and
 * that `overrideReason` names the shape of the original bug (a model-first
 * candidate set emptied BY THE FLOOR).
 */
describe('AutoRouteResult — agentic capability verdict is recorded (A1)', () => {
  it('verdict matches the shared predicate on the FINAL routed pair', () => {
    seedVerified('local', 'gemma4:e4b', 'qwen2.5:0.5b', 'deepseek-coder:latest');
    seedVerified('groq', 'llama-3.3-70b-versatile');
    seedVerified('gemini', 'gemini-2.5-flash');
    const config = makeConfig(['local', 'groq', 'gemini']);

    const decision = new AutoModelRouter().resolve(
      'chat',
      'install rust and build the macos gui app in /Users/me/Documents/cal/src-tauri',
      {},
      config,
    );

    expect(decision.agenticCapable).toBe(true);
    expect(decision.agenticCapable).toBe(
      isAgenticCapableModel(decision.model, decision.provider),
    );
  });

  it('records agenticCapable=false and model-first-blocked when only weak models exist', () => {
    // A box whose ONLY models are ≤4B: the floor has nothing capable to keep,
    // so the model-first candidate set is emptied BY THE FLOOR and the
    // deterministic (weak) pick must stand — recorded, not inferred.
    seedVerified('local', 'gemma4:e4b', 'qwen2.5:0.5b');
    const config = makeConfig(['local']);

    const decision = new AutoModelRouter().resolve(
      'chat',
      'install rust and build the macos gui app in /Users/me/Documents/cal/src-tauri',
      {},
      config,
    );

    expect(decision.agenticCapable).toBe(false);
    expect(decision.overrideReason).toBe('model-first-blocked');
  });
});
