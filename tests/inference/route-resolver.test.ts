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
  substitutionLine,
  strictModelMode,
} from '../../src/inference/route-resolver.js';
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
