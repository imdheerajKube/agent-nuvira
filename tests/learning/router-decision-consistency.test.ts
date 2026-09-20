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
