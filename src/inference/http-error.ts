/**
 * HTTP error context attachment for inference adapters.
 *
 * Adapters throw `Error` with a message like `Groq API error (429): {body}`.
 * The message is enough for classifyFallbackError(), but the provider's
 * RATE-LIMIT RESET HINT often lives in the RESPONSE HEADERS (Retry-After,
 * x-ratelimit-reset-requests/tokens, ...) or only appears in the body text.
 * Attach the raw status + headers to the thrown error so the shared
 * `extractRetryAfterMs()` in learning/provider-fallback.ts can read them and
 * park the provider for the ACTUAL reset time instead of a fixed window.
 *
 * The attached fields are non-enumerable-safe plain properties on the Error;
 * the error message format is unchanged (no behavior change for existing
 * callers / tests).
 */
export function attachHttpContext(err: Error, status: number, headers?: unknown): Error {
  (err as Error & { status?: number }).status = status;
  if (headers) {
    (err as Error & { headers?: unknown }).headers = headers;
  }
  return err;
}
