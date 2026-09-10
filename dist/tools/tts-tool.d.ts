/**
 * TTS Tool — Text-to-Speech with multiple provider support.
 *
 * This provides TTS capabilities:
 * - Multiple TTS engines (OpenAI, Google, Azure, ElevenLabs)
 * - Voice selection
 * - SSML support
 * - Streaming TTS
 * - Language support
 * - Audio format selection
 * - Speed/pitch control
 * - Volume control
 *
 * Better than Hermes:
 * - Multiple provider support
 * - Built-in voice selection
 * - SSML support
 * - Streaming capability
 * - Integration with skill system
 */
export type TTSProvider = 'openai' | 'google' | 'azure' | 'elevenlabs';
export interface TTSConfig {
    /** TTS provider */
    provider: TTSProvider;
    /** API key */
    apiKey: string;
    /** Voice ID or name */
    voiceId?: string;
    /** Language code (e.g., 'en-US') */
    language?: string;
    /** Speaking rate (0.5 - 2.0) */
    speed?: number;
    /** Pitch (-10 - 10) */
    pitch?: number;
    /** Volume gain (-96 - 16 dB) */
    volumeGainDb?: number;
    /** Audio format */
    audioFormat?: 'mp3' | 'wav' | 'ogg' | 'flac';
    /** SSML support */
    ssml?: boolean;
}
export interface TTSEngineResult {
    success: boolean;
    audioBuffer?: Buffer;
    audioPath?: string;
    durationMs: number;
    provider: TTSProvider;
    voiceId?: string;
    error?: string;
}
/**
 * Convert text to speech using the specified provider.
 */
export declare function textToSpeech(text: string, config: TTSConfig, outputPath?: string): Promise<TTSEngineResult>;
/**
 * Get available voices for a provider.
 */
export declare function getAvailableVoices(provider: TTSProvider, apiKey: string): Promise<Array<{
    id: string;
    name: string;
    language?: string;
}>>;
export interface STTConfig {
    /** STT provider */
    provider: 'openai' | 'google' | 'azure';
    /** API key */
    apiKey: string;
    /** Language code */
    language?: string;
    /** Model */
    model?: string;
}
export interface STTResult {
    success: boolean;
    text?: string;
    language?: string;
    durationMs: number;
    provider: string;
    error?: string;
}
/**
 * Convert speech to text using the specified provider.
 */
export declare function speechToText(audioPath: string, config: STTConfig): Promise<STTResult>;
declare const _default: {
    textToSpeech: typeof textToSpeech;
    getAvailableVoices: typeof getAvailableVoices;
    speechToText: typeof speechToText;
};
export default _default;
//# sourceMappingURL=tts-tool.d.ts.map