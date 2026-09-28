/**
 * Language Model tools — let VS Code's language model (Copilot Chat and any
 * other `vscode.lm` consumer) invoke Agent-Nuvira's agents.
 *
 * WHY: until now the extension was a one-way street — the user drove
 * Agent-Nuvira, and Agent-Nuvira drove the CLI. Nothing let the model *in the
 * editor* ask Agent-Nuvira to review a file or explain a selection. These tools
 * close that loop: they are contributed in `package.json` and registered here.
 *
 * COMPATIBILITY: the `vscode.lm.registerTool` API and its result classes are
 * only present on newer VS Code. This module feature-detects them and becomes a
 * no-op where they are missing, so the extension still installs and runs on the
 * older versions its `engines` field allows. The contribution points are simply
 * ignored by clients that don't understand them.
 *
 * Every failure is converted into a text result the model can read, because a
 * thrown error inside a tool surfaces to the user as an opaque chat failure.
 */

import * as vscode from 'vscode';
import type { CLIManager } from './cliManager.js';
import type { CLIResult } from './types.js';
import { log, logError } from './output.js';

// ─── Tool ids (must match package.json contributes.languageModelTools) ──────

export const LM_REVIEW_TOOL = 'agent-nuvira_reviewFile';
export const LM_EXPLAIN_TOOL = 'agent-nuvira_explainSelection';
export const LM_EXECUTE_TOOL = 'agent-nuvira_executeGoal';

// ─── Injectable API surface (feature-detected; injectable for tests) ────────

/** The subset of `vscode.lm` + result classes this module needs. */
export interface LmToolApi {
  registerTool(
    id: string,
    tool: { invoke(options: { input: Record<string, unknown> }, token: unknown): Promise<unknown> },
  ): vscode.Disposable;
  LanguageModelTextPart: new (text: string) => unknown;
  LanguageModelToolResult: new (parts: unknown[]) => unknown;
}

/**
 * Resolve the LM API from the injected surface or the live `vscode` namespace.
 * Returns null when the client does not support tools — the caller then no-ops.
 */
export function resolveLmApi(explicit?: LmToolApi): LmToolApi | null {
  if (explicit) {
    if (typeof explicit.registerTool !== 'function') return null;
    if (typeof explicit.LanguageModelToolResult !== 'function') return null;
    if (typeof explicit.LanguageModelTextPart !== 'function') return null;
    return explicit;
  }

  // Reading a namespace member that does not exist can THROW rather than yield
  // `undefined` (vitest's module mock does exactly that), so the probe is
  // guarded: "this VS Code is too old" must be a null return, not an exception
  // inside extension activation.
  let lm: { registerTool?: unknown } | undefined;
  let TextPart: unknown;
  let ToolResult: unknown;
  try {
    const ns = vscode as unknown as Record<string, unknown>;
    lm = ns.lm as { registerTool?: unknown } | undefined;
    TextPart = ns.LanguageModelTextPart;
    ToolResult = ns.LanguageModelToolResult;
  } catch {
    return null;
  }

  if (!lm || typeof lm.registerTool !== 'function') return null;
  if (typeof ToolResult !== 'function' || typeof TextPart !== 'function') return null;

  return {
    registerTool: (lm.registerTool as LmToolApi['registerTool']).bind(lm),
    LanguageModelTextPart: TextPart as LmToolApi['LanguageModelTextPart'],
    LanguageModelToolResult: ToolResult as LmToolApi['LanguageModelToolResult'],
  };
}

/** Build a text-only tool result. */
function textResult(api: LmToolApi, text: string): unknown {
  return new api.LanguageModelToolResult([new api.LanguageModelTextPart(text)]);
}

/** Render a CLI result as text the model can consume. */
function renderCliResult(r: CLIResult): string {
  const body = (r.stdout || '').trim() || (r.stderr || '').trim() || '(no output)';
  return r.success ? body : `Agent-Nuvira failed (exit ${r.exitCode ?? 'unknown'}):\n${body}`;
}

// ─── Tool implementations ───────────────────────────────────────────────────

function activeFilePath(): string | undefined {
  return vscode.window.activeTextEditor?.document.uri.fsPath;
}

/** Review a file (or the active file) with the reviewer agent. */
function reviewTool(api: LmToolApi, cliManager: CLIManager) {
  return {
    async invoke(options: { input: Record<string, unknown> }): Promise<unknown> {
      try {
        const filePath = typeof options.input.filePath === 'string' && options.input.filePath
          ? options.input.filePath
          : activeFilePath();
        if (!filePath) return textResult(api, 'No file was specified and no editor is active.');

        log(`LM tool: review ${filePath}`);
        return textResult(api, renderCliResult(await cliManager.reviewFile(filePath)));
      } catch (err) {
        logError(`LM review tool failed: ${err instanceof Error ? err.message : String(err)}`);
        return textResult(api, `Agent-Nuvira review failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** Explain a code snippet (or the current selection). */
function explainTool(api: LmToolApi, cliManager: CLIManager) {
  return {
    async invoke(options: { input: Record<string, unknown> }): Promise<unknown> {
      try {
        const editor = vscode.window.activeTextEditor;
        const inputCode = typeof options.input.code === 'string' ? options.input.code : '';
        const code = inputCode || editor?.document.getText(editor.selection) || '';
        if (!code.trim()) return textResult(api, 'No code was provided and nothing is selected.');

        log('LM tool: explain');
        return textResult(api, renderCliResult(await cliManager.explainCode(code, editor?.document.languageId)));
      } catch (err) {
        logError(`LM explain tool failed: ${err instanceof Error ? err.message : String(err)}`);
        return textResult(api, `Agent-Nuvira explain failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** Run a multi-agent goal. */
function executeTool(api: LmToolApi, cliManager: CLIManager) {
  return {
    async invoke(options: { input: Record<string, unknown> }): Promise<unknown> {
      try {
        const goal = typeof options.input.goal === 'string' ? options.input.goal.trim() : '';
        if (!goal) return textResult(api, 'A non-empty `goal` is required.');

        log(`LM tool: execute goal`);
        return textResult(api, renderCliResult(await cliManager.executeGoal(goal)));
      } catch (err) {
        logError(`LM execute tool failed: ${err instanceof Error ? err.message : String(err)}`);
        return textResult(api, `Agent-Nuvira execute failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * Register the Agent-Nuvira language model tools.
 *
 * @returns The disposables to add to `context.subscriptions` (empty when the
 *   client does not support LM tools).
 */
export function registerLanguageModelTools(
  cliManager: CLIManager,
  api: LmToolApi | null = resolveLmApi(),
): vscode.Disposable[] {
  if (!api) {
    log('Language Model tools unavailable on this VS Code version — skipping registration');
    return [];
  }

  const disposables: vscode.Disposable[] = [];
  const register = (id: string, tool: { invoke(options: { input: Record<string, unknown> }, token: unknown): Promise<unknown> }) => {
    try {
      disposables.push(api.registerTool(id, tool));
    } catch (err) {
      logError(`Failed to register LM tool ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  register(LM_REVIEW_TOOL, reviewTool(api, cliManager));
  register(LM_EXPLAIN_TOOL, explainTool(api, cliManager));
  register(LM_EXECUTE_TOOL, executeTool(api, cliManager));

  log(`Registered ${disposables.length} Language Model tool(s)`);
  return disposables;
}
