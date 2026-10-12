/**
 * MCP prerequisite probe — "what must exist before this server can run".
 *
 * WHY THIS EXISTS. The shipped catalog pinned npm specs that do not resolve
 * (`docs/mcp-assessment.md` §2: 4 of 6 entries E404'd), and the install path
 * could not tell a user why a server would never start: it wrote a config and
 * reported success. A capability slot now offers several WAYS to run the same
 * server (hosted remote, `npx`, a local binary, `uvx`, docker), and each way
 * declares what it needs. This module answers — locally, without spawning
 * anything — "on THIS machine, which of those ways can actually run, and what
 * is missing from the others".
 *
 * Two rules keep it honest:
 *   1. A probe never claims more than it checked. `command`/`env`/`file` are
 *      verified here. A version requirement satisfied by an alternate runtime
 *      binary is reported as PRESENT-BUT-UNVERIFIED (the version is established
 *      by the MCP handshake at connect time, not by guessing at install).
 *   2. Absence is never fatal by itself. The caller decides: the catalog shows
 *      the gap, `install` refuses only when NO variant can run.
 *
 * THE DOCKER CASE — why `service` exists. A CLI binary on PATH is not the same
 * as a working service. `docker` 29.7 was installed at /opt/homebrew/bin/docker
 * on the dev machine while its daemon socket did not exist, so "docker is
 * installed" was true and `docker run` still failed. A `command` prereq cannot
 * express that, and a wrong "not installed" message sends the user to install
 * something they already have. A `service` prereq names the binary AND the
 * probe that must succeed (`docker info`), so the report can say exactly which
 * half is missing. Running that probe EXECUTES a process, so it is opt-in
 * (`deep`): the CLI asks for it at install time, unit tests never do.
 *
 * Hermetic by construction: PATH lookup + `process.env` reads only. No spawn,
 * no network, no config write. Tests can inject `env`/`nodeVersion`.
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, isAbsolute, join } from 'node:path';

/** What a variant can require of the machine. */
export type MCPPrereqKind =
  /** A Node.js version floor, e.g. `>=20.18.1` — checked against `nodeVersion`. */
  | 'node'
  /** An executable that must be resolvable on PATH (npx, uvx, docker, a binary). */
  | 'command'
  /**
   * A background SERVICE behind a CLI: the binary must exist AND `check` must
   * succeed (e.g. `docker info` — the daemon is reachable). Checked only in
   * `deep` mode; a shallow probe reports it as present-but-unverified.
   */
  | 'service'
  /** An environment variable that must be set (a credential, an endpoint). */
  | 'env'
  /** A file/directory that must exist (a local server entry point, a mount). */
  | 'file';

export interface MCPPrereq {
  kind: MCPPrereqKind;
  /**
   * `command`/`env`/`file`: the name/path to look for.
   * `node`: the literal `node` (the version lives in `minVersion`).
   */
  name: string;
  /** `node` only — the minimum version, e.g. `20.18.1`. */
  minVersion?: string;
  /** `service` only — the command that must EXIT 0 for the service to count as up. */
  check?: { args: string[]; timeoutMs?: number };
  /** What to install / set, in the user's words, shown BEFORE anything is enabled. */
  hint: string;
}

/** A prerequisite whose binary exists but whose check failed (service down). */
export interface MCPBlockedPrereq {
  prereq: MCPPrereq;
  /** What was observed, e.g. "daemon not reachable (Cannot connect to the Docker daemon)". */
  reason: string;
}

/** The outcome of probing a variant's prerequisites. */
export interface MCPPrereqStatus {
  /** True when every prerequisite is satisfied — the variant can be started. */
  ok: boolean;
  /** The prerequisites that are not satisfied, in declaration order. */
  missing: MCPPrereq[];
  /**
   * Requirements satisfied WITHOUT verification, with the reason. Today this is
   * one case: a `node` floor met by an alternate runtime binary — the binary is
   * present, its version is established by the handshake at connect time.
   */
  unverified: string[];
  /**
   * Requirements whose binary IS present but which still cannot work (a service
   * that is down). Separate from `missing` because the fix is different: the user
   * must START something, not install it.
   */
  blocked: MCPBlockedPrereq[];
}

export interface MCPProbeOptions {
  /**
   * Run the `service` checks (executes `check.args` against the named binary,
   * bounded by `timeoutMs`). OFF by default so a unit test never spawns
   * anything; the CLI turns it on for `catalog` / `install`.
   */
  deep?: boolean;
  /** Environment to read (`process.env` by default; tests inject one). */
  env?: NodeJS.ProcessEnv;
  /** Node version to check against a `node` floor (defaults to this process). */
  nodeVersion?: string;
  /**
   * An alternate runtime command declared by the variant (`runtime.command`).
   * When set, a `node` floor is satisfied by the runtime's PRESENCE and the
   * version check is reported as unverified rather than passed silently.
   */
  runtimeCommand?: string;
}

/** Strip a leading `v` and any pre-release suffix: `v20.18.1-rc.1` → `20.18.1`. */
function normalizeVersion(version: string): number[] {
  return String(version ?? '')
    .trim()
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/**
 * Compare two dotted versions. Returns <0 when `a` is older, 0 when equal,
 * >0 when `a` is newer. Missing components count as 0, so `18` < `18.18`.
 */
export function compareVersions(a: string, b: string): number {
  const left = normalizeVersion(a);
  const right = normalizeVersion(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Is `command` runnable? An absolute or relative path is checked directly; a
 * bare name is looked up on PATH (honouring PATHEXT on Windows). Executability
 * is verified where the platform exposes it, so a non-executable file on PATH
 * is reported as missing rather than assumed usable.
 */
export function commandExists(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCommandPath(command, env) !== null;
}

/**
 * Where an executable actually is — the first candidate that exists and is
 * executable, or null. Reporting the PATH is what turns "not installed" into a
 * check the user can falsify in one command (`ls -l /opt/homebrew/bin/docker`).
 */
export function resolveCommandPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const name = String(command ?? '').trim();
  if (!name) return null;

  const candidates: string[] = [];
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    candidates.push(name);
  } else {
    const extensions =
      process.platform === 'win32'
        ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        : [''];
    const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
    for (const dir of dirs) {
      for (const ext of extensions) {
        candidates.push(join(dir, `${name}${ext}`));
      }
    }
  }

  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not there, or not executable — try the next candidate.
    }
  }
  return null;
}

/** Default budget for one deep service check. */
const SERVICE_CHECK_TIMEOUT_MS = 2500;

/**
 * Run a service check (`<binary> <args…>`) and require exit 0. Returns the
 * observed failure reason on non-zero/missing/timeout, so the caller can show it
 * verbatim instead of guessing.
 */
function runServiceCheck(
  binary: string,
  check: NonNullable<MCPPrereq['check']>,
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; reason: string } {
  try {
    const result = spawnSync(binary, check.args, {
      timeout: check.timeoutMs ?? SERVICE_CHECK_TIMEOUT_MS,
      encoding: 'utf-8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) return { ok: false, reason: result.error.message };
    if (result.status === 0) return { ok: true };
    const stderr = String(result.stderr ?? '').trim().split('\n').filter(Boolean).pop();
    const stdout = String(result.stdout ?? '').trim().split('\n').filter(Boolean).pop();
    const raw = stderr || stdout || `exited with status ${result.status}`;
    // Tools like docker print a paragraph; keep the report one readable line.
    return { ok: false, reason: raw.length > 160 ? `${raw.slice(0, 157)}…` : raw };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Probe one variant's prerequisites. Pure with respect to the filesystem
 * (reads only) and to the network (never touches it).
 */
export function probePrereqs(prereqs: MCPPrereq[], options: MCPProbeOptions = {}): MCPPrereqStatus {
  const env = options.env ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const missing: MCPPrereq[] = [];
  const unverified: string[] = [];
  const blocked: MCPBlockedPrereq[] = [];

  for (const prereq of prereqs) {
    switch (prereq.kind) {
      case 'command': {
        if (!commandExists(prereq.name, env)) missing.push(prereq);
        break;
      }
      case 'service': {
        const binary = resolveCommandPath(prereq.name, env);
        if (!binary) {
          // The BINARY is missing — the actionable fix is to install it.
          missing.push(prereq);
          break;
        }
        if (!options.deep || !prereq.check) {
          // Present, daemon state not established: say so rather than assume.
          unverified.push(`'${prereq.name}' found at ${binary} — its service was not checked`);
          break;
        }
        const result = runServiceCheck(binary, prereq.check, env);
        if (!result.ok) {
          blocked.push({
            prereq,
            reason: `'${prereq.name}' is installed (${binary}) but not running: ${result.reason}`,
          });
        }
        break;
      }
      case 'env': {
        const value = env[prereq.name];
        if (!value || !String(value).trim()) missing.push(prereq);
        break;
      }
      case 'file': {
        if (!existsSync(prereq.name)) missing.push(prereq);
        break;
      }
      case 'node': {
        if (options.runtimeCommand) {
          // The floor is met by running the server under a different runtime.
          // Verify the runtime is present; its VERSION is established by the
          // handshake at connect time — say so instead of claiming a pass.
          if (!commandExists(options.runtimeCommand, env)) {
            missing.push(prereq);
          } else if (prereq.minVersion && compareVersions(nodeVersion, prereq.minVersion) < 0) {
            unverified.push(
              `${prereq.name} ≥ ${prereq.minVersion} via '${options.runtimeCommand}' — version checked at connect`,
            );
          }
          break;
        }
        if (prereq.minVersion && compareVersions(nodeVersion, prereq.minVersion) < 0) {
          missing.push(prereq);
        }
        break;
      }
    }
  }

  return { ok: missing.length === 0 && blocked.length === 0, missing, unverified, blocked };
}

/**
 * One human line per missing prerequisite: what is absent, and what to do about
 * it. Used by `nuvira mcp catalog` / `install` so a dependency is named BEFORE
 * the user enables anything rather than surfacing as a dead server later.
 */
export function describeMissingPrereqs(missing: MCPPrereq[]): string[] {
  return missing.map((prereq) => {
    switch (prereq.kind) {
      case 'node':
        return `Node.js ${prereq.minVersion ?? ''}+ (this process runs ${process.versions.node}) — ${prereq.hint}`.trim();
      case 'command':
        return `'${prereq.name}' not found on PATH — ${prereq.hint}`;
      case 'service':
        return `'${prereq.name}' not found on PATH — ${prereq.hint}`;
      case 'env':
        return `$${prereq.name} is not set — ${prereq.hint}`;
      case 'file':
        return `${prereq.name} does not exist — ${prereq.hint}`;
      default:
        return `${prereq.name} — ${prereq.hint}`;
    }
  });
}

/**
 * Every reason a variant cannot run, in the words the user needs: something
 * ABSENT (install it) or something PRESENT BUT DOWN (start it). One function, so
 * the CLI, the dashboard and the installer cannot phrase it differently.
 */
export function describePrereqProblems(status: MCPPrereqStatus): string[] {
  const lines = describeMissingPrereqs(status.missing);
  for (const { reason, prereq } of status.blocked) {
    lines.push(`${reason} — ${prereq.hint}`);
  }
  return lines;
}
