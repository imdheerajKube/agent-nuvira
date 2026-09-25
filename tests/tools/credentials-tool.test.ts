/**
 * `credentials` tool tests — the store surface the agent uses to make a release
 * possible without the user re-exporting tokens.
 *
 * Two invariants are load-bearing here and are asserted directly:
 *   1. The tool NEVER echoes a secret back into the transcript.
 *   2. `store` without a value asks the USER (never invents one).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SECRET = 'ghp_supersecrettoken0123456789';
const NPM_SECRET = 'npm_supersecrettoken0123456789';

describe('credentials tool', () => {
  let testDir: string;
  let runCredentialsTool: typeof import('../../src/tools/credentials-tool.js')['runCredentialsTool'];
  let realHome: string | undefined;
  let realCwd: string;
  const ctx = { configManager: {} } as never;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'creds-tool-test-'));
    // Never touch the developer's real profile.
    process.env.NUVIRA_ENV_FILE = join(testDir, '.env');
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.NPM_TOKEN;
    delete process.env.GIT_USERNAME;

    // Hermetic against `.npmrc`: the repo's own .npmrc holds a REAL npm token,
    // and `verify` would otherwise make a live call to the npm registry from a
    // unit test. Point HOME and cwd at the temp dir so only the store can
    // supply a credential.
    realHome = process.env.HOME;
    realCwd = process.cwd();
    process.env.HOME = testDir;
    (process as any).cwd = () => testDir;

    ({ runCredentialsTool } = await import('../../src/tools/credentials-tool.js'));
  });

  afterEach(() => {
    delete process.env.NUVIRA_ENV_FILE;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.NPM_TOKEN;
    delete process.env.GIT_USERNAME;
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    (process as any).cwd = () => realCwd;
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('status is the default action and lists the credential keys', async () => {
    const out = await runCredentialsTool({}, ctx);
    expect(out).toContain('Release credentials');
    expect(out).toContain('GITHUB_TOKEN');
    expect(out).toContain('NPM_TOKEN');
  });

  it('status reports a missing token so the model knows to ask for it', async () => {
    const out = await runCredentialsTool({ action: 'status' }, ctx);
    expect(out).toContain('❌');
    expect(out).toContain('ask_user');
  });

  it('stores a token and never echoes the value back', async () => {
    const out = await runCredentialsTool(
      { action: 'store', key: 'GITHUB_TOKEN', value: SECRET },
      ctx,
    );

    expect(out).toContain('✅ Stored GITHUB_TOKEN');
    // The invariant: the secret does not appear in the tool result.
    expect(out).not.toContain(SECRET);

    // …and it really landed on disk.
    const written = readFileSync(process.env.NUVIRA_ENV_FILE!, 'utf-8');
    expect(written).toContain(SECRET);
  });

  it('reports a stored token in status, masked, with its origin', async () => {
    await runCredentialsTool({ action: 'store', key: 'NPM_TOKEN', value: NPM_SECRET }, ctx);
    // Drop the env copy so the origin is reported as the STORE.
    delete process.env.NPM_TOKEN;

    const out = await runCredentialsTool({ action: 'status' }, ctx);
    expect(out).toContain('npm_…6789');
    expect(out).toContain('(from stored)');
    expect(out).not.toContain(NPM_SECRET);
  });

  it('store without a value refuses and points at ask_user', async () => {
    const out = await runCredentialsTool({ action: 'store', key: 'NPM_TOKEN' }, ctx);
    expect(out).toContain('needs a value');
    expect(out).toContain('ask_user');
    expect(existsSync(process.env.NUVIRA_ENV_FILE!)).toBe(false);
  });

  it('refuses a key it does not store', async () => {
    const out = await runCredentialsTool(
      { action: 'store', key: 'AWS_SECRET_ACCESS_KEY', value: 'nope' },
      ctx,
    );
    expect(out).toContain('is not a release credential');
    expect(out).toContain('NPM_TOKEN');
  });

  it('store without a key explains which keys are valid', async () => {
    const out = await runCredentialsTool({ action: 'store' }, ctx);
    expect(out).toContain('needs a key');
    expect(out).toContain('GITHUB_TOKEN');
  });

  it('forget removes a stored token', async () => {
    await runCredentialsTool({ action: 'store', key: 'NPM_TOKEN', value: NPM_SECRET }, ctx);

    const out = await runCredentialsTool({ action: 'forget', key: 'NPM_TOKEN' }, ctx);
    expect(out).toContain('Removed NPM_TOKEN');

    const written = existsSync(process.env.NUVIRA_ENV_FILE!)
      ? readFileSync(process.env.NUVIRA_ENV_FILE!, 'utf-8')
      : '';
    expect(written).not.toContain(NPM_SECRET);
  });

  it('forget on an unset key is reported as a no-op, not an error', async () => {
    const out = await runCredentialsTool({ action: 'forget', key: 'NPM_TOKEN' }, ctx);
    expect(out).toContain('nothing to remove');
  });

  it('verify without any credentials says so instead of probing', async () => {
    const out = await runCredentialsTool({ action: 'verify' }, ctx);
    expect(out).toContain('No credentials to verify');
  });
});
