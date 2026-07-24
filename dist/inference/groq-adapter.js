import { logger } from '../utils/logger.js';
import { streamCompletion } from './sse.js';
import { getModelTags } from './model-catalog.js';
import { getCostTracker } from '../learning/cost-tracker.js';
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
/**
 * Groq Adapter
 * Connects to Groq's OpenAI-compatible API for fast inference
 */
export class GroqAdapter {
    name = 'Groq';
    config;
    constructor(config) {
        this.config = config;
    }
    async generate(prompt, options) {
        const apiKey = this.config.apiKey;
        if (!apiKey) {
            throw new Error('Groq API key is not configured. Set GROQ_API_KEY env var.');
        }
        const model = options?.model || this.config.model || 'llama-3.3-70b-versatile';
        const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
        const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;
        logger.debug(`Groq: Generating with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);
        const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
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
            throw new Error(`Groq API error (${response.status}): ${errorBody}`);
        }
        const data = (await response.json());
        const content = data.choices[0]?.message?.content || '';
        // Track cost
        try {
            const costTracker = getCostTracker();
            costTracker.recordCallEstimated('groq', model, prompt, content);
        }
        catch { /* Non-critical */ }
        return content;
    }
    async generateStream(prompt, options, onToken) {
        const apiKey = this.config.apiKey;
        if (!apiKey) {
            throw new Error('Groq API key is not configured. Set GROQ_API_KEY env var.');
        }
        const model = options?.model || this.config.model || 'llama-3.3-70b-versatile';
        const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
        const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;
        logger.debug(`Groq: Streaming with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);
        const fullContent = await streamCompletion(`${GROQ_BASE_URL}/chat/completions`, { 'Authorization': `Bearer ${apiKey}` }, { model, messages: [{ role: 'user', content: prompt }], temperature, max_tokens: maxTokens }, onToken);
        // Track cost for streaming response
        try {
            const costTracker = getCostTracker();
            costTracker.recordCallEstimated('groq', model, prompt, fullContent);
        }
        catch { /* Non-critical */ }
        return fullContent;
    }
    async isAvailable() {
        return !!this.config.apiKey;
    }
    getInfo() {
        return `Provider: Groq\nModel: ${this.config.model || 'default'}\nStatus: ${this.config.apiKey ? '✅ Configured' : '❌ Missing API key'}`;
    }
    async listModels() {
        const apiKey = this.config.apiKey;
        if (!apiKey)
            return [];
        try {
            const response = await fetch(`${GROQ_BASE_URL}/models`, {
                headers: { 'Authorization': `Bearer ${apiKey}` },
            });
            if (!response.ok)
                return [];
            const data = (await response.json());
            // Filter out non-chat models (speech/audio/whisper) that can't be used
            // with the chat completions endpoint
            return (data.data || [])
                .map((m) => ({
                id: m.id,
                name: m.id,
                provider: 'groq',
                owner: m.owned_by || 'groq',
                tags: getModelTags(m.id, m.owned_by),
            }));
        }
        catch {
            return [];
        }
    }
}
//# sourceMappingURL=groq-adapter.js.map