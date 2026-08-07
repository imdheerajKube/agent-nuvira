import { InferenceProvider, ModelDescriptor } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getModelTags } from './model-catalog.js';
import { getCostTracker } from '../learning/cost-tracker.js';
import { requireAdapterModel } from '../learning/model-selection.js';

const OLLAMA_API_BASE = 'http://localhost:11434';

/** Cap on /api/show fallback fetches per listModels call — bounds the N+1 cost
 *  on machines with large local model libraries. */
const MAX_SHOW_FALLBACKS = 8;

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
}

/**
 * Extract a nominal context window (tokens) from an Ollama model_info map.
 * Ollama keys the value by GGUF architecture family in many builds
 * (`gemma4.context_length`, `qwen2.context_length`, `llama.context_length`)
 * and by `general.context_length` / `llama.context_length` in others.
 * Attention/embedding lengths (`*.key_length`, `*.embedding_length`) never
 * match the `<family>.context_length` pattern. Returns undefined when unknown.
 */
function contextLengthFromModelInfo(modelInfo?: Record<string, unknown>): number | undefined {
  if (!modelInfo) return undefined;
  for (const key of ['general.context_length', 'llama.context_length']) {
    const v = modelInfo[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  for (const [key, v] of Object.entries(modelInfo)) {
    if (/^[a-z0-9_.-]+\.context_length$/.test(key) && typeof v === 'number' && Number.isFinite(v) && v > 0) {
      return v;
    }
  }
  return undefined;
}

/**
 * Local Model Adapter
 * Supports Ollama, Hugging Face Transformers, and GGML models
 */
export class LocalAdapter implements InferenceProvider {
  readonly name = 'Local';
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async generate(prompt: string, options?: InferenceOptions): Promise<string> {
    const runner = this.config.runner || 'ollama';

    switch (runner) {
      case 'ollama':
        return this.generateOllama(prompt, options);
      case 'huggingface':
        return this.generateHuggingFace(prompt, options);
      case 'ggml':
        return this.generateGGML(prompt, options);
      default:
        throw new Error(`Unknown local runner: ${runner}. Supported: ollama, huggingface, ggml`);
    }
  }/**
 * Generate using Ollama HTTP API
 */
  private async generateOllama(prompt: string, options?: InferenceOptions): Promise<string> {
    const model = options?.model || requireAdapterModel('local', this.config.model);
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;

    logger.debug(`Ollama: Generating with model=${model}, temperature=${temperature}`);

    const response = await fetch(`${OLLAMA_API_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature,
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Ollama API error (${response.status}): ${errorBody}\n` +
        `Ensure Ollama is running: ollama serve`
      );
    }

    const data = (await response.json()) as OllamaGenerateResponse;
    const content = data.response || '';

    // Track cost (local models are free, but we still track usage)
    try {
      getCostTracker().recordCallEstimated('local', model, prompt, content);
    } catch { /* Non-critical */ }

    return content;
  }

  /**
   * Stream tokens from Ollama's HTTP API using newline-delimited JSON.
   * Ollama's streaming format returns one JSON object per line with a `response` field.
   */
  private async generateOllamaStream(
    prompt: string,
    model: string,
    temperature: number,
    onToken: (token: string) => void,
  ): Promise<string> {
    const response = await fetch(`${OLLAMA_API_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: true,
        options: { temperature },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Ollama streaming API error (${response.status}): ${errorBody}\n` +
        `Ensure Ollama is running: ollama serve`
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Ollama response body is not readable');
    }

    const decoder = new TextDecoder();
    const fullContent: string[] = [];
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Ollama sends newline-delimited JSON: one object per line
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed);
            // Each chunk has a `response` field with the token text
            if (parsed.response) {
              fullContent.push(parsed.response);
              onToken(parsed.response);
            }
            // `done: true` signals the end of the stream
            if (parsed.done) {
              break;
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const content = fullContent.join('');

    // Track cost for streaming (local models are free, tracks usage)
    try {
      getCostTracker().recordCallEstimated('local', model, prompt, content);
    } catch { /* Non-critical */ }

    return content;
  }

  /**
   * Generate using Hugging Face Transformers (via Python)
   * Requires transformers Python package to be installed
   */
  private async generateHuggingFace(prompt: string, options?: InferenceOptions): Promise<string> {
    const model = options?.model || requireAdapterModel('local', this.config.model);
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 512;

    logger.debug(`HuggingFace: Generating with model=${model}, maxTokens=${maxTokens}`);

    // Use a Python script for reliability
    const pythonScript = `
import sys, json
try:
    from transformers import AutoModelForCausalLM, AutoTokenizer
    import torch

    model_name = ${JSON.stringify(model)}
    prompt = ${JSON.stringify(prompt)}

    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForCausalLM.from_pretrained(model_name)

    inputs = tokenizer(prompt, return_tensors="pt")
    with torch.no_grad():
        outputs = model.generate(**inputs, max_new_tokens=${maxTokens})
    result = tokenizer.decode(outputs[0], skip_special_tokens=True)
    # Strip the input prompt from the output
    if result.startswith(prompt):
        result = result[len(prompt):].strip()
    print(json.dumps({"response": result}))
except ImportError:
    print(json.dumps({"error": "transformers package not installed. Run: pip install transformers torch"}))
    sys.exit(1)
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;

    return new Promise<string>((resolve, reject) => {
      const python = spawn('python3', ['-c', pythonScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let errorOutput = '';

      python.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      python.stderr?.on('data', (chunk: Buffer) => {
        errorOutput += chunk.toString();
      });

      python.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('Python 3 is not installed. Install it from https://python.org'));
        } else {
          reject(new Error(`Failed to run Python: ${err.message}`));
        }
      });

      python.on('close', (exitCode) => {
        if (exitCode === 0) {
          try {
            const parsed = JSON.parse(output);
            if (parsed.error) {
              reject(new Error(parsed.error));
            } else {
              resolve(parsed.response || '');
            }
          } catch (parseErr) {
            reject(new Error(`Failed to parse HuggingFace output: ${output}`));
          }
        } else {
          reject(new Error(`Hugging Face inference failed: ${errorOutput || output}`));
        }
      });
    });
  }

  /**
   * Generate using a GGML model binary
   * Expects a path to a GGML-compatible model file or the llama.cpp binary
   */
  private async generateGGML(prompt: string, options?: InferenceOptions): Promise<string> {
    const model = options?.model || requireAdapterModel('local', this.config.model);
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 512;

    logger.debug(`GGML: Generating with model=${model}, maxTokens=${maxTokens}`);

    // Check if the model file exists
    if (!existsSync(model)) {
      throw new Error(
        `GGML model not found at: ${model}\n` +
        `Download a model or update the path in your config.\n` +
        `You can download models from: https://huggingface.co/TheBloke`
      );
    }

    return new Promise((resolve, reject) => {
      const llamaCpp = spawn('llama-cli', [
        '-m', model,
        '-p', prompt,
        '-n', String(maxTokens),
        '--no-display-prompt',
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let errorOutput = '';

      llamaCpp.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
      });

      llamaCpp.stderr?.on('data', (data: Buffer) => {
        errorOutput += data.toString();
      });

      llamaCpp.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(
            'llama-cli not found. Install llama.cpp:\n' +
            '  brew install llama.cpp\n' +
            '  # or build from: https://github.com/ggerganov/llama.cpp'
          ));
        } else {
          reject(new Error(`Failed to run GGML model: ${err.message}`));
        }
      });

      llamaCpp.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim().replace(prompt, '').trim());
        } else {
          reject(new Error(`GGML inference exited with code ${code}: ${errorOutput}`));
        }
      });
    });
  }

  async generateStream(
    prompt: string,
    options: InferenceOptions | undefined,
    onToken: (token: string) => void,
  ): Promise<string> {
    const runner = this.config.runner || 'ollama';

    if (runner !== 'ollama') {
      // Only Ollama supports streaming for now; HuggingFace and GGML fall back to non-streaming
      logger.debug(`Local: Streaming not supported for runner '${runner}', falling back to non-streaming`);
      return this.generate(prompt, options);
    }

    const model = options?.model || requireAdapterModel('local', this.config.model);
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;

    logger.debug(`Ollama: Streaming with model=${model}, temperature=${temperature}`);

    return this.generateOllamaStream(prompt, model, temperature, onToken);
  }

  async isAvailable(): Promise<boolean> {
    const runner = this.config.runner || 'ollama';

    if (runner === 'ollama') {
      try {
        const response = await fetch(`${OLLAMA_API_BASE}/api/tags`);
        return response.ok;
      } catch {
        return false;
      }
    }

    // For huggingface/ggml, check at generation time
    return true;
  }

  getInfo(): string {
    const runner = this.config.runner || 'ollama';
    return `Provider: Local (${runner})\nModel: ${this.config.model || 'default'}\nStatus: ✅ Always available`;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const runner = this.config.runner || 'ollama';
    if (runner !== 'ollama') return [];

    try {
      const response = await fetch(`${OLLAMA_API_BASE}/api/tags`);
      if (!response.ok) return [];
      // Ollama exposes each model's context length in DIFFERENT places by
      // version: `details.context_length` (0.32.x+), `model_info["general.context_length"]`
      // (mid builds), or a family-keyed `model_info["<family>.context_length"]`.
      const data = (await response.json()) as {
        models?: Array<{
          name: string;
          model_info?: Record<string, unknown>;
          details?: { context_length?: number };
        }>;
      };
      const models = (data.models || []).map(
        (m: {
          name: string;
          model_info?: Record<string, unknown>;
          details?: { context_length?: number };
        }) => {
          const ctx = contextLengthFromModelInfo(m.model_info) ?? m.details?.context_length;
          return {
            id: m.name,
            name: m.name,
            provider: 'local',
            tags: getModelTags(m.name),
            ...(ctx !== undefined ? { contextWindowTokens: ctx } : {}),
          };
        },
      );

      // Fallback: models /api/tags couldn't describe get a targeted /api/show
      // lookup (bounded so a large local library never triggers an unbounded
      // N+1 probe; localhost round-trips are ~ms each). Never throws.
      for (const m of models.filter((x) => x.contextWindowTokens === undefined).slice(0, MAX_SHOW_FALLBACKS)) {
        const ctx = await this.fetchContextWindow(m.id);
        if (ctx !== undefined) m.contextWindowTokens = ctx;
      }
      return models;
    } catch {
      return [];
    }
  }

  /** POST /api/show for one model and read its advertised context window. */
  private async fetchContextWindow(model: string): Promise<number | undefined> {
    try {
      const response = await fetch(`${OLLAMA_API_BASE}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!response.ok) return undefined;
      const data = (await response.json()) as { model_info?: Record<string, unknown> };
      return contextLengthFromModelInfo(data.model_info);
    } catch {
      return undefined;
    }
  }
}
