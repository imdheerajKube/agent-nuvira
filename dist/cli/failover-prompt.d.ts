/**
 * Interactive failover confirmation for Auto mode (routing.promptOnFailover).
 *
 * By default Auto mode fails over SILENTLY: when a provider dies mid-session
 * (expired key, exhausted quota, deprecated model), the next-ranked candidate
 * answers automatically and the user never gets stuck. When the user opts into
 * `routing.promptOnFailover: true`, the CLI instead asks BEFORE the switch:
 *
 *   🔄 provider failed — auto routing suggests next-provider (model)
 *   How would you like to proceed?
 *     🔄 Switch to next-provider (model) — recommended
 *     🎯 Let me pick a provider myself
 *
 * This module is deliberately small and dependency-light so it can be unit
 * tested in isolation (inquirer mocked) and reused by any auto-mode caller.
 */
/** The config shape we read (only the routing sub-section). */
export interface FailoverPromptConfig {
    routing?: {
        promptOnFailover?: boolean;
    };
}
/** What the user chose when confirming a failover. */
export type FailoverChoice = 'switch' | 'manual';
/**
 * Whether Auto mode should ASK before failing over. Reads
 * `routing.promptOnFailover` (default false — silent auto-failover).
 */
export declare function shouldConfirmFailover(config: FailoverPromptConfig): boolean;
/**
 * Ask the user how to handle a mid-session auto-mode failover.
 *
 * @param failedProviderName Human name of the provider that just failed
 * @param nextProviderName   Human name of the next-ranked candidate
 * @param nextModel          The candidate's model
 * @returns 'switch' to adopt the next candidate, 'manual' to fall through to
 *          the standard interactive recovery (model picker etc.)
 */
export declare function promptFailoverChoice(failedProviderName: string, nextProviderName: string, nextModel: string): Promise<FailoverChoice>;
//# sourceMappingURL=failover-prompt.d.ts.map