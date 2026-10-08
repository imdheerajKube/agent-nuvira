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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolContext } from './registry.js';
import { recordArtifact } from './artifact-append.js';
import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { resolveAsk } from '../commands/intent-router.js';
import { decideCliIntentConfirmation } from '../learning/autonomy-policy.js';
import { cliIntentGateFacts } from '../learning/cli-intent-effects.js';
import { envelopeCoversAction } from '../learning/intent-envelope.js';
import { sessionGrantCovers, type SessionGrantCategory } from '../learning/session-grant.js';
import { maskSenderId } from '../utils/mask.js';

/** Cap on how much CLI output is fed back to the model. */
const MAX_OUTPUT_CHARS = 6000;
/** CLI commands are quick; 60s is generous. */
const TOOL_TIMEOUT_MS = 60_000;

function repoRootDir(): string {
  // Compiled: dist/tools/run-cli.js → repo root is ../../.
  // Dev (tsx): src/tools/run-cli.ts → same ../../.
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function cliEntry(): string {
  return join(repoRootDir(), 'dist', 'index.js');
}

/**
 * Strip a leading CLI-bin alias (`buff`, `agent-nuvira`, `nuvira`) from argv.
 * Manifest commands carry the human-facing `buff` prefix, but the spawn target
 * is `node dist/index.js <subcommand>` — a stray prefix would make the CLI
 * print root help instead of running the command.
 */
export function stripCliPrefix(argv: string[]): string[] {
  if (argv[0] === 'buff' || argv[0] === 'agent-nuvira' || argv[0] === 'nuvira') {
    return argv.slice(1);
  }
  return argv;
}

/** Split a command string into argv, honoring double/single quotes. */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of String(command ?? '').trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        args.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) args.push(cur);
  return args;
}

/**
 * Persist one command's output as a log file under the memory dir.
 *
 * run_cli's deliverable is its OUTPUT, which has no file of its own — so the
 * artifact tab could never show one. Writing the captured output to a real log
 * file gives the artifact a path (and therefore a preview) without touching the
 * user's workspace. Best-effort: any failure just means no artifact.
 */
function writeCliLog(command: string, body: string): string | undefined {
  try {
    const memory = envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
    const dir = join(memory, 'cli-logs');
    mkdirSync(dir, { recursive: true });
    const slug = command.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'cli';
    const file = join(dir, `${Date.now()}-${slug}.log`);
    writeFileSync(file, `$ ${command}\n\n${body}\n`, 'utf-8');
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Run the run_cli tool — returns model-feedable text (never throws).
 */
export async function runCliTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { runCliSchema } = await import('./registry.js');
  let ask = '';
  let confirm = false;
  try {
    const parsed = runCliSchema.parse(args);
    ask = parsed.ask;
    confirm = parsed.confirm ?? false;
  } catch (err) {
    return `Error: run_cli: missing/invalid arguments — expected { ask, confirm? }. ${err instanceof Error ? err.message.split('\n')[0] : ''}`.trim();
  }

  const matches = resolveAsk(ask);
  const top = matches[0];
  if (!top) {
    return (
      `Error: run_cli: could not map "${ask}" to a known intent. Tell the user no matching ` +
      `capability was found and suggest checking 'nuvira doctor' or docs/COMMANDS.md.`
    );
  }

  // Ambiguous → ask the user which they mean (never guess).
  if (top.ambiguous && top.options?.length) {
    const choices = top.options
      .map((o) => `- "${o.when}" → \`${o.command}\``)
      .join('\n');
    return (
      `Error: run_cli: the ask "${ask}" is AMBIGUOUS — it maps to more than one command. ` +
      `Call ask_user with 2 choices (one per option below), then re-call run_cli with the ` +
      `resolved command phrased unambiguously:\n${choices}`
    );
  }

  const command = top.command;
  if (!command) {
    return `Error: run_cli: intent "${top.intent}" has no executable command — tell the user to run the equivalent step manually.`;
  }

  // ── G16: the gate's missing input is whether the USER asked for this ───────
  // The manifest flag says the ACTION is stateful; it does not say the user has
  // to approve what they just asked for. "Stop the dashboard" resolved to this
  // exact command is the authorization — asking again is the manual cadence.
  // Resolved with the SAME router the tool already used, so the tool's ask and
  // the user's ask are compared like for like, and only on an identical command.
  // Intents that cannot be undone (history.clear, memory.prune, publish, …) are
  // still always gated, however the request is phrased.
  let decidedAutonomously = false;
  let autonomyReason = '';
  if (top.confirmation && !confirm) {
    const namedByRequest = resolveAsk(ctx.authorizationRequest ?? '').some((m) => m.command === command);
    // Stage 3 — the durable grant is consulted first, and ONLY for the intents
    // the CLI policy itself classifies as RECOVERABLE. Everything else is handed
    // to the envelope as `destructive`, which it never covers, so this cannot
    // widen what may run: irreversible intents keep the gate they had, and this
    // only lets an approved plan carry out system work without a round trip per
    // command.
    // ONE declaration answers every question below — what it does to the world,
    // whether re-running undoes it, and which grant may cover it. See
    // `learning/cli-intent-effects.ts`; the three hand-maintained sets this used to
    // consult are retired.
    const gatedIntent = cliIntentGateFacts(top.intent);
    const envVerdict = envelopeCoversAction(ctx.envelope, {
      tool: 'run_cli',
      changeClass: gatedIntent.recoverable ? 'local-state' : 'destructive',
    });
    // A grant may only cover an intent the policy itself classifies as recoverable
    // or off-machine — NEVER an irreversible local one (`history.clear`,
    // `memory.prune`), which keeps its gate whatever the user granted.
    const grantCovers =
      (gatedIntent.external || gatedIntent.recoverable) &&
      sessionGrantCovers(ctx.planStore, gatedIntent.grantCategory ?? 'terminal');
    const verdict = envVerdict.covered || grantCovers
      ? {
          action: 'proceed' as const,
          reason: envVerdict.covered ? envVerdict.reason : 'allowed for this session by the user',
        }
      : decideCliIntentConfirmation({ intent: top.intent, namedByRequest });
    if (verdict.action !== 'proceed') {
      ctx.pendingConfirmation = {
        tool: 'run_cli',
        command,
        // Offer a session grant ONLY where one could actually help; an
        // irreversible local intent declares no category, so no grant is offered.
        ...((gatedIntent.external || gatedIntent.recoverable) && gatedIntent.grantCategory
          ? { category: gatedIntent.grantCategory as SessionGrantCategory }
          : {}),
      };
      return (
        `Error: run_cli: "${top.intent}" changes running services/state and needs explicit confirmation ` +
        `(${verdict.reason}). ` +
        `Call ask_user with choices yes/no confirming this exact command, then re-call ` +
        `run_cli with the SAME ask plus confirm: true only if the user agreed:\n` +
        `\`${command}\``
      );
    }
    decidedAutonomously = true;
    autonomyReason = verdict.reason;
    ctx.emit?.('autonomy:write-applied', {
      tool: 'run_cli',
      intent: top.intent,
      command,
      reason: verdict.reason,
    }, 'tool-loop');
  }

  // Execute the manifest-resolved command as a child process (the real CLI).
  const entry = cliEntry();
  if (!existsSync(entry)) {
    return `Error: run_cli: CLI entry not found at ${entry} — build the project first (npm run build).`;
  }
  const argv = stripCliPrefix(splitCommand(command));
  if (argv.length === 0) return `Error: run_cli: empty command resolved for intent "${top.intent}".`;

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
      } catch {
        /* best-effort */
      }
    }, TOOL_TIMEOUT_MS);
    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf-8');
      if (out.length > MAX_OUTPUT_CHARS * 2) out = out.slice(-MAX_OUTPUT_CHARS * 2);
    });
    child.stderr?.on('data', (b: Buffer) => {
      err += b.toString('utf-8');
      if (err.length > MAX_OUTPUT_CHARS) err = err.slice(-MAX_OUTPUT_CHARS);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(`run_cli: failed to spawn CLI — ${e.message}`);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const body = (out || err).trim().slice(0, MAX_OUTPUT_CHARS);
      // I3 — the output is the deliverable. Only when a sink exists (the
      // dashboard/CLI chat session) so a unit test or a bare run writes no
      // files. A command with nothing to say registers nothing.
      if (ctx.artifacts && body) {
        const logPath = writeCliLog(command, body);
        if (logPath) {
          recordArtifact(ctx.artifacts, {
            kind: 'log',
            title: `cli: ${command.slice(0, 70)}`,
            path: logPath,
            mime: 'text/plain',
          });
        }
      }
      const masked = maskSenderId(body);
      const status = code === 0 ? '✅ succeeded' : `❌ failed (exit ${code ?? '?'})`;
      const body2 =
        `run_cli: \`${command}\` ${status}.\n` +
        (masked ? `Output:\n${masked}` : '(no output)');
      resolve(
        decidedAutonomously
          ? `${body2}\n💡 Ran without asking: ${autonomyReason}. State the action plainly in your answer — ` +
              'do not ask for permission to do work the user already asked for.'
          : body2,
      );
    });
  });
}
