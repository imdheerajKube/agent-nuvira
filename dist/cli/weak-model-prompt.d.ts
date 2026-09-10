/**
 * Interactive weak-model decision prompt for the orchestrator
 * (routing.promptOnWeakModel).
 *
 * When a task can only run on a WEAK model (model escalation is a no-op —
 * every stronger candidate is unavailable/blocked, e.g. only a small local
 * model is configured), the default behavior is SILENT: the pipeline
 * continues on the weak model with lenient parsing and a bounded repair
 * budget (never stuck, but the deliverable may be recommendations rather
 * than reliable code). When the user opts into `routing.promptOnWeakModel:
 * true`, the orchestrator instead asks BEFORE committing to that path:
 *
 *   ⚠️ Only a weak model is available (local/gemma4:e4b)
 *   ? How would you like to proceed?
 *     ▶ Continue on the weak model — recommended if you just want its best
 *       effort (may be guidance, not a reliable deliverable)
 *     ⏳ Wait and retry when a stronger model is back (shown only when a
 *        stronger candidate is in a short cooldown)
 *     ⛔ Abort — I'll fix the provider config (add a key / wait out quota)
 *
 * This module is deliberately small and dependency-light so it can be unit
 * tested in isolation (inquirer mocked) and reused by any auto-mode caller.
 */
/** The config shape we read (only the routing sub-section). */
export interface WeakModelPromptConfig {
    routing?: {
        promptOnWeakModel?: boolean;
    };
}
/** What the user chose when a task can only run on a weak model. */
export type WeakModelChoice = 'continue' | 'wait' | 'abort';
/**
 * Whether the orchestrator should ASK what to do when only a weak model is
 * available. Reads `routing.promptOnWeakModel` (default false — silent
 * weak-model continuation).
 */
export declare function shouldPromptWeakModel(config: WeakModelPromptConfig): boolean;
/**
 * Ask the user how to handle a task that can only run on a weak model.
 *
 * @param weakModelLabel Human label of the weak model (e.g. "local/gemma4:e4b")
 * @param opts.waitAvailable When a stronger candidate is in a short cooldown,
 *        offer the "wait and retry" option (an honest wait — otherwise the
 *        only real choices are continue or abort).
 * @returns 'continue' to proceed on the weak model, 'wait' to stop and retry
 *          when a stronger model is back, 'abort' to stop the pipeline.
 */
export declare function promptWeakModelChoice(weakModelLabel: string, opts: {
    waitAvailable: boolean;
}): Promise<WeakModelChoice>;
//# sourceMappingURL=weak-model-prompt.d.ts.map