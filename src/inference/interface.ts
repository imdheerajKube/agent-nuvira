import { InferenceOptions } from '../config/types.js';

/**
 * Unified inference provider interface.
 * All adapters (local, nim, gemini, openrouter) implement this.
 */
export interface InferenceProvider {
  /** Display name for the provider */
  readonly name: string;

  /**
   * Generate a completion for the given prompt.
   * Returns the generated text content.
   */
  generate(prompt: string, options?: InferenceOptions): Promise<string>;

  /**
   * Check if the provider is properly configured and available
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get a description of the current provider configuration
   */
  getInfo(): string;
}
