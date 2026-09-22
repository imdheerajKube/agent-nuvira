/**
 * Prompt layers — deterministic splitting of a composed prompt into the
 * layers that matter for review (enterprise hardening, session 3).
 *
 * WHY THIS EXISTS (the prompt audit of the last 30 traces):
 * The trace stored ONE flat `promptPreview` capped at 300–500 chars, and for
 * chat turns the preview deliberately shortened the system prompt to its first
 * 80 characters. Result: in 106/106 chat steps the single most important
 * artifact — the system prompt (persona, tool contract, response rules) — was
 * INVISIBLE, and `promptDigest` hashed the whole thread so it could not show
 * whether the stable layer was byte-stable (i.e. cacheable). Prompt
 * engineering was, in practice, unreviewable.
 *
 * This module answers three questions from a flat prompt string, with no LLM
 * and no caller changes:
 *   1. Which bytes are the STABLE layer (identity / contract)?
 *   2. Which are CONTEXT (project knowledge, recalled state, history, tools)?
 *   3. Which are VOLATILE (the current task / ask)?
 *
 * Two transports are recognised because the codebase composes prompts two ways:
 *   - the chat thread serialisation: `[System]` / `[User]` / `[Assistant]` /
 *     `[Tool result]` markers (see `chat.ts` callModelWithTrace);
 *   - the layered assembler: `# Project Context` … `## Task` headings
 *     (see `agents/prompt-assembly.ts` assemblePrompt).
 * Anything else falls back to a single `system` layer so a digest still detects
 * change even when the shape is unknown.
 */

import { createHash } from 'node:crypto';

export interface PromptLayers {
  /** Stable layer — identity, tool contract, tool guidance. */
  system: string;
  /** Context layer — project assessment, knowledge, recalled state, history. */
  context: string;
  /** Volatile layer — the current task / ask. */
  volatile: string;
}

/** Per-layer digest + size record stored on a trace step. */
export interface PromptLayerDigests {
  systemDigest: string;
  contextDigest: string;
  volatileDigest: string;
  systemChars: number;
  contextChars: number;
  volatileChars: number;
}

function sha256Prefix(input: string, length = 16): string {
  try {
    return createHash('sha256').update(input).digest('hex').slice(0, length);
  } catch {
    return String(input.length);
  }
}

/** The chat transport's role markers, at the START of a line. */
const CHAT_MARKER_RE = /^(?:\[System\]|\[User\]|\[Assistant\]|\[Tool result\])\s*$/;

/** The assembler transport's headings. */
const ASSEMBLED_CONTEXT_RE = /^#\s*Project Context\s*$/m;
const ASSEMBLED_VOLATILE_RE = /^##\s*Task\s*$/m;

/**
 * Split a chat-thread serialisation. The LAST `[User]` block is the current
 * ask (volatile); every earlier block — injected context, prior turns, tool
 * results — is context; the leading `[System]` block is the stable layer.
 */
function splitChatThread(text: string): PromptLayers {
  const lines = text.split('\n');
  // Index of each marker line.
  const marks: Array<{ i: number; kind: string }> = [];
  lines.forEach((l, i) => {
    if (CHAT_MARKER_RE.test(l.trim())) marks.push({ i, kind: l.trim() });
  });
  if (marks.length === 0) return { system: text, context: '', volatile: '' };

  const lastUser = [...marks].reverse().find((m) => m.kind === '[User]');
  const sys = marks.find((m) => m.kind === '[System]');

  // Slice boundaries: a block runs from a marker to the next marker.
  const blockEnd = (idx: number): number => {
    const next = marks.find((m) => m.i > marks[idx].i);
    return next ? next.i : lines.length;
  };
  const blockAt = (mark: { i: number }): string => {
    const pos = marks.findIndex((m) => m.i === mark.i);
    return lines.slice(mark.i, blockEnd(pos)).join('\n');
  };

  const system = sys ? blockAt(sys) : '';
  const volatile = lastUser ? blockAt(lastUser) : '';
  const context = lines
    .filter((_, i) => {
      // Everything except the system block and the LAST user block.
      if (sys && i >= sys.i && i < blockEnd(marks.findIndex((m) => m.i === sys.i))) return false;
      if (lastUser && i >= lastUser.i && i < blockEnd(marks.findIndex((m) => m.i === lastUser.i))) return false;
      return true;
    })
    .join('\n');
  return { system, context: context.trim(), volatile };
}

/**
 * Split an `assemblePrompt` result: everything before `# Project Context` is
 * the stable layer, the Project Context block is context, and `## Task`
 * onward is volatile.
 */
function splitAssembledPrompt(text: string): PromptLayers {
  const ctxMatch = ASSEMBLED_CONTEXT_RE.exec(text);
  const volMatch = ASSEMBLED_VOLATILE_RE.exec(text);
  const ctxAt = ctxMatch?.index ?? -1;
  const volAt = volMatch?.index ?? -1;

  if (ctxAt === -1 && volAt === -1) {
    // Unknown shape — keep it as one stable layer so change is still detected.
    return { system: text, context: '', volatile: '' };
  }
  const systemEnd = ctxAt !== -1 ? ctxAt : volAt;
  const system = text.slice(0, systemEnd).trim();
  const context = ctxAt === -1 ? '' : text.slice(ctxAt, volAt === -1 ? text.length : volAt).trim();
  const volatile = volAt === -1 ? '' : text.slice(volAt).trim();
  return { system, context, volatile };
}

/**
 * Split a composed prompt into its stable / context / volatile layers.
 * Deterministic and transport-aware; never throws.
 */
export function splitPromptLayers(text: string): PromptLayers {
  const t = text || '';
  if (!t.trim()) return { system: '', context: '', volatile: '' };
  try {
    if (CHAT_MARKER_RE.test(t.split('\n')[0].trim()) || /\n\[User\]\s*$|\n\[User\]\n/.test(t)) {
      return splitChatThread(t);
    }
    return splitAssembledPrompt(t);
  } catch {
    return { system: t, context: '', volatile: '' };
  }
}

/**
 * Per-layer digests + sizes. The three digests SEPARATELY answer the review
 * question the flat digest could not: did the stable layer change between
 * steps (a cache-busting regression), or only the volatile one (expected)?
 */
export function digestPromptLayers(layers: PromptLayers): PromptLayerDigests {
  return {
    systemDigest: sha256Prefix(layers.system),
    contextDigest: sha256Prefix(layers.context),
    volatileDigest: sha256Prefix(layers.volatile),
    systemChars: layers.system.length,
    contextChars: layers.context.length,
    volatileChars: layers.volatile.length,
  };
}

/** Convenience: split + digest in one call. */
export function digestPrompt(text: string): { layers: PromptLayers; digests: PromptLayerDigests } {
  const layers = splitPromptLayers(text);
  return { layers, digests: digestPromptLayers(layers) };
}
