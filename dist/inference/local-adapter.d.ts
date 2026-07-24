import { InferenceProvider, ModelDescriptor } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
/**
 * Local Model Adapter
 * Supports Ollama, Hugging Face Transformers, and GGML models
 */
export declare class LocalAdapter implements InferenceProvider {
    readonly name = "Local";
    private config;
    constructor(config: ProviderConfig);
    generate(prompt: string, options?: InferenceOptions): Promise<string>; /**
   * Generate using Ollama HTTP API
   */
    private generateOllama;
    /**
     * Stream tokens from Ollama's HTTP API using newline-delimited JSON.
     * Ollama's streaming format returns one JSON object per line with a `response` field.
     */
    private generateOllamaStream;
    /**
     * Generate using Hugging Face Transformers (via Python)
     * Requires transformers Python package to be installed
     */
    private generateHuggingFace;
    /**
     * Generate using a GGML model binary
     * Expects a path to a GGML-compatible model file or the llama.cpp binary
     */
    private generateGGML;
    generateStream(prompt: string, options: InferenceOptions | undefined, onToken: (token: string) => void): Promise<string>;
    isAvailable(): Promise<boolean>;
    getInfo(): string;
    listModels(): Promise<ModelDescriptor[]>;
}
//# sourceMappingURL=local-adapter.d.ts.map