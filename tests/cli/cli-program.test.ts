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
