import { logger } from '../utils/logger.js';
import { streamCompletion } from './sse.js';
import { getModelTags } from './model-catalog.js';
import { getCostTracker, recordCallWithUsage } from '../learning/cost-tracker.js';
import { requireAdapterModel } from '../learning/model-selection.js';
const DEFAULT_NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';
/**
 * NVIDIA NIM Adapter
 * Connects to NVIDIA NIM OpenAI-compatible API
 */
export class NIMAdapter {
    name = 'NVIDIA NIM';
    config;
    constructor(config) {
        this.config = config;
    }
    async generate(prompt, options) {
        // M2.3: options.apiKey overrides the configured key (multi-account rotation).
        const apiKey = options?.apiKey || this.config.apiKey;
        if (!apiKey) {
            throw new Error('NVIDIA NIM API key is not configured. Set NVIDIA_NIM_API_KEY env var.');
        }
        const model = options?.model || requireAdapterModel('nim', this.config.model);
        const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
        const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;
        logger.debug(`NIM: Generating with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);
        const baseUrl = this.config.baseUrl || DEFAULT_NIM_BASE_URL;
        const url = `${baseUrl}/chat/completions`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                temperature,
                max_tokens: maxTokens,
            }),
        });
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`NVIDIA NIM API error (${response.status}): ${errorBody}`);
        }
        const data = (await response.json());
        const content = data.choices[0]?.message?.content || '';
        // Track cost — M2.2: use the endpoint-reported usage (exact wire tokens)
        // when present, else the length-based estimate.
        try {
            const usage = data.usage;
            recordCallWithUsage(getCostTracker(), 'nim', model, prompt, content, usage
                ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
                : undefined);
        }
        catch { /* Non-critical */ }
        return content;
    }
    async generateStream(prompt, options, onToken) {
        // M2.3: options.apiKey overrides the configured key (multi-account rotation).
        const apiKey = options?.apiKey || this.config.apiKey;
        if (!apiKey) {
            throw new Error('NVIDIA NIM API key is not configured. Set NVIDIA_NIM_API_KEY env var.');
        }
        const model = options?.model || requireAdapterModel('nim', this.config.model);
        const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
        const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;
        logger.debug(`NIM: Streaming with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);
        const baseUrl = this.config.baseUrl || DEFAULT_NIM_BASE_URL;
        // M2.2: capture the endpoint-reported usage from the final SSE chunk
        // (OpenAI stream_options.include_usage convention) for measured cost.
        let streamUsage;
        const fullContent = await streamCompletion(`${baseUrl}/chat/completions`, { 'Authorization': `Bearer ${apiKey}` }, { model, messages: [{ role: 'user', content: prompt }], temperature, max_tokens: maxTokens }, onToken, (u) => {
            streamUsage = u;
        });
        // Track cost for streaming response
        try {
            recordCallWithUsage(getCostTracker(), 'nim', model, prompt, fullContent, streamUsage);
        }
        catch { /* Non-critical */ }
        return fullContent;
    }
    async isAvailable() {
        // Deliberately checks availability with the CONFIG (primary) key only, not
        // a rotated key: endpoint availability is account-independent, and the
        // M2.3 rotation walk handles per-key auth/rate-limit at generate time. Do
        // not "fix" this into a per-key probe — it would slow every candidate
        // check for zero correctness gain.
        return !!this.config.apiKey;
    }
    getInfo() {
        return `Provider: NVIDIA NIM\nModel: ${this.config.model || 'default'}\nStatus: ${this.config.apiKey ? '✅ Configured' : '❌ Missing API key'}`;
    }
    async listModels() {
        // Primary-key probe by design (see isAvailable): the model list is shared
        // across accounts of the same provider.
        const apiKey = this.config.apiKey;
        if (!apiKey)
            return [];
        const baseUrl = this.config.baseUrl || DEFAULT_NIM_BASE_URL;
        try {
            const response = await fetch(`${baseUrl}/models`, {
                headers: { 'Authorization': `Bearer ${apiKey}` },
            });
            if (!response.ok)
                return [];
            // vLLM-backed NIM deployments expose `max_model_len` in the
            // OpenAI-compatible list (total sequence length = input + output — a
            // slight overestimate of the input window for preflight, fine for a soft
            // estimate); others (TensorRT-LLM) omit it. Parse defensively, fall back
            // to the provider-level default.
            const data = (await response.json());
            return (data.data || []).map((m) => {
                const ctx = typeof m.max_model_len === 'number' && m.max_model_len > 0 ? m.max_model_len : undefined;
                return {
                    id: m.id,
                    name: m.id.split('/').pop() || m.id,
                    provider: 'nim',
                    owner: m.owned_by || 'nvidia',
                    tags: getModelTags(m.id, m.owned_by),
                    ...(ctx !== undefined ? { contextWindowTokens: ctx } : {}),
                };
            });
        }
        catch {
            return [];
        }
    }
}
//# sourceMappingURL=nim-adapter.js.map