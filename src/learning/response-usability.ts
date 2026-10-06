/**
 * Is a model response USABLE? (fix_model_routing P1)
 *
 * WHY THIS EXISTS. A provider that answers with NOTHING was silently accepted as
 * a success by the failover walk (`resilient-call.ts` recorded telemetry and
 * returned), because only a THROWN error advances to the next candidate. A real
 * turn therefore retried the same dead model five times and then died with zero
 * tool calls while healthy models sat configured and unused. The walk had no
 * definition of "usable", so "the provider replied" *was* the definition.
 *
 * This module is that definition, in one place, for every seam that needs it:
 *
 *   - the failover walk validates the raw completion BEFORE recording success;
 *   - the tool loop asks it whether a step response carries anything;
 *   - telemetry and the exhaustion report name the failure from it.
 *
 * THE RULE. A response is usable when it carries assistant TEXT or at least one
 * TOOL CALL. Anything else is a provider failure — not a "the model is thinking"
 * state and not a success:
 *
 *   - `''` (blank text, no tool calls)      → `empty`      — the case that killed
 *                                             the run: HTTP 200, zero content.
 *   - a shape with neither field, or a     → `malformed`  — the adapter broke its
 *     content that is not a string                        contract.
 *
 * WHAT IS DELIBERATELY *NOT* USABLE-AWARE HERE: a `<think>…</think>`-only reply.
 * It is non-blank text, so it is USABLE by this definition, and the tool loop
 * keeps its own (bounded) "reasoning continued, not an answer" handling. Folding
 * thinking models into the empty-response path would make every reasoning step
 * look like a dead provider and swap models mid-thought — a worse bug than the
 * one this fixes. The empty-string case and the think-only case are therefore
 * named apart, exactly as `tool-loop.ts` already argues.
 *
 * `generate()` returns TEXT ONLY (tool calls travel via `generateTools`), which
 * is what makes an empty string here provably a failure rather than a
 * tool-call-only reply — see `src/inference/interface.ts`.
 */

/** Why a response could not be used. */
export type UnusableResponseKind = 'empty' | 'malformed';

/** The failure-kind string carried through telemetry, exclusion and reports. */
export const EMPTY_RESPONSE_FAILURE_KIND = 'empty-response';

/** Human label used inside the thrown error so classification can recognise it. */
export const UNUSABLE_RESPONSE_MARKER = 'unusable model response';

export interface ResponseUsability {
  /** True when the response carries text or tool calls. */
  usable: boolean;
  /** Why not, when `usable` is false. */
  kind: UnusableResponseKind | null;
  /** One sentence naming what was wrong — for the trace, the log and the report. */
  detail: string;
}

/**
 * Decide whether a model response carries anything usable.
 *
 * Accepts both shapes the codebase produces: a raw STRING (what
 * `InferenceProvider.generate` returns) and a `{ content, toolCalls }` object
 * (what the native tool-calling path returns). Being shape-tolerant is the point
 * — a seam that forgets to validate is the bug this module exists to remove, so
 * the validator must be safe to call on either.
 */
export function classifyModelResponse(response: unknown): ResponseUsability {
  // Raw text completion — the orchestrator/failover path.
  if (typeof response === 'string') {
    return response.trim().length > 0
      ? { usable: true, kind: null, detail: '' }
      : {
          usable: false,
          kind: 'empty',
          detail: 'the provider returned no text (empty completion)',
        };
  }

  if (response === null || response === undefined) {
    return {
      usable: false,
      kind: 'malformed',
      detail: 'the provider returned no response object at all',
    };
  }

  if (typeof response !== 'object') {
    return {
      usable: false,
      kind: 'malformed',
      detail: `the provider returned ${typeof response} instead of a completion`,
    };
  }

  const { content, toolCalls } = response as { content?: unknown; toolCalls?: unknown };
  const hasText = typeof content === 'string' && content.trim().length > 0;
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  if (hasText || hasToolCalls) return { usable: true, kind: null, detail: '' };

  // A well-formed step response that simply carried nothing is EMPTY; a response
  // that does not even have the right fields is MALFORMED. The two are reported
  // apart because they have different repairs (retry with another model vs fix
  // the adapter), and the tool loop already treats a bad shape as an error.
  if (typeof content === 'string' && Array.isArray(toolCalls)) {
    return {
      usable: false,
      kind: 'empty',
      detail: 'the provider returned an empty response — no answer text and no tool call',
    };
  }

  return {
    usable: false,
    kind: 'malformed',
    detail: 'the provider returned a response with no content and no tool-call list',
  };
}

/**
 * Thrown when a provider resolves with a response that cannot be used.
 *
 * Typed (rather than a bare `Error`) so the failover walk treats it exactly like
 * any other generation failure — it is caught by the same handler, so the
 * candidate is excluded, persisted and the walk advances — while telemetry and
 * reports can name the precise reason instead of bucketing it as `unknown`.
 */
export class UnusableModelResponseError extends Error {
  readonly kind: UnusableResponseKind;
  /** The failure kind string carried into the registry/ledger ('empty-response'). */
  readonly failureKind = EMPTY_RESPONSE_FAILURE_KIND;

  constructor(kind: UnusableResponseKind, detail: string) {
    super(`${UNUSABLE_RESPONSE_MARKER} (${kind}): ${detail}`);
    this.name = 'UnusableModelResponseError';
    this.kind = kind;
  }
}

/** Recognise the error without relying on `instanceof` across module copies. */
export function isUnusableModelResponseError(err: unknown): err is UnusableModelResponseError {
  return (
    err instanceof UnusableModelResponseError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { name?: unknown }).name === 'UnusableModelResponseError')
  );
}

/**
 * Throw when a response is unusable; return it unchanged when it is fine.
 *
 * Used at the failover boundary so an empty completion becomes a *failure* the
 * walk already knows how to handle, rather than a success it returns.
 */
export function assertUsableModelResponse<T>(response: T): T {
  const verdict = classifyModelResponse(response);
  if (!verdict.usable) throw new UnusableModelResponseError(verdict.kind ?? 'empty', verdict.detail);
  return response;
}
