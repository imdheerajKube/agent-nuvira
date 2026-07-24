/**
 * Run command — Execute a shell command directly using the RunnerAgent.
 *
 * This is a lightweight shortcut that bypasses the multi-agent pipeline
 * and runs a command immediately, showing stdout/stderr output.
 *
 * Usage:
 *   buff run "echo hello world"
 *   buff run "npm test" --verbose
 *   buff run "python hello.py" --timeout 30000
 *   buff run "node index.js" --provider groq --model "llama-3.1-8b-instant"
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
/**
 * Run command — lightweight shell command execution via RunnerAgent.
 */
export declare class RunCommand extends BaseCommand {
    create(): Command;
    private execute;
}
//# sourceMappingURL=run.d.ts.map