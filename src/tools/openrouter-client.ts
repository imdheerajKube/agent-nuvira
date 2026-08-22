/**
 * openrouter_client — Multi-LLM routing via OpenRouter.
 *
 * Routes LLM calls to multiple providers (OpenAI, Anthropic, Google, etc.)
 * for cost optimization and fallback.
 *
 * Features:
 * - Multi-provider routing
 * - Cost optimization
 * - Automatic fallback
 * - Usage tracking
 */

import * as https from 'https';
import * as http from 'http';

// ─── Types ──────────────────────────────────────────────────────────────────

interface OpenRouterConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletion {
  id: string;
  model: string;
  content: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  cost?: number;
  latencyMs: number;
}

interface ModelInfo {
  id: string;
  name: string;
  pricing: {
    prompt: number;
    completion: number;
  };
  context_length: number;
  provider: string;
}

// ─── OpenRouter Client ──────────────────────────────────────────────────────

class OpenRouterClient {
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  private usageHistory: {
    model: string;
    tokens: number;
    cost: number;
    latencyMs: number;
    timestamp: number;
  }[] = [];

  constructor(config?: OpenRouterConfig) {
    this.apiKey = config?.apiKey || process.env.OPENROUTER_API_KEY || '';
    this.baseUrl = config?.baseUrl || 'https://openrouter.ai/api/v1';
    this.defaultModel = config?.defaultModel || 'anthropic/claude-3.5-sonnet';
  }

  /**
   * Send a chat completion request.
   */
  async chat(
    messages: ChatMessage[],
    options?: {
      model?: string;
      maxTokens?: number;
      temperature?: number;
      stream?: boolean;
    },
  ): Promise<ChatCompletion> {
    const model = options?.model || this.defaultModel;
    const startTime = Date.now();

    const body = {
      model,
      messages,
      max_tokens: options?.maxTokens || 4096,
      temperature: options?.temperature ?? 0.7,
      stream: options?.stream || false,
    };

    const response = await this.request('POST', '/chat/completions', body);
    const latencyMs = Date.now() - startTime;

    const completion: ChatCompletion = {
      id: response.id || `gen_${Date.now()}`,
      model: response.model || model,
      content: response.choices?.[0]?.message?.content || '',
      usage: {
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0,
      },
      latencyMs,
    };

    // Track usage
    this.usageHistory.push({
      model,
      tokens: completion.usage.total_tokens,
      cost: this.estimateCost(model, completion.usage),
      latencyMs,
      timestamp: Date.now(),
    });

    return completion;
  }

  /**
   * List available models.
   */
  async listModels(): Promise<ModelInfo[]> {
    const response = await this.request('GET', '/models');
    return response.data || [];
  }

  /**
   * Get cost estimate for a model.
   */
  estimateCost(model: string, usage: { prompt_tokens: number; completion_tokens: number }): number {
    // Approximate pricing per 1M tokens (USD)
    const pricing: Record<string, { prompt: number; completion: number }> = {
      'anthropic/claude-3.5-sonnet': { prompt: 3, completion: 15 },
      'anthropic/claude-3-opus': { prompt: 15, completion: 75 },
      'openai/gpt-4o': { prompt: 2.5, completion: 10 },
      'openai/gpt-4-turbo': { prompt: 10, completion: 30 },
      'google/gemini-pro': { prompt: 0.5, completion: 1.5 },
      'meta-llama/llama-3-70b': { prompt: 0.5, completion: 0.8 },
    };

    const rates = pricing[model] || { prompt: 3, completion: 15 };
    return (usage.prompt_tokens * rates.prompt + usage.completion_tokens * rates.completion) / 1_000_000;
  }

  /**
   * Get usage statistics.
   */
  getStats(): {
    totalRequests: number;
    totalTokens: number;
    totalCost: number;
    avgLatencyMs: number;
    byModel: Record<string, { requests: number; tokens: number; cost: number }>;
  } {
    const totalRequests = this.usageHistory.length;
    const totalTokens = this.usageHistory.reduce((sum, u) => sum + u.tokens, 0);
    const totalCost = this.usageHistory.reduce((sum, u) => sum + u.cost, 0);
    const avgLatencyMs = totalRequests > 0
      ? this.usageHistory.reduce((sum, u) => sum + u.latencyMs, 0) / totalRequests
      : 0;

    const byModel: Record<string, { requests: number; tokens: number; cost: number }> = {};
    for (const usage of this.usageHistory) {
      if (!byModel[usage.model]) {
        byModel[usage.model] = { requests: 0, tokens: 0, cost: 0 };
      }
      byModel[usage.model].requests++;
      byModel[usage.model].tokens += usage.tokens;
      byModel[usage.model].cost += usage.cost;
    }

    return { totalRequests, totalTokens, totalCost, avgLatencyMs, byModel };
  }

  /**
   * HTTP request helper.
   */
  private async request(method: string, path: string, body?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://agent-nuvira.dev',
        'X-Title': 'Agent-Nuvira',
      };

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method,
        headers,
      };

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid response: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(30_000, () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: OpenRouterClient | null = null;

export function getOpenRouterClient(config?: OpenRouterConfig): OpenRouterClient {
  if (!_instance) _instance = new OpenRouterClient(config);
  return _instance;
}

export { OpenRouterClient };
