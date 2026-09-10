/**
 * I4 — Voice pack (text-to-speech + speech-to-text via optional backends).
 *
 *   speak(text)        → edge-tts (Microsoft free edge voices) or Piper TTS.
 *   transcribe(audio)  → whisper.cpp or faster-whisper (local, free).
 *
 * All backends are OPTIONAL installs — `isAvailable()` probes the binary on
 * PATH (edge-tts / piper / whisper) and the tool degrades gracefully. Audio
 * outputs are written to the sandbox `audio/` artifact dir. Command execution
 * is injectable so tests run without the binaries.
 */
/** True when ANY TTS backend binary is on PATH. */
export declare function isTtsAvailable(): boolean;
/** True when ANY transcription backend binary is on PATH. */
export declare function isTranscribeAvailable(): boolean;
/**
 * Test hook — force backend availability without a binary on PATH.
 * `tts: 'edge-tts' | 'piper' | true | null` — a string selects the backend,
 * true means "edge-tts available" (branch selection honors the override),
 * null resets to probing. `transcribe` is a boolean or null.
 */
export declare function setVoiceBackendOverride(tts: 'edge-tts' | 'piper' | boolean | null, transcribe: boolean | null): void;
export interface SpeakOptions {
    /** edge-tts voice (default en-US-AriaNeural). */
    voice?: string;
    /** Piper model path (used when edge-tts is absent but piper exists). */
    piperModel?: string;
    cwd?: string;
}
/** Injectable exec for tests. */
export type ExecFn = (cmd: string, args: string[], opts: {
    timeout?: number;
    input?: string;
}) => string;
/**
 * Synthesize speech for text → sandbox audio/*.mp3 (edge-tts) or *.wav
 * (piper). Returns the artifact path or a descriptive error. Never throws.
 */
export declare function speak(text: string, opts?: SpeakOptions, exec?: ExecFn): Promise<{
    ok: boolean;
    file?: string;
    error?: string;
}>;
export interface TranscribeOptions {
    /** whisper model (default base). */
    model?: string;
    cwd?: string;
}
/**
 * Transcribe an audio file with whisper.cpp. Returns the transcript or a
 * descriptive error. Never throws.
 */
export declare function transcribe(audioPath: string, opts?: TranscribeOptions, exec?: ExecFn): Promise<{
    ok: boolean;
    text?: string;
    error?: string;
}>;
//# sourceMappingURL=voice.d.ts.map