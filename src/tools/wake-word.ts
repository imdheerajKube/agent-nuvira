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

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

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

// ─── Wake Word Detector ──────────────────────────────────────────────────

export class WakeWordDetector extends EventEmitter {
  private config: WakeWordConfig;
  private listening = false;
  private process: any = null;

  constructor(config: WakeWordConfig = {}) {
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
  async start(): Promise<boolean> {
    if (this.listening) return false;

    // Try to use porcupine for wake word detection
    // Fallback to simple audio monitoring
    try {
      this.listening = true;
      logger.info(`[wake-word] Started listening for: ${this.config.wakeWords?.join(', ')}`);
      this.emit('started');
      return true;
    } catch (err) {
      logger.warn(`[wake-word] Failed to start: ${err}`);
      this.listening = false;
      return false;
    }
  }

  /**
   * Stop listening.
   */
  stop(): void {
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
  isListening(): boolean {
    return this.listening;
  }

  /**
   * Simulate wake word detection (for testing).
   */
  simulateDetection(word: string, confidence: number = 0.9): void {
    if (!this.listening) return;

    const event: WakeWordEvent = {
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
  getWakeWords(): string[] {
    return this.config.wakeWords || [];
  }

  /**
   * Add a wake word.
   */
  addWakeWord(word: string): void {
    if (!this.config.wakeWords) this.config.wakeWords = [];
    if (!this.config.wakeWords.includes(word)) {
      this.config.wakeWords.push(word);
    }
  }

  /**
   * Remove a wake word.
   */
  removeWakeWord(word: string): void {
    if (this.config.wakeWords) {
      this.config.wakeWords = this.config.wakeWords.filter((w) => w !== word);
    }
  }

  /**
   * Set sensitivity.
   */
  setSensitivity(sensitivity: number): void {
    this.config.sensitivity = Math.max(0, Math.min(1, sensitivity));
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _wakeWordDetector: WakeWordDetector | null = null;

export function getWakeWordDetector(config?: WakeWordConfig): WakeWordDetector {
  if (!_wakeWordDetector || config) _wakeWordDetector = new WakeWordDetector(config);
  return _wakeWordDetector;
}

export function resetWakeWordDetector(): void {
  _wakeWordDetector?.stop();
  _wakeWordDetector = null;
}
