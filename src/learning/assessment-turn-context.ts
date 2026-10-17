/**
 * ASSESSMENT TURN CONTEXT — the ONE seam every surface builds an assessment ask
 * through.
 *
 * WHY THIS EXISTS. `assessment-protocol.ts` answers "what must a findings turn be
 * able to show?", `self-check-discovery.ts` answers "what does this project
 * already check?", and `perf-probe.ts` answers "how would its startup cost be
 * measured?" — three modules, one prompt section, and four turn entries that all
 * run assessment asks (the CLI chat and the dashboard and the gateway chat through
 * `ChatCommand.runChatAnswer`, `nuvira execute` through `runLoopExecutor` and
 * `runPipelineTool`, and a delegated sub-agent through the child runtime).
 *
 * Measured before this module existed: the section was assembled inline in
 * `chat.ts`, so it reached exactly one entry. An assessment run through
 * `nuvira execute` — the surface a batch/scripted audit actually uses — got the
 * plain ask with none of the rules, which is the "capability lands on one surface
 * and quietly misses three" drift `src/parity/surfaces.ts` was written to make
 * visible. Assembling it here means the surfaces cannot disagree about what an
 * assessment ask is, and a rule added once lands everywhere.
 *
 * THE ORDER IS THE DESIGN, not an optimisation detail. `isProjectAssessmentGoal`
 * is a pure regex over the goal and runs FIRST: for every ordinary turn — the
 * overwhelming majority — this function does no filesystem work at all and returns
 * an empty block, so such a turn is byte-identical to one from a build without any
 * of these modules. Only once a turn IS an assessment ask does it read the project
 * directory.
 *
 * BEST-EFFORT BY CONTRACT, like the modules it composes. A missing/unreadable
 * workspace, or a project with nothing discoverable, yields the rules block alone:
 * the protocol still applies, and no turn is ever broken by a discovery failure.
 */

import { assessmentProtocolBlock, isProjectAssessmentGoal } from './assessment-protocol.js';
import { buildSelfCheckBlock, readProjectSelfChecks } from './self-check-discovery.js';
import { buildPerfProbeBlock, detectPerfProbeInput } from './perf-probe.js';
import type { MachineFacts } from './machine-facts.js';

/** What an assessment turn contributes to the prompt, and how much of it. */
export interface AssessmentTurnContext {
  /** True when the goal is a findings ask — the detector, exposed once. */
  isAssessment: boolean;
  /** The prompt section: '' for every non-assessment ask. */
  block: string;
  /** How many of the project's own checks were named (0 when none/not probed). */
  selfChecks: number;
  /** Whether a performance-probe section was included. */
  perfProbes: boolean;
}

/** The empty result — also what a non-assessment ask returns, by value. */
const NOT_ASSESSMENT: AssessmentTurnContext = { isAssessment: false, block: '', selfChecks: 0, perfProbes: false };

/**
 * Build the assessment section for one turn.
 *
 * @param goal the user's ask, verbatim (the detector reads it, so do not rewrite it first)
 * @param dir  the directory the turn is scoped to (the project being assessed)
 * @param opts.facts machine facts, injectable for tests
 */
export function buildAssessmentTurnContext(
  goal: string,
  dir: string,
  opts: { facts?: MachineFacts } = {},
): AssessmentTurnContext {
  // The gate first: a non-assessment ask must not touch the filesystem.
  if (!isProjectAssessmentGoal(goal)) return { ...NOT_ASSESSMENT };

  let selfChecksBlock = '';
  let selfCheckCount = 0;
  try {
    const checks = readProjectSelfChecks(dir);
    selfCheckCount = checks.length;
    selfChecksBlock = buildSelfCheckBlock(checks);
  } catch {
    // Discovery is best-effort: the rules still apply without it.
  }

  let perfBlock = '';
  try {
    perfBlock = buildPerfProbeBlock(detectPerfProbeInput(dir, opts.facts));
  } catch {
    // A probe section that cannot be detected is simply not offered.
  }

  const section = [selfChecksBlock.trim(), perfBlock.trim()].filter(Boolean).join('\n\n');
  const block = assessmentProtocolBlock(goal, { selfChecks: section });
  if (block === '') return { ...NOT_ASSESSMENT };
  return { isAssessment: true, block, selfChecks: selfCheckCount, perfProbes: perfBlock.trim() !== '' };
}
