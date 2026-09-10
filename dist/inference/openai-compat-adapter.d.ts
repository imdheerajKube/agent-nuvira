/**
 * OpenAICompatAdapter — the generic OpenAI-compatible /v1 adapter (Issue 001).
 *
 * A single adapter serves EVERY catalog provider that speaks the OpenAI
 * `/v1/chat/completions` protocol: OpenAI, Mistral, Together, DeepInfra,
 * Fireworks, Perplexity, Azure OpenAI, LM Studio, Anyscale, vLLM/TGI,
 * DeepSeek, xAI, Replicate, the Nuvira gateway, OpenRouter, Groq, NIM — any
 * endpoint with a base URL + optional key. Provider-specific differences are
 * metadata, not code:
 *
 *   - baseUrl          — default endpoint (config.baseUrl overrides)
 *   - apiKeyHeader     — 'Authorization' (Bearer) or 'api-key' (Azure)
 *   - apiVersionQuery  — extra query string (Azure `api-version=...`)
 *   - providerId       — stable id used for cost tracking / reasoning cache
 *   - label            — display name
 *   - keyless          — no key needed (local runners, gateways)
 *
 * The behavior contract is inherited from the Nuvira Gateway adapter: shared
 * error-message classification (401/403→auth, 429→rate-limit, 5xx→server,
 * fetch→network, abort→timeout), wire-token cost metering (M2.2) when the
 * endpoint reports `usage`, reasoning caching (M4.2), and continuation retries
 * (M4.1) — so every OpenAI-compatible catalog provider learns through the SAME
 * failover/registry pipeline as the built-ins.
 */
import { InferenceProvider, ModelDescriptor, ToolCallResponse, ToolMessage, ToolSchema } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
/** Metadata that differentiates one OpenAI-compatible provider from another. */
export interface OpenAICompatMeta {
    /** Stable provider id (cost tracking, reasoning cache, registry). */
    providerId: string;
    /** Human label (adapter `name`). */
    label: string;
    /** Default base URL (config.baseUrl overrides). */
    defaultBaseUrl: string;
    /** Auth header name — 'Authorization' (Bearer) or 'api-key' (Azure). */
    apiKeyHeader?: string;
    /** Extra query string appended to request URLs (Azure api-version). */
    apiVersionQuery?: string;
    /** No API key needed (local runners / gateways). */
    keyless?: boolean;
    /**
     * Azure OpenAI shape: chat lives at `/openai/deployments/{model}/chat/completions`
     * and the model list at `/openai/models` (the model id IS the deployment
     * name). When set, request URLs use the deployments path instead of the
     * plain `/chat/completions` convention.
     */
    azureDeployments?: boolean;
}
export declare class OpenAICompatAdapter implements InferenceProvider {
    readonly name: string;
    private config;
    private baseUrl;
    private meta;
    constructor(config: ProviderConfig, meta: OpenAICompatMeta);
    generate(prompt: string, options?: InferenceOptions): Promise<string>;
    /** H1 — native tool-calling via the OpenAI `tools` protocol. */
    generateTools(messages: ToolMessage[], tools: ToolSchema[], options?: InferenceOptions): Promise<ToolCallResponse>;
    /**
     * P4 — streaming native tool-calling: same wire protocol as generateTools
     * with `stream: true`; content tokens delivered to onToken as they arrive.
     */
    generateToolsStream(messages: ToolMessage[], tools: ToolSchema[], options: InferenceOptions | undefined, onToken: (token: string) => void): Promise<ToolCallResponse>;
    generateStream(prompt: string, options: InferenceOptions | undefined, onToken: (token: string) => void): Promise<string>;
    isAvailable(): Promise<boolean>;
    getInfo(): string;
    listModels(): Promise<ModelDescriptor[]>;
}
//# sourceMappingURL=openai-compat-adapter.d.ts.map