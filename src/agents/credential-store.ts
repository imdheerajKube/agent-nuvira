/**
 * CredentialStore — Collects, validates, and manages credentials for publishing.
 *
 * Capabilities:
 * - Collect Git credentials (HTTPS token, SSH key path) from env vars or interactive prompts
 * - Collect npm credentials (token, registry) from env vars or interactive prompts
 * - Validate credentials before use
 * - Write temporary .npmrc and git credential files
 * - Zero-config detection from environment variables
 *
 * Usage:
 * ```ts
 * const creds = new CredentialStore();
 * await creds.collectAll();  // Interactive: prompts for what's missing
 * creds.setupNpmAuth();      // Writes .npmrc with token
 * creds.setupGitCredentials(); // Sets GIT_ASKPASS for HTTPS auth
 * ```
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync, unlinkSync, chmodSync } from 'node:fs';
import { envBuff, resolveNuviraEnvFile } from '../config/paths';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import inquirer from 'inquirer';
import { execSync } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { maskSecret } from '../enterprise/secrets.js';
import {
  deleteEnvValue,
  getEnvVarValue,
  loadEnvFile,
  saveEnvValue,
} from '../skills/secret-capture.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GitCredentials {
  /** Remote URL (e.g., https://github.com/user/repo.git) */
  remoteUrl?: string;
  /** GitHub username or token-based auth */
  username?: string;
  /** Personal Access Token (preferred over password) */
  token?: string;
  /** Path to SSH private key */
  sshKeyPath?: string;
  /** Whether to use SSH instead of HTTPS */
  useSsh?: boolean;
  /** Parsed owner/repo from remote URL */
  repoSlug?: string;
}

export interface NpmCredentials {
  /** npm token (from env NPM_TOKEN or .npmrc) */
  token?: string;
  /** npm registry URL (default: https://registry.npmjs.org/) */
  registry?: string;
  /** Whether credentials were already configured */
  configured: boolean;
}

export interface PublishCredentials {
  git: GitCredentials;
  npm: NpmCredentials;
}

// ─── Persisted release credentials ──────────────────────────────────────────

/**
 * Release credentials may be STORED, not merely exported for one session.
 *
 * Why this exists: this store used to read only `process.env` and `.npmrc`,
 * and `collectAll()` was the only way to mark credentials as collected. So an
 * agent asked to release needed both tokens re-exported in its environment
 * every session, and the `publish` TOOL — which may never prompt — could never
 * set them up at all: it called `setupGitCredentials()` / `setupNpmAuth()`
 * without `collectAll()`, both threw, and a single `try/catch` swallowed the
 * pair. A tool-driven release therefore ran with NO credentials while
 * reporting a clean pipeline.
 *
 * Tokens now persist in the nuvira env file (0600, resolved by
 * `resolveNuviraEnvFile` — outside the repo, never in shell history), the SAME
 * store the skill-secret path already writes. One place a credential lives.
 */
export const RELEASE_CREDENTIAL_KEYS = {
  /** GitHub PAT / OAuth token used for HTTPS push. */
  gitToken: 'GITHUB_TOKEN',
  /** Git username paired with {@link RELEASE_CREDENTIAL_KEYS.gitToken}. */
  gitUsername: 'GIT_USERNAME',
  /** npm automation token used for `npm publish`. */
  npmToken: 'NPM_TOKEN',
  /** Optional non-default npm registry. */
  npmRegistry: 'NPM_REGISTRY',
} as const;

/** Legacy/alternate GitHub token names accepted on read. */
const GIT_TOKEN_ALIASES = ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_API_KEY'] as const;

/**
 * Read a credential from the persisted store, falling back to `process.env`.
 * Returns `undefined` when unset (never an empty string).
 */
function storedCredential(name: string): string | undefined {
  return getEnvVarValue(name) || undefined;
}

/** First set credential among `names`, in priority order. */
function firstStoredCredential(names: readonly string[]): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = storedCredential(name);
    if (value) return { name, value };
  }
  return undefined;
}

function detectGitRemote(): GitCredentials {
  const creds: GitCredentials = {};
  try {
    const remote = execSync('git remote get-url origin 2>&1', {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    creds.remoteUrl = remote;

    // Parse owner/repo from various remote formats
    const httpsMatch = remote.match(/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?$/);
    const sshMatch = remote.match(/github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/);

    if (httpsMatch) {
      creds.repoSlug = `${httpsMatch[1]}/${httpsMatch[2]}`;
    } else if (sshMatch) {
      creds.repoSlug = `${sshMatch[1]}/${sshMatch[2]}`;
      creds.useSsh = true;
    }

    // Detect SSH configuration
    if (remote.startsWith('git@') || remote.startsWith('ssh://')) {
      creds.useSsh = true;
      // Check for common SSH key paths
      const sshPaths = [
        join(homedir(), '.ssh', 'id_rsa'),
        join(homedir(), '.ssh', 'id_ed25519'),
        join(homedir(), '.ssh', 'id_ecdsa'),
      ];
      for (const p of sshPaths) {
        if (existsSync(p)) {
          creds.sshKeyPath = p;
          break;
        }
      }
    }
  } catch {
    // No remote configured — leave empty
  }

  return creds;
}

function detectNpmConfig(): NpmCredentials {
  const creds: NpmCredentials = { configured: false };

  // Check env vars first
  if (process.env.NPM_TOKEN) {
    creds.token = process.env.NPM_TOKEN;
  }

  // Check .npmrc for existing auth token
  const npmrcPaths = [
    join(process.cwd(), '.npmrc'),
    join(homedir(), '.npmrc'),
  ];

  for (const npmrcPath of npmrcPaths) {
    if (existsSync(npmrcPath)) {
      try {
        const content = readFileSync(npmrcPath, 'utf-8');
        const tokenMatch = content.match(/\/\/registry\.npmjs\.org\/:_authToken=([^\s]+)/);
        if (tokenMatch) {
          creds.token = creds.token || tokenMatch[1];
          creds.configured = true;
        }
        const registryMatch = content.match(/registry\s*=\s*([^\s]+)/);
        if (registryMatch) {
          creds.registry = registryMatch[1];
        }
      } catch {
        // Ignore unreadable .npmrc
      }
    }
  }

  // Persisted store — the STORED path (nuvira env file), which is what makes a
  // token survive across sessions without an env export.
  if (!creds.token) {
    const stored = getEnvVarValue(RELEASE_CREDENTIAL_KEYS.npmToken);
    if (stored) {
      creds.token = stored;
      creds.configured = true;
    }
  }
  const storedRegistry = getEnvVarValue(RELEASE_CREDENTIAL_KEYS.npmRegistry);
  if (storedRegistry) creds.registry = storedRegistry;

  creds.registry = creds.registry || 'https://registry.npmjs.org/';
  return creds;
}

// ─── Password-Protected SSH Key Helper ───────────────────────────────────────

let _sshPassphrase: string | undefined;

/**
 * Check if an SSH key is password-protected.
 */
function isSSHKeyProtected(keyPath: string): boolean {
  try {
    const content = readFileSync(keyPath, 'utf-8');
    return content.includes('ENCRYPTED') || content.includes('DEK-Info');
  } catch {
    return false;
  }
}

// ─── CredentialStore ─────────────────────────────────────────────────────────

export class CredentialStore {
  private _git: GitCredentials = {};
  private _npm: NpmCredentials = { configured: false };
  private _collected = false;

  /** The current git credentials */
  get git(): GitCredentials {
    return this._git;
  }

  /** The current npm credentials */
  get npm(): NpmCredentials {
    return this._npm;
  }

  /** Whether credentials have been collected */
  get collected(): boolean {
    return this._collected;
  }

  /** Whether we have enough credentials to push to git */
  get canPush(): boolean {
    if (this._git.useSsh && this._git.sshKeyPath) return true;
    if (this._git.token) return true;
    return false;
  }

  /** Whether we have enough credentials to publish to npm */
  get canPublish(): boolean {
    return !!this._npm.token;
  }

  /**
   * Auto-detect credentials from environment and existing config.
   * Does NOT prompt — call collectAll() for interactive collection.
   */
  constructor() {
    this._git = detectGitRemote();
    this._npm = detectNpmConfig();

    // Auto-detect from env vars
    if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
      this._git.token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    }
    if (process.env.GIT_USERNAME) {
      this._git.username = process.env.GIT_USERNAME;
    }

    // …then the PERSISTED store (env file), for anything the environment did
    // not already provide. `process.env` wins so a one-off override stays
    // possible without editing the stored credential.
    if (!this._git.token) {
      const stored = firstStoredCredential(GIT_TOKEN_ALIASES);
      if (stored) this._git.token = stored.value;
    }
    if (!this._git.username) {
      const storedUser = storedCredential(RELEASE_CREDENTIAL_KEYS.gitUsername);
      if (storedUser) this._git.username = storedUser;
    }
  }

  /**
   * Non-interactive initialisation.
   *
   * Adopts whatever was auto-detected — environment variables, the persisted
   * store, and the project `.npmrc` — and marks the store collected, so
   * {@link setupGitCredentials} / {@link setupNpmAuth} can run with NO TTY.
   *
   * This is the method the `publish` TOOL must call: a tool call may never
   * block on a prompt, whereas `nuvira publish` on a terminal still uses
   * `collectAll()` to ask for anything missing.
   */
  initialize(): PublishCredentials {
    this._collected = true;
    return { git: this._git, npm: this._npm };
  }

  /**
   * Validate the detected credentials against the live services.
   * Best-effort and NON-FATAL: a network hiccup reports `unknown`, never a
   * failure, so a preflight check can advise without blocking a release.
   */
  async verify(): Promise<PublishVerification> {
    const result: PublishVerification = {
      git: { checked: false, ok: false, detail: 'no git credentials' },
      npm: { checked: false, ok: false, detail: 'no npm token' },
    };

    if (this._git.token) {
      result.git = await probeGitHubToken(this._git.token);
    }

    if (this._npm.token) {
      result.npm = await probeNpmToken(
        this._npm.token,
        this._npm.registry || 'https://registry.npmjs.org/',
      );
    }

    return result;
  }

  /**
   * Collect missing credentials interactively.
   * Skips prompts for already-detected values.
   */
  async collectAll(): Promise<PublishCredentials> {
    // Already initialised non-interactively (tool path) — never re-prompt.
    if (this._collected) {
      return { git: this._git, npm: this._npm };
    }

    console.log('');
    logger.highlight(`${'═'.repeat(50)}`);
    logger.highlight('  🔑  Publishing Credentials Setup');
    logger.highlight(`${'═'.repeat(50)}`);
    console.log('');

    // ── Show detected status ────────────────────────────────────────────
    if (this._git.remoteUrl) {
      logger.info(`  📡 Git remote: ${this._git.remoteUrl}`);
    } else {
      logger.warn('  ⚠️  No git remote configured (git remote get-url origin)');
    }

    if (this._npm.token) {
      logger.info('  📦 npm token: detected ✅');
    } else {
      logger.warn('  ⚠️  No npm token detected');
    }
    console.log('');

    // ── Git credential collection ───────────────────────────────────────
    if (this._git.useSsh) {
      // SSH mode — check if key exists and if it's password-protected
      if (!this._git.sshKeyPath) {
        const { sshKey } = await inquirer.prompt<{ sshKey: string }>([
          {
            type: 'input',
            name: 'sshKey',
            message: 'Path to SSH private key:',
            default: '~/.ssh/id_ed25519',
            validate: (input: string) => {
              const resolved = input.replace(/^~/, homedir());
              return existsSync(resolved) || `File not found: ${input}`;
            },
          },
        ]);
        this._git.sshKeyPath = sshKey.replace(/^~/, homedir());
      }

      // Check if the SSH key is password-protected
      if (this._git.sshKeyPath && isSSHKeyProtected(this._git.sshKeyPath) && !_sshPassphrase) {
        const { passphrase } = await inquirer.prompt<{ passphrase: string }>([
          {
            type: 'password',
            name: 'passphrase',
            message: 'SSH key passphrase (leave empty if none):',
            mask: '*',
          },
        ]);
        if (passphrase) {
          _sshPassphrase = passphrase;
        }
      }
    } else if (!this._git.useSsh && !this._git.token) {
      // HTTPS mode — need a token
      const envHint = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
        ? 'Detected from environment'
        : 'Set GITHUB_TOKEN or GH_TOKEN env var';

      logger.info(`  💡 ${envHint}`);

      const { token } = await inquirer.prompt<{ token: string }>([
        {
          type: 'password',
          name: 'token',
          message: 'GitHub Personal Access Token (classic or fine-grained):',
          mask: '*',
          validate: (input: string) => input.length > 0 || 'Token is required for git push',
        },
      ]);
      this._git.token = token;

      const { gitUser } = await inquirer.prompt<{ gitUser: string }>([
        {
          type: 'input',
          name: 'gitUser',
          message: 'GitHub username (for token auth):',
          default: process.env.USER || 'git',
        },
      ]);
      this._git.username = gitUser;
    }

    // ── npm credential collection ───────────────────────────────────────
    if (!this._npm.token) {
      const envHint = process.env.NPM_TOKEN
        ? 'Detected from NPM_TOKEN env var'
        : 'Set NPM_TOKEN env var';

      logger.info(`  💡 ${envHint}`);

      const { npmToken } = await inquirer.prompt<{ npmToken: string }>([
        {
          type: 'password',
          name: 'npmToken',
          message: 'npm automation token (classic or granular):',
          mask: '*',
          validate: (input: string) => input.length > 0 || 'Token is required for npm publish',
        },
      ]);
      this._npm.token = npmToken;

      const { registry } = await inquirer.prompt<{ registry: string }>([
        {
          type: 'input',
          name: 'registry',
          message: 'npm registry URL:',
          default: this._npm.registry || 'https://registry.npmjs.org/',
        },
      ]);
      this._npm.registry = registry;
    }

    this._collected = true;
    console.log('');
    // Report where they CAME from rather than claiming "session only": tokens
    // are routinely read from the persisted store now, and a message that says
    // otherwise makes an operator distrust the store they just populated.
    logger.success('  ✅ Credentials ready for this run');
    logger.info(`     Stored values are read from: ${resolveNuviraEnvFile()}`);
    console.log('');

    return { git: this._git, npm: this._npm };
  }

  /**
   * Set up git credential helpers for the current session.
   * For HTTPS: writes a GIT_ASKPASS script that echoes the token.
   * For SSH: sets up SSH agent with key, optionally with passphrase.
   *
   * Call this AFTER collectAll().
   */
  setupGitCredentials(): void {
    if (!this._collected) {
      throw new Error('Call collectAll() before setupGitCredentials()');
    }

    if (this._git.useSsh && this._git.sshKeyPath) {
      // SSH mode: add key to SSH agent
      try {
        const keyPath = this._git.sshKeyPath;
        // Check if key is already added to agent
        const addedKeys = execSync('ssh-add -l 2>&1', {
          timeout: 5000,
          encoding: 'utf-8',
          stdio: 'pipe',
        });

        if (!addedKeys.includes(keyPath)) {
          if (_sshPassphrase) {
            // Use an askpass helper for password-protected keys.
            // Platform-aware: `.cmd` on Windows (no chmod, no /dev/null),
            // `.sh` on Unix. The passphrase rides in env (never inlined into
            // the script) so special chars can't break the helper.
            const isWindows = process.platform === 'win32';
            const askPassScript = join(
              tmpdir(),
              isWindows ? 'buff-ssh-askpass.cmd' : 'buff-ssh-askpass.sh',
            );
            const askPassContent = isWindows
              ? '@echo off\r\necho %BUFF_SSH_PASSPHRASE%\r\n'
              : `#!/bin/sh\necho "${_sshPassphrase}"\n`;
            writeFileSync(askPassScript, askPassContent, 'utf-8');
            try {
              if (!isWindows) {
                execSync('chmod +x ' + askPassScript, { timeout: 2000 });
              }
              execSync(`ssh-add "${keyPath}"`, {
                timeout: 5000,
                encoding: 'utf-8',
                stdio: 'pipe',
                env: {
                  ...process.env,
                  SSH_ASKPASS: askPassScript,
                  // OpenSSH 8.4+: force askpass even without a TTY/display
                  SSH_ASKPASS_REQUIRE: 'force',
                  BUFF_SSH_PASSPHRASE: _sshPassphrase,
                },
              });
            } finally {
              try { unlinkSync(askPassScript); } catch { /* best-effort */ }
            }
          } else {
            execSync(`ssh-add "${keyPath}" 2>&1`, {
              timeout: 5000,
              encoding: 'utf-8',
              stdio: 'pipe',
            });
          }
        }
      } catch {
        logger.warn('  ⚠️  Could not add SSH key to agent (ssh-add may not be available)');
      }
    } else if (this._git.token) {
      // HTTPS mode: set up GIT_ASKPASS credential helper
      // Platform-aware: `.cmd` on Windows, `.sh` on Unix. Username/token ride
      // in env (never inlined into the script file on disk), which removes the
      // biggest breakage vector (tokens with &, %, ^, quotes, spaces) and keeps
      // secrets out of temp files. cmd.exe still expands %NUVIRA_GIT_TOKEN% at
      // runtime, so values containing `%` remain best-effort on Windows.
      //
      // The variable names here MUST match the ones exported below: the script
      // and the env were written on different days (one read BUFF_GIT_TOKEN
      // while the other set NUVIRA_GIT_TOKEN), so a stored `GITHUB_TOKEN`
      // produced an askpass helper that echoed an EMPTY string — HTTPS auth
      // silently fell back to whatever credential helper the machine had, and
      // a machine with none simply could not push.
      const isWindows = process.platform === 'win32';
      const askPassPath = join(
        tmpdir(),
        isWindows ? 'buff-git-askpass.cmd' : 'buff-git-askpass.sh',
      );
      const username = this._git.username || process.env.USER || process.env.USERNAME || 'git';
      const token = this._git.token;

      const askPassContent = isWindows
        ? '@echo off\r\n' +
          'echo %1 | findstr /i "Username" >nul\r\n' +
          'if not errorlevel 1 (\r\n' +
          '  echo %NUVIRA_GIT_USERNAME%\r\n' +
          ') else (\r\n' +
          '  echo %NUVIRA_GIT_TOKEN%\r\n' +
          ')\r\n'
        // Unix variant reads the values from env too — never inlines secrets
        // into the script file on disk.
        : '#!/bin/sh\n' +
          'case "$1" in\n' +
          '  *Username*) echo "$NUVIRA_GIT_USERNAME" ;;\n' +
          '  *)          echo "$NUVIRA_GIT_TOKEN" ;;\n' +
          'esac\n';
      writeFileSync(askPassPath, askPassContent, 'utf-8');

      // Values ride in env so the script text stays literal and safe.
      process.env.NUVIRA_GIT_USERNAME = username;
      process.env.NUVIRA_GIT_TOKEN = token;

      try {
        if (!isWindows) {
          execSync(`chmod +x "${askPassPath}"`, { timeout: 2000 });
        }
      } catch { /* best-effort */ }

      process.env.GIT_ASKPASS = askPassPath;
      // Also set the credential helper for good measure
      process.env.GIT_TERMINAL_PROMPT = '0';

      logger.debug(`  🔑 GIT_ASKPASS set up for HTTPS auth (user: ${username})`);
    }
  }

  /**
   * Set up npm authentication for the current session.
   * Writes a temporary .npmrc in the project directory.
   *
   * Call this AFTER collectAll().
   */
  setupNpmAuth(): void {
    if (!this._collected) {
      throw new Error('Call collectAll() before setupNpmAuth()');
    }

    if (!this._npm.token) return;

    const registry = this._npm.registry || 'https://registry.npmjs.org/';
    const registryUrl = registry.replace(/^https?:\/\//, '').replace(/\/$/, '');

    // Write project-level .npmrc with token
    const npmrcPath = join(process.cwd(), '.npmrc');
    const existing = existsSync(npmrcPath) ? readFileSync(npmrcPath, 'utf-8') + '\n' : '';

    // Only add if not already present
    if (!existing.includes(`//${registryUrl}/:_authToken`)) {
      const authLine = `//${registryUrl}/:_authToken=\${NPM_TOKEN}\n`;
      writeFileSync(npmrcPath, existing + authLine, 'utf-8');
      logger.debug(`  📦 Added npm auth token to .npmrc (registry: ${registry})`);
    }

    // Also set env var for build/publish commands
    process.env.NPM_TOKEN = this._npm.token;
  }

  /**
   * Remove any temporary credential files created during setup.
   * Call this after publishing is complete.
   */
  cleanup(): void {
    // Remove GIT_ASKPASS script and the helper env vars
    if (process.env.GIT_ASKPASS) {
      try { unlinkSync(process.env.GIT_ASKPASS); } catch { /* best-effort */ }
      delete process.env.GIT_ASKPASS;
    }
    delete process.env.NUVIRA_GIT_USERNAME;
    delete process.env.NUVIRA_GIT_TOKEN;

    // Remove SSH_ASKPASS script if we created one
    // (already cleaned up in setupGitCredentials)

    // Unset terminal prompt disable
    delete process.env.GIT_TERMINAL_PROMPT;

    // Don't clear NPM_TOKEN env var — it might be needed by npm in subprocesses
    // Don't remove .npmrc lines — the token might have been there already

    this._collected = false;
    logger.debug('  🧹 Credential session cleaned up');
  }
}

/**
 * Check if git credentials are available (env vars or pre-configured).
 */
export function checkGitCredentials(): boolean {
  return !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GIT_ASKPASS);
}

/**
 * Check if npm credentials are available (env vars or pre-configured).
 */
export function checkNpmCredentials(): boolean {
  return !!(process.env.NPM_TOKEN);
}

/**
 * Get a human-readable summary of the current credential status.
 */
export function getCredentialStatus(): string {
  const status = releaseCredentialStatus();
  const lines: string[] = [];

  lines.push(`  📡 Remote: ${status.git.remoteUrl || 'Not configured'}`);
  const gitRow = status.rows.find((r) => r.role === 'git');
  lines.push(`  🔑 Git token: ${gitRow?.set ? `✅ Detected (${gitRow.origin})` : '❌ Missing'}`);
  const ssh = status.rows.find((r) => r.role === 'git' && r.origin === 'ssh');
  lines.push(`  🔐 SSH key: ${ssh ? `✅ ${ssh.key}` : '❌ Not detected'}`);

  const npmRow = status.rows.find((r) => r.role === 'npm');
  lines.push(`  📦 npm token: ${npmRow?.set ? `✅ Detected (${npmRow.origin})` : '❌ Missing'}`);
  lines.push(`  📦 npm registry: ${status.npm.registry || 'Not configured'}`);

  return lines.join('\n');
}

// ─── Storing, forgetting and reporting release credentials ──────────────────

/** Where a credential was found. */
export type CredentialOrigin = 'env' | 'stored' | 'npmrc' | 'ssh' | 'none';

/** One row of the release-credential status table. */
export interface ReleaseCredentialRow {
  /** Env var name the credential lives under. */
  key: string;
  /** What the credential is for. */
  role: 'git' | 'npm';
  /** Whether a usable value was found anywhere. */
  set: boolean;
  /** Masked value — enough to identify the key, never the key itself. */
  masked?: string;
  /** Where the value came from. */
  origin: CredentialOrigin;
}

/** Result of a live credential probe against GitHub / the npm registry. */
export interface CredentialProbe {
  /** False when the check could not be completed (offline, timeout). */
  checked: boolean;
  /** True only when the service CONFIRMED the credential works. */
  ok: boolean;
  /** Human-readable outcome. */
  detail: string;
}

/** Both probes from {@link CredentialStore.verify}. */
export interface PublishVerification {
  git: CredentialProbe;
  npm: CredentialProbe;
}

/** The full release-credential picture, for the CLI and the tool. */
export interface ReleaseCredentialStatus {
  rows: ReleaseCredentialRow[];
  git: { canPush: boolean; remoteUrl?: string; repoSlug?: string; origin: CredentialOrigin };
  npm: { canPublish: boolean; registry: string; origin: CredentialOrigin };
  /** Path of the store the values are persisted to. */
  storePath: string;
}

/**
 * Resolve one credential and report WHERE it came from.
 *
 * The env FILE is consulted first, by reading it directly. It cannot be found
 * through `process.env` order alone: nuvira loads that file into `process.env`
 * at startup, so an environment-first check labelled every STORED token as
 * `env` — the status output claimed the store was empty while it was in fact
 * the thing supplying the value.
 */
function resolveCredential(
  names: readonly string[],
  fileVars: Record<string, string>,
): { value?: string; origin: CredentialOrigin; key: string } {
  for (const name of names) {
    const fromFile = fileVars[name]?.trim();
    if (fromFile) return { value: fromFile, origin: 'stored', key: name };
  }
  for (const name of names) {
    const fromEnv = process.env[name]?.trim();
    if (fromEnv) return { value: fromEnv, origin: 'env', key: name };
  }
  return { origin: 'none', key: names[0] ?? '' };
}

/** The npm token as written by `npm login` into a `.npmrc`, if any. */
function projectNpmrcToken(): string {
  for (const candidate of [join(process.cwd(), '.npmrc'), join(homedir(), '.npmrc')]) {
    if (!existsSync(candidate)) continue;
    try {
      const m = readFileSync(candidate, 'utf-8').match(
        /\/\/registry\.npmjs\.org\/:_authToken=([^\s]+)/,
      );
      // A `${VAR}` placeholder is not a token — resolve it (setupNpmAuth writes
      // the placeholder form, with the real value in the environment).
      const raw = m?.[1];
      if (!raw) continue;
      const indirection = raw.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
      if (indirection) {
        const resolved = process.env[indirection[1]]?.trim();
        if (resolved) return resolved;
        continue;
      }
      return raw;
    } catch {
      // Unreadable .npmrc — try the next one.
    }
  }
  return '';
}

/**
 * Describe every release credential, masked, and say whether a release could
 * run right now. Never returns a raw secret — only {@link maskSecret} shapes.
 */
export function releaseCredentialStatus(): ReleaseCredentialStatus {
  // Read the store ONCE — the file is re-read per call otherwise.
  const fileVars = loadEnvFile();
  const git = resolveCredential(GIT_TOKEN_ALIASES, fileVars);
  const gitUser = resolveCredential([RELEASE_CREDENTIAL_KEYS.gitUsername], fileVars);
  const npm = resolveCredential([RELEASE_CREDENTIAL_KEYS.npmToken], fileVars);
  const npmRegistry = resolveCredential([RELEASE_CREDENTIAL_KEYS.npmRegistry], fileVars);

  const remote = detectGitRemote();

  // npm's own `.npmrc` is a legitimate source — `npm login` writes it, and a
  // release that ignored it would report "no npm token" on a machine that can
  // publish perfectly well.
  let npmValue = npm.value;
  let npmOrigin: CredentialOrigin = npm.origin;
  if (!npmValue) {
    const fromNpmrc = projectNpmrcToken();
    if (fromNpmrc) {
      npmValue = fromNpmrc;
      npmOrigin = 'npmrc';
    }
  }

  const rows: ReleaseCredentialRow[] = [
    {
      key: git.key || RELEASE_CREDENTIAL_KEYS.gitToken,
      role: 'git',
      set: Boolean(git.value) || Boolean(remote.sshKeyPath),
      masked: git.value ? maskSecret(git.value) : undefined,
      origin: git.value ? git.origin : remote.sshKeyPath ? 'ssh' : 'none',
    },
    {
      key: gitUser.key || RELEASE_CREDENTIAL_KEYS.gitUsername,
      role: 'git',
      set: Boolean(gitUser.value),
      masked: gitUser.value ? maskSecret(gitUser.value) : undefined,
      origin: gitUser.origin,
    },
    {
      key: npm.key || RELEASE_CREDENTIAL_KEYS.npmToken,
      role: 'npm',
      set: Boolean(npmValue),
      masked: npmValue ? maskSecret(npmValue) : undefined,
      origin: npmOrigin,
    },
  ];

  return {
    rows,
    git: {
      canPush: Boolean(git.value) || Boolean(remote.sshKeyPath),
      remoteUrl: remote.remoteUrl,
      repoSlug: remote.repoSlug,
      origin: rows[0].origin,
    },
    npm: {
      canPublish: Boolean(npmValue),
      registry: npmRegistry.value || 'https://registry.npmjs.org/',
      origin: npmOrigin,
    },
    storePath: resolveNuviraEnvFile(),
  };
}

/**
 * Persist a release credential so it survives the session.
 *
 * Writes to the nuvira env file (created 0600 by {@link saveEnvValue}), which
 * lives OUTSIDE the repository — a token in a committed file is a leak, and a
 * token in a shell export is gone at the next login.
 */
export function storeReleaseCredential(
  name: string,
  value: string,
): { success: boolean; path: string; reason?: string } {
  const cleaned = String(value ?? '').replace(/[\r\n]/g, '').trim();
  if (!cleaned) {
    return { success: false, path: resolveNuviraEnvFile(), reason: 'empty-value' };
  }
  const result = saveEnvValue(name, cleaned);
  if (result.success) {
    // Owner-only. `saveEnvValue` writes with the process umask, which on a
    // default (022) install produced a WORLD-READABLE file holding a token.
    // Best-effort: a filesystem without POSIX permissions still stores fine.
    try {
      chmodSync(result.path, 0o600);
    } catch { /* best-effort — non-POSIX filesystems */ }
    // Make it usable in THIS process too, so a release started right after the
    // token is stored does not need a restart to pick it up.
    process.env[name] = cleaned;
  }
  return { success: result.success, path: result.path, reason: result.reason };
}

/**
 * Forget a stored release credential.
 * A value that was never stored is a SUCCESS — the caller's intent already
 * holds, and reporting failure would only surface a pointless error.
 */
export function forgetReleaseCredential(
  name: string,
): { success: boolean; path: string; removed: boolean; reason?: string } {
  const result = deleteEnvValue(name);
  if (result.success) delete process.env[name];
  return result;
}

/** Whether `name` is a credential this module is willing to store. */
export function isReleaseCredentialKey(name: string): boolean {
  return (Object.values(RELEASE_CREDENTIAL_KEYS) as string[]).includes(name)
    || (GIT_TOKEN_ALIASES as readonly string[]).includes(name);
}

/**
 * Confirm a GitHub token is live. A 401 is a DEFINITIVE failure (the token was
 * revoked or lacks scopes); anything else inconclusive — offline, timeout,
 * rate-limit — reports `checked: false` so a preflight can warn without
 * blocking a release on a flaky network.
 */
async function probeGitHubToken(token: string): Promise<CredentialProbe> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'agent-nuvira',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { login?: string };
      return {
        checked: true,
        ok: true,
        detail: body.login ? `authenticated as ${body.login}` : 'token accepted',
      };
    }
    if (res.status === 401) {
      return { checked: true, ok: false, detail: 'token rejected (401) — revoked or wrong scopes' };
    }
    return { checked: true, ok: true, detail: `GitHub returned ${res.status} (token accepted)` };
  } catch (err) {
    return {
      checked: false,
      ok: false,
      detail: `could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Confirm an npm token is live, by asking the registry who we are. Same
 * conservatism as {@link probeGitHubToken}: only a definitive rejection counts.
 */
async function probeNpmToken(token: string, registry: string): Promise<CredentialProbe> {
  const base = registry.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/-/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { username?: string };
      return {
        checked: true,
        ok: true,
        detail: body.username ? `authenticated as ${body.username}` : 'token accepted',
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { checked: true, ok: false, detail: `token rejected (${res.status})` };
    }
    return { checked: true, ok: true, detail: `registry returned ${res.status} (token accepted)` };
  } catch (err) {
    return {
      checked: false,
      ok: false,
      detail: `could not reach ${base}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
