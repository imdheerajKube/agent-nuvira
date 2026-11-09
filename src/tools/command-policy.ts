/**
 * The USER-OWNED command policy.
 *
 * WHY THIS EXISTS. The built-in deny list in `run-terminal.ts` is a safety
 * floor, but it was also the only way to change what the agent may run: a user
 * who wanted `git push` or `kill -9` available had to edit source. A deny is
 * unpromptable, so a wrong entry there does not ask — it refuses forever.
 *
 * FILE: `<config dir>/command-policy.json` (honours `NUVIRA_CONFIG_DIR`), or the
 * path in `NUVIRA_COMMAND_POLICY`. Three lists of command PREFIXES:
 *
 *   {
 *     "allow":   ["kill"],                 // run WITHOUT asking (user pre-authorises)
 *     "approve": ["git push", "kill -9"],  // ask ONCE, then the session grant covers it
 *     "deny":    ["rm -rf build"]          // never run, whatever the request says
 *   }
 *
 * PRECEDENCE: policy deny > built-in deny (relaxed by allow/approve) > allow >
 * the built-in class. On a command the BUILT-IN floor denies, both `approve`
 * and `allow` downgrade it to `confirm` — one human approval, never silence:
 * `allow` records "the user is fine with this", which is not the same claim as
 * "this is safe", and an entry that silently did nothing would be a trap (the
 * file says allowed while the tool keeps refusing). Neither can reach a command
 * this same policy DENIES — that wins first.
 *
 * Prefixes match at a COMMAND POSITION (start, a shell separator, `$(`), not as
 * a substring, so `git push` does not match `grep "git push"` the way the old
 * word-anywhere rules did.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveBuffConfigDir } from '../config/paths.js';
import { logger } from '../utils/logger.js';

/** What a policy entry does to a command. */
export type CommandPolicyKind = 'allow' | 'approve' | 'deny';

/** The policy entry that decided a command (longest matching prefix). */
export interface CommandPolicyMatch {
  kind: CommandPolicyKind;
  prefix: string;
}

export interface CommandPolicy {
  allow: string[];
  approve: string[];
  deny: string[];
}

const EMPTY: CommandPolicy = { allow: [], approve: [], deny: [] };

/** The policy file this process reads (env override → active config dir). */
export function commandPolicyFile(): string {
  const explicit = (process.env.NUVIRA_COMMAND_POLICY ?? process.env.BUFF_COMMAND_POLICY ?? '').trim();
  return explicit || join(resolveBuffConfigDir(), 'command-policy.json');
}

interface CacheEntry {
  file: string;
  mtimeMs: number;
  size: number;
  policy: CommandPolicy;
}

let cache: CacheEntry | null = null;
let warnedFor = '';

/** Normalize for comparison only — policy prefixes are matched lowercased. */
export function normalizeCommandForPolicy(command: string): string {
  return String(command ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const prefix = normalizeCommandForPolicy(entry);
    if (prefix && prefix.length <= 200) out.push(prefix);
  }
  return out;
}

/**
 * Read the policy, cached by (path, mtime, size) so an edit takes effect on the
 * next command without restarting the process. A missing file means "no user
 * policy"; a MALFORMED file is reported once and treated as empty rather than
 * trusted — an unreadable policy must never silently become permissive.
 */
export function loadCommandPolicy(): CommandPolicy {
  const file = commandPolicyFile();
  if (!existsSync(file)) {
    cache = null;
    return EMPTY;
  }
  try {
    const st = statSync(file);
    if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
      return cache.policy;
    }
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    const policy: CommandPolicy = {
      allow: cleanList(raw.allow),
      approve: cleanList(raw.approve),
      deny: cleanList(raw.deny),
    };
    cache = { file, mtimeMs: st.mtimeMs, size: st.size, policy };
    if (warnedFor === file) warnedFor = '';
    return policy;
  } catch (err) {
    if (warnedFor !== file) {
      warnedFor = file;
      logger.warn(
        `command-policy: could not read ${file} (${err instanceof Error ? err.message : String(err)}) ` +
          '— using the built-in policy.',
      );
    }
    return EMPTY;
  }
}

/** Test hook: forget the cached policy (and the once-per-file warning). */
export function resetCommandPolicyCache(): void {
  cache = null;
  warnedFor = '';
}

/** A command position, optionally after env assignments — same shape the deny list uses. */
const CMD_PREFIX = '(?:^|[;&|()`{}])\\s*(?:[a-z_][a-z0-9_]*=\\S*\\s+)*';

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function atCommandPosition(lower: string, prefix: string): boolean {
  return new RegExp(`${CMD_PREFIX}${escapeRe(prefix)}(?=\\s|$|[;&|)}])`).test(lower);
}

/**
 * The policy entry that decides this command, or null when the user has not
 * spoken about it. Longest prefix wins within a kind; kinds are ordered
 * deny → approve → allow so an explicit refusal always beats a permission.
 */
export function matchCommandPolicy(command: string): CommandPolicyMatch | null {
  const lower = normalizeCommandForPolicy(command);
  if (!lower) return null;
  const policy = loadCommandPolicy();
  for (const kind of ['deny', 'approve', 'allow'] as const) {
    const prefixes = [...policy[kind]].sort((a, b) => b.length - a.length);
    for (const prefix of prefixes) {
      if (atCommandPosition(lower, prefix)) return { kind, prefix };
    }
  }
  return null;
}

/** The refusal reason when the USER's own policy denies this command. */
export function describePolicyDenial(command: string): string | undefined {
  const match = matchCommandPolicy(command);
  return match?.kind === 'deny' ? `your command policy (deny: "${match.prefix}")` : undefined;
}

/** ─── Writing the policy (CLI + dashboard share this) ─────────────────────── */

/** Why an entry cannot be used, or undefined when it is fine. */
export function commandPolicyEntryError(input: unknown): string | undefined {
  if (typeof input !== 'string') return 'must be a string';
  if (/[\r\n]/.test(input)) return 'must be a single line';
  const prefix = normalizeCommandForPolicy(input);
  if (!prefix) return 'is empty';
  if (prefix.length > 200) return 'is longer than 200 characters';
  return undefined;
}

/** One prefix per list, no duplicates, and no prefix in two lists at once. */
function dedupeAcrossLists(policy: CommandPolicy): CommandPolicy {
  const out: CommandPolicy = { allow: [], approve: [], deny: [] };
  const seen = new Set<string>();
  // Highest precedence first: a prefix the user also denied stays denied.
  for (const kind of ['deny', 'approve', 'allow'] as const) {
    for (const prefix of policy[kind]) {
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      out[kind].push(prefix);
    }
  }
  return out;
}

export interface CommandPolicyWriteResult {
  ok: boolean;
  error?: string;
  file?: string;
  policy?: CommandPolicy;
  /** The normalized prefix an add/remove acted on. */
  prefix?: string;
  /** Which lists a remove actually changed. */
  removed?: CommandPolicyKind[];
}

/**
 * Validate and write the policy atomically (0600), then drop the cache so the
 * next command in THIS process sees the new file. The 0600 mode matches the
 * other user-owned config files: a policy is not a secret, but it is not
 * world-editable either.
 */
export function writeCommandPolicy(input: Partial<Record<CommandPolicyKind, unknown>>): CommandPolicyWriteResult {
  const file = commandPolicyFile();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'The policy must be an object with allow / approve / deny lists.' };
  }
  // A body with no list at all is a mistake, not "clear everything": an empty
  // PUT must not be able to wipe a policy the user cannot see in the request.
  if (!('allow' in input) && !('approve' in input) && !('deny' in input)) {
    return { ok: false, error: 'Expected at least one of allow / approve / deny.' };
  }
  const lists: CommandPolicy = { allow: [], approve: [], deny: [] };
  for (const kind of ['allow', 'approve', 'deny'] as const) {
    const raw = input[kind];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) {
      return { ok: false, error: `"${kind}" must be an array of command prefixes.` };
    }
    for (const entry of raw) {
      const problem = commandPolicyEntryError(entry);
      if (problem) return { ok: false, error: `${JSON.stringify(entry)} ${problem}.` };
      lists[kind].push(normalizeCommandForPolicy(entry as string));
    }
  }
  const policy = dedupeAcrossLists(lists);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best-effort on filesystems without POSIX modes */
    }
  } catch (err) {
    return { ok: false, error: `could not write ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
  resetCommandPolicyCache();
  return { ok: true, file, policy };
}

/** The file's state, INCLUDING a parse error — `loadCommandPolicy()` hides one. */
export interface CommandPolicyStatus {
  file: string;
  exists: boolean;
  policy: CommandPolicy;
  error?: string;
}

export function commandPolicyStatus(): CommandPolicyStatus {
  const file = commandPolicyFile();
  if (!existsSync(file)) return { file, exists: false, policy: { ...EMPTY } };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    return {
      file,
      exists: true,
      policy: {
        allow: cleanList(raw.allow),
        approve: cleanList(raw.approve),
        deny: cleanList(raw.deny),
      },
    };
  } catch (err) {
    return {
      file,
      exists: true,
      policy: { ...EMPTY },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Read for a WRITE. A malformed file is never silently replaced: the entries are
 * unreadable, so writing over them would destroy a policy the user meant to
 * keep. The caller is told to fix or clear it instead.
 */
function policyForWrite(): { policy: CommandPolicy; error?: string } {
  const status = commandPolicyStatus();
  if (status.error) {
    return {
      policy: { ...EMPTY },
      error: `${status.file} could not be read (${status.error}) — fix or clear it first; refusing to overwrite it.`,
    };
  }
  return { policy: status.policy };
}

/** Add a prefix to one list, removing it from the other two (one place only). */
export function addCommandPolicyEntry(kind: CommandPolicyKind, input: string): CommandPolicyWriteResult {
  const problem = commandPolicyEntryError(input);
  if (problem) return { ok: false, error: `${JSON.stringify(input)} ${problem}.` };
  const prefix = normalizeCommandForPolicy(input);
  const { policy, error } = policyForWrite();
  if (error) return { ok: false, error };
  const next: CommandPolicy = {
    allow: policy.allow.filter((p) => p !== prefix),
    approve: policy.approve.filter((p) => p !== prefix),
    deny: policy.deny.filter((p) => p !== prefix),
  };
  next[kind].push(prefix);
  const written = writeCommandPolicy(next);
  return { ...written, prefix };
}

/** Remove a prefix from every list; reports which ones it was in. */
export function removeCommandPolicyEntry(input: string): CommandPolicyWriteResult {
  const problem = commandPolicyEntryError(input);
  if (problem) return { ok: false, error: `${JSON.stringify(input)} ${problem}.` };
  const prefix = normalizeCommandForPolicy(input);
  const { policy, error } = policyForWrite();
  if (error) return { ok: false, error };
  const removed = (['allow', 'approve', 'deny'] as const).filter((k) => policy[k].includes(prefix));
  if (removed.length === 0) return { ok: true, prefix, removed: [], file: commandPolicyFile(), policy };
  const next: CommandPolicy = {
    allow: policy.allow.filter((p) => p !== prefix),
    approve: policy.approve.filter((p) => p !== prefix),
    deny: policy.deny.filter((p) => p !== prefix),
  };
  const written = writeCommandPolicy(next);
  return { ...written, prefix, removed };
}

/** Clear one list, or delete the file entirely (no kind) — back to the defaults. */
export function clearCommandPolicy(kind?: CommandPolicyKind): CommandPolicyWriteResult {
  const file = commandPolicyFile();
  if (!kind) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch (err) {
      return { ok: false, error: `could not remove ${file}: ${err instanceof Error ? err.message : String(err)}` };
    }
    resetCommandPolicyCache();
    return { ok: true, file, policy: { ...EMPTY } };
  }
  const { policy, error } = policyForWrite();
  if (error) return { ok: false, error };
  return writeCommandPolicy({ ...policy, [kind]: [] });
}
