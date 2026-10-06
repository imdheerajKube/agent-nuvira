/**
 * Hook contract (`src/gateway/hook-contract.ts`).
 *
 * WHY THIS EXISTS. Third-party plugins in the Claude Code ecosystem assume a
 * hook contract (`SessionStart`, `PreToolUse`, …) that runs THEIR code. nuvira
 * deliberately has no remote-code hook API — that is a remote-execution surface
 * (see `docs/DESIGN-skill-plugin-ecosystem.md` §5.2/§6). But the *value* people
 * want from hooks is real, and nuvira already fires four lifecycle seams
 * internally (`src/gateway/hooks.ts`). This module is the missing half: a
 * DECLARATIVE contract an operator can write from the dashboard, bound to those
 * existing seams, with a fixed allow-list of native actions.
 *
 * POSITIONING — what a hook IS and IS NOT here:
 *   - A hook is a RULE: "when <event> matches <when>, do <action>". Data, not code.
 *   - The action set is a fixed allow-list enforced natively by nuvira
 *     ({@link HookActionKind}). There is deliberately no `run-command`, no
 *     `script`, no `mcp`. A hook can DENY a tool call, NOTIFY, or SCAN the call's
 *     arguments for secret shapes — nothing else.
 *   - Therefore installing a hook can never execute third-party code, and the
 *     worst a rogue declaration can do is block a call or log a line. That is
 *     the whole reason this is safe to expose to an operator.
 *
 * HOW IT WORKS (the four seams are defined in hooks.ts; this module binds to them):
 *   before_tool_call  → can `deny` (veto) or `notify` or `scan-args` (+deny-on-hit)
 *   after_tool_call   → `notify` or `scan-args` on the result
 *   failed_tool_call  → `notify` on the failure
 *   on_session_end    → `notify` with the run's summary
 *
 * Declarations persist as JSON at `<config-dir>/hooks.json` and are reloaded in
 * memory on every save, so a dashboard edit takes effect without a restart. One
 * handler per event is registered on the shared registry; it reads the current
 * declarations on each call. Enforcement FAILS OPEN exactly like the underlying
 * registry: a broken declaration is reported, never fatal.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { resolveBuffConfigDir } from '../config/paths.js';
import { logger } from '../utils/logger.js';
import { scanText } from '../security/secret-scan.js';
import type { HookDecision, HookEvent } from './hooks.js';

// Re-exported so callers (the CLI, the dashboard types mirror) can name a seam
// without reaching into the registry module.
export type { HookEvent };

// ─── The allow-list ─────────────────────────────────────────────────────────

/** The four lifecycle seams, in the order the runtime fires them. */
export const HOOK_EVENTS: HookEvent[] = [
  'before_tool_call',
  'after_tool_call',
  'failed_tool_call',
  'on_session_end',
];

/** One human sentence per seam — shown verbatim in the dashboard. */
export const HOOK_EVENT_DESCRIPTIONS: Record<HookEvent, string> = {
  before_tool_call: 'Runs BEFORE a tool call. The only seam that can DENY (stop) the call.',
  after_tool_call: 'Runs after a tool call SUCCEEDS, with the result text and duration.',
  failed_tool_call: 'Runs after a tool call FAILS (threw, or returned a failure), with the error.',
  on_session_end: 'Runs when a pipeline run finishes, with its success flag and summary.',
};

/**
 * The action allow-list. This union IS the contract's entire power: adding a
 * member here is the only way to give hooks a new capability, and every member
 * is implemented natively below.
 */
export type HookAction =
  /** Veto a call (before_tool_call only). */
  | { kind: 'deny'; reason?: string }
  /** Emit a line (all seams). `{tool}`/`{surface}`/`{event}` are interpolated. */
  | { kind: 'notify'; message: string }
  /** Scan the call's args (or result) for secret shapes. Tool seams only. */
  | { kind: 'scan-args'; denyOnHit?: boolean; reason?: string };

export type HookActionKind = HookAction['kind'];

export const HOOK_ACTION_KINDS: HookActionKind[] = ['deny', 'notify', 'scan-args'];

export const HOOK_ACTION_DESCRIPTIONS: Record<HookActionKind, string> = {
  deny: 'Stop the tool call. Only available on before_tool_call.',
  notify: 'Write a line to the log (with {tool} / {surface} / {event} interpolated).',
  'scan-args': 'Scan the call arguments (or the tool result) for secret-shaped values.',
};

/** A shallow matcher over the call context. An absent field matches anything. */
export interface HookMatcher {
  /** Glob over the tool name: `run_terminal`, `edit_*`, `*`. */
  tool?: string;
  /** Glob over the surface label (`cli-chat`, `subagent`, …). */
  surface?: string;
  /** Prefix match on the working directory. */
  cwdPrefix?: string;
  /** Shallow arg checks: arg name → glob over the stringified value. */
  argsMatch?: Record<string, string>;
}

/** One declared hook. */
export interface HookDeclaration {
  /** Stable slug, unique within the file. */
  id: string;
  /** Human label shown in the dashboard. */
  label: string;
  event: HookEvent;
  enabled: boolean;
  /** Optional matcher; absent means "every call of this seam". */
  when?: HookMatcher;
  action: HookAction;
  /** Where it came from: 'user' (dashboard/CLI) or 'builtin'. */
  source?: 'user' | 'builtin';
  /** Epoch ms, best-effort metadata. */
  updatedAt?: number;
}

// ─── Built-in starter hooks ─────────────────────────────────────────────────

/**
 * The STARTER set. These ship DISABLED — nothing changes until an operator
 * turns one on. They exist so the Hooks page and `nuvira hooks` open on working
 * examples instead of an empty form, and they cover the two asks that motivated
 * the feature: stop a destructive `rm -rf`, and catch a secret at the moment it
 * would be written or run.
 *
 * A built-in is a DEFAULT, not a `hooks.json` entry: it is merged into what the
 * dashboard and CLI DISPLAY (see {@link listHookDeclarations}) but is only
 * written to disk once an operator edits or enables it. That keeps a shipped
 * default correctable in a later release without a stale copy shadowing it. Ids
 * are namespaced (`builtin-…`) so a user hook can override one deliberately.
 */
export const BUILTIN_HOOK_DECLARATIONS: HookDeclaration[] = [
  {
    id: 'builtin-block-rm-rf',
    label: 'Block `rm -rf`',
    event: 'before_tool_call',
    enabled: false,
    source: 'builtin',
    when: { tool: 'run_terminal', argsMatch: { command: '*rm -rf*' } },
    action: {
      kind: 'deny',
      reason: 'Recursive force delete is refused by the built-in "builtin-block-rm-rf" hook. Delete specific paths instead, or disable the hook to allow this.',
    },
  },
  {
    id: 'builtin-scan-writes-for-secrets',
    label: 'Block writes that contain a secret',
    event: 'before_tool_call',
    enabled: false,
    source: 'builtin',
    when: { tool: 'write_file' },
    action: {
      kind: 'scan-args',
      denyOnHit: true,
      reason: 'A secret-shaped value is in the content about to be written — refusing to write it to disk. Values are masked in the report.',
    },
  },
  {
    id: 'builtin-scan-terminal-args-for-secrets',
    label: 'Flag secrets in terminal commands',
    event: 'before_tool_call',
    enabled: false,
    source: 'builtin',
    when: { tool: 'run_terminal' },
    action: { kind: 'scan-args', denyOnHit: false },
  },
  {
    id: 'builtin-notify-tool-failures',
    label: 'Log every failed tool call',
    event: 'failed_tool_call',
    enabled: false,
    source: 'builtin',
    action: { kind: 'notify', message: '{tool} failed — see the tool result for details.' },
  },
];

/** A deep copy of a declaration, so a caller cannot mutate the shipped default. */
function cloneDeclaration(hook: HookDeclaration): HookDeclaration {
  return {
    ...hook,
    when: hook.when
      ? { ...hook.when, argsMatch: hook.when.argsMatch ? { ...hook.when.argsMatch } : undefined }
      : undefined,
    action: { ...hook.action },
  };
}

/** The built-in starter set, cloned (safe to hand to a caller or editor). */
export function builtinHookDeclarations(): HookDeclaration[] {
  return BUILTIN_HOOK_DECLARATIONS.map(cloneDeclaration);
}

/** One built-in by id, cloned, or undefined. */
export function builtinHookById(id: string): HookDeclaration | undefined {
  const found = BUILTIN_HOOK_DECLARATIONS.find((h) => h.id === id);
  return found ? cloneDeclaration(found) : undefined;
}

/**
 * Merge the shipped built-ins with a set of user declarations. A user entry with
 * the same id WINS, so an operator can override a built-in deliberately.
 * Built-ins come first (they are the defaults) and, being disabled by default,
 * simply never fire.
 */
export function mergeHookDeclarations(user: HookDeclaration[]): HookDeclaration[] {
  const overridden = new Set(user.map((h) => h.id));
  const builtins = builtinHookDeclarations().filter((h) => !overridden.has(h.id));
  return [...builtins, ...user];
}

// ─── Validation ─────────────────────────────────────────────────────────────

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const matcherSchema = z
  .object({
    tool: z.string().max(120).optional(),
    surface: z.string().max(120).optional(),
    cwdPrefix: z.string().max(512).optional(),
    argsMatch: z.record(z.string(), z.string().max(200)).optional(),
  })
  .strict();

const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('deny'), reason: z.string().max(500).optional() }).strict(),
  z.object({ kind: z.literal('notify'), message: z.string().min(1).max(500) }).strict(),
  z.object({
    kind: z.literal('scan-args'),
    denyOnHit: z.boolean().optional(),
    reason: z.string().max(500).optional(),
  }).strict(),
]);

const declarationSchema = z
  .object({
    id: z.string().regex(ID_RE, 'id must be lowercase letters, digits and hyphens (e.g. "block-rm-rf")'),
    label: z.string().min(1).max(120),
    event: z.enum(['before_tool_call', 'after_tool_call', 'failed_tool_call', 'on_session_end']),
    enabled: z.boolean(),
    when: matcherSchema.optional(),
    action: actionSchema,
    source: z.enum(['user', 'builtin']).optional(),
    updatedAt: z.number().optional(),
  })
  .strict();

/**
 * Validate one declaration.
 *
 * Beyond field shapes this enforces the two cross-field rules of the contract,
 * because both would otherwise be silent no-ops:
 *   - `deny` is only meaningful on `before_tool_call` (the other seams cannot
 *     stop anything), so it is rejected elsewhere rather than ignored;
 *   - `scan-args` is about a tool call, so it is rejected on `on_session_end`.
 */
export function validateHookDeclaration(value: unknown): { ok: true; hook: HookDeclaration } | { ok: false; error: string } {
  const parsed = declarationSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'hook'}: ${i.message}`).join('; ') };
  }
  const hook = parsed.data as HookDeclaration;
  if (hook.action.kind === 'deny' && hook.event !== 'before_tool_call') {
    return { ok: false, error: `"${hook.id}": deny is only available on before_tool_call (${hook.event} cannot stop a call).` };
  }
  if (hook.action.kind === 'scan-args' && hook.event === 'on_session_end') {
    return { ok: false, error: `"${hook.id}": scan-args needs a tool call, not on_session_end.` };
  }
  return { ok: true, hook };
}

/** Validate a whole list, catching duplicate ids. */
export function validateHookDeclarations(
  value: unknown,
): { ok: true; declarations: HookDeclaration[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: 'hooks must be an array.' };
  const out: HookDeclaration[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const res = validateHookDeclaration(item);
    if (!res.ok) return { ok: false, error: res.error };
    if (seen.has(res.hook.id)) return { ok: false, error: `duplicate hook id: "${res.hook.id}".` };
    seen.add(res.hook.id);
    out.push(res.hook);
  }
  return { ok: true, declarations: out };
}

// ─── Matching ───────────────────────────────────────────────────────────────

/** Compile a glob (`*` only) to a case-insensitive anchored regex. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** True when `glob` matches `value` (missing value only matches a bare `*`). */
export function globMatches(glob: string, value: string | undefined): boolean {
  if (value === undefined || value === '') return glob === '*';
  return globToRegExp(glob).test(value);
}

function stringifyArg(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * Does this declaration's `when` match the call context? A context is `any`
 * because the four seams carry different fields; only the fields a matcher
 * names are read, which keeps the predicate identical across seams.
 */
export function matchesHookDeclaration(hook: HookDeclaration, ctx: any): boolean {
  const when = hook.when;
  if (!when) return true;
  if (when.tool !== undefined && !globMatches(when.tool, typeof ctx?.tool === 'string' ? ctx.tool : '')) return false;
  if (when.surface !== undefined && !globMatches(when.surface, typeof ctx?.surface === 'string' ? ctx.surface : '')) return false;
  if (when.cwdPrefix !== undefined) {
    const cwd = typeof ctx?.cwd === 'string' ? ctx.cwd : '';
    if (!cwd.startsWith(when.cwdPrefix)) return false;
  }
  if (when.argsMatch) {
    for (const [key, glob] of Object.entries(when.argsMatch)) {
      const arg = ctx?.args && typeof ctx.args === 'object' ? (ctx.args as Record<string, unknown>)[key] : undefined;
      if (!globMatches(glob, stringifyArg(arg))) return false;
    }
  }
  return true;
}

// ─── Evaluation (the native action implementations) ─────────────────────────

function interpolate(template: string, hook: HookDeclaration, ctx: any): string {
  return template
    .replace(/\{tool\}/g, typeof ctx?.tool === 'string' ? ctx.tool : '')
    .replace(/\{surface\}/g, typeof ctx?.surface === 'string' ? ctx.surface : '')
    .replace(/\{event\}/g, hook.event);
}

/** Scan a text blob for secret shapes; returns a human count summary or null. */
function scanForSecrets(hook: HookDeclaration, text: string): string | null {
  if (!text) return null;
  try {
    const hits = scanText(text, `hook:${hook.id}`);
    if (hits.length === 0) return null;
    const kinds = [...new Set(hits.map((h) => h.label))].join(', ');
    return `${hits.length} secret-shaped value(s) (${kinds}) — values masked.`;
  } catch {
    return null;
  }
}

/**
 * Apply one declaration's action to a context.
 *
 * Returns a {@link HookDecision} only when the action is a `deny` (or a
 * `scan-args` hit with `denyOnHit` on `before_tool_call`). Every other action
 * is a side effect (a log line, a `report` note) and returns null, so the
 * registry's "first denial wins" rule is preserved exactly.
 */
export function applyHookDeclaration(hook: HookDeclaration, ctx: any): HookDecision | null {
  if (!hook.enabled) return null;
  if (!matchesHookDeclaration(hook, ctx)) return null;

  switch (hook.action.kind) {
    case 'notify': {
      const message = interpolate(hook.action.message, hook, ctx);
      logger.info(`hook '${hook.id}': ${message}`);
      ctx?.report?.(`hook '${hook.id}': ${message}`);
      return null;
    }
    case 'deny': {
      const reason = hook.action.reason ? interpolate(hook.action.reason, hook, ctx) : undefined;
      return { deny: true, reason: reason ?? `blocked by hook '${hook.id}'`, by: `hook:${hook.id}` };
    }
    case 'scan-args': {
      // Scan the arguments before a call, or the result after a call.
      const payload =
        hook.event === 'before_tool_call'
          ? stringifyArg(ctx?.args)
          : typeof ctx?.result === 'string'
            ? ctx.result
            : stringifyArg(ctx?.args);
      const summary = scanForSecrets(hook, payload);
      if (!summary) return null;
      const message = `hook '${hook.id}': ${summary}`;
      if (hook.action.denyOnHit && hook.event === 'before_tool_call') {
        const reason = hook.action.reason ? interpolate(hook.action.reason, hook, ctx) : `${summary} — blocked before running.`;
        return { deny: true, reason, by: `hook:${hook.id}` };
      }
      logger.warn(message);
      ctx?.report?.(message);
      return null;
    }
    default:
      return null;
  }
}

/** Evaluate every declaration for one event; returns the first denial or null. */
export function evaluateDeclarations(declarations: HookDeclaration[], event: HookEvent, ctx: any): HookDecision | null {
  for (const hook of declarations) {
    if (hook.event !== event) continue;
    const decision = applyHookDeclaration(hook, ctx);
    if (decision) return decision;
  }
  return null;
}

// ─── Persistence ────────────────────────────────────────────────────────────

/** `<config-dir>/hooks.json` (NUVIRA_CONFIG_DIR aware, like contacts.json). */
export function hookDeclarationsFile(): string {
  return join(resolveBuffConfigDir(), 'hooks.json');
}

/** Read declarations from disk. Missing/corrupt → [] (never throws). */
export function readHookDeclarations(): HookDeclaration[] {
  try {
    const parsed = JSON.parse(readFileSync(hookDeclarationsFile(), 'utf-8')) as { hooks?: unknown };
    const validated = validateHookDeclarations(parsed.hooks ?? []);
    return validated.ok ? validated.declarations : [];
  } catch {
    return [];
  }
}

/** Persist declarations (best-effort — a failed write never breaks the caller). */
export function writeHookDeclarations(declarations: HookDeclaration[]): void {
  try {
    const file = hookDeclarationsFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, hooks: declarations }, null, 2), 'utf-8');
  } catch {
    /* best-effort */
  }
}

// ─── In-memory registry (the runtime reads this) ────────────────────────────

let declarations: HookDeclaration[] = [];
let loadedOnce = false;

/** The declarations currently in force (loads from disk on first use). */
export function getHookDeclarations(): HookDeclaration[] {
  if (!loadedOnce) {
    declarations = readHookDeclarations();
    loadedOnce = true;
  }
  return declarations;
}

/**
 * The list to DISPLAY (dashboard + CLI): the built-in starter set merged with
 * the in-force user declarations. The runtime evaluates only
 * {@link getHookDeclarations}; built-ins reach it once an operator enables one
 * (which persists it, so it then appears in the user set too).
 */
export function listHookDeclarations(): HookDeclaration[] {
  return mergeHookDeclarations(getHookDeclarations());
}

/**
 * Replace the in-force declarations. Validates first; on success persists and
 * swaps the in-memory list (so the next tool call sees the change). Returns the
 * validation error unchanged on failure — never a silent partial save.
 */
export function setHookDeclarations(next: unknown): { ok: true; declarations: HookDeclaration[] } | { ok: false; error: string } {
  const validated = validateHookDeclarations(next);
  if (!validated.ok) return validated;
  declarations = validated.declarations;
  loadedOnce = true;
  writeHookDeclarations(declarations);
  return { ok: true, declarations };
}

/** Test/CLI helper: drop the cache so the next read hits disk. */
export function resetHookDeclarationsCache(): void {
  declarations = [];
  loadedOnce = false;
}

// ─── Runtime installation ───────────────────────────────────────────────────

/** The minimal slice of the hook registry this module needs. */
export interface HookRegistrar {
  register(event: HookEvent, handler: (ctx: any) => void | HookDecision | Promise<void | HookDecision>): void;
}

let installedOn: HookRegistrar | null = null;

/**
 * Register one handler per seam on `registrar`. Idempotent per registrar
 * instance, so importing the gateway more than once cannot double-fire hooks.
 *
 * Each handler reads {@link getHookDeclarations} at call time, so an edit from
 * the dashboard is live on the next call without re-registering.
 */
export function installDeclaredHooks(registrar: HookRegistrar): void {
  if (installedOn === registrar) return;
  installedOn = registrar;
  getHookDeclarations(); // warm from disk

  registrar.register('before_tool_call', (ctx) => evaluateDeclarations(getHookDeclarations(), 'before_tool_call', ctx) ?? undefined);
  registrar.register('after_tool_call', (ctx) => {
    evaluateDeclarations(getHookDeclarations(), 'after_tool_call', ctx);
    return undefined;
  });
  registrar.register('failed_tool_call', (ctx) => {
    evaluateDeclarations(getHookDeclarations(), 'failed_tool_call', ctx);
    return undefined;
  });
  registrar.register('on_session_end', (ctx) => {
    evaluateDeclarations(getHookDeclarations(), 'on_session_end', ctx);
    return undefined;
  });
}

/** Test helper: forget which registrar was installed. */
export function resetDeclaredHooksInstall(): void {
  installedOn = null;
}
