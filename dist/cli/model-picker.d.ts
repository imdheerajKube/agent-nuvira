/**
 * Shared Model Picker — standalone categorized model picker for CLI and orchestrator.
 *
 * Extracted from chat.ts so the orchestrator's rate-limit "switch model" flow
 * shows the same nice categorized picker instead of asking the user to type a
 * raw model name.
 */
import { ConfigManager } from '../config/manager.js';
export interface PickerResult {
    provider: string;
    model: string;
}
/**
 * Show a categorized model picker that groups models by capability.
 * Returns the selected provider and model, or null if cancelled.
 */
export declare function showModelPicker(configManager: ConfigManager): Promise<PickerResult | null>;
//# sourceMappingURL=model-picker.d.ts.map