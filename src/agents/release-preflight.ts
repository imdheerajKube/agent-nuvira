/**
 * Release preflight — check the things a release cannot undo BEFORE it starts.
 *
 * WHY THIS EXISTS. A live release run bumped the version, committed, tagged and
 * pushed `v3.3.2` — and only THEN discovered it could not publish, because the
 * version-pinned CLI cast still recorded 3.3.1 and `prepublishOnly`'s test run
 * refuses a stale artifact. Everything irreversible had already happened. A
 * release has exactly one cheap moment: before the first phase.
 *
 * The checks are chosen by the same rule `credentials verify` follows — report
 * what was MEASURED, and never fail on a check that could not be made:
 *
 *   1. `npm view <name>@<version>` — is this version already published? (The one
 *      condition under which the whole run is pointless; npm is immutable, so a
 *      second publish of 3.3.2 can only fail.)
 *   2. The working tree — is it a git repo, is there a remote, is the branch
 *      ahead/behind, does the target tag already exist locally or on the remote?
 *   3. The provider×model pair — ONLY when a phase will actually call a model.
 *      Since the release phases became deterministic that is normally zero
 *      phases, and claiming to have verified a route nothing will use would be
 *      exactly the kind of decorative check this repo keeps deleting.
 *
 * A `definitive` failure (the registry answered, the version exists, the tag is
 * taken) blocks the run unless `--force`. An `unknown` (offline, no npm token,
 * no network) warns and continues — a closed network must not make releases
 * impossible, and pretending those checks passed would be worse than admitting
 * they did not run.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveProvider } from '../cli/router.js';
import { resolveRoute } from '../inference/route-resolver.js';
import type { ConfigManager } from '../config/manager.js';
import { logger } from '../utils/logger.js';

export interface PreflightCheck {
  name: string;
  /** 'ok' verified good · 'warn' advisory · 'block' a reason not to start. */
  status: 'ok' | 'warn' | 'block';
  detail: string;
  /**
   * True when the answer came from the authoritative source (the registry
   * answered, the tag exists). A `block` with `definitive: false` is a caution,
   * not a verdict.
   */
  definitive: boolean;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  /** True when at least one DEFINITIVE block was found. */
  blocked: boolean;
  /** Human-readable one-screen summary. */
  summary: string;
}

/**
 * A command runner, injected rather than imported.
 *
 * The checks below are the ones a release must be able to TRUST, and trusting
 * them means being able to test them against the answers that matter — "already
 * published", "tag taken", "registry unreachable" — without a network, a
 * registry or a git repository. A module-mocked `execSync` would also make every
 * test depend on vitest's builtin-mock plumbing; an explicit parameter keeps the
 * seam visible in the signature.
 */
export type CommandRunner = (command: string, timeoutMs?: number) => { ok: boolean; output: string };

const defaultRunner: CommandRunner = (command, timeoutMs = 60_000) => {
  try {
    const output = execSync(`${command} 2>&1`, { timeout: timeoutMs, encoding: 'utf-8', stdio: 'pipe' });
    return { ok: true, output: (output || '').trim() };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: (error.stdout || error.stderr || error.message || '').trim() };
  }
};

export interface PreflightInput {
  /** `package.json` of the project being released. */
  cwd?: string;
  /** The version the release WILL create (computed from the bump type). */
  targetVersion: string;
  /**
   * True when some phase will call a language model. Only then is the route
   * checked — see the module docstring.
   */
  needsModel?: boolean;
  /** Injected so the model check is testable without a provider instance. */
  probeModel?: () => Promise<{ ok: boolean; checked: boolean; detail: string }>;
  /** Injected so the command checks are testable without a network. */
  runner?: CommandRunner;
}

/**
 * Read the package name/version the release concerns.
 * Exported for tests and for the caller that computes the target version.
 */
export function readReleaseTarget(cwd = process.cwd()): { name: string; version: string; private?: boolean } | null {
  try {
    const raw = readFileSync(join(cwd, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { name?: string; version?: string; private?: boolean };
    return { name: pkg.name || '', version: pkg.version || '', private: pkg.private };
  } catch {
    return null;
  }
}

/** Is `name@version` already on the registry? */
export function checkVersionPublished(
  name: string,
  version: string,
  runner: CommandRunner = defaultRunner,
): PreflightCheck {
  const name_ = 'npm version available';
  if (!name || !version) {
    return { name: name_, status: 'warn', detail: 'no package name/version to check', definitive: false };
  }
  const result = runner(`npm view "${name}@${version}" version`, 60_000);
  if (result.ok && result.output.includes(version)) {
    return {
      name: name_,
      status: 'block',
      detail: `${name}@${version} is ALREADY published — a second publish of the same version cannot succeed. Bump further or fix the version.`,
      definitive: true,
    };
  }
  if (!result.ok && /E404|not found|No match found/i.test(result.output)) {
    // The definitive "this version does not exist yet" answer.
    return { name: name_, status: 'ok', detail: `${name}@${version} is not published yet`, definitive: true };
  }
  // Offline, registry error, no token — an unanswerable question.
  return {
    name: name_,
    status: 'warn',
    detail: `could not check the registry (${result.output.split('\n')[0]?.slice(0, 120) || 'no output'})`,
    definitive: false,
  };
}

/** Repo/remote/tag state — the facts that make a push succeed or collide. */
export function checkGitState(
  targetVersion: string,
  cwd = process.cwd(),
  runner: CommandRunner = defaultRunner,
): PreflightCheck[] {
  const run = runner;
  const checks: PreflightCheck[] = [];

  const inside = run('git rev-parse --is-inside-work-tree', 15_000);
  if (!inside.ok || !inside.output.includes('true')) {
    return [{ name: 'git repository', status: 'block', detail: `${cwd} is not a git repository`, definitive: true }];
  }

  const remotes = run('git remote', 15_000);
  checks.push(
    remotes.ok && remotes.output.trim()
      ? { name: 'git remote', status: 'ok', detail: remotes.output.split('\n')[0].trim(), definitive: true }
      : { name: 'git remote', status: 'block', detail: 'no git remote configured — the commit could not be pushed', definitive: true },
  );

  const tag = `v${targetVersion}`;
  const localTag = run(`git tag -l "${tag}"`, 15_000);
  const tagExistsLocally = localTag.ok && localTag.output.trim() === tag;

  // The remote answer needs the network; a failure here is 'unknown', not 'fine'.
  const remoteTag = run(`git ls-remote --tags origin "refs/tags/${tag}"`, 60_000);
  const tagExistsRemotely = remoteTag.ok && remoteTag.output.trim().length > 0;

  if (tagExistsLocally || tagExistsRemotely) {
    checks.push({
      name: 'release tag',
      status: 'block',
      detail:
        `${tag} already exists ${tagExistsRemotely ? 'on the remote' : 'locally'} — ` +
        'publishing this version again is not possible; bump further or delete the tag deliberately.',
      definitive: true,
    });
  } else if (!remoteTag.ok) {
    checks.push({
      name: 'release tag',
      status: 'warn',
      detail: `could not check the remote for ${tag} (${remoteTag.output.split('\n')[0]?.slice(0, 100) || 'no output'})`,
      definitive: false,
    });
  } else {
    checks.push({ name: 'release tag', status: 'ok', detail: `${tag} is free locally and on the remote`, definitive: true });
  }

  const dirty = run('git status --porcelain', 30_000);
  if (dirty.ok) {
    const count = dirty.output.split('\n').filter(Boolean).length;
    checks.push({
      name: 'working tree',
      status: count === 0 ? 'ok' : 'warn',
      detail: count === 0 ? 'clean' : `${count} uncommitted change(s) will be included in the release commit`,
      definitive: true,
    });
  }

  return checks;
}

/**
 * Run every check. Never throws; a check that cannot run reports `warn`.
 */
export async function runReleasePreflight(input: PreflightInput): Promise<PreflightResult> {
  const cwd = input.cwd || process.cwd();
  const target = readReleaseTarget(cwd);
  const checks: PreflightCheck[] = [];

  if (!target) {
    checks.push({ name: 'package.json', status: 'block', detail: `no readable package.json in ${cwd}`, definitive: true });
  } else if (target.private) {
    checks.push({
      name: 'package privacy',
      status: 'block',
      detail: 'package.json is `private: true` — npm refuses to publish it',
      definitive: true,
    });
  } else {
    checks.push(...checkGitState(input.targetVersion, cwd, input.runner));
    checks.push(checkVersionPublished(target.name, input.targetVersion, input.runner));
  }

  // The model pair, ONLY when a phase will call a model. Reporting a verified
  // route nothing uses would be a decorative check.
  if (input.needsModel) {
    if (!input.probeModel) {
      checks.push({
        name: 'provider×model',
        status: 'warn',
        detail: 'a phase will call a model, but no probe was supplied — the route is unverified',
        definitive: false,
      });
    } else {
      try {
        const probe = await input.probeModel();
        checks.push({
          name: 'provider×model',
          status: probe.ok ? 'ok' : probe.checked ? 'block' : 'warn',
          detail: probe.detail,
          definitive: probe.checked,
        });
      } catch (err) {
        checks.push({
          name: 'provider×model',
          status: 'warn',
          detail: `probe failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
          definitive: false,
        });
      }
    }
  }

  const blocked = checks.some((c) => c.status === 'block' && c.definitive);
  return { checks, blocked, summary: formatPreflight({ checks, blocked }) };
}

/** One screen: what was verified, what could not be, and what stops the run. */
export function formatPreflight(result: { checks: PreflightCheck[]; blocked: boolean }): string {
  const icon = (c: PreflightCheck): string =>
    c.status === 'ok' ? '✅' : c.status === 'warn' ? '⚠️ ' : '❌';

  const lines = ['📋 Release preflight'];
  for (const c of result.checks) {
    lines.push(`  ${icon(c)} ${c.name}: ${c.detail}`);
  }
  if (result.blocked) {
    lines.push('  → These are definitive: the release is stopped before anything irreversible happens.');
  } else if (result.checks.some((c) => c.status === 'warn')) {
    lines.push('  → Warnings could not be verified (offline / no token). The release will run; they are not claims that it passed.');
  }
  return lines.join('\n');
}

/**
 * Verify the route a model-calling phase would use — WITHOUT spending a
 * generation.
 *
 * What this genuinely proves: the provider is constructible and reachable, and
 * the model exists on it (the resolver validates against the provider's LIVE
 * model list, which is a real API call). What it does NOT prove: that a
 * generation succeeds for this prompt. The detail string says exactly that, so
 * the report cannot be read as more than it is.
 */
export async function probeProviderModel(
  configManager: ConfigManager,
  providerOption?: string,
  modelOption?: string,
): Promise<{ ok: boolean; checked: boolean; detail: string }> {
  try {
    const resolved = resolveProvider(configManager, providerOption);
    if (typeof resolved.provider.isAvailable === 'function' && !(await resolved.provider.isAvailable())) {
      return { ok: false, checked: true, detail: `${resolved.type} reports itself unavailable (missing key or unreachable)` };
    }
    const route = await resolveRoute({
      providerType: resolved.type,
      provider: resolved.provider,
      model: modelOption,
      source: 'publish',
      task: 'release preflight',
    });
    const substituted = route.substituted ? ` (requested '${route.requested}' was substituted)` : '';
    return {
      ok: true,
      checked: true,
      detail:
        `${resolved.type}/${route.model} exists on the provider's live model list${substituted}; ` +
        'a generation was NOT attempted — this verifies the pair, not a successful call',
    };
  } catch (err) {
    return {
      ok: false,
      checked: false,
      detail: `could not resolve the pair: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    };
  }
}

/** Log a preflight result at the right level for each status. */
export function reportPreflight(result: PreflightResult): void {
  for (const check of result.checks) {
    const line = `  ${check.status === 'ok' ? '✅' : check.status === 'warn' ? '⚠️ ' : '❌'} preflight · ${check.name}: ${check.detail}`;
    if (check.status === 'ok') logger.info(line);
    else logger.warn(line);
  }
  if (result.blocked) {
    logger.error('  ❌ preflight found a definitive blocker — the release did not start (use --force to override)');
  }
}
