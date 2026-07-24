import { logger } from '../utils/logger.js';
import { streamCompletion } from './sse.js';
import { getModelTags } from './model-catalog.js';
import { getCostTracker } from '../learning/cost-tracker.js';
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
        const apiKey = this.config.apiKey;
        if (!apiKey) {
            throw new Error('NVIDIA NIM API key is not configured. Set NVIDIA_NIM_API_KEY env var.');
        }
        const model = options?.model || this.config.model || 'meta/llama-3.1-8b-instruct';
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
        // Track cost
        try {
            getCostTracker().recordCallEstimated('nim', model, prompt, content);
        }
        catch { /* Non-critical */ }
        return content;
    }
    async generateStream(prompt, options, onToken) {
        const apiKey = this.config.apiKey;
        if (!apiKey) {
            throw new Error('NVIDIA NIM API key is not configured. Set NVIDIA_NIM_API_KEY env var.');
        }
        const model = options?.model || this.config.model || 'meta/llama-3.1-8b-instruct';
        const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
        const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;
        logger.debug(`NIM: Streaming with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);
        const baseUrl = this.config.baseUrl || DEFAULT_NIM_BASE_URL;
        const fullContent = await streamCompletion(`${baseUrl}/chat/completions`, { 'Authorization': `Bearer ${apiKey}` }, { model, messages: [{ role: 'user', content: prompt }], temperature, max_tokens: maxTokens }, onToken);
        // Track cost for streaming response
        try {
            getCostTracker().recordCallEstimated('nim', model, prompt, fullContent);
        }
        catch { /* Non-critical */ }
        return fullContent;
    }
    async isAvailable() {
        return !!this.config.apiKey;
    }
    getInfo() {
        return `Provider: NVIDIA NIM\nModel: ${this.config.model || 'default'}\nStatus: ${this.config.apiKey ? '✅ Configured' : '❌ Missing API key'}`;
    }
    async listModels() {
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
            const data = (await response.json());
            return (data.data || []).map((m) => ({
                id: m.id,
                name: m.id.split('/').pop() || m.id,
                provider: 'nim',
                owner: m.owned_by || 'nvidia',
                tags: getModelTags(m.id, m.owned_by),
            }));
        }
        catch {
            return [];
        }
    }
}
//# sourceMappingURL=nim-adapter.js.map