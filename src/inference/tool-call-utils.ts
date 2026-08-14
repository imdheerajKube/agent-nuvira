/**
 * Shared tool-call helpers (H1) — the S2/S3 reliability fixes lifted OUT of
 * `src/cli/chat.ts` so every surface that drives a model through tool calling
 * (chat's tool loop today; any future execute/plan/… loop or dashboard
 * console) gets them for free. One copy, one test, one contract.
 *
 * - `salvageFailedGeneration`  — recover a complete model answer from a
 *   tool-calling 400's `failed_generation` field (S3). The API rejects the
 *   CALL (e.g. the model emitted an Anthropic-style `<function=…>` tag inside
 *   its content) while the content is a full, deliverable answer — the essay
 *   was sitting in the error payload and being thrown away.
 * - `compactToolSchemas`       — one-line argument shapes for the JSON
 *   fallback transport (S2). The fallback contract lists tool NAMES only, so
 *   a fallback model cannot produce valid arguments for schemas it never saw.
 * - `buildJsonFallbackPrompt`  — the flattened thread + schema-shape section
 *   (the S2 injection), shared so chat and any other loop build identical
 *   prompts.
 */

import type { ToolMessage } from './interface.js';
import type { FollowupSuggestion, ToolJsonSchema } from '../tools/registry.js';

/**
 * S3 — salvage the model's generated content from a tool-calling 400.
 *
 * OpenAI-compatible APIs (Groq et al.) reject the CALL but often embed the
 * model's COMPLETE answer in the error body's `failed_generation` field — e.g.
 * when the model emitted an Anthropic-style `<function=…>` tag inside its
 * content (observed with llama-3.3-70b on Groq, which destroyed a perfect
 * essay). Only salvage when the intended call is the end-of-response marker
 * (`suggest_followups`) or absent: a rejected REAL tool call (build/repair/…)
 * must not be "answered" with its intro prose.
 */
export function salvageFailedGeneration(
  err: unknown,
): { content: string; followups?: FollowupSuggestion[] } | null {
  if (!(err instanceof Error)) return null;
  const m = err.message.match(/"failed_generation"\s*:\s*("(?:[^"\\]|\\.)*")/);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]) as string;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    // Only salvage when the intended calls are the end-of-response marker
    // (suggest_followups) or absent: a rejected REAL tool call (build/…)
    // must not be "answered" with its intro prose.
    const funcs = [...raw.matchAll(/<function=([^>\s]*)\s*>?\s*([\s\S]*?)<\/function>/g)];
    if (funcs.some(([, f]) => f && f !== 'suggest_followups')) return null;
    // The tag shape is `<function=name [args]</function>` — NO `>` between the
    // args and the close (a naive `<function=[^>]*>` would greedily swallow
    // through `</function>`'s `>` and strip nothing). Handle the space form
    // (observed) AND the Claude angle form `<function=name>args</function>`.
    const content = raw
      .replace(/<function=[^>\s]*\s*[\s\S]*?<\/function>/g, '')
      .replace(/<function=[^>]*>[\s\S]*?<\/function>/g, '')
      .trim();
    // Best-effort: recover the followups from the stripped tag so the turn
    // still ends with the Freebuff contract (the model's suggestions were
    // also being thrown away with the rejected call).
    let followups: FollowupSuggestion[] | undefined;
    for (const [, name, body] of funcs) {
      if (name !== 'suggest_followups' || !body.trim()) continue;
      try {
        const parsed = JSON.parse(body.trim()) as unknown;
        const list = Array.isArray(parsed) ? parsed : (parsed as { followups?: unknown }).followups;
        if (Array.isArray(list)) {
          const mapped = list
            .map((f) => {
              const o = f as { prompt?: unknown; label?: unknown };
              return {
                prompt: typeof o?.prompt === 'string' ? o.prompt : '',
                ...(typeof o?.label === 'string' && o.label ? { label: o.label } : {}),
              };
            })
            .filter((f) => f.prompt.trim());
          if (mapped.length > 0) followups = mapped;
        }
      } catch {
        // Ignore malformed followups — the answer is what matters.
      }
    }
    return { content, followups };
  } catch {
    return null;
  }
}

/**
 * S2 — compact one-line argument shapes for the JSON-fallback transport.
 *
 * The fallback contract (TOOL_CONTRACT_JSON) lists tool NAMES only — a
 * fallback-transport model (e.g. a small local Ollama model) cannot produce
 * valid arguments for schemas it never saw (it guessed plain strings / a
 * `text` key for suggest_followups). Append these shapes to the flattened
 * prompt: top-level property name + type + required, one line per tool.
 * Deliberately NOT the full JSON schema (token-heavy for small contexts).
 */
export function compactToolSchemas(schemas: ToolJsonSchema[]): string {
  return schemas
    .map((s) => {
      const params = (s.parameters ?? {}) as {
        properties?: Record<string, { type?: string; items?: { type?: string } }>;
        required?: string[];
      };
      const required = new Set(params.required ?? []);
      const parts = Object.entries(params.properties ?? {}).map(([k, v]) => {
        const items = v.items?.type ? `[]<${v.items.type}>` : '';
        return `${k}: ${items || v.type || 'any'}${required.has(k) ? ' (required)' : ''}`;
      });
      return `${s.name}: { ${parts.join(', ') || 'no args'} }`;
    })
    .join('\n');
}

/**
 * S2 — the JSON-fallback flattened prompt WITH the schema-shape section
 * appended (shared so chat and any other loop build byte-identical prompts).
 */
export function buildJsonFallbackPrompt(
  messages: ToolMessage[],
  schemas: ToolJsonSchema[],
): string {
  const prompt = messages
    .map((m) => {
      if (m.role === 'system') return `[System]\n${m.content}`;
      if (m.role === 'user') return `[User]\n${m.content}`;
      if (m.role === 'assistant') return m.content ? `[Assistant]\n${m.content}` : '';
      if (m.role === 'tool') return `[Tool result]\n${m.content}`;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
  return (
    prompt +
    (schemas.length > 0
      ? `\n\nTOOL ARGUMENT SHAPES (use these exact keys):\n${compactToolSchemas(schemas)}\n\nExample suggest_followups call:\n{"tool":"suggest_followups","arguments":{"followups":[{"prompt":"...","label":"..."}]}}`
      : '')
  );
}
