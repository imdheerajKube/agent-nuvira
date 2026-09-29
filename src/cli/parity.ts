/**
 * `nuvira parity` — run the surface-parity harness from the CLI.
 *
 * WHY THIS EXISTS. WS0 (#22) built the harness as a test suite: the registry,
 * the import-graph ratchet and the capability matrix are pure modules in
 * `src/parity/`, and the drivers that actually run a turn used to live in
 * `tests/parity/` behind `vi.spyOn`. That left "is every surface at par?" as a
 * question only CI could answer. This command makes the same facts — and the
 * same run — available from a terminal, a script or a CI step, which is what
 * the harness was for.
 *
 * FOUR SUBCOMMANDS, in the order a reader wants them:
 *
 *   nuvira parity surfaces   what the registry declares vs what the imports reach
 *   nuvira parity debt       the anti-silo ratchet (observed == declared, exit 1 on drift)
 *   nuvira parity matrix     every capability × surface, and any unproven claim
 *   nuvira parity run        DRIVE all five surfaces through the real harness
 *
 * `surfaces`/`debt`/`matrix` read the real import graph (`src/parity/graph.ts`),
 * so they need the repository SOURCES — they say so and fail honestly when run
 * against an installed package (the alternative is a classifier that finds
 * nothing and reports a clean bill of health, which is how a check stops
 * checking). `run` drives the built surfaces and works from either.
 *
 * Exit codes are the point: each subcommand sets `process.exitCode = 1` on a
 * real failure, so `nuvira parity debt` is usable as a gate.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import { SURFACES, SURFACE_DEBT, TURN_ENTRIES } from '../parity/surfaces.js';
import { classifyAllSurfaces, declaredSurfaceDebt, observedSurfaceDebt } from '../parity/graph.js';
import {
  CAPABILITIES,
  UNVERIFIED_SUPPORTED,
  WORKSTREAM_ISSUES,
  cellKey,
  matrixCells,
} from '../parity/matrix.js';
import { reportParityFailure } from '../parity/observation.js';
import { runParityScenario, type ParityScenario } from '../parity/scenarios.js';

/**
 * The repository root, derived from this module's own location.
 *
 * `dist/cli/parity.js` → `../..` is the repo root, and `src/cli/parity.ts` (the
 * test/source run) resolves to the same place — so the graph checks read the
 * REAL sources whether the command runs from `dist` or from source.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A check result: whether it passed, and the lines to show. */
export interface ParityCheck {
  ok: boolean;
  lines: string[];
}

/** The source marker every import-graph check needs. */
function hasSources(root: string): boolean {
  return existsSync(join(root, 'src', 'cli', 'chat.ts'));
}

const NO_SOURCES = (root: string): ParityCheck => ({
  ok: false,
  lines: [
    `✗ cannot find the repository sources under ${root}.`,
    '  The registry/graph checks read `src/` directly, so they only run from a',
    '  source checkout — run `nuvira parity run` for the driven comparison instead.',
  ],
});

/**
 * The registry versus the real import graph: for each surface, the turn entries
 * it DECLARES against the ones its own modules actually reach. A mismatch here
 * is the drift the registry exists to catch — the same class of bug as the
 * hand-maintained dashboard bundle that silently missed a whole tab.
 */
export function surfaceReachCheck(root = REPO_ROOT): ParityCheck {
  if (!hasSources(root)) return NO_SOURCES(root);
  const reaches = new Map(classifyAllSurfaces(root).map((r) => [r.surface, r]));
  const lines: string[] = ['Surface registry vs the real import graph:'];
  let ok = true;
  for (const surface of SURFACES) {
    const reach = reaches.get(surface.id);
    const declared = [...surface.turnEntries].sort();
    const observed = reach ? reach.entries : [];
    const agrees = JSON.stringify(declared) === JSON.stringify(observed);
    if (!agrees) ok = false;
    lines.push(
      `  ${agrees ? '✅' : '✗ '} ${surface.id.padEnd(15)} engines=[${surface.engines.join(', ')}] entries=[${declared.join(', ')}]` +
        (agrees ? '' : `  ← observed [${observed.join(', ')}]`),
    );
    if (reach) {
      if (reach.providerFactory.length > 0) {
        ok = false;
        lines.push(`      ✗ builds its own provider: ${reach.providerFactory.join(', ')}`);
      }
      if (reach.pipelineWrapperBypass.length > 0) {
        ok = false;
        lines.push(`      ✗ drives the pipeline without the wrapper: ${reach.pipelineWrapperBypass.join(', ')}`);
      }
    }
  }
  lines.push('', ok ? '✓ every surface matches its declaration.' : '✗ the registry drifted from the code.');
  return { ok, lines };
}

/**
 * The anti-silo ratchet. The set of surfaces that build their own provider or
 * bypass the pipeline wrapper must EQUAL the frozen debt list, in both
 * directions: growth means a new silo appeared, and a stale entry means one was
 * fixed and the list still claims it — which would let the next real bypass hide.
 */
export function surfaceDebtCheck(root = REPO_ROOT): ParityCheck {
  if (!hasSources(root)) return NO_SOURCES(root);
  const observed = observedSurfaceDebt(root);
  const declared = declaredSurfaceDebt();
  const lines: string[] = ['Surface debt ratchet (observed must equal declared):'];
  let ok = true;
  const kinds = [...new Set([...Object.keys(observed), ...Object.keys(declared)])].sort();
  for (const kind of kinds) {
    const observedModules = observed[kind] ?? [];
    const declaredModules = declared[kind] ?? [];
    const agrees = JSON.stringify(observedModules) === JSON.stringify(declaredModules);
    if (!agrees) ok = false;
    const frozen = SURFACE_DEBT[kind];
    lines.push(
      `  ${agrees ? '✅' : '✗ '} ${kind}: ${observedModules.length} observed, ${declaredModules.length} declared` +
        (frozen === undefined ? '  ← the rule is no longer declared (frozen list missing)' : ''),
    );
    if (!agrees) {
      lines.push(`      observed: [${observedModules.join(', ')}]`);
      lines.push(`      declared: [${declaredModules.join(', ')}]`);
    }
  }
  lines.push('', ok ? '✓ the debt ratchet holds — no new silo, no stale entry.' : '✗ surface debt drifted.');
  return { ok, lines };
}

/**
 * The capability matrix. Statuses are what we BELIEVE; the unverified list is
 * what the harness does not yet PROVE. The check asserts the invariant the CLI
 * can see on its own: every cell on the frozen debt list is a `supported` cell
 * with a reason (a cell that needs proof but carries no explanation is the debt
 * nobody can act on), and every `scoped` cell says why it differs.
 */
export function capabilityMatrixCheck(): ParityCheck {
  const lines: string[] = ['Capability matrix (status is belief; the debt list is what is unproven):'];
  let ok = true;
  for (const capability of CAPABILITIES) {
    const statuses = SURFACES.map((s) => `${s.id}=${capability.cells[s.id].status}`);
    const issue = WORKSTREAM_ISSUES[capability.workstream];
    const owner = capability.workstream === 'existing' ? 'existing' : `${capability.workstream}${issue ? ` (#${issue})` : ''}`;
    lines.push(`  ${capability.id.padEnd(20)} ${owner.padEnd(12)} ${statuses.join('  ')}`);
  }
  if (UNVERIFIED_SUPPORTED.length === 0) {
    lines.push('  ✅ unverified supported claims: none — every `supported` cell is proven by the parity suite.');
  } else {
    lines.push(`  ⚠ unverified supported claims (${UNVERIFIED_SUPPORTED.length}):`);
    const byKey = new Map(matrixCells().map((c) => [cellKey(c.capability, c.surface), c.cell]));
    for (const key of [...UNVERIFIED_SUPPORTED].sort()) {
      const cell = byKey.get(key);
      const note = cell?.note?.trim();
      if (cell?.status !== 'supported' || !note) {
        ok = false;
        lines.push(`      ✗ ${key} — on the debt list but not a supported cell with a reason`);
      } else {
        lines.push(`      • ${key} — ${note}`);
      }
    }
  }
  for (const entry of matrixCells()) {
    if (entry.cell.status !== 'scoped') continue;
    if (!entry.cell.note?.trim()) {
      ok = false;
      lines.push(`      ✗ ${cellKey(entry.capability, entry.surface)} is scoped with no note`);
    }
  }
  return { ok, lines };
}

/**
 * The scenarios `nuvira parity run` drives on every surface. Kept small and
 * deterministic: a plain completion (does the turn and its attribution agree),
 * a tool call that WORKS, a tool call that FAILS, and the WS1 finding pair — a
 * claim with evidence (promoted to CONFIRMED) and a claim without (the gate
 * refuses the promotion, so every surface must report PLAUSIBLE).
 *
 * The failing case is not a corner. Two surfaces can agree that a tool ran and
 * disagree about whether it worked, and an outcome that is merely ABSENT is not
 * a failure either — `compare` (`src/parity/observation.ts`) treats "no outcome"
 * as equal to "no outcome", so five surfaces that all stopped reporting `ok`
 * would still read as at-par. The test suite pins each of these scenarios by id
 * so the CLI and the suite prove the same thing.
 */
export const PARITY_SCENARIOS: readonly ParityScenario[] = [
  {
    id: 'plain-completion',
    message: 'reply with the single word: parity',
    answer: 'Answered.',
  },
  {
    id: 'single-tool-call',
    message: 'list the working directory, then answer',
    toolCall: { tool: 'list_dir', args: { path: '.' } },
    answer: 'Listed.',
  },
  {
    id: 'failing-tool-call',
    message: 'run a command that fails, then answer',
    // Deterministic by construction, not by luck. The loop's own rule is that a
    // tool result starting with `Error:` is a failure (`tools/tool-loop.ts:1526`,
    // and the child's copy at `tools/child-agent-runtime.ts:405`), and
    // `run_terminal` prefixes exactly that on a non-zero exit
    // (`tools/run-terminal.ts:457`). `node --check` on a missing file is a
    // VERIFY-class command (`tools/run-terminal.ts:95`), so it runs without a
    // confirmation prompt and exits non-zero.
    toolCall: {
      tool: 'run_terminal',
      args: { command: 'node --check no-such-file-parity-probe.js' },
    },
    answer: 'Command failed.',
  },
  {
    id: 'finding-confirmed',
    message: 'record what you checked as a finding, then answer',
    // WS1 (#23) — a finding the turn recorded, on every surface. The stub asks
    // for the `finding` tool WITH a usable evidence reference, so the gate
    // promotes it: the case proves the surface carries the verdict AND the
    // evidence behind it, not merely that a tool ran.
    toolCall: {
      tool: 'finding',
      args: {
        claim: 'the parity harness can drive every surface',
        outcome: 'checked by running the harness',
        evidence: [
          { kind: 'observation', ref: 'all five surfaces reported the same verdict' },
        ],
      },
    },
    answer: 'Recorded.',
  },
  {
    id: 'finding-refused',
    message: 'record a finding you have not checked, then answer',
    // The GATE, proved on every surface: the same tool with a blank evidence
    // reference. `confirmFinding` refuses the promotion, so the verdict stays
    // PLAUSIBLE and the outcome names the refusal. Asserting the PLAUSIBLE
    // verdict (rather than only that the surfaces agree) is what makes this
    // evidence that no surface can be handed a CONFIRMED verdict it did not earn.
    toolCall: {
      tool: 'finding',
      args: {
        claim: 'this claim was never checked',
        outcome: 'reported as a guess',
        evidence: [{ kind: 'file', ref: '   ' }],
      },
    },
    answer: 'Recorded as a guess.',
  },
  {
    id: 'failing-read',
    message: 'open a file that does not exist, then answer',
    // The regression guard for a REAL false-success defect, measured by this
    // harness: `read_file` on a missing path returned a message with no `Error:`
    // prefix, and the loop's accounting is `ok: !startsWith('Error:')`
    // (`tools/tool-loop.ts:1526`), so a read that never happened was reported as a
    // successful call on all five surfaces. `read_file` is the smallest
    // reproducing case of that family — `list_dir` and `edit_file` had it too, and
    // all three now report the failure (`tools/coding-tools.ts`).
    toolCall: { tool: 'read_file', args: { path: 'no-such-file-parity-probe.ts' } },
    answer: 'Read failed.',
  },
];

/**
 * Drive the real harness: every surface, every scenario, one verdict each.
 *
 * The drivers run the REAL surfaces against a loopback stub provider (transport
 * depth — see `src/parity/drivers.ts`), in an isolated config/memory profile, so
 * this is a real comparison and not a smoke test. `verdict === 'divergent'` or a
 * refusal both fail the check; the differences are printed by name.
 */
export async function harnessRunCheck(): Promise<ParityCheck> {
  const { createParityHarness } = await import('../parity/drivers.js');
  const harness = await createParityHarness();
  const lines: string[] = ['Driving every surface (transport depth — real provider, stub server):'];
  let ok = true;
  try {
    for (const scenario of PARITY_SCENARIOS) {
      const run = await runParityScenario(scenario, harness.drivers);
      const atPar = run.verdict === 'at-par';
      if (!atPar) ok = false;
      lines.push(
        `  ${atPar ? '✅' : '✗ '} ${scenario.id.padEnd(20)} ${run.verdict}` +
          `  [${run.observations.map((o) => o.surface).join(', ')}]`,
      );
      if (run.refusal) lines.push(`      refused: ${run.refusal.message}`);
      for (const difference of run.differences) lines.push(`      - ${difference}`);
      if (!atPar && run.differences.length > 0) {
        lines.push(reportParityFailure(run.observations, run.differences));
      }
      for (const skipped of run.skipped) {
        lines.push(`      · skipped ${skipped.surface}: ${skipped.reason}`);
      }
    }
  } finally {
    await harness.dispose();
  }
  lines.push('', ok ? '✓ every surface is at par.' : '✗ cross-surface parity failed.');
  return { ok, lines };
}

/** Print a check's lines and make its verdict the process exit code. */
function report(check: ParityCheck): void {
  for (const line of check.lines) console.log(line);
  console.log('');
  if (!check.ok) process.exitCode = 1;
}

export class ParityCommand extends BaseCommand {
  create(): Command {
    const cmd = new Command('parity')
      .description('Surface-parity harness — prove the same experience on chat, execute, dashboard, gateway and subagents');

    cmd
      .command('surfaces')
      .description('Compare the surface registry against the real import graph')
      .action(async () => {
        report(surfaceReachCheck());
      });

    cmd
      .command('debt')
      .description('Check the anti-silo debt ratchet (observed surface debt must equal the frozen list)')
      .action(async () => {
        report(surfaceDebtCheck());
      });

    cmd
      .command('matrix')
      .description('Show every capability × surface and any unproven `supported` claim')
      .action(async () => {
        report(capabilityMatrixCheck());
      });

    cmd
      .command('run')
      .description('Drive all five surfaces through the real harness and report the verdict')
      .action(async () => {
        logger.highlight('\n🔎 Surface-parity harness — driving every surface\n');
        report(await harnessRunCheck());
      });

    // A bare `nuvira parity` is a summary + the way in, matching `gateway`/`bedrock`.
    cmd.action(() => {
      logger.highlight('\n🔎 Surface-parity harness\n');
      console.log('  nuvira parity surfaces   registry vs the real import graph');
      console.log('  nuvira parity debt       the anti-silo debt ratchet');
      console.log('  nuvira parity matrix     capability × surface, and unproven claims');
      console.log('  nuvira parity run        drive every surface and report the verdict\n');
      console.log('  The first three read `src/` and need a source checkout; `run` drives the built surfaces.');
      console.log(`  Turn-parity entry points: ${Object.keys(TURN_ENTRIES).join(', ')}`);
      console.log('');
    });

    return cmd;
  }
}
