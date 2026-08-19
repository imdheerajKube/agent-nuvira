/**
 * Model Catalog — Categorizes AI models by capability so users can pick
 * the right model for their task.
 *
 * Each model is tagged with one or more categories based on its ID pattern.
 * The model picker uses these categories to group models with icons,
 * descriptions, and recommendation badges.
 */

// ─── Category Types ─────────────────────────────────────────────────────────

/** Category identifier used internally */
export type ModelCategory =
  | 'chat'        // General conversation
  | 'code'        // Code generation / programming
  | 'reasoning'   // Complex reasoning / logic / math
  | 'fast'        // Low-latency / lightweight
  | 'creative'    // Creative writing / storytelling
  | 'vision'      // Multimodal / image understanding
  | 'instruct'    // Instruction-following fine-tunes
  | 'agentic'     // Tool-use / function-calling
  | 'preview'     // Latest preview / experimental
  | 'speech'      // Speech/audio — TTS, STT (not chat-compatible)
  | 'other';      // Fallback

/** Display metadata for each category */
export interface CategoryInfo {
  /** Icon shown next to the category header */
  icon: string;
  /** Short human-readable label */
  label: string;
  /** Explanation of what this category is good for */
  description: string;
}

/**
 * Display info for every category.
 * Ordered roughly by popularity / usefulness.
 */
export const CATEGORY_INFO: Record<ModelCategory, CategoryInfo> = {
  chat: {
    icon: '💬',
    label: 'Chat',
    description: 'General conversation, Q&A, and everyday tasks',
  },
  code: {
    icon: '💻',
    label: 'Code',
    description: 'Code generation, debugging, and programming tasks',
  },
  reasoning: {
    icon: '🧠',
    label: 'Reasoning',
    description: 'Complex problem-solving, math, and logic',
  },
  fast: {
    icon: '⚡',
    label: 'Fast',
    description: 'Low-latency responses — best for quick iterations',
  },
  creative: {
    icon: '🎨',
    label: 'Creative',
    description: 'Creative writing, storytelling, and brainstorming',
  },
  vision: {
    icon: '👁️',
    label: 'Vision',
    description: 'Image understanding and multimodal tasks',
  },
  instruct: {
    icon: '🎯',
    label: 'Instruct',
    description: 'Instruction-tuned models for structured output',
  },
  agentic: {
    icon: '🤖',
    label: 'Agentic',
    description: 'Tool-use, function-calling, and autonomous agents',
  },
  preview: {
    icon: '🧪',
    label: 'Preview',
    description: 'Experimental / preview — may not be production-ready',
  },
  speech: {
    icon: '🎤',
    label: 'Speech',
    description: 'Speech/audio models — TTS, STT, voice (not chat-compatible)',
  },
  other: {
    icon: '🔹',
    label: 'Other',
    description: 'Uncategorized models',
  },

};

// ─── Pattern Scanner ────────────────────────────────────────────────────────

interface CategoryMatch {
  category: ModelCategory;
  /** Priority: lower = higher priority when multiple patterns match */
  priority: number;
}

/**
 * Ordered list of pattern matchers.
 * Each entry has a list of regex patterns to test against the model ID,
 * and the category to assign when any pattern matches.
 *
 * Only the LOWEST-priority match is kept (i.e., the most specific pattern wins).
 */
const CATEGORY_PATTERNS: Array<{
  patterns: RegExp[];
  category: ModelCategory;
  priority: number;
}> = [
  // ── Speech / Audio (most specific — not chat-compatible) ───────────────
  { patterns: [/orpheus/i, /whisper/i, /distil-whisper/i, /tts/i, /audio/i], category: 'speech', priority: 1 },
  // ── Vision / Multimodal ────────────────────────────────────────────────
  { patterns: [/vision/i, /multimodal/i], category: 'vision', priority: 2 },
  // ── Reasoning / Thinking ───────────────────────────────────────────────
  {
    patterns: [
      /qwen-2(?:\.5)?-(?:\d+)?b?(?:\d+)?-?(?:instruct|reasoning)?$/i,
      /deepseek-r1/i,
      /deepseek-(?:v2|v3)/i,
      /reasoning/i,
      /think/i,
    ],
    category: 'reasoning',
    priority: 3,
  },
  // ── Agentic / Tool-use ─────────────────────────────────────────────────
  {
    patterns: [
      /function-call/i,
      /tool-use/i,
      /agent/i,
      /claude.*(?:opus|sonnet)/i,
      /gpt-4/i,
    ],
    category: 'agentic',
    priority: 4,
  },
  // ── Code ───────────────────────────────────────────────────────────────
  {
    patterns: [
      /coder/i,
      /code-/i,
      /code\b/i,
      /deepseek-coder/i,
      /codellama/i,
      /codegemma/i,
      /starcoder/i,
      /qwen-coder/i,
      /wizardcoder/i,
      /codeqwen/i,
    ],
    category: 'code',
    priority: 4,
  },
  // ── Fast / Lightweight ─────────────────────────────────────────────────
  {
    patterns: [
      /llama-3[._-]1-8b/i,
      /llama-3[._-]2-3b/i,
      /llama-?-3b/i,
      /gemma-?2-?9b/i,
      /gemma-?2-?2b/i,
      /mistral-7b/i,
      /mixtral-8x7b/i,
      /phi-?3/i,
      /phi-?3?-?mini/i,
    ],
    category: 'fast',
    priority: 5,
  },
  // ── Preview / Experimental ─────────────────────────────────────────────
  {
    patterns: [
      /preview/i,
      /exp$/i,
      /experimental/i,
      /flash-exp/i,
    ],
    category: 'preview',
    priority: 6,
  },
  // ── Instruct / Structured ──────────────────────────────────────────────
  {
    patterns: [
      /-it$/i,
      /-instruct/i,
      /instruct$/i,
    ],
    category: 'instruct',
    priority: 6,
  },
  // ── Chat / General (most broad — catch-all for known chat models) ──────
  {
    patterns: [
      /llama/i,
      /mistral/i,
      /mixtral/i,
      /gemma/i,
      /gemini/i,
      /qwen/i,
      /deepseek/i,
      /claude/i,
      /gpt/i,
      /phi/i,
      /command\b/i,
      /aya/i,
      /nous/i,
      /hermes/i,
      /dbrx/i,
      /solar/i,
      /wizard/i,
    ],
    category: 'chat',
    priority: 7,
  },
];

/**
 * Determine the category for a given model ID.
 * Uses pattern matching against known model naming conventions.
 *
 * @param modelId The model identifier (e.g., "llama-3.3-70b-versatile")
 * @param owner   Optional owner/organization hint (e.g., "meta", "google")
 * @returns The best-matching category, defaulting to 'other'
 */
export function categorizeModel(modelId: string, _owner?: string): ModelCategory {
  let bestCategory: ModelCategory = 'other';
  let bestPriority = Infinity;
  let bestIndex = -1;

  for (let i = 0; i < CATEGORY_PATTERNS.length; i++) {
    const entry = CATEGORY_PATTERNS[i];
    for (const pattern of entry.patterns) {
      if (pattern.test(modelId)) {
        if (entry.priority < bestPriority) {
          bestCategory = entry.category;
          bestPriority = entry.priority;
          bestIndex = i;
        }
        break; // Only first matching pattern per entry
      }
    }
  }

  // If the model matched "fast" or "preview" but also has a broader category,
  // use the broader category for display but keep the tag
  // (tags will be handled separately)
  return bestCategory;
}

/**
 * Get ALL applicable category tags for a model.
 * This returns multiple categories so a model can be shown in multiple groups.
 *
 * Example: "llama-3.1-8b-instant" → ['chat', 'fast', 'instruct']
 */
export function getModelTags(modelId: string, _owner?: string): string[] {
  const tags: string[] = [];

  for (const entry of CATEGORY_PATTERNS) {
    for (const pattern of entry.patterns) {
      if (pattern.test(modelId)) {
        tags.push(entry.category);
        break;
      }
    }
  }

  // Always include 'chat' for any model that has recognizable patterns
  // (even code models can do chat), but NOT for speech models
  const hasKnownPattern = tags.length > 0;
  const isSpeech = tags.includes('speech');
  if (hasKnownPattern && !tags.includes('chat') && !isSpeech) {
    tags.push('chat');
  }

  return tags;
}

/**
 * Returns a human-friendly label for a model ID, stripping provider prefixes
 * and formatting nicely.
 *
 * Example: "meta-llama/llama-3.3-70b-instruct" → "Llama 3.3 70B Instruct"
 */
export function formatModelName(modelId: string): string {
  // Strip provider prefix (e.g., "groq/", "nvidia/")
  let name = modelId.replace(/^[^/]+\//, '');

  // Replace separators
  name = name.replace(/[/_]/g, ' ');

  // Capitalize first letter of each segment
  name = name.replace(/\b\w/g, (c) => c.toUpperCase());

  // Fix common renames
  name = name.replace(/\bLlama\b/g, 'Llama');
  name = name.replace(/\bGpt\b/g, 'GPT');
  name = name.replace(/\bClaude\b/g, 'Claude');
  name = name.replace(/\bGemma\b/g, 'Gemma');
  name = name.replace(/\bGemini\b/g, 'Gemini');
  name = name.replace(/\bMistral\b/g, 'Mistral');
  name = name.replace(/\bMixtral\b/g, 'Mixtral');
  name = name.replace(/\bQwen\b/g, 'Qwen');
  name = name.replace(/\bDeepseek\b/g, 'DeepSeek');

  return name;
}

/**
 * Get a recommendation badge / description for a model.
 * Some well-known models get a short blurb about what they excel at.
 */
import { generateDynamicBadge } from './dynamic-catalog.js';

export function getModelBadge(modelId: string): string | undefined {
  // Dynamic badge generation — pattern-based, no hardcoded model names.
  // This ensures the system adapts when providers add/remove models.
  return generateDynamicBadge(modelId);
}
