/**
 * G16 — the four confirmation-gated tools, tested through the REAL registry.
 *
 * The audit (see ENTERPRISE_GRADE_TRACKER.md §G16) found that only `write_file`
 * had the authorization input it needed. `edit_file`, `run_terminal` (confirm
 * class), `run_cli` (confirmation intents) and `git commit` were binary —
 * confirm or refuse — so they could not tell work the user ordered from
 * something the model invented, and every one of them reached for `ask_user`.
 *
 * These tests pin BOTH directions, which is the point of the whole change:
 *   - the round trip is gone for work the request authorized, and
 *   - nothing irreversible, external, or unrequested gained any autonomy.
 *
 * Hermetic: temp workspace / real temp git repo, no network, no TTY.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { getTool, type ToolContext } from '../../src/tools/registry.js';
import { requestAuthorizesWrites } from '../../src/learning/autonomy-policy.js';
import {
  classifyCommand,
  addsDependency,
  isRecoverableWorkspaceCommand,
  runTerminalTool,
} from '../../src/tools/run-terminal.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nuvira-statechange-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The verdict + raw text the loop derives from the last user message. */
function ctxFor(request: string, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    configManager: {},
    cwd: root,
    writesAuthorized: requestAuthorizesWrites(request),
    authorizationRequest: request,
    ...extra,
  };
}

async function call(tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const t = getTool(tool);
  if (!t) throw new Error(`${tool} not registered`);
  return t.run(args, ctx);
}

// ── edit_file ───────────────────────────────────────────────────────────────

/** A file large enough that a one-line fix is unmistakably surgical. */
const BIG_FILE = Array.from(
  { length: 60 },
  (_, i) => `export function f${i}(x: number): number { return x + ${i}; }`,
).join('\n');

describe('edit_file — the verify loop must not need a human per iteration', () => {
  const FIX_THE_CALC = 'fix the calculator so that division by zero returns 0 instead of NaN';

  function seedBig(): void {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/calc.ts'), BIG_FILE, 'utf-8');
  }

  it('applies a surgical edit on authorized work, without confirm, and says so', async () => {
    seedBig();
    const result = await call(
      'edit_file',
      { path: 'src/calc.ts', old_string: 'return x + 0;', new_string: 'return x + 100;' },
      ctxFor(FIX_THE_CALC),
    );

    // `gated.rel` is a NATIVE path (coding-tools' gatePath), so build the
    // expected spelling with `join` rather than hard-coding the POSIX form.
    expect(result).toContain(`edit_file: applied to '${join('src', 'calc.ts')}'`);
    expect(result).toContain('Applied without asking');
    expect(readFileSync(join(root, 'src/calc.ts'), 'utf-8')).toContain('return x + 100;');
  });

  it('applies a WHOLE-FILE rewrite when the request NAMES the file', async () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    const small = 'A'.repeat(150);
    writeFileSync(join(root, 'src/calc.ts'), small, 'utf-8');

    const result = await call(
      'edit_file',
      { path: 'src/calc.ts', old_string: small, new_string: 'B'.repeat(150) },
      ctxFor('rewrite src/calc.ts to use a lookup table'),
    );

    expect(result).toContain('Applied without asking');
    expect(readFileSync(join(root, 'src/calc.ts'), 'utf-8')).toBe('B'.repeat(150));
  });

  it('still asks when the edit rewrites most of a file the request never named', async () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    const small = 'A'.repeat(150);
    writeFileSync(join(root, 'src/calc.ts'), small, 'utf-8');

    const result = await call(
      'edit_file',
      { path: 'src/calc.ts', old_string: small, new_string: 'B'.repeat(150) },
      // Authorized work, but the request names the calculator, not calc.ts —
      // and a 100% rewrite is exactly what a re-run cannot recover.
      ctxFor(FIX_THE_CALC),
    );

    expect(result).toContain('state-changing — NOT applied');
    expect(result).toContain('ask_user');
    expect(readFileSync(join(root, 'src/calc.ts'), 'utf-8')).toBe(small);
  });

  it('still refuses when there is no loop context at all (back-compat)', async () => {
    seedBig();
    const result = await call(
      'edit_file',
      { path: 'src/calc.ts', old_string: 'return x + 0;', new_string: 'return x + 100;' },
      { configManager: {}, cwd: root },
    );
    expect(result).toContain('state-changing — NOT applied');
    expect(readFileSync(join(root, 'src/calc.ts'), 'utf-8')).toContain('return x + 0;');
  });

  it('VALIDATES before it asks — a non-matching old_string is reported as itself', async () => {
    seedBig();
    const result = await call(
      'edit_file',
      { path: 'src/calc.ts', old_string: 'this text is not in the file', new_string: 'x' },
      ctxFor(FIX_THE_CALC),
    );

    // The old gate asked the user to approve an edit that could never apply.
    expect(result).toContain('NO changes applied');
    expect(result).not.toContain('ask_user');
  });

  it('reports the measured share of the file in the audit event', async () => {
    seedBig();
    const emit = vi.fn();
    await call(
      'edit_file',
      { path: 'src/calc.ts', old_string: 'return x + 0;', new_string: 'return x + 1;' },
      ctxFor(FIX_THE_CALC, { emit }),
    );

    expect(emit).toHaveBeenCalledWith(
      'autonomy:write-applied',
      expect.objectContaining({ tool: 'edit_file', path: join('src', 'calc.ts'), share: expect.any(Number) }),
      'tool-loop',
    );
  });
});

// ── run_terminal ────────────────────────────────────────────────────────────

describe('run_terminal — recoverable workspace commands', () => {
  const SETUP_ASK = 'set up a node project with a src directory and install the dependencies';

  it('runs a workspace mutation without confirm when the request authorized the work', async () => {
    const out = await call('run_terminal', { command: 'mkdir -p src/components' }, ctxFor(SETUP_ASK));

    expect(out).toContain('✅ succeeded');
    expect(out).toContain('Ran without asking');
    expect(existsSync(join(root, 'src/components'))).toBe(true);
  });

  it('still refuses the same command when the request did not authorize the work', async () => {
    const out = await call('run_terminal', { command: 'mkdir -p src/components' }, ctxFor('what does the writer agent do?'));

    expect(out).toContain('needs explicit confirmation');
    expect(out).toContain('ask_user');
    expect(existsSync(join(root, 'src/components'))).toBe(false);
  });

  it('still refuses with no loop context (back-compat)', async () => {
    const out = await runTerminalTool({ command: 'touch marker.txt' }, { configManager: {}, cwd: root });
    expect(out).toContain('needs explicit confirmation');
    expect(existsSync(join(root, 'marker.txt'))).toBe(false);
  });

  it('never treats a GLOBAL install as recoverable — it mutates the machine, not the repo', async () => {
    expect(isRecoverableWorkspaceCommand('npm install -g typescript')).toBe(false);
    const out = await call('run_terminal', { command: 'npm install -g typescript' }, ctxFor(SETUP_ASK));
    expect(out).toContain('needs explicit confirmation');
  });

  it('never grants a recoverable prefix autonomy inside a composed command', async () => {
    for (const command of [
      'mkdir -p a && rm -rf b',
      'npm install lodash && npm publish',
      'touch x > out.txt',
      'npm install lodash | tee log',
    ]) {
      expect(isRecoverableWorkspaceCommand(command), command).toBe(false);
    }
    const out = await call('run_terminal', { command: 'mkdir -p a && rm -rf b' }, ctxFor(SETUP_ASK));
    expect(out).toContain('needs explicit confirmation');
  });

  it('recognises the recoverable install prefixes themselves', () => {
    // The DECLARED forms: they install what the manifest already says, so they
    // introduce nothing new. (This list used to include `npm install lodash` — a
    // command that WRITES a dependency — see the test below for why that is now
    // a confirmation.)
    for (const command of ['npm install', 'npm i', 'npm ci', 'pip install', 'poetry install', 'git add src/x.ts', 'mkdir -p a/b']) {
      expect(isRecoverableWorkspaceCommand(command), command).toBe(true);
    }
  });

  it('never grants autonomy to a command that ADDS a dependency', async () => {
    // The live incident this rule exists for: `bcrypt@^6.0.0` and
    // `express-jwt@^8.5.1` were written into this repo's package.json and
    // package-lock.json mid-release, with no source file referencing either, one
    // `git add -A` from being committed and published. Installing what a manifest
    // declares is setup; DECLARING a dependency is a supply-chain decision and
    // belongs to the human.
    for (const command of [
      'npm install bcrypt',
      'npm i bcrypt express-jwt',
      'npm add bcrypt',
      'yarn add express-jwt',
      'pnpm add left-pad',
      'cargo add serde',
      'pip install requests',
      'uv add fastapi',
      'composer require monolog/monolog',
      // A flag does not make it declared: `--save-dev vitest` writes vitest into
      // devDependencies, which is exactly the change the rule exists to gate.
      'npm install --save-dev vitest',
    ]) {
      expect(isRecoverableWorkspaceCommand(command), command).toBe(false);
    }

    const out = await call('run_terminal', { command: 'npm install bcrypt' }, ctxFor(SETUP_ASK));
    expect(out).toContain('needs explicit confirmation');
  });

  it('keeps flag-driven and path-driven installs recoverable — they declare nothing new', () => {
    for (const command of [
      'pip install -r requirements.txt',
      'pip install -e .',
      'uv pip install -r req.txt',
    ]) {
      expect(isRecoverableWorkspaceCommand(command), command).toBe(true);
    }
  });

  it('names the add-only forms correctly, including the npm i alias', () => {
    // `npm i` is an alias of `npm install`, so the BARE form is setup and the
    // form with a package is not — the argument decides, not the command name.
    expect(addsDependency('npm i')).toBe(false);
    expect(addsDependency('npm i lodash')).toBe(true);
    expect(addsDependency('go get github.com/x/y')).toBe(true);
    expect(addsDependency('go mod tidy')).toBe(false);
  });
});

describe('classifyCommand — a chain is only as safe as its WORST segment', () => {
  it('no longer lets a verify prefix launder a state-changing tail', () => {
    // The audit caught this: the whole string was scored against the verify
    // allowlist, so `npm run build && <anything>` was classified `verify` and
    // ran with no confirmation at all.
    expect(classifyCommand('npm run build && rm -rf src')).toBe('confirm');
    expect(classifyCommand('npx vitest run tests/x.ts && npm publish')).toBe('confirm');
  });

  it('keeps a genuinely all-verify chain running freely (the loop’s normal shape)', () => {
    expect(classifyCommand('npx tsc --noEmit && npx vitest run tests/x.ts')).toBe('verify');
    expect(classifyCommand('git log --oneline | head -5')).toBe('verify');
  });

  it('keeps deny-first on the whole string — a denied command cannot hide in a chain', () => {
    expect(classifyCommand('npm run build && git push origin main')).toBe('deny');
    expect(classifyCommand('echo $(rm -rf /)')).toBe('deny');
  });

  it('classifies a read-only substitution helper as verify', () => {
    expect(classifyCommand('npx vitest run tests/$(basename x).test.ts')).toBe('verify');
  });
});

// ── run_cli ─────────────────────────────────────────────────────────────────

describe('run_cli — the user’s own ask is the confirmation', () => {
  it('does not re-ask for a recoverable intent the user asked for', async () => {
    const out = await call(
      'run_cli',
      { ask: 'stop the dashboard' },
      { configManager: {}, cwd: root, authorizationRequest: 'stop the dashboard' },
    );

    expect(out).not.toContain('needs explicit confirmation');
    // It proceeds to execution — the CLI entry may be absent in a test tree.
    expect(out).toMatch(/CLI entry not found|✅ succeeded|❌ failed/);
  });

  it('still asks when the MODEL chose the intent', async () => {
    const out = await call(
      'run_cli',
      { ask: 'stop the dashboard' },
      { configManager: {}, cwd: root, authorizationRequest: 'write a 12 page story called Kharig Nights' },
    );

    expect(out).toContain('needs explicit confirmation');
    expect(out).toContain("agent's own initiative");
  });

  it('still asks for an IRREVERSIBLE intent even when the user asked for it', async () => {
    const out = await call(
      'run_cli',
      { ask: 'clear conversation history' },
      { configManager: {}, cwd: root, authorizationRequest: 'clear conversation history' },
    );

    expect(out).toContain('needs explicit confirmation');
    expect(out).toContain('cannot be undone');
  });
});

// ── git commit ──────────────────────────────────────────────────────────────

describe('git commit — asking for a commit IS the approval', () => {
  function freshRepo(): ToolContext {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one\n', 'utf-8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\n', 'utf-8');
    return { configManager: {}, cwd: root };
  }

  function log(): string {
    return execFileSync('git', ['log', '--oneline'], { cwd: root, encoding: 'utf-8' }).trim();
  }

  it('commits when the request asked for a commit', async () => {
    const ctx = freshRepo();
    const before = log();

    const out = await call(
      'git',
      { action: 'commit', message: 'Fix the login bug' },
      { ...ctx, authorizationRequest: 'fix the login bug and commit these changes' },
    );

    expect(out).toContain('✅ Committed');
    expect(out).toContain('Committed without asking');
    expect(log()).not.toBe(before);
  });

  it('still asks when the model decided to commit on its own', async () => {
    const ctx = freshRepo();
    const before = log();

    const out = await call(
      'git',
      { action: 'commit', message: 'Fix the login bug' },
      { ...ctx, writesAuthorized: requestAuthorizesWrites('fix the login bug'), authorizationRequest: 'fix the login bug' },
    );

    expect(out).toContain('needs explicit confirmation');
    expect(out).toContain('ask_user');
    expect(log()).toBe(before);
  });

  it('still asks with no loop context (back-compat)', async () => {
    const ctx = freshRepo();
    const out = await call('git', { action: 'commit', message: 'x' }, ctx);
    expect(out).toContain('needs explicit confirmation');
  });
});
