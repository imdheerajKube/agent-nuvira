# Project Specification: Forking Freebuff & Building Flexible Inference Tool

## 🎯 Objective
Create a CLI tool by forking **Freebuff**, removing server dependencies, and integrating support for both **offline models** (Ollama, Hugging Face, GGML) and **cloud APIs** (NVIDIA NIM, Google Gemini free tier, OpenRouter, with scope to add more later).

---

## 🔧 Requirements

### 1. Fork & Cleanup
- Clone Freebuff’s GitHub repo.
- Remove outbound calls to Freebuff’s hosted inference servers.
- Strip telemetry, ad‑injection, and subscription logic.

### 2. Inference Layer Abstraction
- Define a unified interface:

```ts
interface InferenceProvider {
  generate(prompt: string, options: InferenceOptions): Promise<string>;
}

Implement adapters:

NIMAdapter → NVIDIA NIM APIs.

GeminiAdapter → Google Gemini free API.

OpenRouterAdapter → OpenRouter multi‑provider routing.

LocalAdapter → Ollama/Hugging Face/other offline runners.

3. Configuration System
Add a config file (~/.buffconfig.json) or environment variables.

Allow users to specify:

Default provider (local, nim, gemini, openrouter).

API keys for each provider.

Model selection (e.g., llama2, mistral, gemini-pro).

4. Local Model Runner Integration
Integrate Ollama CLI for local LLMs.

Add Hugging Face Transformers for custom models.

Support GGML/quantized models for lightweight offline execution.

5. Context Management
Implement local caching (SQLite or Redis).

Handle multi‑file context parsing (chunking, prioritization).

Ensure context fits within model token limits.

6. CLI Command Routing
Modify Freebuff’s CLI commands (edit, plan, chat) to call your InferenceProvider.

Example usage:

buff edit file.js --provider=nim

buff chat --provider=local --model=llama2

7. Future‑Proofing
Build a plugin system for new adapters.

Support hybrid mode: local inference for small tasks, cloud APIs for heavy lifting.

Optional: add local telemetry/logging (no server dependency).

📐 Architecture Diagram (Conceptual)
Code
CLI Commands (edit, plan, chat)
        │
        ▼
Inference Layer (Unified Interface)
        │
 ┌──────┼───────────────┐
 │      │               │
NIMAdapter   GeminiAdapter   OpenRouterAdapter   LocalAdapter
 │             │               │                  │
NVIDIA NIM   Google Gemini   OpenRouter APIs   Ollama/HF/Local Models
📂 Sample Config File (buffconfig.json)
json
{
  "defaultProvider": "local",
  "providers": {
    "nim": { "apiKey": "YOUR_NIM_KEY", "model": "nim-llm" },
    "gemini": { "apiKey": "YOUR_GEMINI_KEY", "model": "gemini-pro" },
    "openrouter": { "apiKey": "YOUR_OPENROUTER_KEY", "model": "mistral-7b" },
    "local": { "runner": "ollama", "model": "llama2" }
  }
}
✅ Deliverables
Forked repo with server calls removed.

Modular inference layer with pluggable adapters.

Config system for API keys and model selection.

Working CLI commands routed through the new inference layer.

Documentation for adding new providers in the future.

Code

---