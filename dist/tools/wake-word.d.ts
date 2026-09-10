/**
 * Wake Word Detection — Detect wake words for voice-activated interactions.
 *
 * Hermes equivalent: wake_word.py (1,464 lines)
 *
 * Provides:
 * - Wake word detection (configurable phrases)
 * - Continuous listening mode
 * - Integration with voice recording
 * - Sensitivity configuration
 * - Multiple wake word support
 */
import { EventEmitter } from 'node:events';
export interface WakeWordConfig {
    /** Wake word phrases to detect */
    wakeWords?: string[];
    /** Detection sensitivity (0.0 - 1.0) */
    sensitivity?: number;
    /** Audio device */
    device?: string;
    /** Sample rate */
    sampleRate?: number;
}
export interface WakeWordEvent {
    word: string;
    confidence: number;
    timestamp: number;
}
export declare class WakeWordDetector extends EventEmitter {
    private config;
    private listening;
    private process;
    constructor(config?: WakeWordConfig);
    /**
     * Start listening for wake words.
     */
    start(): Promise<boolean>;
    /**
     * Stop listening.
     */
    stop(): void;
    /**
     * Check if listening.
     */
    isListening(): boolean;
    /**
     * Simulate wake word detection (for testing).
     */
    simulateDetection(word: string, confidence?: number): void;
    /**
     * Get configured wake words.
     */
    getWakeWords(): string[];
    /**
     * Add a wake word.
     */
    addWakeWord(word: string): void;
    /**
     * Remove a wake word.
     */
    removeWakeWord(word: string): void;
    /**
     * Set sensitivity.
     */
    setSensitivity(sensitivity: number): void;
}
export declare function getWakeWordDetector(config?: WakeWordConfig): WakeWordDetector;
export declare function resetWakeWordDetector(): void;
//# sourceMappingURL=wake-word.d.ts.map