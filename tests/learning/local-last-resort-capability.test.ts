/**
 * Last-resort LOCAL pick respects CAPABILITY.
 *
 * `local` is the zero-config last resort and is never dropped (auto must not
 * dead-end). But its MODEL was chosen by a health-first ranking, which a tiny
 * tag always wins on latency — measured live: an agentic project-assessment
 * turn ended on `local/qwen2.5:0.5b` while a stronger verified local model
 * existed. This pins that an agentic ask is never answered by the WEAKEST local
 * model when a stronger one is available.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAutoRouter, resetAutoRouter } from '../../src/learning/auto-router.js';
import { buildAutoResolveOptions } from '../../src/learning/resolve-options.js';
import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';
import { getQuotaLedger, resetQuotaLedger } from '../../src/learning/quota-ledger.js';
import { resetRouterBandit } from '../../src/learning/router-bandit.js';
import { resetProviderFallback } from '../../src/learning/provider-fallback.js';

let tempDir: string;
let originalMemoryDir: string | undefined;

function makeConfig(): any {
  return {
    getAll: () => ({ providers: {}, routing: {} }),
    // No cloud credentials — only the keyless `local` runner is usable, which
    // forces the router into the exactly-the-last-resort path this test covers.
    hasRequiredCredentials: vi.fn(() => false),
    getProviderConfig: () => ({ type: 'local', config: {} }),
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-local-capability-'));
  originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = tempDir;
  resetQuotaLedger();
  resetModelRegistry();
  resetAutoRouter();
  resetRouterBandit();
  resetProviderFallback();

  const registry = getModelRegistry();
  // The WEAK model is the HEALTHIEST (lower latency), so a health-first ranking
  // offers it first — the exact ordering that produced the live mis-route.
  registry.markVerified('local', 'qwen2.5:0.5b', 'telemetry', 40);
  registry.markVerified('local', 'gpt-oss:120b-cloud', 'telemetry', 3_000);
});

afterEach(() => {
  resetQuotaLedger();
  resetModelRegistry();
  resetAutoRouter();
  resetRouterBandit();
  resetProviderFallback();
  if (originalMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('last-resort local pick respects capability', () => {
  it('never lands an agentic ask on the weakest local model when a stronger one exists', () => {
    const config = makeConfig();
    // `useModelFirst: false` disables the model-first override, so the decision's
    // model comes straight from the health-first `resolveModel` — the exact case
    // where a 0.5B tag wins on latency. This is where the capability upgrade must
    // apply (measured: with model-first ON the override already picks the strong
    // model, which is why this test was insensitive until it was turned off).
    const options = { ...buildAutoResolveOptions(config), allowedProviders: ['local'], useModelFirst: false };
    const decision = getAutoRouter().resolve('chat', 'implement a feature with tests', options, config);

    expect(decision.provider).toBe('local');
    // The weaker model is the healthiest, so without the capability upgrade the
    // router would pick it. It must not.
    expect(decision.model).not.toBe('qwen2.5:0.5b');
    expect(decision.model).toBe('gpt-oss:120b-cloud');
  });
});
