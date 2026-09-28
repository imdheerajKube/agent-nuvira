/**
 * NeuTTS Synthesis — text-to-speech.
 *
 * Hermes equivalent: neutts_synth.py (110 lines)
 *
 * Provides:
 * - API-backed synthesis when NEUTTS_API_KEY (or an injected key) is set
 * - Multiple voice options
 * - Audio file output
 *
 * WHEN NO BACKEND IS CONFIGURED it does NOT fall back to writing audio: the old
 * fallback wrote a valid, silent WAV (44-byte header + a zeroed sample buffer) and
 * returned it as a successful synthesis with duration/voice/text metadata. Anything
 * downstream — a gateway that sends the file, an agent that reports "the audio is
 * ready" — then acted on silence that looked like speech. Silence is now an
 * explicit opt-in (BUFF_NEUTTS_ALLOW_SILENT) and never the default.
 *
 * See TOOL_TRUTHFULNESS_TRACKER.md finding #5.
 */

import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logger } from '../utils/logger.js';
import { envBuff } from '../config/paths.js';
import { refusalFields, type ToolRefusal } from './tool-refusal.js';

/**
 * Whether a silent placeholder WAV may stand in for speech. Opt-in only
 * (`BUFF_NEUTTS_ALLOW_SILENT=1`) — the point of the refusal is that silence must
 * never be mistaken for synthesis. Exported for tests.
 */
export function allowSilentFallback(): boolean {
  const v = envBuff('NEUTTS_ALLOW_SILENT');
  return v === '1' || v === 'true' || v === 'yes';
}

// ─── Types ────────────────────────────────────────────────────────────────

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
  ok: boolean;
  /**
   * True when the audio is a silent placeholder rather than synthesised speech.
   * Only ever set behind the BUFF_NEUTTS_ALLOW_SILENT opt-in.
   */
  silent?: boolean;
  code?: ToolRefusal['code'];
  alternatives?: string[];
  error?: string;
}

// ─── NeuTTS Synthesizer ──────────────────────────────────────────────────

export class NeuTTSSynthesizer {
  private config: NeuTTSConfig;
  private outputDir: string;

  constructor(config: NeuTTSConfig = {}) {
    this.config = {
      apiKey: config.apiKey || process.env.NEUTTS_API_KEY || '',
      defaultVoice: config.defaultVoice || 'default',
    };
    this.outputDir = config.outputDir || join(tmpdir(), 'nuvira-tts');
  }

  /**
   * Synthesize text to speech.
   */
  async synthesize(
    text: string,
    options: { voice?: string; speed?: number; pitch?: number; format?: string } = {},
  ): Promise<SynthesisResult> {
    const id = randomUUID();
    const voice = options.voice || this.config.defaultVoice!;
    const format = options.format || 'wav';
    const audioPath = join(this.outputDir, `${id}.${format}`);

    // 1. The real backend, when one is configured.
    let failureReason = 'No NeuTTS API key is configured (NEUTTS_API_KEY).';
    if (this.config.apiKey) {
      try {
        return await this.synthesizeViaAPI(text, voice, audioPath, options);
      } catch (err) {
        failureReason = `NeuTTS API synthesis failed: ${err instanceof Error ? err.message : String(err)}`;
        logger.warn(`[neutts] ${failureReason}`);
      }
    }

    // 2. No real audio. Write a silent placeholder ONLY when the operator asked for
    //    it — a silent WAV reported as a successful synthesis is a lie the caller
    //    cannot detect, so it is never the default.
    if (allowSilentFallback()) {
      logger.warn(`[neutts] writing SILENT placeholder audio (BUFF_NEUTTS_ALLOW_SILENT is set) — ${failureReason}`);
      return this.synthesizeLocal(text, voice, audioPath, options);
    }

    // 3. Refuse: say what is missing and what to use instead.
    const reason = `No speech was synthesised. ${failureReason}`;
    logger.warn(`[neutts] synthesis refused — ${failureReason}`);
    return {
      id,
      audioPath: '',
      durationMs: 0,
      voice,
      text,
      ok: false,
      error: reason,
      ...refusalFields('not_configured', [
        'Set NEUTTS_API_KEY to enable API-backed synthesis',
        'Use the `speak` tool — it uses the configured local TTS backend (piper) when available',
      ]),
    };
  }

  /**
   * Synthesize via external API.
   */
  private async synthesizeViaAPI(
    text: string,
    voice: string,
    audioPath: string,
    options: { speed?: number; pitch?: number },
  ): Promise<SynthesisResult> {
    const response = await fetch('https://api.neutts.com/v1/synthesize', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        voice,
        speed: options.speed || 1.0,
        pitch: options.pitch || 1.0,
        format: 'wav',
      }),
    });

    if (!response.ok) {
      throw new Error(`NeuTTS API error: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    await writeFile(audioPath, Buffer.from(buffer));

    return {
      id: randomUUID(),
      audioPath,
      durationMs: Math.round((buffer.byteLength / (16000 * 2)) * 1000),
      voice,
      text,
      ok: true,
    };
  }

  /**
   * Local synthesis fallback (generates silent audio).
   */
  private async synthesizeLocal(
    text: string,
    voice: string,
    audioPath: string,
    options: { speed?: number },
  ): Promise<SynthesisResult> {
    // Generate a minimal WAV file (silent)
    const sampleRate = 16000;
    const durationSec = Math.max(0.5, text.length * 0.05); // Rough estimate
    const numSamples = Math.floor(sampleRate * durationSec);

    // WAV header + silent data
    const buffer = Buffer.alloc(44 + numSamples * 2);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + numSamples * 2, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(1, 22); // Mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(numSamples * 2, 40);

    await writeFile(audioPath, buffer);

    return {
      id: randomUUID(),
      audioPath,
      durationMs: Math.round(durationSec * 1000),
      voice,
      text,
      ok: true,
      // Flagged so a caller (or the user) can see the file is silence, not speech.
      silent: true,
    };
  }

  /**
   * List available voices.
   */
  async listVoices(): Promise<Array<{ id: string; name: string; language: string }>> {
    if (this.config.apiKey) {
      try {
        const response = await fetch('https://api.neutts.com/v1/voices', {
          headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
        });
        if (response.ok) {
          return await response.json() as Array<{ id: string; name: string; language: string }>;
        }
      } catch {
        // Ignore
      }
    }

    // No backend → no voices. This used to return three invented voice ids
    // ('default', 'female-1', 'male-1') that no configured backend could honour, so
    // a caller could pick one and only discover it was fictitious after synthesis.
    return [];
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _neuttsSynth: NeuTTSSynthesizer | null = null;

export function getNeuTTSSynthesizer(config?: NeuTTSConfig): NeuTTSSynthesizer {
  if (!_neuttsSynth || config) _neuttsSynth = new NeuTTSSynthesizer(config);
  return _neuttsSynth;
}

export function resetNeuTTSSynthesizer(): void {
  _neuttsSynth = null;
}
