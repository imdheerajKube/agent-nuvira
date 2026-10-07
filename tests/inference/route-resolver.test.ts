/**
 * Route resolver — the ONE place a provider and its model are validated as a
 * PAIR (issues #9, #10, #11).
 *
 * The live defect these tests pin: a release run failed its first model call
 * with `Groq API error (404): The model 'gemini-3.1-flash-lite' does not exist`
 * — a Gemini id sent to Groq — while the repair machinery sat unused because it
 * only ran for an EMPTY or `default` model. Two properties matter as much as the
 * repair itself: the model is validated against the adapter that will serve the
 * call, and a substitution is never silent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  resolveRoute,
  resetSubstitutionReporting,
  resetRouteAudit,
  substitutionLine,
  strictModelMode,
} from '../../src/inference/route-resolver.js';
import { getRoutingHistory } from '../../src/learning/routing-history.js';
import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InferenceProvider } from '../../src/inference/interface.js';
import { logger } from '../../src/utils/logger.js';
import { beginTrace, endTrace, getTrace } from '../../src/learning/reasoning-trace.js';

/** A provider stand-in: only `listModels` matters to model validation. */
function fakeProvider(models: string[] | Error): InferenceProvider {
  return {
    name: 'fake',
    async listModels() {
      if (models instanceof Error) throw models;
      return models.map((id) => ({ id }));
    },
  } as unknown as InferenceProvider;
}

// A substitution is announced once per pair per PROCESS. Each test stands in for
// its own process, so the record starts empty — otherwise a test that asserts the
// announcement inherits the previous test's quiet (a leak that is invisible until
// the assertions start returning 0).
beforeEach(() => {
  resetSubstitutionReporting();
  delete process.env.NUVIRA_STRICT_MODEL;
});

describe('resolveRoute — the pair is validated', () => {

  it('returns the requested model untouched when the provider serves it', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const route = await resolveRoute({
      providerType: 'groq',
      provider: fakeProvider(['llama-3.3-70b-versatile', 'openai/gpt-oss-120b']),
      model: 'openai/gpt-oss-120b',
    });

    expect(route.model).toBe('openai/gpt-oss-120b');
    expect(route.substituted).toBe(false);
    // A healthy pair must be quiet — a warning on every call is noise the real
    // substitution announcement would drown in.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('repairs a model from ANOTHER provider and says so out loud', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const route = await resolveRoute({
      providerType: 'groq',
      provider: fakeProvider(['llama-3.3-70b-versatile', 'openai/gpt-oss-120b']),
      // The exact id from the live 404: a Gemini model sent to Groq.
      model: 'gemini-3.1-flash-lite',
    });

    expect(route.substituted).toBe(true);
    expect(route.requested).toBe('gemini-3.1-flash-lite');
    expect(route.model).not.toBe('gemini-3.1-flash-lite');
    expect(route.model).not.toBe('default');
    // Named, not silent: the console line carries both halves of the pair.
    const printed = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('gemini-3.1-flash-lite');
    expect(printed).toContain(route.model);
    expect(printed).toContain('groq');
    warn.mockRestore();
  });

  it('never hands the "default" sentinel to a provider API', async () => {
    const route = await resolveRoute({
      providerType: 'groq',
      provider: fakeProvider(['llama-3.3-70b-versatile']),
      model: 'default',
    });
    expect(route.model).toBeTruthy();
    expect(route.model).not.toBe('default');
    expect(route.substituted).toBe(false);
  });

  it('keeps a real requested model when the live list cannot be fetched', async () => {
    // Offline / no key: the honest outcome is the model the caller asked for
    // (so any error names the real model), never an empty string and never a
    // claim that a substitution happened.
    const route = await resolveRoute({
      providerType: 'groq',
      provider: fakeProvider(new Error('offline')),
      model: 'openai/gpt-oss-120b',
    });
    expect(route.model).toBe('openai/gpt-oss-120b');
    expect(route.substituted).toBe(false);
  });
});

describe('resolveRoute — strict mode refuses to substitute', () => {
  afterEach(() => {
    delete process.env.NUVIRA_STRICT_MODEL;
  });

  it('throws with both sides of the pair named, and announces nothing it did not do', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await expect(
      resolveRoute({
        providerType: 'groq',
        provider: fakeProvider(['llama-3.3-70b-versatile']),
        model: 'gemini-3.1-flash-lite',
        strict: true,
      }),
    ).rejects.toThrow(/gemini-3\.1-flash-lite.*groq|groq.*gemini-3\.1-flash-lite/);
    // Announcing a substitution that then throws is worse than silence — the
    // report and the outcome have to agree.
    const printed = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).not.toContain('using');
    warn.mockRestore();
  });

  it('prints exactly ONE line per substitution, however many layers can repair', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const provider = fakeProvider(['llama-3.3-70b-versatile']);
    // Same pair, three calls — the pinned repair and the failover walk both
    // resolve it in a real run.
    for (let i = 0; i < 3; i++) {
      await resolveRoute({ providerType: 'groq', provider, model: 'gemini-3.1-flash-lite' });
    }
    const mentions = warn.mock.calls.filter((c) => String(c[0]).includes('gemini-3.1-flash-lite'));
    expect(mentions.length).toBe(1);
    warn.mockRestore();
  });

  it('is opt-in per call and via NUVIRA_STRICT_MODEL', async () => {
    expect(strictModelMode()).toBe(false);
    process.env.NUVIRA_STRICT_MODEL = '1';
    expect(strictModelMode()).toBe(true);

    await expect(
      resolveRoute({
        providerType: 'gemini',
        provider: fakeProvider(['gemini-flash-latest']),
        model: 'gemini-2.0-flash-exp',
      }),
    ).rejects.toThrow(/strict model mode/);
  });
});

describe('resolveRoute — a substitution reaches the run trace', () => {
  it('attaches to the run in progress when the caller holds no trace id', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const traceId = beginTrace({ goal: 'publish a release', source: 'orchestrator' });
    try {
      await resolveRoute({
        providerType: 'groq',
        provider: fakeProvider(['llama-3.3-70b-versatile']),
        model: 'gemini-3.1-flash-lite',
        task: 'release',
      });
    } finally {
      endTrace(traceId);
      warn.mockRestore();
    }

    const trace = getTrace(traceId);
    const events = trace?.events ?? [];
    const substitution = events.find((e) => e.summary.includes('gemini-3.1-flash-lite'));
    expect(substitution, 'the substitution must be readable from the run itself').toBeDefined();
    expect(substitution!.kind).toBe('decision');
  });
});

describe('resolveRoute — the HAPPY path reaches the audit trail', () => {
  // The audit trail is a real file. Point it at a temp dir so a test never
  // writes (or reads) the operator's own routing history.
  let dir: string;
  const prior = process.env.NUVIRA_MEMORY_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nuvira-route-audit-'));
    process.env.NUVIRA_MEMORY_DIR = dir;
    resetRouteAudit();
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the served pair, so a run that never substituted is still auditable', async () => {
    const route = await resolveRoute({
      providerType: 'groq',
      provider: fakeProvider(['openai/gpt-oss-120b']),
      model: 'openai/gpt-oss-120b',
      source: 'chat',
      agentType: 'chat',
      task: 'build a knowledge base app',
    });

    expect(route.substituted).toBe(false);
    const rows = getRoutingHistory(50).filter(
      (e) => e.provider === 'groq' && e.model === 'openai/gpt-oss-120b',
    );
    // Measured defect this pins: a 12-minute, 82-step turn left ZERO rows, so
    // "which model served this?" could not be answered from the audit trail.
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe('chat');
    expect(rows[0].task).toBe('build a knowledge base app');
  });

  it('omits a guessed complexity rather than inventing one', async () => {
    await resolveRoute({
      providerType: 'groq',
      provider: fakeProvider(['openai/gpt-oss-120b']),
      model: 'openai/gpt-oss-120b',
    });
    const row = getRoutingHistory(50).find((e) => e.provider === 'groq');
    // This layer resolves a PAIR; it does not classify the ask.
    expect(row?.complexity).toBe('unknown');
  });

  it('records a pair ONCE per process — a route is a property of the pair', async () => {
    const provider = fakeProvider(['openai/gpt-oss-120b']);
    for (let i = 0; i < 3; i++) {
      await resolveRoute({ providerType: 'groq', provider, model: 'openai/gpt-oss-120b' });
    }
    const rows = getRoutingHistory(50).filter((e) => e.provider === 'groq');
    expect(rows.length).toBe(1);
  });
});

/**
 * A1/A2 — a PIN the registry has PROVEN dead is refused before any network call,
 * and the operator is told the real reason.
 *
 * Measured (Run D): `-p openrouter -m deepseek/deepseek-v4.1-flash` was fired at
 * an account with no credits. The pin was accepted, the call went out, and the
 * cause arrived as a raw 402 body after a full round trip. Under strict mode the
 * run was GUARANTEED to fail, so the only question was whether it failed fast
 * with the reason or slowly with a provider error.
 */
describe('resolveRoute — A2: a proven-dead pin is refused before any network call', () => {
  let dir: string;
  const prior = process.env.NUVIRA_MEMORY_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nuvira-pin-preflight-'));
    process.env.NUVIRA_MEMORY_DIR = dir;
    resetModelRegistry();
    resetRouteAudit();
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  });

  /** A provider whose model list is OBSERVABLE — the whole point of a pre-flight. */
  const spyProvider = (models: string[]) => {
    const listModels = vi.fn(async () => models.map((id) => ({ id })));
    return { provider: { name: 'fake', listModels } as unknown as InferenceProvider, listModels };
  };

  it('refuses without asking the provider for its model list', async () => {
    getModelRegistry().recordCall(
      'openrouter',
      'deepseek/deepseek-v4.1-flash',
      false,
      'credit-exhausted',
      'chat',
    );
    const { provider, listModels } = spyProvider(['deepseek/deepseek-v4.1-flash']);

    await expect(
      resolveRoute({
        providerType: 'openrouter',
        provider,
        model: 'deepseek/deepseek-v4.1-flash',
        strict: true,
      }),
    ).rejects.toThrow(/Refusing to call openrouter\/deepseek\/deepseek-v4\.1-flash/);

    // THE assertion that makes it a PRE-FLIGHT rather than a nicer error.
    expect(listModels).not.toHaveBeenCalled();
  });

  it('names the reason, and keeps the phrase the repair ladder classifies on', async () => {
    getModelRegistry().recordCall('openrouter', 'vendor/broken', false, 'credit-exhausted', 'chat');
    await expect(
      resolveRoute({
        providerType: 'openrouter',
        provider: fakeProvider(['vendor/broken']),
        model: 'vendor/broken',
        strict: true,
      }),
    ).rejects.toThrow(/credit-exhausted|forbids substituting/);
  });

  it('names a verified EQUIVALENT on another provider when the bare model id matches (A1)', async () => {
    const registry = getModelRegistry();
    registry.recordCall('openrouter', 'vendor/some-model', false, 'credit-exhausted', 'chat');
    registry.markVerified('deepseek', 'some-model', 'probe');

    await expect(
      resolveRoute({
        providerType: 'openrouter',
        provider: fakeProvider(['vendor/some-model']),
        model: 'vendor/some-model',
        strict: true,
      }),
    ).rejects.toThrow(/deepseek\/some-model/);
  });

  it('names the EQUIVALENT for a DECLARED alias the bare-id rule cannot join (A1)', async () => {
    // The measured pair, now related by declaration: `deepseek/deepseek-v4.1-flash`
    // (the run-D pin, `credit-exhausted` on openrouter) and the verified
    // `deepseek-flash`. They share no bare id, so before A1 this honestly said
    // "no known equivalent" — leaving the operator to discover by hand that the
    // same model was funded on another provider.
    const registry = getModelRegistry();
    registry.recordCall('openrouter', 'deepseek/deepseek-v4.1-flash', false, 'credit-exhausted', 'chat');
    registry.markVerified('deepseek', 'deepseek-flash', 'probe');

    await expect(
      resolveRoute({
        providerType: 'openrouter',
        provider: fakeProvider(['deepseek/deepseek-v4.1-flash']),
        model: 'deepseek/deepseek-v4.1-flash',
        strict: true,
      }),
    ).rejects.toThrow(/deepseek\/deepseek-flash/);
  });

  it('honestly offers no equivalent when ids merely LOOK alike (no family guessing)', async () => {
    // `deepseek-v4-flash` and `deepseek-v4.1-flash` are both DeepSeek and both
    // "flash", one version apart — and they are NOT the same model. Asserting
    // otherwise from their spelling is the name-based judgement this programme
    // exists to remove, so the refusal must still say "no known equivalent".
    const registry = getModelRegistry();
    registry.recordCall('openrouter', 'deepseek/deepseek-v4.1-flash', false, 'credit-exhausted', 'chat');
    registry.markVerified('deepseek', 'deepseek/deepseek-v4-flash', 'probe');

    await expect(
      resolveRoute({
        providerType: 'openrouter',
        provider: fakeProvider(['deepseek/deepseek-v4.1-flash']),
        model: 'deepseek/deepseek-v4.1-flash',
        strict: true,
      }),
    ).rejects.toThrow(/nuvira models/);
  });

  it('does NOT refuse an UNVERIFIED pin — that is how a new model gets proven', async () => {
    // `unverified` means "nothing has ever been tried", not "broken". Refusing
    // it would forbid the pins whose whole purpose is to prove a model.
    const { provider } = spyProvider(['brand/new-model']);
    const route = await resolveRoute({
      providerType: 'openrouter',
      provider,
      model: 'brand/new-model',
      strict: true,
    });
    expect(route.model).toBe('brand/new-model');
  });
});

describe('substitutionLine', () => {
  it('names both the requested and the served model, with the provider', () => {
    const line = substitutionLine({
      providerType: 'groq',
      requested: 'gemini-3.1-flash-lite',
      served: 'openai/gpt-oss-120b',
    });
    expect(line).toContain('groq/gemini-3.1-flash-lite');
    expect(line).toContain('openai/gpt-oss-120b');
  });
});
