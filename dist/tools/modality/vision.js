/**
 * I5 — Vision (describe an image via an optional local/Gemini backend).
 *
 * `describe_image(path, prompt?)` describes an image using:
 *   1. Local **llava / llama3.2-vision** via Ollama (the existing local
 *      adapter's HTTP API — `/api/generate` with base64 images), or
 *   2. The free **Gemini vision** tier when BUFF_GEMINI_API_KEY is set.
 *
 * Availability: true when Ollama answers the `/api/tags` probe OR a Gemini key
 * is present. The Ollama probe is injectable so tests run without a server.
 */
import { readFileSync } from 'node:fs';
import { envBuff } from '../../config/paths.js';
import { fileExists } from './shared.js';
const OLLAMA_API_BASE = 'http://localhost:11434';
// ─── Availability ───────────────────────────────────────────────────────────
/** True when Ollama serves a vision model OR a Gemini key is present. */
export async function isVisionAvailable(opts = {}) {
    if (envBuff('GEMINI_API_KEY'))
        return true;
    return (opts.probe ?? defaultProbe)(opts);
}
async function defaultProbe(opts) {
    try {
        const base = opts.ollamaBase ?? OLLAMA_API_BASE;
        const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok)
            return false;
        const data = (await res.json());
        const names = (data.models ?? []).map((m) => m.name);
        return names.some((n) => /llava|vision|llama3\.2|minicpm/i.test(n));
    }
    catch {
        return false;
    }
}
// ─── describe_image ─────────────────────────────────────────────────────────
/**
 * Describe an image. Returns the description text or a descriptive error.
 * Never throws.
 */
export async function describeImage(imagePath, prompt = 'Describe this image in detail, including any visible text.', opts = {}) {
    if (!fileExists(imagePath)) {
        return { ok: false, error: `vision: image not found: ${imagePath}` };
    }
    try {
        // Gemini free tier first when a key is present.
        if (envBuff('GEMINI_API_KEY')) {
            const base64 = readFileSync(imagePath).toString('base64');
            const mime = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${envBuff('GEMINI_API_KEY')}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                            parts: [
                                { text: prompt },
                                { inline_data: { mime_type: mime, data: base64 } },
                            ],
                        }],
                }),
            });
            if (!res.ok)
                throw new Error(`Gemini vision HTTP ${res.status}`);
            const data = (await res.json());
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text)
                throw new Error('Gemini returned no description');
            return { ok: true, description: text.trim() };
        }
        // Local Ollama vision model.
        const base = opts.ollamaBase ?? OLLAMA_API_BASE;
        const model = opts.ollamaModel ?? 'llava';
        const base64 = readFileSync(imagePath).toString('base64');
        const res = await fetch(`${base}/api/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model, prompt, images: [base64], stream: false }),
        });
        if (!res.ok)
            throw new Error(`Ollama vision HTTP ${res.status}`);
        const data = (await res.json());
        if (data.error)
            throw new Error(data.error);
        if (!data.response)
            throw new Error('Ollama returned no description');
        return { ok: true, description: data.response.trim() };
    }
    catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
//# sourceMappingURL=vision.js.map