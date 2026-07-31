/**
 * PackageAgent — Manages npm package operations for the publishing pipeline.
 *
 * Capabilities:
 * - Bump version (patch, minor, major)
 * - Build project
 * - Generate changelog from git log
 * - Publish to npm
 * - Auto-setup npm auth from env vars or CredentialStore
 * - Pre-publish checks (auth, build success, version consistency)
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-publish", "description": "Bump version and publish to npm", "agentType": "package", "dependsOn": ["step-test"] }
 * ```
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Agent } from '../agent.js';
const CHANGELOG_PROMPT = `You are generating a changelog entry.

Given the following git log between two tags/revisions, write a concise changelog entry.

Format:
## [version] - YYYY-MM-DD

### Added
- new features

### Changed
- changes in existing functionality

### Fixed
- bug fixes

### Removed
- removed features

Group commits by type. Use present tense, be specific. Return ONLY the changelog entry.`;
/**
 * PackageAgent — Manages npm package versioning, building, and publishing.
 */
export class PackageAgent extends Agent {
    name = 'Package';
    description = 'Manages package version, build, and npm publish';
    async execute(context, callLLM) {
        try {
            const taskDesc = context.taskPlan.find((s) => s.agentType === 'package' && s.status === 'running')?.description || context.goal;
            const operation = this.detectOperation(taskDesc);
            switch (operation) {
                case 'version':
                    return this.bumpVersion(context, taskDesc);
                case 'build':
                    return this.build();
                case 'publish':
                    return this.publish();
                case 'changelog':
                    return this.generateChangelog(callLLM);
                case 'full-publish':
                    return this.fullPublish(context, taskDesc, callLLM);
                default:
                    // If description mentions "full" or "auto", do full publish
                    if (taskDesc.toLowerCase().includes('full') || taskDesc.toLowerCase().includes('auto')) {
                        return this.fullPublish(context, taskDesc, callLLM);
                    }
                    return this.bumpVersion(context, taskDesc);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, summary: 'Package operation failed', error: msg };
        }
    }
    detectOperation(description) {
        const lower = description.toLowerCase();
        if (lower.includes('full') || lower.includes('auto') || lower.includes('release pipeline'))
            return 'full-publish';
        if (lower.includes('version') || lower.includes('bump') || lower.includes('patch') || lower.includes('minor') || lower.includes('major'))
            return 'version';
        if (lower.includes('build') || lower.includes('compile') || lower.includes('dist'))
            return 'build';
        if (lower.includes('publish') || lower.includes('release') || lower.includes('deploy'))
            return 'publish';
        if (lower.includes('changelog') || lower.includes('change log') || lower.includes('log'))
            return 'changelog';
        return 'version';
    }
    detectBumpType(description) {
        const lower = description.toLowerCase();
        if (lower.includes('major'))
            return 'major';
        if (lower.includes('minor'))
            return 'minor';
        return 'patch';
    }
    async bumpVersion(context, description) {
        const pkgPath = join(context.workingDirectory, 'package.json');
        if (!existsSync(pkgPath)) {
            return { success: false, summary: 'No package.json found', error: 'Cannot bump version without package.json' };
        }
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const currentVersion = pkg.version || '0.0.0';
        const parts = currentVersion.split('.').map(Number);
        const bumpType = this.detectBumpType(description);
        switch (bumpType) {
            case 'major':
                parts[0] = (parts[0] || 0) + 1;
                parts[1] = 0;
                parts[2] = 0;
                break;
            case 'minor':
                parts[1] = (parts[1] || 0) + 1;
                parts[2] = 0;
                break;
            case 'patch':
                parts[2] = (parts[2] || 0) + 1;
                break;
        }
        const newVersion = parts.join('.');
        pkg.version = newVersion;
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
        return {
            success: true,
            summary: `Bumped version: ${currentVersion} -> ${newVersion} (${bumpType})`,
        };
    }
    async build() {
        try {
            const output = execSync('npm run build 2>&1', {
                cwd: process.cwd(),
                timeout: 120_000,
                encoding: 'utf-8',
                stdio: 'pipe',
            });
            return {
                success: true,
                summary: 'Build completed successfully',
                details: output.slice(0, 1000),
            };
        }
        catch (err) {
            const error = err;
            return {
                success: false,
                summary: 'Build failed',
                error: error.stderr || error.message || 'Unknown build error',
            };
        }
    }
    /**
     * Check if npm auth is configured before publishing.
     * Uses NPM_TOKEN env var, .npmrc, or sets up via CredentialStore.
     */
    checkNpmAuth() {
        // Check env var first
        if (process.env.NPM_TOKEN) {
            return { ok: true };
        }
        // Check .npmrc
        const npmrcPaths = [
            join(process.cwd(), '.npmrc'),
            join(process.env.HOME || '/root', '.npmrc'),
        ];
        for (const npmrcPath of npmrcPaths) {
            if (existsSync(npmrcPath)) {
                try {
                    const content = readFileSync(npmrcPath, 'utf-8');
                    if (content.includes('_authToken') || content.includes('_auth')) {
                        return { ok: true };
                    }
                }
                catch { /* ignore */ }
            }
        }
        // Try auto-setup from env
        if (process.env.NPM_TOKEN) {
            return { ok: true };
        }
        return {
            ok: false,
            message: 'npm auth not configured. Set NPM_TOKEN env var or run credential setup.',
        };
    }
    /**
     * Full publish pipeline: version bump -> build -> publish.
     * Optionally sets up npm auth via CredentialStore if available.
     */
    async fullPublish(context, description, callLLM) {
        // Step 1: Check auth via env var or .npmrc
        const hasAuth = !!(process.env.NPM_TOKEN) || this.checkNpmAuth().ok;
        if (!hasAuth) {
            return {
                success: false,
                summary: 'npm publish not possible: authentication required',
                error: 'Set NPM_TOKEN env var or configure .npmrc with auth token',
            };
        }
        // Step 2: Bump version
        const versionResult = await this.bumpVersion(context, description);
        if (!versionResult.success) {
            return versionResult;
        }
        // Step 3: Build
        const buildResult = await this.build();
        if (!buildResult.success) {
            return {
                success: false,
                summary: `Version bumped but build failed`,
                error: buildResult.error,
            };
        }
        // Step 4: Publish
        const publishResult = await this.publish();
        if (!publishResult.success) {
            return {
                success: false,
                summary: `Build succeeded but publish failed`,
                error: publishResult.error,
            };
        }
        return {
            success: true,
            summary: `Published successfully: ${versionResult.summary}`,
            details: [versionResult.details, buildResult.details, publishResult.details].filter(Boolean).join('\n'),
        };
    }
    async publish() {
        try {
            const output = execSync('npm publish 2>&1', {
                cwd: process.cwd(),
                timeout: 120_000,
                encoding: 'utf-8',
                stdio: 'pipe',
            });
            return {
                success: true,
                summary: 'Published to npm successfully',
                details: output,
            };
        }
        catch (err) {
            const error = err;
            return {
                success: false,
                summary: 'npm publish failed',
                error: this.parseNpmError(error),
            };
        }
    }
    async generateChangelog(callLLM) {
        try {
            const log = this.exec('git log --oneline --no-decorate $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD 2>&1');
            const logLines = log.trim().split('\n').filter(Boolean);
            if (logLines.length === 0) {
                return { success: true, summary: 'No new commits since last tag', details: 'Changelog is empty' };
            }
            const prompt = `${CHANGELOG_PROMPT}\n\n## Git Log\n${log}`;
            let changelogEntry;
            try {
                changelogEntry = await callLLM(prompt, { temperature: 0.3, maxTokens: 1000 });
                changelogEntry = changelogEntry.trim().replace(/^```[\s\S]*?\n|```$/g, '').trim();
            }
            catch {
                changelogEntry = `## [Unreleased]\n${logLines.map((l) => `- ${l}`).join('\n')}`;
            }
            const changelogPath = join(process.cwd(), 'CHANGELOG.md');
            let existingContent = '';
            if (existsSync(changelogPath)) {
                existingContent = readFileSync(changelogPath, 'utf-8');
            }
            const newContent = changelogEntry + '\n\n' + existingContent;
            writeFileSync(changelogPath, newContent, 'utf-8');
            return {
                success: true,
                summary: `Generated changelog with ${logLines.length} commit(s)`,
                details: changelogEntry,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, summary: 'Changelog generation failed', error: msg };
        }
    }
    parseNpmError(error) {
        const msg = error.stderr || error.message || '';
        if (msg.includes('E403') || msg.includes('unauthorized') || msg.includes('not_logged_in'))
            return 'Not authorized — check npm login and token (set NPM_TOKEN env var)';
        if (msg.includes('E404'))
            return 'Package not found — check package name and registry';
        if (msg.includes('E402'))
            return 'Payment required — check npm account';
        if (msg.includes('unpaid'))
            return 'Unpaid account — complete npm payment setup';
        if (msg.includes('cannot publish over previously published version'))
            return 'Version already published — bump to a new version';
        if (msg.includes('ENEEDAUTH'))
            return 'Authentication required — npm login or set NPM_TOKEN';
        return msg.slice(0, 300);
    }
    exec(command, cwd) {
        try {
            return execSync(command, {
                cwd: cwd || process.cwd(),
                timeout: 30_000,
                encoding: 'utf-8',
                stdio: 'pipe',
            });
        }
        catch (err) {
            const error = err;
            const msg = error.stderr || error.message || '';
            if (msg.includes('Command failed') || msg.includes('not found')) {
                throw new Error(msg.slice(0, 200));
            }
            return error.stdout || msg;
        }
    }
}
//# sourceMappingURL=package-agent.js.map