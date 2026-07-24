import { logger } from '../utils/logger.js';
import { getModelTags } from './model-catalog.js';
import { getCostTracker } from '../learning/cost-tracker.js';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
/**
 * Parse a Gemini SSE streaming response line.
 * Gemini's streaming format differs from OpenAI's SSE:
 * - Each line has `data: ` prefix (like SSE)
 * - The JSON payload has `candidates[].content.parts[].text`
 * - A `data: [DONE]` or empty line signals the end
 */
function parseGeminiSSELine(line) {
    if (!line.startsWith('data: '))
        return null;
    const data = line.slice(6).trim();
    if (!data || data === '[DONE]')
        return null;
    try {
        const parsed = JSON.parse(data);
        return parsed?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    }
    catch {
        return null;
    }
}
/**
 * Google Gemini Adapter (free tier)
 * Connects to Google Gemini API
 */
export class GeminiAdapter {
    name = 'Google Gemini';
    config;
    constructor(config) {
        this.config = config;
    }
    async generate(prompt, options) {
        const apiKey = this.config.apiKey;
        if (!apiKey) {
            throw new Error('Google Gemini API key is not configured. Set GEMINI_API_KEY env var.');
        }
        const model = options?.model || this.config.model || 'gemini-2.0-flash-exp';
        const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
        const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 8192;
        logger.debug(`Gemini: Generating with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);
        const url = `${GEMINI_BASE_URL}/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature,
                    maxOutputTokens: maxTokens,
                },
            }),
        });
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Gemini API error (${response.status}): ${errorBody}`);
        }
        const data = (await response.json());
        const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        // Track cost
        try {
            getCostTracker().recordCallEstimated('gemini', model, prompt, content);
        }
        catch { /* Non-critical */ }
        return content;
    }
    async generateStream(prompt, options, onToken) {
        const apiKey = this.config.apiKey;
        if (!apiKey) {
            throw new Error('Google Gemini API key is not configured. Set GEMINI_API_KEY env var.');
        }
        const model = options?.model || this.config.model || 'gemini-2.0-flash-exp';
        const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
        const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 8192;
        logger.debug(`Gemini: Streaming with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);
        // Use Gemini's streamGenerateContent endpoint
        const url = `${GEMINI_BASE_URL}/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature,
                    maxOutputTokens: maxTokens,
                },
            }),
        });
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Gemini streaming API error (${response.status}): ${errorBody}`);
        }
        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('Gemini response body is not readable');
        }
        const decoder = new TextDecoder();
        const fullContent = [];
        let buffer = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                // Process complete lines from the buffer
                const lines = buffer.split('\n');
                // Keep the last (potentially incomplete) line in the buffer
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed)
                        continue;
                    const token = parseGeminiSSELine(trimmed);
                    if (token) {
                        fullContent.push(token);
                        onToken(token);
                    }
                }
            }
            // Process remaining buffer
            const remaining = buffer.trim();
            if (remaining) {
                const token = parseGeminiSSELine(remaining);
                if (token) {
                    fullContent.push(token);
                    onToken(token);
                }
            }
        }
        finally {
            reader.releaseLock();
        }
        const content = fullContent.join('');
        // Track cost for streaming response
        try {
            getCostTracker().recordCallEstimated('gemini', model, prompt, content);
        }
        catch { /* Non-critical */ }
        return content;
    }
    async isAvailable() {
        return !!this.config.apiKey;
    }
    getInfo() {
        return `Provider: Google Gemini\nModel: ${this.config.model || 'default'}\nStatus: ${this.config.apiKey ? '✅ Configured' : '❌ Missing API key'}`;
    }
    async listModels() {
        const apiKey = this.config.apiKey;
        if (!apiKey)
            return [];
        try {
            const response = await fetch(`${GEMINI_BASE_URL}?key=${apiKey}`);
            if (!response.ok)
                return [];
            const data = (await response.json());
            return (data.models || []).map((m) => {
                const id = m.name.replace('models/', '');
                return {
                    id,
                    name: m.displayName || id,
                    provider: 'gemini',
                    description: m.description,
                    tags: getModelTags(id),
                };
            });
        }
        catch {
            return [];
        }
    }
}
//# sourceMappingURL=gemini-adapter.js.map