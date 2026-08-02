import { Command } from 'commander';
import { BaseCommand } from './commands.js';
/**
 * Execute the multi-agent pipeline for a user's goal.
 */
export declare function runDeveloperMode(goal: string, configManager: any, options?: {
    provider?: string;
    model?: string;
}): Promise<void>;
export declare class ChatCommand extends BaseCommand {
    private devModeAuto;
    /**
     * Providers that failed MID-SESSION in auto mode, with the expiry of their
     * exclusion (ms epoch):
     * - AUTH failures (expired token/key) are definitive → excluded for the whole
     *   session (Number.MAX_SAFE_INTEGER), so a provider whose key died mid-session
     *   is never re-picked (and re-failed) on a later message.
     * - RATE-LIMIT failures (429 / exhausted quota / "token limit exceeded") are
     *   usually TRANSIENT (a 1-minute quota window) → excluded only for a short
     *   cooldown, then re-admitted, so a throttled-but-working provider isn't
     *   blacklisted for the entire chat.
     * - 5xx/network errors are NOT session-excluded at all — they flow through
     *   the circuit breaker (which needs repeated failures before opening).
     * Cleared when the chat exits.
     */
    private sessionFailedProviders;
    /**
     * How long a rate-limit failure excludes a provider from auto routing (ms).
     * Aligned with the circuit breaker's COOLDOWN_DURATION_MS (120s) so the
     * session-level exclusion and the breaker's scoring cooldown expire together
     * — one consistent recovery window, not two competing ones.
     */
    private static readonly RATE_LIMIT_EXCLUSION_MS;
    create(): Command;
    private execute;
    /**
     * Show a categorized model picker that groups models by capability.
     *
     * Example output:
     *
     *   🎯  Available Models
     *
     *   💬 Chat (General conversation)
     *    1. 🟢  llama-3.3-70b-versatile  ⭐ Best all-rounder — strong at...
     *    2. 🟢  gemma2-9b-it
     *
     *   💻 Code (Code generation, programming)
     *    3. 🔷  gemini-2.0-flash-exp  ⭐ Latest Gemini — fast, multimodal...
     *
     *   Enter a number (0-8):
     */
    /**
     * Record an auto-mode provider failure so the session fails over instead of
     * getting stuck on a broken provider (the core of "auto routing should pick
     * another provider when the current one dies mid-session"):
     *
     * - Definitive failures — auth (expired token/key) and rate-limit (exhausted
     *   quota, "token limit exceeded") — exclude the provider for the WHOLE
     *   session, so the next message never re-picks it and re-fails.
     * - EVERY failure also feeds the shared circuit breaker, so the auto router
     *   deprioritizes the provider by scoring even for transient 5xx/network
     *   errors (which need repeated failures before cooldown opens).
     *
     * Best-effort: never throws, so failover bookkeeping can't crash the chat.
     */
    private recordAutoProviderFailure;
    private showModelPicker;
    /**
     * Resolve the best provider/model for a message via the AutoModelRouter.
     * Returns the routed type/provider/model; the caller applies them to the
     * active session state.
     */
    /**
     * Resolve the best provider/model for a message via the AutoModelRouter.
     *
     * ONLY AVAILABLE providers are returned: the router itself already excludes
     * unconfigured providers (no API key), and this method additionally walks
     * the ranked candidates and picks the first one whose isAvailable() passes —
     * so Auto routing never sends a request to a provider that would 401.
     */
    private routeMessageAuto;
    /**
     * Generate a single-shot response in auto mode with runtime failover.
     *
     * The auto router picks the best provider, but a provider's key/model can
     * still fail at generation time (quota exhausted → 429, deprecated model →
     * 404 — Gemini's listModels() lists models the key can't actually use).
     * This walks the ranked candidates and returns the first successful response,
     * so Auto routing NEVER crashes the CLI — it always answers from a working
     * provider.
     */
    private generateAutoWithFailover;
    /**
     * Read multi-line input from stdin using readline.
     *
     * - First line prompt: "You: "
     * - Continuation lines prompt: "  > "
     * - Pressing Enter with no text on the first line re-prompts
     * - An empty line after non-empty input submits the message
     * - This allows pasting multi-line text (each line collected), then Enter to submit
     */
    private readMultiLineInput;
    private handleCommand;
    private generateWithContext;
}
//# sourceMappingURL=chat.d.ts.map