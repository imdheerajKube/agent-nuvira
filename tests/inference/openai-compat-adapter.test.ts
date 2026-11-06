/**
 * The generic OpenAI-compatible adapter's availability probe.
 *
 * A keyless provider (a local runner, or a gateway such as OmniRoute) can be
 * serving chat while gating `/v1/models` behind a 401. Treating that 401 as
 * "down" made every eval/parity run refuse a server that demonstrably works, so
 * a keyless provider counts a 401/403 as reachable — while a provider WITH a
 * configured key still reads a 401 as a bad key.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderFactory } from '../../src/inference/factory.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';
import { clearOutputBudgetMemory, rememberedOutputBudget } from '../../src/inference/output-budget.js';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const response = (status: number, body: unknown = {}): { ok: boolean; status: number; headers: Headers; json: () => Promise<unknown> } => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: async () => body,
});

describe('OpenAICompatAdapter.isAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelRegistry();
  });

  it('is available on a 200 models list', async () => {
    mockFetch.mockResolvedValueOnce(response(200, { data: [{ id: 'm' }] }));
    const provider = ProviderFactory.createProvider('omniroute', { model: 'auto/smart' } as never);
    expect(await provider.isAvailable()).toBe(true);
  });

  it('treats a 401 on a KEYLESS provider as reachable (server up, enumeration gated)', async () => {
    mockFetch.mockResolvedValueOnce(response(401, { error: { message: 'Authentication required' } }));
    const provider = ProviderFactory.createProvider('omniroute', { model: 'auto/smart' } as never);
    expect(await provider.isAvailable()).toBe(true);
  });

  it('treats a 401 on a KEYED provider as unavailable (a 401 there is a bad key)', async () => {
    mockFetch.mockResolvedValueOnce(response(401, { error: { message: 'Unauthorized' } }));
    const provider = ProviderFactory.createProvider('deepseek', { apiKey: 'sk-test', model: 'deepseek-flash' } as never);
    expect(await provider.isAvailable()).toBe(false);
  });

  it('is unavailable when the request throws (connection refused)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const provider = ProviderFactory.createProvider('omniroute', { model: 'auto/smart' } as never);
    expect(await provider.isAvailable()).toBe(false);
  });
});

/**
 * A step cut at the output cap is EVIDENCE the model needs more room — not
 * evidence it is dead. The adapter records it for the pair and raises the cap on
 * the next request, which is what lets the loop re-ask a reasoning model instead
 * of rotating away from it.
 */
describe('OpenAICompatAdapter — learned output budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelRegistry();
    clearOutputBudgetMemory();
  });

  const truncated = () =>
    response(200, {
      choices: [{ message: { content: '', reasoning_content: 'thinking…'.repeat(50) }, finish_reason: 'length' }],
      usage: { prompt_tokens: 100, completion_tokens: 1024 },
    });

  it('learns from finish_reason "length" and sends a larger cap next time', async () => {
    mockFetch.mockResolvedValueOnce(truncated());
    const provider = ProviderFactory.createProvider('deepseek', {
      apiKey: 'sk-test',
      model: 'deepseek-v4-pro',
    } as never);

    await provider.generate('hi', { model: 'deepseek-v4-pro', maxTokens: 1024 });
    expect(rememberedOutputBudget('deepseek', 'deepseek-v4-pro')).toBeGreaterThanOrEqual(8192);

    mockFetch.mockResolvedValueOnce(
      response(200, { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] }),
    );
    await provider.generate('hi', { model: 'deepseek-v4-pro', maxTokens: 1024 });

    const body = JSON.parse(String((mockFetch.mock.calls[1]?.[1] as RequestInit).body)) as { max_tokens: number };
    expect(body.max_tokens).toBeGreaterThanOrEqual(8192);
  });

  it('does not raise the cap for a step that finished normally', async () => {
    mockFetch.mockResolvedValueOnce(
      response(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    );
    const provider = ProviderFactory.createProvider('deepseek', {
      apiKey: 'sk-test',
      model: 'deepseek-v4-flash',
    } as never);

    await provider.generate('hi', { model: 'deepseek-v4-flash', maxTokens: 1024 });
    expect(rememberedOutputBudget('deepseek', 'deepseek-v4-flash')).toBeUndefined();
  });
});

/**
 * A tool call whose ARGUMENTS were cut is the same evidence as an empty answer:
 * the model was still emitting when the cap ended the step. The empty-answer path
 * never sees it (the step has content and a call), so without this the pair kept
 * being re-asked under the cap that had just cut it — and the only way to deliver
 * a large document was to fragment it.
 *
 * Measured (trace-1793853385112-sf2exl, 2026-11-05): a sectioned `edit_file` was
 * cut mid-JSON at 4,096 tokens; the audit report on disk ended at §1.
 */
describe('OpenAICompatAdapter — cut tool-call arguments raise the cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelRegistry();
    clearOutputBudgetMemory();
  });

  /** A step that carries a tool call whose argument JSON never finished. */
  const cutArguments = () =>
    response(200, {
      choices: [
        {
          message: {
            content: 'Writing the report.',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'write_file', arguments: '{"path":"AUDIT.md","content":"# Audit\\n\\n## 1.' },
              },
            ],
          },
          // Deliberately ABSENT: gateways that do not echo it are the case this
          // path exists for. The argument bytes still prove the truncation.
          finish_reason: null,
        },
      ],
      usage: { prompt_tokens: 900, completion_tokens: 4096 },
    });

  it('learns from unusable arguments even with no finish_reason, and reports the new cap', async () => {
    mockFetch.mockResolvedValueOnce(cutArguments());
    const provider = ProviderFactory.createProvider('deepseek', {
      apiKey: 'sk-test',
      model: 'deepseek-flash',
    } as never);

    const result = await provider.generateTools!(
      [{ role: 'user', content: 'write the report' } as never],
      [{ name: 'write_file', description: 'write a file', parameters: { type: 'object' } }],
      { model: 'deepseek-flash', maxTokens: 4096 },
    );

    expect(result.toolCalls[0]?.argumentsError).toBe('unparseable');
    // The pair earned a bigger floor …
    expect(rememberedOutputBudget('deepseek', 'deepseek-flash')).toBeGreaterThanOrEqual(8192);
    // … and the CALLER is told the number, so the refusal can say "re-send it
    // once" instead of teaching the model to fragment its deliverable.
    expect(result.budgetAfterTruncation).toBeGreaterThanOrEqual(8192);
  });

  it('leaves a step alone when its arguments parsed', async () => {
    mockFetch.mockResolvedValueOnce(
      response(200, {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    const provider = ProviderFactory.createProvider('deepseek', {
      apiKey: 'sk-test',
      model: 'deepseek-flash',
    } as never);

    const result = await provider.generateTools!(
      [{ role: 'user', content: 'list' } as never],
      [{ name: 'list_dir', description: 'list', parameters: { type: 'object' } }],
      { model: 'deepseek-flash', maxTokens: 4096 },
    );

    expect(result.toolCalls[0]?.argumentsError).toBeUndefined();
    expect(result.budgetAfterTruncation).toBeUndefined();
    expect(rememberedOutputBudget('deepseek', 'deepseek-flash')).toBeUndefined();
  });
});
