import { InferenceProvider, ModelDescriptor } from './interface.js';
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
    isAvailable(): Promise<boolean>;
    getInfo(): string;
    listModels(): Promise<ModelDescriptor[]>;
}
//# sourceMappingURL=gemini-adapter.d.ts.map