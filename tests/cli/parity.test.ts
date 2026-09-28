/**
 * `nuvira parity` — the harness, from the CLI.
 *
 * The registry, the debt ratchet and the capability matrix used to be assertions
 * only a test could make. This pins the command that exposes them (and the
 * driven comparison) to a terminal/script/CI, and pins the two things that make
 * it trustworthy: a real drift fails the process, and a run without the
 * repository sources says so instead of reporting a clean bill of health for an
 * empty graph.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  ParityCommand,
  capabilityMatrixCheck,
  surfaceDebtCheck,
  surfaceReachCheck,
} from '../../src/cli/parity.js';
import { logger } from '../../src/utils/logger.js';

describe('nuvira parity', () => {
  afterEach(() => {
    // `report()` sets `process.exitCode = 1` on failure; a leaked failure code
    // would fail the suite itself.
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  async function run(args: string[]): Promise<string> {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => logs.push('ERR: ' + a.map(String).join(' ')));
    for (const method of ['highlight', 'info', 'warn', 'error', 'success'] as const) {
      vi.spyOn(logger, method).mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(' '));
      });
    }
    await new ParityCommand().create().parseAsync(['node', 'nuvira', ...args]);
    return logs.join('\n');
  }

  it('prints a summary and the subcommands for a bare `nuvira parity`', async () => {
    const text = await run([]);
    expect(text).toContain('Surface-parity harness');
    expect(text).toContain('nuvira parity run');
    expect(text).toContain('nuvira parity debt');
  });

  it('compares the registry against the real import graph', async () => {
    const text = await run(['surfaces']);
    expect(text).toContain('Surface registry vs the real import graph');
    for (const surface of ['cli-chat', 'cli-execute', 'dashboard-chat', 'gateway-chat', 'subagent']) {
      expect(text).toContain(surface);
    }
    // The live tree is clean — a real drift would (correctly) flip this to '✗'.
    expect(text).toContain('✓ every surface matches its declaration.');
    expect(process.exitCode).not.toBe(1);
  });

  it('holds the debt ratchet and exits 0 when the tree is clean', async () => {
    const text = await run(['debt']);
    expect(text).toContain('Surface debt ratchet');
    expect(text).toContain('provider-factory');
    expect(text).toContain('pipeline-wrapper-bypass');
    expect(text).toContain('✓ the debt ratchet holds');
    expect(process.exitCode).not.toBe(1);
  });

  it('shows the capability matrix and every workstream', async () => {
    const text = await run(['matrix']);
    expect(text).toContain('Capability matrix');
    expect(text).toContain('turn-parity');
    expect(text).toContain('tool-call-lifecycle');
    expect(text).toContain('findings-verdicts');
    expect(process.exitCode).not.toBe(1);
  });

  it('drives every surface and reports the verdict', async () => {
    const text = await run(['run']);
    expect(text).toContain('Driving every surface');
    expect(text).toContain('plain-completion');
    expect(text).toContain('single-tool-call');
    expect(text).toContain('at-par');
    expect(text).toContain('✓ every surface is at par.');
    expect(process.exitCode).not.toBe(1);
  }, 90_000);

  it('fails honestly when the repository sources are absent', async () => {
    // The graph checks read `src/` directly. Run against a directory that is not
    // a checkout they must FAIL — a classifier that finds nothing and reports
    // success is how a check stops checking.
    for (const check of [surfaceReachCheck('/nonexistent-parity-root'), surfaceDebtCheck('/nonexistent-parity-root')]) {
      expect(check.ok).toBe(false);
      expect(check.lines.join('\n')).toContain('cannot find the repository sources');
    }
  });

  it('agrees with the test-side invariants on a clean tree', () => {
    // Same facts the parity suite asserts, exposed as data: the helpers are the
    // single source the command prints from.
    expect(surfaceReachCheck().ok).toBe(true);
    expect(surfaceDebtCheck().ok).toBe(true);
    expect(capabilityMatrixCheck().ok).toBe(true);
  });
});
