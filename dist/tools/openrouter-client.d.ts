/**
 * openrouter_client — Multi-LLM routing via OpenRouter.
 *
 * Routes LLM calls to multiple providers (OpenAI, Anthropic, Google, etc.)
 * for cost optimization and fallback.
 *
 * Features:
 * - Multi-provider routing
 * - Cost optimization
 * - Automatic fallback
 * - Usage tracking
 */
interface OpenRouterConfig {
    apiKey?: string;
    baseUrl?: string;
    defaultModel?: string;
}
interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
interface ChatCompletion {
    id: string;
    model: string;
    content: string;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    cost?: number;
    latencyMs: number;
}
interface ModelInfo {
    id: string;
    name: string;
    pricing: {
        prompt: number;
        completion: number;
    };
    context_length: number;
    provider: string;
}
declare class OpenRouterClient {
    private apiKey;
    private baseUrl;
    private defaultModel;
    private usageHistory;
    constructor(config?: OpenRouterConfig);
    /**
     * Send a chat completion request.
     */
    chat(messages: ChatMessage[], options?: {
        model?: string;
        maxTokens?: number;
        temperature?: number;
        stream?: boolean;
    }): Promise<ChatCompletion>;
    /**
     * List available models.
     */
    listModels(): Promise<ModelInfo[]>;
    /**
     * Get cost estimate for a model.
     */
    estimateCost(model: string, usage: {
        prompt_tokens: number;
        completion_tokens: number;
    }): number;
    /**
     * Get usage statistics.
     */
    getStats(): {
        totalRequests: number;
        totalTokens: number;
        totalCost: number;
        avgLatencyMs: number;
        byModel: Record<string, {
            requests: number;
            tokens: number;
            cost: number;
        }>;
    };
    /**
     * HTTP request helper.
     */
    private request;
}
export declare function getOpenRouterClient(config?: OpenRouterConfig): OpenRouterClient;
export { OpenRouterClient };
//# sourceMappingURL=openrouter-client.d.ts.map