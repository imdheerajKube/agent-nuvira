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
 * - `looksLikeConfusedScaffoldingReply` — answer-quality resilience (v1.8x
 *   audit): detect the model CONFUSEDLY TALKING ABOUT the tool contract
 *   instead of executing it (e.g. apologizing about the example call). Such a
 *   reply never throws, so failover never fired and the confusion was
 *   delivered verbatim to a messaging-app sender. Callers treat it like a
 *   generation failure: retry via failover, fall back to the raw reply.
 */
/**
 * Answer-quality resilience — detect a model CONFUSEDLY TALKING ABOUT the
 * tool contract instead of executing it.
 *
 * Motivation (live WhatsApp incident): a fallback-transport model answered
 * "Write a song …" with "I'm sorry, but the provided example call to
 * suggest_followups is incomplete … Could you please provide more context" —
 * it had read the JSON-fallback prompt's `Example suggest_followups call:`
 * section and responded to IT as if it were the user's request. The reply
 * never throws, so the failover walk (which only fires on provider ERRORS)
 * accepted it and the confusion was delivered verbatim to the sender.
 *
 * Detection is deliberately conservative — the whole reply must look like
 * contract meta-talk, so a legitimate answer that merely MENTIONS a tool
 * ("I can run build for you") is never flagged:
 *  1. references the tool contract's own vocabulary (a known tool name or
 *     a tool/JSON/call-form noun phrase), AND
 *  2. is short (≤ 400 chars — real answers are longer), AND
 *  3. carries an apologetic/confused meta-tone (sorry/cannot/provided/incomplete…).
 *
 * @param content  the model's visible reply text
 * @param tools    tool names to look for (defaults to suggest_followups —
 *                 the contract marker every turn ends with)
 */
export function looksLikeConfusedScaffoldingReply(content, tools = ['suggest_followups']) {
    const t = (content || '').trim();
    if (!t || t.length > 400)
        return false;
    const mentionsContract = tools.some((name) => t.includes(name))
        || /\b(?:tool|tools)\s+call\b|\b(?:provided|given)\s+(?:example|call|schema|argument|arguments|tool)\b|\bexample\s+call\b/i.test(t);
    if (!mentionsContract)
        return false;
    const metaTone = /\b(?:i'?m\s+)?(?:really\s+)?sorry|\bi\s+(?:cannot|can't)\b|\bcould\s+(?:you|u)\s+please\b|\bprovide\s+(?:more\s+)?(?:context|details|information|clarification)\b|\b(incomplete|invalid|malformed|unclear|not\s+fully\s+defined)\b/i;
    return metaTone.test(t);
}
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
export function salvageFailedGeneration(err) {
    if (!(err instanceof Error))
        return null;
    const m = err.message.match(/"failed_generation"\s*:\s*("(?:[^"\\]|\\.)*")/);
    if (!m)
        return null;
    try {
        const raw = JSON.parse(m[1]);
        if (typeof raw !== 'string' || !raw.trim())
            return null;
        // Only salvage when the intended calls are the end-of-response marker
        // (suggest_followups) or absent: a rejected REAL tool call (build/…)
        // must not be "answered" with its intro prose.
        const funcs = [...raw.matchAll(/<function=([^>\s]*)\s*>?\s*([\s\S]*?)<\/function>/g)];
        if (funcs.some(([, f]) => f && f !== 'suggest_followups'))
            return null;
        // The tag shape is `<function=name [args]</function>` — NO `>` between the
        // args and the close (a naive `<function=[^>]*>` would greedily swallow
        // through `</function>`'s `>` and strip nothing). Handle the space form
        // (observed) AND the Anthropic-style angle form `<function=name>args</function>`.
        const content = raw
            .replace(/<function=[^>\s]*\s*[\s\S]*?<\/function>/g, '')
            .replace(/<function=[^>]*>[\s\S]*?<\/function>/g, '')
            .trim();
        // Best-effort: recover the followups from the stripped tag so the turn
        // still ends with the contract (the model's suggestions were
        // also being thrown away with the rejected call).
        let followups;
        for (const [, name, body] of funcs) {
            if (name !== 'suggest_followups' || !body.trim())
                continue;
            try {
                const parsed = JSON.parse(body.trim());
                const list = Array.isArray(parsed) ? parsed : parsed.followups;
                if (Array.isArray(list)) {
                    const mapped = list
                        .map((f) => {
                        const o = f;
                        return {
                            prompt: typeof o?.prompt === 'string' ? o.prompt : '',
                            ...(typeof o?.label === 'string' && o.label ? { label: o.label } : {}),
                        };
                    })
                        .filter((f) => f.prompt.trim());
                    if (mapped.length > 0)
                        followups = mapped;
                }
            }
            catch {
                // Ignore malformed followups — the answer is what matters.
            }
        }
        return { content, followups };
    }
    catch {
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
export function compactToolSchemas(schemas) {
    return schemas
        .map((s) => {
        const params = (s.parameters ?? {});
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
export function buildJsonFallbackPrompt(messages, schemas) {
    const prompt = messages
        .map((m) => {
        if (m.role === 'system')
            return `[System]\n${m.content}`;
        if (m.role === 'user')
            return `[User]\n${m.content}`;
        if (m.role === 'assistant')
            return m.content ? `[Assistant]\n${m.content}` : '';
        if (m.role === 'tool')
            return `[Tool result]\n${m.content}`;
        return '';
    })
        .filter(Boolean)
        .join('\n\n');
    return (prompt +
        (schemas.length > 0
            ? `\n\nTOOL ARGUMENT SHAPES (use these exact keys):\n${compactToolSchemas(schemas)}\n\nExample suggest_followups call:\n{"tool":"suggest_followups","arguments":{"followups":[{"prompt":"...","label":"..."}]}}`
            : ''));
}
//# sourceMappingURL=tool-call-utils.js.map