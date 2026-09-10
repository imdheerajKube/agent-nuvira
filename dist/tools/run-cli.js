/**
 * run_cli — plain-English → CLI execution as an agent TOOL.
 *
 * The agent-side half of the intent router (src/commands/intent-router.ts +
 * src/resources/command-manifest.json): the user asks in plain English
 * ("stop the dashboard", "add Rahul's mobile +919958604222 to whatsapp",
 * "run the eval suite") and the model calls:
 *
 *   run_cli({ ask: "stop the dashboard" })
 *
 * The tool resolves the ask against the manifest and, when safe, executes the
 * exact `buff` command as a child process (`node dist/index.js <args>`) — the
 * SAME engine the user would run by hand, so behavior never diverges from the
 * CLI (this mirrors the dashboard task runner's design).
 *
 * Safety model (see docs/COMMANDS.md §15):
 *   - NO arbitrary shell: the tool only executes commands that came from the
 *     manifest's intent → command mapping. The model cannot smuggle a raw
 *     command string in.
 *   - Ambiguous asks (verified list vs send-by-name mapping, …) are NOT
 *     guessed: the tool returns the options and instructs the model to call
 *     `ask_user` first, then retry with the chosen intent.
 *   - Confirmation-flagged intents (stop/shutdown/publish/clear/disallow/…) do
 *     not run until the model passes `confirm: true`, which it only has after
 *     the user confirmed via ask_user.
 *   - Output is capped and sender ids are masked (maskSenderId) — the tool
 *     result never echoes full phone numbers back into the model.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAsk } from '../commands/intent-router.js';
import { maskSenderId } from '../utils/mask.js';
/** Cap on how much CLI output is fed back to the model. */
const MAX_OUTPUT_CHARS = 6000;
/** CLI commands are quick; 60s is generous. */
const TOOL_TIMEOUT_MS = 60_000;
function repoRootDir() {
    // Compiled: dist/tools/run-cli.js → repo root is ../../.
    // Dev (tsx): src/tools/run-cli.ts → same ../../.
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}
function cliEntry() {
    return join(repoRootDir(), 'dist', 'index.js');
}
/**
 * Strip a leading CLI-bin alias (`buff`, `agent-nuvira`, `nuvira`) from argv.
 * Manifest commands carry the human-facing `buff` prefix, but the spawn target
 * is `node dist/index.js <subcommand>` — a stray prefix would make the CLI
 * print root help instead of running the command.
 */
export function stripCliPrefix(argv) {
    if (argv[0] === 'buff' || argv[0] === 'agent-nuvira' || argv[0] === 'nuvira') {
        return argv.slice(1);
    }
    return argv;
}
/** Split a command string into argv, honoring double/single quotes. */
export function splitCommand(command) {
    const args = [];
    let cur = '';
    let quote = null;
    for (const ch of String(command ?? '').trim()) {
        if (quote) {
            if (ch === quote)
                quote = null;
            else
                cur += ch;
        }
        else if (ch === '"' || ch === "'") {
            quote = ch;
        }
        else if (/\s/.test(ch)) {
            if (cur) {
                args.push(cur);
                cur = '';
            }
        }
        else {
            cur += ch;
        }
    }
    if (cur)
        args.push(cur);
    return args;
}
/**
 * Run the run_cli tool — returns model-feedable text (never throws).
 */
export async function runCliTool(args, ctx) {
    const { runCliSchema } = await import('./registry.js');
    let ask = '';
    let confirm = false;
    try {
        const parsed = runCliSchema.parse(args);
        ask = parsed.ask;
        confirm = parsed.confirm ?? false;
    }
    catch (err) {
        return `run_cli: missing/invalid arguments — expected { ask, confirm? }. ${err instanceof Error ? err.message.split('\n')[0] : ''}`.trim();
    }
    const matches = resolveAsk(ask);
    const top = matches[0];
    if (!top) {
        return (`run_cli: could not map "${ask}" to a known intent. Tell the user no matching ` +
            `capability was found and suggest checking 'nuvira doctor' or docs/COMMANDS.md.`);
    }
    // Ambiguous → ask the user which they mean (never guess).
    if (top.ambiguous && top.options?.length) {
        const choices = top.options
            .map((o) => `- "${o.when}" → \`${o.command}\``)
            .join('\n');
        return (`run_cli: the ask "${ask}" is AMBIGUOUS — it maps to more than one command. ` +
            `Call ask_user with 2 choices (one per option below), then re-call run_cli with the ` +
            `resolved command phrased unambiguously:\n${choices}`);
    }
    const command = top.command;
    if (!command) {
        return `run_cli: intent "${top.intent}" has no executable command — tell the user to run the equivalent step manually.`;
    }
    // Confirmation gate — destructive/system-level intents need user sign-off.
    if (top.confirmation && !confirm) {
        return (`run_cli: "${top.intent}" changes running services/state and needs explicit confirmation. ` +
            `Call ask_user with choices yes/no confirming this exact command, then re-call ` +
            `run_cli with the SAME ask plus confirm: true only if the user agreed:\n` +
            `\`${command}\``);
    }
    // Execute the manifest-resolved command as a child process (the real CLI).
    const entry = cliEntry();
    if (!existsSync(entry)) {
        return `run_cli: CLI entry not found at ${entry} — build the project first (npm run build).`;
    }
    const argv = stripCliPrefix(splitCommand(command));
    if (argv.length === 0)
        return `run_cli: empty command resolved for intent "${top.intent}".`;
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [entry, ...argv], {
            cwd: process.cwd(),
            env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
            try {
                child.kill('SIGTERM');
            }
            catch {
                /* best-effort */
            }
        }, TOOL_TIMEOUT_MS);
        child.stdout?.on('data', (b) => {
            out += b.toString('utf-8');
            if (out.length > MAX_OUTPUT_CHARS * 2)
                out = out.slice(-MAX_OUTPUT_CHARS * 2);
        });
        child.stderr?.on('data', (b) => {
            err += b.toString('utf-8');
            if (err.length > MAX_OUTPUT_CHARS)
                err = err.slice(-MAX_OUTPUT_CHARS);
        });
        child.on('error', (e) => {
            clearTimeout(timer);
            resolve(`run_cli: failed to spawn CLI — ${e.message}`);
        });
        child.on('exit', (code) => {
            clearTimeout(timer);
            const body = (out || err).trim().slice(0, MAX_OUTPUT_CHARS);
            const masked = maskSenderId(body);
            const status = code === 0 ? '✅ succeeded' : `❌ failed (exit ${code ?? '?'})`;
            resolve(`run_cli: \`${command}\` ${status}.\n` +
                (masked ? `Output:\n${masked}` : '(no output)'));
        });
    });
}
//# sourceMappingURL=run-cli.js.map