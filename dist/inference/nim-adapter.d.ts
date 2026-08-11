import { InferenceProvider, ModelDescriptor, ToolCallResponse, ToolMessage, ToolSchema } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
/**
 * NVIDIA NIM Adapter
 * Connects to NVIDIA NIM OpenAI-compatible API
 */
export declare class NIMAdapter implements InferenceProvider {
    readonly name = "NVIDIA NIM";
    private config;
    constructor(config: ProviderConfig);
    generate(prompt: string, options?: InferenceOptions): Promise<string>;
    /** H1 — native tool-calling via the OpenAI `tools` protocol. */
    generateTools(messages: ToolMessage[], tools: ToolSchema[], options?: InferenceOptions): Promise<ToolCallResponse>;
    generateStream(prompt: string, options: InferenceOptions | undefined, onToken: (token: string) => void): Promise<string>;
    isAvailable(): Promise<boolean>;
    getInfo(): string;
    listModels(): Promise<ModelDescriptor[]>;
}
//# sourceMappingURL=nim-adapter.d.ts.map