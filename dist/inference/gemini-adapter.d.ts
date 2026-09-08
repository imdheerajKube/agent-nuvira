import { InferenceProvider, ModelDescriptor } from './interface.js';
import type { ToolCallResponse, ToolMessage, ToolSchema } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
/**
 * Google Gemini Adapter (free tier)
 * Connects to Google Gemini API
 */
export declare class GeminiAdapter implements InferenceProvider {
    readonly name = "Google Gemini";
    private config;
    constructor(config: ProviderConfig);
    generate(prompt: string, options?: InferenceOptions): Promise<string>;
    generateStream(prompt: string, options: InferenceOptions | undefined, onToken: (token: string) => void): Promise<string>;
    generateTools(messages: ToolMessage[], tools: ToolSchema[], options?: InferenceOptions): Promise<ToolCallResponse>;
    /**
     * P4/Phase 1.2 — streaming native tool-calling: same protocol with
     * streamGenerateContent?alt=sse; content tokens stream to onToken, tool
     * calls accumulate across chunks and parse at stream end.
     */
    generateToolsStream(messages: ToolMessage[], tools: ToolSchema[], options: InferenceOptions | undefined, onToken: (token: string) => void): Promise<ToolCallResponse>;
    isAvailable(): Promise<boolean>;
    getInfo(): string;
    listModels(): Promise<ModelDescriptor[]>;
}
//# sourceMappingURL=gemini-adapter.d.ts.map