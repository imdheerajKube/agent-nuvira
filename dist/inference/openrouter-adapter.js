import { logger } from '../utils/logger.js';
import { streamCompletion } from './sse.js';
import { chatCompletionsWithTools, chatCompletionsWithToolsStream } from './tools.js';
import { getModelTags } from './model-catalog.js';
import { getCostTracker } from '../learning/cost-tracker.js';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
/**
 * Common small models on OpenRouter that have low max_tokens.
 * OpenRouter exposes hundreds of models; for safety, we only cap known
 * small ones (≤2B params) and leave the default (4096) for larger models.
 */
const OPENROUTER_LOW_OUTPUT_MODELS = [
    /gemma-?2-?[12]b/i,
    /gemma-?3-?1b/i,
    /llama-?3[._-]?2-?[12]b/i,
    /phi-?3-mini/i,
    /qwen-?2-?0.5b/i,
    /tinyllama/i,
    /starcoderbase/i,
];
/** Cap max_tokens for known small models on OpenRouter. */
function openRouterModelMaxTokens(model) {
    if (OPENROUTER_LOW_OUTPUT_MODELS.some((rx) => rx.test(model)))
        return 1024;
    return 4096;
}
/**
 * OpenRouter Adapter
 * Routes requests through OpenRouter's multi-provider API
 */
export class OpenRouterAdapter {
    name = 'OpenRouter';
    config;
    constructor(config) {
        this.config = config;
    }
    async generate(prompt, options) {
        const apiKey = this.config.apiKey;
        if (!apiKey) {
            throw new Error('OpenRouter API key is not configured. Set OPENROUTER_API_KEY env var.');
        }
        const model = options?.model || this.config.model || 'mistralai/mistral-7b-instruct';
        const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
        const maxTokens = Math.min(options?.maxTokens ?? this.config.maxTokens ?? 4096, openRouterModelMaxTokens(model));
        logger.debug(`OpenRouter: Generating with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);
        const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/buff-cli/buff',
                'X-Title': 'Buff CLI',
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
            throw new Error(`OpenRouter API error (${response.status}): ${errorBody}`);
        }
        const data = (await response.json());
        const content = data.choices[0]?.message?.content || '';
        // Track cost
        try {
            getCostTracker().recordCallEstimated('openrouter', model, prompt, content);
        }
        catch { /* Non-critical */ }
        return content;
    }
    /** H1 — native tool-calling via the OpenAI `tools` protocol. */
    async generateTools(messages, tools, options) {
        const apiKey = this.config.apiKey;
        if (!apiKey)
            throw new Error('OpenRouter API key is not configured. Set OPENROUTER_API_KEY env var.');
        const model = options?.model || this.config.model || 'mistralai/mistral-7b-instruct';
        return chatCompletionsWithTools({
            baseUrl: OPENROUTER_BASE_URL,
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://github.com/buff-cli/buff',
                'X-Title': 'Buff CLI',
            },
            model,
            messages,
            tools,
            temperature: options?.temperature ?? this.config.temperature ?? 0.7,
            maxTokens: Math.min(options?.maxTokens ?? this.config.maxTokens ?? 4096, openRouterModelMaxTokens(model)),
            timeoutMs: this.config.timeoutMs ?? 30_000,
            // P4 — external cancellation (the dashboard Cancel button).
            signal: options?.signal,
            // Cost parity with generate(): meter tool-calling turns too.
            onCost: (promptText, contentText) => {
                try {
                    getCostTracker().recordCallEstimated('openrouter', model, promptText, contentText);
                }
                catch {
                    // Non-critical.
                }
            },
        });
    }
    /**
     * P4 — streaming native tool-calling: same wire protocol as generateTools
     * with `stream: true`; content tokens delivered to onToken as they arrive.
     */
    async generateToolsStream(messages, tools, options, onToken) {
        const apiKey = this.config.apiKey;
        if (!apiKey)
            throw new Error('OpenRouter API key is not configured. Set OPENROUTER_API_KEY env var.');
        const model = options?.model || this.config.model || 'mistralai/mistral-7b-instruct';
        return chatCompletionsWithToolsStream({
            baseUrl: OPENROUTER_BASE_URL,
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://github.com/buff-cli/buff',
                'X-Title': 'Buff CLI',
            },
            model,
            messages,
            tools,
            temperature: options?.temperature ?? this.config.temperature ?? 0.7,
            maxTokens: Math.min(options?.maxTokens ?? this.config.maxTokens ?? 4096, openRouterModelMaxTokens(model)),
            timeoutMs: this.config.timeoutMs ?? 30_000,
            // P4 — external cancellation (the dashboard Cancel button).
            signal: options?.signal,
            // Cost parity with generate(): meter tool-calling turns too.
            onCost: (promptText, contentText) => {
                try {
                    getCostTracker().recordCallEstimated('openrouter', model, promptText, contentText);
                }
                catch {
                    // Non-critical.
                }
            },
        }, onToken);
    }
    async generateStream(prompt, options, onToken) {
        const apiKey = this.config.apiKey;
        if (!apiKey) {
            throw new Error('OpenRouter API key is not configured. Set OPENROUTER_API_KEY env var.');
        }
        const model = options?.model || this.config.model || 'mistralai/mistral-7b-instruct';
        const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
        const maxTokens = Math.min(options?.maxTokens ?? this.config.maxTokens ?? 4096, openRouterModelMaxTokens(model));
        logger.debug(`OpenRouter: Streaming with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);
        // OpenRouter uses OpenAI-compatible streaming SSE, same as Groq/NIM
        const fullContent = await streamCompletion(`${OPENROUTER_BASE_URL}/chat/completions`, {
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://github.com/buff-cli/buff',
            'X-Title': 'Buff CLI',
        }, { model, messages: [{ role: 'user', content: prompt }], temperature, max_tokens: maxTokens }, onToken);
        // Track cost for streaming response
        try {
            getCostTracker().recordCallEstimated('openrouter', model, prompt, fullContent);
        }
        catch { /* Non-critical */ }
        return fullContent;
    }
    async isAvailable() {
        return !!this.config.apiKey;
    }
    getInfo() {
        return `Provider: OpenRouter\nModel: ${this.config.model || 'default'}\nStatus: ${this.config.apiKey ? '✅ Configured' : '❌ Missing API key'}`;
    }
    async listModels() {
        const apiKey = this.config.apiKey;
        if (!apiKey)
            return [];
        try {
            const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
                headers: { 'Authorization': `Bearer ${apiKey}` },
            });
            if (!response.ok)
                return [];
            // OpenRouter's /models exposes each model's `context_length` — carry it
            // so the registry records the LIVE advertised window for preflight.
            const data = (await response.json());
            return (data.data || []).map((m) => {
                const ctx = typeof m.context_length === 'number' && m.context_length > 0 ? m.context_length : undefined;
                return {
                    id: m.id,
                    name: m.name || m.id,
                    provider: 'openrouter',
                    description: m.description,
                    tags: getModelTags(m.id),
                    ...(ctx !== undefined ? { contextWindowTokens: ctx } : {}),
                };
            });
        }
        catch {
            return [];
        }
    }
}
//# sourceMappingURL=openrouter-adapter.js.map