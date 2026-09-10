/**
 * tts_streaming — Provider-agnostic streaming TTS.
 *
 * Converts text to speech using various providers (ElevenLabs, OpenAI, Azure, etc.)
 * Supports streaming for real-time playback.
 *
 * Features:
 * - Multiple provider support
 * - Streaming audio output
 * - Voice selection
 * - Speed control
 * - Format selection (PCM, MP3, WAV)
 */
type TTSProvider = 'elevenlabs' | 'openai' | 'azure' | 'google' | 'edge-tts';
interface TTSResult {
    audio: Buffer | Uint8Array;
    format: string;
    duration?: number;
    provider: string;
}
interface TTSStreamChunk {
    audio: Buffer | Uint8Array;
    isFinal: boolean;
}
declare class TTSStreamingManager {
    private providers;
    private defaultProvider;
    constructor();
    /**
     * Synthesize text to speech.
     */
    synthesize(text: string, options?: {
        provider?: TTSProvider;
        voice?: string;
        speed?: number;
        format?: string;
    }): Promise<TTSResult>;
    /**
     * Stream text to speech.
     */
    stream(text: string, options?: {
        provider?: TTSProvider;
        voice?: string;
        speed?: number;
    }): Promise<ReadableStream<TTSStreamChunk>>;
    /**
     * List available providers.
     */
    listProviders(): string[];
    /**
     * Set default provider.
     */
    setDefaultProvider(provider: TTSProvider): void;
}
export declare function getTTSStreamingManager(): TTSStreamingManager;
export { TTSStreamingManager };
//# sourceMappingURL=tts-streaming.d.ts.map