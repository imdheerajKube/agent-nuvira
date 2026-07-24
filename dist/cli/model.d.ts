/**
 * Model command — Manage and switch inference providers and models seamlessly.
 *
 * This command enables "context-preserving" provider switching:
 * - Changes the active provider/model in a runtime state file
 * - Other commands (chat, execute) can read this state to pick up the current model
 * - The switch is instant — no need to restart any session
 * - Conversation history and agent state are preserved across switches
 *
 * Usage:
 *   buff model                           — Show current config + interactive switch
 *   buff model list                      — List all providers and their status
 *   buff model switch                    — Interactive categorized model picker
 *   buff model switch groq               — Switch to groq (default model)
 *   buff model switch groq/llama-3.3-70b — Switch to specific model
 *   buff model info                      — Show detailed current config
 *   buff model recommend                 — Show model routing recommendations
 *   buff model health                    — Quick health check for active provider
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
/**
 * The runtime state file that preserves the active model across sessions.
 * Other commands (chat, execute) can read this to know which model to use.
 * Path: ~/.buff/active-model.json
 */
export interface ActiveModelState {
    /** Provider type identifier (e.g., 'groq', 'gemini', 'openrouter') */
    provider: string;
    /** Model identifier (e.g., 'llama-3.3-70b-versatile') */
    model: string;
    /** When this was last updated */
    updatedAt: number;
    /** Whether this was explicitly set by the user */
    explicit: boolean;
    /** Display name for the provider */
    providerLabel?: string;
}
/**
 * Read the current active model state from disk.
 * Returns null if no state has been saved yet.
 */
export declare function readActiveModelState(): ActiveModelState | null;
/**
 * Save a new active model state to disk.
 * This is called when the user switches providers/models.
 */
export declare function saveActiveModelState(state: Omit<ActiveModelState, 'updatedAt'>): void;
/**
 * Apply the active model state to CLI options.
 * Other commands call this to auto-select the user's last-used model.
 */
export declare function applyActiveModel(options: {
    provider?: string;
    model?: string;
}): {
    provider?: string;
    model?: string;
};
export declare class ModelCommand extends BaseCommand {
    create(): Command;
    private listProviders;
    private switchProvider;
    /**
     * Perform the actual provider/model switch.
     * Saves the active model state and confirms to the user.
     */
    private doSwitch;
    private showInfo;
    private showRecommendations;
    private checkHealth;
    private promptSwitchIfWanted;
}
//# sourceMappingURL=model.d.ts.map