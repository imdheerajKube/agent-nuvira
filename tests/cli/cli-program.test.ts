/**
 * Smoke test for the CLI dispatcher (`src/cli/cli-program.ts`).
 *
 * Why this file exists: `createCLI()` used to live in `src/cli/router.ts`
 * alongside `resolveProvider()` — a service 17 modules import. That made the
 * provider-resolution service depend on ~35 command modules while those
 * commands imported the service back, which is what sustained a 28-module
 * import cycle. The dispatcher now lives in its own leaf module. Nothing
 * exercised it, so a broken registration (a missing command, a duplicated
 * name) would only surface when a user ran the CLI.
 *
 * Asserted here:
 *   1. the program builds and registers the full command surface, uniquely
 *      named;
 *   2. the two roles stayed split — router.ts is a SERVICE module (no command
 *      registration, no dependency on the command layer), so the cycle cannot
 *      creep back in through a lazy import.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCLI } from '../../src/cli/cli-program.js';
import { resolveProvider } from '../../src/cli/router.js';

describe('createCLI — dispatcher', () => {
  it('registers the full command surface with unique names', () => {
    const program = createCLI();

    const names = program.commands.map((c) => c.name());
    expect(names.length).toBeGreaterThan(30);
    expect(new Set(names).size).toBe(names.length);
    for (const expected of ['chat', 'execute', 'plan', 'edit', 'config', 'models']) {
      expect(names).toContain(expected);
    }
    expect(program.helpInformation()).toContain('Usage:');
  });

  it('leaves the isolation and resume flags UNSET, so the environment can still ask for them', () => {
    // WS5 (#27). `NUVIRA_ISOLATE` / `NUVIRA_RESUME` are how a surface WITHOUT a
    // command line asks for these (the dashboard, the gateway, the harness), and
    // the precedence is deliberate: an explicit flag outranks the environment, so
    // `--no-isolate`-style opt-out is possible. That only works if "the operator
    // typed nothing" is `undefined` — commander's own `false` default is an
    // explicit DECLINE, and both resolvers honour it. Measured on the real CLI: a
    // `false` default made `NUVIRA_ISOLATE=1 nuvira execute …` write into the real
    // tree while every in-process driver (which passes no option at all) isolated.
    const program = createCLI();
    const checked: string[] = [];
    for (const name of ['chat', 'execute']) {
      const command = program.commands.find((c) => c.name() === name);
      expect(command, `${name} is not registered`).toBeDefined();
      for (const long of ['--worktree', '--keep-worktree', '--resume']) {
        const option = command!.options.find((o) => o.long === long);
        expect(option, `${name} ${long} is not registered`).toBeDefined();
        expect(option!.defaultValue, `${name} ${long} must have NO default`).toBeUndefined();
        checked.push(`${name} ${long}`);
      }
    }
    expect(checked).toHaveLength(6);
  });

  it('reads the isolation and resume flags as absent-or-asked, with no third state', () => {
    const program = createCLI();
    const execute = program.commands.find((c) => c.name() === 'execute')!;
    // Absent: nobody asked — the environment is still free to.
    execute.parseOptions([]);
    expect(execute.opts().worktree).toBeUndefined();
    expect(execute.opts().keepWorktree).toBeUndefined();
    expect(execute.opts().resume).toBeUndefined();
    // Typed: asked, and `--resume` with no id means the auto record rather than an
    // empty string, which is what `openResume` reads as "this ask, this directory".
    execute.parseOptions(['--worktree', '--keep-worktree', '--resume']);
    expect(execute.opts().worktree).toBe(true);
    expect(execute.opts().keepWorktree).toBe(true);
    expect(execute.opts().resume).toBe(true);
    // And a named record is passed through as written.
    execute.parseOptions(['--resume', 'ci-run-7']);
    expect(execute.opts().resume).toBe('ci-run-7');
  });

  it('keeps router.ts a pure service module (the cycle source)', () => {
    expect(typeof resolveProvider).toBe('function');

    const routerSource = readFileSync(join(process.cwd(), 'src/cli/router.ts'), 'utf-8');
    // No command registration in the service module.
    expect(routerSource).not.toMatch(/new Command\(/);
    // And no path back into the dispatcher (static OR lazy import).
    expect(routerSource).not.toMatch(/from\s+'\.\/cli-program/);
    expect(routerSource).not.toMatch(/import\(\s*'\.\/cli-program/);
  });
});
