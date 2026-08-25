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

import { execFileSync } from 'node:child_process';
import { envBuff } from '../../config/paths';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeArtifact, safeArtifactName, binaryOnPath, fileExists, cleanupTemp } from './shared.js';

// ─── Availability ───────────────────────────────────────────────────────────

/** True when ANY TTS backend binary is on PATH. */
export function isTtsAvailable(): boolean {
  return binaryOnPath('edge-tts') || binaryOnPath('piper');
}

/** True when ANY transcription backend binary is on PATH. */
export function isTranscribeAvailable(): boolean {
  return binaryOnPath('whisper') || binaryOnPath('whisper-cli');
}

/**
 * Test hook — force backend availability without a binary on PATH.
 * `tts: 'edge-tts' | 'piper' | true | null` — a string selects the backend,
 * true means "edge-tts available" (branch selection honors the override),
 * null resets to probing. `transcribe` is a boolean or null.
 */
export function setVoiceBackendOverride(tts: 'edge-tts' | 'piper' | boolean | null, transcribe: boolean | null): void {
  _ttsOverride = tts;
  _transcribeOverride = transcribe;
}

let _ttsOverride: 'edge-tts' | 'piper' | boolean | null = null;
let _transcribeOverride: boolean | null = null;

/** True when the override (or probe) prefers edge-tts (`true` = edge-tts). */
function useEdgeTts(): boolean {
  return _ttsOverride === 'edge-tts' || _ttsOverride === true || (_ttsOverride === null && binaryOnPath('edge-tts'));
}

/** True when the override (or probe) prefers piper. */
function usePiper(): boolean {
  return _ttsOverride === 'piper' || (_ttsOverride === null && !binaryOnPath('edge-tts') && binaryOnPath('piper'));
}

/** Resolve availability honoring the test override (string overrides = available). */
function effectiveTts(): boolean {
  return _ttsOverride === null ? isTtsAvailable() : Boolean(_ttsOverride);
}

function effectiveTranscribe(): boolean {
  return _transcribeOverride ?? isTranscribeAvailable();
}

// ─── TTS ────────────────────────────────────────────────────────────────────

export interface SpeakOptions {
  /** edge-tts voice (default en-US-AriaNeural). */
  voice?: string;
  /** Piper model path (used when edge-tts is absent but piper exists). */
  piperModel?: string;
  cwd?: string;
}

/** Injectable exec for tests. */
export type ExecFn = (cmd: string, args: string[], opts: { timeout?: number; input?: string }) => string;

/** Default exec — real subprocess (input piped for stdin readers like piper). */
function defaultExec(cmd: string, args: string[], opts: { timeout?: number; input?: string }): string {
  return execFileSync(cmd, args, {
    encoding: 'utf-8',
    timeout: opts.timeout ?? 30000,
    stdio: 'pipe',
    input: opts.input,
  });
}

/**
 * Synthesize speech for text → sandbox audio/*.mp3 (edge-tts) or *.wav
 * (piper). Returns the artifact path or a descriptive error. Never throws.
 */
export async function speak(
  text: string,
  opts: SpeakOptions = {},
  exec: ExecFn = defaultExec,
): Promise<{ ok: boolean; file?: string; error?: string }> {
  if (!effectiveTts()) {
    return {
      ok: false,
      error: 'voice: no TTS backend — install edge-tts (pip install edge-tts) or Piper, then retry.',
    };
  }
  try {
    if (useEdgeTts()) {
      const out = join(process.env.TMPDIR || '/tmp', `${safeArtifactName('tts', '.mp3')}`);
      exec('edge-tts', ['--voice', opts.voice ?? 'en-US-AriaNeural', '--text', text, '--write-media', out], { timeout: 60000 });
      const file = writeArtifact('audio', safeArtifactName('speech', '.mp3'), readFileSync(out), opts.cwd);
      cleanupTemp(out);
      return { ok: true, file };
    }
    // Piper fallback — piper reads the text on STDIN.
    if (!usePiper()) {
      return { ok: false, error: 'voice: piper needs BUFF_PIPER_MODEL (path to a .onnx voice)' };
    }
    const model = opts.piperModel || envBuff('PIPER_MODEL');
    if (!model) return { ok: false, error: 'voice: piper needs BUFF_PIPER_MODEL (path to a .onnx voice)' };
    const out = join(process.env.TMPDIR || '/tmp', `${safeArtifactName('tts', '.wav')}`);
    exec('piper', ['-m', model, '--output_file', out], { timeout: 60000, input: text });
    const file = writeArtifact('audio', safeArtifactName('speech', '.wav'), readFileSync(out), opts.cwd);
    cleanupTemp(out);
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Transcription ──────────────────────────────────────────────────────────

export interface TranscribeOptions {
  /** whisper model (default base). */
  model?: string;
  cwd?: string;
}

/**
 * Transcribe an audio file with whisper.cpp. Returns the transcript or a
 * descriptive error. Never throws.
 */
export async function transcribe(
  audioPath: string,
  opts: TranscribeOptions = {},
  exec: ExecFn = defaultExec,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!fileExists(audioPath)) {
    return { ok: false, error: `voice: audio file not found: ${audioPath}` };
  }
  if (!effectiveTranscribe()) {
    return {
      ok: false,
      error: 'voice: no transcription backend — install whisper.cpp (or faster-whisper) and add it to PATH.',
    };
  }
  const audioDir = join(process.env.TMPDIR || '/tmp');
  const txtOut = join(audioDir, `${safeArtifactName('whisper', '.txt')}`);
  try {
    const model = opts.model ?? 'base';
    // whisper.cpp writes the transcript to a .txt file with -otxt — it does
    // NOT print it to stdout. Read the generated file; fall back to stdout.
    let out: string;
    if (_transcribeOverride === true || binaryOnPath('whisper')) {
      // whisper.cpp: -f is the AUDIO INPUT flag; -of sets the output base name.
      out = exec('whisper', ['-m', model, '-f', audioPath, '-otxt', '-of', txtOut.replace(/\.txt$/, '')], { timeout: 120000 });
    } else {
      // whisper-cli (newer whisper.cpp builds): same -f/-otxt/-of semantics.
      out = exec('whisper-cli', ['-m', `${model}.bin`, '-f', audioPath, '-otxt', '-of', txtOut.replace(/\.txt$/, '')], { timeout: 120000 });
    }
    // Transcript lives in the generated file (or stdout line as a fallback).
    const fromFile = existsSync(txtOut) ? readFileSync(txtOut, 'utf-8').trim() : '';
    const text = fromFile || out.trim() || '(no transcript produced)';
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    cleanupTemp(txtOut);
  }
}
