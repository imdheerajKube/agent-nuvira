/**
 * The USER-OWNED command policy (`~/.nuvira/command-policy.json`).
 *
 * The behaviour under test is the one a deny entry gets wrong: a deny is
 * unpromptable, so `approve` must produce a QUESTION, not a refusal, while
 * `allow` is the only thing that runs unasked — and neither can reach a command
 * the user's own `deny` list refuses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { classifyCommand } from '../../src/tools/run-terminal.js';
import { describePolicyDenial, resetCommandPolicyCache } from '../../src/tools/command-policy.js';

describe('user command policy', () => {
  let dir = '';
  let file = '';

  const write = (policy: unknown) => writeFileSync(file, JSON.stringify(policy));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'buff-command-policy-'));
    file = join(dir, 'command-policy.json');
    process.env.NUVIRA_COMMAND_POLICY = file;
    resetCommandPolicyCache();
  });

  afterEach(() => {
    delete process.env.NUVIRA_COMMAND_POLICY;
    resetCommandPolicyCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves the built-in policy untouched when no file exists', () => {
    expect(classifyCommand('git push')).toBe('deny');
    expect(classifyCommand('rm -rf /')).toBe('deny');
  });

  it('`approve` turns a built-in denial into ONE human approval', () => {
    write({ approve: ['git push', 'kill -9'] });

    expect(classifyCommand('git push origin main')).toBe('confirm');
    expect(classifyCommand('kill -9 1234')).toBe('confirm');
    // A chain and an env assignment are still command positions.
    expect(classifyCommand('cd app && git push origin main')).toBe('confirm');

    // Only what the user named — the rest of the floor still holds.
    expect(classifyCommand('rm -rf /')).toBe('deny');
    expect(classifyCommand('sudo ls')).toBe('deny');
  });

  it('`allow` runs without asking; `deny` always refuses', () => {
    write({ allow: ['kill'], deny: ['rm -rf build'] });

    expect(classifyCommand('kill 1234')).toBe('verify');
    expect(classifyCommand('rm -rf build')).toBe('deny');
    // The refusal names the USER's rule, not an anonymous policy.
    expect(describePolicyDenial('rm -rf build')).toContain('rm -rf build');
  });

  it('the user deny wins over allow for the same prefix', () => {
    write({ allow: ['npm publish'], deny: ['npm publish'] });
    expect(classifyCommand('npm publish')).toBe('deny');
  });

  it('`allow` on a floor-denied command still ASKS — never runs silently', () => {
    write({ allow: ['git push'] });
    expect(classifyCommand('git push')).toBe('confirm');
  });

  it('matches at a command position, not as a substring', () => {
    write({ approve: ['git push'] });
    // Discussing the command is not running it.
    expect(classifyCommand('grep -r "git push" .')).not.toBe('confirm');
    expect(classifyCommand('echo "git push"')).not.toBe('confirm');
  });

  it('edits take effect without a restart', () => {
    write({ approve: ['git push'] });
    expect(classifyCommand('git push')).toBe('confirm');

    write({});
    expect(classifyCommand('git push')).toBe('deny');
  });

  it('a malformed file is ignored, not trusted', () => {
    writeFileSync(file, '{ not json');
    expect(classifyCommand('git push')).toBe('deny');
  });
});
