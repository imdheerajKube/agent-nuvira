import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class ChatCommand extends BaseCommand {
    private devModeAuto;
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
    private showModelPicker;
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