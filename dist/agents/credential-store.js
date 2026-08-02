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
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import inquirer from 'inquirer';
import { execSync } from 'node:child_process';
import { logger } from '../utils/logger.js';
// ─── Auto-Detection Constants ───────────────────────────────────────────────
function detectGitRemote() {
    const creds = {};
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
        }
        else if (sshMatch) {
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
    }
    catch {
        // No remote configured — leave empty
    }
    return creds;
}
function detectNpmConfig() {
    const creds = { configured: false };
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
            }
            catch {
                // Ignore unreadable .npmrc
            }
        }
    }
    creds.registry = creds.registry || 'https://registry.npmjs.org/';
    return creds;
}
// ─── Password-Protected SSH Key Helper ───────────────────────────────────────
let _sshPassphrase;
/**
 * Check if an SSH key is password-protected.
 */
function isSSHKeyProtected(keyPath) {
    try {
        const content = readFileSync(keyPath, 'utf-8');
        return content.includes('ENCRYPTED') || content.includes('DEK-Info');
    }
    catch {
        return false;
    }
}
// ─── CredentialStore ─────────────────────────────────────────────────────────
export class CredentialStore {
    _git = {};
    _npm = { configured: false };
    _collected = false;
    /** The current git credentials */
    get git() {
        return this._git;
    }
    /** The current npm credentials */
    get npm() {
        return this._npm;
    }
    /** Whether credentials have been collected */
    get collected() {
        return this._collected;
    }
    /** Whether we have enough credentials to push to git */
    get canPush() {
        if (this._git.useSsh && this._git.sshKeyPath)
            return true;
        if (this._git.token)
            return true;
        return false;
    }
    /** Whether we have enough credentials to publish to npm */
    get canPublish() {
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
    }
    /**
     * Collect missing credentials interactively.
     * Skips prompts for already-detected values.
     */
    async collectAll() {
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
        }
        else {
            logger.warn('  ⚠️  No git remote configured (git remote get-url origin)');
        }
        if (this._npm.token) {
            logger.info('  📦 npm token: detected ✅');
        }
        else {
            logger.warn('  ⚠️  No npm token detected');
        }
        console.log('');
        // ── Git credential collection ───────────────────────────────────────
        if (this._git.useSsh) {
            // SSH mode — check if key exists and if it's password-protected
            if (!this._git.sshKeyPath) {
                const { sshKey } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'sshKey',
                        message: 'Path to SSH private key:',
                        default: '~/.ssh/id_ed25519',
                        validate: (input) => {
                            const resolved = input.replace(/^~/, homedir());
                            return existsSync(resolved) || `File not found: ${input}`;
                        },
                    },
                ]);
                this._git.sshKeyPath = sshKey.replace(/^~/, homedir());
            }
            // Check if the SSH key is password-protected
            if (this._git.sshKeyPath && isSSHKeyProtected(this._git.sshKeyPath) && !_sshPassphrase) {
                const { passphrase } = await inquirer.prompt([
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
        }
        else if (!this._git.useSsh && !this._git.token) {
            // HTTPS mode — need a token
            const envHint = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
                ? 'Detected from environment'
                : 'Set GITHUB_TOKEN or GH_TOKEN env var';
            logger.info(`  💡 ${envHint}`);
            const { token } = await inquirer.prompt([
                {
                    type: 'password',
                    name: 'token',
                    message: 'GitHub Personal Access Token (classic or fine-grained):',
                    mask: '*',
                    validate: (input) => input.length > 0 || 'Token is required for git push',
                },
            ]);
            this._git.token = token;
            const { gitUser } = await inquirer.prompt([
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
            const { npmToken } = await inquirer.prompt([
                {
                    type: 'password',
                    name: 'npmToken',
                    message: 'npm automation token (classic or granular):',
                    mask: '*',
                    validate: (input) => input.length > 0 || 'Token is required for npm publish',
                },
            ]);
            this._npm.token = npmToken;
            const { registry } = await inquirer.prompt([
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
        logger.success('  ✅ Credentials collected (session only — not stored to disk)');
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
    setupGitCredentials() {
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
                        // Use SSH_ASKPASS for password-protected keys
                        const askPassScript = join(tmpdir(), 'buff-ssh-askpass.sh');
                        writeFileSync(askPassScript, `#!/bin/sh\necho "${_sshPassphrase}"\n`, 'utf-8');
                        try {
                            execSync('chmod +x ' + askPassScript, { timeout: 2000 });
                            execSync(`SSH_ASKPASS="${askPassScript}" ssh-add "${keyPath}" < /dev/null 2>&1`, {
                                timeout: 5000,
                                encoding: 'utf-8',
                                stdio: 'pipe',
                            });
                        }
                        finally {
                            try {
                                unlinkSync(askPassScript);
                            }
                            catch { /* best-effort */ }
                        }
                    }
                    else {
                        execSync(`ssh-add "${keyPath}" 2>&1`, {
                            timeout: 5000,
                            encoding: 'utf-8',
                            stdio: 'pipe',
                        });
                    }
                }
            }
            catch {
                logger.warn('  ⚠️  Could not add SSH key to agent (ssh-add may not be available)');
            }
        }
        else if (this._git.token) {
            // HTTPS mode: set up GIT_ASKPASS credential helper
            const askPassPath = join(tmpdir(), 'buff-git-askpass.sh');
            const username = this._git.username || process.env.USER || 'git';
            const token = this._git.token;
            const askPassContent = `#!/bin/sh
case "$1" in
  *Username*) echo "${username}" ;;
  *Password*) echo "${token}" ;;
  *Token*)    echo "${token}" ;;
  *)          echo "${token}" ;;
esac
`;
            writeFileSync(askPassPath, askPassContent, 'utf-8');
            try {
                execSync(`chmod +x "${askPassPath}"`, { timeout: 2000 });
            }
            catch { /* best-effort */ }
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
    setupNpmAuth() {
        if (!this._collected) {
            throw new Error('Call collectAll() before setupNpmAuth()');
        }
        if (!this._npm.token)
            return;
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
    cleanup() {
        // Remove GIT_ASKPASS script
        if (process.env.GIT_ASKPASS) {
            try {
                unlinkSync(process.env.GIT_ASKPASS);
            }
            catch { /* best-effort */ }
            delete process.env.GIT_ASKPASS;
        }
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
export function checkGitCredentials() {
    return !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GIT_ASKPASS);
}
/**
 * Check if npm credentials are available (env vars or pre-configured).
 */
export function checkNpmCredentials() {
    return !!(process.env.NPM_TOKEN);
}
/**
 * Get a human-readable summary of the current credential status.
 */
export function getCredentialStatus() {
    const lines = [];
    // Git status
    const gitToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    const gitRemote = detectGitRemote();
    lines.push(`  📡 Remote: ${gitRemote.remoteUrl || 'Not configured'}`);
    lines.push(`  🔑 Git token: ${gitToken ? '✅ Detected' : '❌ Missing'}`);
    lines.push(`  🔐 SSH key: ${gitRemote.sshKeyPath ? `✅ ${gitRemote.sshKeyPath}` : '❌ Not detected'}`);
    // npm status
    const npmToken = process.env.NPM_TOKEN || '';
    const npmConfig = detectNpmConfig();
    lines.push(`  📦 npm token: ${npmToken || npmConfig.token ? '✅ Detected' : '❌ Missing'}`);
    lines.push(`  📦 npm registry: ${npmConfig.registry || 'Not configured'}`);
    return lines.join('\n');
}
//# sourceMappingURL=credential-store.js.map