import { InferenceProvider, ModelDescriptor } from './interface.js';
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
    generateStream(prompt: string, options: InferenceOptions | undefined, onToken: (token: string) => void): Promise<string>;
    isAvailable(): Promise<boolean>;
    getInfo(): string;
    listModels(): Promise<ModelDescriptor[]>;
}
//# sourceMappingURL=nim-adapter.d.ts.map