import { InferenceProvider, ModelDescriptor } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
/**
 * OpenRouter Adapter
 * Routes requests through OpenRouter's multi-provider API
 */
export declare class OpenRouterAdapter implements InferenceProvider {
    readonly name = "OpenRouter";
    private config;
    constructor(config: ProviderConfig);
    generate(prompt: string, options?: InferenceOptions): Promise<string>;
    generateStream(prompt: string, options: InferenceOptions | undefined, onToken: (token: string) => void): Promise<string>;
    isAvailable(): Promise<boolean>;
    getInfo(): string;
    listModels(): Promise<ModelDescriptor[]>;
}
//# sourceMappingURL=openrouter-adapter.d.ts.map