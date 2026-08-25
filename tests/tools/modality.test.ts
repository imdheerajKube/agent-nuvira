/**
 * I2–I5 — Modality pack tests.
 *
 * All network/binaries are mocked or absent — no live browser, no image
 * endpoint, no TTS/whisper binaries in tests (plan acceptance: mocked backend,
 * availability gating). Artifacts go to a hermetic BUFF_ARTIFACTS_DIR.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const artDir = mkdtempSync(join(tmpdir(), 'buff-modality-art-'));

beforeAll(() => {
  process.env.NUVIRA_ARTIFACTS_DIR = artDir;
});

afterAll(() => {
  delete process.env.NUVIRA_ARTIFACTS_DIR;
  rmSync(artDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── I2 browser ─────────────────────────────────────────────────────────────

import {
  executeBrowserAction,
  isBrowserAvailable,
  resetBrowserAvailability,
  setBrowserAvailable,
} from '../../src/tools/modality/browser.js';

/** A minimal fake playwright Page. */
function fakePage(): any {
  const calls: string[] = [];
  return {
    calls,
    async goto(url: string) { calls.push(`goto:${url}`); },
    async click(sel: string) { calls.push(`click:${sel}`); },
    async fill(sel: string, text: string) { calls.push(`fill:${sel}:${text}`); },
    async textContent(sel: string) { calls.push(`text:${sel}`); return 'Fake page body text'; },
    async title() { return 'Fake Title'; },
    async content() { return '<html>fake</html>'; },
    url() { return 'https://example.com'; },
    async screenshot(opts: any) { return Buffer.from('PNG-DATA'); },
  };
}

describe('I2 browser', () => {
  it('availability probe is machine-independent (override false = unavailable)', () => {
    resetBrowserAvailability();
    setBrowserAvailable(false);
    expect(isBrowserAvailable()).toBe(false);
    setBrowserAvailable(null);
    resetBrowserAvailability();
  });

  it('open navigates and extracts page text', async () => {
    const page = fakePage();
    const result = await executeBrowserAction(page, 'open', { url: 'https://example.com' });
    expect(page.calls[0]).toBe('goto:https://example.com');
    expect(result.text).toContain('Fake page body text');
    expect(result.text).toContain('Fake Title');
  });

  it('open blocks private/loopback/metadata URLs (SSRF guard)', async () => {
    const page = fakePage();
    const orig = process.env.NUVIRA_WEB_ALLOW_PRIVATE;
    delete process.env.NUVIRA_WEB_ALLOW_PRIVATE;
    try {
      const blocked = await executeBrowserAction(page, 'open', { url: 'http://169.254.169.254/latest/meta-data' });
      expect(blocked.text).toContain('blocked');
      expect(page.calls).toHaveLength(0); // never navigated
      const allowed = await executeBrowserAction(page, 'open', { url: 'https://example.com' });
      expect(allowed.text).not.toContain('blocked');
    } finally {
      if (orig === undefined) delete process.env.NUVIRA_WEB_ALLOW_PRIVATE;
      else process.env.NUVIRA_WEB_ALLOW_PRIVATE = orig;
    }
  });

  it('click and type forward selectors/text', async () => {
    const page = fakePage();
    await executeBrowserAction(page, 'click', { selector: '#btn' });
    await executeBrowserAction(page, 'type', { selector: '#input', text: 'hello' });
    expect(page.calls).toContain('click:#btn');
    expect(page.calls).toContain('fill:#input:hello');
  });

  it('extract reads a selector or the body', async () => {
    const page = fakePage();
    const r1 = await executeBrowserAction(page, 'extract', { selector: '.content' });
    expect(r1.text).toContain('Fake page body text');
  });

  it('screenshot writes to the sandbox screenshots dir', async () => {
    const page = fakePage();
    const result = await executeBrowserAction(page, 'screenshot', {});
    expect(result.file).toBeTruthy();
    expect(readFileSync(result.file!)).toEqual(Buffer.from('PNG-DATA'));
    expect(result.file).toContain('screenshots');
  });

  it('requires url for open and selector for click', async () => {
    const page = fakePage();
    expect((await executeBrowserAction(page, 'open', {})).text).toContain('url is required');
    expect((await executeBrowserAction(page, 'click', {})).text).toContain('selector is required');
  });
});

// ─── I3 image generation ────────────────────────────────────────────────────

import { generateImage, fetchImageBytes } from '../../src/tools/modality/image-gen.js';

describe('I3 image generation', () => {
  it('generates via the Pollinations free endpoint and writes to images/', async () => {
    const bytes = Buffer.from('FAKE-PNG');
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes } as Response));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateImage('a red cat', { width: 512, height: 512 });
    expect(result.ok).toBe(true);
    expect(result.file).toContain('images');
    expect(readFileSync(result.file!)).toEqual(bytes);
    // Pollinations URL shape: prompt with size params.
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('image.pollinations.ai');
    expect(url).toContain('width=512');
  });

  it('uses a local backend when BUFF_IMAGE_API_URL is passed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => Buffer.from('LOCAL') } as unknown as Response)),
    );
    const result = await generateImage('landscape', { apiUrl: 'http://localhost:7860/sdapi/v1/txt2img' });
    expect(result.ok).toBe(true);
    expect(result.file).toBeTruthy();
  });

  it('returns an error (never throws) on backend failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 } as Response)));
    const result = await generateImage('broken');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 500');
  });

  it('fetchImageBytes rejects empty bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response)));
    await expect(fetchImageBytes('https://x/y.png')).rejects.toThrow(/empty/);
  });
});

// ─── I4 voice ───────────────────────────────────────────────────────────────

import {
  speak,
  transcribe,
  isTtsAvailable,
  isTranscribeAvailable,
  setVoiceBackendOverride,
} from '../../src/tools/modality/voice.js';
import { resetProbeCache } from '../../src/tools/modality/shared.js';

describe('I4 voice', () => {
  it('reports TTS unavailable when no backend binary is on PATH', () => {
    resetProbeCache();
    expect(isTtsAvailable()).toBe(false);
    expect(isTranscribeAvailable()).toBe(false);
  });

  it('speak degrades gracefully without a backend', async () => {
    resetProbeCache();
    const result = await speak('hello');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no TTS backend');
  });

  it('speak writes an mp3 to the audio dir when a TTS backend is available', async () => {
    setVoiceBackendOverride(true, null);
    const execMock = vi.fn(() => '');
    // edge-tts writes the media file; the test exec must create it so the
    // follow-up readFileSync succeeds.
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      const out = args[args.indexOf('--write-media') + 1];
      writeFileSync(out, Buffer.from('MP3-DATA'));
      return '';
    });
    const result = await speak('hello world', {}, execMock as any);
    expect(result.ok).toBe(true);
    expect(result.file).toContain('audio');
    expect(readFileSync(result.file!)).toEqual(Buffer.from('MP3-DATA'));
    expect(execMock.mock.calls[0][0]).toBe('edge-tts');
    setVoiceBackendOverride(null, null);
  });

  it('transcribe rejects a missing audio file before touching backends', async () => {
    resetProbeCache();
    const result = await transcribe('/nonexistent/audio.wav');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('audio file not found');
  });

  it('transcribe degrades gracefully without whisper', async () => {
    resetProbeCache();
    const audio = join(artDir, 'clip.wav');
    writeFileSync(audio, Buffer.from('WAV'));
    const result = await transcribe(audio);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no transcription backend');
  });

  it('transcribe runs the whisper binary and reads the generated .txt transcript', async () => {
    resetProbeCache();
    setVoiceBackendOverride(null, true);
    const execMock = vi.fn((_cmd: string, args: string[]) => {
      // whisper writes the transcript to the -of file; simulate that.
      const of = args[args.indexOf('-of') + 1];
      writeFileSync(`${of}.txt`, 'This is the transcript.', 'utf-8');
      return '';
    });
    const audio = join(artDir, 'clip2.wav');
    writeFileSync(audio, Buffer.from('WAV'));
    const result = await transcribe(audio, {}, execMock as any);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('transcript');
    // -f carries the audio input; -otxt writes the transcript to a file.
    expect(execMock.mock.calls[0][0]).toBe('whisper');
    expect(execMock.mock.calls[0][1]).toContain('-f');
    expect(execMock.mock.calls[0][1]).toContain(audio);
    setVoiceBackendOverride(null, null);
  });

  it('piper receives the text on stdin and writes the wav', async () => {
    resetProbeCache();
    // Force the piper backend directly via the override.
    setVoiceBackendOverride('piper', null);
    const execMock = vi.fn((_cmd: string, args: string[], opts: any) => {
      expect(opts.input).toBe('piper text');
      // piper writes to --output_file; simulate so the read succeeds.
      const out = args[args.indexOf('--output_file') + 1];
      writeFileSync(out, Buffer.from('WAV-DATA'));
      return '';
    });
    const result = await speak('piper text', { piperModel: '/models/voice.onnx' }, execMock as any);
    expect(result.ok).toBe(true);
    expect(result.file).toContain('audio');
    expect(readFileSync(result.file!)).toEqual(Buffer.from('WAV-DATA'));
    expect(execMock.mock.calls[0][0]).toBe('piper');
    setVoiceBackendOverride(null, null);
  });
});

// ─── I5 vision ──────────────────────────────────────────────────────────────

import { describeImage, isVisionAvailable } from '../../src/tools/modality/vision.js';

describe('I5 vision', () => {
  it('is available when a Gemini key is present', async () => {
    process.env.NUVIRA_GEMINI_API_KEY = 'test-key';
    expect(await isVisionAvailable()).toBe(true);
    delete process.env.NUVIRA_GEMINI_API_KEY;
  });

  it('is unavailable when Ollama is down and no Gemini key', async () => {
    const probe = vi.fn(async () => false);
    expect(await isVisionAvailable({ probe })).toBe(false);
  });

  it('rejects a missing image file', async () => {
    const result = await describeImage('/nonexistent/img.png');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('image not found');
  });

  it('describes via the Ollama vision endpoint (mocked)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ response: 'A screenshot of a terminal running tests.' }) } as unknown as Response)),
    );
    const img = join(artDir, 'shot.png');
    writeFileSync(img, Buffer.from('PNG'));
    const result = await describeImage(img, 'What is this?', { ollamaBase: 'http://localhost:11434' });
    expect(result.ok).toBe(true);
    expect(result.description).toContain('terminal');
  });

  it('describes via free Gemini vision when a key is set (mocked)', async () => {
    process.env.NUVIRA_GEMINI_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'A diagram of the architecture.' }] } }] }) } as unknown as Response)),
    );
    const img = join(artDir, 'diagram.png');
    writeFileSync(img, Buffer.from('PNG'));
    const result = await describeImage(img);
    expect(result.ok).toBe(true);
    expect(result.description).toContain('diagram');
    delete process.env.NUVIRA_GEMINI_API_KEY;
  });
});
