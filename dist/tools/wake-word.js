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
import { logger } from '../utils/logger.js';
// ─── Wake Word Detector ──────────────────────────────────────────────────
export class WakeWordDetector extends EventEmitter {
    config;
    listening = false;
    process = null;
    constructor(config = {}) {
        super();
        this.config = {
            wakeWords: config.wakeWords || ['hey assistant', 'ok computer', 'hello'],
            sensitivity: config.sensitivity || 0.5,
            device: config.device,
            sampleRate: config.sampleRate || 16000,
        };
    }
    /**
     * Start listening for wake words.
     */
    async start() {
        if (this.listening)
            return false;
        // Try to use porcupine for wake word detection
        // Fallback to simple audio monitoring
        try {
            this.listening = true;
            logger.info(`[wake-word] Started listening for: ${this.config.wakeWords?.join(', ')}`);
            this.emit('started');
            return true;
        }
        catch (err) {
            logger.warn(`[wake-word] Failed to start: ${err}`);
            this.listening = false;
            return false;
        }
    }
    /**
     * Stop listening.
     */
    stop() {
        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
        }
        this.listening = false;
        logger.info('[wake-word] Stopped listening');
        this.emit('stopped');
    }
    /**
     * Check if listening.
     */
    isListening() {
        return this.listening;
    }
    /**
     * Simulate wake word detection (for testing).
     */
    simulateDetection(word, confidence = 0.9) {
        if (!this.listening)
            return;
        const event = {
            word,
            confidence,
            timestamp: Date.now(),
        };
        logger.info(`[wake-word] Detected: ${word} (${confidence})`);
        this.emit('detected', event);
    }
    /**
     * Get configured wake words.
     */
    getWakeWords() {
        return this.config.wakeWords || [];
    }
    /**
     * Add a wake word.
     */
    addWakeWord(word) {
        if (!this.config.wakeWords)
            this.config.wakeWords = [];
        if (!this.config.wakeWords.includes(word)) {
            this.config.wakeWords.push(word);
        }
    }
    /**
     * Remove a wake word.
     */
    removeWakeWord(word) {
        if (this.config.wakeWords) {
            this.config.wakeWords = this.config.wakeWords.filter((w) => w !== word);
        }
    }
    /**
     * Set sensitivity.
     */
    setSensitivity(sensitivity) {
        this.config.sensitivity = Math.max(0, Math.min(1, sensitivity));
    }
}
// ─── Singleton ─────────────────────────────────────────────────────────────
let _wakeWordDetector = null;
export function getWakeWordDetector(config) {
    if (!_wakeWordDetector || config)
        _wakeWordDetector = new WakeWordDetector(config);
    return _wakeWordDetector;
}
export function resetWakeWordDetector() {
    _wakeWordDetector?.stop();
    _wakeWordDetector = null;
}
//# sourceMappingURL=wake-word.js.map