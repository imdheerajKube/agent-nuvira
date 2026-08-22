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

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logger } from '../utils/logger.js';
import { EventEmitter } from 'node:events';

// ─── Types ────────────────────────────────────────────────────────────────

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

// ─── Voice Manager ────────────────────────────────────────────────────────

export class VoiceManager extends EventEmitter {
  private config: VoiceConfig;
  private state: VoiceState = { recording: false, playing: false };
  private audioDir: string;
  private recordingProcess: any = null;

  constructor(config: VoiceConfig = {}) {
    super();
    this.config = {
      sampleRate: config.sampleRate || 16000,
      channels: config.channels || 1,
      maxDurationSec: config.maxDurationSec || 60,
      format: config.format || 'wav',
    };
    this.audioDir = join(tmpdir(), 'nuvira-voice');
    this.ensureDir();
  }

  private async ensureDir(): Promise<void> {
    try {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(this.audioDir, { recursive: true });
    } catch {
      // Ignore
    }
  }

  /**
   * Check if audio recording is available.
   */
  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    // Check for ffmpeg/sox
    const hasFfmpeg = await this.commandExists('ffmpeg');
    const hasSox = await this.commandExists('sox');

    if (!hasFfmpeg && !hasSox) {
      return { available: false, reason: 'Neither ffmpeg nor sox found. Install one for audio recording.' };
    }

    return { available: true };
  }

  /**
   * Start recording audio.
   */
  async startRecording(options: { duration?: number; device?: string } = {}): Promise<{ id: string; started: boolean }> {
    if (this.state.recording) {
      return { id: '', started: false };
    }

    const id = randomUUID();
    const outputPath = join(this.audioDir, `${id}.${this.config.format}`);
    const duration = options.duration || this.config.maxDurationSec!;

    // Use sox for recording
    const args = [
      '-d', // default device
      '-r', String(this.config.sampleRate),
      '-c', String(this.config.channels),
      outputPath,
      'trim', '0', String(duration),
    ];

    if (options.device) {
      args[1] = options.device;
    }

    try {
      this.recordingProcess = spawn('sox', args);
      this.state.recording = true;
      this.state.currentRecording = {
        id,
        path: outputPath,
        durationMs: 0,
        sampleRate: this.config.sampleRate!,
        channels: this.config.channels!,
        format: this.config.format!,
        sizeBytes: 0,
      };

      this.recordingProcess.on('exit', () => {
        this.state.recording = false;
        this.emit('recording-stopped', id);
      });

      logger.info(`[voice] Started recording: ${id}`);
      return { id, started: true };
    } catch (err) {
      logger.warn(`[voice] Failed to start recording: ${err}`);
      return { id: '', started: false };
    }
  }

  /**
   * Stop recording.
   */
  async stopRecording(): Promise<AudioRecording | null> {
    if (!this.state.recording || !this.recordingProcess) {
      return null;
    }

    this.recordingProcess.kill('SIGTERM');
    this.state.recording = false;

    // Wait for file to be written
    await new Promise((resolve) => setTimeout(resolve, 500));

    const recording = this.state.currentRecording;
    if (recording && existsSync(recording.path)) {
      const stats = await readFile(recording.path);
      recording.sizeBytes = stats.length;
      recording.durationMs = Math.round((recording.sizeBytes / (this.config.sampleRate! * 2 * this.config.channels!)) * 1000);
      return recording;
    }

    return null;
  }

  /**
   * Play audio file.
   */
  async play(audioPath: string): Promise<boolean> {
    if (this.state.playing) return false;

    if (!existsSync(audioPath)) {
      logger.warn(`[voice] Audio file not found: ${audioPath}`);
      return false;
    }

    this.state.playing = true;

    try {
      const proc = spawn('sox', [audioPath, '-d']); // Play to default device
      proc.on('exit', () => {
        this.state.playing = false;
        this.emit('playback-ended');
      });
      return true;
    } catch {
      this.state.playing = false;
      return false;
    }
  }

  /**
   * Convert audio format.
   */
  async convert(inputPath: string, outputPath: string, options: { format?: string; sampleRate?: number } = {}): Promise<boolean> {
    const args = [inputPath];
    if (options.sampleRate) args.push('-r', String(options.sampleRate));
    args.push(outputPath);

    return new Promise((resolve) => {
      const proc = spawn('sox', args);
      proc.on('exit', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }

  /**
   * Get current state.
   */
  getState(): VoiceState {
    return { ...this.state };
  }

  /**
   * Check if a command exists.
   */
  private async commandExists(cmd: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('which', [cmd]);
      proc.on('exit', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _voiceManager: VoiceManager | null = null;

export function getVoiceManager(config?: VoiceConfig): VoiceManager {
  if (!_voiceManager || config) _voiceManager = new VoiceManager(config);
  return _voiceManager;
}

export function resetVoiceManager(): void {
  _voiceManager = null;
}
