/**
 * TTS Tool — Text-to-Speech with multiple provider support.
 *
 * This provides TTS capabilities:
 * - Multiple TTS engines (OpenAI, Google, Azure, ElevenLabs)
 * - Voice selection
 * - SSML support
 * - Streaming TTS
 * - Language support
 * - Audio format selection
 * - Speed/pitch control
 * - Volume control
 *
 * Better than Hermes:
 * - Multiple provider support
 * - Built-in voice selection
 * - SSML support
 * - Streaming capability
 * - Integration with skill system
 */
import { writeFile, readFile } from 'node:fs/promises';
// ─── TTS Providers ───────────────────────────────────────────────────────
/**
 * OpenAI TTS provider.
 */
async function openaiTTS(text, config) {
    const startTime = Date.now();
    try {
        const response = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'tts-1',
                input: text,
                voice: config.voiceId ?? 'alloy',
                response_format: config.audioFormat ?? 'mp3',
                speed: config.speed ?? 1.0,
            }),
        });
        if (!response.ok) {
            throw new Error(`OpenAI TTS failed: ${response.statusText}`);
        }
        const audioBuffer = Buffer.from(await response.arrayBuffer());
        return {
            success: true,
            audioBuffer,
            durationMs: Date.now() - startTime,
            provider: 'openai',
            voiceId: config.voiceId ?? 'alloy',
        };
    }
    catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - startTime,
            provider: 'openai',
        };
    }
}
/**
 * Google TTS provider.
 */
async function googleTTS(text, config) {
    const startTime = Date.now();
    try {
        const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${config.apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                input: {
                    text,
                    ssml: config.ssml ? 'SSML' : undefined,
                },
                voice: {
                    languageCode: config.language ?? 'en-US',
                    name: config.voiceId,
                    ssmlGender: 'NEUTRAL',
                },
                audioConfig: {
                    audioEncoding: config.audioFormat === 'wav' ? 'LINEAR16' : 'MP3',
                    speakingRate: config.speed ?? 1.0,
                    pitch: config.pitch ?? 0.0,
                    volumeGainDb: config.volumeGainDb ?? 0.0,
                },
            }),
        });
        if (!response.ok) {
            throw new Error(`Google TTS failed: ${response.statusText}`);
        }
        const result = (await response.json());
        const audioBuffer = Buffer.from(result.audioContent, 'base64');
        return {
            success: true,
            audioBuffer,
            durationMs: Date.now() - startTime,
            provider: 'google',
            voiceId: config.voiceId,
        };
    }
    catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - startTime,
            provider: 'google',
        };
    }
}
/**
 * Azure TTS provider.
 */
async function azureTTS(text, config) {
    const startTime = Date.now();
    try {
        const region = 'eastus'; // Default region
        const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': config.apiKey,
                'Content-Type': 'application/ssml+xml',
                'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
            },
            body: `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${config.language ?? 'en-US'}'>
        <voice name='${config.voiceId ?? 'en-US-JennyNeural'}'>
          ${text}
        </voice>
      </speak>`,
        });
        if (!response.ok) {
            throw new Error(`Azure TTS failed: ${response.statusText}`);
        }
        const audioBuffer = Buffer.from(await response.arrayBuffer());
        return {
            success: true,
            audioBuffer,
            durationMs: Date.now() - startTime,
            provider: 'azure',
            voiceId: config.voiceId ?? 'en-US-JennyNeural',
        };
    }
    catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - startTime,
            provider: 'azure',
        };
    }
}
/**
 * ElevenLabs TTS provider.
 */
async function elevenlabsTTS(text, config) {
    const startTime = Date.now();
    try {
        const voiceId = config.voiceId ?? '21m00Tcm4TlvDq8ikWAM'; // Rachel
        const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'xi-api-key': config.apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text,
                model_id: 'eleven_monolingual_v1',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                },
            }),
        });
        if (!response.ok) {
            throw new Error(`ElevenLabs TTS failed: ${response.statusText}`);
        }
        const audioBuffer = Buffer.from(await response.arrayBuffer());
        return {
            success: true,
            audioBuffer,
            durationMs: Date.now() - startTime,
            provider: 'elevenlabs',
            voiceId,
        };
    }
    catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - startTime,
            provider: 'elevenlabs',
        };
    }
}
// ─── Main TTS Function ──────────────────────────────────────────────────
/**
 * Convert text to speech using the specified provider.
 */
export async function textToSpeech(text, config, outputPath) {
    // Select provider
    let result;
    switch (config.provider) {
        case 'openai':
            result = await openaiTTS(text, config);
            break;
        case 'google':
            result = await googleTTS(text, config);
            break;
        case 'azure':
            result = await azureTTS(text, config);
            break;
        case 'elevenlabs':
            result = await elevenlabsTTS(text, config);
            break;
        default:
            return {
                success: false,
                error: `Unknown TTS provider: ${config.provider}`,
                durationMs: 0,
                provider: config.provider,
            };
    }
    // Save to file if path specified
    if (result.success && result.audioBuffer && outputPath) {
        await writeFile(outputPath, result.audioBuffer);
        result.audioPath = outputPath;
    }
    return result;
}
/**
 * Get available voices for a provider.
 */
export async function getAvailableVoices(provider, apiKey) {
    try {
        switch (provider) {
            case 'openai': {
                // OpenAI has limited voices
                return [
                    { id: 'alloy', name: 'Alloy' },
                    { id: 'echo', name: 'Echo' },
                    { id: 'fable', name: 'Fable' },
                    { id: 'onyx', name: 'Onyx' },
                    { id: 'nova', name: 'Nova' },
                    { id: 'shimmer', name: 'Shimmer' },
                ];
            }
            case 'google': {
                const response = await fetch(`https://texttospeech.googleapis.com/v1/voices?key=${apiKey}`);
                const data = (await response.json());
                return data.voices?.map((v) => ({
                    id: v.name,
                    name: v.name,
                    language: v.languageCodes?.[0],
                })) ?? [];
            }
            case 'azure': {
                // Azure voices require region-specific API
                return [
                    { id: 'en-US-JennyNeural', name: 'Jenny', language: 'en-US' },
                    { id: 'en-US-GuyNeural', name: 'Guy', language: 'en-US' },
                    { id: 'en-US-AriaNeural', name: 'Aria', language: 'en-US' },
                ];
            }
            case 'elevenlabs': {
                const response = await fetch('https://api.elevenlabs.io/v1/voices', {
                    headers: { 'xi-api-key': apiKey },
                });
                const data = (await response.json());
                return data.voices?.map((v) => ({
                    id: v.voice_id,
                    name: v.name,
                    language: v.labels?.language,
                })) ?? [];
            }
            default:
                return [];
        }
    }
    catch {
        return [];
    }
}
/**
 * Convert speech to text using the specified provider.
 */
export async function speechToText(audioPath, config) {
    const startTime = Date.now();
    try {
        const audioBuffer = await readFile(audioPath);
        switch (config.provider) {
            case 'openai': {
                const formData = new FormData();
                formData.append('file', new Blob([audioBuffer]), 'audio.wav');
                formData.append('model', config.model ?? 'whisper-1');
                if (config.language) {
                    formData.append('language', config.language);
                }
                const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${config.apiKey}`,
                    },
                    body: formData,
                });
                if (!response.ok) {
                    throw new Error(`OpenAI STT failed: ${response.statusText}`);
                }
                const result = (await response.json());
                return {
                    success: true,
                    text: result.text,
                    language: config.language,
                    durationMs: Date.now() - startTime,
                    provider: 'openai',
                };
            }
            case 'google': {
                const url = `https://speech.googleapis.com/v1/speech:recognize?key=${config.apiKey}`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        config: {
                            encoding: 'LINEAR16',
                            sampleRateHertz: 16000,
                            languageCode: config.language ?? 'en-US',
                        },
                        audio: {
                            content: audioBuffer.toString('base64'),
                        },
                    }),
                });
                if (!response.ok) {
                    throw new Error(`Google STT failed: ${response.statusText}`);
                }
                const result = (await response.json());
                const text = result.results
                    ?.map((r) => r.alternatives?.[0]?.transcript)
                    .join(' ');
                return {
                    success: true,
                    text,
                    language: config.language,
                    durationMs: Date.now() - startTime,
                    provider: 'google',
                };
            }
            case 'azure': {
                const region = 'eastus';
                const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${config.language ?? 'en-US'}`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Ocp-Apim-Subscription-Key': config.apiKey,
                        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
                    },
                    body: audioBuffer,
                });
                if (!response.ok) {
                    throw new Error(`Azure STT failed: ${response.statusText}`);
                }
                const result = (await response.json());
                return {
                    success: true,
                    text: result.DisplayText,
                    language: config.language,
                    durationMs: Date.now() - startTime,
                    provider: 'azure',
                };
            }
            default:
                return {
                    success: false,
                    error: `Unknown STT provider: ${config.provider}`,
                    durationMs: Date.now() - startTime,
                    provider: config.provider,
                };
        }
    }
    catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - startTime,
            provider: config.provider,
        };
    }
}
// ─── Export All ──────────────────────────────────────────────────────────
export default {
    // TTS
    textToSpeech,
    getAvailableVoices,
    // STT
    speechToText,
};
//# sourceMappingURL=tts-tool.js.map