/**
 * NeuTTS Synthesis — High-quality text-to-speech.
 *
 * Hermes equivalent: neutts_synth.py (110 lines)
 *
 * Provides:
 * - High-quality TTS synthesis
 * - Multiple voice options
 * - SSML support
 * - Audio file output
 */
export interface NeuTTSConfig {
    /** API key for NeuTTS */
    apiKey?: string;
    /** Default voice */
    defaultVoice?: string;
    /** Output directory */
    outputDir?: string;
}
export interface SynthesisResult {
    id: string;
    audioPath: string;
    durationMs: number;
    voice: string;
    text: string;
}
export declare class NeuTTSSynthesizer {
    private config;
    private outputDir;
    constructor(config?: NeuTTSConfig);
    /**
     * Synthesize text to speech.
     */
    synthesize(text: string, options?: {
        voice?: string;
        speed?: number;
        pitch?: number;
        format?: string;
    }): Promise<SynthesisResult>;
    /**
     * Synthesize via external API.
     */
    private synthesizeViaAPI;
    /**
     * Local synthesis fallback (generates silent audio).
     */
    private synthesizeLocal;
    /**
     * List available voices.
     */
    listVoices(): Promise<Array<{
        id: string;
        name: string;
        language: string;
    }>>;
}
export declare function getNeuTTSSynthesizer(config?: NeuTTSConfig): NeuTTSSynthesizer;
export declare function resetNeuTTSSynthesizer(): void;
//# sourceMappingURL=neutts-synth.d.ts.map