/**
 * Voice Mode — Push-to-talk audio recording and playback.
 *
 * Hermes equivalent: voice_mode.py (2,308 lines)
 *
 * Provides:
 * - Push-to-talk audio recording
 * - Audio playback
 * - Integration with TTS and transcription
 * - Voice activity detection
 * - Audio format conversion
 */
import { EventEmitter } from 'node:events';
export interface VoiceConfig {
    /** Sample rate in Hz */
    sampleRate?: number;
    /** Channels (1=mono, 2=stereo) */
    channels?: number;
    /** Max recording duration in seconds */
    maxDurationSec?: number;
    /** Audio format */
    format?: 'wav' | 'mp3' | 'ogg';
}
export interface AudioRecording {
    id: string;
    path: string;
    durationMs: number;
    sampleRate: number;
    channels: number;
    format: string;
    sizeBytes: number;
}
export interface VoiceState {
    recording: boolean;
    playing: boolean;
    currentRecording?: AudioRecording;
}
export declare class VoiceManager extends EventEmitter {
    private config;
    private state;
    private audioDir;
    private recordingProcess;
    constructor(config?: VoiceConfig);
    private ensureDir;
    /**
     * Check if audio recording is available.
     */
    isAvailable(): Promise<{
        available: boolean;
        reason?: string;
    }>;
    /**
     * Start recording audio.
     */
    startRecording(options?: {
        duration?: number;
        device?: string;
    }): Promise<{
        id: string;
        started: boolean;
    }>;
    /**
     * Stop recording.
     */
    stopRecording(): Promise<AudioRecording | null>;
    /**
     * Play audio file.
     */
    play(audioPath: string): Promise<boolean>;
    /**
     * Convert audio format.
     */
    convert(inputPath: string, outputPath: string, options?: {
        format?: string;
        sampleRate?: number;
    }): Promise<boolean>;
    /**
     * Get current state.
     */
    getState(): VoiceState;
    /**
     * Check if a command exists.
     */
    private commandExists;
}
export declare function getVoiceManager(config?: VoiceConfig): VoiceManager;
export declare function resetVoiceManager(): void;
//# sourceMappingURL=voice-mode.d.ts.map