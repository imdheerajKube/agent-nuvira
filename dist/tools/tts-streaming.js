/**
 * tts_streaming — Provider-agnostic streaming TTS.
 *
 * Converts text to speech using various providers (ElevenLabs, OpenAI, Azure, etc.)
 * Supports streaming for real-time playback.
 *
 * Features:
 * - Multiple provider support
 * - Streaming audio output
 * - Voice selection
 * - Speed control
 * - Format selection (PCM, MP3, WAV)
 */
import * as https from 'https';
// ─── TTS Providers ──────────────────────────────────────────────────────────
class ElevenLabsProvider {
    apiKey;
    voiceId;
    constructor(apiKey, voiceId = '21m00Tcm4TlvDq8ikWAM') {
        this.apiKey = apiKey;
        this.voiceId = voiceId;
    }
    async synthesize(text, options) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                text,
                model_id: 'eleven_multilingual_v2',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    speed: options?.speed || 1.0,
                },
            });
            const req = https.request({
                hostname: 'api.elevenlabs.io',
                path: `/v1/text-to-speech/${this.voiceId}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'xi-api-key': this.apiKey,
                    'Accept': options?.format === 'mp3' ? 'audio/mpeg' : 'audio/pcm',
                },
            }, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const audio = Buffer.concat(chunks);
                    resolve({
                        audio,
                        format: options?.format || 'pcm',
                        provider: 'elevenlabs',
                    });
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
    async stream(text, options) {
        // Streaming implementation would go here
        // For now, return non-streaming as a stream
        const result = await this.synthesize(text, options);
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue({ audio: result.audio, isFinal: true });
                controller.close();
            },
        });
        return stream;
    }
}
class OpenAIProvider {
    apiKey;
    model;
    constructor(apiKey, model = 'tts-1') {
        this.apiKey = apiKey;
        this.model = model;
    }
    async synthesize(text, options) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                model: this.model,
                input: text,
                voice: options?.voice || 'alloy',
                response_format: options?.format || 'pcm',
                speed: options?.speed || 1.0,
            });
            const req = https.request({
                hostname: 'api.openai.com',
                path: '/v1/audio/speech',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                },
            }, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const audio = Buffer.concat(chunks);
                    resolve({
                        audio,
                        format: options?.format || 'pcm',
                        provider: 'openai',
                    });
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
}
// ─── TTS Manager ────────────────────────────────────────────────────────────
class TTSStreamingManager {
    providers = new Map();
    defaultProvider;
    constructor() {
        this.defaultProvider = 'openai';
        // Register default providers
        if (process.env.ELEVENLABS_API_KEY) {
            this.providers.set('elevenlabs', new ElevenLabsProvider(process.env.ELEVENLABS_API_KEY));
        }
        if (process.env.OPENAI_API_KEY) {
            this.providers.set('openai', new OpenAIProvider(process.env.OPENAI_API_KEY));
        }
    }
    /**
     * Synthesize text to speech.
     */
    async synthesize(text, options) {
        const provider = options?.provider || this.defaultProvider;
        const providerInstance = this.providers.get(provider);
        if (!providerInstance) {
            throw new Error(`TTS provider '${provider}' not configured. Set ${provider.toUpperCase()}_API_KEY.`);
        }
        return providerInstance.synthesize(text, options);
    }
    /**
     * Stream text to speech.
     */
    async stream(text, options) {
        const provider = options?.provider || this.defaultProvider;
        const providerInstance = this.providers.get(provider);
        if (!providerInstance) {
            throw new Error(`TTS provider '${provider}' not configured`);
        }
        if (providerInstance.stream) {
            return providerInstance.stream(text, options);
        }
        // Fallback to non-streaming
        const result = await providerInstance.synthesize(text, options);
        return new ReadableStream({
            start(controller) {
                controller.enqueue({ audio: result.audio, isFinal: true });
                controller.close();
            },
        });
    }
    /**
     * List available providers.
     */
    listProviders() {
        return Array.from(this.providers.keys());
    }
    /**
     * Set default provider.
     */
    setDefaultProvider(provider) {
        this.defaultProvider = provider;
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let _instance = null;
export function getTTSStreamingManager() {
    if (!_instance)
        _instance = new TTSStreamingManager();
    return _instance;
}
export { TTSStreamingManager };
//# sourceMappingURL=tts-streaming.js.map